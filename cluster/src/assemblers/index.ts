/**
 * @agentix-e/db-cluster — the multi-node half of the operations layer.
 *
 * Everything in `@agentix-e/db-node` answers a question about one
 * process. Everything here answers a question about a *set* of them, which is why
 * it needs a member list, a leader and a majority rule and the node package does
 * not:
 *
 *   - `ClusterScalingExecutor` — applies a scaler's `ScaleAction` to the members
 *     that exist, instead of to the count the scaler remembers.
 *   - `ClusterRolloutPlanner` — sequences a rolling upgrade so that no batch costs
 *     quorum and the leader goes last.
 *   - `RaftFaultTranslator` — turns an abstract fault into the transport calls
 *     that realise it, symmetrically, and refuses the ones a transport cannot
 *     express.
 *
 * All three are pure decisions over a snapshot; the only I/O is what the caller's
 * ports do. That is deliberate: a decision that has to be replayed after an
 * incident cannot depend on the cluster it is reasoning about still looking the
 * way it did when the decision was made.
 *
 * @module @agentix-e/db-cluster
 */

export type { ClusterRole, ClusterMember, IMemberSet, SkippedItem } from './interfaces/index.js';

export { isVoter, votersOf, quorumOf, tolerableFailures, leaderOf, holdsQuorumOf } from './membership/quorum.js';

export { ClusterMembershipError } from './membership/errors.js';
export type { MembershipFailure } from './membership/errors.js';

export { InMemoryClusterTopology } from './membership/InMemoryClusterTopology.js';
export type { InMemoryClusterTopologyOptions } from './membership/InMemoryClusterTopology.js';

export { ClusterScalingExecutor } from './scaling/ClusterScalingExecutor.js';
export type { ClusterScalingOptions, ScaleOutcome, ClampReason } from './scaling/ClusterScalingExecutor.js';

export { ClusterRolloutPlanner } from './rollout/ClusterRolloutPlanner.js';
export type { RolloutPlanningInput, RolloutBatch, ClusterRolloutPlan } from './rollout/ClusterRolloutPlanner.js';

export { RaftFaultTranslator, inverseOf, applyInstructions } from './chaos/RaftFaultTranslator.js';
export type { TransportOperation, TransportInstruction, FaultTranslation } from './chaos/RaftFaultTranslator.js';
