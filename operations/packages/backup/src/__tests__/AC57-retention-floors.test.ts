/**
 * AC 57 — a retention floor is a floor, and a limit that cannot be met says so.
 *
 * The evaluator's own docblock states four rules: keep the newest
 * `maxFullSnapshots` full snapshots, skip anything younger than `keepRecent`,
 * delete only what is at least `minAge` old, and keep total bytes under
 * `maxTotalBytes`. Rules two and three are stated as prohibitions — "skipped",
 * "only deletable" — and the fourth rule, as implemented, ignored both of them:
 * the byte loop walked every snapshot that had not already been marked and
 * deleted the oldest until the total fit.
 *
 * So a policy saying "never remove anything from the last seven days" removed a
 * one-hour-old backup as soon as the byte ceiling was exceeded, and reported
 * success by returning it in the delete list. Nothing in the old suite noticed,
 * because every test of `keepRecent` also disabled `maxTotalBytes`, and every
 * test of `maxTotalBytes` left the floors unset — each rule was tested alone.
 * Found by mutation testing: the byte loop's guards survived.
 *
 * The second half of the contract is what happens when the limit cannot be
 * honoured: the floors win, and the bytes that stayed are reported rather than
 * forgotten. `evaluateWithOutcome` returns them; `evaluate` keeps its shape and
 * returns only the delete list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetentionPolicyEvaluator, parseDurationToMs } from '../impl/RetentionPolicyEvaluator.js';
import type { BackupMetadata } from '@agentix-e/db-operations-core/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Fixed instant so every age in this suite is an exact number of hours. */
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0, 0);

function snapshot(id: string, ageMs: number, sizeBytes: number, type: 'full' | 'incremental' = 'full'): BackupMetadata {
  return {
    snapshotId: id,
    type,
    state: 'completed',
    sizeBytes,
    createdAt: new Date(NOW - ageMs).toISOString(),
    fileCount: 1,
    location: `file:///backups/${id}.tar`,
  };
}

const ids = (snapshots: BackupMetadata[]): string[] => snapshots.map((s) => s.snapshotId).sort();

describe('AC 57 — retention floors survive the byte ceiling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 57.1: keepRecent is not overridden when the byte ceiling is exceeded', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      keepRecent: 'P7D',
      maxTotalBytes: 1,
    });

    const young = snapshot('young', 1 * HOUR_MS, 5_000_000);
    const old = snapshot('old', 30 * DAY_MS, 5_000_000);

    const toDelete = evaluator.evaluate([young, old]);

    // The old snapshot is the only count candidate, so it goes. The young one is
    // protected by keepRecent and must survive even though it alone is far over
    // the one-byte ceiling.
    expect(ids(toDelete)).toEqual(['old']);
  });

  it('AC 57.2: minAge is not overridden when the byte ceiling is exceeded', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      minAge: 'P30D',
      maxTotalBytes: 1,
    });

    const midlife = snapshot('midlife', 10 * DAY_MS, 5_000_000);
    const old = snapshot('old', 90 * DAY_MS, 5_000_000);

    expect(ids(evaluator.evaluate([midlife, old]))).toEqual(['old']);
  });

  it('AC 57.3: bytes the floors forbid reclaiming are reported, not swallowed', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      keepRecent: 'P7D',
      maxTotalBytes: 1_000,
    });

    const young = snapshot('young', 1 * HOUR_MS, 5_000);
    const outcome = evaluator.evaluateWithOutcome([young]);

    expect(outcome.toDelete).toEqual([]);
    expect(outcome.unreclaimedBytes).toBe(5_000 - 1_000);
  });

  it('AC 57.4: the count rule keeps the newest snapshots, not the first in the array', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 2, maxTotalBytes: 0 });

    // Deliberately not in chronological order.
    const snapshots = [
      snapshot('third', 3 * DAY_MS, 100),
      snapshot('first', 1 * DAY_MS, 100),
      snapshot('second', 2 * DAY_MS, 100),
    ];

    // Newest two are `first` and `second`; `third` is the only candidate.
    expect(ids(evaluator.evaluate(snapshots))).toEqual(['third']);
  });

  it('AC 57.5: a parentless incremental counts as a set of its own', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 1, maxTotalBytes: 0 });

    const snapshots = [
      snapshot('full-new', 1 * DAY_MS, 100),
      snapshot('inc-2', 2 * DAY_MS, 100, 'incremental'),
      snapshot('inc-3', 3 * DAY_MS, 100, 'incremental'),
    ];

    // None of these names a base, so each is a set of one. The newest set is
    // kept and the two older ones are removed. Iteration 26 kept every
    // incremental forever — the semantics P2-12 asked to settle — which left
    // unrestorable snapshots accumulating until the byte ceiling caught them
    // (AC 59).
    expect(
      evaluator
        .evaluate(snapshots)
        .map((s) => s.snapshotId)
        .sort(),
    ).toEqual(['inc-2', 'inc-3']);
  });

  it('AC 57.6: a snapshot is never listed twice, and bytes already scheduled for deletion are not counted again', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      maxTotalBytes: 2_000_000,
    });

    const snapshots = [
      snapshot('newest', 1 * DAY_MS, 1_000_000),
      snapshot('middle', 2 * DAY_MS, 1_000_000),
      snapshot('oldest', 3 * DAY_MS, 100_000_000),
    ];

    const toDelete = evaluator.evaluate(snapshots);

    // `middle` and `oldest` are count candidates. What is left is 1 MB, which is
    // under the 2 MB ceiling — counting the two candidates again would have made
    // it look like 102 MB and deleted `newest` as well.
    expect(ids(toDelete)).toEqual(['middle', 'oldest']);
    expect(new Set(toDelete.map((s) => s.snapshotId)).size).toBe(toDelete.length);
  });

  it('AC 57.7: deletion stops when the excess reaches exactly zero', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 3,
      maxTotalBytes: 5_000_000,
    });

    const snapshots = [
      snapshot('newest', 1 * DAY_MS, 3_000_000),
      snapshot('middle', 2 * DAY_MS, 2_000_000),
      snapshot('oldest', 3 * DAY_MS, 3_000_000),
    ];

    // 8 MB against a 5 MB ceiling is a 3 MB excess. Removing the oldest 3 MB
    // snapshot closes it exactly; one more deletion would take 2 MB that the
    // policy never asked to give up.
    expect(ids(evaluator.evaluate(snapshots))).toEqual(['oldest']);
  });

  it('AC 57.8: a total at the ceiling does not trigger deletion', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 5,
      maxTotalBytes: 4_000_000,
    });

    const snapshots = [snapshot('a', 1 * DAY_MS, 2_000_000), snapshot('b', 2 * DAY_MS, 2_000_000)];

    // Exactly at the ceiling is not over it.
    expect(evaluator.evaluate(snapshots)).toEqual([]);
  });

  it('AC 57.9: a snapshot exactly at the keepRecent floor is deletable', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 0,
      keepRecent: 'P7D',
      maxTotalBytes: 0,
    });

    const atFloor = snapshot('at-floor', 7 * DAY_MS, 100);
    const justInside = snapshot('just-inside', 7 * DAY_MS - 1, 100);

    // "younger than" is strict: the floor instant itself is not younger.
    expect(ids(evaluator.evaluate([atFloor, justInside]))).toEqual(['at-floor']);
  });

  it('AC 57.10: a snapshot exactly at the minAge floor is deletable', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 0,
      minAge: 'P10D',
      maxTotalBytes: 0,
    });

    const atFloor = snapshot('at-floor', 10 * DAY_MS, 100);
    const justInside = snapshot('just-inside', 10 * DAY_MS - 1, 100);

    expect(ids(evaluator.evaluate([atFloor, justInside]))).toEqual(['at-floor']);
  });
});

describe('AC 57 — a duration that cannot be understood is an error', () => {
  it('AC 57.11: an unparseable duration is rejected where the policy is written', () => {
    // Silently reading as zero would turn "keep a week" into "keep nothing",
    // which deletes every backup the next time the ceiling is hit.
    expect(
      () => new RetentionPolicyEvaluator({ maxFullSnapshots: 1, keepRecent: 'seven days', maxTotalBytes: 0 }),
    ).toThrow(/keepRecent/);
    expect(() => new RetentionPolicyEvaluator({ maxFullSnapshots: 1, minAge: 'P1W', maxTotalBytes: 0 })).toThrow(
      /minAge/,
    );
  });

  it('AC 57.12: parseDurationToMs accepts the documented forms and rejects the rest', () => {
    expect(parseDurationToMs('P7D')).toBe(7 * DAY_MS);
    expect(parseDurationToMs('PT1H')).toBe(HOUR_MS);
    expect(parseDurationToMs('PT30M')).toBe(30 * MINUTE_MS);
    expect(parseDurationToMs('P1DT2H3M4S')).toBe(DAY_MS + 2 * HOUR_MS + 3 * MINUTE_MS + 4_000);
    // The plain-hour fallback is documented and stays.
    expect(parseDurationToMs('48')).toBe(48 * HOUR_MS);
    // Surrounding whitespace is not part of the value.
    expect(parseDurationToMs('  P7D ')).toBe(7 * DAY_MS);

    // Everything else is rejected rather than read as zero.
    for (const bad of ['', 'seven days', 'P1W', 'PT', '1D', 'P-1D', 'P1.5D']) {
      expect(() => parseDurationToMs(bad), bad).toThrow();
    }
  });

  it('AC 57.12b: the rejection says which field is wrong and what it was given', () => {
    // A validation error is read by whoever wrote the policy, at deploy time.
    // Naming the field and quoting the value is the difference between a fix and
    // a search.
    expect(
      () => new RetentionPolicyEvaluator({ maxFullSnapshots: 1, keepRecent: 'seven days', maxTotalBytes: 0 }),
    ).toThrow(
      'RetentionPolicy.keepRecent is "seven days", which is not a duration: ' +
        '"seven days" is not an ISO-8601 duration (P7D, PT1H, P1DT2H) or a plain number of hours',
    );

    // `PT` looks like a duration and has no component in it; the message says so
    // rather than repeating the generic grammar complaint.
    expect(() => parseDurationToMs('PT')).toThrow('"PT" has no duration component');
  });

  it('AC 57.13: updateConfig validates the floors it is given', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      keepRecent: 'P7D',
      maxTotalBytes: 0,
    });

    // A runtime update is a second place a policy is written, and it is the one
    // that happens in production. It rejects the same inputs the constructor
    // does, and names the field that is wrong.
    expect(() => evaluator.updateConfig({ keepRecent: 'lately' })).toThrow(/keepRecent/);
    expect(() => evaluator.updateConfig({ minAge: 'P1W' })).toThrow(/minAge/);

    // The rejected update is not half-applied.
    expect(evaluator.getConfig().keepRecent).toBe('P7D');
    expect(evaluator.getConfig().minAge).toBeUndefined();

    evaluator.updateConfig({ keepRecent: 'P14D' });
    expect(evaluator.getConfig().keepRecent).toBe('P14D');
  });
});
