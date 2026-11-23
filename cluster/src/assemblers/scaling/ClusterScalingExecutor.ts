/**
 * The scaling decision is an opinion; the member set is the fact.
 *
 * `IAutoScaler.evaluate()` returns a `ScaleAction` whose `targetCount` was
 * computed from the metrics that reached it and from the node count *it* believes
 * in. Those two numbers drift, and they drift in the direction that hurts: a
 * membership change the scaler did not observe leaves it asking for six nodes
 * when there are seven, or — the dangerous one — asking for two when there are
 * three and only two of them vote.
 *
 * This executor therefore does not apply `action.amount`. It reads the topology,
 * computes the delta from what exists, clamps the result against the policy floor
 * and the quorum floor, and removes nodes in an order that never starts with the
 * leader. Every clamp is reported rather than applied silently, because a
 * scale-down that stopped at the quorum floor is a capacity decision an operator
 * has to make, not a number to discover from a graph a week later.
 *
 * @module @agentix-e/db-cluster/scaling
 */

import type { ScaleAction, ScaleDirection } from '@agentix-e/db-node/autoscaler';
import type { ClusterMember, IMemberSet, SkippedItem } from '../interfaces/index.js';
import { ClusterMembershipError } from '../membership/errors.js';
import { quorumOf, votersOf } from '../membership/quorum.js';

/** What stopped a requested target from being reached. */
export type ClampReason = 'policy-min' | 'policy-max' | 'quorum-floor' | 'unlisted-nodes';

export interface ClusterScalingOptions {
  topology: IMemberSet;
  /** Policy floor: the cluster never runs fewer than this. */
  minNodes: number;
  /** Policy ceiling: the cluster never runs more than this. */
  maxNodes: number;
  /** Prefix for ids minted by a scale-up. Defaults to `node`. */
  idPrefix?: string;
}

export interface ScaleOutcome {
  /** The action this outcome implements; `null` when the scaler had no opinion. */
  action: ScaleAction | null;
  /** Members the topology reported before any change. */
  observedCount: number;
  /** Members after the change — what was asked for, clamped. */
  targetCount: number;
  direction: ScaleDirection;
  /** Ids added or removed, in the order the topology saw them. */
  applied: string[];
  /** Changes that were not made, each with a reason. */
  skipped: SkippedItem[];
  /** Set when the requested target was not reached. */
  clampedBy: ClampReason | null;
  /** One sentence an operator can read without the code. */
  note: string;
}

export class ClusterScalingExecutor {
  private readonly topology: IMemberSet;
  private readonly minNodes: number;
  private readonly maxNodes: number;
  private readonly idPrefix: string;

  constructor(options: ClusterScalingOptions) {
    if (options.minNodes < 0) throw new Error('minNodes must be >= 0');
    if (options.maxNodes < options.minNodes) {
      throw new Error(
        `maxNodes (${options.maxNodes}) is below minNodes (${options.minNodes}); ` +
          'a policy that can never be satisfied would clamp every action',
      );
    }
    this.topology = options.topology;
    this.minNodes = options.minNodes;
    this.maxNodes = options.maxNodes;
    this.idPrefix = options.idPrefix ?? 'node';
  }

  async apply(action: ScaleAction | null): Promise<ScaleOutcome> {
    const members = await this.topology.members();
    const observed = members.length;

    if (!action || action.action === 'none') {
      return {
        action,
        observedCount: observed,
        targetCount: observed,
        direction: 'none',
        applied: [],
        skipped: [],
        clampedBy: null,
        note: action ? `scaler declined to act: ${action.reason}` : 'scaler returned no action',
      };
    }

    return action.action === 'scale_up' ? this.scaleUp(action, members) : this.scaleDown(action, members);
  }

  private async scaleUp(action: ScaleAction, members: readonly ClusterMember[]): Promise<ScaleOutcome> {
    const observed = members.length;
    // `Math.max(observed, …)`: a scale-up whose target is *below* the current size
    // is a stale decision, and honouring it would make this method a scale-down
    // in disguise — one that skipped every quorum check.
    const asked = Math.max(observed, Math.floor(action.targetCount));
    const capped = Math.min(asked, this.maxNodes);
    const target = Math.max(capped, this.minNodes);
    const clampedBy: ClampReason | null =
      asked > this.maxNodes ? 'policy-max' : capped < this.minNodes ? 'policy-min' : null;

    const wanted = target - observed;
    if (wanted <= 0) {
      return {
        action,
        observedCount: observed,
        targetCount: observed,
        direction: 'none',
        applied: [],
        skipped: [],
        clampedBy,
        note: `already at ${observed} members, policy ceiling is ${this.maxNodes}`,
      };
    }

    const applied: string[] = [];
    const skipped: SkippedItem[] = [];
    const taken = new Set(members.map((member) => member.id));

    // Every id is minted before the first attempt, in one pass, so the number of
    // attempts is the length of a list rather than a counter whose step an edit can
    // reverse (P3-75). `mintId` does not record what it hands out — recording is the
    // caller's job below — so the mapper records it: taken before the attempt, not
    // after, because a refused join that is not remembered is minted again on the
    // next pass, and one failing id would turn a three-node scale-up into three
    // attempts at the same failing node.
    const ids = Array.from({ length: wanted }, () => {
      const id = this.mintId(taken);
      taken.add(id);
      return id;
    });

    for (const id of ids) {
      try {
        await this.topology.addNode(id);
        applied.push(id);
      } catch (error) {
        skipped.push({ id, reason: describe(error) });
      }
    }

    return {
      action,
      observedCount: observed,
      targetCount: applied.length + observed,
      direction: 'scale_up',
      applied,
      skipped,
      clampedBy,
      note:
        applied.length === wanted
          ? `grew from ${observed} to ${observed + applied.length} members`
          : `grew from ${observed} to ${observed + applied.length}; ${skipped.length} join(s) refused`,
    };
  }

  private async scaleDown(action: ScaleAction, members: readonly ClusterMember[]): Promise<ScaleOutcome> {
    const observed = members.length;
    const voters = votersOf(members).length;
    const asked = Math.min(observed, Math.floor(action.targetCount));

    // Two floors, and the larger wins. The policy floor is a capacity decision the
    // operator made; the quorum floor is physics — below it the group stops
    // committing, and a cluster that cannot commit is not a smaller cluster.
    const quorumFloor = quorumOf(voters);
    const floor = Math.max(this.minNodes, quorumFloor);
    const target = Math.max(asked, floor);
    const clampedBy: ClampReason | null =
      asked < this.minNodes ? 'policy-min' : asked < quorumFloor ? 'quorum-floor' : null;

    // The floor is at least quorum, and a group of `n` voters can always lose
    // `n - quorum(n)` of them, so there is a candidate for every removal the floor
    // permits: the loop below is bounded by the target, never by the list.
    const removable = this.removableOrder(members);

    const applied: string[] = [];
    const skipped: SkippedItem[] = [];
    // A node that is already gone shrank the group too. Counting it as a removal
    // that still has to happen is how a scale-down overshoots: the plan says "go
    // from five to three", two of the three removals are already done by someone
    // else, and the executor removes two more.
    let absent = 0;
    const size = (): number => observed - applied.length - absent;

    for (const id of removable) {
      if (size() <= target) break;
      try {
        await this.topology.removeNode(id);
        applied.push(id);
      } catch (error) {
        if (error instanceof ClusterMembershipError && error.code === 'unknown-member') {
          // A stale plan, not a failure: another actor removed this node and the
          // state the caller wanted is the state that exists.
          absent += 1;
          skipped.push({ id, reason: 'already absent' });
          continue;
        }
        // Any other refusal — quorum, a changing configuration — means the layer
        // is now rejecting changes it had been accepting. Continuing would walk
        // further into the floor that just pushed back.
        skipped.push({ id, reason: describe(error) });
        break;
      }
    }

    // One sentence, and the clause that explains a clamp is part of it rather
    // than an element of an array: a list joined by a separator that only ever
    // has one element is a literal nothing can observe.
    const floorNote =
      clampedBy === 'quorum-floor'
        ? `; stopped at the quorum floor of ${quorumFloor} voter(s)`
        : clampedBy === 'policy-min'
          ? `; stopped at the policy floor of ${this.minNodes}`
          : '';

    return {
      action,
      observedCount: observed,
      targetCount: size(),
      direction: applied.length > 0 ? 'scale_down' : 'none',
      applied,
      skipped,
      clampedBy,
      note: `shrank from ${observed} to ${size()} members${floorNote}`,
    };
  }

  /**
   * The order nodes leave in.
   *
   * Learners first: they do not vote, so removing one costs nothing but a
   * replication stream. Followers next, newest id first — a scale-down that
   * removes the oldest member leaves the group with the least-experienced
   * majority. The leader is never in this list.
   */
  private removableOrder(members: readonly ClusterMember[]): string[] {
    // A learner can never be the leader: the role is exclusive, and `leaderOf`
    // answers from it. The `member.id !== leader?.id` clause that used to sit here
    // could not fire, and a filter whose second clause is unreachable is a claim
    // about the code that the roles already make.
    const learners = members.filter((member) => member.role === 'learner');
    // `filter` already copied: sorting it cannot reorder the caller's array.
    const followers = members
      .filter((member) => member.role === 'follower')
      .sort((left, right) => right.id.localeCompare(left.id));
    return [...learners, ...followers].map((member) => member.id);
  }

  /** The first `<prefix>-<n>` id that the current member set does not use. */
  private mintId(taken: ReadonlySet<string>): string {
    // At most `taken.size` of these names can be taken, so one of the first
    // `taken.size + 1` of them is free — a pigeonhole, not a search. The walk this
    // replaces incremented an index until a name was free, which is a loop a
    // reversed step leaves turning forever (P3-75).
    const candidates = Array.from({ length: taken.size + 1 }, (_, offset) => `${this.idPrefix}-${offset + 1}`);
    return candidates.find((id) => !taken.has(id))!;
  }
}

/** A refusal as a sentence: the error's message when it is one, else its text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
