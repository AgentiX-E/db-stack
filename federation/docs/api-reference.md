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

## Transports

### `ITransport`

The seam every other layer sends through. An implementation delivers
`TransportMessage`s between nodes and reports its peers and counters.

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
  partition(): void;   // cut this node off from its registry
  heal(): void;        // restore it
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
delivery loop. Entries exceeding `maxRetries` move to the dead-letter queue
instead of blocking the head of the queue.

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
  getDeadLetterEntries(): DeadLetterEntry[];
  getDeadLetterStats(): { count: number };
  getPendingCount(): Promise<number>;
  getStats(): Promise<OutboxStats>;
  isCapacityExceeded(): boolean;
  housekeeping(): void;
  close(): void;
}
```

`OutboxStoreConfig`: `dataDir` (required), `ttlMs?` (default 14 days),
`maxRetries?` (default 3), `deadLetterTtlMs?` (default 7 days), `mapSize?`
(default 1 GiB).

`OutboxEntry` carries `id`, optional `msgId`, `targetPeerIds`, `payload`
(`Uint8Array`), `timestamp` (an HLC), `type`, `status`
(`'pending' | 'delivered' | 'failed'`) and attempt bookkeeping (`createdAt`,
`lastAttemptAt`, `attemptCount`, `lastError`). `OutboxEntryInput` is that shape
minus the fields the store owns.

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
  readonly wallTime: bigint;   // milliseconds since epoch
  readonly logical: number;    // tie-breaker within one millisecond
  readonly nodeId: string;     // final tie-breaker
  now(): IHLCTimestamp;
  observe(remote: IHLCTimestamp): void;
  compare(other: IHLCTimestamp): number;   // -1 | 0 | 1
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
  put(msgId: string): boolean;    // true when the id was new, false when it was a duplicate
  delete(msgId: string): boolean;
  clear(): void;
  getStats(): {
    size: number; totalSeen: number; totalDeduped: number;
    totalEvicted: number; capacity: number;
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
}
```

`MultiLeaderReplicationOptions`: `transport`, `outbox`, `config`
(`ReplicationConfig`), and an optional `hlc` for deterministic tests.
`ReplicationConfig`: `nodeId`, `dc`, `targets` (`ReplicationTarget[]`),
`curveDir`, `tickMs?`, `batchSize?`, `maxRetries?`.

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
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent;
}
```

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
stream and delivers no events. Delivery with ordering, retry and checkpoints is
`ExactlyOnceCDCPipeline`.

```typescript
class CDCPublicationRegistry {
  constructor(config: CDCPublicationRegistryConfig);
  createPublication(name: string, tables: string[]): Promise<ICDCPublication>;
  dropPublication(name: string): Promise<void>;
  createSubscription(name: string, publicationName: string, targetDsn: string): Promise<CDCSubscription>;
  dropSubscription(name: string): Promise<void>;
  getSubscriptions(): Promise<CDCSubscription[]>;
  getPublications(): Promise<ICDCPublication[]>;
}
```

`CDCPublicationRegistryConfig`: `nodeId`, `engine`.

### `ExactlyOnceCDCPipeline`

Exactly-once delivery on top of an at-least-once transport. Outbound, a change is
appended to the outbox before it is sent and the checkpoint advances only after
the peer confirms; inbound, the dedup ring rejects replays and the checkpoint
file makes a restart resume instead of re-send.

```typescript
class ExactlyOnceCDCPipeline {
  constructor(config: ExactlyOnceCDCPipelineConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent;
  processInbound(message: TransportMessage): { accepted: boolean; event?: CDCChangeEvent };
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
`dedupTtlMs?` (default 10 min), `transport?`, `remoteNodeId?`, plus the
checkpoint path.

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
    key: string, local: ConflictValue, remote: ConflictValue,
    defaultStrategy?: ConflictStrategy,
  ): Promise<ConflictResult>;
}
```

`ConflictValue`: `{ key, value, hlc, nodeId }`.
`ConflictResult`: `{ resolvedValue, strategyUsed, loserNodeIds, merged }`.
`ConflictPredicate`: `{ tableName?, keyPrefix? }`.
`CustomResolver`: `(key, local, remote) => Promise<ConflictResult>`.

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
  start(config?: AntiEntropyConfig): Promise<void>;
  stop(): Promise<void>;
  buildMerkleTree(): Promise<MerkleNode>;
  syncWith(peerNodeId: string): Promise<SyncResult>;
  syncAll(): Promise<SyncResult[]>;
  getMerkleRoot(shardId: string): Promise<string>;
  findDiffRanges(node: MerkleNode): Promise<Array<{ start: string; end: string }>>;
  getSyncHistory(): SyncResult[];
}
```

`AntiEntropyConfig`: `nodeId`, `intervalMs`, `merkleDepth`. `SyncResult`:
`{ nodeId, entriesSynced, entriesSkipped, conflictsResolved, durationMs,
completedAt }`.

### `MerkleNode`

One node of the digest tree: the key range it covers, its hash, and its
children.

### `DataEntry`

The unit anti-entropy compares and applies: `{ key, value, hlc }`.

### `DataProvider`

The four-method interface above that a consumer implements against its own
storage.

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
    shardIdOrKey: number | string, valueOrData: string, type: string,
    remoteValue?: ConflictValue,
  ): Promise<{ msgId: string }>;
  applyInbound(msg: InboundMessage): Promise<'applied' | 'duplicate' | 'superseded' | 'malformed'>;
  getLastInboundError(): string | null;
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
`outbox`, `hlc?`, `healthConfig?`.

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

| Type | Where it is used |
|------|------------------|
| `TransportMessage` | Everything a transport carries: id, type, sender, target, payload |
| `InboundMessage` | A received message plus the channel it arrived on |
| `PeerInfo` | `peerId`, `address`, `connectedAt`, `latencyMs` |
| `TransportStats` | Messages and bytes in both directions, peers connected, uptime |
| `OutboxStats` | Total, pending and delivered entries, oldest pending timestamp |
| `HLCStatus` | Physical and logical clock components with the owning node id |
| `ReplicationTarget` | A replication peer: node id, DC, role, address |
| `ReplicationStatus` | Per-target lag and pending counts |
| `CDCChangeEvent` | One row change: table, operation, before/after, lsn, txId, HLC |
| `CDCSubscription` / `ICDCPublication` | Slot-side bookkeeping |
| `ReplicationSlot` / `IReplicationSlotManager` | The engine-neutral slot seam |
| `CDCCheckpoint` | Per-table confirmed LSN, persisted across restarts |
| `CDCPipelineMetrics` / `CDCPipelineEvent` | Pipeline counters and lifecycle events |

## Where the exhaustive list lives

This page is the map: every exported value, what it is for, and the shape a
caller codes against. The declaration that wins is the one in `src/` — every
signature above is a copy of it, and `pnpm check:docs-api` is what keeps the copy
honest.
