# db-cluster API Reference

`@agentix-e/db-cluster` is a Raft-based consensus and sharding middleware. It
never touches a database directly: a replica is anything that implements
`IShardReplica` (apply an entry, take a snapshot, install one), so PostgreSQL,
SQLite, an LSM tree or an in-memory map all plug into the same consensus core.

Everything below is the package root's export surface — `src/index.ts`. Every
heading on this page is checked against that surface by
`scripts/check-docs-api.mjs` on every CI run, and every exported value must be
mentioned here for the gate to pass. The four classes this page used to
document — `RaftCluster`, `ClusterConfig`, `FencingToken` and `ITransport` —
were never written; the check exists because a reference page is a promise about
the package.

The published subpaths are documented in their own places: `./testing` in
[testing.md](./testing.md), and `./raft`, `./transport` and `./storage` re-export
`RaftAdapter`, `RaftTcpTransport` and `SqliteStorage`, each documented below.

## How the pieces fit

```
 your engine ──► IShardReplica ◄── RaftGroup ◄── RaftAdapter ──► raft-core
                     ▲                 ▲                            │
                     │                 │                            ▼
              ShardStateMachine   RaftGroupManager  ◄── RaftTcpTransport / NodeTransport
                                       │
                                  one group per shard
```

`RaftGroupManager` owns one `RaftGroup` per local shard, each group wrapping a
`RaftAdapter` (the `@maboke123/raft-core` node) around an `IShardReplica`. A
transport carries `RaftMessage`s between nodes; storage persists the log.

## Consensus core

### `RaftAdapter`

The wrapper around `@maboke123/raft-core`'s `RaftNode`. It normalises the
upstream API, proxies the transport so it can be swapped or observed, and adds
the queries this middleware needs — retained log length, log bounds, log
entries, membership, peer progress — that the upstream node does not expose
directly.

```typescript
class RaftAdapter {
  constructor(config: RaftConfig);
  init(
    applyHandler?: (data: string, index?: number, term?: number) => void | Promise<void>,
    tcpConfig?: RaftTcpTransportConfig,
    sharedTransport?: SharedTransport,
  ): Promise<void>;
  setApplicationSnapshotHandlers(handlers: {
    takeSnapshot?: (boundaryIndex: number) => Buffer | Promise<Buffer>;
    installSnapshot?: (data: Buffer) => void | Promise<void>;
    appliedIndex?: () => number | Promise<number>;
  }): void;
  propose(data: string): Promise<{ index: string; term: string }>;
  proposeAndWait(data: string): Promise<{ index: string; term: string }>;
  isLeader(): Promise<boolean>;
  getLeader(): Promise<number>;
  getTerm(): Promise<number>;
  campaign(): Promise<void>;
  transferLeadership(targetNodeId: string): Promise<void>;
  getCommitIndex(): Promise<number>;
  getAppliedIndex(): Promise<number>;
  getRetainedLogLength(): Promise<number>;
  getLogBounds(): Promise<{ firstIndex: number; lastIndex: number; lastTerm: number }>;
  getLogEntries(fromIndex: number, limit?: number): Promise<ApplyEntry[]>;
  getMembership(): Promise<Membership>;
  addServer(nodeId: number, address: string, asLearner?: boolean): Promise<MembershipChangeResult>;
  promoteServer(nodeId: number): Promise<MembershipChangeResult>;
  removeServer(nodeId: number): Promise<MembershipChangeResult>;
  getPeerProgress(): Promise<Record<number, { next: number; match: number }>>;
  getQuorumHealth(): QuorumHealth;
  readBarrier(): Promise<void>;
  stop(): Promise<void>;
  releaseResources(): Promise<void>;
}
```

`getLogBounds()` returns `null` for an empty log; `getLogEntries()` clamps its
lower bound, returns an empty slice past the head, and returns an empty slice
rather than throwing when compaction lands mid-read — a learner pulling entries
must be able to tell "nothing there yet" from "I lost the race".

`init()` ends with a check the adapter can only make with the application's help:
that the engine's state is where Raft says the node is. The optional
`appliedIndex` provider is what makes it possible. A node whose engine is behind
the log is refused with `FAILED_PRECONDITION`, naming both positions and the width
of the hole, because the entries in it are applied without reaching the
application and are already compacted out of the log — the node would answer reads
out of a hole, and no later replay could fill it. Without a provider the check
covers the one case the handler table decides on its own: a snapshot exists in
storage, the application registered `takeSnapshot`, and no `installSnapshot` was
registered to receive the state. `getStatus()` reports `applicationApplied` and
`appliedGap` for monitoring; both are `null` when no provider is registered,
because "not published" is not "zero".

### Where a quorum's member set comes from

`getQuorumHealth()` is arithmetic over a member set, and the set has three sources,
in this order:

1. `RaftConfig.peers` — the declared cluster, which is what a node started with a
   `tcpConfig` has;
2. `RaftConfig.quorumMembers` — the same list for a mode that does not declare it,
   such as a group whose members live in the `RaftGroupManager` that routes for it.
   It is merged with `peers`, never a replacement: declaring the set twice cannot
   produce two different majorities;
3. the configuration raft **committed**, read from this node's storage. A node that
   declared nothing adopts it on its first `isLeader()` and inside every membership
   change.

`null` means "no accounting", not "no quorum": it is what `checkQuorum: false` asks
for, and what a node answers in the window before any of the three sources has
produced a member set. That window is why a group on a shared transport used to be
unaccounted — a watchdog built from an empty `peers` would have been a watchdog of
one, which is true of every isolated node. The committed configuration is the only
list that is a _fact_, so it is the one that wins.

A single-node cluster is not that window: its committed configuration names one
voter, one answer is a majority, and `hasQuorum` is `true` because it has to be.

### Membership changes are single-step

`addServer` / `promoteServer` / `removeServer` append a **single-step**
configuration — the new voter set is in force for the commit that admits it — so a
change commits when the _enlarged_ set can answer, not when every existing voter
can. The arithmetic has a consequence worth stating plainly, because the intuitive
reading is the opposite one: promoting a reachable learner needs
`⌊(n+1)/2⌋ + 1` acknowledgements out of `n+1` voters, and the learner is one of
them, so a single voter being down does not block the promotion. Measured, not
argued: `e2e/tests/cluster-membership.test.ts` (AC-C11) kills one voter of a
six-voter cluster and promotes a seventh, on five real processes over mTLS, in under
a second.

What a change does not survive is _losing the quorum it would need_, and that case
is refused by name rather than by timeout. `removeServer` on a leader that can no
longer hear a majority answers `{ changed: false, reason: 'no-quorum' }` in about a
millisecond and appends nothing (AC-C12) — the guard reads the watchdog before
raft-core is asked, because a node that keeps reporting itself leader after losing
its majority is precisely the state it exists for.

One residue is worth knowing. If a change does reach raft-core and fails to commit —
an entry appended in the window between losing a majority and the watchdog noticing
it — raft-core keeps that configuration in its in-memory active set, so the node
refuses further changes with `rejected` until it restarts and re-reads the committed
configuration. `getMembership()` is unaffected either way: it reports what was
committed, and the watchdog keeps the majority raft can commit with. For the
two-phase path (C_old → C_old,new → C_new, with rollback) use
`RaftGroup.proposeMembershipChange`, which drives the joint-consensus engine.

Two defaults are published because a caller may want to state them explicitly
rather than inherit them:

| Constant                    | Value | Meaning                                                                                                                                                                                            |
| --------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_LOG_SLICE`         |   128 | Entries one learner pull carries when the caller asks for no particular count. Raising it shortens catch-up at the cost of larger responses.                                                       |
| `DEFAULT_SNAPSHOT_INTERVAL` |   200 | Committed entries between snapshots. Lower keeps the log a restart replays short and pays for it in capture cost; higher does the reverse. `bench/snapshot-threshold-sweep.ts` measures the curve. |

### `RaftGroup`

One shard's consensus unit: the adapter plus the replica plus the shard-level
concerns — joint consensus, learners, leader transfer, snapshots, log limits,
fencing and read-only mode.

```typescript
class RaftGroup {
  constructor(
    shardId: number,
    raftConfig: RaftConfig,
    replica: IShardReplica,
    outboxManager: IOutboxWriter,
    snapshotDir?: string,
    flexQuorumConfig?: Partial<FlexibleQuorumConfig>,
    pitrHook?: IPITRHook,
    pitrFlushHook?: () => Promise<void>,
  );
  init(sharedTransport?: SharedTransport): Promise<void>;
  propose(entry: ApplyEntry): Promise<void>;
  proposeBatch(entries: ApplyEntry[]): Promise<void>;
  proposeAndWait(entry: ApplyEntry): Promise<void>;
  proposeAsync(entry: ApplyEntry): void;
  read(sql: string, params?: any[]): Promise<any[]>;
  isLeader(): Promise<boolean>;
  getLeader(): Promise<number>;
  getTerm(): Promise<number>;
  getProgress(): Promise<Record<string, number>>;
  getLearners(): Map<string, LearnerInfo>;
  addLearner(nodeId: string): Promise<boolean>;
  removeLearner(nodeId: string): boolean;
  requestForLearner(
    fromIndex: number,
    limit?: number,
  ): Promise<{
    entries: ApplyEntry[];
    snapshotAvailable: boolean;
    firstAvailableIndex: number;
    lastIndex: number;
    lastTerm: number;
  }>;
  updateLearnerProgress(nodeId: string, matchedIndex: number): void;
  proposeMembershipChange(
    change: MembershipChange,
  ): Promise<{ success: boolean; phase: RaftConsensusPhase; error?: string }>;
  rollbackMembershipChange(): Promise<boolean>;
  getConsensusPhase(): RaftConsensusPhase;
  isJointQuorumSatisfied(acknowledgedPeerIds: Set<number>): boolean;
  transferLeadership(targetNodeId: string): Promise<LeaderTransferResult>;
  trySnapshot(): Promise<void>;
  enforceLogLimit(): Promise<void>;
  enterReadOnlyMode(): Promise<void>;
  getSplitBrainStatus(): {
    inMajority: boolean;
    readOnly: boolean;
    connectedPeers: number;
    totalPeers: number;
    fencingState: string;
  };
  stop(): void;
}
```

`proposeBatch()` is the batch path: one `__batch` command carries N entries and
costs one commit, which is what the write path uses. `requestForLearner()` reads
the leader's retained log for a learner that fell behind; when the requested
range is already compacted it reports `snapshotAvailable: true` instead of
pretending the range is empty.

### `RaftGroupManager`

The node-level owner: registers shards, routes proposals and reads to the right
group, forwards writes to the leader when forwarding is enabled, batches
per-shard traffic, optionally shares one transport across all groups, and
aggregates health.

```typescript
class RaftGroupManager {
  constructor(
    outboxManager: any,
    tickMs?: number,
    flexQuorumConfig?: Partial<FlexibleQuorumConfig>,
    clusterTopology?: IClusterTopology,
  );
  registerShardWithReplica(
    shardId: number,
    replica: IShardReplica,
    peers: { nodeId: string; raftIndex: number }[],
    localRaftIndex: number,
    raftConfigOverrides?: Partial<RaftConfig>,
  ): void;
  deregisterShard(shardId: number): void;
  pauseShard(shardId: number): Promise<void>;
  resumeShard(shardId: number): Promise<void>;
  start(): Promise<void>;
  waitForRaftLeaders(timeoutMs?: number): Promise<boolean>;
  propose(shardId: string, value: string): Promise<number>;
  proposeBatch(shardId: number, entries: any[]): Promise<void>;
  proposeAndWait(shardId: number, entry: any): Promise<void>;
  read(shardId: number, sql: string, params?: any[]): Promise<any[]>;
  proposeRead(
    shardId: number,
    sql: string,
    params?: any[],
  ): Promise<{ rows: any[]; quorumResult: RaftGroupQuorumResult }>;
  getLeaderForShard(shardId: number): Promise<number>;
  getStats(): Promise<Record<number, { isLeader: boolean; term: number; progress: Record<string, number> }>>;
  getHealthStatus(): Promise<RaftHealthStatus[]>;
  getPeerStatus(): RaftPeerStatus[];
  notifyTopologyChange(
    peers: { nodeId: string; raftIndex: number }[],
    localRaftIndex: number,
  ): Promise<Map<number, { success: boolean; phase: RaftConsensusPhase }>>;
  requestForLearner(shardId: number, fromIndex: number, limit?: number): Promise<LearnerPullResult>;
  getLeaderHealthSummary(): Promise<LeaderHealthSummary>;
  stop(): Promise<void>;
}
```

`getHealthStatus()` reports `applyLag` (`lastLogIndex - appliedIndex`) per
group — the depth of the apply queue, not the replication position, because an
apply backlog and a replication lag need different responses.

### `ShardStateMachine`

The adapter between raft-core's `ApplicationStateMachine` and the apply handler
a `IShardReplica` is built around: `apply`, `getState`, `takeSnapshot`,
`installSnapshot`.

```typescript
class ShardStateMachine {
  constructor(callbacks: ShardStateMachineCallbacks);
  apply(command: Command): Promise<any>;
  getState(): any;
  takeSnapshot(): Promise<Buffer>;
  installSnapshot(data: Buffer): Promise<void>;
}
```

### `RaftJointConsensusEngine`

Two-phase joint consensus on top of `RaftGroup.proposeMembershipChange`: enter
the joint configuration, commit under both majorities, then leave it for the new
configuration. It retries with exponential backoff, aborts cleanly, and emits
progress events.

```typescript
class RaftJointConsensusEngine {
  constructor(getRaftGroup: (shardId: number) => RaftGroup, getConsensusLayer: () => IConsensusLayer);
  transitionTo(peers: PeerConfig[], options?: TransitionOptions): Promise<TransitionResult>;
  getTransitionPhase(): TransitionPhase;
  getActiveTransition(): { changeId: string; oldConfig: PeerConfig[]; newConfig: PeerConfig[]; phase: TransitionPhase };
  getProgress(): TransitionProgress;
  abortTransition(): Promise<TransitionResult>;
  onTransitionEvent(handler: (event: MembershipChangeEvent) => void): () => void;
}
```

## Consensus extensions

### `InstallSnapshotHandler`

The InstallSnapshot RPC from §7 of the Raft paper, chunked: the leader streams
the snapshot in pieces, the follower assembles them, verifies the checksum and
installs atomically. Stale partial assemblies are reaped.

```typescript
class InstallSnapshotHandler {
  constructor(snapshotDir: string, nodeId: number, config?: Partial<InstallSnapshotHandlerConfig>);
  handleChunk(
    req: InstallSnapshotRequest,
    raft: RaftAdapter,
    installSnapshotCallback: InstallSnapshotCallback,
  ): Promise<SnapshotChunkResult>;
  createChunks(
    snapshotPath: string,
    meta: ShardSnapshotMeta,
    leaderId: string,
    chunkSize?: number,
  ): AsyncGenerator<InstallSnapshotRequest>;
  sendSnapshot(
    raft: RaftAdapter,
    targetNodeId: string,
    snapshotPath: string,
    meta: ShardSnapshotMeta,
  ): Promise<boolean>;
  getAssemblyProgress(): { key: string; chunks: number; bytesReceived: number; elapsedMs: number }[];
  cleanStaleStates(): void;
  reset(): void;
}
```

### `LeaderTransferHandler`

Graceful leadership transfer: append a no-op, send `TimeoutNow` to the target,
then wait for it to win the election — bounded by `timeoutMs` so a target that
cannot win does not freeze the group.

```typescript
class LeaderTransferHandler {
  constructor(config?: Partial<LeaderTransferHandlerConfig>);
  transfer(raftNode, currentLeaderId, targetNodeId, proposeFn, getLeaderFn, isLeaderFn): Promise<LeaderTransferResult>;
  sendTimeoutNow(raftNode, targetNodeId: string): Promise<void>;
  waitForNewLeader(currentLeaderId, getLeaderFn, startTime: number): Promise<LeaderTransferResult>;
  isTransferInProgress(): boolean;
  getConfig(): LeaderTransferHandlerConfig;
  setConfig(config: Partial<LeaderTransferHandlerConfig>): void;
  reset(): void;
}
```

### `LeaseReadManager`

The lease-read optimisation: while the leader has heard from a quorum inside
`leaseMs`, it can answer a linearizable read locally instead of running a
ReadIndex round.

```typescript
class LeaseReadManager {
  constructor(leaseMs?: number);
  onQuorumHeartbeatAck(now?: number): void;
  isLeaseValid(): boolean;
  getLeaseRemaining(): number;
  readonly leaseDuration: number;
  reset(): void;
}
```

### `ReadIndexManager`

The ReadIndex protocol for one group: record the commit index at request time,
answer the read once the leader has confirmed leadership for that index, and
fail every pending request when the leader is lost rather than hanging.

```typescript
class ReadIndexManager {
  constructor(readTimeoutMs?: number);
  requestReadIndex(): Promise<number>;
  onCommitIndex(currentIndex: number): void;
  onLeaderLost(): void;
  readonly pendingCount: number;
  readonly timeout: number;
}
```

### `FencingManager`

Write fencing (STONITH-style): when a leader has not heard a heartbeat for a
shard inside the lease, it stops accepting writes instead of serving a
partition. `checkWriteAllowed()` is the gate the write path consults;
`onFenceTriggered` and `onPanic` are the escalation hooks.

The lease answers _"should this node stop?"_ — a local decision taken from
elapsed time. It is not enough on its own: a partitioned primary that still hears
one peer has a valid lease and a wrong belief. `checkWriteAllowed(shardId, token)`
therefore consults a second, independent gate, the `FencingTokenGuard` below, and
refuses if either says no. Token admission is opt-in (`requireToken`), so an
engine that cannot carry a token yet keeps the behaviour it had.

```typescript
class FencingManager {
  constructor(config?: Partial<FencingConfig>);
  start(): void;
  stop(): void;
  getState(): FenceState;
  getShardState(shardId: number): FenceState;
  receiveHeartbeat(shardId: number, term: number, leaderId: string): void;
  checkWriteAllowed(shardId: string | number, token?: FencingToken | null): { allowed: boolean; reason?: string };
  admitToken(token: FencingToken): WriteAdmission;
  getHighestToken(): FencingToken | null;
  getFormattedHighestToken(): string | null;
  onFenceTriggered(callback: (reason: string) => void): void;
  onPanic(callback: (reason: string) => void): void;
  getStatus(): FencingStatus;
  fenceNode(nodeId: string): void;
  removeShard(shardId: number): void;
  checkAllLeases(): void;
}
```

### `FencingTokenGuard`

The resource layer's own answer to _"may this write land?"_ — and the only place a
partitioned primary is actually stopped.

A token is the quorum's log position at the moment it granted the right to write:
the term, and the index committed in that term. The pair orders totally and never
goes backwards, so a resource that remembers the highest token it has accepted
refuses everyone from before it, including a leader whose lease, clock and peers
all still say it is the leader.

```typescript
class FencingTokenGuard {
  constructor(options?: FencingTokenGuardOptions);
  admit(token?: FencingToken | null, context?: string): WriteAdmission;
  observe(token: FencingToken): void;
  getHighest(): FencingToken | null;
  getRefusalCount(): number;
  onRefused(observer: FencingRefusalObserver): () => void;
  reset(token?: FencingToken | null): void;
}

function mintFencingToken(term: number, index: number): FencingToken;
function compareFencingTokens(a: FencingToken, b: FencingToken): -1 | 0 | 1;
function formatFencingToken(token: FencingToken): string;
function parseFencingToken(raw: string): FencingToken;
function stampFencingTokenOnEntry<T extends object>(
  entry: T,
  term: number,
  commitIndex: number,
): T & { fencingToken: string };
```

| Decision                   | When                                       | Why                                                                                        |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `missing-token`            | no token, and `requireToken` (the default) | fail-closed: a resource that cannot tell whether a writer is current must not assume it is |
| admitted                   | token equal to the highest                 | a retry is not a usurper; at-least-once delivery depends on it                             |
| `stale-token`              | token below the highest                    | the resource has already accepted a later position                                         |
| admitted, highest advances | token above the highest                    | the right to write has moved on                                                            |

`mintFencingToken` validates the coordinates, `compareFencingTokens` is the total
order (term first, then index), and `formatFencingToken` / `parseFencingToken` are
the wire form — `"term/index"` in canonical unsigned decimals, so one position has
exactly one spelling and two nodes cannot disagree about whether they agree.

`initial` seeds the highest token from the engine's durable state. A resource that
restarts with an empty memory re-admits the old primary's writes during exactly
the window the token exists to cover, so recovery from durable state is part of
the contract rather than a convenience.

`stampFencingTokenOnEntry` is the write-path seam. `RaftGroup.propose()` calls it
with the group's current term and committed index before committing, so every
entry carries the position that authorised it. An entry with no token is returned
with one stamped (the caller's object is not mutated); a token at or above the
position is kept, so a retry is not rewritten; a token below it, or a malformed
one, is refused before a log entry exists. The function knows nothing about
shards, tables or sockets, so an engine that drives the cluster directly can call
the same seam its own write path needs.

`RaftGroup.fencingRequest()` mints the token from the term the group is in and the
index it has committed, and `getFencingToken()` hands it to the engine, which
attaches it to every write. The fence also refuses to mint when the group's own
term is behind a term it has already observed, and falling back to read-only drops
the token — a fenced node presents nothing rather than a superseded position.

### `LogicalPrimaryResolver`

A stable logical name that follows the elected leader, so a failover is a
protocol event rather than a DNS change. The resolver reads the leader id and
the live member set through injected callbacks (`leader()`, `members()`, and an
optional `term()`), so it is engine-agnostic and knows nothing about Raft or
storage. Each `resolve()` reads the callbacks afresh.

```ts
interface PrimaryMember { id: string; role: 'leader' | 'follower' | 'candidate' | 'learner' }

interface LogicalPrimaryDeps {
  leader(): Promise<number | string | null>;
  members(): Promise<readonly PrimaryMember[]>;
  term?(): Promise<number | undefined>;
}

class LogicalPrimaryResolver {
  constructor(name: string, deps: LogicalPrimaryDeps);
  resolve(): Promise<PrimaryResolution>;
  epoch(): number;         // 0 before the first successful resolution
  lastMemberId(): string | null;
}

function resolveLogicalPrimary(
  name: string,
  input: { leaderId: number | string | null; members: readonly PrimaryMember[]; leaderTerm?: number },
): PrimaryResolutionCore;
```

`PrimaryResolution` carries `memberId`, `resolved`, a named `reason`
(`leader-is-member`, `no-leader`, `no-members`, `leader-not-a-member`), and a
monotonic `epoch` that advances only when the resolved member actually changes.
`changed` is true only on the resolution that moved. The elected leader id is
authoritative: a stale role label on a member row does not block resolution, but
a leader id absent from the member set is refused by name. A numeric leader id
matches both a bare `2` and a `node-2` member id. `resolveLogicalPrimary` is the
stateless form for callers that already hold a membership snapshot.

### `IdempotencyTable` and `IdempotentWriteCoordinator`

A retry of the same `msgId` returns the first attempt's result instead of
becoming a second write. The dedup window is injected as `windowMs` (the value
P3-83 derives as `dedupMs`), so this package imports neither federation nor any
engine; the write itself is a caller-supplied callback.

```ts
class IdempotencyTable<Result> {
  constructor(options: { windowMs: number; now?: () => number; maxEntries?: number });
  get(msgId: string): IdempotencyRecord<Result> | undefined;
  has(msgId: string): boolean;
  put(msgId: string, result: Result, position: number): IdempotencyRecord<Result>;
  delete(msgId: string): boolean;
  sweep(): number;
  readonly size: number;
  stats(): { size: number; evicted: number; capacity: number; windowMs: number };
}

class IdempotentWriteCoordinator<Result> {
  constructor(options: { table: IdempotencyTable<Result> });
  execute(msgId: string, write: () => Promise<Result>, position: number): Promise<IdempotentOutcome<Result>>;
  inFlight(): number;
}
```

`IdempotentOutcome` reports `result`, `replayed`, `attempts` and `position`.
A completed id replays without executing again; concurrent callers of one id
share a single execution; a failed execution is not remembered, so a later
retry may try once more. Entries expire at `recordedAt + windowMs` (`0` never
remembers, `Infinity` never forgets) and are evicted FIFO at `maxEntries`.

### `SessionManager`

Consensus sessions with a TTL, sliding expiry and an expiry callback — the
primitive a client-lease or a "leader still alive" check builds on.

```typescript
class SessionManager {
  constructor(config: SessionConfig);
  create(id: string, metadata?: Record<string, unknown>): SessionEntry;
  get(id: string): SessionEntry | null;
  delete(id: string): SessionEntry | null;
  extend(id: string): boolean;
  onExpiry(handler: SessionExpiryHandler): () => void;
  activeCount(): number;
  cleanup(): number;
  shutdown(): void;
}
```

### `EventBus`

A synchronous consensus event bus. `on()` handlers run in registration order
inside `emit()`; `onAsync()` handlers are awaited out of band. Every
subscription returns a disposable, so a stopped group releases its listeners.

```typescript
class EventBus {
  emit(event: ConsensusEvent): void;
  on(type, handler): IDisposable;
  onAsync(type, handler): IDisposable;
  once(type, handler): IDisposable;
  subscriberCount(type?: string): number;
  reset(): void;
}
```

### `WatchApi`

Prefix-scoped watches over the event bus: a subscriber registers a key prefix
and receives the matching events until it disposes the subscription.

```typescript
class WatchApi {
  constructor(eventBus: IEventBus);
  watch(keyPrefix: string, handler: WatchHandler, options?: WatchOptions): IDisposable;
  activeWatchCount(): number;
  shutdown(): void;
}
```

### `AdaptiveElectionTimeout`

Election timeouts derived from measured RTT instead of a constant: it keeps a
sample window, recomputes the tick when the average moves, and reports the
change through `onChange` so the group can re-arm its timers.

```typescript
class AdaptiveElectionTimeout {
  constructor(config?: Partial<AdaptiveElectionConfig>, onChange?: (newTick: number, oldTick: number) => void);
  start(): void;
  stop(): void;
  recordRtt(rttMs: number): void;
  getAvgRtt(): number;
  getRecommendedTick(): number;
  recalculate(): void;
  getSampleCount(): number;
}
```

### `PeerCircuitBreakerWrapper`

One circuit breaker per peer, so a dead peer fails fast instead of consuming a
connection attempt per message. `fire()` wraps the call and trips the breaker
after the configured failure threshold.

```typescript
class PeerCircuitBreakerWrapper {
  constructor(peerId: number, options?: PeerCircuitBreakerOptions);
  fire<T>(action: () => Promise<T>): Promise<T>;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly isOpen: boolean;
  readonly isHalfOpen: boolean;
  open(): void;
  close(): void;
  getMetrics(): CircuitBreakerMetric;
  shutdown(): void;
}
```

## Transport

### `RaftTcpTransport`

TCP with mutual TLS for Raft messages: length-framed, one `PeerConnection` per
peer, reconnection with backoff, and per-peer circuit breakers.

It is the only writer: a frame that cannot go out now is buffered (bounded at
1024 per peer) and flushed when the socket comes up. A buffered batch that the
new socket rejects is put back and the socket closed, up to three attempts;
after that the frames are dropped, counted in `getStatus().droppedFrames` and
reported through the `frames-dropped` event.

Frames for one peer reach the socket in the order `send()` was given them,
whichever path they take. Three exist — a compressed frame's queue link, the
uncompressed fast path, and the buffer that holds frames for a peer with no
connection — and they meet in one gate per peer: a frame joins the queue when
anything older is still in flight or buffered, the flush is a link in that queue
rather than a write from the connection callback, a new frame never overtakes a
buffered backlog, and a write that fails is put back at the head of the buffer
instead of being logged and lost. Heartbeats are the exception in one direction
only: they are dropped rather than queued when the peer is behind, because the
next one carries a newer commit index. A flush resolves its socket when its turn
comes, not when it was requested — a connection the pool has replaced is one whose
writes the peer may never read.

```typescript
class RaftTcpTransport {
  constructor(config: RaftTcpTransportConfig);
  register(node: RaftNodeConfig): void;
  unregister(nodeId: number): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(fromId: number, msgs: RaftMessage[]): Promise<void>;
  sendToPeer(peerId: number, payload: Buffer): void;
  onMessage(handler: MessageHandler): void;
  awaitPeerConnection(peerId: number, timeoutMs: number): Promise<boolean>;
  waitForConnections(): Promise<void>;
  getBoundPort(): number;
  getConnectedPeers(): number[];
  getStatus(): {
    connectedPeers: number[];
    totalPeers: number;
    started: boolean;
    bufferedFrames: Record<number, number>;
    droppedFrames: number;
  };
  canReach(peerId: number): boolean;
  getCircuitBreakerMetrics(): CircuitBreakerMetric[];
}
```

### `FramesDroppedEvent`

The payload of the `frames-dropped` event: `{ peerId, count, reason, head }`,
where `reason` is `buffer-full` (the peer's queue hit its cap) or `flush-failed`
(three fresh sockets rejected the batch). `head` is the first eight bytes of the
oldest discarded frame, so a log line can be matched to a message.

### `BatchedRaftTransport`

Turns the fire-and-forget transport into request/response: every outbound
message carries a request id, the reply resolves the pending promise, and a
missing reply times out instead of leaking.

```typescript
class BatchedRaftTransport {
  constructor(config: RaftTcpTransportConfig, requestTimeoutMs?: number);
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, message: RPCMessage): Promise<RPCMessage>;
  sendFrame(peerNumId: number, requestId: string, message: RPCMessage): Promise<RPCMessage>;
  addPeer(peerId: string, address: string): Promise<void>;
  removePeer(peerId: string): void;
  awaitPeer(peerId: string, timeoutMs: number): Promise<boolean>;
  onIncoming(wireMsg: any, fromPeerId: string): void;
  claimSnapshotTransfer(peer: number, chunk: SnapshotChunk): void;
  settleSnapshotTransfer(peer: number, chunk: SnapshotChunk, answered: boolean): void;
  getStats(): Record<string, TransportPeerStats>;
}
```

### `SharedBatchedTransport`

The same request/response bridge for a `SharedTransport` — one socket per peer
carrying every shard's traffic, demultiplexed by shard id.

```typescript
class SharedBatchedTransport {
  constructor(shared: SharedTransport, shardId: number, selfNodeId: string, requestTimeoutMs?: number);
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, message: RPCMessage): Promise<RPCMessage>;
  onIncoming(wireMsg: any): void;
  unregisterHandler(): void;
  isStarted(): boolean;
}
```

### `NodeTransport`

The node-level transport a `RaftAdapter` uses: one TCP transport shared by every
shard on the node, with `forShard(shardId)` handing back a shard-scoped view.

```typescript
class NodeTransport {
  constructor(config: RaftTcpTransportConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  send(fromId: string, msgs: any[]): Promise<void>;
  onMessage(handler: (shardId: number, msg: any) => void): void;
  forShard(shardId: number): { send(fromId: string | number, msgs: any[]): Promise<void> };
  sendToShard(fromId: string, shardId: number, msgs: RaftMessage[]): Promise<void>;
  registerPeer(node: { id: number; host: string; port: number }): void;
  getStatus(): { connectedPeers: number[]; totalPeers: number; started: boolean };
}
```

### `MessageCodec`

The TCP wire format for Raft messages: frame length prefix, message type, and
the encode/decode pair both sides share.

### `ConnectionPool`

The mTLS connection pool underneath `RaftTcpTransport`: dial-on-demand, retry
with backoff, a circuit breaker per peer, and a non-blocking connection lookup
so a Raft tick never waits on a TLS handshake.

It owns sockets and nothing else. Framing, buffering and the policy for an
unreachable peer live in `RaftTcpTransport`, which is the only writer.

```typescript
class ConnectionPool {
  constructor(config: ConnectionPoolConfig);
  addNode(peer: PeerInfo): void;
  removeNode(peerId: number): void;
  getConnection(peerId: number): Promise<PeerConnection>;
  tryGetConnection(peerId: number): PeerConnection | null;
  onIncoming(peerId: number, socket: TLSSocket): Promise<PeerConnection>;
  markStale(peerId: number): void;
  getCircuitBreakerMetrics(): CircuitBreakerMetric[];
  stop(): Promise<void>;
  readonly connectionCount: number;
  readonly connectedPeers: number[];
}
```

### `PeerConnection`

One TLS socket to one peer, with a write lock (concurrent writers cannot
interleave frames), a health check, and an epoch so a replaced socket is
recognisably stale.

```typescript
class PeerConnection {
  constructor(peerId: number, socket: TLSSocket, epoch?: number);
  write(data: Buffer): Promise<void>;
  sendHeartbeat(): Promise<void>;
  replaceSocket(socket: TLSSocket): void;
  close(): void;
  readonly connected: boolean;
  readonly destroyed: boolean;
  readonly connectionEpoch: number;
}
```

### `MessageCompressor`

Transparent Zstd compression above a size threshold, with a node:zlib fallback
when the native codec is unavailable.

```typescript
class MessageCompressor {
  constructor(options?: { threshold?: number; level?: number });
  compress(data: Buffer): Promise<Buffer>;
  decompress(data: Buffer): Promise<Buffer>;
  getThreshold(): number;
}
```

## Storage

### `SqliteStorage`

The Raft log in SQLite (`better-sqlite3`): log entries with checksums, a KV map
for metadata, snapshot index tracking, WAL checkpointing, group commit for
concurrent writers, crash recovery, and compaction that keeps a truncation hook.

```typescript
class SqliteStorage {
  constructor(opts: SqliteStorageOptions);
  open(): void;
  close(): void;
  appendLogEntry(index: number, term: number, type?: number, data?: Buffer): void;
  getLogEntry(index: number): RaftLogEntry;
  getLogEntries(lo: number, hi: number): RaftLogEntry[];
  getLogsSince(fromIndex: number): RaftLogEntry[];
  truncateLogsBefore(snapshotIndex: number): Promise<void>;
  truncateLogsFrom(fromIndex: number): Promise<void>;
  truncateAllLogs(): Promise<void>;
  getLastIndex(): number;
  getMinIndex(): number;
  getTerm(index: number): number;
  countLogs(): number;
  compactLogs(snapshotIndex: number): Promise<number>;
  verifyLogChecksum(index: number): boolean;
  verifyLogChecksums(lo: number, hi: number): number[];
  setKv(key: string, value: Buffer): void;
  getKv(key: string): Buffer;
  scanKv(prefix: string): { key: string; value: Buffer }[];
  beginBatch(): void;
  endBatch(): void;
  requestFsync(): Promise<void>;
  checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): void;
  recoverFromCrash(): Promise<{ ok: boolean; message: string }>;
  vacuum(): void;
  stats(): StorageStats;
}
```

`verifyLogChecksums()` returns the indexes whose CRC does not match, which is
what turns silent disk corruption into a reportable failure.

`openSqliteHandleCount` reports how many SQLite handles this process holds. It
exists so a suite can assert that its own teardown returns the count to where it
started — every open should be matched by a close. There is deliberately no
reset: a reset would let a leak be cleared instead of fixed.

### `SqliteNodeStorage`

The `@maboke123/raft-core` `NodeStorage` implementation over one `SqliteStorage`:
it exposes `meta`, `log`, `snapshot` and `config` sub-stores that share the same
connection and the same transaction boundary.

```typescript
class SqliteNodeStorage {
  constructor(sqlite: SqliteStorage);
  readonly meta: MetaStorage;
  readonly log: LogStorage;
  readonly snapshot: SnapshotStorage;
  readonly config: ConfigStorage;
  open(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
}
```

### `SqliteMetaStorage`

Term and vote: `read()` returns `MetaData`, `write(term, votedFor)` persists the
pair atomically.

### `SqliteLogStorage`

The raft-core `LogStorage` view of the log: `append`, `getEntry`, `getEntries`,
`truncateFrom`, `compact`, `reset`.

### `SqliteSnapshotStorage`

The raft-core `SnapshotStorage` view: `readMetadata`, `save`, `load`.

### `SqliteConfigStorage`

The raft-core `ConfigStorage` view: `read()` and `write(voters, learners)` for
the membership configuration.

### `crc32`

Typed access to the CRC32 implementation the WAL integrity checks use, with an
optional partial-CRC input so a running checksum can be extended chunk by chunk.

```typescript
function crc32(input: string | Buffer, partialCrc?: number | Buffer): Buffer;
```

## Engine adapters

### `IStorageEngine` / `EngineApplyContext`

The engine-neutral apply seam: `apply(context, payload)`, `query(request)`,
`snapshot()`, `restore(snapshot)`, `sizeInBytes()`, `close()`. The context
carries the shard id and the log position the entry is being applied at.

### `MemoryStorageEngine`

The reference `IStorageEngine`: a `Map` of string keys with snapshot and restore,
used by tests and documented as the shape a real engine adapter must match.

```typescript
class MemoryStorageEngine {
  apply(context: EngineApplyContext, payload: Buffer): Promise<void>;
  query(request: Buffer): Promise<Buffer>;
  snapshot(): Promise<Buffer>;
  restore(snapshot: Buffer): Promise<void>;
  sizeInBytes(): Promise<number>;
  close(): Promise<void>;
}
```

### `EngineBackedReplica`

Turns an `IStorageEngine` into the `IShardReplica` a Raft group applies to. It
serialises applies through a tail promise, skips replays of entries it already
applied, and fails loudly when a restore leaves a gap instead of pretending the
state is consistent.

```typescript
class EngineBackedReplica {
  constructor(options: EngineBackedReplicaOptions);
  apply(entry: ApplyEntry): Promise<void>;
  applyOnce(entry: ApplyEntry): Promise<void>;
  query(request: Buffer): Promise<Buffer>;
  getAppliedIndex(): Promise<number>;
  lastAppliedIndex(): number;
  shardId(): number;
  snapshot(boundaryIndex?: number): Promise<Buffer>;
  restore(snapshot: Buffer): Promise<void>;
  dataSize(): Promise<number>;
  readonly skippedReplays: number;
  readonly forwardJumps: number;
}
```

### `encodeSnapshotEnvelope`

Wraps an engine snapshot in a positioned, checksummed envelope carrying the
shard id, the boundary index and its term, so a snapshot can be validated
against the group it is installed into.

### `decodeSnapshotEnvelope`

Parses and validates an envelope, rejecting a version mismatch, a checksum
mismatch, or a shard id that does not match the expected one.

### `SNAPSHOT_ENVELOPE_VERSION`

The current envelope version (`1`). A bump is a breaking change to the on-disk
snapshot format.

## Sharding

### `ShardManager`

Shard lifecycle over a pluggable `IShardStrategy`: assign, remove, rebalance as
nodes join and leave, and answer "which shard owns this key". Every method
returns an `OperationResult` rather than throwing.

```typescript
class ShardManager {
  initialize(strategy: IShardStrategy): Promise<OperationResult<void>>;
  getShardForKey(key: string): Promise<OperationResult<string>>;
  getShardNodes(shardId: string): Promise<OperationResult<string[]>>;
  getDistribution(): Promise<OperationResult<Record<string, string[]>>>;
  assignShard(shardId: string, nodeIds: string[]): Promise<OperationResult<void>>;
  removeShard(shardId: string): Promise<OperationResult<void>>;
  rebalance(nodeIds: string[]): Promise<OperationResult<void>>;
  addNode(nodeId: string): Promise<OperationResult<void>>;
  removeNode(nodeId: string): Promise<OperationResult<void>>;
  onShardAssigned(callback: ShardAssignedCallback): void;
  onShardRemoved(callback: ShardRemovedCallback): void;
  listShards(): Promise<OperationResult<string[]>>;
}
```

### `HashShardStrategy`

Even distribution by key hash — the strategy to pick when keys have no natural
order and the read pattern is uniform.

### `RangeShardStrategy`

Ordered ranges with explicit boundaries, so range scans stay on one shard;
`splitShard()` cuts a range at a key.

### `ConsistentHashStrategy`

A virtual-node ring: adding or removing a node moves roughly `1/N` of the keys
instead of remapping everything; `estimateRedistributionRatio()` reports how much
a membership change would move.

### `ReshardPlanner`

Describes a reshard and executes it through a migration coordinator.

A reshard has two halves: a shape — which shards, which nodes, what batch size —
and a copy. This class owns the shape; `OnlineShardMigration` owns the copy, and
every number a caller reads here was measured by it.

```typescript
class ReshardPlanner {
  constructor(migration?: IOnlineShardMigration);
  createSplitPlan(sourceShardId: number, splitKey: string): Promise<ReshardPlan>;
  createMergePlan(sourceShardIds: [number, number]): Promise<ReshardPlan>;
  createMovePlan(shardId: number, targetNodeId: string, sourceNodeId?: string): Promise<ReshardPlan>;
  executePlan(plan: ReshardPlan): Promise<string>;
  getProgress(planId: string): Promise<IMigrationProgress | null>;
  verifyConsistency(planId: string): Promise<{ consistent: boolean; mismatches: number }>;
  cancelPlan(planId: string): Promise<void>;
  rollbackPlan(planId: string): Promise<void>;
  onProgress(callback: (progress: IMigrationProgress) => void): () => void;
  listActivePlans(): Promise<ReshardPlan[]>;
  getAllPlans(): ReshardPlan[];
  dispose(): void;
}
```

### What it executes, and what it refuses

It executes **moves**. A move copies one shard, whole, from one node to another,
which is the case the coordinator can prove: it finishes by comparing what the
target holds with what the source has, and that comparison is only meaningful when
the two extents are the same.

A **split** re-keys entries (shard 7 becomes 71 and 72, and `user:5` belongs to one
of them) and a **merge** copies a shard into a target that already holds entries.
Neither has a source count to conserve against, so `executePlan` refuses them —
before a migration is registered — with a message naming the shard, the boundary or
the union involved. A refusal an operator can act on beats a percentage that
measures nothing.

`IMigrationProgress` is the coordinator's status in the plan's vocabulary:
`dual-writing` is the initial sync of a plan that asked for dual writes, `migrating`
is the catch-up, `verifying` is the cutover, and `completed` is only reported after
the conservation check passed. `estimatedSizeBytes` seeds the first report — the
only number available before the source is asked — and is replaced by the
measurement from the second one on.

```typescript
const planner = new ReshardPlanner(migration);
const plan = await planner.createMovePlan(7, 'node-b', 'node-a');
const planId = await planner.executePlan(plan);

await planner.getProgress(planId); // preparing -> migrating -> verifying -> completed
await planner.verifyConsistency(planId); // { consistent: true, mismatches: 0 }
```

### `OnlineShardMigration`

The hot-migration coordinator: copies the shard while it serves traffic,
suspends writes for the cutover window, and completes only after the target
reports as many entries as the source holds.

It knows nothing about the database. Reads arrive through `IShardMigrationSource`
and writes through `IShardMigrationSink` — two interfaces, five methods, that any
engine can implement. The unit of enumeration is a **version**, not an offset: a
shard that gains entries during the copy shifts every offset after the insertion
point, so a paged scan would skip or repeat, while a version watermark is
unaffected.

```typescript
class OnlineShardMigration {
  constructor(source: IShardMigrationSource, sink: IShardMigrationSink);
  startMigration(config: IMigrationConfig): Promise<{ migrationId: string }>;
  getStatus(migrationId: string): Promise<IMigrationStatus>;
  cutover(migrationId: string): Promise<void>;
  rollback(migrationId: string): Promise<void>;
  cancel(migrationId: string): Promise<void>;
  waitForCompletion(migrationId: string): Promise<IMigrationStatus>;
  onProgress(listener: (event: MigrationProgressEvent) => void): () => void;
  areWritesSuspended(migrationId: string): boolean;
  getActiveMigrationCount(): number;
  listMigrations(): string[];
}
```

`IMigrationStatus` reports what was measured, not what was attempted:
`entriesCopied` over `entriesTotal` gives `progress`, `bytesCopied` and
`remainingBytes` come from the source's own byte counts, and `caughtUpVersion` is
the watermark the coordinator reached.

Prefer `waitForCompletion()` to polling `getStatus()`: the migration reports its
own completion, and a fixed pause is a guess about how long a copy takes.
`onProgress()` is the same signal for a caller that wants to publish progress while
it runs: one report per applied batch and one per phase change, carrying the status
`getStatus()` would return.

```typescript
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
if (status.phase === 'failed') throw new Error(status.error);
```

Three outcomes are distinct on purpose:

| Outcome                   | `phase`     | Meaning                                                                         |
| ------------------------- | ----------- | ------------------------------------------------------------------------------- |
| Copied and verified       | `completed` | The target holds as many entries as the source, checked after the final pass    |
| A write was lost          | `failed`    | The message names both counts: `the target holds 4 of the source's 5`           |
| The source never quiesced | `failed`    | `did not quiesce within 5000 ms` — writes above the watermark outran the budget |

A manual `cutover()` takes the same final pass and the same check, so it cannot
report a migration the automatic path would have refused.

## High availability

### `HAFailoverDetector`

Detects a leaderless or unresponsive shard from commit-index progress and missed
heartbeats, with a startup grace window and an RTT-adaptive timeout so a slow
network does not read as a failure.

```typescript
class HAFailoverDetector {
  constructor(
    config: Partial<HAFailoverDetectorConfig>,
    clusterTopology: IClusterTopology,
    consensusLayer: IConsensusLayer,
  );
  registerShard(shardId: string): void;
  unregisterShard(shardId: string): void;
  start(): void;
  stop(): void;
  onFailover(handler: (event: FailoverEvent) => void): void;
  checkNow(): Promise<void>;
  inStartupGrace(): boolean;
  getAdaptiveTimeout(): number;
  updateRTT(ms: number): void;
  getRegisteredShardCount(): number;
}
```

### `HAFailoverCoordinator`

The orchestrator a detector event goes to: verify the failure is real, decide
whether this node should take over, trigger the election, reconfigure Raft, and
re-point clients — reporting each step.

```typescript
class HAFailoverCoordinator {
  constructor(
    consensusLayer,
    clusterTopology,
    consistencyVerifier?,
    clientManager?,
    clockCompensator?,
    fencingManager?,
    detectorConfig?,
  );
  initialize(): void;
  handleFailover(event: FailoverEvent): Promise<boolean>;
  verifyFailure(event: FailoverEvent): Promise<boolean>;
  shouldTakeOver(event: FailoverEvent, localNodeId: string): Promise<boolean>;
  triggerElection(event: FailoverEvent, localNodeId: string): Promise<boolean>;
  handleRaftReconfiguration(event: FailoverEvent): Promise<void>;
  transferLeadership(
    shardId: string,
    targetNodeId: string,
    matchIndex?: number,
    lastLogIndex?: number,
  ): Promise<boolean>;
  getStatus(): HAStatus;
  markNodeRecovered(nodeId: string): void;
  shutdown(): void;
}
```

### `HAClientManager`

Client bookkeeping across a failover: which client is attached to which shard,
and a leader-change notification so drivers reconnect to the new leader.

```typescript
class HAClientManager {
  constructor(config?: Partial<HAClientConfig>);
  registerClient(clientId: string, shardId: string): void;
  unregisterClient(clientId: string): void;
  onLeaderChange(shardId: string, newLeaderId: string, newLeaderAddr: string): void;
  getClientStats(): Record<string, number>;
  getTotalClientCount(): number;
  getClientIdsForShard(shardId: string): string[];
  clearAll(): void;
}
```

### `HAConsistencyVerifier`

Post-failover verification: compare the new leader's commit index and state with
what the cluster agreed on, so a failover that lost entries is reported before
clients observe it.

```typescript
class HAConsistencyVerifier {
  constructor(consensusLayer?: IConsensusLayer);
  verifyConsistency(
    shardId: string,
    consensusLayer: IConsensusLayer,
  ): Promise<{ consistent: boolean; details: string }>;
  verifyNewLeaderConsistency(
    newLeaderId: string,
    shardId: string,
    consensusLayer?: IConsensusLayer,
    preFailoverCommitIndex?: number,
  ): Promise<boolean>;
}
```

### `ClockCompensator`

Estimates per-peer clock offset across data centers, exposes a safety margin,
and converts timestamps between local and peer time — the input an HLC needs
when the two DCs are not NTP-aligned.

```typescript
class ClockCompensator {
  constructor(config?: Partial<ClockCompensatorConfig>);
  estimateOffset(remoteTimestamp: number, localRecvMs?: number): number;
  estimateOffsetForPeer(peerNodeId: string, remoteTimestamp: number, localRecvMs?: number): number;
  getPeerOffset(peerNodeId: string): number;
  getMaxAbsOffset(): number;
  getSafetyMargin(): number;
  toLocalTime(peerNodeId: string, remoteTimestamp: number): number;
  toRemoteTime(peerNodeId: string, localTimestamp: number): number;
  synchronized(): boolean;
  recordNtpSync(ntpTimeMs: number): void;
  getPeerOffsetsSummary(): Record<string, number>;
  reset(): void;
}
```

## Snapshots, streams and PITR

### `SnapshotManager`

Snapshot lifecycle for a group: create with metadata, verify by checksum, list,
find the nearest snapshot to an index, prune by retention, and compact.

```typescript
class SnapshotManager {
  constructor(config?: Partial<SnapshotManagerConfig>);
  init(): Promise<void>;
  shutdown(): Promise<void>;
  createSnapshot(data: Buffer, meta: SnapshotMeta): Promise<SnapshotDescriptor>;
  deleteSnapshot(snapshotId: string): Promise<boolean>;
  getSnapshot(snapshotId: string): Promise<SnapshotDescriptor>;
  listSnapshots(groupId?: string): Promise<SnapshotDescriptor[]>;
  verifySnapshot(snapshotId: string): Promise<VerificationResult>;
  verifyAll(): Promise<Map<string, VerificationResult>>;
  findNearest(index: number, groupId?: string): Promise<SnapshotDescriptor>;
  prune(): Promise<string[]>;
  compact(): Promise<SnapshotDescriptor>;
  totalStorageBytes(): Promise<number>;
  onCreated(callback: (descriptor: SnapshotDescriptor) => void): () => void;
  onPruned(callback: (ids: string[]) => void): () => void;
}
```

### `WalStreamer`

Streams committed log entries to subscribers with per-subscriber position,
filtering, replay from an index, acknowledgement and lag reporting — the
primitive a CDC feed or a read-replica tail sits on.

```typescript
class WalStreamer {
  init(storage: IWalStorage, config?: Partial<WalStreamConfig>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(subscriberId: string, handler: StreamHandler, filter?: StreamFilter): Promise<StreamSubscription>;
  unsubscribe(subscriptionId: string): Promise<void>;
  replay(fromIndex: number, toIndex: number, handler: StreamHandler, filter?: StreamFilter): Promise<number>;
  ack(ack: StreamAck): Promise<void>;
  getPosition(): Promise<{ sequence: number; entryIndex: number }>;
  getLag(subscriberId: string): Promise<number>;
  catchUp(subscriberId: string): Promise<number>;
  getSubscriptions(): Promise<StreamSubscription[]>;
}
```

### `PITRManager`

Point-in-time recovery: checkpoint the snapshot, keep the WAL after it, and
restore to a timestamp by replaying entries onto the nearest checkpoint. RPO is
reported rather than assumed.

```typescript
class PITRManager {
  constructor(config?: Partial<PITRConfig>);
  enable(shardId: string): void;
  disable(shardId: string): void;
  recordWAL(entry: WALEntry): void;
  recordWALBatch(entries: WALEntry[]): void;
  createCheckpoint(shardId: string, snapshotIndex: number, snapshotTerm: number, snapshotData: Buffer): PITRCheckpoint;
  restore(shardId: string, targetTimestamp: number): Promise<PITRRestoreResult>;
  getCheckpoints(shardId: string): PITRCheckpoint[];
  getRPO(shardId: string): number;
  enforceWALRetention(shardId: string): void;
  enforceCheckpointRetention(shardId: string): void;
  reset(): void;
}
```

### `MerkleTree`

The anti-entropy digest used to find divergent key ranges without shipping the
data: `build`/`add` the entries, compare roots, and `difference()` returns the
ranges that differ.

```typescript
class MerkleTree {
  build(entries: Entry[]): void;
  add(entries: Entry[]): void;
  rootHash(): string;
  computeRoot(): string;
  difference(other: MerkleTree): string[];
}
```

## Observability

### `HealthProbe`

A registry of named probes aggregated into the three Kubernetes-shaped answers:
`liveness()` (should this process be restarted), `readiness()` (should it
receive traffic), `startup()` (has it finished initialising).

```typescript
class HealthProbe {
  register(name: string, probe: () => ProbeResult): void;
  markStartupComplete(): void;
  recordFatalError(): void;
  liveness(): ProbeResult;
  readiness(): ProbeResult;
  startup(): ProbeResult;
  fullStatus(): HealthStatus;
}
```

### `LoggingAdapter`

A structured logger with bound context and per-component children, wrapping a
pino-compatible base logger so the host application keeps one log pipeline.

```typescript
class LoggingAdapter {
  constructor(component: string, bindings?: Record<string, unknown>, base?: Logger);
  child(bindings: Record<string, unknown>): ILogger;
  trace(msg: string): void;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  fatal(msg: string): void;
  raw(): Logger;
}
```

### `traceContext`

Async-local trace ids: `runWith` / `runWithAsync` bind an id to a call tree and
`getTraceId()` reads it, so one client request is one trace across every shard
it touches.

```typescript
const traceContext: {
  getTraceId(): string;
  runWith<T>(traceId: string, fn: () => T): T;
  runWithAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T>;
};
```

### `RaftMetricsCollector`

In-process counters and gauges for a group — leader changes, proposals by
outcome, commit latency, term, log size, peer count — with a Prometheus text
exposition.

```typescript
class RaftMetricsCollector {
  recordLeaderChange(): void;
  recordProposal(success: boolean): void;
  recordCommitLatency(ms: number): void;
  setTerm(term: number): void;
  setLogSizeBytes(bytes: number): void;
  setPeerCount(count: number): void;
  snapshot(): RaftMetricsSnapshot;
  toPrometheus(prefix?: string): string;
  reset(): void;
}
```

## Errors and enums

### `SqlVecError`

The error type thrown across the package boundary. It carries a stable `code`
from `SqlVecErrorCode` and preserves `cause`, so a caller can distinguish a
retryable failure (port in use, `ENOENT`) from a fatal one without matching on
message text.

```typescript
class SqlVecError extends Error {
  constructor(message: string, code?: SqlVecErrorCode, options?: { cause?: unknown });
  readonly code: SqlVecErrorCode;
}
```

### `ConsensusRole`

The three Raft roles: `ConsensusRole.Follower`, `ConsensusRole.Candidate`,
`ConsensusRole.Leader`.

## Types

| Type                                                                                    | What it describes                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RaftConfig`                                                                            | Node id, peers, election and heartbeat ticks, storage, transport, snapshot interval, pre-vote and check-quorum flags                                                                                      |
| `Membership` / `MembershipChange` / `MembershipChangeResult`                            | Voters, learners, the change being proposed, and whether it committed                                                                                                                                     |
| `QuorumHealth`                                                                          | Window size, majority, whether a quorum was heard inside it, and which peers were not                                                                                                                     |
| `CommittedEntry`                                                                        | `{ index, term, data }` — a log position and its payload                                                                                                                                                  |
| `ApplyEntry`                                                                            | The entry shape a replica applies, including the idempotency `msgId`                                                                                                                                      |
| `RaftHealthStatus`                                                                      | Per-shard leader, term, commit index, applied index, last log index and `applyLag`                                                                                                                        |
| `RaftPeerStatus`                                                                        | Per-shard peer list, connected count and learner count                                                                                                                                                    |
| `RaftGroupQuorumResult`                                                                 | `{ quorumMet, required, actual, total, type }`                                                                                                                                                            |
| `LearnerInfo`                                                                           | A learner's matched index and catch-up state                                                                                                                                                              |
| `SnapshotMeta` / `SnapshotDescriptor` / `SnapshotEnvelope`                              | Snapshot position, on-disk record, and the checksummed wire form                                                                                                                                          |
| `ShardSnapshotMeta`                                                                     | What a node recorded about a snapshot it took: shard, node, log position and timestamp                                                                                                                    |
| `RaftSnapshotMeta`                                                                      | raft-core's log-level snapshot record: `snapshotIndex`, `snapshotTerm` and the `hardState` beside it                                                                                                      |
| `TransitionPhase` / `TransitionResult` / `TransitionOptions`                            | Joint-consensus phase, outcome, and retry policy                                                                                                                                                          |
| `FencingConfig` / `FencingStatus` / `FenceState`                                        | Lease length, escalation action, and the state machine                                                                                                                                                    |
| `SessionConfig` / `SessionEntry` / `ISessionManager`                                    | Session TTL, the entry, and the interface                                                                                                                                                                 |
| `RaftEvent` and its variants                                                            | `LeaderElectedEvent`, `LeaderLostEvent`, `StepDownEvent`, `ProposalCommittedEvent`, `ProposalAppliedEvent`, `SnapshotCreatedEvent`, `SnapshotRestoredEvent`, `RoleChangedEvent`, `MembershipChangedEvent` |
| `IConsensusLayer` / `IClusterTopology` / `IOutboxWriter` / `IShardReplica`              | The seams the HA and consensus layers are built on                                                                                                                                                        |
| `IShardStrategy` / `IShardManager` / `IReshardPlanner` / `IOnlineShardMigration`        | The sharding seams                                                                                                                                                                                        |
| `IShardMigrationSource` / `IShardMigrationSink` / `ShardScanEntry` / `ShardVolumeStats` | The two ports a hot migration reads and writes through                                                                                                                                                    |
| `RaftMessage` / `RaftEntry`                                                             | The wire shape a transport sends: numeric `msgType`, decimal-string ids, and the entries it carries                                                                                                       |
| `FramesDroppedEvent`                                                                    | Why the transport discarded frames: `buffer-full` or `flush-failed`, with the count and the head of the oldest                                                                                            |
| `RaftConsensusPhase`                                                                    | The phase a joint-consensus transition is in: `stable`, `joint`, `transitional`                                                                                                                           |
| `SqlVecErrorCode`                                                                       | The stable codes `SqlVecError` carries across the package boundary                                                                                                                                        |
| `OperationResult`                                                                       | `{ success, error? }` — the sharding layer's non-throwing result                                                                                                                                          |

## Where the exhaustive list lives

This page is the map: every exported value, what it is for, and the methods a
caller uses. The declaration that wins is the one in `src/` — every signature
above is a copy of it, and `pnpm check:docs-api` is what keeps the copy honest.
