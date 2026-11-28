/**
 * I106 — the retention window is checked against the schedule that takes the snapshots.
 *
 * `RetentionPolicyEvaluator` can compare a window with an interval, but nothing
 * connected it to the schedule a deployment runs. A policy that keeps a day of
 * backups and a schedule that snapshots every two days therefore passed at boot
 * and deleted the last restore there was. The composition root under test reads
 * the schedule and hands its period to the evaluator; a disabled schedule cannot
 * promise snapshots at all and is refused by name.
 *
 * @module @agentix-e/db-node/backup/__tests__
 */

import { describe, expect, it } from 'vitest';

import type { IBackupScheduleConfig } from '../interfaces/index.js';
import type { RetentionPolicy } from '../../core/types.js';
import { createRetentionForSchedule } from '../impl/retentionComposition.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const policy: RetentionPolicy = {
  maxFullSnapshots: 10,
  maxTotalBytes: 0,
  keepRecent: 'P1D',
};

function schedule(intervalMs: number, enabled = true): IBackupScheduleConfig {
  return { enabled, intervalMs, retentionCount: 10 };
}

describe('I106: retention composed with its schedule', () => {
  it("RS.1 — the schedule's period becomes the interval the evaluator checks", () => {
    const evaluator = createRetentionForSchedule(policy, schedule(HOUR));
    expect(evaluator.getWindows()).toMatchObject({ keepRecentMs: DAY, snapshotIntervalMs: HOUR });
  });

  it('RS.2 — a schedule slower than the window is refused at construction', () => {
    expect(() => createRetentionForSchedule(policy, schedule(2 * DAY))).toThrow(
      /snapshotInterval 172800000 ms is longer than keepRecent 86400000 ms/,
    );
  });

  it('RS.3 — a disabled schedule cannot keep a retention promise', () => {
    expect(() => createRetentionForSchedule(policy, schedule(HOUR, false))).toThrow(
      /schedule is disabled, so no snapshot will ever be taken/,
    );
  });

  it('RS.4 — no schedule is still the honest "uncheckable" answer', () => {
    expect(createRetentionForSchedule(policy, null).getWindows()).toEqual({
      keepRecentMs: DAY,
      replayWindowMs: DAY,
    });
  });
});
