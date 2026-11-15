# Cluster guide

Everything the `@agentix-e/db-cluster` package does, grouped by task. Each section states
the guarantee and the API, then shows the configuration that matters.

Install:

```bash
npm install @agentix-e/db-cluster
```

Entry points:

```ts
import {
  RaftAdapter, RaftGroup, RaftGroupManager,
  RaftTcpTransport, BatchedRaftTransport, SharedBatchedTransport,
  SqliteStorage, SqliteNodeStorage,
  ShardManager, HashShardStrategy, RangeShardStrategy, ConsistentHashStrategy,
  ReshardPlanner, OnlineShardMigration,
  RaftJointConsensusEngine, FencingManager,
  SessionManager, WatchApi, EventBus,
  PITRManager, WalStreamer,
  RaftMetricsCollector, HealthProbe,
} from '@agentix-e/db-cluster';
```

---

## 1. A single consensus group

### 1.1 Configuration that matters

| Field | Effect | Guidance |
|---|---|---|
| `id`, `peers` | Group membership | `peers` must contain every voting node id, including… not yourself |
| `electionTick` | Election timeout in ticks | Too low ⇒ spurious elections on GC pauses |
| `heartbeatTick` | Heartbeat period in ticks | Keep `heartbeatTick ≤ electionTick / 3` |
| `tickIntervalMs` | Wall-clock length of a tick | `electionTick × tickIntervalMs` should exceed your p99 pause time |
| `storagePath` | SQLite file for the log | Put it on a local SSD; never on NFS |
| `snapshotInterval` | Entries between snapshots | 0 disables snapshots (unbounded log growth) |
| `maxLogEntries` | Forced compaction threshold | Set it; otherwise a slow follower pins the log forever |
| `preVote` | Election disruption avoidance | Keep on in production |
| `checkQuorum` | Leader steps down when isolated | Keep on in production |
| `useInMemoryStorage` / `useInMemoryTransport` | Test-only shortcuts | Never in production — they silently remove durability |

### 1.2 Lifecycle

```ts
const adapter = new RaftAdapter({ id: 1, peers: [1, 2, 3], electionTick: 10, heartbeatTick: 3,
  storagePath: '/var/lib/db/node-1/raft.db', snapshotInterval: 5000, maxLogEntries: 20000,
  preVote: true, checkQuorum: true });

await adapter.init(applyFn, {
  node: { id: 1, host: '10.0.0.1', port: 7001 },
  peers: [ { id: 2, host: '10.0.0.2', port: 7002 }, { id: 3, host: '10.0.0.3', port: 7003 } ],
  tls: { cert, key, ca },
});
```

`init()` returns when the transport is listening. Leadership is **not** available yet —
poll `isLeader()` or watch for the `leader.elected` event. Shutdown:

```ts
adapter.stop();   // closes transport, flushes and releases storage
```

### 1.3 Writing

```ts
const { index, term } = await adapter.propose(JSON.stringify({ key, value }));
```

`propose()` rejects if this node is not the leader. There is no transparent forwarding —
the client retries against `await adapter.getLeader()`, which keeps failure modes visible
instead of hiding them behind retries.

### 1.4 Reading

```ts
await adapter.readBarrier();            // linearizable barrier
const status = await adapter.getStatus(); // { term, commitIndex, appliedIndex, ... }
```

For high read throughput use `ReadIndexManager` (no clock assumption) or
`LeaseReadManager` (one fewer round-trip, requires bounded clock drift).

### 1.5 Proposing many entries

`BatchedRaftTransport` coalesces frames per peer; `proposeAndWait()` waits for the local
apply rather than just the commit:

```ts
await Promise.all(entries.map((e) => adapter.proposeAndWait(JSON.stringify(e))));
```

The adapter enforces an in-flight semaphore (`RaftAdapter.semaphore`) so a burst cannot
exhaust memory — the queue is bounded, not the heap.

---

## 2. Log compaction and snapshots

```
log: [1 .. 10000][101 .. 10250]          snapshot@10000 
                    └─ tail retained ─┘  └─ state as of 10000 ┘
```

| Setting | Meaning |
|---|---|
| `snapshotInterval: N` | Take a snapshot every N applied entries (raft-core checks after every apply) |
| `maxLogEntries: M` | Compact when the retained log exceeds M entries |
| `group.trySnapshot()` | Force one now — idempotent, and a no-op if nothing was applied since the last one |

**There is exactly one snapshot mechanism.** raft-core captures it: it calls your
replica's `snapshot(boundaryIndex)` for the bytes, stores it with its term and the
committed configuration, and truncates the log it covers — in that order, in one step.
Nothing else truncates the log, which is why "the log was compacted past a snapshot that
does not contain the data" cannot happen.

The boundary index handed to `snapshot()` is Raft's, not the engine's. They differ by the
CONFIG and NOOP entries Raft applies without calling your engine (a bootstrap entry, a
leader's election no-op), so an engine that stamped its own watermark would come back
from a restore a few indexes short — and then refuse the next entry as a gap.

Installation is raft-core's too: it pulls the snapshot in chunks from the leader,
verifies it and hands the bytes to `installSnapshot()`. A lagging follower therefore never
holds a whole snapshot in memory, and the leader needs no help from the application.

**Failure mode to know:** if `snapshot()` returns inconsistent bytes (for example because
the engine read while writes were in flight), a follower that installs that snapshot
diverges permanently. `EngineBackedReplica` waits for in-flight applies before capturing;
a hand-written replica must do the same.

---

## 3. Sharding

```ts
const manager = new ShardManager({
  shardCount: 16,
  strategy: new HashShardStrategy(),
  replicaFactory: (shardId) => createReplica(shardId),
});
await manager.initialize();
const shardId = manager.route('user:42');
```

| Strategy | Determinism | Rebalancing cost |
|---|---|---|
| `HashShardStrategy` | Pure function of the key | Changing `shardCount` remaps nearly everything |
| `RangeShardStrategy` | Ordered boundaries | Split/merge moves one range |
| `ConsistentHashStrategy` | Ring position with virtual nodes | Adding a node moves ~1/n of keys |

### Online resharding

```ts
const plan = new ReshardPlanner({ strategy, currentShards, targetShards }).plan();
await new OnlineShardMigration({ plan, source, target }).execute();
```

The migration copies state, replays the tail of the log, and only then switches routing.
During the copy the source keeps serving; the switch is a routing update, not a restart.

---

## 4. Membership changes

Never edit `peers` in place and restart — that is how split brains are created.

```ts
const engine = new RaftJointConsensusEngine(() => groups, () => consensusLayer);
await engine.transition({ oldPeers, newPeers }, { timeoutMs: 30_000, maxRetries: 10 });
```

The engine performs `C_old → C_old,new → C_new` with retries and rollback:

* rejected if a transition is already in flight (single-writer invariant),
* rolled back automatically on timeout **before** `C_new` commits,
* refuses to shrink a cluster below a quorum,
* emits `membership.changed` events for observers.

Adding a read-only replica? Use a learner (`addLearner`), let it catch up, then promote.
Learners never vote, so a slow region cannot stall your commits.

---

## 5. High availability, fencing, failover

```ts
const detector = new HAFailoverDetector({ consensusLayer, config });
const coordinator = new HAFailoverCoordinator({ consensusLayer, fencingManager, config });
detector.onFailure(async (event) => coordinator.handle(event));
```

| Component | Responsibility | Safe default |
|---|---|---|
| `HAFailoverDetector` | Declares a shard unhealthy after sustained stagnation | Grace period > election timeout |
| `HAFailoverCoordinator` | Chooses a target, transfers leadership, verifies | Prefer a follower with the highest match index |
| `FencingManager` | Revokes the old owner's writes before the new one starts | Always on when storage is shared |
| `HAConsistencyVerifier` | Confirms surviving replicas agree after failover | Run after every failover |

**Order matters**: fence, then transfer, then verify. Transferring before fencing is the
classic way to lose writes from a zombie leader.

---

## 6. Sessions and watches

`SessionManager` gives you idempotent client sessions on top of an ordered log:

```ts
const sessions = new SessionManager({ defaultTtlMs: 30_000, slidingExpiry: true, maxSessions: 10_000 });
const session = sessions.create('client-7', { user: 'alice' });
sessions.onExpire((id) => releaseLocks(id));   // fires exactly once per session
```

`WatchApi` turns committed proposals into notifications:

```ts
const watch = new WatchApi({ eventBus });
const handle = watch.watch('orders/', (event) => console.log(event), { timeoutMs: 60_000 });
handle.dispose();
```

Prefix matching is per-watch; events are delivered FIFO per watch; a throwing handler does
not affect other watches.

---

## 7. Point-in-time recovery and WAL streaming

```ts
const pitr = new PITRManager({ storage, dataDir: '/var/lib/db/pitr' });
await pitr.createRestorePoint('before-migration');
await pitr.restoreToTimestamp(Date.now() - 60_000);
```

`WalStreamer` tails the log for downstream consumers (backup, audit, CDC):

```ts
const streamer = new WalStreamer({ storage, fromIndex });
for await (const batch of streamer.batches()) { await ship(batch); }
```

PITR granularity is bounded by your snapshot interval: recovery replays from the last
snapshot to the requested timestamp, so a large interval means a long replay.

---

## 8. Transport and security

```ts
const transport = new RaftTcpTransport({
  node: { id: 1, host: '0.0.0.0', port: 7001 },
  peers: [ /* ... */ ],
  tls: { cert, key, ca, verify: { serverName: 'raft-node-1' } },
  connectTimeoutMs: 5_000,
  initialRetryMs: 100,
  maxRetryMs: 30_000,
  compression: { algorithm: 'zstd', thresholdBytes: 4096 },
});
```

* TLS **1.3 only**, with mutual certificate verification.
* Peer identity is checked against the certificate's CN/SAN (`raft-node-<id>` by default);
  a mismatched certificate fails the handshake — see [AC-C3](../README.md).
* `ConnectionPool` keeps one connection per peer, applies per-peer circuit breaking, and
  queues frames while a peer is reconnecting.
* `MessageCodec` frames each message with a length prefix plus CRC32, so truncated or
  corrupted frames are rejected rather than misinterpreted.

---

## 9. Observability

```ts
const metrics = new RaftMetricsCollector();
const probe = new HealthProbe({ consensusLayer });
```

| Signal | Type | Why it matters |
|---|---|---|
| `raft_term` | gauge | Jumps indicate election churn |
| `commit_index` / `applied_index` | gauge | Divergence ⇒ slow apply, not slow network |
| `election_count` | counter | Rising ⇒ timeouts too tight or network loss |
| `snapshot_count`, `snapshot_bytes` | counter | Compaction working |
| `peer_rtt_ms` | histogram | Distinguishes a slow peer from a slow disk |

Events (typed, from `EventBus`): `leader.elected`, `leader.lost`, `leader.step_down`,
`proposal.committed`, `proposal.applied`, `snapshot.created`, `snapshot.restored`,
`role.changed`, `membership.changed`.

---

## 10. Testing against a real cluster

The package publishes a harness so you do not have to reimplement it:

```ts
import { TestCluster, generateClusterCerts, LinearizabilityChecker } from '@agentix-e/db-cluster/testing';

const cluster = new TestCluster({ nodeCount: 3 });
await cluster.start();
const leader = await cluster.findLeader();
const followers = cluster.remainingNodes(leader.id);
// … propose, kill, wait for a new leader …
await cluster.stop(); // stops every node and removes its data directory
```

`TestCluster` gives you `findLeader()`, `waitForNewLeader(excludeId)`, `killNode(id)`,
`remainingNodes(excludeId)`, and the live `nodes` / `peerConfigs` / `dataDirs` arrays. Two
details are worth knowing because they are the ones that bite in CI:

- **Ports are not reserved.** `getFreePorts()` asks the OS and closes its probe socket before
  returning, so another process on a busy runner can take the port before your node binds.
  `start()` retries that specific failure with a fresh allocation (three attempts) and tears the
  partial attempt down first — a node that did bind holds a different port, and leaving it
  listening makes the retry collide with itself. A failure that is *not* a lost port race is
  thrown on the first attempt, unchanged. Inject your own allocator with
  `new TestCluster({ portAllocator })` to test that path.
- **`start()` cleans up after itself, and `stop()` is not optional.** A failed start is torn down
  before `start()` returns or retries, and `stop()` removes the temporary data directories it
  created — call it from `afterEach` even when the case failed, or the next run inherits the
  previous one's Raft log.

For acceptance-level assurance, spawn real processes over TLS exactly as the project's own
E2E suite does (`e2e/harness/raft-node.mjs`): the difference between "the tests pass" and
"the system works" is mostly whether the transport was real.

---

## 11. Limits and non-goals

| Limit | Value / note |
|---|---|
| Minimum cluster size | 1 node works, 3 is the smallest sensible HA deployment |
| Maximum group size | Practical limit ~7 voters; beyond that, use learners + federation |
| Payload size | Bounded by frame limits (~16 MB per message by default); batch large values |
| Cross-shard transactions | **Not supported.** Shard your data so transactions are shard-local |
| Linearizable cross-shard reads | **Not supported** without an external coordinator |
| Clock dependence | None for safety; lease reads assume bounded drift |
