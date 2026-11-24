# High-level architecture

This document describes **what the stack is made of and how the parts interact**. It is
deliberately architecture-level: no private internals, no implementation trivia. The
detailed technical design (algorithms, invariants, trade-off records) lives in the
companion repository [`db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs).

---

## 1. Layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               your application                               │
└───────────────┬───────────────────────────────────────────────────────────────┘
┌───────────────▼───────────────────────────────────────────────────────────────┐
│               @agentix-e/db-federation  — several datacenters                │
│                                                                              │
│  replication   CDC, outbox, dedup, conflict, anti-entropy                    │
│  transport     TcpSecureTransport (mTLS)                                     │
│  core          FederationManager, FederatedNode                              │
│  query/schema  FederatedQueryRouter, SchemaFederator                         │
│  topology      TopologyManager, EdgeReplica, ChannelHealth                   │
└───────────────┬───────────────────────────────────────────────────────────────┘
               │
┌───────────────▼───────────────────────────────────────────────────────────────┐
│                   @agentix-e/db-cluster  — one datacenter                    │
│                                                                              │
│  consensus     RaftAdapter, RaftGroup(Manager), joint consensus              │
│  transport     RaftTcpTransport, batching, mTLS, pool                        │
│  storage       SQLite WAL, snapshots                                         │
│  cluster       sharding, HA/fencing, PITR, WAL streaming                     │
│  assemblers    ClusterScalingExecutor, ClusterRolloutPlanner,                │
│                RaftFaultTranslator, quorum arithmetic                        │
│  observability metrics, health, IClusterTopology                             │
└───────────────┬───────────────────────────────────────────────────────────────┘
               │
┌───────────────▼───────────────────────────────────────────────────────────────┐
│                      @agentix-e/db-node  — one process                       │
│                                                                              │
│  core          ProviderRegistry, tokens, every shared type                   │
│  health · backup · metrics · monitor · security · auth                       │
│  audit · logger · observability · otel · maintenance                         │
│  autoscaler · autotuner · circuitbreaker · configwatcher                     │
│  memoryguard · rollingupgrade · slacollector · chaosengine                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly one-way (`node ← cluster ← federation`). `node` imports
nothing else here; `cluster` embeds a node's storage, transport and observability to run a
consensus group; `federation` reuses the cluster's transport primitives to move bytes
between datacenters. A single-node deployment installs `db-node` and never loads the other
two, so the packages are split by what a consumer deploys rather than by a
control-plane/data-plane line.

---

## 2. Component inventory

### 2.1 `@agentix-e/db-cluster`

| Area              | Principal components                                                                                                                         | Responsibility                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Consensus core    | `RaftAdapter`, `RaftGroup`, `RaftGroupManager`, `ShardStateMachine`                                                                          | One log per shard; leader election; commit + apply; multi-shard orchestration                                                             |
| Membership        | `RaftJointConsensusEngine`                                                                                                                   | Two-phase, rollback-safe membership change                                                                                                |
| Extensions        | `LeaderTransferHandler`, `ReadIndexManager`, `LeaseReadManager`, `SessionManager`, `WatchApi`                                                | Graceful handoff, linearizable reads, idempotent sessions, change notification. Snapshot transfer is not here: raft-core owns it (§2.1.1) |
| Transport         | `RaftTcpTransport`, `BatchedRaftTransport`, `SharedBatchedTransport`, `NodeTransport`, `ConnectionPool`, `MessageCodec`, `MessageCompressor` | TLS 1.3 + mTLS framing, batching, compression, reconnection with backoff, per-peer circuit breaking                                       |
| Storage           | `SqliteStorage`, `SqliteNodeStorage` (+ meta/log/snapshot/config splits), `WAL` streaming, `PITRManager`                                     | Durable log, compaction, snapshot persistence, point-in-time recovery                                                                     |
| Sharding          | `ShardManager`, `ReshardPlanner`, `OnlineShardMigration`, `HashShardStrategy`, `RangeShardStrategy`, `ConsistentHashStrategy`                | Key→shard routing, online migration driven by a measured copy                                                                             |
| High availability | `HAFailoverDetector`, `HAFailoverCoordinator`, `HAClientManager`, `HAConsistencyVerifier`, `FencingManager`, `ClockCompensator`              | Failure detection, automated failover, fencing, post-failover verification                                                                |
| Observability     | `RaftMetricsCollector`, `HealthProbe`, `LoggingAdapter`, `EventBus`                                                                          | Metrics, probes, structured logs, typed event stream                                                                                      |
| Testing surface   | `TestCluster`, certificate factory, `LinearizabilityChecker`                                                                                 | Published harness so downstream packages test against a real cluster instead of mocks                                                     |

#### 2.1.1 One snapshot authority

A snapshot has to answer three questions at once — _what is the state_, _up to which log
index_, and _what may now be discarded_ — so only one component may answer them. That
component is raft-core:

```
apply(entry)  ──▶ state machine ──▶ replica.apply(entry)          engine state
                       │
                       ├─ applied - snapshot ≥ threshold
                       ▼
             replica.snapshot(boundaryIndex)  ──▶ envelope(shard, boundary, term, CRC32)
                       ▼
             snapshot stored + log truncated      (one step, one writer)
```

`RaftGroup` schedules nothing and truncates nothing; it exposes `trySnapshot()` as an
explicit request and reports the boundary raft-core holds. An earlier design had a second
loop in the group that wrote a metadata-only file and then truncated the log itself; the
two boundaries could disagree, and when they did the difference was data loss. The
end-to-end suite (`AC-C7`) now restarts a compacted three-process cluster and asserts both
halves of the outcome: every key is back, and the cluster accepts writes.

### 2.2 `@agentix-e/db-federation`

| Area                 | Principal components                                                            | Responsibility                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Change capture       | `CDCEngine`, `CDCManager`, `CDCPublicationRegistry`, `ExactlyOnceCDCPipeline`   | Table-level change streams, per-DC streaming, publication/subscription bookkeeping, exactly-once cross-DC delivery                        |
| Change fan-out       | `CDCSubscriptionPump`, `CDCSinkResolver`, `ICDCSink`                            | Resolve a subscription's DSN to a sink and deliver to it: ordered per subscription, one `emit` per change, refusals retried then recorded |
| Durable delivery     | `OutboxStore` (LMDB-backed), `DedupRing`                                        | Outbox-before-send, at-least-once with bounded dedup                                                                                      |
| Conflict handling    | `ConflictResolver` (+ CRDT types), `HLC`                                        | LWW on hybrid logical clocks, CRDT merge, custom resolvers                                                                                |
| Reconciliation       | `AntiEntropy` (+ Merkle trees), `Convergence`                                   | Detect and repair divergence after partitions                                                                                             |
| Cluster coordination | `FederationManager`, `TopologyManager`, `MultiLeaderReplication`, `EdgeReplica` | Peer management, split-brain detection, multi-leader fan-out, edge read replicas                                                          |
| Transport            | `TcpSecureTransport` (mTLS), `InProcessTransport`                               | Wire transport, swappable for tests                                                                                                       |
| Operations           | `HealthMonitor`, `ChannelHealth`, `QueryRouter`                                 | Per-channel health scoring, cross-cluster query routing                                                                                   |

### 2.3 The three publishable packages

The split is by the deployment a consumer has — one process, one datacenter, several
datacenters — and inside each package by one question: **does this code need to know how
many nodes exist?**

| Package                    | Deployment          | Contents                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentix-e/db-node`       | One node            | Twenty modules whose implementation is about one process: `core`, `logger`, `observability`, `otel`, `health`, `monitor`, `metrics`, `circuitbreaker`, `memoryguard`, `chaosengine`, `backup`, `maintenance`, `security`, `auth`, `audit`, `autoscaler`, `autotuner`, `configwatcher`, `rollingupgrade`, `slacollector`                                 |
| `@agentix-e/db-cluster`    | One datacenter      | The multi-node assembly: Raft consensus, mTLS transport, SQLite WAL + snapshots, sharding, HA/fencing, PITR, plus `ClusterScalingExecutor` (apply a scaling decision to a live member set), `ClusterRolloutPlanner` (order an upgrade without losing quorum), `RaftFaultTranslator` (realise a fault through `IChaosTransport`) and majority arithmetic |
| `@agentix-e/db-federation` | Several datacenters | The cross-datacenter binding: CDC and outbox replication, conflict resolution, anti-entropy, `FederatedNode`, `FederatedQueryRouter`, schema federation                                                                                                                                                                                                 |

The boundary is enforced by what the packages can see, not by convention: nothing in
`node` receives a member list, and the two modules that produce multi-node decisions —
`autoscaler` and `rollingupgrade` — return _data_ (`ScaleAction.targetCount`,
`RollingUpgradePlan.nodes`) that `cluster` turns into a sequence. A node-local module
therefore has no way to take a group's quorum away, and a cluster deployment does not
reimplement majority arithmetic in every caller.

Every package is independently publishable, has no dependency on a database engine, and
exposes its engine-facing seams as interfaces behind the `core` provider registry.

---

## 3. Data paths

### 3.1 Write path (consensus)

```
client ─▶ RaftGroup.propose(payload)
            │
            ├─▶ RaftAdapter.propose ─▶ raft-core ─▶ append to WAL (fsync)
            │
            ├─▶ transport: AppendEntries over TLS 1.3 / mTLS to each peer
            │        └─ peer appends (fsync) and acknowledges
            │
            ├─▶ majority acknowledged ─▶ commit index advances
            │
            ├─▶ apply callback on every node (in index order)
            │
            └─▶ optional: outbox append for cross-DC fan-out
```

Latency is dominated by the majority round-trip plus one `fsync` per node.

### 3.2 Read path

| Mode          | Mechanism                                                          | Consistency                        |
| ------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Leader read   | Read after `propose()` resolved                                    | Linearizable for that client       |
| Read index    | `ReadIndexManager` confirms leadership with a heartbeat round-trip | Linearizable                       |
| Lease read    | `LeaseReadManager` uses a bounded lease                            | Linearizable while the lease holds |
| Follower read | Local apply state                                                  | Stale (bounded by replication lag) |

### 3.3 Cross-DC replication path

```
DC-East cluster ──commit──▶ CDC engine ──▶ outbox (durable) ──▶ TLS ──▶ DC-West
                                                                          │
                                                              dedup ring ─┤
                                                                          ▼
                                                                  apply + HLC stamp
```

If the link fails, the outbox grows and the sender retries with backoff; the receiving
side deduplicates. On reconnect, anti-entropy compares Merkle summaries and repairs
divergence.

---

## 4. Deployment topologies

| Topology                | Shape                                           | Use when                                            |
| ----------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Single DC, 3 AZ         | 3 voters, one per AZ                            | Standard HA; tolerates one AZ loss                  |
| Single DC + read region | 3 voters local + 1 learner remote               | Reads near users without cross-region write latency |
| Two DC, synchronous     | 5 voters split 3/2                              | Cross-DC RPO 0; writes pay the WAN RTT              |
| Two DC, asynchronous    | 3 voters per DC, federation between them        | Low write latency, eventual cross-DC consistency    |
| Edge fan-out            | 3 voters per region + `EdgeReplica` at the edge | Read-mostly edge workloads                          |

---

## 5. Quality attributes and how they are verified

| Attribute            | Target                                                               | Verification                                                                                    |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Safety               | No committed entry lost; no two leaders committing at the same index | Chaos suites with crash/pause/partition, plus a linearizability checker over recorded histories |
| Durability           | Committed ⇒ fsynced on a majority                                    | Kill-and-restart tests that assert log contents after recovery                                  |
| Availability         | A 3-node cluster survives one node loss without operator action      | E2E: kill the leader mid-workload, assert re-election and zero loss                             |
| Read consistency     | Read-index and lease reads linearizable                              | Dedicated suites per read mode                                                                  |
| Cross-DC convergence | Every write visible in the peer DC; no duplicates                    | E2E with two real clusters, 50-key burst, convergence assertions                                |
| Transport security   | TLS 1.3 with mutual verification; rogue certificate rejected         | E2E handshake tests with a rogue CA                                                             |
| Performance          | Throughput and latency tracked per commit                            | YCSB workloads A–F on a real 3-node cluster, published as a CI artefact                         |
| Operability          | Health, metrics, structured logs from day one                        | Unit + integration coverage of every operations package                                         |

Current measured status per criterion is reported in the audit and progress reports in
`db-stack-docs`; the machine-readable form is the CI run itself.

---

## 6. Design principles

1. **Engine-agnostic seams.** No layer imports a database driver except the reference
   SQLite adapter. Everything else goes through an interface.
2. **Callbacks over inheritance.** Engines integrate by supplying functions (apply,
   snapshot, restore, change-callback), not by subclassing stack classes.
3. **No mock in acceptance tests.** Distributed correctness cannot be established against
   a fake transport; acceptance suites spawn real processes and real TLS sockets.
4. **Fail closed.** Missing certificates, unknown peers, stale topology epochs and
   unverifiable identities reject the connection rather than degrading silently.
5. **Evidence over claims.** Every guarantee above is backed by a test that would fail if
   the guarantee were removed.

---

## 7. Related documents

- [Concepts](concepts.md) — the mental model behind this structure
- [Engine adapters](user-guide/engine-adapters.md) — where your database plugs in
- [Production runbook](user-guide/production-runbook.md) — operating these topologies
- Internal design, ADRs, whitepaper, roadmap: [`db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs)
