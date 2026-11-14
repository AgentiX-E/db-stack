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

// Create a Raft-backed cluster node
const adapter = new RaftAdapter({
  id: 1,
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
  isLeader(): Promise<boolean>;
  getLeader(): Promise<number | null>;
  getTerm(): Promise<number>;
  readBarrier(): Promise<void>;
  
  // Status
  getStatus(): Promise<ClusterStatus>;
  getProgress(): Promise<Record<string, number>>;
  getAppliedIndex(): Promise<number>;
  getCommitIndex(): Promise<number>;
  
  // Leadership
  transferLeadership(targetNodeId: string): Promise<void>;
  setForceLeader(enabled: boolean): void;
  
  // Snapshots
  shouldTakeSnapshot(): boolean;
  takeSnapshot(index: number): void;
  compactLogs(lastIncludedIndex: number): Promise<void>;
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
  snapshotInterval?: number;   // Entries per snapshot (default: 100)
  enableInstallSnapshot?: boolean;
  environment?: 'development' | 'production';
}
```

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
npm test                   # 613 tests, 72 test files
npm run bench              # Performance benchmarks
npm run bench:ycsb         # YCSB-style workload benchmarks
npm run tla-check          # TLA+ model checking
```

- **72 test files, 613 tests** — unit, integration, boundary, chaos, LTS
- **TLA+ formal verification** — JointConsensus elections + log replication
- **Jepsen-style validation** — fuzzy register checker + end-state scanning
- **LTS soak tests** — 5-minute adaptive stability cycles, 0 leader changes

---

## Design Decisions

See [ADR](docs/adr/) for architecture decision records, including:

- [ADR-001: Why @maboke123/raft-core as the consensus engine](docs/adr/001-raft-core.md)
- [ADR-002: Transport layer — TCP, mTLS, Batched, Shared](docs/adr/002-transport.md)
- [ADR-003: Snapshot and log compaction strategy](docs/adr/003-snapshots.md)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
