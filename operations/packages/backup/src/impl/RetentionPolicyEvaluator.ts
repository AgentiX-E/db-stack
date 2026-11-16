/**
 * RetentionPolicyEvaluator — Evaluates snapshots against a retention policy.
 *
 * @module @agentix-e/db-operations-backup/impl
 */

import type { IBackupRetentionPolicy } from '../interfaces/index.js';
import type { BackupMetadata, RetentionPolicy } from '@agentix-e/db-operations-core/types';

const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * What a retention pass decided, and what it could not do.
 */
export interface RetentionOutcome {
  /**
   * Snapshots the policy permits removing, oldest first.
   *
   * Always a union of whole backup sets: committing this list leaves no
   * incremental without the base it needs, and no base whose incrementals were
   * left pointing at it. The order is oldest-first so that deleting the list as
   * it comes never removes a base before the snapshots that depend on it.
   */
  toDelete: BackupMetadata[];
  /**
   * Bytes over `maxTotalBytes` that the age floors forbade reclaiming.
   *
   * Zero means the ceiling was met. A positive number means the policy is
   * asking for two things that cannot both hold — "stay under N bytes" and
   * "never remove anything younger than a week" — and the floors won. It is
   * reported rather than swallowed because the alternative is a storage limit
   * that silently is not one.
   */
  unreclaimedBytes: number;
}

/**
 * One restorable backup: a base snapshot and every incremental chained to it.
 *
 * Snapshots are not independent. An incremental holds only what changed since
 * its parent, so it can be replayed only on top of the whole chain that leads
 * back to a base. A policy that treats snapshots one at a time therefore makes
 * two mistakes, both of which this class used to make:
 *
 *   - it deletes a base and leaves its incrementals behind, occupying bytes
 *     while being unrestorable (the count rule did this: only `full` snapshots
 *     counted toward `maxFullSnapshots`, so incrementals were never pruned and
 *     the base under them went first);
 *   - it deletes a base `n` bytes over the ceiling and stops with a half
 *     chain, which reads as "250 GB reclaimed" while the surviving bytes are
 *     dead weight.
 *
 * Retention therefore operates on sets. A set is kept or removed whole.
 *
 * @internal
 */
interface BackupSet {
  /** The snapshot no other snapshot in the set depends on: its base. */
  base: BackupMetadata;
  /**
   * Every snapshot reachable from the base, in traversal order.
   *
   * Deliberately unordered: nothing decides anything from this array's order
   * (the policy sums bytes and asks `some`), and `evaluateWithOutcome` sorts the
   * union it returns. Sorting it here sorted a value nobody read.
   */
  members: BackupMetadata[];
}

/**
 * Epoch milliseconds of a snapshot's creation, for ordering only.
 *
 * An unreadable timestamp sorts as the oldest snapshot. It is not therefore the
 * first one removed — `isFloorProtected` refuses to remove anything it cannot
 * date — but ordering has to be total, and "unknown" has no better place to sit.
 */
function createdMs(snapshot: BackupMetadata): number {
  const parsed = new Date(snapshot.createdAt).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** True when the snapshot carries a creation time that can be read at all. */
function hasReadableTimestamp(snapshot: BackupMetadata): boolean {
  return !Number.isNaN(new Date(snapshot.createdAt).getTime());
}
/**
 * Group an inventory into restorable sets.
 *
 * A snapshot whose parent is not in the inventory is treated as a base of its
 * own rather than as an orphan to be deleted: `evaluate` receives whatever
 * inventory the caller passes, and a filtered listing must not turn into a
 * delete order. A cycle (malformed metadata that names its own ancestor) is
 * visited once and becomes a set rooted at its oldest member, so no snapshot is
 * unreclaimable and no traversal loops.
 */
function buildBackupSets(snapshots: BackupMetadata[]): BackupSet[] {
  // Keyed by `string | undefined` so that "this snapshot names no parent" is a
  // lookup that finds nothing rather than a branch: a base is a snapshot whose
  // parent id is not a key in the inventory, and both forms of that - absent
  // id, id of a snapshot the caller did not pass - reach the same code path.
  const byId = new Map<string | undefined, BackupMetadata>(
    snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]),
  );
  const children = new Map<string | undefined, BackupMetadata[]>();
  const bases: BackupMetadata[] = [];

  for (const snapshot of snapshots) {
    const parentId = snapshot.parentSnapshotId;
    const parent = byId.get(parentId);
    // A snapshot that names itself as parent is a base. Following that edge
    // would put it in its own child list, where the traversal below would walk
    // it once and give up - the same set, by a longer route.
    const hasBaseInInventory = parent !== undefined && parent.snapshotId !== snapshot.snapshotId;
    if (hasBaseInInventory) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(snapshot);
      children.set(parentId, siblings);
    } else {
      bases.push(snapshot);
    }
  }

  const visited = new Set<string>();
  const collect = (base: BackupMetadata): BackupSet => {
    const members: BackupMetadata[] = [];
    const queue: BackupMetadata[] = [base];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.snapshotId)) continue;
      visited.add(current.snapshotId);
      members.push(current);
      const descendants = children.get(current.snapshotId) ?? [];
      for (const descendant of descendants) queue.push(descendant);
    }
    return { base, members };
  };

  const sets = bases.map((base) => collect(base));

  // Nothing reachable from a base is left unvisited except a cycle, which has
  // no base by definition. Give each remaining snapshot its own set so it can
  // still be reclaimed.
  for (const snapshot of snapshots) {
    if (visited.has(snapshot.snapshotId)) continue;
    sets.push(collect(snapshot));
  }

  return sets;
}

/**
 * Evaluates which backup snapshots to prune based on a RetentionPolicy.
 *
 * Snapshots are grouped into restorable sets first (a base plus every
 * incremental chained to it), and every rule below is decided per set — see
 * `BackupSet`. Rules, in the order they are applied:
 *
 * 1. Keep the newest `maxFullSnapshots` sets, ordered by the creation time of
 *    their base; the rest are candidates for removal, whole.
 * 2. If `keepRecent` is set, a set containing anything younger than it is not
 *    removed — by any rule.
 * 3. If `minAge` is set, only sets whose every member is at least that old are
 *    removed.
 * 4. Enforce `maxTotalBytes`: remove whole sets, oldest base first, until the
 *    total fits or nothing removable is left.
 *
 * Rules 2 and 3 are prohibitions, so they bind rule 4 as well. Before iteration
 * 26 the byte loop ignored both of them and deleted the oldest snapshots that
 * had not already been marked, which meant a policy of "keep seven days" could
 * remove a one-hour-old backup the moment the ceiling was exceeded (AC 57.1).
 * Before iteration 27 neither rule was aware of chains at all (AC 59).
 */
export class RetentionPolicyEvaluator implements IBackupRetentionPolicy {
  private policy: RetentionPolicy;

  constructor(policy: RetentionPolicy) {
    this.policy = { ...policy };
    assertFloorsAreReadable(this.policy);
  }

  /** @inheritdoc */
  evaluate(snapshots: BackupMetadata[]): BackupMetadata[] {
    return this.evaluateWithOutcome(snapshots).toDelete;
  }

  /**
   * Evaluate the policy and report what the floors prevented.
   *
   * `evaluate` is the interface; this is the form an operator needs, because a
   * ceiling that cannot be honoured is a fact about the deployment.
   */
  evaluateWithOutcome(snapshots: BackupMetadata[]): RetentionOutcome {
    const toDelete: BackupMetadata[] = [];

    const now = Date.now();
    const keepRecentMs = this.policy.keepRecent ? parseDurationToMs(this.policy.keepRecent) : null;
    const minAgeMs = this.policy.minAge ? parseDurationToMs(this.policy.minAge) : null;

    /**
     * True when rules 2 or 3 forbid removing this snapshot.
     *
     * A snapshot whose `createdAt` cannot be read is protected too. Treating an
     * unreadable timestamp as the epoch — which the ordering helper does, so the
     * sort stays total — would have put it first in every removal queue: the
     * least understood backup would be the first deleted. Retention may not
     * delete what it cannot date, and the byte ceiling reports the bytes it could
     * not reclaim instead.
     */
    const isFloorProtected = (snap: BackupMetadata): boolean => {
      if (!hasReadableTimestamp(snap)) return true;
      const age = now - createdMs(snap);
      if (keepRecentMs !== null && age < keepRecentMs) return true;
      if (minAgeMs !== null && age < minAgeMs) return true;
      return false;
    };

    /** A set is protected when any member is: keeping the member means keeping its chain. */
    const isSetProtected = (set: BackupSet): boolean => set.members.some(isFloorProtected);

    const sets = buildBackupSets(snapshots);

    // Rule 1 — count sets, newest base first. The base decides the age of the
    // set: an incremental is only as new as the chain it can be replayed on.
    const newestFirst = [...sets].sort((a, b) => createdMs(b.base) - createdMs(a.base));
    const countExcess = newestFirst.slice(Math.max(this.policy.maxFullSnapshots, 0));

    // Rules 2 and 3 bind every deletion, the count rule included.
    const removedSets = new Set<BackupSet>();
    for (const set of countExcess) {
      if (isSetProtected(set)) continue;
      removedSets.add(set);
      toDelete.push(...set.members);
    }

    // Rule 4 — the oldest removable set first, until the total fits.
    let unreclaimedBytes = 0;
    if (this.policy.maxTotalBytes > 0) {
      const surviving = sets.filter((set) => !removedSets.has(set));
      const setBytes = (set: BackupSet): number => set.members.reduce((sum, s) => sum + s.sizeBytes, 0);
      const oldestBaseFirst = [...surviving].sort((a, b) => createdMs(a.base) - createdMs(b.base));
      let excess = surviving.reduce((sum, set) => sum + setBytes(set), 0) - this.policy.maxTotalBytes;

      // A pass that removes nothing leaves `excess` at or below zero and reports
      // nothing unreclaimed - so "we are under the ceiling" needs no branch of
      // its own: the loop breaks before it touches a set.
      for (const set of oldestBaseFirst) {
        if (excess <= 0) break;
        if (isSetProtected(set)) continue;
        toDelete.push(...set.members);
        excess -= setBytes(set);
      }

      // Anything still over the ceiling stayed because a floor said so.
      unreclaimedBytes = Math.max(excess, 0);
    }

    // One order for the caller, whichever rule produced the entry: oldest first.
    // Deleting in list order therefore never removes a base before the
    // snapshots that depend on it.
    toDelete.sort((a, b) => createdMs(a) - createdMs(b));

    return { toDelete, unreclaimedBytes };
  }

  /** @inheritdoc */
  getConfig(): RetentionPolicy {
    return { ...this.policy };
  }

  /** @inheritdoc */
  updateConfig(config: Partial<RetentionPolicy>): void {
    const next = { ...this.policy, ...config };
    assertFloorsAreReadable(next);
    this.policy = next;
  }
}

/**
 * Reject a policy whose duration fields name no duration.
 *
 * `parseDurationToMs` used to answer `0` for anything it did not understand, so
 * `keepRecent: 'seven days'` meant "keep nothing recent" and the next retention
 * pass removed every backup it had promised to keep. A configuration error is
 * reported where it is made instead (AC 57.11).
 */
function assertFloorsAreReadable(policy: RetentionPolicy): void {
  for (const field of ['keepRecent', 'minAge'] as const) {
    const value = policy[field];
    if (value === undefined) continue;
    try {
      parseDurationToMs(value);
    } catch (error) {
      throw new Error(
        `RetentionPolicy.${field} is ${JSON.stringify(value)}, which is not a duration: ` +
          `${(error as Error).message}`,
      );
    }
  }
}

/** Matches `P7D`, `PT1H`, `P1DT2H3M4S` — and, deliberately, nothing else. */
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** A bare number is read as hours; the form is documented and stays supported. */
const PLAIN_HOURS = /^\d+(?:\.\d+)?$/;

/**
 * Parse a simple ISO-8601 duration string to milliseconds.
 * Supports days (P7D), hours (PT1H), minutes (PT30M), seconds (PT30S), and a
 * plain number of hours (`"48"`).
 *
 * @throws If the value names no duration. Two earlier behaviours are gone: a
 * silent `0` for unparseable input, and acceptance of strings such as `"1D"`,
 * `"P1W"` or `"PT"` that look like durations and are not.
 */
export function parseDurationToMs(duration: string): number {
  const text = duration.trim();
  const match = ISO_DURATION.exec(text);

  if (match) {
    const [, days, hours, minutes, seconds] = match;
    if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
      throw new Error(`"${duration}" has no duration component`);
    }
    return (
      Number(days ?? 0) * MILLISECONDS_PER_DAY +
      Number(hours ?? 0) * MILLISECONDS_PER_HOUR +
      Number(minutes ?? 0) * MILLISECONDS_PER_MINUTE +
      Number(seconds ?? 0) * MILLISECONDS_PER_SECOND
    );
  }

  if (PLAIN_HOURS.test(text)) {
    return Number(text) * MILLISECONDS_PER_HOUR;
  }

  throw new Error(`"${duration}" is not an ISO-8601 duration (P7D, PT1H, P1DT2H) or a plain number of hours`);
}
