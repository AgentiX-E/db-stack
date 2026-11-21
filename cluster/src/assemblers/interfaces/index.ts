/**
 * The vocabulary a cluster-level assembler needs, and nothing else.
 *
 * These types describe what the cluster *is* — who is a member, who is a voter,
 * who is leading, which zone a node sits in — because every decision in this
 * package is a decision about a set of nodes rather than about one. They are not
 * a client: a member list is read through `IMemberSet`, which a deployment
 * implements over whatever consensus layer it actually runs.
 *
 * @module @agentix-e/db-cluster/interfaces
 */

// ── Membership ───────────────────────────────────────────────

/**
 * A member's part in a consensus group.
 *
 * `learner` is a full member that does not vote. It matters to every safety
 * calculation in this package: it counts towards "how many nodes run this
 * version" and not towards "how many nodes must be up". A planner that counted
 * learners as voters would refuse upgrades it could afford, and a planner that
 * ignored them would leave them on the old version.
 */
export type ClusterRole = 'leader' | 'follower' | 'learner';

export interface ClusterMember {
  /** Transport-level identifier, unique within the group. */
  id: string;
  role: ClusterRole;
  /** Failure domain (rack, zone, host). Absent means "unknown", never "none". */
  zone?: string;
}

/**
 * The live member set, as the consensus layer sees it.
 *
 * Deliberately three methods. Anything richer — replication lag, per-node health,
 * upgrade progress — belongs to the port the caller already has for that
 * question; a topology that grew a `waitForHealthy()` would make every assembler
 * here depend on a health system it does not use.
 *
 * Not named `IClusterTopology`. That name is already published by
 * `@agentix-e/db-cluster` for the *opposite* view of the same word: one node
 * looking out at its peers (`getNodeId`, `getPeerIds`, `isPeerAlive`,
 * `onTopologyChange`). This interface is the set looking in — "who is in the
 * group, and change it". Two interfaces under one name would be tolerable while
 * they live in two packages that never import each other; they become a compile
 * error the moment the multi-node assemblers move next to the consensus engine,
 * which is where they are headed.
 */
export interface IMemberSet {
  /** Current members. A snapshot: callers must not assume it stays true. */
  members(): Promise<readonly ClusterMember[]>;
  /** Add a member. Rejects if the consensus layer refuses the change. */
  addNode(id: string, options?: { zone?: string }): Promise<void>;
  /** Remove a member. Rejects if the consensus layer refuses the change. */
  removeNode(id: string): Promise<void>;
}

// ── Shared result vocabulary ─────────────────────────────────

/**
 * Something an assembler decided not to do, and why.
 *
 * Every list of these in this package is a first-class part of a result rather
 * than a log line: "the plan had four nodes and the topology has three" is the
 * difference between an operator checking the wrong cluster and a batch that
 * quietly upgraded three of four.
 */
export interface SkippedItem {
  id: string;
  reason: string;
}
