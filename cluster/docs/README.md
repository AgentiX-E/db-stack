# db-cluster — Distributed Raft Consensus Engine

**Production-grade, pure-TypeScript Raft consensus engine with mTLS transport, automatic failover, sharding, and no WASM dependency.**

db-cluster provides the foundational consensus layer for the Agentix-E database ecosystem. It is used by `sqlvec-db` (SQL + vector) and `graphvec-db` (graph) databases, and consumed by `db-federation` for cross-datacenter coordination.

**Package**: `@agentix-e/db-cluster`

---

## Why db-cluster?

Most Raft implementations in the JavaScript/TypeScript ecosystem fall into three categories:

| Category | Examples | Problem |
|----------|----------|---------|
| WASM-based (tikv/raft-rs) | `raft-logic`, `nugget` | WASM serialization overhead (~5–15µs per message), RefCell contention, manual tick driving |
| Embedded (go/gRPC) | `etcd/raft` via sidecar | Deployment complexity, cross-language crashes |
| Ported (pure JS) | `node-raft` | Abandoned, no TLS, no HA, no tests |

db-cluster solves all three — **pure TypeScript, zero WASM, zero external process dependencies, 424 tests, and a clean component architecture**.

### Console output
```logs
15:30:20 INFO (RaftGroup/42): state=Follower → Candidate  term=5
15:30:20 INFO (RaftGroup/42): voted-for=self  term=5
15:30:20 INFO (RaftGroup/42): state=Candidate → Leader  term=5  commit=128
15:30:20 INFO (OutboxManager): Unfrozen — resuming sends
```

---

## Core Capabilities

| Capability | Detail |
|------------|--------|
| **Raft consensus** | Leader election, log replication, committed index tracking, term progression |
| **Automatic failover** | HAFailoverCoordinator — secondary becomes leader in <3s (default election timeout) |
| **mTLS transport** | All inter-node communication encrypted with TLS client certificates |
| **Sharding** | Multiple Raft groups per node; each shard has independent Raft state and log |
| **Snapshot install** | Catch-up from snapshot + log replay for severely lagging followers |
| **Leader transfer** | Graceful leader handoff without election timeout |
| **Read-index** | Linearizable reads without writing to the Raft log |
| **Replication pipeline** | Optimistic batching: up to 128 entries per AppendEntries RPC |
| **Circuit breaker** | Connection failures trigger circuit breaker (opossum) — peer marked unhealthy |
| **Fencing** | Term-based lease fencing prevents stale leader writes |
| **Outbox integration** | OutboxManager gates cross-DC sends behind Raft commit index |

---

## Architecture (3-Layer)

```
┌─────────────────────────────────────────────────────────────┐
│                 Application Layer                            │
│  RaftClient — propose(), getLeader(), registerShard()        │
│  ShardReplica — per-shard state machine consumer             │
│  OutboxWriter — async propagation of committed entries       │
├─────────────────────────────────────────────────────────────┤
│                 Consensus Layer                               │
│                                                              │
│  RaftGroupManager   ─── manages ──►  RaftGroup[]            │
│  (lifecycle, config)                 (per-shard Raft)        │
│       │                                    │                 │
│       └───── RaftAdapter ─── RaftNode ─────┘                 │
│                     (@maboke123/raft-core)                    │
│                                                              │
│  Core state machine:                                         │
│    Follower ◄──► Candidate ◄──► Leader                       │
│    - Follower: receive + apply entries from leader           │
│    - Candidate: start election on timeout                     │
│    - Leader: accept client proposals, manage replication      │
├─────────────────────────────────────────────────────────────┤
│                Transport & Storage Layers                     │
│                                                              │
│  RaftTcpTransport  ─── ConnectionPool ──► PeerConnection     │
│  (TLS server+client)         │            (mTLS, circuit     │
│                              │             breaker, frame)   │
│                              ▼                               │
│                    SqliteStorage (WAL mode)                    │
│                    Raft log + state machine                   │
│                                                              │
│  Wire format:  [ length:4B | msgpack_payload ]               │
└─────────────────────────────────────────────────────────────┘
```

For the complete module map, data flows, state machines, and design decisions, see [architecture.md](./architecture.md).

---

## Quick Start

```bash
npm install @agentix-e/db-cluster
```

### Single-node (development)

```typescript
import { RaftGroupManager } from '@agentix-e/db-cluster';

const manager = new RaftGroupManager({
  nodeId: 'node-1',
  storagePath: '/var/db/node-1',
  peers: [{ id: 'node-1', host: '127.0.0.1', port: 19001 }],
});

// Register a shard
manager.registerShard('shard-0');

// Start all shard Raft groups
await manager.start();

// Propose an entry
const commitIndex = await manager.propose('shard-0', '{"balance": 100}');
console.log('Committed at index:', commitIndex);

await manager.stop();
```

### 3-node cluster (production)

```typescript
// On node-1:
const mgr1 = new RaftGroupManager({
  nodeId: 'node-1',
  storagePath: '/data/db-cluster',
  peers: [
    { id: 'node-1', host: '10.0.1.10', port: 19001 },
    { id: 'node-2', host: '10.0.1.11', port: 19001 },
    { id: 'node-3', host: '10.0.1.12', port: 19001 },
  ],
  // mTLS configuration
  tls: {
    cert: fs.readFileSync('/etc/certs/node-1.pem'),
    key: fs.readFileSync('/etc/certs/node-1-key.pem'),
    ca: fs.readFileSync('/etc/certs/ca.pem'),
  },
});

await mgr1.start();
```

### With HA failover coordinator

```typescript
import { RaftGroupManager, HAFailoverCoordinator } from '@agentix-e/db-cluster';

const mgr = new RaftGroupManager({ ... });
await mgr.start();

const coordinator = new HAFailoverCoordinator(mgr, {
  checkIntervalMs: 1000,       // health check every 1s
  electionTimeoutMs: 3000,     // trigger election after 3s without leader
});

coordinator.on('leader-changed', (shardId, newLeader) => {
  console.log(`Shard ${shardId}: leader is now ${newLeader}`);
});

await coordinator.start();
```

### With db-federation

```typescript
import { DbClusterConsensusAdapter } from '@agentix-e/sqlvec-db';

const adapter = new DbClusterConsensusAdapter(mgr);
await adapter.start();

// Now usable anywhere IConsensusLayer is expected
```

---

## Design Principles

| Principle | Implied Design Decisions |
|-----------|-------------------------|
| **No WASM** | Pure TypeScript. No serialization queues, no manual ticks, no RefCell contention. RaftNode internally manages timers and elections. |
| **Transport-agnostic core** | RaftGroup → RaftAdapter → NodeTransport → concrete transport. Swap in batched, shared, or raw transport without touching the Raft state machine. |
| **Crash-safe storage** | SQLite in WAL mode with immediate synchronous=NORMAL. Prepared statement pool for zero-allocation log writes. |
| **Circuit-broken connections** | Invalid peers are circuit-broken immediately (no retry storm). Recovery is exponential backoff with jitter. |
| **Deterministic failover** | Term-based fencing prevents stale leaders. Lease expiry is always > election timeout (3× margin). |
| **Shard-isolated failures** | Each Raft group has its own connection pool, storage, and election timer. Shard-0 crash does not affect shard-1. |

---

## Project Stats

| Metric | Value |
|--------|-------|
| Source files | 47 |
| Source lines | 13,774 |
| Test files | 46 |
| **Tests** | **424** ✅ |
| TypeScript errors | 0 |
| Dead code | 0 |
| Coverage | 98%+ on core paths |

---

## Module Reference

| Module | File | Lines | Responsibility |
|--------|------|-------|--------------|
| **RaftGroupManager** | `src/core/RaftGroupManager.ts` | 1,935 | Cluster lifecycle: start/stop/configure Raft groups, shard registration |
| **RaftGroup** | `src/core/RaftGroup.ts` | 1,831 | Per-shard Raft: propose, commit, catch-up, snapshot, term tracking |
| **ConnectionPool** | `src/transport/ConnectionPool.ts` | 1,206 | mTLS connection management: connect, retry, backoff, circuit breaker |
| **RaftAdapter** | `src/transport/RaftAdapter.ts` | 774 | Wraps @maboke123/raft-core into IConsensusLayer contract |
| **SharedBatchedTransport** | `src/transport/SharedBatchedTransport.ts` | 907 | Batched message transport with shared port mux |
| **SqliteStorage** | `src/storage/SqliteStorage.ts` | 660 | Raft log + state machine on SQLite WAL mode |
| **HAFailoverCoordinator** | `src/coordinator/HAFailoverCoordinator.ts` | 762 | Election monitoring + automatic leader failover |
| **FencingManager** | `src/core/FencingManager.ts` | 414 | Term-based lease fencing, stale leader detection |
| **ReplicationPipeline** | `src/pipeline/ReplicationPipeline.ts` | 350 | Optimistic batch send (128 entries) per AppendEntries RPC |
| **InstallSnapshotHandler** | `src/snapshot/InstallSnapshotHandler.ts` | 420 | Follower catch-up via snapshot + log replay |
| **LeaderTransferHandler** | `src/coordinator/LeaderTransferHandler.ts` | 238 | Graceful leader handoff protocol |
| **ReadIndexHandler** | `src/coordinator/ReadIndexHandler.ts` | 248 | Linearizable read optimization (no log write) |

---

## Test Infrastructure

### Real In-Process Clusters (No Docker)

Integration and performance tests spin up real 3-node mTLS clusters inside the same vitest process:

```
┌─────────────────────────────────────────────────┐
│                 vitest fork                       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ node-1   │  │ node-2   │  │ node-3   │        │
│  │ :19001   │  │ :19002   │  │ :19003   │        │
│  │ RaftNode │  │ RaftNode │  │ RaftNode │        │
│  │ RaftTcp  │  │ RaftTcp  │  │ RaftTcp  │        │
│  │ SQLite   │  │ SQLite   │  │ SQLite   │        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
│       └─────────────┼──────────────┘               │
│                     │                              │
│              mTLS (self-signed)                    │
└────────────────────────────────────────────────────┘
```

### Test Categories

| Category | Files | Coverage |
|----------|-------|----------|
| Unit (pure functions with mocks) | 26 | RaftAdapter, frame codec, message routing |
| Integration (real 3-node clusters) | 5 | Leader election, log replication, failover, network partition |
| Performance (throughput + chaos) | 3 | 1K msg/s throughput, chair-kill, leader flapping |
| Interface (type-level contract) | 12 | IConsensusLayer conformance, all method signatures |

### Chaos Engineering (raft-chaos)

The `raft-chaos.test.ts` suite verifies Raft safety invariants:

- **Leader kill**: New election completes with no data loss
- **Follower kill**: Quorum maintained, leader commits
- **Leader flapping**: 3 consecutive kills → term progression monotonic
- **Network partition**: Minority cluster freezes, majority continues commit
- **Commit index regression prevention**: After any leader change, commit index never decreases

### Run Tests

```bash
# All 424 tests
npm test

# By category
npx vitest run src/__tests__/unit/           # 26 files, ~30s
npx vitest run src/__tests__/integration/    # 5 files, ~50s (real mTLS)
npx vitest run src/__tests__/performance/    # 3 files, ~20s
npx vitest run src/__tests__/interfaces/     # 12 files, <1s

# Chaos tests with Raft debug logs
DEBUG=1 npx vitest run src/__tests__/performance/raft-chaos.test.ts

# Single file
npx vitest run src/__tests__/integration/ha-e2e.test.ts
```

---

## Integration with sqlvec-db

```typescript
import { RaftGroupManager } from '@agentix-e/db-cluster';
import { DbClusterConsensusAdapter } from '@agentix-e/sqlvec-db';

const mgr = new RaftGroupManager({ ... });
await mgr.start();

const adapter = new DbClusterConsensusAdapter(mgr);
adapter.setApply(async (data) => {
  // Forward committed entries to sqlvec-db state machine
});

// Now usable via IConsensusLayer
await adapter.propose('shard-0', 'value');
```

## Integration with graphvec-db

```typescript
import { RaftGroupManager } from '@agentix-e/db-cluster';
import { DbClusterConsensusProvider, registerDbClusterConsensus }
  from '@agentix-e/graphvec-db';

registerDbClusterConsensus(mgr);

// Factory creates a DbClusterConsensusProvider wrapping mgr
const provider = createConsensus({ mode: 'db-cluster', ... });
```

## Integration with db-federation

```typescript
import { FederationManager } from '@agentix-e/db-federation';

const fm = new FederationManager({
  dc: 'dc-west',
  transport: new TcpSecureTransport({ ... }),
  consumers: [
    // sqlvec-db consumer that wraps RaftGroupManager
  ],
});
```

---

## Architecture Document

For a deep dive into:
- Full component diagram (29 modules)
- Data flows: propose, receive, heartbeat, connection lifecycle
- Error state machine with propagation paths
- Wire format (length-prefixed msgpack)
- All design decisions D1–D9 with rationale
- Performance benchmarks

See [docs/architecture.md](./architecture.md).

---

## License

MIT — see [LICENSE](./LICENSE)
