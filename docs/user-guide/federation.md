# Federation guide

`@agentix-e/db-federation` connects **independent clusters** across datacenters. Each
cluster keeps its own consensus group and its own low write latency; the federation layer
moves changes between them, resolves conflicts, and repairs divergence.

Install:

```bash
npm install @agentix-e/db-federation
```

Choose your topology before writing code — it determines everything else:

| Topology | Write latency | Cross-DC consistency | Use when |
|---|---|---|---|
| Active–passive (single leader DC) | Local in the primary; followers read | Converges quickly, one writer | DR, read scaling |
| Active–active (multi-leader) | Local everywhere | Converges; conflicts possible | Geographically distributed write traffic |
| Edge read replica | Local writes in the core | Read-only at the edge | CDN-like read locality |

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
  lsn: string;                 // monotonic log sequence number in the source engine
  timestamp: IHLCTimestamp;    // hybrid logical clock stamp
  tableName: string;
  operation: 'insert' | 'update' | 'delete';
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  txId: string;
}
```

**The engine-agnostic contract is this interface, not a driver.** Bundled adapters cover
the reference SQLite engine; for PostgreSQL, MySQL, MongoDB or a proprietary engine you
implement one class: read your change stream, stamp each change with the HLC, call the
callback. See [engine adapters](engine-adapters.md#3-change-capture-for-federation).

Publications and subscriptions group tables:

```ts
const manager = new CDCManager({ engine, nodeId: 'dc-east-1' });
await manager.createPublication('orders-pub', ['orders', 'order_items']);
await manager.createSubscription('to-west', 'orders-pub', 'dc-west-1');
```

---

## 2. Exactly-once delivery

The pipeline is *outbox-before-send*:

```
commit ──▶ outbox append (durable) ──▶ pump ──▶ transport ──▶ peer
                    ▲                                          │
                    └────── ack / retry with backoff ◀─────────┘
```

```ts
const pipeline = new ExactlyOnceCDCPipeline({
  nodeId: 'dc-east-1',
  cdcConfig: { nodeId: 'dc-east-1' },
  outboxConfig: { dataDir: '/var/lib/db/outbox', maxSizeMB: 1024 },
  transport,
  remoteNodeId: 'dc-west-1',
  pumpIntervalMs: 500,
  pumpBatchSize: 100,
  dedupTtlMs: 600_000,
});
await pipeline.start();
```

| Property | Mechanism | Consequence |
|---|---|---|
| No loss on crash | Change is persisted to the outbox before transmission | A restart resumes from the checkpoint |
| At-least-once | Retries until acknowledged | Duplicates are possible on the wire |
| Effectively-once | Receiver-side `DedupRing` keyed by message id | Each change takes effect once within the dedup window |
| Bounded memory | `pumpBatchSize`, `maxSizeMB` backpressure | Throughput is capped, not the heap |

**Dedup window caveat:** duplicates arriving after `dedupTtlMs` are treated as new. Size it
above your maximum expected outage.

---

## 3. Conflict resolution

Two DCs can write the same key. You choose the semantics per table or key prefix:

| Strategy | Config value | Behaviour | Discards data? |
|---|---|---|---|
| Last-write-wins on HLC | `'lww'` | Greater HLC wins; ties broken by node id | Yes — the loser |
| Counter | `'crdt-counter'` | Values merge additively | No |
| Set | `'crdt-set'` | Union with add/remove tombstones | No |
| Map | `'crdt-map'` | Per-field LWW inside a map | Per field |
| Custom | `'custom'` | Your resolver decides | Up to you |

```ts
const resolver = new ConflictResolver({ localNodeId: 'dc-east-1', strategy: 'lww' });
resolver.registerCustom('inventory', {
  predicate: (a, b) => a.key === b.key,
  resolver: (a, b) => ({ winner: a, merged: mergeInventory(a, b) }),
});
```

**LWW is lossy by design.** If a lost write is unacceptable, use a CRDT or an
application-level merge — the transport cannot invent information the merge discards.

---

## 4. Anti-entropy reconciliation

After a partition, the two sides have diverged. Merkle trees let each side compute a
summary and exchange only the differing leaves:

```ts
const antiEntropy = new AntiEntropy({ local: localStore, remote: remoteStore, config: {
  rangeSize: 1024, hashAlgorithm: 'sha256', maxDepth: 20,
} });
const result = await antiEntropy.sync();
// { comparedRanges, divergentRanges, repairedKeys, durationMs }
```

Cost is proportional to **divergence**, not to total data size — that is the entire point
of the Merkle approach. Run it after any partition, and periodically as a safety net.

---

## 5. Multi-leader and topology

```ts
const federation = new FederationManager({
  nodeId: 'dc-east-1',
  dc: 'east',
  replicationConfig: { targets: [{ nodeId: 'dc-west-1', priority: 1 }], topology: 'multi-leader' },
  transport,
  outbox,
});
await federation.start();
```

| Concern | Component | What it does |
|---|---|---|
| Peer lifecycle | `TopologyManager` | Tracks membership, assigns topology epochs, emits change events |
| Split-brain detection | `DCSplitBrainDetector` | Compares cluster identity + epoch; refuses to merge a stale view |
| Fan-out | `MultiLeaderReplication` | One logical stream per peer, independent backpressure |
| Edge reads | `EdgeReplica` | Resumable read-only stream from the primary (restart from LSN) |
| Health | `HealthMonitor`, `ChannelHealth` | Per-peer lag/error/jitter scored 0–100 |

Channel health is a weighted score, so a dashboard shows *why* a channel is unhealthy:

```
health = 100 − min(lag_ms/1000, 1)·30 − (err/(err+0.01))·40 − min(reconnects·5, 25) − min(log2(jitter+1)·2, 10)
```

---

## 6. Cross-cluster routing

`QueryRouter` sends a query to the cluster that owns the data:

```ts
const router = new QueryRouter({ topology, localClusterId: 'dc-east-1', policy: 'nearest-writer' });
const target = router.route({ table: 'orders', key: 'order-9' });
```

Policies: `local-first` (default), `nearest-writer`, `primary-only`, `read-any`.
Routing decisions are *routing hints*, not guarantees; the owning cluster still enforces
its own consistency rules.

---

## 7. Security

All cross-DC traffic uses `TcpSecureTransport`: TLS 1.3 with mutual certificate
verification. There is no plaintext mode and no "trust the network" switch.

```ts
const transport = new TcpSecureTransport({
  nodeId: 'dc-east-1',
  listen: { host: '0.0.0.0', port: 7443 },
  peers: [{ nodeId: 'dc-west-1', host: 'west.example.net', port: 7443 }],
  tls: { cert, key, ca },
});
await transport.start();
```

Certificates are the identity: a peer presenting a certificate from an unknown CA fails
the handshake and appears as a connection error — never as a silent no-op.

---

## 8. Operating a federation

| Symptom | First thing to check | Likely cause |
|---|---|---|
| Outbox grows monotonically | `ChannelHealth` reconnect count | Link down or certificate expired |
| Lag grows but no errors | Peer RTT, `pumpBatchSize` | Throughput cap, not failure |
| Divergent values after recovery | Conflict strategy for the table | LWW discarding a write that mattered |
| Duplicate effects | `dedupTtlMs` vs outage length | Dedup window too short |
| Split-brain warning | Topology epochs of both sides | A DC was restored from a stale snapshot |

A federation is healthy when: outbox depth is flat, lag is bounded by your SLO, channel
health is > 80, and a periodic anti-entropy pass reports zero divergent ranges.
