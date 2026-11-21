# API reference — `@agentix-e/db-operations-cluster`

Every export of the package, with the behaviour that a signature cannot state.
Names in backticks are the names the package exports.

## `ClusterMember`

```ts
interface ClusterMember {
  id: string;
  role: 'leader' | 'follower' | 'learner';
  zone?: string;
}
```

`role: 'learner'` is a full member that does not vote. It counts towards "which
nodes run this version" and not towards "how many must be up"; every safety
calculation in this package distinguishes the two. `zone` absent means _unknown_,
never _none_ — a planner that treats missing zones as one shared zone puts a whole
batch in it.

## `IMemberSet`

```ts
interface IMemberSet {
  members(): Promise<readonly ClusterMember[]>;
  addNode(id: string, options?: { zone?: string }): Promise<void>;
  removeNode(id: string): Promise<void>;
}
```

Three methods, deliberately. Replication lag, per-node health and upgrade progress
belong to the port a caller already has for that question; a topology that grew a
`waitForHealthy()` would make every assembler here depend on a health system it
does not use.

`members()` returns a snapshot. It is not a subscription, and nothing in this
package assumes the answer is still true when it acts on it — which is why the
scaling executor re-reads the member set every time it applies a decision.

## `SkippedItem`

```ts
interface SkippedItem {
  id: string;
  reason: string;
}
```

A change that was not made. Returned in results rather than logged, because
"the plan named four nodes and the group has three" is the difference between an
operator checking the wrong cluster and a batch that quietly upgraded three of
four.

## `quorumOf` / `tolerableFailures`

```ts
quorumOf(size: number): number;        // floor(size / 2) + 1, and 0 for an empty group
tolerableFailures(size: number): number; // size - quorumOf(size)
```

`quorumOf` is the strict majority, not `ceil(size / 2)`: three voters tolerate one
failure, not one and a half. An empty group has no quorum — answering `1` there
would let an empty group report quorum held.

## `votersOf` / `isVoter` / `leaderOf`

```ts
votersOf(members: readonly ClusterMember[]): ClusterMember[];
isVoter(member: ClusterMember): boolean;      // role !== 'learner'
leaderOf(members: readonly ClusterMember[]): ClusterMember | null;
```

`leaderOf` answers `null` when the group has no leader. That is a state a
`leadership-flap` has to be able to see, and a function that threw would turn "no
leader right now" into an exception in a chaos run.

## `holdsQuorumOf`

```ts
holdsQuorumOf(before: readonly ClusterMember[], after: readonly ClusterMember[]): boolean
```

Whether `after` still holds a majority of the voters `before` had. The comparison
is against the _previous_ configuration: a removal that keeps a majority of what is
left is not the question, because the previous configuration is what the other
replicas still believe in until the change commits. An empty `before` holds quorum
vacuously — there is nothing to lose a majority of.

## `ClusterMembershipError`

```ts
class ClusterMembershipError extends Error {
  readonly code: 'unknown-member' | 'duplicate-member' | 'unsupported';
}
```

Typed so a caller can tell "already gone" (a stale plan; the outcome the caller
wanted is the one that exists) from "refused" (the consensus layer said no; stop).
Matching on the message is how a `catch` block turns the first into a retry storm.

## `InMemoryClusterTopology`

```ts
class InMemoryClusterTopology implements IMemberSet {
  constructor(options: { members: readonly ClusterMember[] });
  readonly readCount: number;
  setRole(id: string, role: ClusterRole): void;
}
```

The reference topology: a fixed member set with the rules a consensus layer
enforces. Duplicate ids, two leaders and a whitespace-only id are refused at
construction or on `addNode`; removing an unknown member is an error rather than a
no-op; `members()` hands out copies, so a caller cannot change the topology without
a membership change.

`setRole` is not on the interface — a real deployment changes roles through
elections — and exists so a test can express "the leader moved" without rebuilding
the object. `readCount` reports how many times the member set has been read, which
is how a case asserts that an executor re-read instead of caching.

## `ClusterScalingExecutor`

```ts
class ClusterScalingExecutor {
  constructor(options: { topology: IMemberSet; minNodes: number; maxNodes: number; idPrefix?: string });
  apply(action: ScaleAction | null): Promise<ScaleOutcome>;
}
```

Applies a scaler's decision to the members that exist. The delta is computed from
`action.targetCount` against the observed member set, never from `action.amount`:
the two drift the moment anything else changes the membership.

- **Scale-up** mints ids that the member set does not use, clamps at `maxNodes` and
  grows to `minNodes` when the scaler asks for less. A target _below_ the current
  size is treated as a stale decision and produces no change — a scale-up that
  removed nodes would be a scale-down that skipped the quorum checks.
- **Scale-down** never removes the leader, removes learners before followers and
  newest ids first, and stops at `max(minNodes, quorumOf(voters))`. The quorum floor
  is not a preference: below it the group stops committing, and a cluster that
  cannot commit is not a smaller cluster.
- A join the topology refuses is recorded in `skipped` and the rest continue; a
  removal refused for any reason other than "already absent" stops the loop,
  because the layer is rejecting changes it had been accepting.
- A node that is already gone counts as one the group has lost, so the executor
  does not remove a second node to reach a target the first removal already
  reached.

`ScaleOutcome` reports `observedCount`, `targetCount`, `applied`, `skipped`,
`clampedBy` (`'policy-min' | 'policy-max' | 'quorum-floor' | 'unlisted-nodes'`) and
a `note` that states what happened in one sentence.

## `ClusterRolloutPlanner`

```ts
class ClusterRolloutPlanner {
  plan(input: {
    nodes: readonly string[];
    members: readonly ClusterMember[];
    batchStrategy: BatchStrategy;
    batchSize?: number;
  }): ClusterRolloutPlan;
}
```

Turns the upgrade plan's node list into a sequence:

1. **Quorum first.** A batch never takes down more voters than the group can lose.
   When the group cannot afford even one node down, the plan reports
   `feasible: false` — the batches are still returned so an operator can see the
   shape of the job, but running one is a decision to stop the cluster.
2. **Followers before the leader.** Learners first (they do not vote, and a learner
   left behind cannot be promoted), then followers, then the leader.
3. **Zones spread.** Followers are interleaved across zones and a batch is drawn
   from as many distinct zones as the candidate set allows.

`percentage` reads `batchSize` as a percentage of the remaining nodes and defaults
to 20; `fixed_size` defaults to one; `all_at_once` is capped by the quorum budget
like every other strategy. A batch size is never zero: the loop that emits batches
advances by it, so a size below one is floored at one rather than becoming a hang.
A strategy string this version does not know is an error — answering one node at a
time would be a plausible plan for a strategy that may have meant something else.
Nodes in `nodes` that the topology does not have are returned in `unplanned` rather
than dropped.

## `RaftFaultTranslator`

```ts
class RaftFaultTranslator {
  translate(fault: ChaosFaultV2, members: readonly ClusterMember[]): FaultTranslation;
  revert(fault: ChaosFaultV2, members: readonly ClusterMember[]): FaultTranslation;
}
```

Turns a `ChaosFaultV2` into `TransportInstruction`s — `{ transportId, operation }`
pairs where the operation is `isolate`, `heal`, `setMessageLoss`, `setLatency`,
`stop` or `start`.

- **Partitions are symmetric.** `isolate` called on `n1` stops `n1` sending to its
  peers; it does not stop them sending to `n1`. Every pair is emitted in both
  directions, or the "partition" is a half-open connection that still carries
  traffic. `config.groups` names the two sides explicitly; `config.direction:
'one-way'` asks for the asymmetric version on purpose.
- **`leadership-flap` names no node.** The leader is read from the member set at
  translation time; with no leader the fault is refused rather than silently
  injected as a no-op.
- **Faults a transport cannot express are refused by name.** `clock-skew`,
  `resource-pressure` and `cascading-failure` have no method on `IChaosTransport`,
  and `latency-injection` with `jitterMs` is refused for the same reason: applying
  the base delay and dropping the jitter would run a different scenario than the one
  written down.
- **Unknown targets are refused.** A fault aimed at a node the group does not have
  is a typo that would otherwise report "injected" and change nothing.

`revert` is `translate` with every operation inverted.

## `inverseOf`

```ts
inverseOf(operation: TransportOperation): TransportOperation
```

Isolate ↔ heal and stop ↔ start are involutions; the two knobs invert to `0`, so
undoing twice is undoing once. Idempotent rather than symmetric — which is what a
revert has to be to be safe to run twice.

## `applyInstructions`

```ts
applyInstructions(
  transports: ReadonlyMap<string, IChaosTransport>,
  instructions: readonly TransportInstruction[],
): Promise<ChaosTransportStats[]>
```

Calls the transports and returns what they report. `stop` and `start` are awaited,
so a scenario cannot race the crash it just injected. An instruction naming a
transport the caller did not supply is an error, not a skip: a scenario that
silently ignores the one node it was supposed to break passes for the wrong reason.
