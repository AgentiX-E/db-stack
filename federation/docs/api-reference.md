# db-federation API Reference

`@agentix-e/db-federation` moves data between database clusters that live in
different data centers. It knows nothing about any particular database engine:
writes enter through an outbox, leave through a transport, and are applied on
the far side through a callback the consumer supplies.

Everything below is the package root's export surface — `src/index.ts`. Every
heading on this page is checked against that surface by
`scripts/check-docs-api.mjs` on every CI run, and every exported value must be
mentioned here for the gate to pass, so the page cannot drift back into
describing classes that were never written.

Two subpaths are published beside the root. `./transport` exports
`TcpSecureTransport` and its four types; `./testing` exports the fault injector
described in [testing.md](./testing.md).

## How the pieces fit

```
                      ┌─────────────── sender DC ───────────────┐
 database change ───► │ CDCEngine → OutboxStore → transport     │
                      │            (durable)     (TcpSecure)    │
                      └─────────────────────────┬───────────────┘
                                                │ TLS, at-least-once
                      ┌───────────── receiver DC ▼──────────────┐
                      │ dedup → conflict resolution → consumer   │
                      │ (DedupRing) (ConflictResolver) (yours)  │
                      └──────────────────────────────────────────┘
```

`MultiLeaderReplication` is the sender loop, `FederationManager` wires both
halves together, and `AntiEntropy` repairs whatever at-least-once delivery and
long partitions left behind. Each layer has its own interface (`ITransport`,
`IOutboxStore`, `IMultiLeaderReplication`, `IAntiEntropy`, `ICDCEngine`,
`IReplicationSlotManager`), so a deployment can replace any of them — a Kafka
outbox, an S3 transport — without touching the rest.

Change capture has two exits, and they are different destinations rather than
different qualities:

```
 CDCEngine ──┬─► ExactlyOnceCDCPipeline ──► OutboxStore ──► transport ──► another DC
             │      (checkpoints and replay; durability across a restart)
             └─► CDCSubscriptionPump ────► ICDCSink ────► webhook / queue / database
                    (per-subscription fan-out, in process)
```

## Transports

### `ITransport`

The seam every other layer sends through. An implementation delivers
`TransportMessage`s between nodes and reports its peers and counters.

`send()` answers a question about **this** process: `true` means the frame
reached a live socket, `false` means it did not. It cannot answer the question a
replication protocol actually asks — did the peer apply it — because a TCP write
into a connection whose peer has gone is accepted by the local kernel. That is
what `cdc_ack` is for.

One thing `send()` does promise, and the CDC pipeline depends on it: **the frames
of one peer reach `onMessage` in the order `send()` was called.** The pipeline
keeps the outbox in FIFO order and its consumer applies changes in the order they
arrive, so a frame that overtakes its predecessor is a change applied out of order
in the other datacenter — and the outbox cannot see it, because both frames were
delivered. An implementation that compresses, batches or hands frames to a worker
pool has to keep that order itself; `TcpSecureTransport` inherits it from
`RaftTcpTransport`, which queues compression per peer for exactly this reason
(`@agentix-e/db-cluster` CHANGELOG, iterations 70 and 73).

The promise covers the whole path, not just the compression step. A frame handed
over while the peer has no connection is buffered and flushed when one appears; a
frame whose write fails is put back rather than dropped; and a frame handed over
while either of those is pending takes its place in the queue instead of writing
past it. One order per peer, whichever of the three routes the frame takes — a
transport that promises it on one route and not the others has not promised it.

```typescript
interface ITransport {
  send(message: TransportMessage): Promise<boolean>;
  broadcast(message: TransportMessage): Promise<number>;
  onMessage(callback: (message: InboundMessage) => void): () => void;
  getConnectedPeers(): PeerInfo[];
  getStats(): TransportStats;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### `InProcessTransport`

An in-memory transport for tests and single-process deployments. Peers that
share a `registryKey` can reach each other; latency, jitter and drop rate are
configurable, and `partition()` / `heal()` simulate a network split.

```typescript
class InProcessTransport implements ITransport {
  constructor(config: InProcessTransportConfig);
  send(message: TransportMessage): Promise<boolean>;
  broadcast(message: TransportMessage): Promise<number>;
  onMessage(callback: (message: InboundMessage) => void): () => void;
  getConnectedPeers(): PeerInfo[];
  getStats(): TransportStats;
  getDropStats(): { messagesDropped: number };
  partition(): void; // cut this node off from its registry
  heal(): void; // restore it
  destroy(): void;
  static resetRegistry(key?: string): void;
}
```

`InProcessTransportConfig`: `nodeId`, `registryKey?`, `latencyMs?`, `dropRate?`,
`jitterMs?`.

### `TcpSecureTransport`

The production transport: length-framed TCP with mutual TLS, per-peer
reconnection with backoff, and counters for bytes and messages in both
directions.

```typescript
class TcpSecureTransport implements ITransport {
  constructor(config: TcpSecureTransportConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: TransportMessage): Promise<boolean>;
  broadcast(message: TransportMessage): Promise<number>;
  onMessage(callback: (message: InboundMessage) => void): () => void;
  getConnectedPeers(): PeerInfo[];
  getStats(): TransportStats;
  getLocalAddress(): { host: string; port: number };
  getLastSendError(): string | null;
  reconnect(peerId: string): Promise<void>;
  destroy(): void;
}
```

`TcpSecureTransportConfig`: `nodeId`, `transportNodeId?`, `listen?`
(`{ host, port }`, default `127.0.0.1:0`), `peers?`, `peerAddresses?` (legacy
`host:port` list), and the TLS material (`cert`, `key`, `ca`, plus the peer
verification options the connection pool accepts).

## Durable outbox

### `IOutboxStore`

The contract `MultiLeaderReplication` and `ExactlyOnceCDCPipeline` depend on.
`addBatch` and `fetchAndFlush` are optional so an implementation can skip the
fast paths; `markFailed` is not, because a store that cannot record a failure
cannot dead-letter.

```typescript
interface IOutboxStore {
  add(entry: OutboxEntryInput): Promise<OutboxEntry>;
  addBatch?(entries: OutboxEntryInput[]): OutboxEntry[];
  fetchOldestPending(count: number, limit?: number): Promise<OutboxEntry[]>;
  fetchAndFlush?(count: number): OutboxEntry[];
  markDelivered(entryId: string): Promise<void>;
  markFailed(entryId: string, error?: string): boolean;
  getPendingCount(): Promise<number>;
  getStats(): OutboxStats | Promise<OutboxStats>;
}
```

### `OutboxStore`

The LMDB-backed implementation. Every index — main entries, the pending queue,
the delivery record, the sequence counter, the dead-letter queue and the
`id`/`msgId` reverse index — lives in one environment, so an `add()` is a single
transaction and a crash cannot leave an entry persisted but invisible to the
delivery loop. An entry that spends its retry budget moves to the dead-letter
queue instead of blocking the head of the queue.

```typescript
class OutboxStore implements IOutboxStore {
  constructor(config: OutboxStoreConfig);
  add(entry: OutboxEntryInput): Promise<OutboxEntry>;
  addBatch(entries: OutboxEntryInput[]): OutboxEntry[];
  fetchOldestPending(count: number, limit?: number): Promise<OutboxEntry[]>;
  fetchOldestPendingSync(count: number): OutboxEntry[];
  fetchAndFlush(count: number): OutboxEntry[];
  markDelivered(entryId: string): Promise<void>;
  isDelivered(entryId: string): boolean;
  markFailed(entryId: string, error?: string): boolean;
  retryDeadLetter(entryId: string): boolean;
  retryDeadLetters(targetPeerId?: string): number;
  getDeadLetterEntries(): DeadLetterEntry[];
  getDeadLetterStats(): { count: number };
  getPendingCount(): Promise<number>;
  getPendingStats(): Record<string, { count: number; oldestCreatedAt: number | null }>;
  getStats(): Promise<OutboxStats>;
  getRetention(): RetentionWindows;
  isCapacityExceeded(): boolean;
  housekeeping(): { delivered: number; deadLettered: number };
  close(): void;
}
```

`OutboxStoreConfig`: `dataDir` (required), `ttlMs?` (default 14 days; `entryTtlMs?`
is the same window under the name `deriveRetention` returns, so a derived set can be
spread into the config), `retryWindowMs?` (default 60 s), `dedupMs?` (default 30 min
— the peer's memory, which the retry budget must fit inside), `maxRetries?` (no
default — off), `retryBackoffMs?` (default 50 ms), `retryBackoffMaxMs?` (default
2 000 ms), `deadLetterTtlMs?` (default 7 days), `mapSize?` (default 1 GiB).

The constructor resolves those durations through `deriveRetention` **before** it
creates the data directory, so a configuration whose windows do not contain each
other is refused rather than opened: see [`deriveRetention`](#deriveretention).

**The retry budget is time, not attempts.** A failure starts a window that is
measured from the _first_ failure — an entry that waited a minute behind a busy
peer has not spent that minute failing — and the entry is dead-lettered when the
window is spent. Retries inside the window back off (doubling from
`retryBackoffMs` to `retryBackoffMaxMs`), because a pump that retries the head of
the queue once per tick asks a peer that is down fifty times a second. The
previous default was `maxRetries: 3`, and at a 20 ms pump interval that was sixty
milliseconds of outage before changes started moving to the dead-letter queue; an
acceptance run lost nine changes to it. `maxRetries` still exists as an optional
hard cap for a caller who wants three strikes on a fast link.

`OutboxEntry` carries `id`, optional `msgId`, `targetPeerIds`, `payload`
(`Uint8Array`), `timestamp` (an HLC), `type`, `status`
(`'pending' | 'delivered' | 'failed'`) and attempt bookkeeping (`createdAt`,
`lastAttemptAt`, `attemptCount`, `lastError`, `firstFailedAt`, `nextAttemptAt`).
`OutboxEntryInput` is that shape minus the fields the store owns.

### `deriveRetention`

One derivation for the durations that govern an entry, from the shortest outward:

```
retryBackoffMax  ≤  retryWindow
retryWindow + ackTimeout  ≤  dedup
deliveryIndex  =  entryTtl
```

```typescript
function deriveRetention(request?: RetentionRequest): RetentionWindows;
class RetentionViolation extends Error {
  readonly rule: 'window-not-a-duration' | 'retry-covers-backoff' | 'dedup-covers-retry';
}
const DEFAULT_RETENTION: Readonly<RetentionWindows>;
```

`RetentionRequest` is all-optional (`dedupMs`, `ackTimeoutMs`, `retryWindowMs`,
`retryBackoffMaxMs`, `deadLetterTtlMs`, `entryTtlMs`) and an omitted field comes from
`DEFAULT_RETENTION`. `RetentionWindows` is the same set with nothing optional, plus
`deliveryIndexMs`, which is not a knob: the delivery record is pruned in the same pass
as the entries, so it is reported as `entryTtlMs` rather than as a fifth number that
could disagree with the fourth.

`deriveRetention` is pure, so a composition root can derive once and hand the same
numbers to components that cannot see each other — the outbox, the replication, the
manager and the CDC pipeline all report theirs through `getRetention()` instead of
restating a default.

The two nested relations are enforced; a violation throws `RetentionViolation` with
`rule` set and both numbers in the message, before any file is opened:

```text
RetentionViolation: dedup-covers-retry: the receiver forgets a message id after 300000 ms
but the sender may retry it for 600000 ms and wait 5000 ms for each verdict, so a retry
arrives as a new change
```

Two pairs that look nested are sequential and are deliberately **not** enforced: `ttlMs`
prunes delivered records and the dead-letter queue but never a pending entry, and the
dead-letter clock starts after the retry budget is spent. `Infinity` is a legal duration
meaning "no limit", and a sender that never gives up retrying needs a receiver that never
forgets — the same rule, read at the other end.

## Hybrid logical clock

### `HLC`

A hybrid logical clock. `now()` is strictly increasing — it advances the
physical component when the wall clock moved, and the logical counter when it
did not or when a peer is ahead. `observe()` is how a received timestamp is
folded in, so a message's HLC is always greater than every timestamp its sender
had seen.

```typescript
class HLC implements IHLCTimestamp {
  constructor(nodeId: string, initialWall?: bigint, initialLogical?: number);
  readonly wallTime: bigint; // milliseconds since epoch
  readonly logical: number; // tie-breaker within one millisecond
  readonly nodeId: string; // final tie-breaker
  now(): IHLCTimestamp;
  observe(remote: IHLCTimestamp): void;
  compare(other: IHLCTimestamp): number; // -1 | 0 | 1
  serialize(): string;
  deserialize(data: string): IHLCTimestamp;
}
```

### `IHLCTimestamp`

The value type carried on the wire. `wallTime` is a `bigint` — not a number —
so the encoding survives both `Date.now()` and clock values beyond 2^53.

### `compareHLC`

Total order over timestamps: wall time, then logical counter, then node id. The
node-id tie-break is what makes last-writer-wins deterministic across DCs.

```typescript
function compareHLC(a: IHLCTimestamp, b: IHLCTimestamp): number;
```

### `happenedBefore`

`compareHLC(a, b) < 0`. Encodes the causal order the replication layer relies on
when deciding whether an inbound write supersedes the local one.

```typescript
function happenedBefore(a: IHLCTimestamp, b: IHLCTimestamp): boolean;
```

### `makeHLC`

Builds a timestamp from its three components, attaching `compare`, `serialize`
and `deserialize` so a plain object behaves like an `HLC` value.

```typescript
function makeHLC(wallTime: bigint, logical: number, nodeId: string): IHLCTimestamp;
```

### `hlcToKey`

Encodes a timestamp as a lexicographically sortable string —
`<wall:16 hex>:<logical:8 hex>:<nodeId:utf-8 hex>`. Sorting keys in an LMDB or
RocksDB index therefore yields causal order without decoding.

```typescript
function hlcToKey(ts: IHLCTimestamp): string;
```

### `keyToHlc`

The inverse of `hlcToKey`. Colons inside the node id survive the round trip.

```typescript
function keyToHlc(key: string): IHLCTimestamp;
```

## Deduplication

### `DedupRing`

A bounded, TTL-swept ring of recently seen message ids. Delivery is
at-least-once, so the receiver asks `contains()` before applying and `put()`
after; `getStats()` exposes the seen/deduped/evicted counters that make a
mis-sized ring visible before it starts letting duplicates through.

```typescript
class DedupRing {
  constructor(config?: DedupRingConfig);
  readonly size: number;
  contains(msgId: string): boolean;
  put(msgId: string): boolean; // true when the id was new, false when it was a duplicate
  delete(msgId: string): boolean;
  clear(): void;
  getStats(): {
    size: number;
    totalSeen: number;
    totalDeduped: number;
    totalEvicted: number;
    capacity: number;
  };
  sweep(): void;
}
```

`DedupRingConfig`: `ttlMs?` (default 60 s), `maxCapacity?` (default 100 000),
`nodeId?`.

## Multi-leader replication

### `IMultiLeaderReplication`

The sender-side contract: persist a value for every target, drain the outbox in
the background, report lag.

```typescript
interface IMultiLeaderReplication {
  start(config?: ReplicationConfig): Promise<void>;
  stop(): Promise<void>;
  replicate(shardId: number, data: string, type?: string): Promise<{ msgId: string }>;
  getStatus(): Promise<ReplicationStatus>;
  retryFailed(targetNodeId: string): Promise<number>;
  getPendingCounts(): Promise<Record<string, number>>;
}
```

### `MultiLeaderReplication`

The implementation. One worker per target drains its own slice of the outbox, so
a slow or partitioned DC cannot starve the others; `onTargetConnected`,
`onTargetDisconnected` and `onHighLag` expose the transitions a supervisor needs.

```typescript
class MultiLeaderReplication implements IMultiLeaderReplication {
  constructor(options: MultiLeaderReplicationOptions);
  start(config?: ReplicationConfig): Promise<void>;
  stop(): Promise<void>;
  replicate(shardId: number, data: string, type?: string): Promise<{ msgId: string }>;
  getStatus(): Promise<ReplicationStatus>;
  retryFailed(targetNodeId: string): Promise<number>;
  getPendingCounts(): Promise<Record<string, number>>;
  onTargetConnected(callback: (targetNodeId: string) => void): () => void;
  onTargetDisconnected(callback: (targetNodeId: string) => void): () => void;
  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void;
  getAckStats(): { received: number; timeouts: number; pending: number; unsolicited: number };
}
```

`MultiLeaderReplicationOptions`: `transport`, `outbox`, `config`
(`ReplicationConfig`), and an optional `hlc` for deterministic tests.
`ReplicationConfig`: `nodeId`, `dc`, `targets` (`ReplicationTarget[]`),
`curveDir`, `tickMs?`, `batchSize?`, `maxRetries?`, `acknowledgement?`
(`'peer' | 'none'`, default `'peer'`), `ackTimeoutMs?` (default 5 000 ms).

An entry leaves the outbox when the peer says it applied the change. `'none'`
retires it on `send()` resolving, which is a statement about this node's socket and
not about the peer's state — the weaker contract, chosen explicitly, for a peer that
cannot answer. `getAckStats()` is how a sender tells a slow peer from a silent one:
`timeouts` rising beside a flat `received` is a reachable peer that is not applying.

## Edge replicas

### `EdgeReplica` / `IEdgeReplica`

An in-process read replica of a CDC stream, addressed by LSN. It is an intake
machine, not a socket: it takes frames from whatever calls `receive(lsn, payload)`
and exposes the resulting state through `getSyncStatus()`, `getLag()` and
`getAllData()`. `onEvent`, `onSyncComplete` and `onError` are the callbacks a
consumer subscribes to; unsubscribing returns a function.

`new EdgeReplica(options?)` takes two **engine-agnostic** hooks — the replica
knows nothing about the engine behind either one:

- `connectTransport?: (source: EdgeSourceConfig) => Promise<void | EdgeTransportHandle>` —
  the real dial, supplied by whoever owns the socket (WebSocket, SSE, a
  `TcpSecureTransport`). `connect()` awaits it in place of the built-in
  simulated dial; a rejection is emitted through `onError` and starts the
  backoff. It may return an `EdgeTransportHandle` — an object whose `dispose()`
  method is sync or async — which `disconnect()` awaits so a real socket can be
  torn down without the replica knowing its protocol; a dispose failure is
  reported through `onError`. Omit the hook for an engine that streams data
  in-process.
- `resolveConflict?: (lsn, existing, incoming) => unknown` — the policy for two
  writers claiming the same LSN. Called only for a _genuine_ conflict; a
  byte-identical replay is dropped before it gets here. Omit it and the first
  payload at an LSN stands, which keeps the stream a log rather than a cache.

**Real-socket lifecycle.** A socket can deliver bytes before the dial promise
resolves, so frames that arrive while `connect()` is in flight are buffered and
applied in arrival order once it settles — they are not dropped. A dial that
fails discards its buffer and emits through `onError`. Each `connect()` retires
the previous attempt's generation, so a slow dial or a backoff timer that
settles after `disconnect()` or a newer `connect()` becomes a no-op instead of
re-establishing a connection nobody asked for. `disconnect()` clears the source
and the pending backoff, then disposes the transport handle if one was supplied.
The cross-process acceptance case (`AC-F13`) drives exactly this path: a real
mTLS source in a second process pushes two writers claiming one LSN, and a
custom resolver changes which value survives.

A repeated LSN is always one entry: a transport duplicate is ignored, a
conflict is arbitrated in place, and `receivedCount` counts distinct positions.
The decision reaches **both** views of the stream: when the resolver changes
the payload, the arbitrated value is published to `onEvent` subscribers as
well as stored in `getAllData()`, so a consumer following the event stream does
not keep a stale pre-arbitration value. A byte-identical replay or a decision
that keeps the existing value is not republished. Handler exceptions are
isolated — one throwing does not stop the others — and are reported through
`onError` rather than swallowed.

## Change data capture

### `ICDCEngine`

Turns table changes into `CDCChangeEvent`s stamped with an LSN, a transaction id
and an HLC.

```typescript
interface ICDCEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  onChange(callback: (event: CDCChangeEvent) => void): () => void;
}
```

`appendChange()` is not on the interface. It is how the default engine is fed —
by a WAL decoder, or by a test — and an engine backed by a real replication
stream has nothing to append to.

### `CDCEngine`

The default `ICDCEngine`. It is deliberately engine-agnostic: the extraction step
hands it a change, and it assigns the ordering metadata.

```typescript
class CDCEngine implements ICDCEngine {
  constructor(config: CDCEngineConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  onChange(callback: (event: CDCChangeEvent) => void): () => void;
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent;
  readonly started: boolean;
}
```

### `createCDCPipeline` / `isSimulatedCapability` / `SimulatedEngineError`

The composition root a product uses to assemble an `ExactlyOnceCDCPipeline`.
`ExactlyOnceCDCPipeline` itself still accepts a default simulator — unit tests
drive its outbox and dedup logic with the `appendChange` hook — but starting a
product with that default used to report success while reading from nothing.
`createCDCPipeline` is the boundary: it refuses a simulated source at
construction, names the component and the engine in the error, and accepts any
real `ICDCEngine` untouched. The test is capability-based, not `instanceof`:
anything carrying the `appendChange` hook counts as a simulator regardless of
its class, so the guard binds to no concrete implementation.

```typescript
interface CreateCDCPipelineConfig extends ExactlyOnceCDCPipelineConfig {
  /** Required when the engine is omitted or carries `appendChange`. */
  allowSimulated?: boolean;
}

function createCDCPipeline(config: CreateCDCPipelineConfig): ExactlyOnceCDCPipeline;
function isSimulatedCapability(engine: unknown): boolean;
class SimulatedEngineError extends Error {
  readonly component: 'ExactlyOnceCDCPipeline';
  readonly engineName: string;
}
```

A receive-only node — which produces no changes and only dedups inbound ones —
passes `allowSimulated: true` deliberately. A producer passes a real engine
(for example `WalTailCDCEngine`). The refusal happens synchronously, before
`start()` installs a pump over a stream nothing writes.

### `CDCManager`

One change-capture engine per remote DC, feeding a single buffered stream, with
backpressure when the buffer fills. This is what `FederationManager.getCDC()`
returns once the manager has started.

```typescript
class CDCManager {
  constructor(config: CDCManagerConfig);
  start(targets: CDCTarget[]): Promise<void>;
  stop(): Promise<void>;
  capture(event: CDCEvent): Promise<void>;
  onEvent(handler: CDCEventHandler): () => void;
  onBackpressure(callback: (info: { bufferSize: number; maxBufferSize: number }) => void): () => void;
  getBufferSize(): number;
  isBackpressured(): boolean;
  getEngineCount(): number;
  isStarted(): boolean;
}
```

`CDCManagerConfig`: `nodeId`, `hlc`, `maxBufferSize?`, `tickMs?`, `maxLagMs?`.

### `CDCPublicationRegistry`

The publication and subscription catalogue a PostgreSQL-style replication setup
needs: named publications over table sets, and subscriptions pointing at a
target DSN. It is a separate object from `CDCManager` because the two jobs have
different lifetimes — publications outlive any one streaming session — and
because a manager that answers `getPublications()` with an empty array is not a
registry.

It is a catalogue and nothing else: it keeps the maps and watches the
publications' tables on the engine, but it does not subscribe to the change
stream and delivers no events. The DSN a subscription records is resolved by
`CDCSubscriptionPump`; cross-datacenter delivery with ordering, checkpoints and
replay is `ExactlyOnceCDCPipeline`.

```typescript
class CDCPublicationRegistry {
  constructor(config: CDCPublicationRegistryConfig);
  createPublication(name: string, tables: string[]): Promise<ICDCPublication>;
  dropPublication(name: string): Promise<void>;
  createSubscription(
    name: string,
    publicationName: string,
    targetDsn: string,
    operations?: CDCSubscription['operations'],
  ): Promise<CDCSubscription>;
  dropSubscription(name: string): Promise<void>;
  getSubscriptions(): Promise<CDCSubscription[]>;
  getPublications(): Promise<ICDCPublication[]>;
}
```

`CDCPublicationRegistryConfig`: `nodeId`, `engine`.

`operations` defaults to all three, and is what `CDCSubscriptionPump` filters on.
A `CDCSubscription` is `{ subscriptionId, tables, operations, targetDsn,
createdAt }` — `targetDsn` is stored exactly as given, whatever its scheme.

### `ICDCSink`

The destination side of change capture: anything that can connect, disconnect
and accept a batch of `CDCSinkEvent`s. Implement it to write changes to a
webhook, a queue, another database, or a test double.

```typescript
interface ICDCSink {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  emit(events: CDCSinkEvent[]): Promise<void>;
}
```

Throwing from `emit` means _refused_. `CDCSubscriptionPump` turns a refusal into
a retry and, once the budget is spent, into a recorded failure; a sink that
returns normally is taken to have accepted the batch.

`CDCSinkEvent` is `{ id, type, table, key, data, timestamp }` — `id` is
`<lsn>:<txId>`, `timestamp` is the HLC wall time as a `bigint`. It is a
different shape from `CDCManager`'s `CDCEvent` and was renamed from `CDCEvent`
so that both can be exported from the package root without one shadowing the
other.

### `InMemoryCDCSink`

An `ICDCSink` that keeps what it is given, in order. For tests, development and
benchmarks where an external destination would only add latency.

```typescript
class InMemoryCDCSink implements ICDCSink {
  constructor(name?: string);
  readonly name: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  emit(events: CDCSinkEvent[]): Promise<void>;
  getEvents(): CDCSinkEvent[];
  clear(): void;
}
```

### `CDCSinkResolver`

Wraps any `ICDCSink` with the parts a real destination needs: connection retry
with `'fixed' | 'exponential' | 'none'` backoff, batch splitting at
`maxBatchSize`, a periodic liveness probe, and a health/failure stream. It is
itself an `ICDCSink`, so it drops into `CDCSubscriptionPump`'s `resolveSink`
without the pump knowing.

```typescript
class CDCSinkResolver implements ICDCSink {
  constructor(sink: ICDCSink, config?: Partial<CDCSinkResolverConfig>);
  readonly name: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  emit(events: CDCSinkEvent[]): Promise<void>;
  getHealth(): ResolverHealth;
  onHealthChange(callback: (health: ResolverHealth) => void): () => void;
  onFailure(callback: (event: FailureEvent) => void): () => void;
}
```

`CDCSinkResolverConfig`: `name?`, `maxRetries` (5), `retryBaseMs` (100),
`retryMaxMs` (30 000), `retryStrategy` (`'exponential'`), `maxBatchSize` (1 000),
`healthCheckIntervalMs` (30 000; `0` disables). `ResolverHealth` is
`{ connected, lastEmitTimestamp, totalEmitted, totalFailures,
consecutiveFailures, uptimeMs }`; a `FailureEvent` carries a `SinkFailureMode`
(`connection_lost`, `emit_failed`, `retry_exhausted`), a timestamp and the error
text.

`emit` rejects when a batch is refused — including the case where the resolver
is disconnected by the time the refusal arrives. There is no path through this
class on which a refused batch resolves.

### `CDCSubscriptionPump`

The edge between a subscription and a sink. For every subscription in the
catalogue it resolves `targetDsn` through `resolveSink`, connects the result, and
routes the engine's changes to the sinks whose subscription admits them — by
table and by operation.

```typescript
class CDCSubscriptionPump {
  constructor(config: CDCSubscriptionPumpConfig);
  start(): Promise<void>;
  sync(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): CDCSubscriptionPumpStatus;
  getFailures(): CDCPumpFailure[];
  onEvent(handler: CDCPumpEventHandler): () => void;
}
```

`CDCSubscriptionPumpConfig`: `engine`, `registry`, `resolveSink`, `project?`,
`maxPendingPerSubscription?` (1 024), `maxEmitAttempts?` (3), `retryBaseMs?` (20),
`maxFailureLog?` (100).

Delivery rules, each of which is a test rather than a claim:

- **Order.** One FIFO queue and one drain loop per subscription, so a sink sees
  changes in the order the engine produced them. `CDCEngine` assigns a monotonic
  LSN, so that order is LSN order.
- **One emit per change.** A change reaches a sink through exactly one
  successful `emit()` call, or none. Retries re-send the same single-event call,
  never a batch, so a retry cannot duplicate an accepted change or half-apply a
  batch.
- **No silent loss.** A refusal is retried `maxEmitAttempts` times and then
  recorded in the bounded failure log (`getFailures()`) and reported as
  `delivery_failed`. A queue that overflows drops the _newest_ change — the
  consumer keeps a contiguous prefix — and reports `overflow` with the id of the
  first change that found no room.
- **No stall.** A poisoned change leaves the queue after its budget is spent, so
  the ones behind it are still attempted. Holding the head would convert one bad
  event into an outage for the whole subscription.

`start()` opens every subscription the catalogue holds and does not throw for a
single one that cannot be opened: an unresolvable DSN or a failed `connect()`
appears in `getStatus().unopened` and as a `subscription_failed` event, and the
next `sync()` retries it. `sync()` also opens subscriptions created after
`start()` and closes ones dropped from the catalogue. `stop()` detaches from the
engine and abandons queued changes, counting them as `dropped` with reason
`stopped`.

`CDCSubscriptionPumpStatus`: `started`, `subscriptions`, `unopened`, `pending`
(per subscription), `delivered`, `failed`, `dropped`, `evictedFailures`. A
`CDCPumpEvent` is `{ type, subscriptionId?, timestamp, eventId?, lsn?, table?,
attempts?, error?, reason?, dropped? }` with `type` one of `subscription_opened`,
`subscription_closed`, `subscription_failed`, `delivered`, `delivery_failed`,
`overflow`, and `reason` one of `queue-full`, `stopped`, `unsubscribed`.

`projection_failed` is the seventh type and the only one without a
`subscriptionId`: the projection runs once per change, before the pump knows
which subscriptions admit it. It is also the only failure the pump absorbs on
the engine's behalf — `onChange` runs inside the engine's listener loop, where a
throw would abandon every listener registered after the pump, so a broken
`project` is reported and counted instead of breaking the engine for every other
subscriber.

### `projectChangeEvent`

The default projection from `CDCChangeEvent` to `CDCSinkEvent`:
`id` is `<lsn>:<txId>`, `type` is the operation, `table` the table name, `data`
the new row (`newValues`, falling back to `oldValues`), `timestamp` the HLC wall
time.

```typescript
function projectChangeEvent(event: CDCChangeEvent): CDCSinkEvent;
```

`key` is left empty: `CDCChangeEvent` names no key column, and a default that
read `id` would be right for the schemas that happen to have one and silently
wrong for the rest. Supply `project` when your sink needs row identity:

```typescript
const pump = new CDCSubscriptionPump({
  engine,
  registry,
  resolveSink: (dsn) => new MySink(dsn),
  project: (event) => ({
    ...projectChangeEvent(event),
    key: String((event.newValues as { id?: string })?.id ?? ''),
  }),
});
```

### `ExactlyOnceCDCPipeline`

Exactly-once delivery on top of an at-least-once transport. Outbound, a change is
appended to the outbox before it is sent, and it is marked delivered only when the
receiving node **confirms it applied the change**; inbound, the dedup ring rejects
replays and the checkpoint file makes a restart resume instead of re-send.

**Delivered means the peer said so.** `send()` answers `true` when the local socket
took the bytes, and a TCP write into a connection whose peer has gone is accepted by
the kernel — an acceptance run measured the gap: twenty changes reported delivered,
thirteen applied, `refusals: 0`, `deadLetterCount: 0`. The pipeline now waits for a
`cdc_ack` frame from the peer, matched by message id, and treats the four answers
differently:

| The peer's answer                      | What the pump does                                                |
| -------------------------------------- | ----------------------------------------------------------------- |
| applied                                | `markDelivered`, advance the checkpoint                           |
| refused (`{ok:false, error}`)          | `markFailed` at once, with the peer's reason in `lastError`       |
| silent past `ackTimeoutMs`             | `markFailed`; the entry stays pending and its retry backs off     |
| nothing (the pipeline stopped waiting) | nothing — the entry keeps its place and is not charged an attempt |

An ack is sent by the **receiver's caller**, after its own durable write:
`processInbound()` returns the event and does not answer anything, because an ack
that leaves before the apply is the same lie one layer up. A duplicate is answered
too — it was applied the first time, and the sender must be allowed to stop
retrying it.

`processInbound()` refuses two things, and `reason` says which: `'duplicate'` (a
confirmation is the right answer) and `'undecodable'` (it is not). An undecodable
frame is also removed from the dedup ring, because the ring records what has been
_applied_ and this was not — left in it, the retry would look like a duplicate and a
caller that confirms duplicates would turn the refusal into a confirmation. A
receiver answers an undecodable frame with `acknowledge(message, reason)`, which the
sender treats as a refusal: the entry fails at once with the receiver's reason, and
the frame keeps failing until the retry budget puts it in the dead-letter queue.

One ordering rule is part of the contract: **a pump cycle ends at the first entry
the peer did not confirm.** The outbox returns entries oldest-first, but a loop
that keeps walking after a refusal sends the entries behind it, and the refused
one's retry then lands after them — so a receiver that appends in arrival order
records `5, 6, 4`. Entries sent behind an unconfirmed one are _not_ marked
delivered even when their own acks arrived: marking them would let the checkpoint
move past an entry that is still owed, and a duplicate is recoverable while a gap
is not.

`acknowledgement: 'none'` is the weaker contract, chosen explicitly: `send()`'s
`true` is the delivery. It exists for a peer that cannot answer (a write-only sink,
a bridge into a system without a reply path), and a deployment that selects it is
choosing "at-least-once onto the wire".

```typescript
class ExactlyOnceCDCPipeline {
  constructor(config: ExactlyOnceCDCPipelineConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent;
  processInbound(message: TransportMessage): {
    accepted: boolean;
    event?: CDCChangeEvent;
    reason?: 'duplicate' | 'undecodable';
  };
  acknowledge(inbound: TransportMessage, refusal?: string): Promise<boolean>;
  advanceCheckpoint(tableName: string, lsn: string): void;
  getCheckpoint(): CDCCheckpoint;
  getLastConfirmedLSN(tableName: string): string | null;
  onEvent(handler: CDCPipelineEventHandler): () => void;
  getMetrics(): Promise<CDCPipelineMetrics>;
  retryDeadLetter(entryId: string): boolean;
  getDeadLetterEntries(): DeadLetterEntry[];
  flushCheckpoint(cp?: CDCCheckpoint): void;
  cleanup(): Promise<void>;
}
```

`ExactlyOnceCDCPipelineConfig`: `nodeId`, `cdcConfig`, `outboxConfig`,
`dedupTtlMs?` (default 10 min), `transport?`, `remoteNodeId?`,
`acknowledgement?` (default `'peer'`), `ackTimeoutMs?` (default 5 000 ms), plus the
checkpoint path.

The two halves of the frame a receiver sends back — `buildAckFrame` and `parseAck` —
are exported, together with the frame type `CDC_ACK_TYPE`, so a peer written
against this package does not have to re-derive them:

```typescript
const CDC_ACK_TYPE: 'cdc_ack';
function buildAckFrame(
  acked: TransportMessage,
  fromNodeId: string,
  timestamp: IHLCTimestamp,
  refusal?: string,
): TransportMessage;
function parseAck(payload: Uint8Array, messageId: string): { ok: boolean; error?: string };
```

An empty payload is a confirmation — a peer that answered at all, on the frame it
was asked about, has said the only thing the sender needs. A body has to be JSON,
and only an explicit `ok: false` is a refusal: treating a chatty acknowledgement as
a failure would re-send a change that was already applied. A body that does not
parse _is_ a refusal, because taking an unreadable answer as a yes is how a lost
change becomes an invisible one.

### The read end of the change stream

`CDCEngine` is a simulator: its events are produced by `appendChange()`, a
method documented as test-only. Everything below it is real — a log another
process wrote, read back through an interface any engine can implement.

```
 your engine's log ──► IChangeLogReader ──► WalTailCDCEngine ──► ICDCEngine consumers
 (PostgreSQL slot,      (readAfter/head)     (cursor, filter, HLC)   (pipeline, pump, …)
  MySQL binlog, Kafka,
  FileChangeLog)
```

### `IChangeLogReader`

The seam between _where changes are recorded_ and _what this package does with
them_. Two properties are the contract: records come back in strictly
increasing `lsn` order with none at or before the position asked for, and a
record is only ever returned after it is durable — a record acknowledged to a
writer and then lost in a crash is the failure this seam exists to rule out.

```typescript
interface IChangeLogReader {
  readAfter(afterLsn: string | null, limit: number): Promise<ChangeLogRecord[]>;
  head(): Promise<string | null>;
}
```

`ChangeLogRecord` carries `lsn`, `table`, `operation`, `oldValues`,
`newValues`, `txId` and `committedAt` (the writer's commit time in epoch
milliseconds — a log written by another process cannot borrow this one's
clock).

An adapter for a real engine implements these two methods against its own
position type. `compareLsn` and `parseLsn` understand the `high/low`
hexadecimal shape PostgreSQL uses; `formatLsn` produces it; and
`recordToChangeEvent` converts a record into the `CDCChangeEvent` the rest of
the package consumes, given a timestamp.

```typescript
import { compareLsn, formatLsn, parseLsn, recordToChangeEvent } from '@agentix-e/db-federation';

compareLsn('0/100000000', '0/A0000000'); // 1 — numerically, not lexically
```

### `FileChangeLogWriter` / `FileChangeLogReader`

A reference log on disk: one JSON object per line, UTF-8, `\n`-terminated, with
`fsync` between the append and the acknowledgement. It is what makes "ordered,
resumable delivery" measurable without a database: the writer is one process,
the reader another, and the bytes in between are on a filesystem.

```typescript
import { openFileChangeLog } from '@agentix-e/db-federation';

const { writer, reader } = await openFileChangeLog({ dir: '/var/lib/app/changelog' });
const lsn = await writer.append({
  table: 'orders',
  operation: 'insert',
  newValues: { id: 7 },
  txId: 'tx-1',
}); // resolves after fsync — `0/00000001`
```

`openFileChangeLog` opens both halves over one file. `FileChangeLogOptions`
takes `dir`, `fileName?` (default `changelog.jsonl`) and
`fsync?` (default true; off is a durability trade for benchmarks). `append`
takes an `AppendChangeInput`. The writer assigns positions — a reopened writer
continues past the last record rather than reusing it — and truncates a torn
tail, because a record that was still being written when a process died was
never acknowledged. The reader refuses three things by name: a file that shrank
(rotation it cannot follow), a line that is not JSON, and a record whose LSN
does not advance. All three arrive as `ChangeLogCorruptError`, carrying the byte
offset the reader gave up at.

### `WalTailCDCEngine`

An `ICDCEngine` over an `IChangeLogReader`: it polls, moves a cursor, filters by
watch set and stamps an HLC anchored to the writer's commit time.

```typescript
import { WalTailCDCEngine } from '@agentix-e/db-federation';

const engine = new WalTailCDCEngine({
  reader,
  nodeId: 'dc-east',
  startAfterLsn: '0/0000041F', // the consumer's checkpoint
  pollIntervalMs: 50,
});
await engine.start();
```

`WalTailCDCEngineConfig` also takes `batchSize?` (default 256) and an
`onReadError?` hook. A read failure is counted, reported and retried on the next
tick rather than stopping the stream: one transient `EACCES` must not wedge a
tail until somebody restarts the process. The cursor advances for records the
watch set rejects — the position belongs to the log, not to a subscription, and
a cursor left behind an unwatched table would re-read it forever. An empty watch
set means "deliver what the log holds", because silence is indistinguishable
from a broken deployment.

`WalTailCDCEngineStatus` reports `started`, `position`, `polls`, `readErrors`,
`lastError`, `emitted` and `skipped`. `poll()` is public so a caller can drive
the tail deterministically instead of sleeping for one interval; concurrent
calls collapse into one.

Wire the engine into the pipeline with `engine` in
`ExactlyOnceCDCPipelineConfig`, and read the resume point _before_ the engine is
constructed:

```typescript
import { ExactlyOnceCDCPipeline } from '@agentix-e/db-federation';

const checkpoint = ExactlyOnceCDCPipeline.readCheckpoint('/var/lib/app/outbox');
const startAfterLsn = ExactlyOnceCDCPipeline.resumePosition(checkpoint);
```

`resumePosition` returns the _earliest_ position the checkpoint holds, not the
latest: a tail has one cursor and a checkpoint has one position per table, so
resuming at the latest would skip every row of a table that is behind. A replay
is absorbed by the receiver's dedup ring; a gap is not.

`comparePositions` orders two checkpoint positions — numerically when both are
`high/low` LSNs, lexically when neither is (a consumer may key its checkpoint by
a Kafka offset), and it throws for a mix, because two positions that are not the
same kind of thing have no order. `isSimulatedEngine` tells the simulator from a
read end, which is what `appendChange()` uses to refuse when the pipeline is
wired to a log.

### `HttpCDCSink`

A sink that ends at a socket, for the half of CDC that delivers to a webhook or
an ingest endpoint rather than to another datacenter.

```typescript
import { HttpCDCSink } from '@agentix-e/db-federation';

const sink = new HttpCDCSink({
  url: 'https://ingest.internal/cdc',
  headers: { authorization: `Bearer ${process.env.CDC_TOKEN}` },
  timeoutMs: 2_000,
  probe: { method: 'GET' },
});
```

`emit()` POSTs `{"events":[…]}` and resolves only on a 2xx. Anything else
throws `HttpSinkRefusedError`, which carries the status, a bounded excerpt of
the body, and whether the failure was a timeout; `CDCSinkResolver` and
`CDCSubscriptionPump` retry on a throw and record a failure once the budget is
spent. A batch that never got a response is a refusal too — a receiver that
committed a batch the client gave up on and one that never saw it are different
states, and only the receiver can tell them apart, which is why delivery is
at-least-once and the receiver deduplicates by event id. A 404 on the probe
counts as proof of life.

`HttpCDCSinkConfig` takes `url`, `name?`, `headers?`, `timeoutMs?` (default
5 s), `keepAlive?` (default true), `probe?` (default off) and
`maxErrorBodyBytes?` (default 512). `HttpCDCSinkStats` reports `requests`,
`batches`, `events`, `refusals` and `lastStatus`.

### Counters, exposition and the conservation identity

The pump and the pipeline both keep counters. `pumpConservation` and
`pipelineConservation` state what those counters must add up to, and
`renderPumpMetrics` / `renderPipelineMetrics` render them as Prometheus text.

```typescript
import { pumpConservation, renderPumpMetrics } from '@agentix-e/db-federation';

const status = pump.getStatus();
const ledger = pumpConservation(status);
// accepted = delivered + failed + dropped + Σ pending, always
if (!ledger.balanced) throw new Error(`${ledger.unaccounted} changes vanished`);

process.stdout.write(renderPumpMetrics(status, { node: 'dc-east' }));
```

The identity holds because the queue is the ledger: a change routed to a
subscription is counted once as `accepted`, and from that moment it is pending
(including the head being emitted right now), delivered, failed after the retry
budget, or dropped. There is no in-flight bucket, which is what makes the
identity exact rather than approximate. A projection that throws is counted as
`projectionFailed`, not as a delivery failure — it runs before any subscription
is chosen.

`escapeLabelValue` escapes the three characters the exposition format treats
specially (backslash, double quote, newline), and `MetricLabels` is the label
map. For the pipeline the identity is over the outbox:
`produced = pending + sent + deadLettered`, with `preExisting` passed in when
the outbox was not empty at start.

`sent` counts what the peer confirmed, so an entry in flight is still `pending` and
the identity keeps holding across the confirmation round trip — that is the reason
the ack is a counter of its own rather than a subtraction. `CDCPipelineMetrics`
adds `acksReceived` (confirmations that matched an in-flight frame, applied or
refused) and `ackTimeouts` (frames a cycle stopped waiting for), exposed as
`db_federation_cdc_pipeline_acks_total` and
`db_federation_cdc_pipeline_ack_timeouts_total`. A rising `ack_timeouts` with a
flat `sent` is the signature of a peer that is reachable and not applying.

## Conflict resolution

### `ConflictResolver`

Five strategies over the same `ConflictValue` shape: `'lww'` (higher HLC wins,
then higher node id), `'crdt-counter'`, `'crdt-set'`, `'crdt-map'`, and
`'custom'`, which dispatches to resolvers registered by table name or key
prefix. The result records which strategy ran and which nodes lost.

```typescript
class ConflictResolver {
  constructor(localNodeId: string);
  registerCustomResolver(predicate: ConflictPredicate, resolver: CustomResolver): void;
  unregisterCustomResolver(predicate: ConflictPredicate): void;
  resolve(
    key: string,
    local: ConflictValue,
    remote: ConflictValue,
    defaultStrategy?: ConflictStrategy,
  ): Promise<ConflictResult>;
}
```

`ConflictValue`: `{ key, value, hlc, nodeId }`.
`ConflictResult`: `{ resolvedValue, strategyUsed, loserNodeIds, merged }`.
`ConflictPredicate`: `{ tableName?, keyPrefix? }`.
`CustomResolver`: `(key, local, remote) => Promise<ConflictResult>`.

Custom-resolver selection is deterministic and independent of registration
order. An **exact table match** wins first — a table name is a whole token, so
`user` matches `user:1` but not `users_archive:1`. If no table matches, the
**longest matching key prefix** wins. A bare `{}` predicate is a fallback that
matches any key only when nothing above did. A table and a prefix registered
with the same token are two distinct resolvers: registering the second does not
replace the first, and unregistering either leaves the other addressable.

## Anti-entropy

### `IAntiEntropy`

Bounds how far two replicas can drift: build a Merkle tree of the keyspace,
compare roots, and exchange only the ranges that differ.

```typescript
interface IAntiEntropy {
  start(config?: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  buildMerkleTree(): Promise<MerkleNode>;
  syncWith(peerNodeId: string): Promise<SyncResult>;
  syncAll(): Promise<SyncResult[]>;
  getSyncHistory(): SyncResult[];
}
```

### `AntiEntropy`

The implementation. `DataProvider` (`getRange`, `getEntriesAfter`, `apply`,
`get`) is the engine-neutral read/write seam; conflicts found while repairing a
range go through the `ConflictResolver` when one is supplied.

```typescript
class AntiEntropy implements IAntiEntropy {
  constructor(config: AntiEntropyConfig, dataProvider: DataProvider, conflictResolver?: ConflictResolver);

  // A peer, and the socket behind it. Unbound peers are refused, not invented.
  bindPeer(peerId: string, peer: MerklePeer): () => void;
  getPeers(): string[];

  start(config?: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  buildMerkleTree(): Promise<MerkleNode>;

  // The comparison, and the repair it implies.
  buildDigest(shardId?: string): Promise<DatasetDigest>;
  diff(mine: DatasetDigest, theirs: DatasetDigest): { push: string[]; want: string[] };
  entriesInBucket(prefix: string): Promise<DataEntry[]>;
  snapshotEntries(): Promise<DataEntry[]>;
  applyRemote(entries: DataEntry[]): Promise<{ applied: number; skipped: number; conflicts: number }>;

  syncWith(peerNodeId: string, shardId?: string): Promise<SyncResult>;
  syncAll(shardId?: string): Promise<SyncResult[]>;
  getMerkleRoot(shardId: string): Promise<string>;
  findDiffRanges(node: MerkleNode): Promise<Array<{ start: string; end: string }>>;
  getSyncHistory(): SyncResult[];
  getLastError(): string | null;
}
```

`AntiEntropyConfig`: `nodeId`, `intervalMs`, `merkleDepth`. `SyncResult`:
`{ nodeId, entriesSynced, entriesSkipped, conflictsResolved, pushed,
peerReachable, durationMs, completedAt }`.

**Bucket names come from keys, not from entries.** `bucketPrefix(key, depth)` is
the first `depth` bits of `SHA-256(key)`, so two nodes compute the same buckets
from the same key space without having agreed on anything else. A tree whose
leaves were derived from the entries each side happened to hold could not be
compared bucket by bucket at all — which is why `syncWith()` used to build a
digest, compare it with a digest of the same dataset, and always agree.

**A digest lists every bucket, empty ones included.** Empty buckets share one
constant hash. A digest that listed only the buckets it had data for made
"absent" indistinguishable from "empty", so a peer missing a bucket and a peer
running an older build read the same.

**`diff()` compares hashes, not counts.** The same number of entries with
different values is still a divergence.

**`applyRemote()` keeps the origin clock it was given.** A store that stamped
`Date.now()` made every applied entry look newer than its source, so the next
sweep classified _this_ node as the divergent side and pushed the same bucket
back — a reconciliation loop that never converges and never reports an error.

### `MerkleNode`

One node of the digest tree: the key range it covers, its hash, and its
children.

### `DataEntry`

The unit anti-entropy compares and applies: `{ key, value, hlc }`.

### `DataProvider`

The four-method interface above that a consumer implements against its own
storage.

## The control plane

Three protocols that share one transport, one HLC and one node id. Each is
agnostic about the others and about the storage: what a silence means, what a
snapshot contains and what a divergence costs are all injected.

### `AntiEntropyProtocol`

The sweep, over the wire.

```typescript
class AntiEntropyProtocol {
  constructor(transport: ITransport, hlc: HLC, antiEntropy: AntiEntropy, config: AntiEntropyProtocolConfig);
  start(): void; // binds every target, owns the timer. Does not sweep.
  stop(): void; // unbinds, and settles every outstanding round trip.
  sweep(): Promise<void>; // one sweep, one at a time.
  handle(msg: InboundMessage): Promise<boolean>;
  getStatus(): AntiEntropyProtocolStatus;
}
```

`AntiEntropyProtocolConfig`: `nodeId`, `targets`, `shardId?`, `intervalMs?` (15 000,
`0` leaves the timer off), `exchangeTimeoutMs?` (5 000), `maxEntriesPerFrame?` (500).

`AntiEntropyProtocolStatus`: `sweeps`, `requestsSent`, `repliesSent`,
`repliesReceived`, `pushesSent`, `pushesReceived`, `entriesApplied`,
`entriesSkipped`, `conflicts`, `timeouts`, `malformed`, `unsolicited`, `selfRoot`,
`peers` (per peer: `{ root, total, depth, at }`), `lastError`.

Pushes are not acknowledged. A push is idempotent and a sweep repeats it, so the
divergence is its own receipt; an ack would cost a second state machine with its
own timeout, its own abort path and its own way of reporting a slow peer as a
down one. A digest round trip _is_ bounded: a digest that is never answered
leaves this node unable to decide anything, while a push that is never
acknowledged leaves it with a difference it will see again. A transport that
refuses the frame ends the wait immediately — waiting out the budget would report
a slow peer where there is an unreachable one.

### `HeartbeatProtocol`

The datacenter heartbeat as a frame.

```typescript
class HeartbeatProtocol {
  constructor(transport: ITransport, hlc: HLC, detector: DCSplitBrainDetector, config: HeartbeatProtocolConfig);
  start(): void; // starts the timer. Sends no beat.
  stop(): void;
  beat(): Promise<number>; // one beat, one sequence, every target.
  handle(msg: InboundMessage): boolean;
  getStatus(): HeartbeatProtocolStatus;
}
```

`HeartbeatProtocolConfig`: `nodeId`, `dcId`, `targets`, `intervalMs?` (1 000). It
must match the detector's interval — the detector multiplies its own copy by the
missed-beat threshold, so two numbers would make the expiry deadline describe a
schedule nobody is running.

A frame is subject to the three things a local emission is not, and each has a
meaning the detector is allowed to draw a conclusion from:

| Arrival                       | Verdict               | Why                                                                                                                              |
| ----------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| nothing                       | silence               | the detector's expiry scan reports it once                                                                                       |
| `seq <= last`                 | `outOfOrder`, dropped | three copies of one interval must not look like three intervals                                                                  |
| `seq > last`, `sentAt < last` | accepted, recorded    | refusing it would freeze the peer's liveness on the last good beat; a clock that stepped back is why the chain will look strange |

The sequence advances **once per beat**, not once per frame: the same interval
told to three peers is one observation, and three peers each receiving `n` is the
only way "did I miss anything?" has one answer.

### `SnapshotBootstrap`

Both roles in one class, because whichever datacenter restarts is the receiver for
that transfer and the other is the source — possibly simultaneously, for its own
peer.

```typescript
interface BootstrapSource {
  currentLsn(): Promise<number>;
  entriesAfter(lsn: number, limit: number): Promise<Array<{ lsn: number; entry: DataEntry }>>;
}

class SnapshotBootstrap {
  constructor(
    transport: ITransport,
    hlc: HLC,
    antiEntropy: AntiEntropy,
    source: BootstrapSource,
    config: SnapshotBootstrapConfig,
  );
  begin(peerId: string): Promise<string>; // returns the transfer id, resumed or fresh.
  handle(msg: InboundMessage): Promise<boolean>;
  getStatus(): SnapshotBootstrapStatus;
  getInboundTransfer(transferId: string): { expected: number; phase: string; highWaterMark: number } | null;
}
```

`SnapshotBootstrapConfig`: `nodeId`, `shardId?`, `chunkSize?` (200),
`handoffBatchSize?` (200), `resumeStatePath?`, `resumeAcrossRestarts?` (`false`).

`resumeAcrossRestarts` is a statement about the consumer, not about this class: a
cursor says "chunks 0..n-1 are already in my store", and only a store that outlives
the process can honour it. The default refuses a cursor written by another
instance — `lastError` says so and the transfer starts at chunk zero — because a
`Map` inside the process does not survive it, and resuming at `n` against an empty
map leaves everything before `n` missing while the transfer still reports
`complete`. The in-memory `DataProvider` this package composes by default is exactly
that case; an engine-backed provider is the other one.

Five frame types: `bootstrap_request`, `bootstrap_chunk`, `bootstrap_done`,
`handoff_entry`, `handoff_end`. `HandoffEndBody.complete` defaults to `true` when
absent, so a peer that predates the field is not read as having lost history.

The properties, and what enforces each:

- **Resumable** — the receiver persists `{transferId, nextChunk, instanceId}` after
  every chunk it accepts and its next request names that index. A sender that died
  can be resumed against, because the request names the position rather than the
  receiver's memory; a _receiver_ that died can only be resumed when its store did
  too (`resumeAcrossRestarts`).
- **Complete** — the snapshot position is read _before_ the state, so a write that
  lands during the read is in the snapshot _and_ in the handoff; the other order
  leaves it in neither. The handoff floor is the sender's `snapshotLsn`, assigned
  rather than maximised: two nodes' positions are counters that have never met, and
  keeping the larger of the two asks the sender for entries after a position its
  log never reached — an empty handoff reported as finished, over a hole.
- **One snapshot per transfer** — a chunk carries the `snapshotLsn` it was cut
  from, and a chunk from a different one restarts the transfer at zero
  (`snapshotMoved`). Chunk 3 of a snapshot taken before three hundred writes is not
  chunk 3 of the one taken after them, so splicing them skips exactly the entries
  whose insertion shifted every boundary — and still finishes and reports
  `complete`.
- **Honest** — a handoff the sender cannot complete (its log was compacted past
  the receiver's floor) is sent with `complete: false`; the receiver reports the
  hole and drops its cursor so the next attempt starts against a fresh snapshot.
- **Serial** — frames of one transfer are processed in order. With async handlers
  interleaving, two chunks read the same `expected`, the second judged itself out
  of order and asked for a re-send: measured as five gap requests and twelve chunk
  frames carrying three chunks.

### `FederationOrchestrator` — failure joined to recovery

Detection and recovery are separate components, and a silent datacenter used to
leave the failover bookkeeping green because nothing connected the two. The
orchestrator is that connection, and it is engine-agnostic: the three
collaborators are narrow interfaces a caller supplies, so no socket, cluster or
storage type leaks into it.

```typescript
new FederationOrchestrator({
  failureSource: FailureSignalSource;   // e.g. DCSplitBrainDetector
  recoverySource: RecoverySignalSource; // e.g. FederationManager.onTargetRecovered
  failover: FailoverActions;            // e.g. CatastrophicFailoverManager
  resolveDc: (nodeId: string) => string | undefined;
  onReconfigure?: (dcId: string, healthy: boolean) => void | Promise<void>;
  onError?: (error: Error) => void;
});
orchestrator.start(): void;
orchestrator.stop(): void;
orchestrator.recordPending(dcId: string, count?: number): void;
orchestrator.getStatus(): {
  started, failedDcs, recoveries, recoveryFailures, ignoredRecoveries, coalescedRecoveries
};
```

Policy: a heartbeat expiry feeds the detector's observed silence into the
failover clock (`observeSilence`) before asking for a verdict, so a detector that
watched a peer go quiet for minutes is not second-guessed by a clock that began
at construction; a failed verdict marks the DC failed; a peer coming back drives
a real `recover()` before the DC is declared healthy; a rejected recovery keeps
it failed and reports through `onError`; and two recoveries for one DC at once
collapse into one. A caller that omits reconfiguration hooks pays nothing for
them.

For an ordinary deployment the wiring is done by the manager: supplying
`FederationManagerConfig.failover` (an optional `dcTimeoutMs` plus the
`recover` / `onError` hooks) builds the `CatastrophicFailoverManager` and the
orchestrator, connects the detector's expiry and the manager's own
`onTargetRecovered` signal, and stops both on `stop()`. `manager.getFailover()`
and `manager.getOrchestrator()` expose them; omitting `failover` keeps the
historical behaviour for engines that manage recovery themselves.

### `FederationManager` — the control-plane surface

```typescript
manager.getAntiEntropyProtocol(): AntiEntropyProtocol;
manager.getHeartbeat(): HeartbeatProtocol;
manager.getBootstrap(): SnapshotBootstrap;
manager.bootstrapFrom(peerNodeId?: string): Promise<string>;
manager.getLsn(): number;
manager.getProtocolStatus(): { antiEntropy, heartbeat, bootstrap, lsn };
manager.getFailover(): CatastrophicFailoverManager;
manager.getOrchestrator(): FederationOrchestrator;
```

`bootstrapFrom()` defaults to the first configured target. Control frames
(`fed_heartbeat`, `fed_ae_summary`, `fed_ae_push` and the five bootstrap types)
are routed to their protocol **before** the dedup ring and come back as
`'protocol'` from `applyInbound()`; a control frame that no bound protocol claims
is `'malformed'` with a reason, because "I do not know this frame" is a fact an
operator can act on and silence is not.

### Frame types and predicates

The type string is the only thing that says which protocol owns a frame, so the
constants are exported rather than spelled at each call site — a typo in a string
literal routes a heartbeat into the replicate path and nothing reports it.

| Constant                 | Value               | Owner                                                                     |
| ------------------------ | ------------------- | ------------------------------------------------------------------------- |
| `HEARTBEAT_TYPE`         | `fed_heartbeat`     | `HeartbeatProtocol`                                                       |
| `AE_SUMMARY_TYPE`        | `fed_ae_summary`    | `AntiEntropyProtocol` — digest request and reply                          |
| `AE_PUSH_TYPE`           | `fed_ae_push`       | `AntiEntropyProtocol` — one bucket's entries                              |
| `BOOTSTRAP_REQUEST_TYPE` | `bootstrap_request` | `SnapshotBootstrap` — source role                                         |
| `BOOTSTRAP_CHUNK_TYPE`   | `bootstrap_chunk`   | `SnapshotBootstrap` — receiver role                                       |
| `BOOTSTRAP_DONE_TYPE`    | `bootstrap_done`    | `SnapshotBootstrap` — receiver asks for the handoff                       |
| `HANDOFF_TYPE`           | `handoff_entry`     | `SnapshotBootstrap` — one change after the snapshot                       |
| `HANDOFF_END_TYPE`       | `handoff_end`       | `SnapshotBootstrap` — `complete: false` when the log could not reach back |

`BOOTSTRAP_FRAME_TYPES` is the list of the five bootstrap types in one place.

`isHeartbeatFrame(type)`, `isAntiEntropyFrame(type)` and `isBootstrapFrame(type)`
answer "does this protocol own this frame?" and are what the router asks before it
decodes anything. They are disjoint by construction: one type, one owner, so a
frame cannot be applied twice by two protocols that both claimed it.

## Topology

### `TopologyManager`

Answers the routing questions the replication loop asks: who are my peers, which
of them are in my DC, which are edge replicas, what backoff applies to a target,
and which region owns a partition. `on('change')` reports peers appearing,
disappearing and changing.

```typescript
class TopologyManager {
  constructor(config: TopologyConfig);
  getLocalNodeId(): string;
  getLocalDc(): string;
  getAllPeers(): ReplicationTarget[];
  getPeer(nodeId: string): ReplicationTarget | undefined;
  getPeersInDc(dc: string): ReplicationTarget[];
  getCrossDcPeers(): ReplicationTarget[];
  getIntraDcPeers(): ReplicationTarget[];
  getEdgePeers(): ReplicationTarget[];
  getTopologyType(nodeId: string): TopologyType | undefined;
  getBackoffMs(nodeId: string): number;
  isIntraDc(nodeId: string): boolean;
  isSelf(nodeId: string): boolean;
  getPartitionRegion(partitionId: string): string | undefined;
  replaceAll(newPeers: ReplicationTarget[]): void;
  on(event: 'change', callback: (event: TopologyChangeEvent) => void): () => void;
}
```

`TopologyConfig`: `nodeId`, `dc`, `peers`, `partitionRegions?` (partition id to
DC). `TopologyType` is one of `'intra-dc' | 'cross-dc' | 'edge'`.

## Health

### `HealthMonitor`

Polls the replication layer, classifies every target as healthy, warning,
critical or unknown against two lag thresholds, and keeps the last success and
failure per target so a transient blip is distinguishable from a dead link.

```typescript
class HealthMonitor {
  constructor(replication: IMultiLeaderReplication, config?: HealthMonitorConfig);
  start(): void;
  stop(): void;
  check(): Promise<FederationHealth>;
  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void;
  onHealthChange(callback: (health: FederationHealth) => void): () => void;
}
```

`HealthMonitorConfig`: `checkIntervalMs?` (default 5 s),
`highLagThresholdMs?` (default 60 s), `criticalLagThresholdMs?` (default 5 min).

### `TargetHealth`

Per-target status: `targetNodeId`, `connected`, `lagMs`, `pendingCount`,
`lastSuccessAt`, `lastErrorAt`, `lastErrorMessage`, and `status`.

### `FederationHealth`

A snapshot of the whole node: `dc`, `nodeId`, `uptimeMs`, `startedAt`, the
healthy/warning/critical counts, and the `TargetHealth[]` behind them.

## Federation manager

### `FederationManager`

The façade that makes the stack usable from one object. It owns an `HLC`, a
`HealthMonitor`, the receiver-side `DedupRing`, and — once started — the
`CDCManager`, `DCSplitBrainDetector`, `ConflictResolver` and `AntiEntropy`
instances reachable through the getters. `applyInbound()` is the decision point
for a received message and reports exactly what happened to it.

```typescript
class FederationManager {
  constructor(replication: IMultiLeaderReplication, config: FederationManagerConfig);
  start(cdcTargets?: CDCTarget[]): Promise<void>;
  stop(): Promise<void>;
  replicate(
    shardIdOrKey: number | string,
    valueOrData: string,
    type: string,
    remoteValue?: ConflictValue,
  ): Promise<{ msgId: string }>;
  applyInbound(msg: InboundMessage): Promise<InboundOutcome>;
  adoptLocalChange(key: string, value: string, type?: 'insert' | 'update' | 'delete'): Promise<DataEntry>;
  getLastInboundError(): string | null;
  getEpochStatus(): EpochStatus & { self: number | null };
  getLastAckError(): string | null;
  getLocalValue(key: string): string | undefined;
  getLocalStore(): Map<string, { key: string; value: string; hlc: IHLCTimestamp }>;
  getLocalStoreSize(): number;
  registerConsumer(consumer: IFederationConsumer): void;
  getConsumers(): IFederationConsumer[];
  getHLC(): HLC;
  isStarted(): boolean;
  getHealth(): Promise<FederationHealth>;
  getReplication(): IMultiLeaderReplication;
  getCDC(): CDCManager;
  getSplitBrainDetector(): DCSplitBrainDetector;
  getConflictResolver(): ConflictResolver;
  getAntiEntropy(): AntiEntropy;
  onHealthChange(callback: (health: FederationHealth) => void): () => void;
  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void;
  onSplitBrainDetected(callback: (event: SplitBrainEvent) => void): () => void;
}
```

`FederationManagerConfig`: `nodeId`, `dc`, `replicationConfig`, `transport`,
`outbox`, `hlc?`, `healthConfig?`, `antiEntropyIntervalMs?`,
`antiEntropyExchangeTimeoutMs?`, `heartbeatIntervalMs?`, `bootstrapChunkSize?`,
`bootstrapResumePath?`, `bootstrapResumeAcrossRestarts?`, `handoffLogLimit?`,
`dlqScanIntervalMs?`, `outboxHousekeepingIntervalMs?`, `dedupWindowMs?`.

### `adoptLocalChange` — a change this layer never saw

```typescript
const entry = await manager.adoptLocalChange('user:1', 'alice', 'update');
```

Records a change that the local engine has **already committed**, and deliberately
does not replicate it. A deployment does not write only through `replicate()`:
applications write to the engine directly, and a change made that way is committed
by the cluster and absent from this layer — so the replica map stops being a copy of
the engine, and every component that compares the two compares a full store against
a partial one. Anti-entropy then pushes back keys the datacenter already has, and a
bootstrap resumed from a persisted cursor resumes into a map that is missing
everything before the cursor.

The method is what a composition root calls on boot to say what its engine already
holds. There is no outbox entry, because the caller is stating that the change is
already committed locally; sending it as well is `replicate()`.

### `DataProvider.apply()` proposes before it stores

`AntiEntropy` and the bootstrap apply entries through the manager's `DataProvider`,
and that provider proposes the entry to every registered `IFederationConsumer`
**before** writing the replica map. A value repaired into a datacenter is therefore
committed by the cluster that hosts it, not only visible through `read()`: a local
reader of the same key sees it, and it survives a restart because the state machine
is what a restart replays. A refused proposal rejects the `apply()`, so the push
that carried it fails and the next sweep repeats it — the reverse order would leave
the map holding a value the cluster refused, and no sweep could see a difference
again.

### `InboundOutcome`

What became of an inbound frame. Seven facts rather than one boolean, because a sender
retires an outbox entry on the answer and the answer has to be as strong as the claim
it replaces.

| Outcome        | What happened                                                                                   | What is answered       |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| `applied`      | written to the converged store, and every consumer proposed it into the local cluster           | `{ ok: true }`         |
| `duplicate`    | this node already applied that message id                                                       | `{ ok: true }`         |
| `superseded`   | the local value won the conflict; retrying would decide it the same way                         | `{ ok: true }`         |
| `malformed`    | the payload is not an envelope this build can read                                              | `{ ok: false, error }` |
| `declined`     | a consumer could not propose it — no leader, this node is a follower, the proposal was rejected | `{ ok: false, error }` |
| `not-a-change` | the frame is itself a confirmation; nothing was applied and nothing is answered                 | —                      |
| `stale-epoch`  | the frame came from an incarnation of the sender that this node has already moved past          | `{ ok: false, error }` |

`declined` releases the dedup id before it answers. Without that release the sender's
retry would be read as a duplicate of a change that never landed — one refusal followed
by one acknowledgement, which is a silent loss wearing two confirmations.

`stale-epoch` is decided before the dedup ring is consulted, and its id is _not_
recorded. A stale frame's id is one this node may well have applied in a previous
incarnation of the sender; remembering it would answer the current incarnation's retry
as a duplicate of a change that no longer exists.

### `AckTracker`

The bounded wait for a confirmation, used by both senders — `ExactlyOnceCDCPipeline`
and `MultiLeaderReplication`. It answers the question (a verdict, a timeout, or
`aborted` when _we_ stopped) and leaves the consequences to its caller: a pipeline
moves a checkpoint, a replication worker retires or charges an entry.

```typescript
class AckTracker {
  constructor(options: {
    timeoutMs: number;
    onTimeout?: (id: string, ms: number) => void;
    onUnsolicited?: (id: string) => void;
  });
  expect(messageId: string): Promise<CdcAckVerdict>;
  handle(frame: TransportMessage): boolean;
  release(reason: string): void;
  abandon(messageId: string, reason: string): void;
  get pending(): number;
  get received(): number;
  get timeouts(): number;
  get unsolicited(): number;
}
```

`expect()` is called before the frame is sent: an in-process transport delivers the
peer's reply inside the same tick, and an answer that arrives with nothing to match it
against is a lost answer — the entry would then wait out a budget the peer had already
met.

### `IncarnationLedger`

Which incarnation of each peer this node has heard from. A datacenter that has been
rebuilt, rolled back or re-keyed is a different incumbent of the same node id, and a
frame from the previous one carries a world the rebuild has already replaced: applying
it is how a deleted key comes back.

```typescript
class IncarnationLedger {
  assess(peerId: string, epoch: number | null | undefined): EpochVerdict;
  watermarkOf(peerId: string): number | null;
  refusalFor(peerId: string, epoch: number): string;
  getStatus(): EpochStatus; // { peers, refused, advanced, epochless }
}

type EpochVerdict = 'current' | 'newer' | 'stale' | 'unnamed';
```

| Verdict   | When                                                                 | What happens                                         |
| --------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `current` | the epoch equals the watermark, or is the first heard from that peer | applied                                              |
| `newer`   | a higher epoch than the watermark                                    | applied, and the watermark rises                     |
| `stale`   | a lower epoch than the watermark                                     | refused by name (`stale-epoch`), watermark unchanged |
| `unnamed` | no epoch on the frame                                                | applied and counted (`epochless`)                    |

Epochs are compared only against the same peer's own watermark — never across nodes,
because that would be a clock comparison dressed as a safety check. A peer that comes
back _higher_ is the peer rebuilt, and refusing it would take a datacenter out of
service for having been restored. A peer that comes back _lower_ is the case the
resurrection comes from.

`unnamed` is not a refusal: a peer on a build that predates the field cannot name its
incarnation, and refusing it would make the upgrade itself the outage. It is counted
so an operator can see how much of a fleet has not been rolled out.

**Where the number comes from.** `ITransport.getEpoch()` returns the incarnation the
transport stamps on every frame; `TcpSecureTransportOptions.epoch` (and
`InProcessTransportConfig.epoch`) set it, defaulting to `Date.now()` at construction.
Set it explicitly when the guarantee matters more than the default: a datacenter
rebuilt on a host whose clock is behind the previous incarnation would otherwise take a
number that reads as older to its peers. The number is a promise the deployment can
keep; the default is the best one available without asking.

On the wire the epoch travels on the frame's header (`FederationEnvelope.epoch`), and a
receiver reads it into `InboundMessage.sourceEpoch`. A frame from a build that predates
the field simply has no epoch.

### `IFederationConsumer`

The callback interface a database engine implements to receive replicated data.
`proposeReplicated()` hands the entry to the engine (typically through its Raft
group), `getHLC()` lets the manager attach a timestamp, and `onConflict()` is
called when an inbound value conflicts with a local one.

```typescript
interface IFederationConsumer {
  proposeReplicated(entry: ReplicatedEntry): Promise<void>;
  getHLC(): HLC;
  onConflict(conflict: ConflictEntry): Promise<void>;
}
```

### `ReplicatedEntry`

The unit that crosses a DC boundary: `key`, `data`, `type`, `sourceDc`,
`sourceNodeId` and `hlcTimestamp`. `key` is mandatory — the receiving side
applies per key, so an entry without one cannot be routed.

### `ConflictEntry`

The conflict report handed to a consumer: `key`, `localValue`, `remoteValue`,
`localHlc`, `remoteHlc`, `sourceDc`.

## Engine adapters

### `SqlVecFederationConsumer`

An `IFederationConsumer` for SQL engines that expose a Raft group: it proposes
the replicated entry into the local group and applies the HLC stamp on the way
in. Its configuration supplies the propose callback, the local HLC and a
conflict hook.

```typescript
class SqlVecFederationConsumer implements IFederationConsumer {
  constructor(config: SqlVecFederationConsumerConfig);
  proposeReplicated(entry: ReplicatedEntry): Promise<void>;
  getHLC(): HLC;
  onConflict(conflict: ConflictEntry): Promise<void>;
}
```

### `GraphVecFederationConsumer`

The same contract for graph engines, whose apply step is keyed by vertex or edge
rather than by a SQL statement, and whose conflict hook can rewrite an edge
instead of a row.

```typescript
class GraphVecFederationConsumer implements IFederationConsumer {
  constructor(config: GraphVecFederationConsumerConfig);
  proposeReplicated(entry: ReplicatedEntry): Promise<void>;
  getHLC(): HLC;
  onConflict(conflict: ConflictEntry): Promise<void>;
}
```

`GraphVecFederationConsumerConfig` also accepts an
`IGraphVecConsensusProvider` — the seam (`propose`, `getAppliedIndex`,
`getHLC`) a graph engine exposes instead of a Raft group.

## Data types

| Type                                          | Where it is used                                                  |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `EdgeReplicaOptions` / `EdgeSyncStatus`       | Engine-agnostic dial and conflict callbacks; observable state     |
| `EdgeSourceConfig` / `IEdgeReplica`           | A CDC endpoint and the intake surface a consumer codes against    |
| `TransportMessage`                            | Everything a transport carries: id, type, sender, target, payload |
| `InboundMessage`                              | A received message plus the channel it arrived on                 |
| `PeerInfo`                                    | `peerId`, `address`, `connectedAt`, `latencyMs`                   |
| `TransportStats`                              | Messages and bytes in both directions, peers connected, uptime    |
| `OutboxStats`                                 | Total, pending and delivered entries, oldest pending timestamp    |
| `HLCStatus`                                   | Physical and logical clock components with the owning node id     |
| `ReplicationTarget`                           | A replication peer: node id, DC, role, address                    |
| `ReplicationStatus`                           | Per-target lag and pending counts                                 |
| `CDCChangeEvent`                              | One row change: table, operation, before/after, lsn, txId, HLC    |
| `CDCSubscription` / `ICDCPublication`         | Slot-side bookkeeping                                             |
| `ReplicationSlot` / `IReplicationSlotManager` | The engine-neutral slot seam                                      |
| `CDCCheckpoint`                               | Per-table confirmed LSN, persisted across restarts                |
| `CDCPipelineMetrics` / `CDCPipelineEvent`     | Pipeline counters and lifecycle events                            |

## Where the exhaustive list lives

This page is the map: every exported value, what it is for, and the shape a
caller codes against. The declaration that wins is the one in `src/` — every
signature above is a copy of it, and `pnpm check:docs-api` is what keeps the copy
honest.
