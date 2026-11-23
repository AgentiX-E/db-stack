/**
 * A rolling upgrade plan knows *which* nodes; the cluster knows *in what order*.
 *
 * `RollingUpgradePlan.nodes` is a list, and `RollingUpgradeOrchestrator` batches
 * it faithfully — in the order the operator typed. On a real group that order is
 * the whole risk: upgrade the leader first and the group elects a new leader
 * mid-batch; upgrade three replicas of the same zone in one batch and the
 * surviving majority is a majority of one rack. Neither is visible in a plan that
 * is just a list of names, which is why the split is where it is: the node
 * package owns the plan's *shape* and this planner owns its *sequence*.
 *
 * Three rules, in priority order:
 *
 *   1. **Quorum first.** A batch may never take down more voters than the group
 *      can lose. When the group cannot afford even one node down, the plan says
 *      so (`feasible: false`) instead of producing a batch and letting the caller
 *      find out.
 *   2. **Followers before the leader.** The leader is last, always — a leadership
 *      election during a rollout is a signal that has to be attributable to the
 *      rollout.
 *   3. **Zones spread.** Within the constraint in (1), a batch is drawn from as
 *      many distinct zones as the candidate set allows.
 *
 * @module @agentix-e/db-cluster/rollout
 */

import type { BatchStrategy } from '@agentix-e/db-node/rollingupgrade';
import type { ClusterMember, SkippedItem } from '../interfaces/index.js';
import { leaderOf, tolerableFailures, votersOf } from '../membership/quorum.js';

export interface RolloutPlanningInput {
  /** Node ids the upgrade plan intends to replace. */
  nodes: readonly string[];
  /** The member set as it is now. */
  members: readonly ClusterMember[];
  batchStrategy: BatchStrategy;
  /** Batch size, or a percentage for the `percentage` strategy. */
  batchSize?: number;
}

export interface RolloutBatch {
  /** 1-based, matching `UpgradeBatch.index` in the node package. */
  index: number;
  /** Members upgraded together, in the order they should be drained. */
  nodes: string[];
  /** Voters unavailable while this batch runs. */
  votersDown: number;
  /** Zones represented by this batch; `null` when no member has a zone. */
  zones: string[] | null;
}

export interface ClusterRolloutPlan {
  batches: RolloutBatch[];
  /** Planned nodes the topology does not contain — a stale plan, named. */
  unplanned: SkippedItem[];
  /** Batch size the strategy asked for, before the quorum cap. */
  requestedBatchSize: number;
  /** Batch size actually used. */
  effectiveBatchSize: number;
  /**
   * Whether any batch can run without losing quorum.
   *
   * `false` means the group is at or below quorum for its current size: a
   * single-voter group, or one that has already lost members. The batches are
   * still returned so an operator can see the shape of the job, but running one
   * is a decision to stop the cluster — not a rollout.
   *
   * This is a property of the plan rather than of a batch on purpose. The cap
   * `min(requested, budget)` makes every batch it emits quorum-safe by
   * construction, so a per-batch `quorumHeld` flag could only ever read `true` —
   * a measurement that cannot vary is not a measurement. A caller that wants the
   * margin has `votersDown` and the voter count in the note.
   */
  feasible: boolean;
  /** One sentence an operator can read without the code. */
  note: string;
}

export class ClusterRolloutPlanner {
  plan(input: RolloutPlanningInput): ClusterRolloutPlan {
    const byId = new Map(input.members.map((member) => [member.id, member]));
    const unplanned: SkippedItem[] = [];
    const candidates: ClusterMember[] = [];

    for (const id of input.nodes) {
      const member = byId.get(id);
      if (member) candidates.push(member);
      else unplanned.push({ id, reason: 'not a member of this group' });
    }

    const voters = votersOf(input.members).length;
    const budget = tolerableFailures(voters);
    const ordered = this.order(candidates);
    const requestedBatchSize = this.requestedSize(input, ordered.length);

    if (ordered.length === 0) {
      return {
        batches: [],
        unplanned,
        requestedBatchSize,
        effectiveBatchSize: 0,
        feasible: true,
        note:
          unplanned.length === 0
            ? 'nothing to upgrade'
            : `none of the ${unplanned.length} planned node(s) is a member of this group`,
      };
    }

    if (budget === 0) {
      // Every batch would lose quorum. The plan is still returned — an operator
      // with one voter and a version to change has a real decision to make — but
      // `feasible: false` is the answer to "may I run this unattended?", and it is
      // `no`.
      return {
        batches: [
          {
            index: 1,
            nodes: ordered.map((member) => member.id),
            votersDown: votersOf(ordered).length,
            zones: zonesOf(ordered),
          },
        ],
        unplanned,
        requestedBatchSize,
        effectiveBatchSize: ordered.length,
        feasible: false,
        note:
          `${voters} voter(s) tolerate 0 failures; upgrading any of them stops the group ` +
          'from committing — this is an outage window, not a rollout',
      };
    }

    // The split is a chunking, so its size is division rather than a cursor: a
    // count that is arithmetic cannot be left un-advanced by an edit, and a
    // rollout plan that spins is a process that never answers the operator who
    // asked for it (P3-75).
    //
    // No second clamp. `requestedSize` already answers a whole number of at least
    // one on every strategy — including the ones a caller misuses (`-5`, `0`, `2.7`)
    // — and `budget` is at least one here, since zero returned above. A floor on top
    // of that was four mutants no input could distinguish: a branch nothing can take
    // is a line the gate is right to refuse to believe.
    const effectiveBatchSize = Math.min(requestedBatchSize, budget);
    const batches: RolloutBatch[] = Array.from(
      { length: Math.ceil(ordered.length / effectiveBatchSize) },
      (_, offset) => {
        const slice = ordered.slice(offset * effectiveBatchSize, (offset + 1) * effectiveBatchSize);
        return {
          index: offset + 1,
          nodes: slice.map((member) => member.id),
          // Per batch, not cumulative: batches are sequential and a batch is back up
          // before the next one drains. Summing across them would describe a
          // rollout that takes every batch down at once.
          votersDown: votersOf(slice).length,
          zones: zonesOf(slice),
        };
      },
    );

    return {
      batches,
      unplanned,
      requestedBatchSize,
      effectiveBatchSize,
      feasible: true,
      note:
        `${ordered.length} node(s) in ${batches.length} batch(es) of ${effectiveBatchSize}, ` +
        `${voters} voter(s) tolerate ${budget}; leader last`,
    };
  }

  /**
   * Learners, then followers, then the leader.
   *
   * Learners cost nothing to take down and must not be left behind — a learner
   * that never upgrades is a replica that cannot be promoted later. Followers are
   * interleaved across zones so that **any prefix** of this list is as spread out
   * as the member set allows, which is what makes batching a plain `slice`: a
   * per-batch search for a fresh zone is a second copy of the same rule, and the
   * two copies disagree as soon as a zone runs out.
   */
  private order(members: readonly ClusterMember[]): ClusterMember[] {
    const leader = leaderOf(members);
    const learners = members.filter((member) => member.role === 'learner');
    const followers = members.filter((member) => member.role === 'follower');
    const trailing = leader ? [leader] : [];
    return [...learners, ...interleaveByZone(followers), ...trailing];
  }

  private requestedSize(input: RolloutPlanningInput, remaining: number): number {
    switch (input.batchStrategy) {
      case 'one_by_one':
        return 1;
      case 'all_at_once':
        return Math.max(1, remaining);
      case 'percentage': {
        const percent = typeof input.batchSize === 'number' && input.batchSize > 0 ? input.batchSize : 20;
        return Math.max(1, Math.ceil((remaining * percent) / 100));
      }
      case 'fixed_size':
        return typeof input.batchSize === 'number' && input.batchSize >= 1 ? Math.floor(input.batchSize) : 1;
      default:
        // A strategy string this version does not know. Answering one node at a
        // time would be a silent, plausible plan for a strategy that may have
        // meant something else entirely.
        throw new Error(`unknown batch strategy "${input.batchStrategy}"`);
    }
  }
}

/** Zones the members belong to, or `null` when none of them declares one. */
function zonesOf(members: readonly ClusterMember[]): string[] | null {
  const zones = new Set<string>();
  for (const member of members) if (member.zone !== undefined) zones.add(member.zone);
  return zones.size === 0 ? null : [...zones].sort();
}

/**
 * Round-robin across zones, keeping the input order inside a zone.
 *
 * `[a1, a2, a3, b1, b2]` becomes `[a1, b1, a2, b2, a3]`, so a batch of two takes
 * one node from each zone instead of two from the first. A member set with one
 * zone (or none) comes out in its input order, which is what the round robin
 * over a single queue already does — an early return for that case would be a
 * branch whose removal changes nothing.
 */
function interleaveByZone(members: readonly ClusterMember[]): ClusterMember[] {
  // Keyed by the zone itself, `undefined` included: a sentinel string for "no
  // zone" groups the same members, so the sentinel is a value nothing can
  // observe.
  const groups = new Map<string | undefined, ClusterMember[]>();
  for (const member of members) {
    const group = groups.get(member.zone);
    if (group) group.push(member);
    else groups.set(member.zone, [member]);
  }

  const queues = [...groups.values()];
  // One round per member of the longest queue, and round `r` takes the `r`-th
  // member of every queue: the round robin the shifting loop performed, with the
  // number of rounds computed before the walk instead of by it. A flag that the
  // walk sets to keep itself going is a promise the walk can break (P3-75).
  const rounds = queues.reduce((longest, queue) => Math.max(longest, queue.length), 0);
  return Array.from({ length: rounds }, (_, round) =>
    queues.map((queue) => queue[round]).filter((member): member is ClusterMember => member !== undefined),
  ).flat();
}
