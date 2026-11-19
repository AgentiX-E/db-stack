# Engine adapters

The stack ships with a reference storage engine (SQLite) so it runs out of the box, but
**nothing in the middleware requires it**. Every place where an engine is touched is an
interface plus a callback contract. This page is the complete list: if you can implement
the interfaces below, the cluster, federation and operations layers work with your
database unchanged.

```
your engine
   │
   ├── IShardReplica        ← cluster asks "apply this committed entry / snapshot / restore"
   ├── IWalStorage          ← cluster asks "append / read / truncate the log"
   ├── ICDCEngine           ← federation asks "what changed, in order?"
   ├── IOutboxStore         ← federation asks "keep this change until it is delivered"
   ├── ITransport           ← federation asks "put these bytes on the wire"
   └── provider tokens      ← operations asks "probe / back up / measure / authenticate"
```

---

## 1. The storage engine contract (required)

There are two interfaces, and you implement one of them.

```
Raft ──apply(entry)──▶ IShardReplica ──▶ EngineBackedReplica ──▶ IStorageEngine ──▶ your database
        snapshot()                        (positioning, replay,          (apply / query /
        restore()                          framing, checksums)           snapshot / restore)
```

`IShardReplica` is what the consensus layer calls. `EngineBackedReplica` implements it once,
correctly, for every engine; you supply `IStorageEngine`, which is only about your data:

```ts
import type { EngineApplyContext, IStorageEngine } from '@agentix-e/db-cluster';

export interface IStorageEngine {
  /** Stable identifier for logs, metrics and conformance reports. */
  readonly name: string;

  /** Apply one committed command. Called exactly once per index, in order. */
  apply(context: EngineApplyContext, payload: Buffer): Promise<void>;

  /** Evaluate a read against applied state. Side-effect free. */
  query(request: Buffer): Promise<Buffer>;

  /** Serialize the entire applied state. */
  snapshot(): Promise<Buffer>;

  /** Replace the entire state. Validate before mutating. */
  restore(snapshot: Buffer): Promise<void>;

  /** Live state size in bytes; 0 means empty, never "unknown". */
  sizeInBytes(): Promise<number>;

  /** Release resources. Idempotent. */
  close(): Promise<void>;
}

export interface EngineApplyContext {
  readonly shardId: number;   // which shard this entry belongs to
  readonly index: number;     // exact Raft log index: strictly increasing, from 1
  readonly applyTerm: number; // term at apply time (diagnostic, not a correctness input)
  readonly operation?: string;
  readonly msgId?: string;
}
```

The payload is **opaque bytes that your own encoder produced**. A SQL engine puts a
statement there; a KV engine puts an opcode; a columnar engine puts a write batch. The
middleware never parses it, so there is no schema and no data model to conform to.

### Wiring it up

```ts
import { RaftGroup, EngineBackedReplica, MemoryStorageEngine } from '@agentix-e/db-cluster';

const engine = new MemoryStorageEngine();          // ← your engine goes here
const replica = new EngineBackedReplica({ shardId: 0, engine });

const group = new RaftGroup(
  0,                                               // shard id
  { id: 1, peers: [2, 3], electionTick: 10, heartbeatTick: 1 },
  replica,
  outboxManager,                                   // an IOutboxWriter; the shard's own
);
await group.init();
```

`RaftGroup` takes its collaborators positionally, and the shard id comes first —
it is the shard, not a field of the config, because one process owns many.

That is the entire integration. `EngineBackedReplica` then guarantees, on your behalf:

| Guarantee | Why it cannot be left to the engine |
|---|---|
| **Exactly-once replay** | After a restart Raft replays every entry above the snapshot. The adapter drops indexes the engine already applied, so `SET balance = balance + 10` never becomes `+20`. |
| **Monotonic position** | Indexes increase but are *not* consecutive: Raft applies CONFIG and NOOP entries itself and never calls your engine for them, so a forward jump is normal. Going backwards is what the adapter refuses. |
| **Serialization** | Applies run one at a time even when callers forget to await. |
| **Positioned snapshots** | Raw engine bytes carry no position, so a restarted replica could not tell Raft where to resume. The adapter frames every snapshot with `(shardId, index, term)` and a CRC32 — where `index` is the boundary Raft declares, which is exactly the position a restore must resume from. |
| **Corruption is loud** | A truncated, bit-flipped or cross-shard snapshot is rejected before the engine is touched, leaving a healthy replica intact. |
| **Snapshot is a consistent cut** | The adapter waits for in-flight applies, so the payload and the recorded index describe the same state. |

The frame is 30 bytes, big-endian, so the bytes mean the same thing on every platform:

```
0  magic 'DBSE' | 4 version u16 | 6 shardId u32 | 10 index u64 | 18 term u64 | 26 CRC32 u32 | 30 payload
```

### Prove it: the published conformance suite

Do not take the table above on trust, and do not re-derive the contract from the
middleware's behaviour — run it:

```ts
import { describe, it } from 'vitest';
import { runEngineConformance } from '@agentix-e/db-cluster/testing';
import { MyEngine } from './my-engine';

runEngineConformance({
  label: 'my-engine',
  framework: { describe, it },          // vitest, jest, mocha or node:test
  create: () => new MyEngine(),
  codec: {
    put: (key, value) => myEncode({ op: 'put', key, value }),
    del: (key) => myEncode({ op: 'del', key }),
    get: (key) => myEncode({ op: 'get', key }),
    keys: () => myEncode({ op: 'keys' }),
    decodeGet: (response) => myDecodeGet(response),   // null means "absent"
    decodeKeys: (response) => myDecodeKeys(response),
  },
});
```

The suite is 23 checks across four groups — apply/query semantics, snapshot and restore,
replica positioning (replay, gaps, failures, concurrency), and lifecycle. It runs against
the two engines this repository ships (`MemoryStorageEngine` and a SQLite-backed engine) with
no special-casing, which is how the contract stays engine-agnostic instead of drifting into
"whatever the reference implementation happens to do".

### Where the applied index comes from

`EngineApplyContext.index` is exact, and the middleware has to work for it: raft-core hands
its state machine only the command payload, so db-cluster derives the position from the
apply loop itself and forwards it. Before this was wired, every engine saw index `0` and
term `0`, which made idempotent replay impossible to implement and left point-in-time
recovery records unpositioned.

### The five rules your engine must still honour

1. **A rejecting `apply` writes nothing.** A partial write is replayed on restart and will
   be applied twice.
2. **`snapshot()` is self-contained.** No pointers, no host byte order, no references to
   files that will not exist on the next node.
3. **`restore()` replaces.** Not merge, not append.
4. **`sizeInBytes()` is monotone until you compact.** It drives compaction decisions.
5. **`close()` is idempotent.** Shutdown races with initialisation failure.

Rules 1–5 plus the six adapter guarantees are what the suite encodes. Two engines in this
repository pass it; an engine that fails it will corrupt data under failover, and no amount
of cluster-side testing will catch that for you.

## 2. The log store contract (optional)

The Raft log is a separate concern from your data. SQLite is the default; replace it if you
already have a durable append-only store:

```ts
export interface IWalStorage {
  append(entry: Omit<LogEntry, 'index' | 'timestamp'>): Promise<OperationResult<number>>;
  appendBatch(entries: Omit<LogEntry, 'index' | 'timestamp'>[]): Promise<OperationResult<number[]>>;
  read(index: number): Promise<OperationResult<LogEntry | null>>;
  readRange(startIndex: number, endIndex: number): Promise<OperationResult<LogEntry[]>>;
  lastEntry(): Promise<OperationResult<LogEntry | null>>;
  length(): Promise<OperationResult<number>>;
  truncate(lastIndex: number): Promise<OperationResult<void>>;
  // snapshot metadata storage follows the same shape
}
```

| Requirement | Why it is not negotiable |
|---|---|
| `append` is durable before it resolves | The acknowledgement you send to the leader is a promise about disk |
| `appendBatch` is atomic | A partially applied batch corrupts the log |
| `readRange` is ordered and gap-free | The replication protocol assumes contiguity |
| `truncate` discards a suffix | Conflict resolution rewrites an uncommitted tail |

---

## 3. Change capture for federation (required for federation)

```ts
export interface ICDCEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  watchTable(tableName: string): void;
  unwatchTable(tableName: string): void;
  getWatchedTables(): string[];
  onChange(callback: (event: CDCChangeEvent) => void): () => void;
}
```

Your implementation converts your engine's native change stream into `CDCChangeEvent`
objects with a monotonic `lsn`, an HLC `timestamp`, before/after images and a `txId`.

| Engine family | Where the changes come from |
|---|---|
| PostgreSQL | Logical replication slot (`pgoutput`) → decode insert/update/delete |
| MySQL / MariaDB | Binlog (ROW format) → row events |
| MongoDB | Change streams (replica set oplog) |
| Kafka-backed stores | Consume the topic, map offsets to `lsn` |
| Embedded / custom | Your own WAL, or an outbox written in the same transaction as the data |

**Ordering:** events must be emitted in commit order per table. If your engine can commit
out of order relative to LSN assignment, sort inside the adapter — the pipeline assumes
monotonic delivery.

---

## 4. Durable delivery contract

```ts
export interface IOutboxStore {
  add(entry: Omit<OutboxEntry, 'id'>): Promise<OutboxEntry>;
  addBatch?(entries: Array<Omit<OutboxEntry, 'id'>>): OutboxEntry[];
  fetchOldestPending(count: number, limit?: number): Promise<OutboxEntry[]>;
  markDelivered(entryId: string): Promise<void>;
  getPendingCount(): Promise<number>;
  // …stats and purge
}
```

Rules: `add` must be durable before it resolves (this is the crash-safety boundary),
`fetchOldestPending` must be FIFO, and `markDelivered` must be idempotent.

```ts
export interface ITransport {
  send(message: TransportMessage): Promise<boolean>;
  broadcast(message: TransportMessage): Promise<number>;
  onMessage(callback: (message: InboundMessage) => void): () => void;
  getConnectedPeers(): PeerInfo[];
  getStats(): TransportStats;
}
```

`send` returning `true` means *enqueued*, not *delivered*. Delivery is confirmed by the
peer's acknowledgement, which is why the outbox keeps the entry until `markDelivered`.

---

## 5. Operations contract

The operations packages never touch a database directly. You supply providers:

| Token | You provide | Used by |
|---|---|---|
| `ILogger` | Structured logger | everything |
| `IHealthProbe` | `liveness()` / `readiness()` | `health` |
| `IMetricsSink` | Counter/gauge/histogram sink | `metrics` |
| `IBackupAdapter` | `create()`, `openStream()`, `restore()` | `backup` |
| `IEncryptionProvider` | `encrypt()`, `decrypt()`, `rewrap()` | `security` |
| `IAuditStore` | `append()`, `query()`, `verify()` | `audit` |
| `IAuthProvider` | `authenticate()`, `authorize()` | `auth` |

```ts
registry.register(token<IHealthProbe>('IHealthProbe'), {
  liveness: async () => (await engine.ping()) === 'ok',
  readiness: async () => (await engine.replicaLagMs()) < 5_000,
});
```

---

## 6. Adapter conformance checklist

Use this as the acceptance list for your adapter. Each line is something the middleware
will do to you, and something it will not forgive.

| # | Requirement | Failure if violated |
|---|---|---|
| 1 | Re-applying the same index is a no-op | Counters drift, rows duplicate after crash recovery |
| 2 | `apply()` resolves only after the write is durable and visible | Acknowledged writes disappear on failover |
| 3 | `snapshot()` is a consistent cut | A restored replica never converges |
| 4 | `restore()` fully replaces state | Stale keys survive a snapshot install |
| 5 | `getAppliedIndex()` never goes backwards | Cluster computes negative lag, compaction stalls |
| 6 | `dataSize()` is monotone until compaction | Compaction oscillates |
| 7 | Log `append` is durable before resolving | Committed entries are lost on power loss |
| 8 | Log reads are gap-free and ordered | Replication breaks with a confusing term mismatch |
| 9 | CDC events are emitted in commit order | Federation applies a delete before its insert |
| 10 | Outbox `add` is durable before resolving | Cross-DC writes are lost on crash |
| 11 | `markDelivered` is idempotent | Outbox re-delivers forever |
| 12 | Probes never throw; they return status | A resolved probe crashes the health orchestrator |
| 13 | No secrets in logs | Audit failure and credential leakage |

Items 1–6 are executable: `runEngineConformance()` from `@agentix-e/db-cluster/testing`
checks them against your engine, with no access to cluster internals. Items 7–13 are checked
by the federation and operations suites in this repository; they exercise the adapters only
through the interfaces listed above.
