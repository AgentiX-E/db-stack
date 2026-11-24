# Federation guide

`@agentix-e/db-federation` connects **independent clusters** across datacenters. Each
cluster keeps its own consensus group and its own low write latency; the federation layer
moves changes between them, resolves conflicts, and repairs divergence.

Install:

```bash
npm install @agentix-e/db-federation
```

Choose your topology before writing code — it determines everything else:

| Topology                          | Write latency                        | Cross-DC consistency          | Use when                                 |
| --------------------------------- | ------------------------------------ | ----------------------------- | ---------------------------------------- |
| Active–passive (single leader DC) | Local in the primary; followers read | Converges quickly, one writer | DR, read scaling                         |
| Active–active (multi-leader)      | Local everywhere                     | Converges; conflicts possible | Geographically distributed write traffic |
| Edge read replica                 | Local writes in the core             | Read-only at the edge         | CDN-like read locality                   |

---

## 1. Change capture (CDC)

A CDC engine turns your database's change stream into typed events:

```ts
export interface ICDCEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  onChange(callback: (event: CDCChangeEvent) => void): () => void;
}

export interface CDCChangeEvent {
  lsn: string; // monotonic log sequence number in the source engine
  timestamp: IHLCTimestamp; // hybrid logical clock stamp
  tableName: string;
  operation: "insert" | "update" | "delete";
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  txId: string;
}
```

**The engine-agnostic contract is this interface, not a driver.** Bundled adapters cover
the reference SQLite engine; for PostgreSQL, MySQL, MongoDB or a proprietary engine you
implement one class: read your change stream, stamp each change with the HLC, call the
callback. See [engine adapters](engine-adapters.md#3-change-capture-for-federation).

### Reading a real change log

`CDCEngine` is a simulator: it emits whatever `appendChange()` is given, which is what
the unit tests need and not what a deployment has. To run CDC against a log your
database actually wrote, implement `IChangeLogReader` — two methods — and put
`WalTailCDCEngine` on top of it:

```ts
export interface IChangeLogReader {
  // Records strictly after `afterLsn`, in order, at most `limit`.
  // A record must be durable before it is returned.
  readAfter(afterLsn: string | null, limit: number): Promise<ChangeLogRecord[]>;
  // The newest position the log holds, or null when it is empty.
  head(): Promise<string | null>;
}
```

For a PostgreSQL logical-replication slot, `readAfter` decodes WAL records from the
slot's confirmed position; for a MySQL binlog, it reads from the last position the
consumer confirmed. Everything above the interface — the pipeline, the outbox, the
transport, the dedup ring — is unchanged, which is the point: the read end is the
only part that knows what your engine's log looks like.

If you would rather see the whole path working before writing an adapter, the package
ships a reference log on disk:

```ts
import { openFileChangeLog, WalTailCDCEngine, ExactlyOnceCDCPipeline } from "@agentix-e/db-federation";

const { writer, reader } = await openFileChangeLog({ dir: "/var/lib/app/changelog" });

// The producer side: appends and fsyncs, then hands back the position.
await writer.append({ table: "orders", operation: "insert", newValues: { id: 7 }, txId: "tx-1" });

// The consumer side: resume where the last run stopped, then tail.
const checkpoint = ExactlyOnceCDCPipeline.readCheckpoint("/var/lib/app/outbox");
const engine = new WalTailCDCEngine({
  reader,
  nodeId: "dc-east-1",
  startAfterLsn: ExactlyOnceCDCPipeline.resumePosition(checkpoint),
});
```

Three behaviours of the tail are worth knowing before you deploy it:

- **The cursor advances past tables nobody watches.** The position belongs to the log,
  not to a subscription. A cursor that waited for an unwatched table would re-read those
  records on every poll, and a batch limit would then starve the tables you do watch.
- **A read error does not stop the tail.** It is counted (`getStatus().readErrors`),
  kept (`lastError`), passed to `onReadError` if you set one, and retried on the next
  tick. A transient `EACCES` should not wedge a stream until the process restarts.
- **An empty watch set delivers everything.** Silence would be indistinguishable from a
  misconfigured deployment, so a tail that has not been told what it wants delivers what
  the log holds.

`ExactlyOnceCDCPipeline.resumePosition` returns the *earliest* position in the
checkpoint, not the latest. One tail has one cursor and a checkpoint has one position
per table, so resuming at the latest would skip every row of a table that is behind;
resuming at the earliest re-reads some rows, and the receiver's dedup ring removes the
duplicates. A duplicate is recoverable, a gap is not.

Publications and subscriptions group tables:

```ts
const registry = new CDCPublicationRegistry({ engine, nodeId: "dc-east-1" });
await registry.createPublication("orders-pub", ["orders", "order_items"]);
await registry.createSubscription(
  "to-west",
  "orders-pub",
  "https://hooks.example.com/cdc",
);
await registry.createSubscription(
  "inserts-only",
  "orders-pub",
  "memory://audit",
  ["insert"],
);
```

`CDCPublicationRegistry` keeps the named objects; `CDCManager` streams the
changes. They are separate because a publication outlives any one streaming
session — the registry even survives a `FederationManager.stop()`, whereas the
manager's engines do not.

### Delivering the changes to a sink

The catalogue records a destination; `CDCSubscriptionPump` uses it. You supply one
function — DSN to sink — and the pump does the rest: it connects a sink per
subscription, filters the engine's stream by table and by operation, and delivers
each change once, in order.

```ts
import { CDCSubscriptionPump, HttpCDCSink } from "@agentix-e/db-federation";

const pump = new CDCSubscriptionPump({
  engine,
  registry,
  // The pump asks this factory for a sink per subscription's target DSN.
  resolveSink: (dsn) =>
    new HttpCDCSink({
      url: dsn,
      headers: { authorization: `Bearer ${process.env.CDC_TOKEN}` },
      timeoutMs: 2_000,
      probe: { method: "GET" },
    }),
});
await pump.start();

// From here on, whatever your engine appends is delivered to the subscription's
// sink — in LSN order, once per change.
```

`HttpCDCSink` is the bundled destination for anything that speaks HTTP: it batches
the events into `{"events": […]}`, posts them over a keep-alive socket, and resolves
only on a 2xx. A non-2xx status, a connection error and a timeout are all refusals,
each carrying enough detail to tell which one happened. For a queue, a filesystem or
a proprietary protocol, implement `ICDCSink` yourself — three methods, and the pump
treats it identically.

Throwing from `emit()` is how a sink says _no_. The pump retries the same change
`maxEmitAttempts` times, then records it in a bounded failure log
(`pump.getFailures()`) and moves on — one bad change does not block the ones
behind it, and it never disappears silently:

```ts
const status = pump.getStatus();
// { started: true, subscriptions: 2, unopened: [], pending: { 'to-west': 0 },
//   delivered: 412, failed: 1, dropped: 0, evictedFailures: 0 }

const [failure] = pump.getFailures();
// { subscriptionId: 'to-west', eventId: '0/0000019C:9f2c…', table: 'orders',
//   attempts: 3, error: 'https://hooks.example.com/cdc: 503', at: … }
```

A subscription created after `start()` is picked up by `await pump.sync()`; one
dropped from the catalogue is closed by the same call. A DSN the factory cannot
resolve does not stop the other subscriptions — it lands in
`getStatus().unopened` and is retried by the next `sync()`.

Two things the pump deliberately leaves to you. It does not invent a primary
key: `CDCChangeEvent` names no key column, so the default projection leaves
`CDCSinkEvent.key` empty and you supply `project` if your sink needs row
identity. And it does not own the DSN schemes: a factory you write decides what
`https://`, `kafka://` or `memory://` mean, which is what keeps this middleware
free of any one destination's client library.

---

## 2. Exactly-once delivery

The pipeline is _outbox-before-send_:

```
commit ──▶ outbox append (durable) ──▶ pump ──▶ transport ──▶ peer
                    ▲                                          │
                    └────── ack / retry with backoff ◀─────────┘
```

```ts
const pipeline = new ExactlyOnceCDCPipeline({
  nodeId: "dc-east-1",
  cdcConfig: { nodeId: "dc-east-1" },
  outboxConfig: { dataDir: "/var/lib/db/outbox", maxSizeMB: 1024 },
  transport,
  remoteNodeId: "dc-west-1",
  pumpIntervalMs: 500,
  pumpBatchSize: 100,
  dedupTtlMs: 600_000,
});
await pipeline.start();
```

| Property         | Mechanism                                             | Consequence                                           |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| No loss on crash | Change is persisted to the outbox before transmission | A restart resumes from the checkpoint                 |
| At-least-once    | Retries until acknowledged                            | Duplicates are possible on the wire                   |
| Effectively-once | Receiver-side `DedupRing` keyed by message id         | Each change takes effect once within the dedup window |
| Bounded memory   | `pumpBatchSize`, `maxSizeMB` backpressure             | Throughput is capped, not the heap                    |

**Dedup window caveat:** duplicates arriving after `dedupTtlMs` are treated as new. Size it
above your maximum expected outage.

---

## 3. Conflict resolution

Two DCs can write the same key. You choose the semantics per table or key prefix:

| Strategy               | Config value     | Behaviour                                | Discards data?  |
| ---------------------- | ---------------- | ---------------------------------------- | --------------- |
| Last-write-wins on HLC | `'lww'`          | Greater HLC wins; ties broken by node id | Yes — the loser |
| Counter                | `'crdt-counter'` | Values merge additively                  | No              |
| Set                    | `'crdt-set'`     | Union with add/remove tombstones         | No              |
| Map                    | `'crdt-map'`     | Per-field LWW inside a map               | Per field       |
| Custom                 | `'custom'`       | Your resolver decides                    | Up to you       |

```ts
import { ConflictResolver } from "@agentix-e/db-federation";

const resolver = new ConflictResolver("dc-east-1");

// A predicate names the keys this rule owns; the resolver decides the value.
resolver.registerCustomResolver(
  { keyPrefix: "inventory:" },
  async (key, local, remote) => ({
    key,
    resolvedValue: JSON.stringify(mergeInventory(JSON.parse(local.value), JSON.parse(remote.value))),
    strategyUsed: "custom",
    loserNodeIds: [],
    merged: true,
  }),
);

const verdict = await resolver.resolve("inventory:sku-7", localValue, remoteValue);
```

`resolve()` picks the strategy itself: a registered custom resolver whose predicate
matches the key wins, otherwise the built-in CRDT strategies apply when the stored value
parses as one, and `lww` is the fallback.

**LWW is lossy by design.** If a lost write is unacceptable, use a CRDT or an
application-level merge — the transport cannot invent information the merge discards.

---

## 4. Anti-entropy reconciliation

After a partition, the two sides have diverged. Merkle trees let each side compute a
summary and exchange only the differing leaves:

```ts
import { AntiEntropy, type DataProvider } from "@agentix-e/db-federation";

const antiEntropy = new AntiEntropy(
  { nodeId: "dc-east-1", merkleDepth: 4, intervalMs: 5_000 },
  dataProvider, // getRange / getEntriesAfter / get / apply — your storage, not ours
);
await antiEntropy.start();
const results = await antiEntropy.syncAll();
// SyncResult[] — { nodeId, entriesSynced, entriesSkipped, conflictsResolved, durationMs, completedAt }
```

`AntiEntropy` reconciles one side against a `DataProvider`. It does **not** carry the
remote side over a socket: `syncWith(peerId)` and `syncAll()` compare the local Merkle
tree against the provider they were given, so pointing both sides at the same provider
compares the local dataset with itself and reports convergence that was never in doubt.
A real cross-datacenter sweep needs a remote Merkle source in front of the provider,
and that port is not implemented in this package — see
[maturity](../maturity.md) for the current state.

Cost is proportional to **divergence**, not to total data size — that is the entire point
of the Merkle approach. Run it after any partition, and periodically as a safety net.

---

## 5. Multi-leader and topology

```ts
import { FederationManager, MultiLeaderReplication, OutboxStore } from "@agentix-e/db-federation";

const outbox = new OutboxStore({ dataDir: "/var/lib/db/outbox" });

const replicationConfig = {
  nodeId: "dc-east-1",
  dc: "east",
  curveDir: "/var/lib/db/outbox",
  targets: [
    {
      nodeId: "dc-west-1",
      dc: "west",
      address: "west.internal:7443",
      topology: "cross-dc" as const,
      maxBackoffSeconds: 60,
    },
  ],
};

// The manager takes the replication engine, then its own config: it owns the
// change stream, the health monitor, the split-brain detector and the
// anti-entropy sweep, and the engine is the one thing it delegates.
const federation = new FederationManager(
  new MultiLeaderReplication({ transport, outbox, config: replicationConfig }),
  { nodeId: "dc-east-1", dc: "east", replicationConfig, transport, outbox },
);
await federation.start();
```

`ReplicationConfig` has exactly these fields — `nodeId`, `dc`, `targets`, `curveDir`,
and the optional `tickMs`, `batchSize`, `maxRetries`. Per-target `priority` does not
exist, and `topology` belongs to the target (`intra-dc`, `cross-dc`, `edge`), not to the
config.

| Concern               | Component                        | What it does                                                     |
| --------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Peer lifecycle        | `TopologyManager`                | Tracks membership, assigns topology epochs, emits change events  |
| Split-brain detection | `DCSplitBrainDetector`           | Compares cluster identity + epoch; refuses to merge a stale view |
| Fan-out               | `MultiLeaderReplication`         | One logical stream per peer, independent backpressure            |
| Edge reads            | `EdgeReplica`                    | Resumable read-only stream from the primary (restart from LSN)   |
| Health                | `HealthMonitor`, `ChannelHealth` | Per-peer lag/error/jitter scored 0–100                           |

Channel health is a weighted score, so a dashboard shows _why_ a channel is unhealthy:

```
health = 100 − min(lag_ms/1000, 1)·30 − (err/(err+0.01))·40 − min(reconnects·5, 25) − min(log2(jitter+1)·2, 10)
```

---

## 6. Cross-cluster routing

`QueryRouter` sends a query to the cluster that owns the data:

```ts
import { FederatedQueryRouter } from "@agentix-e/db-federation";

const router = new FederatedQueryRouter();
router.registerNode({
  id: "dc-west-1",
  host: "west.internal",
  port: 5432,
  role: "replica",
  health: "healthy",
  shardIds: ["orders"],
  weight: 1,
  capabilities: ["read"],
  region: "west",
});
router.setRoutingPolicy({ strategy: "leader_only", fallbackStrategy: "round_robin", maxRetries: 2 });

const plan = router.planQuery({
  id: "q-1",
  sql: "SELECT * FROM orders WHERE id = $1",
  intent: "read",
  consistency: "read_your_writes",
  targetShards: ["orders"],
  timeoutMs: 2_000,
});
```

Strategies: `round_robin`, `least_connections`, `weighted`, `geo_affinity`, `cost_based`,
`leader_only`. Routing decisions are _routing hints_, not guarantees; the owning cluster
still enforces its own consistency rules. `consistency` is carried in the query type and
is not yet consulted by the router.

---

## 7. Security

All cross-DC traffic uses `TcpSecureTransport`: TLS 1.3 with mutual certificate
verification. There is no plaintext mode and no "trust the network" switch.

```ts
const transport = new TcpSecureTransport({
  nodeId: "dc-east-1",
  listen: { host: "0.0.0.0", port: 7443 },
  peers: [{ nodeId: "dc-west-1", host: "west.example.net", port: 7443 }],
  tls: { cert, key, ca },
});
await transport.start();
```

Certificates are the identity: a peer presenting a certificate from an unknown CA fails
the handshake and appears as a connection error — never as a silent no-op.

### 7.1 The wire id comes from the certificate

Each node is addressed across the wire by a number, and that number is not a free choice:
an inbound connection is identified by the number in its certificate's common name
(`raft-node-<n>`). The transport therefore derives the number from the node id — `dc-west-7`
becomes 7 — and refuses to start when it cannot:

```
Error: node dc-west has no number in its id, so its wire id cannot be derived; pass an
explicit transportNodeId that matches the number in its certificate common name (raft-node-<n>)
```

Name nodes with a number (`dc-west-1`, `dc-west-2`) or pass `transportNodeId` explicitly.
Two nodes that end up with the same number are refused at construction as well: they would
otherwise be one node on the wire, the routing table would hold one entry for two peers, and
`send()` would report success into it.

> **Changed in 1.3.** Before this, every id without a digit fell back to `1`, which is also
> the default id of a peer listed first. A federation configured with `dc-west` and
> `dc-east` never connected — the listeners came up, `getConnectedPeers()` stayed empty, and
> every send refused with `peer dc-east (1) not connected`. If you have such a
> configuration, it was not working; give the nodes numbers.

---

## 8. Operating a federation

| Symptom                         | First thing to check            | Likely cause                            |
| ------------------------------- | ------------------------------- | --------------------------------------- |
| Outbox grows monotonically      | `ChannelHealth` reconnect count | Link down or certificate expired        |
| Lag grows but no errors         | Peer RTT, `pumpBatchSize`       | Throughput cap, not failure             |
| Divergent values after recovery | Conflict strategy for the table | LWW discarding a write that mattered    |
| Duplicate effects               | `dedupTtlMs` vs outage length   | Dedup window too short                  |
| Split-brain warning             | Topology epochs of both sides   | A DC was restored from a stale snapshot |

A federation is healthy when: outbox depth is flat, lag is bounded by your SLO, channel
health is > 80, and a periodic anti-entropy pass reports zero divergent ranges.

## 9. Checking the delivery rules yourself

Sections 1 and 2 describe what this package promises: a change reaches a sink once, in LSN order,
and a refusal is retried and then recorded rather than dropped. Those are claims about your
deployment, and you can test them against your own sink instead of taking ours on trust.

`@agentix-e/db-federation/testing` publishes `CDCFailureInjector`, which wraps any `ICDCSink` and
injects the faults you name — a dropped connection, a latency spike, a partial emit, a duplicate, a
reordered batch:

```ts
import { CDCFailureInjector } from "@agentix-e/db-federation/testing";

const injector = new CDCFailureInjector(mySink, [
  { type: "connection_drop", failEveryN: 3, maxFailures: 2, on: "emit" },
]);
```

Then drive the pipeline and assert what reached the sink underneath. A fault the injector did not
actually fire is not counted, so `injectedBy('connection_drop')` tells you whether your test
measured a fault or a quiet run — which is the difference between a passing test and a meaningful
one. The reference page is [../federation/docs/testing.md](../federation/docs/testing.md), and it
ships inside the published package at `docs/testing.md` — every package here now carries its
documentation in the tarball, not only in the repository.
