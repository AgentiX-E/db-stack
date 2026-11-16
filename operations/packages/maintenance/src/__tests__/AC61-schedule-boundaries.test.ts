/**
 * AC 61 — the boundaries a scheduler mutant can hide in.
 *
 * Every case here exists because a surviving mutant named it: a comparison that
 * could flip by one without any test noticing. They are the cheapest form of
 * coverage a time-based scheduler can have, and the most valuable, because an
 * off-by-one in a projection is not a wrong answer — it is a maintenance window
 * that fires an hour early or a run that is silently never scheduled.
 *
 * The mutators that produced these cases:
 *
 *   - `a.start < b.end` -> `<=` : intervals that touch must not conflict;
 *   - `b.priority > 5` -> `>=` : priority 5 is not "high";
 *   - `start < toMs` -> `<=`   : `toMs` is exclusive, which the interface says;
 *   - `cursor >= fromMs` -> `true` : a cron minute truncated below the range
 *     start is not an upcoming occurrence;
 *   - `cursorTime < fromMs` -> `<=` : a window starting exactly at `fromMs` is
 *     inside the range, not one day later;
 *   - `nextInstanceId++` -> `--` : instance ids must not be reused.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { MaintenanceWindow, WindowOccurrence } from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** UTC midnight, so every `startTime` below lands on a whole minute. */
const NOW = Date.UTC(2026, 10, 16, 0, 0, 0, 0);

function window(overrides: Partial<MaintenanceWindow> & { id: string }): MaintenanceWindow {
  return {
    name: overrides.id,
    operationType: 'VACUUM',
    targets: ['orders'],
    recurrence: 'once',
    at: new Date(NOW + HOUR_MS).toISOString(),
    priority: 5,
    owner: 'dba',
    maxDurationMin: 60,
    requiresApproval: false,
    ...overrides,
  };
}

function occurrence(overrides: Partial<WindowOccurrence> = {}): WindowOccurrence {
  return {
    windowId: 'w1',
    instanceId: 'i1',
    start: NOW,
    end: NOW + HOUR_MS,
    recurrence: 'once',
    priority: 5,
    ...overrides,
  };
}

describe('AC 61 — overlap boundaries', () => {
  it('AC 61.1: an interval starting exactly where the other ends does not overlap, in either order', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const early = occurrence({ start: NOW, end: NOW + HOUR_MS });
    const late = occurrence({ instanceId: 'i2', start: NOW + HOUR_MS, end: NOW + 2 * HOUR_MS });

    // `early.start < late.end` is the only comparison that separates touching
    // from overlapping, and it has to hold with the arguments either way round.
    expect(scheduler.checkConflict(early, late).hasConflict).toBe(false);
    expect(scheduler.checkConflict(late, early).hasConflict).toBe(false);

    const single = occurrence({ instanceId: 'i3', start: NOW + 15 * MINUTE_MS, end: NOW + 2 * HOUR_MS });
    expect(scheduler.checkConflict(single, early).hasConflict).toBe(true);
    expect(scheduler.checkConflict(early, single).hasConflict).toBe(true);
  });

  it('AC 61.2: priority 5 is not high, 6 is', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const a = occurrence({ windowId: 'a', instanceId: 'ia', start: NOW, end: NOW + HOUR_MS });
    const b = occurrence({
      windowId: 'b',
      instanceId: 'ib',
      start: NOW + 30 * MINUTE_MS,
      end: NOW + 2 * HOUR_MS,
    });

    // Both above five: coexist. One at five: defer.
    expect(scheduler.checkConflict({ ...a, priority: 5 }, { ...b, priority: 5 }).recommendation).toBe('split');
    expect(scheduler.checkConflict({ ...a, priority: 5 }, { ...b, priority: 9 }).recommendation).toBe('defer');
    expect(scheduler.checkConflict({ ...a, priority: 6 }, { ...b, priority: 6 }).recommendation).toBe('coexist');
    expect(scheduler.checkConflict({ ...a, priority: 6 }, { ...b, priority: 5 }).recommendation).toBe('defer');
  });
});

describe('AC 61 — projection boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 61.3: a one-shot window at exactly fromMs is inside, at exactly toMs is outside', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'edges', at: new Date(NOW).toISOString() }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + HOUR_MS)).toHaveLength(1);
    expect(scheduler.getUpcomingOccurrences(NOW - HOUR_MS, NOW)).toHaveLength(0);
  });

  it('AC 61.4: a one-shot window whose `at` cannot be read produces nothing', () => {
    const scheduler = new MaintenanceWindowScheduler();
    // `at` is required but not parsed at registration; an unreadable value must
    // not turn into an occurrence at `NaN`.
    scheduler.registerWindow(window({ id: 'garbled', at: 'not-a-timestamp' }));

    expect(scheduler.getUpcomingOccurrences(NOW, NOW + DAY_MS)).toEqual([]);
  });

  it('AC 61.5: a daily window starting exactly at fromMs fires today, not tomorrow', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'daily', recurrence: 'daily', startTime: '00:00' }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 2 * DAY_MS);

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.start).toBe(NOW);
  });

  it('AC 61.6: a monthly window includes a candidate at fromMs and excludes one at toMs', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'monthly', recurrence: 'monthly', startTime: '00:00', daysOfMonth: [16] }));

    const atFrom = scheduler.getUpcomingOccurrences(NOW, NOW + DAY_MS);
    expect(atFrom).toHaveLength(1);
    expect(atFrom[0]!.start).toBe(NOW);

    // Same date, but the range ends where the candidate starts.
    const beforeTo = scheduler.getUpcomingOccurrences(NOW - DAY_MS, NOW);
    expect(beforeTo).toEqual([]);
  });

  it('AC 61.7: a monthly window rolls over from December into January', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'roll', recurrence: 'monthly', startTime: '02:00', daysOfMonth: [1] }));

    // 2026-11-16 .. 2027-02-16 spans the year boundary.
    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 92 * DAY_MS);
    const starts = occurrences.map((occ) => new Date(occ.start).toISOString());

    expect(starts).toContain('2026-12-01T02:00:00.000Z');
    expect(starts).toContain('2027-01-01T02:00:00.000Z');
    expect(starts).toContain('2027-02-01T02:00:00.000Z');
  });

  it('AC 61.8: a monthly window clamps day 31 into a short month', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'short', recurrence: 'monthly', startTime: '00:00', daysOfMonth: [31] }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 120 * DAY_MS);
    const starts = occurrences.map((occ) => new Date(occ.start).toISOString());

    // November has 30 days, so the November run lands on the 30th; December and
    // January keep the 31st.
    expect(starts).toContain('2026-11-30T00:00:00.000Z');
    expect(starts).toContain('2026-12-31T00:00:00.000Z');
    expect(starts).toContain('2027-01-31T00:00:00.000Z');
  });

  it('AC 61.9: a weekly window excludes an occurrence exactly at toMs', () => {
    // 2026-11-16 is a Monday.
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'weekly', recurrence: 'weekly', startTime: '00:00', daysOfWeek: ['mon'] }));

    const inside = scheduler.getUpcomingOccurrences(NOW, NOW + 7 * DAY_MS);
    expect(inside.map((occ) => occ.start)).toEqual([NOW]);

    const exclusive = scheduler.getUpcomingOccurrences(NOW, NOW);
    expect(exclusive).toEqual([]);
  });

  it('AC 61.10: a cron window does not report a minute truncated below the range start', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'cron', recurrence: 'cron', cronExpression: '* * * * *' }));

    // The scan starts at :30:00 — the minute containing :30:45 — and that
    // instant is in the past. Reporting it would hand the caller a start time it
    // cannot use.
    const from = NOW + 30 * MINUTE_MS + 45_000;
    const occurrences = scheduler.getUpcomingOccurrences(from, from + 2 * MINUTE_MS);

    expect(occurrences[0]!.start).toBe(NOW + 31 * MINUTE_MS);
    for (const occ of occurrences) {
      expect(occ.start % MINUTE_MS).toBe(0);
      expect(occ.start).toBeGreaterThanOrEqual(from);
    }
  });
});

describe('AC 61 — instance identity and counters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 61.11: instance ids are allocated once and never reused', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'one' }));
    scheduler.registerWindow(window({ id: 'two', at: new Date(NOW + 2 * HOUR_MS).toISOString() }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 4 * HOUR_MS);
    const ids = occurrences.map((occ) => occ.instanceId);

    expect(ids).toEqual(['inst-1', 'inst-2']);

    // A repeated projection reuses the instances it already made; it does not
    // mint new ones, and it does not hand out an id that was used before.
    const again = scheduler.getUpcomingOccurrences(NOW, NOW + 4 * HOUR_MS);
    expect(again.map((occ) => occ.instanceId)).toEqual(ids);

    const forced = scheduler.forceStart('two');
    expect(forced.id).toBe('inst-3');
  });

  it('AC 61.12: getStats counts every state it documents', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'done', at: new Date(NOW + HOUR_MS).toISOString() }));
    scheduler.registerWindow(window({ id: 'broken', at: new Date(NOW + 2 * HOUR_MS).toISOString() }));
    scheduler.registerWindow(
      window({ id: 'awaiting', at: new Date(NOW + 3 * HOUR_MS).toISOString(), requiresApproval: true }),
    );
    scheduler.registerWindow(window({ id: 'running', at: new Date(NOW + 4 * HOUR_MS).toISOString() }));

    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 6 * HOUR_MS);
    const instanceOf = (windowId: string): string => occurrences.find((occ) => occ.windowId === windowId)!.instanceId;

    scheduler.completeWindow(instanceOf('done'));
    scheduler.failWindow(instanceOf('broken'), 'vacuum was killed');
    // `in_progress` is set by the executor, which this scheduler does not own;
    // it is counted as active, and that is what the assertion below pins.
    scheduler.forceStart('running');

    const stats = scheduler.getStats();

    expect(stats.totalWindows).toBe(4);
    expect(stats.completedInstances).toBe(1);
    expect(stats.failedInstances).toBe(1);
    expect(stats.cancelledInstances).toBe(0);
    expect(stats.pendingApprovals).toBe(1);
    // 'done' completed (not active), 'broken' failed (not active), 'awaiting'
    // is pending (not active), 'running' has a scheduled instance plus the
    // forced one.
    expect(stats.activeWindows).toBe(2);
  });

  it('AC 61.13: terminal transitions refuse to overwrite each other, and say which state refused', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'terminal', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    const instanceId = scheduler.getUpcomingOccurrences(NOW, NOW + HOUR_MS)[0]!.instanceId;

    scheduler.cancelWindow(instanceId, 'operator cancelled');

    expect(() => scheduler.cancelWindow(instanceId, 'again')).toThrow(/cancelled/);
    expect(() => scheduler.completeWindow(instanceId)).toThrow(/cancelled/);
    expect(() => scheduler.failWindow(instanceId, 'late')).toThrow(/cancelled/);

    // A completed instance keeps its failure reason and cannot be finished twice.
    scheduler.registerWindow(window({ id: 'second', at: new Date(NOW + 2 * HOUR_MS).toISOString() }));
    const secondId = scheduler
      .getUpcomingOccurrences(NOW, NOW + 4 * HOUR_MS)
      .find((occ) => occ.windowId === 'second')!.instanceId;
    scheduler.completeWindow(secondId);
    expect(() => scheduler.completeWindow(secondId)).toThrow(/completed/);
    expect(() => scheduler.cancelWindow(secondId, 'too late')).toThrow(/completed/);
  });

  it('AC 61.14: failWindow keeps the reason, completeWindow does not invent one', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'f1' }));
    scheduler.registerWindow(window({ id: 'c1', at: new Date(NOW + 2 * HOUR_MS).toISOString() }));
    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 4 * HOUR_MS);
    const failId = occurrences.find((occ) => occ.windowId === 'f1')!.instanceId;
    const completeId = occurrences.find((occ) => occ.windowId === 'c1')!.instanceId;

    expect(scheduler.failWindow(failId, 'disk full').error).toBe('disk full');
    expect(scheduler.completeWindow(completeId).error).toBeUndefined();
  });
});

describe('AC 61 — cron fields at their edges, and a terminal state that stays terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const minutesOf = (cronExpression: string, hours: number): number[] => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'c', recurrence: 'cron', cronExpression }));
    scheduler.getUpcomingOccurrences(NOW, NOW + hours * HOUR_MS);
    const minutes = scheduler.getWindowInstances('c').map((run) => new Date(run.scheduledStart!).getUTCMinutes());
    return [...new Set(minutes)].sort((a, b) => a - b);
  };

  it('AC 61.15: `*` fills the field up to and including its maximum', () => {
    // Hour 23 is the last hour a cron field can name, and every minute of it
    // must be present — a `*` expansion that stops one short loses 23:59.
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'all-hours', recurrence: 'cron', cronExpression: '* 23 * * *' }));
    scheduler.getUpcomingOccurrences(NOW, NOW + 2 * DAY_MS);
    const starts = scheduler.getWindowInstances('all-hours').map((run) => new Date(run.scheduledStart!));
    const minutes = starts.filter((d) => d.getUTCHours() === 23).map((d) => d.getUTCMinutes());

    expect(minutes).toContain(0);
    expect(minutes).toContain(59);
    expect(new Set(minutes).size).toBe(60);
  });

  it('AC 61.16: a step from a single start value counts from that value', () => {
    // `10/20` means "10, 30, 50" — not "10 only", and not "every 20th minute".
    expect(minutesOf('10/20 * * * *', 2)).toEqual([10, 30, 50]);
  });

  it('AC 61.17: a step whose range ends at the field maximum includes the maximum', () => {
    expect(minutesOf('0-59/59 * * * *', 2)).toEqual([0, 59]);
    expect(minutesOf('*/30 * * * *', 2)).toEqual([0, 30]);
  });

  it('AC 61.18: a malformed step is skipped, not thrown, and not silently widened', () => {
    // `/5` has no range, `*/x` has a step that is not a number, `1-5/x` has both.
    for (const bad of ['/5 * * * *', '*/x * * * *', '1-5/x * * * *', '1- * * * *']) {
      const scheduler = new MaintenanceWindowScheduler();
      scheduler.registerWindow(window({ id: 'bad', recurrence: 'cron', cronExpression: bad }));
      expect(() => scheduler.getUpcomingOccurrences(NOW, NOW + 2 * HOUR_MS), bad).not.toThrow();
      // Nothing matched, so nothing is scheduled: a malformed field is not an
      // implicit `*`.
      expect(scheduler.getWindowInstances('bad'), bad).toHaveLength(0);
    }
  });

  it('AC 61.19: finishing a failed instance twice is refused, and says so', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'again', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    const instanceId = scheduler.getUpcomingOccurrences(NOW, NOW + HOUR_MS)[0]!.instanceId;

    scheduler.failWindow(instanceId, 'first failure');

    // The guard covers `failed` as well as `completed`; a suite that only
    // double-completes a completed run leaves half of it unconstrained.
    expect(() => scheduler.completeWindow(instanceId)).toThrow(/failed/);
    expect(() => scheduler.failWindow(instanceId, 'second failure')).toThrow(/failed/);
    expect(scheduler.getInstanceState(instanceId)!.error).toBe('first failure');
  });

  it('AC 61.20: completing an instance twice is refused, and says so', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'once-more', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    const instanceId = scheduler.getUpcomingOccurrences(NOW, NOW + HOUR_MS)[0]!.instanceId;

    scheduler.completeWindow(instanceId);
    expect(() => scheduler.failWindow(instanceId, 'late')).toThrow(/completed/);
  });
});
