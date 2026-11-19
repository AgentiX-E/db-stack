# db-cluster — Database Cluster Orchestration with Raft Consensus

**A production-grade, embeddable npm package that provides Raft consensus, sharding,
high-availability failover, and WAL-backed durability for any database engine.**

Package: `@agentix-e/db-cluster`  
Version: 0.1.0  
License: MIT

---

## Quick Start

```bash
npm install @agentix-e/db-cluster
```

```typescript
import { RaftAdapter, RaftTcpTransport, SqliteStorage } from '@agentix-e/db-cluster';

// Create a Raft-backed cluster node. `peers` is the voting set *without* this
// node — the id here is 1, so the other two members are 2 and 3.
const adapter = new RaftAdapter({
  id: 1,
  peers: [2, 3],
  electionTick: 10,
  heartbeatTick: 1,
  storagePath: '/data/raft-node-1.db',
});

await adapter.init(
  (data) => console.log('Applied:', data),
  {
    node: { host: '127.0.0.1', port: 8081 },
    peers: [
      { id: 2, host: '127.0.0.1', port: 8082 },
      { id: 3, host: '127.0.0.1', port: 8083 },
    ],
  },
);

// Propose a value through consensus
if (await adapter.isLeader()) {
  const result = await adapter.propose(JSON.stringify({ key: 'hello', value: 'world' }));
  console.log('Committed at index:', result.index, 'term:', result.term);
}
```

[See full API reference →](#api-reference)

---

## Why db-cluster?

Building a database isn't enough — you need it to be highly available, durable, and
scalable across shards. db-cluster provides the consensus and cluster orchestration
layer that sits beneath your storage engine, giving you production-grade Raft consensus
without reinventing it.

| Feature | db-cluster |
|---------|------------|
| **Consensus** | Raft with joint consensus (safe membership changes) |
| **Durability** | SQLite-backed WAL with automatic log compaction |
| **Sharding** | Multi-RaftGroup per node, online resharding, strategy-based placement |
| **High Availability** | Automatic failover, fencing tokens, adaptive election timeouts |
| **Linearizable Reads** | LeaseRead + ReadIndex dual-path for consistent reads |
| **Snapshots** | InstallSnapshot RPC with chunked streaming |
| **Leadership Transfer** | Graceful handoff with NOOP barrier and drain phase |
| **Formal Verification** | TLA+ specs for joint consensus elections + log replication |
| **Security** | mTLS transport, circuit-breaker protection, connection pooling |
| **Observability** | OTEL distributed tracing, structured logging, Prometheus metrics |
| **Testing** | 613 tests, chaos engineering, Jepsen-style validation, LTS soak tests |

### What db-cluster is NOT

- **Not a database engine.** db-cluster provides consensus and cluster management — it doesn't
  store or query user data. Your engine handles storage via the `applyHandler` callback.
- **Not a gRPC service.** db-cluster is an embeddable TypeScript library. You import it into
  your process and wire it up to your engine.
- **Not a distributed SQL engine.** db-cluster manages Raft groups and shards. For cross-cluster
  federation (multi-DC replication, CDC), see `@agentix-e/db-federation`.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                  Your Database Engine                      │
│         (sqlvec-db / graphvec-db / custom)                │
│                                                           │
│  ┌─────────────────────────────────────────────────┐     │
│  │              Storage Engine                      │     │
│  │   (row store / graph store / vector store)       │     │
│  └──────────────┬──────────────────────────────────┘     │
│                 │ applyHandler(data, index, term)         │
├─────────────────┼─────────────────────────────────────────┤
│                 │  @agentix-e/db-cluster                  │
│                                                                   │
│  ┌──────────────▼──────────────────────────────────────┐      │
│  │              RaftAdapter                            │      │
│  │  Consensus layer — propose, commit, state machine    │      │
│  ├─────────────────────────────────────────────────────┤      │
│  │  RaftGroupManager                                   │      │
│  │  Multi-group orchestration, shard routing            │      │
│  ├──────────────────┬──────────────────┬───────────────┤      │
│  │  Joint Consensus  │  Snapshot/       │  Read Path    │      │
│  │  (safe reconfig)  │  Log Compaction  │  (Lease+Idx)  │      │
│  ├──────────────────┼──────────────────┼───────────────┤      │
│  │  HA Failover      │  Fencing         │  Leader       │      │
│  │  Detector+Coord   │  Tokens          │  Transfer     │      │
│  ├──────────────────┼──────────────────┼───────────────┤      │
│  │  Transport Layer — TCP/mTLS/Batched/Shared          │      │
│  │  CircuitBreaker  │  ConnectionPool  │  Codec         │      │
│  ├──────────────────┴──────────────────┴───────────────┤      │
│  │  Storage Layer — SQLite WAL + Log Compaction        │      │
│  │  Adaptive Election Timeout  │  Concurrency Limiter   │      │
│  └─────────────────────────────────────────────────────┘      │
│                                                                   │
│  ┌─────────────────────────────────────────────────────┐      │
│  │  TLA+ Formal Verification                            │      │
│  │  JointConsensus.tla + LogReplication.tla             │      │
│  └─────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────┘
```

### Module Map

| Module | Path | Role |
|--------|------|------|
| **RaftAdapter** | `src/consensus/core/` | Raft consensus adapter wrapping @maboke123/raft-core |
| **RaftGroupManager** | `src/consensus/core/` | Multi-RaftGroup lifecycle and message routing |
| **JointConsensusEngine** | `src/consensus/joint-consensus/` | Two-phase membership change (C_old → C_joint → C_new) |
| **Transport** | `src/consensus/transport/` | TCP/mTLS/Batched/Shared transport with circuit breaker |
| **Storage** | `src/consensus/storage/` | SQLite-backed WAL with log compaction |
| **HA** | `src/ha/` | Failover detection, coordination, fencing, consistency verification |
| **Sharding** | `src/interfaces/shard/` | Shard strategy, reshard planning, online migration |
| **Extensions** | `src/consensus/extensions/` | InstallSnapshot, LeaderTransfer, LeaseRead, ReadIndex |
| **TLA+** | `tla/` | Formal specs for JointConsensus and LogReplication |

---

## API Reference

### RaftAdapter

```typescript
class RaftAdapter {
  constructor(config: RaftConfig);
  
  // Lifecycle
  init(applyHandler?, tcpConfig?, sharedTransport?): Promise<void>;
  stop(): void;
  
  // Write path
  propose(data: string): Promise<{ index: string; term: string }>;
  proposeAndWait(data: string): Promise<void>;
  
  // Read path
  isLeader(): Promise<boolean>;      // role AND contact with a majority
  getLeader(): Promise<number | null>;
  getQuorumHealth(): QuorumHealth | null;
  getTerm(): Promise<number>;
  readBarrier(): Promise<void>;
  
  // Status
  getStatus(): Promise<ClusterStatus>;
  getProgress(): Promise<Record<string, number>>;
  getPeerProgress(): Promise<Record<number, { next: number; match: number }>>;
  getConnectedPeers(): number[];
  getAppliedIndex(): Promise<number>;
  getCommitIndex(): Promise<number>;
  
  // Leadership
  transferLeadership(targetNodeId: string): Promise<void>;
  setForceLeader(enabled: boolean): void;

  // Transport seam — the object raft-core holds is stable; its inside is replaceable.
  getTransport(): Transport | null;
  setTransport(next: Transport | null): void;

  // Configuration honesty
  getIgnoredSettings(): Array<{ setting: string; reason: string }>;
  
  // Snapshots — scheduling belongs to raft-core, which snapshots on the
  // configured threshold after an apply. These are the explicit surfaces.
  requestSnapshot(): Promise<SnapshotMeta | null>;   // force one now; idempotent
  getSnapshotMeta(): SnapshotMeta | null;            // the boundary raft holds
  refreshSnapshotMeta(): Promise<SnapshotMeta | null>; // re-read from storage
}
```

### RaftConfig

```typescript
interface RaftConfig {
  id: number;                  // Node ID
  electionTick: number;        // Election timeout in ticks
  heartbeatTick: number;       // Heartbeat interval in ticks
  tickIntervalMs?: number;     // Tick duration (default: 100)
  
  // Storage
  storagePath?: string;        // SQLite file path
  storage?: SqliteStorage;     // Pre-built storage instance
  useInMemoryStorage?: boolean; // Test-only
  
  // Network
  transport?: Transport;       // Custom transport
  peers?: number[];            // Peer node IDs
  
  // Advanced
  snapshotInterval?: number;   // Entries between snapshots (default: 200)
  checkQuorum?: boolean;       // Leadership follows contact with a majority (default: true)
  preVote?: boolean;           // Describes raft-core; it pre-votes unconditionally
  // @deprecated no-op: chunked snapshot install is unconditional.
  enableInstallSnapshot?: boolean;
  environment?: 'development' | 'production';
}
```

### Quorum loss and leadership

`raft-core` 0.2.1 implements no check-quorum, so a leader that has lost its majority keeps answering
`isLeader() === true`: measured with two of three nodes killed, still true at 16 s, the commit index
frozen, and the next write refused only after **5 035 ms**. Nothing unsafe happens — a majority is
still required to commit — but a client routing by `isLeader()` keeps sending work to a node that
cannot serve it, and reads the result as a slow cluster.

With `checkQuorum` on (the default), `isLeader()` answers from the role **and** from contact with a
majority inside one election timeout. Contact means a completed round trip through the *real*
transport: a layer that answers a message it dropped does not count, which is why the observer sits
innermost. The library's own role is left alone — the node stops claiming it can serve, which is the
part a router reads.

| Surface | Meaning on a node that has lost its majority |
|---|---|
| `isLeader()` | `false` within one election timeout |
| `getLeader()` | `null` — a leader that cannot hear a majority does not know who leads |
| `getQuorumHealth()` | `hasQuorum: false` plus the silent peers, the majority and the window |
| `propose()` / `proposeAndWait()` | rejects with `QUORUM_FAILED` immediately, naming the silent peers |

```typescript
const health = adapter.getQuorumHealth();
// { size: 3, majority: 2, windowMs: 1200, hasQuorum: false, unheardPeers: [2, 3] }
```

Quorum accounting needs a member list, so it is skipped (`getQuorumHealth()` returns `null`) when the
configuration has no peers — a shared-transport group keeps its members in another manager, and
guessing them would be worse than not judging.

`preVote` is the other setting that cannot be honoured: raft-core pre-votes on every election timeout
and exposes no flag to skip it. Passing `preVote: false` warns and is recorded, so a deployment can
assert its configuration is fully in effect:

```typescript
adapter.getIgnoredSettings();
// [{ setting: 'preVote', reason: 'raft-core pre-votes unconditionally and exposes no flag to disable it (P3-22)' }]
```

### Replacing the transport of a running node

`raft-core` captures the `Transport` object it is constructed with, so assigning to a transport field
afterwards is invisible to it: the library keeps using the transport it was built with, and any
injector installed into that field receives nothing. `setTransport` goes through the object the
library actually holds, which is what makes fault injection and connection draining real:

```typescript
import { PartitionTransport } from '@agentix-e/db-cluster/testing';

const parted = new PartitionTransport(adapter.getTransport()!);
adapter.setTransport(parted);   // raft-core now routes through it
parted.isolate([2]);            // peer 2 is unreachable in both directions
parted.heal();
```

The full harness — the cluster, the partition wrapper, the agreement and linearizability checks,
and the engine conformance suite — is documented in [docs/testing.md](docs/testing.md).

An installed transport is expected to wrap the current one. One that does not is accepted, but the
quorum observer is re-installed outside it — and an outer layer that answers without delivering then
stops being evidence of contact, which is a lost quorum rather than a healthy peer.

### Application snapshots

Snapshots are the only way a follower that fell behind a compaction can recover, and they are
only as good as the bytes your engine puts in them. Register both hooks **before** `init()` —
raft-core restores the persisted snapshot while starting, so a handler registered afterwards
misses the restore.

```typescript
const adapter = new RaftAdapter({ ... });

adapter.setApplicationSnapshotHandlers({
  // Return the engine's state *as of `boundaryIndex`*. It must be non-empty: a handler
  // that returns 0 bytes is refused, because Raft would then truncate the log for an
  // index whose state nobody captured.
  takeSnapshot: (boundaryIndex) => engine.exportState(boundaryIndex),
  // Replace the engine's state with the transferred bytes. Must be atomic: Raft has
  // already discarded the log this snapshot replaces.
  installSnapshot: (data) => engine.importState(data),
});

await adapter.init(apply);
```

An application that owns no state may omit both handlers; its snapshots are then empty,
which is correct for a log-only group. A replica that fails to import a snapshot refuses to
apply anything further rather than reporting the leader's index over an engine that never
received it.

### HA Failover

```typescript
// Automatic failure detection
const detector = new HAFailoverDetector({
  checkIntervalMs: 1000,
  failureThreshold: 3,
  recoveryThreshold: 2,
});

// Coordinated failover with fencing
const coordinator = new HAFailoverCoordinator({
  maxConcurrentFailovers: 1,
  fencingEnabled: true,
});
```

### Shard Management

```typescript
interface IShardManager {
  addShard(config: ShardConfig): Promise<void>;
  removeShard(shardId: number): Promise<void>;
  getShard(key: string): ShardInfo;
  rebalance(): Promise<MigrationPlan>;
}

interface IReshardPlanner {
  plan(targetShardCount: number): ReshardPlan;
  execute(plan: ReshardPlan): AsyncIterable<MigrationStep>;
}
```

---

## Observability

Every important operation emits structured logs and optional OTEL spans:

```typescript
// Structured logging (pino)
// [RaftAdapter] Initialized with @maboke123/raft-core
// { nodeId: 1, term: 5, role: "leader" }

// OTEL spans
// raft.propose → raft.commit → raft.apply
// With traceparent propagation across network boundaries
```

---

## Testing

```bash
pnpm test                  # 2 116 tests, 131 test files
pnpm coverage              # the same, with per-file coverage gates
pnpm test:perf             # performance benchmarks on a real 3-node TLS cluster
pnpm tla-check             # TLA+ model checking
```

- **131 test files, 2 116 tests** — unit, integration, boundary, chaos, LTS — 99.36 % lines,
  99.70 % functions, 98.26 % branches, with a per-file floor of 95 %
- **TLA+ formal verification** — JointConsensus elections + log replication
- **Jepsen-style validation** — fuzzy register checker + end-state scanning
- **LTS soak tests** — 5-minute adaptive stability cycles, 0 leader changes

---

## Design Decisions

See the [architecture decision records](https://github.com/AgentiX-E/db-stack-docs/tree/main/adr) for the reasoning behind each major choice, including:

- [ADR-001: Why @maboke123/raft-core as the consensus engine](https://github.com/AgentiX-E/db-stack-docs/blob/main/adr/cluster-001-raft-core.md)
- [ADR-002: Transport layer — TCP, mTLS, Batched, Shared](https://github.com/AgentiX-E/db-stack-docs/blob/main/adr/cluster-002-transport.md)
- [ADR-003: Snapshot and log compaction strategy](https://github.com/AgentiX-E/db-stack-docs/blob/main/adr/cluster-003-snapshots.md)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
