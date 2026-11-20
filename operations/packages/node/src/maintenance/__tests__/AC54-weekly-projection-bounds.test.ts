/**
 * AC 54 — Weekly projection must not advertise an occurrence that already began.
 *
 * `getUpcomingOccurrences(fromMs, toMs)` returns occurrences whose *start* lies
 * in `[fromMs, toMs)`. The daily, monthly, once and cron projections all honour
 * that lower bound. The weekly projection aligned its cursor to `HH:MM` on the
 * range-start day and emitted it unconditionally, so a caller asking at 23:58
 * for a `23:00` weekly window was told the window of 58 minutes ago was still
 * ahead of it. That both inflates the projection and hands operators a start
 * time in the past.
 *
 * Every case here is pinned to explicit UTC instants: a projection test that
 * derives its inputs from `Date.now()` passes for most of the day and fails in
 * the late evening, which is precisely how the defect reached CI.
 *
 * @module @agentix-e/db-operations-node/maintenance/__tests__
 */

import { describe, it, expect } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { DayOfWeek, MaintenanceWindow } from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Sunday 2026-11-15 23:58 UTC — late enough that a 23:00 window is in the past. */
const LATE_SUNDAY = Date.UTC(2026, 10, 15, 23, 58, 0, 0);

const WEEKDAY_NAMES: readonly DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** UTC weekday name of an instant, derived the same way the projection does. */
function weekdayOf(ms: number): DayOfWeek {
  return WEEKDAY_NAMES[new Date(ms).getUTCDay()]!;
}

function weeklyWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: overrides.id ?? 'weekly-1',
    name: 'weekly',
    operationType: 'VACUUM',
    targets: [],
    owner: 'test-owner',
    recurrence: 'weekly',
    startTime: '23:00',
    priority: 5,
    maxDurationMin: 30,
    requiresApproval: false,
    ...overrides,
  };
}

describe('AC 54 — weekly projection lower bound', () => {
  it('AC 54.1: a start time already passed today is not reported as upcoming', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: [weekdayOf(LATE_SUNDAY)] }));

    const occurrences = scheduler.getUpcomingOccurrences(LATE_SUNDAY, LATE_SUNDAY + 7 * DAY_MS);

    // Exactly the occurrence of next week — never the one 58 minutes ago.
    expect(occurrences).toHaveLength(1);
    const expected = Date.UTC(2026, 10, 22, 23, 0, 0, 0);
    expect(occurrences[0]!.start).toBe(expected);
    expect(occurrences[0]!.start).toBeGreaterThan(LATE_SUNDAY);
  });

  it('AC 54.2: a start time equal to the range start is included (inclusive lower bound)', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const from = Date.UTC(2026, 10, 15, 23, 0, 0, 0);
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: [weekdayOf(from)] }));

    const occurrences = scheduler.getUpcomingOccurrences(from, from + 7 * DAY_MS);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.start).toBe(from);
  });

  it('AC 54.3: no projected start precedes the range start, for every hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 30, 59]) {
        const from = Date.UTC(2026, 10, 15, hour, minute, 0, 0);
        const scheduler = new MaintenanceWindowScheduler();
        scheduler.registerWindow(weeklyWindow({ daysOfWeek: [weekdayOf(from)] }));

        const occurrences = scheduler.getUpcomingOccurrences(from, from + 7 * DAY_MS);

        for (const occurrence of occurrences) {
          expect(occurrence.start).toBeGreaterThanOrEqual(from);
        }
        // A weekly window on today's weekday always has its next firing inside
        // the following seven days, whatever the wall clock says.
        expect(occurrences.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('AC 54.4: a window that started earlier but is still running is not upcoming either', () => {
    const scheduler = new MaintenanceWindowScheduler();
    // 23:00 start with a 120 minute duration is still running at 23:58, yet its
    // start is in the past: `getUpcomingOccurrences` answers about starts.
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: [weekdayOf(LATE_SUNDAY)], maxDurationMin: 120 }));

    const [first] = scheduler.getUpcomingOccurrences(LATE_SUNDAY, LATE_SUNDAY + 7 * DAY_MS);

    expect(first).toBeDefined();
    expect(first!.start).toBe(Date.UTC(2026, 10, 22, 23, 0, 0, 0));
    expect(first!.end).toBe(Date.UTC(2026, 10, 23, 1, 0, 0, 0));
  });

  it('AC 54.5: daily projection keeps the same lower bound (reference behaviour)', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ recurrence: 'daily' }));

    const occurrences = scheduler.getUpcomingOccurrences(LATE_SUNDAY, LATE_SUNDAY + 3 * DAY_MS);

    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(occurrence.start).toBeGreaterThanOrEqual(LATE_SUNDAY);
    }
  });

  it('AC 54.6: several weekdays still project every firing inside the range', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: ['mon', 'wed', 'fri'] }));

    // Mon 2026-11-16 00:00 → Mon 2026-11-23 00:00 covers Mon/Wed/Fri twice.
    const from = Date.UTC(2026, 10, 16, 0, 0, 0, 0);
    const occurrences = scheduler.getUpcomingOccurrences(from, from + 7 * DAY_MS);

    expect(occurrences.map((o) => o.start)).toEqual([
      Date.UTC(2026, 10, 16, 23, 0, 0, 0),
      Date.UTC(2026, 10, 18, 23, 0, 0, 0),
      Date.UTC(2026, 10, 20, 23, 0, 0, 0),
    ]);
  });

  it('AC 54.7: a range that opens after the only firing of the week returns nothing', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: ['sun'] }));

    // Sunday 23:59 → Monday 23:59: Sunday's 23:00 has passed, next is 7 days out.
    const from = Date.UTC(2026, 10, 15, 23, 59, 0, 0);
    expect(scheduler.getUpcomingOccurrences(from, from + DAY_MS)).toHaveLength(0);
  });

  it('AC 54.8: the projection is stable when re-run (no duplicate instances)', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: [weekdayOf(LATE_SUNDAY)] }));

    const first = scheduler.getUpcomingOccurrences(LATE_SUNDAY, LATE_SUNDAY + 7 * DAY_MS);
    const second = scheduler.getUpcomingOccurrences(LATE_SUNDAY, LATE_SUNDAY + 7 * DAY_MS);

    expect(second).toEqual(first);
    expect(scheduler.getWindowInstances('weekly-1')).toHaveLength(first.length);
  });

  it('AC 54.9: a sub-day range on the firing day still reports the firing once', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ daysOfWeek: ['sun'] }));

    const from = Date.UTC(2026, 10, 15, 22, 0, 0, 0);
    const occurrences = scheduler.getUpcomingOccurrences(from, from + MINUTE_MS * 90);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.start).toBe(Date.UTC(2026, 10, 15, 23, 0, 0, 0));
  });

  it('AC 54.10: `once` honours the lower bound exactly', () => {
    const from = Date.UTC(2026, 10, 15, 12, 0, 0, 0);

    const including = new MaintenanceWindowScheduler();
    including.registerWindow(weeklyWindow({ recurrence: 'once', at: new Date(from).toISOString() }));
    const atBound = including.getUpcomingOccurrences(from, from + DAY_MS);
    expect(atBound).toHaveLength(1);
    expect(atBound[0]!.start).toBe(from);

    const excluding = new MaintenanceWindowScheduler();
    excluding.registerWindow(weeklyWindow({ recurrence: 'once', at: new Date(from - 1).toISOString() }));
    expect(excluding.getUpcomingOccurrences(from, from + DAY_MS)).toHaveLength(0);
  });

  it('AC 54.11: daily projection honours the lower bound for every hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const from = Date.UTC(2026, 10, 15, hour, 0, 0, 0);
      const scheduler = new MaintenanceWindowScheduler();
      scheduler.registerWindow(weeklyWindow({ recurrence: 'daily', startTime: '03:00' }));

      const occurrences = scheduler.getUpcomingOccurrences(from, from + 2 * DAY_MS);

      expect(occurrences.length).toBeGreaterThanOrEqual(1);
      for (const occurrence of occurrences) {
        expect(occurrence.start).toBeGreaterThanOrEqual(from);
        expect(new Date(occurrence.start).getUTCHours()).toBe(3);
      }
    }
  });

  it('AC 54.12: monthly projection honours the lower bound', () => {
    const scheduler = new MaintenanceWindowScheduler();
    // 06:00 on the 15th, asked about at 07:00 on the 15th: today's firing is past.
    scheduler.registerWindow(weeklyWindow({ recurrence: 'monthly', startTime: '06:00', daysOfMonth: [15] }));

    const from = Date.UTC(2026, 10, 15, 7, 0, 0, 0);
    const occurrences = scheduler.getUpcomingOccurrences(from, from + 45 * DAY_MS);

    expect(occurrences.map((o) => o.start)).toEqual([Date.UTC(2026, 11, 15, 6, 0, 0, 0)]);
  });

  it('AC 54.13: cron projection honours the lower bound', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(weeklyWindow({ recurrence: 'cron', cronExpression: '0 6 * * *' }));

    // 07:00 on the 15th: the 06:00 firing of today is past.
    const from = Date.UTC(2026, 10, 15, 7, 0, 0, 0);
    const occurrences = scheduler.getUpcomingOccurrences(from, from + 2 * DAY_MS + 3_600_000);

    expect(occurrences.map((o) => o.start)).toEqual([
      Date.UTC(2026, 10, 16, 6, 0, 0, 0),
      Date.UTC(2026, 10, 17, 6, 0, 0, 0),
    ]);
  });
});
