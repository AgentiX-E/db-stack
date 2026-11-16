/**
 * AC 58 — a schedule whose edges are not tested is a schedule that does not fire.
 *
 * The maintenance scheduler's guards are all written at the boundary of a range
 * — `i <= max`, `day >= 1`, `priority < 0`, `start >= fromMs` — and a suite that
 * only ever exercises the middle of each range cannot tell `<=` from `<`. These
 * cases were found by mutation testing, not by reading the code: each one names
 * an input that the old suite never produced, and each one failed a real
 * deployment if the two-character difference is on the wrong side.
 *
 * The most expensive of them is AC 58.6: `daysOfMonth: [1]` never fired, because
 * the validity check asked for `day > 1`. A monthly window on the first of the
 * month is not an exotic configuration.
 *
 * @module @agentix-e/db-operations-maintenance/__tests__
 */

import { describe, it, expect } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { MaintenanceWindow } from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Monday 2026-11-16 00:00 UTC. */
const MONDAY = Date.UTC(2026, 10, 16, 0, 0, 0, 0);

function windowOf(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: overrides.id ?? 'window-1',
    name: 'window',
    operationType: 'VACUUM',
    targets: [],
    owner: 'test-owner',
    recurrence: 'daily',
    startTime: '06:00',
    priority: 5,
    maxDurationMin: 30,
    requiresApproval: false,
    ...overrides,
  };
}

/** Local ISO-ish rendering of a UTC instant, to read assertions at a glance. */
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

describe('AC 58 — cron fields reach the ends of their ranges', () => {
  it('AC 58.1: minute 59 and hour 23 are valid values, so the last minute of the day fires', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'cron', cronExpression: '59 23 * * *' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 2 * DAY_MS);

    // `for (i = min; i < max; i++)` would leave 59 out of the minute set and
    // this expression would never match anything.
    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-11-16T23:59', '2026-11-17T23:59']);
    expect(occurrences.every((o) => o.recurrence === 'cron')).toBe(true);
  });

  it('AC 58.2: a stepped range that runs past the field maximum stops at the maximum', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'cron', cronExpression: '50-70/5 * * * *' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 90 * MINUTE_MS);

    // 50 and 55 exist; 60, 65 and 70 are not minutes.
    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-11-16T00:50', '2026-11-16T00:55']);
  });

  it('AC 58.3: a range that ends at the field maximum includes the maximum', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'cron', cronExpression: '58-59 0 * * *' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS);

    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-11-16T00:58', '2026-11-16T00:59']);
  });

  it('AC 58.4: a malformed step is skipped, not turned into a crash', () => {
    // "*/" has no step and "/5" has no range. Neither may throw from inside the
    // parser: a bad expression in one window must not take the whole projection
    // down, and it must not silently become "*".
    for (const expression of ['*/ * * * *', '/5 * * * *', '1-5/x * * * *']) {
      const scheduler = new MaintenanceWindowScheduler();
      scheduler.registerWindow(windowOf({ recurrence: 'cron', cronExpression: expression }));

      expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS), expression).toEqual([]);
    }
  });

  it('AC 58.5: extra whitespace between cron fields is not a fifth-field error', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'cron', cronExpression: '  30   4  *  *  *  ' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS);

    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-11-16T04:30']);
  });
});

describe('AC 58 — day and priority boundaries', () => {
  it('AC 58.6: a monthly window on the first of the month fires', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'monthly', startTime: '06:00', daysOfMonth: [1] }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 60 * DAY_MS);

    // Day 1 is a day of the month. `day > 1` silently dropped it and the window
    // never ran.
    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-12-01T06:00', '2027-01-01T06:00']);
  });

  it('AC 58.7: priority 0 is a priority, not a negative one', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ id: 'zero', priority: 0 }));
    scheduler.registerWindow(windowOf({ id: 'one', startTime: '07:00', priority: 1 }));

    // Both are accepted; a window that treated 0 as negative would have been
    // rejected at registration and this call would project only one.
    expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS).map((o) => o.windowId)).toEqual(['zero', 'one']);
  });
});

describe('AC 58 — instance identity', () => {
  it('AC 58.8: every projected occurrence gets its own instance id', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'daily' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 3 * DAY_MS);

    expect(occurrences).toHaveLength(3);
    expect(new Set(occurrences.map((o) => o.instanceId)).size).toBe(3);
  });

  it('AC 58.9: two windows starting at the same instant keep their own instances', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ id: 'left', startTime: '06:00' }));
    scheduler.registerWindow(windowOf({ id: 'right', startTime: '06:00' }));

    const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS);

    // The idempotency guard is keyed on (window, start). Keyed on start alone it
    // would hand one window the other's instance, and cancelling one would
    // cancel both.
    expect(occurrences.map((o) => o.windowId).sort()).toEqual(['left', 'right']);
    expect(new Set(occurrences.map((o) => o.instanceId)).size).toBe(2);
  });
});

describe('AC 58 — range boundaries', () => {
  it('AC 58.10: an occurrence exactly at the range start is included', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'daily', startTime: '06:00' }));

    const exactlyAtStart = Date.UTC(2026, 10, 16, 6, 0, 0, 0);
    const occurrences = scheduler.getUpcomingOccurrences(exactlyAtStart, exactlyAtStart + DAY_MS);

    // `[from, to)` includes `from`. Treating the bound as exclusive lost a whole
    // day whenever a caller resumed from the previous run's last occurrence.
    expect(occurrences.map((o) => utc(o.start))).toEqual(['2026-11-16T06:00']);
  });

  it('AC 58.11: a once window with an unreadable timestamp projects nothing', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'once', at: 'not-a-date' }));

    // `new Date('not-a-date').getTime()` is NaN, and NaN comparisons are all
    // false — but a guard that is written as `if (isNaN(start)) return;` and then
    // mutated to `false` produces an occurrence scheduled at NaN.
    expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + DAY_MS)).toEqual([]);
  });
});
