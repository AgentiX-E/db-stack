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
| `snapshotInterval` | Entries between snapshots | Default **200**. `0` disables snapshots (unbounded log growth) |
| `maxLogEntries` | Forced compaction threshold | Default **0** (no forced snapshot; `snapshotInterval` alone decides). Set it or a slow follower pins the log forever |
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

**What the middleware guarantees you, and what it refuses:**

| Situation | Behaviour |
|---|---|
| `snapshot()` returns a non-`Buffer` (a JSON string, say) | Refused at capture, naming the type — Raft would otherwise "store" it as nothing |
| `snapshot()` returns 0 bytes | Refused at capture: a handler that exists means the application owns state, so an empty snapshot would truncate the log for an index it does not describe |
| No handler registered at all | Allowed. A log-only group has nothing to capture and still needs a boundary |
| A snapshot larger than 256 KiB | Transferred in chunks, one transfer per peer at a time; a follower that falls behind a compaction recovers by installing it |
| `installSnapshot()` throws | The replica stops applying and says so. It will not report the leader's applied index over state it never received |

A follower that was down while the leader compacted can therefore only recover by
installing a snapshot — the log it missed is gone. Give `installSnapshot()` the same
atomicity you give `snapshot()`: Raft has already discarded the log the snapshot replaces
by the time you are called.

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
const planner = new ReshardPlanner();
const plan = await planner.createMovePlan(7, 'node-b');
await planner.executePlan(plan);

// Moving one shard's data to the node that will own it.
const migration = new OnlineShardMigration(shardSource, targetSink);
const { migrationId } = await migration.startMigration({
  shardId: 7,
  sourceNode: 'node-a',
  targetNode: 'node-b',
  batchSize: 512,
  finalSyncTimeoutMs: 5_000,
  pauseWritesOnCutover: true,
});
const status = await migration.waitForCompletion(migrationId);
```

The migration copies state, then catches up everything written above the version the
copy reached, and only then switches routing. During the copy the source keeps serving;
the switch is a routing update, not a restart.

`shardSource` and `targetSink` are yours: `IShardMigrationSource` asks a shard for its
entry count, a page of entries above a version watermark, one entry by key and its
current version; `IShardMigrationSink` applies an entry and counts what it holds. Any
engine that can answer those five questions can be migrated by this coordinator — the
package never imports yours.

The migration does not claim success from its own counter. Before it completes it asks
both sides how many entries they hold, and a target that is short fails the migration
with both numbers in the message; so does a source that never quiesced inside
`finalSyncTimeoutMs`.

### Write forwarding (optional `pg` dependency)

`RaftGroupManager` can forward a write it receives on a follower to the shard leader over
the PostgreSQL wire protocol instead of rejecting it. That path needs the optional
`pg` (node-postgres) dependency; the rest of the package does not.

```ts
const manager = new RaftGroupManager(config, replicaCount); // no pg required to construct
manager.autoForwardEnabled = true;                          // forwarding is opt-in
```

If `pg` is not installed, the first forwarded write fails with an error that names the
dependency and the feature rather than a bare module-resolution message. Nothing else
degrades: the forwarding path is the only consumer.

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

Adding a read-only replica? Use a learner, let it catch up, then promote it. Learners
replicate the log but never vote, so a slow region cannot stall your commits.

### Growing the cluster from the consensus layer

`RaftAdapter` drives the same operation over a live cluster, one node at a time:

```ts
const added = await adapter.addServer(4, '10.0.0.4:7001', /* asLearner */ true);
if (!added.changed) console.error(`not added: ${added.reason}`);   // e.g. 'unreachable'

await adapter.promoteServer(4);        // learner -> voter
await adapter.removeServer(3);         // and forget the peer on the wire
const { voters, learners, source } = await adapter.getMembership();
```

The three methods answer with a result rather than a bare `false`, because the
reasons need different responses:

| `reason` | Meaning | What to do |
|---|---|---|
| `not-leader` | This node is not the leader | Send the request to the leader |
| `no-quorum` | Leader without a majority | Wait for contact; a change now would half-apply |
| `unreachable` | The named node did not answer | Start it, check its certificate, then retry |
| `rejected` | Raft refused or the commit timed out | Read the membership before retrying |
| `unsupported` | The transport cannot add peers dynamically | Use a transport that can (TCP/mTLS) |

Two things are worth knowing before you use it in production:

* **The address must answer before the change is committed.** `addServer` registers
  the peer, waits up to 3 s for a socket, and only then appends the configuration
  entry. Without that order the cluster gains a member it has never sent an entry
  to — a replica that looks healthy and holds nothing.
* **One entry at a time.** The library appends a single-step configuration, not a
  joint one, so a promotion or a removal needs the existing voters to be reachable
  at that moment. With a voter down, the change reports `rejected` after the commit
  timeout rather than leaving you to guess.

`getMembership()` reports `source: 'bootstrap'` until the first configuration is
persisted. That is the honest answer for a freshly started node: it is running the
membership it was launched with, and nothing has confirmed anything else yet.

### Serving a learner that pulls

A learner normally catches up through the leader's own replication. When you drive
the pull yourself — a read replica you schedule, a migration tool, an operator
asking what a node really holds — ask the group for a slice of its log:

```ts
const { entries, firstAvailableIndex, lastIndex, lastTerm, snapshotAvailable } =
  await group.requestForLearner(cursor, 256);

for (const entry of entries) await replica.apply(entry);   // same shape apply() takes
cursor = entries.length > 0 ? entries[entries.length - 1].index + 1 : cursor;
if (cursor < firstAvailableIndex) {
  // The gap is older than the retained log: take the snapshot instead of asking
  // again for entries that compaction has already removed.
}
```

Three properties are worth relying on:

* **The window is reported, not implied.** `firstAvailableIndex` is the floor
  compaction has left behind. A cursor below it is a signal to switch to the
  snapshot, not an error, and `snapshotAvailable` says whether that is possible.
* **Entries arrive applyable.** Each one carries `index`, `term`, `command`, `data`,
  and — when the payload was written by this package — the `msgId` that makes a
  replay idempotent. You can hand them straight to `IShardReplica.apply()`.
* **Pulls are bounded and cheap to resume.** `limit` defaults to 128 entries; the
  slice is contiguous and ascending, so the next pull continues from the index after
  the last entry you received. A cursor past the head returns an empty slice.

`RaftAdapter.getLogEntries(fromIndex, limit)` and `getLogBounds()` expose the same
window without a group, which is what the cluster harness and the federation layer
use.

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

### 9.1 Trace correlation

Every log line carries a `traceId` field, taken from an `AsyncLocalStorage` scope. Wrap the
work you want correlated:

```ts
import { traceContext } from '@agentix-e/db-cluster';

app.use((req, res, next) =>
  traceContext.runWith(req.headers['x-request-id'] ?? crypto.randomUUID(), () => next()),
);
```

The id survives `await`, timers and callbacks, so a proposal logged by the Raft loop and the
apply logged by the state machine carry the same value. Outside any scope the field is
`undefined` — there is no ambient default, because a fake id is worse than none when you
are grepping for one request.

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
