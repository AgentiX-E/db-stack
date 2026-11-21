/**
 * The one error a membership operation can fail with, and why it is typed.
 *
 * A scale-down executor has to tell two failures apart: *the node is already
 * gone* (someone else removed it; the plan is stale, and continuing is correct)
 * and *the consensus layer refused* (the removal would lose quorum, or the node
 * is not a member of the group being changed; continuing is not correct). The
 * alternative — matching on a message — is how a `catch` block turns "already
 * removed" into a retry storm.
 *
 * @module @agentix-e/db-cluster/membership
 */

/** How a membership change failed. */
export type MembershipFailure = 'unknown-member' | 'duplicate-member' | 'unsupported';

export class ClusterMembershipError extends Error {
  readonly code: MembershipFailure;

  constructor(code: MembershipFailure, message: string) {
    super(message);
    this.name = 'ClusterMembershipError';
    this.code = code;
  }
}
