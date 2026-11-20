/**
 * A member set held in memory — the reference `IClusterTopology`.
 *
 * It exists for two reasons. The first is that every assembler in this package
 * needs a member set to be tested against, and a suite that stubs `members()` to
 * return an array tests its own stub. The second is that a deployment with a
 * fixed member list (a test cluster, a three-node appliance, a migration being
 * rehearsed) really does have this topology, and it should not have to write one.
 *
 * The rules are the ones a real consensus layer enforces, and they are enforced
 * here rather than left to the caller: ids are unique, removing an unknown member
 * is an error rather than a no-op, and a role change that would leave two leaders
 * is refused. A permissive fake is a fake that hides the bug it was meant to find.
 *
 * @module @agentix-e/db-operations-cluster/membership
 */

import type { ClusterMember, ClusterRole, IClusterTopology } from '../interfaces/index.js';
import { ClusterMembershipError } from './errors.js';

export interface InMemoryClusterTopologyOptions {
  /** Initial members, in the order they should be considered. */
  members: readonly ClusterMember[];
}

export class InMemoryClusterTopology implements IClusterTopology {
  private readonly state: ClusterMember[];
  /** Set when `members()` has been called more than once, for the drift tests. */
  private reads = 0;

  constructor(options: InMemoryClusterTopologyOptions) {
    this.state = options.members.map((member) => ({ ...member }));
    const leaders = this.state.filter((member) => member.role === 'leader').length;
    if (leaders > 1) {
      throw new ClusterMembershipError(
        'duplicate-member',
        `${leaders} members claim to be leader; a group has at most one`,
      );
    }
    const ids = new Set<string>();
    for (const member of this.state) {
      if (ids.has(member.id)) {
        throw new ClusterMembershipError('duplicate-member', `member ${member.id} listed twice`);
      }
      ids.add(member.id);
    }
  }

  /** How many times the member set has been read. Lets a test assert the count. */
  get readCount(): number {
    return this.reads;
  }

  async members(): Promise<readonly ClusterMember[]> {
    this.reads += 1;
    // A copy, because a caller that mutates the array it was handed would be
    // changing the topology without going through a membership change — and every
    // quorum calculation downstream would then be about a cluster that never
    // existed.
    return this.state.map((member) => ({ ...member }));
  }

  async addNode(id: string, options?: { zone?: string }): Promise<void> {
    if (this.state.some((member) => member.id === id)) {
      throw new ClusterMembershipError('duplicate-member', `member ${id} already exists`);
    }
    if (id.trim() === '') {
      throw new ClusterMembershipError('unsupported', 'a member needs a non-empty id');
    }
    const member: ClusterMember = { id, role: 'follower' };
    if (options?.zone !== undefined) member.zone = options.zone;
    this.state.push(member);
  }

  async removeNode(id: string): Promise<void> {
    const index = this.state.findIndex((member) => member.id === id);
    if (index < 0) {
      throw new ClusterMembershipError('unknown-member', `member ${id} does not exist`);
    }
    this.state.splice(index, 1);
  }

  /**
   * Change a member's role.
   *
   * Not part of `IClusterTopology`: a deployment's consensus layer changes roles
   * through elections, not through a method call. The reference topology needs it
   * so that a test can express "the leader moved" without rebuilding the object,
   * which is what a leader-aware planner has to survive.
   */
  setRole(id: string, role: ClusterRole): void {
    const member = this.state.find((candidate) => candidate.id === id);
    if (!member) {
      throw new ClusterMembershipError('unknown-member', `member ${id} does not exist`);
    }
    if (role === 'leader' && this.state.some((other) => other.id !== id && other.role === 'leader')) {
      throw new ClusterMembershipError('duplicate-member', 'another member is already leader; step it down first');
    }
    member.role = role;
  }
}
