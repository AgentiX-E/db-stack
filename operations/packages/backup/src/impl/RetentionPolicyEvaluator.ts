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
  /** Snapshots the policy permits removing. */
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
 * Evaluates which backup snapshots to prune based on a RetentionPolicy.
 *
 * Rules, in the order they are applied:
 * 1. Keep the newest `maxFullSnapshots` full snapshots; the rest are candidates.
 * 2. If `keepRecent` is set, nothing younger than it is removed — by any rule.
 * 3. If `minAge` is set, only snapshots at least that old are removed.
 * 4. Enforce `maxTotalBytes`: remove the oldest snapshots that rules 2 and 3
 *    still allow, until the total fits or nothing removable is left.
 *
 * Rules 2 and 3 are prohibitions, so they bind rule 4 as well. Before iteration
 * 26 the byte loop ignored both of them and deleted the oldest snapshots that
 * had not already been marked, which meant a policy of "keep seven days" could
 * remove a one-hour-old backup the moment the ceiling was exceeded (AC 57.1).
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
    if (snapshots.length === 0) {
      return { toDelete, unreclaimedBytes: 0 };
    }

    const now = Date.now();
    const keepRecentMs = this.policy.keepRecent ? parseDurationToMs(this.policy.keepRecent) : null;
    const minAgeMs = this.policy.minAge ? parseDurationToMs(this.policy.minAge) : null;

    /** True when rules 2 or 3 forbid removing this snapshot. */
    const isFloorProtected = (snap: BackupMetadata): boolean => {
      const age = now - new Date(snap.createdAt).getTime();
      if (keepRecentMs !== null && age < keepRecentMs) return true;
      if (minAgeMs !== null && age < minAgeMs) return true;
      return false;
    };

    // Newest first. The count rule is defined on creation time, not on the
    // order the caller happened to hand the inventory over in.
    const sorted = [...snapshots].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Rule 1 — count full snapshots only. Incrementals are not promoted into a
    // full's slot: they are only removable by the byte rule below.
    const fullSnapshots = sorted.filter((s) => s.type === 'full');
    const countCandidates = fullSnapshots.slice(Math.max(this.policy.maxFullSnapshots, 0));

    // Rules 2 and 3 bind every deletion, the count rule included.
    for (const snap of countCandidates) {
      if (isFloorProtected(snap)) continue;
      toDelete.push(snap);
    }

    // Rule 4 — the oldest removable snapshot first, until the total fits.
    let unreclaimedBytes = 0;
    if (this.policy.maxTotalBytes > 0) {
      const remaining = sorted.filter((s) => !toDelete.includes(s));
      const totalBytes = remaining.reduce((sum, s) => sum + s.sizeBytes, 0);

      if (totalBytes > this.policy.maxTotalBytes) {
        const orderedByAge = [...remaining].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        let excess = totalBytes - this.policy.maxTotalBytes;

        for (const snap of orderedByAge) {
          if (excess <= 0) break;
          if (isFloorProtected(snap)) continue;
          if (toDelete.includes(snap)) continue;
          toDelete.push(snap);
          excess -= snap.sizeBytes;
        }

        // Anything still over the ceiling stayed because a floor said so.
        unreclaimedBytes = Math.max(excess, 0);
      }
    }

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
