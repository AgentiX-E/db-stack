/**
 * AC 55 — A schedule must mean what it says, or produce nothing.
 *
 * The projections read `startTime` with `Number()` and hand the result to
 * `setUTCHours()`. `Number('25')` is 25, not `NaN`, and `setUTCHours(25, 0)`
 * rolls over to 01:00 the next day: a typo in the hour silently schedules a
 * window at an hour nobody asked for. The same shape appears in
 * `daysOfMonth`, where `Date.UTC(year, month, 0)` is the last day of the
 * *previous* month — a `0` entry fires a window on a date the operator never
 * named, one month early.
 *
 * The contract these tests lock: a value that cannot name a time of day or a
 * calendar day is malformed, and a malformed schedule produces no occurrences.
 * It never throws and never guesses. Every case uses fixed UTC instants.
 *
 * @module @agentix-e/db-operations-node/maintenance/__tests__
 */

import { describe, it, expect } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { MaintenanceWindow } from '../interfaces/IMaintenanceScheduler.js';

const DAY_MS = 86_400_000;

/** Monday 2026-11-16 00:00 UTC. */
const MONDAY = Date.UTC(2026, 10, 16, 0, 0, 0, 0);

function windowOf(overrides: Partial<MaintenanceWindow>): MaintenanceWindow {
  return {
    id: 'w',
    name: 'w',
    operationType: 'VACUUM',
    targets: [],
    owner: 'test-owner',
    recurrence: 'daily',
    priority: 5,
    maxDurationMin: 30,
    requiresApproval: false,
    ...overrides,
  };
}

describe('AC 55 — start time and calendar day validation', () => {
  it.each([
    ['25:00', 'an hour past the end of the day'],
    ['24:00', 'midnight spelled as the 24th hour rolls to the next day'],
    ['23:60', 'a minute past the end of the hour'],
    ['-1:00', 'a negative hour'],
    ['03:-5', 'a negative minute'],
    ['3.5:00', 'a fractional hour'],
  ])('AC 55.1: startTime %s is malformed (%s)', (startTime) => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'daily', startTime }));

    expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 2 * DAY_MS)).toEqual([]);
  });

  it('AC 55.2: weekly and monthly reject the same out-of-range times', () => {
    const weekly = new MaintenanceWindowScheduler();
    weekly.registerWindow(windowOf({ recurrence: 'weekly', startTime: '25:00', daysOfWeek: ['mon'] }));
    expect(weekly.getUpcomingOccurrences(MONDAY, MONDAY + 7 * DAY_MS)).toEqual([]);

    const monthly = new MaintenanceWindowScheduler();
    monthly.registerWindow(windowOf({ recurrence: 'monthly', startTime: '23:60', daysOfMonth: [16] }));
    expect(monthly.getUpcomingOccurrences(MONDAY, MONDAY + 45 * DAY_MS)).toEqual([]);
  });

  it('AC 55.3: the edges of the day are still valid times', () => {
    for (const startTime of ['00:00', '23:59', '0:00', '7:05']) {
      const scheduler = new MaintenanceWindowScheduler();
      scheduler.registerWindow(windowOf({ recurrence: 'daily', startTime }));

      const occurrences = scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 2 * DAY_MS);

      expect(occurrences.length).toBeGreaterThanOrEqual(1);
      const [hour, minute] = startTime.split(':').map(Number) as [number, number];
      for (const occurrence of occurrences) {
        const date = new Date(occurrence.start);
        expect(date.getUTCHours()).toBe(hour);
        expect(date.getUTCMinutes()).toBe(minute);
      }
    }
  });

  it('AC 55.4: a day-of-month of 0 does not fire on the last day of the previous month', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'monthly', startTime: '06:00', daysOfMonth: [0] }));

    // 45 days from 16 November reaches 30 December: `Date.UTC(2026, 11, 0)` is
    // 30 November, a date this window never asked for.
    expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 45 * DAY_MS)).toEqual([]);
  });

  it('AC 55.5: days outside 1..31 are ignored, valid days still fire', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'monthly', startTime: '06:00', daysOfMonth: [0, 15, 99] }));

    // 1 November → 16 December covers the 15th of both months, and nothing else.
    const occurrences = scheduler.getUpcomingOccurrences(
      Date.UTC(2026, 10, 1, 0, 0, 0, 0),
      Date.UTC(2026, 11, 16, 0, 0, 0, 0),
    );

    expect(occurrences.map((o) => new Date(o.start).getUTCDate())).toEqual([15, 15]);
  });

  it('AC 55.6: a monthly window whose every entry is invalid projects nothing', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(windowOf({ recurrence: 'monthly', startTime: '06:00', daysOfMonth: [0, -3, 99] }));

    expect(scheduler.getUpcomingOccurrences(MONDAY, MONDAY + 120 * DAY_MS)).toEqual([]);
  });
});
