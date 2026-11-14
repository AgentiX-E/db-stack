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

## 1. The state machine contract (required)

A committed entry is only useful if it changes your engine's state. Implement
`IShardReplica`:

```ts
export interface ApplyEntry {
  index: number;
  term: number;
  command: string;
  data: Buffer | string;
  msgId?: string;
  type?: string;
}

export interface IShardReplica {
  /** Apply one committed entry, in index order, exactly once. */
  apply(entry: ApplyEntry): Promise<void>;
  /** Highest index this replica has applied (used by the cluster for lag). */
  getAppliedIndex(): Promise<number>;
  lastAppliedIndex(): number;
  shardId(): number;
  /** Serialise the whole state for a snapshot. Must be consistent. */
  snapshot(): Promise<Buffer>;
  /** Replace the whole state from snapshot bytes. */
  restore(snapshot: Buffer): Promise<void>;
  /** Approximate on-disk state size (drives compaction decisions). */
  dataSize(): Promise<number>;
}
```

### The four rules that make an adapter correct

1. **Apply must be idempotent at the index level.** After a crash the cluster replays from
   the last snapshot; a duplicate apply must not double-count a counter or re-insert a row.
   Either key your writes by `index` or apply inside a transaction guarded by
   `getAppliedIndex()`.
2. **Apply must be synchronous with respect to ordering.** The cluster calls `apply()`
   sequentially; if you fan out internally, you must not resolve before the write is
   durable *and* visible to the next apply.
3. **`snapshot()` must be a consistent cut.** Take it under the same lock/cursor as
   `apply()`. A snapshot that spans a partially applied entry produces a replica that can
   never converge.
4. **`restore()` must replace, not merge.** Installing a snapshot means "my state is now
   exactly this".

### Example: a key-value engine in 30 lines

```ts
import type { IShardReplica, ApplyEntry } from '@agentix-e/db-cluster';

export class KvReplica implements IShardReplica {
  private readonly data = new Map<string, string>();
  private applied = 0;

  constructor(private readonly id: number) {}

  async apply(entry: ApplyEntry): Promise<void> {
    if (entry.index <= this.applied) return;                 // rule 1: idempotent
    const { key, value, expect } = JSON.parse(entry.data.toString());
    if (expect !== undefined && this.data.get(key) !== expect) {
      throw new Error(`compare-and-set failed at index ${entry.index}`);
    }
    if (value === null) this.data.delete(key); else this.data.set(key, value);
    this.applied = entry.index;                              // committed before resolving
  }

  async getAppliedIndex(): Promise<number> { return this.applied; }
  lastAppliedIndex(): number { return this.applied; }
  shardId(): number { return this.id; }
  async snapshot(): Promise<Buffer> { return Buffer.from(JSON.stringify([...this.data])); }
  async restore(buf: Buffer): Promise<void> {
    this.data.clear();
    for (const [k, v] of JSON.parse(buf.toString())) this.data.set(k, v);
  }
  async dataSize(): Promise<number> { return this.data.size; }
}
```

Wire it in via `RaftGroup`/`ShardManager` and every cluster feature — snapshots, learners,
resharding, PITR — applies to your engine with no further work.

---

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

If your adapter satisfies 1–13, the conformance suites in `cluster/src/__tests__` and
`federation/src/__tests__` can be pointed at it unchanged: they exercise the engine only
through these interfaces.
