/**
 * Majority arithmetic, in one place.
 *
 * Every "may I take this node down?" question in this package reduces to the same
 * two numbers, and they were worth writing once because the tempting shortcuts
 * are wrong in ways that only show up under load:
 *
 *   - **`n / 2` is not the majority.** Three voters tolerate one failure, not
 *     one-and-a-half; `Math.ceil(n/2)` says two out of three may go, which is a
 *     split brain with extra steps. `Math.floor(n/2) + 1` is the quorum.
 *   - **learners are not voters.** A five-member group with two learners has three
 *     voters and tolerates one failure, not two.
 *   - **the target of a removal still counts until the change is committed.** A
 *     plan that reasons about the membership it is about to create will happily
 *     walk a group from three voters to two while the third is still voting; the
 *     arithmetic below is about the configuration that exists *now*.
 *
 * @module @agentix-e/db-cluster/membership
 */

import type { ClusterMember } from '../interfaces/index.js';

/** Whether a member's vote counts towards quorum. */
export function isVoter(member: ClusterMember): boolean {
  return member.role !== 'learner';
}

/** The voters in a member set, in the order given. */
export function votersOf(members: readonly ClusterMember[]): ClusterMember[] {
  return members.filter(isVoter);
}

/**
 * Votes needed to commit, for a group of `size` voters.
 *
 * Zero voters have no quorum — not "a quorum of zero". A function that answered
 * `1` here would let an empty group report quorum-held.
 */
export function quorumOf(size: number): number {
  if (size <= 0) return 0;
  return Math.floor(size / 2) + 1;
}

/** How many voters may be down at once without losing quorum. */
export function tolerableFailures(size: number): number {
  // `quorumOf` answers 0 for an empty group, so the subtraction is already 0 at
  // the boundary; the floor is here for a negative size, where "minus nothing"
  // would be a negative failure budget.
  return Math.max(0, size - quorumOf(size));
}

/** The member currently leading, or `null` when the group has no leader. */
export function leaderOf(members: readonly ClusterMember[]): ClusterMember | null {
  return members.find((member) => member.role === 'leader') ?? null;
}

/**
 * Whether `after` still holds a majority of the voters `before` had.
 *
 * The comparison is against the *previous* configuration on purpose: a removal
 * that keeps a majority of what is left is not the question, because the
 * previous configuration is what the other replicas still believe in until the
 * change is committed.
 *
 * A `before` with no voters is satisfied by any `after`, and that falls out of
 * the arithmetic rather than out of a guard: `quorumOf(0)` is `0`, and `0 >= 0`.
 * The guard that used to sit here returned `true` on the same input, which made
 * it a branch whose removal changed nothing.
 */
export function holdsQuorumOf(before: readonly ClusterMember[], after: readonly ClusterMember[]): boolean {
  return votersOf(after).length >= quorumOf(votersOf(before).length);
}
