/**
 * AC 63 — the cron grammar, tested as a grammar.
 *
 * The cron parser used to live inside `MaintenanceWindowScheduler` and was only
 * ever exercised through occurrence projection. That is a test of the *scheduler*
 * with the grammar as a side effect, and it cannot distinguish "this expression
 * names the wrong minutes" from "this window never fires": both produce zero
 * occurrences. Seventeen mutants survived there for that reason — bounds that
 * could be flipped, a step that could stop stepping, a clamp that could be
 * dropped, none of them visible through a projection.
 *
 * So the grammar is a module (`impl/cron.ts`) and these cases name the values a
 * field resolves to, not the occurrences that follow from them. Each group below
 * is one form of the grammar: a literal, a range, a stepped range, a list, and
 * the malformed input that must be inert rather than throw.
 *
 * Nothing here asserts on an error message it does not read: a field that names
 * nothing yields an empty set, which is the contract, and only a field *count*
 * below five is an error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseCron, parseCronField } from '../impl/cron.js';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { MaintenanceWindow } from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 10, 16, 0, 0, 0, 0);

/** Sorted values, so an assertion reads as the set it is asserting on. */
function values(field: string, min: number, max: number): number[] {
  return [...parseCronField(field, min, max)].sort((a, b) => a - b);
}

function range(min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value++) out.push(value);
  return out;
}

function window(overrides: Partial<MaintenanceWindow> & { id: string }): MaintenanceWindow {
  return {
    name: overrides.id,
    operationType: 'VACUUM',
    targets: ['orders'],
    recurrence: 'cron',
    priority: 5,
    owner: 'platform',
    maxDurationMin: 30,
    requiresApproval: false,
    ...overrides,
  };
}

describe('AC 63 — cron field grammar', () => {
  describe('a star names the whole field', () => {
    it('names every minute for minutes', () => {
      expect(values('*', 0, 59)).toEqual(range(0, 59));
    });

    it('starts at the field minimum, not at zero', () => {
      // Days of the month begin at 1; a star that started at 0 would name a day
      // that does not exist and shift the whole clamp below by one.
      expect(values('*', 1, 31)).toEqual(range(1, 31));
    });

    it('names exactly the seven weekdays', () => {
      expect(values('*', 0, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  describe('a literal names one value, and only inside the field', () => {
    it('keeps a value inside the range', () => {
      expect(values('30', 0, 59)).toEqual([30]);
    });

    it('drops a value above the maximum', () => {
      expect(values('60', 0, 59)).toEqual([]);
    });

    it('drops a value below the minimum', () => {
      // `0` is a minute but not a day of the month.
      expect(values('0', 1, 31)).toEqual([]);
    });

    it('drops a month of 13 and a weekday of 7', () => {
      expect(values('13', 1, 12)).toEqual([]);
      expect(values('7', 0, 6)).toEqual([]);
    });

    it('drops a word', () => {
      expect(values('mon', 0, 6)).toEqual([]);
    });
  });

  describe('a range is inclusive and clamped at both ends', () => {
    it('includes both bounds', () => {
      expect(values('10-15', 0, 59)).toEqual([10, 11, 12, 13, 14, 15]);
    });

    it('clamps the upper bound to the field maximum', () => {
      // `0-70` names 60 minutes, not 71: an hour has 59 as its last minute.
      expect(values('0-70', 0, 59)).toEqual(range(0, 59));
    });

    it('clamps the lower bound to the field minimum', () => {
      expect(values('0-5', 1, 31)).toEqual([1, 2, 3, 4, 5]);
    });

    it('names nothing when the bounds are reversed', () => {
      expect(values('5-3', 0, 59)).toEqual([]);
    });

    it('names one value when both bounds are equal', () => {
      expect(values('3-3', 0, 59)).toEqual([3]);
    });

    it('names nothing when the upper bound is missing', () => {
      expect(values('5-', 0, 59)).toEqual([]);
    });

    it('names nothing when the whole part is a dash', () => {
      expect(values('-', 0, 59)).toEqual([]);
    });
  });

  describe('a stepped range walks its range and stops at the field maximum', () => {
    it('walks the whole field', () => {
      expect(values('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
    });

    it('walks every value when the step is one', () => {
      expect(values('*/1', 0, 59)).toEqual(range(0, 59));
    });

    it('drops stepped values above the maximum', () => {
      // 60, 65 and 70 are not minutes.
      expect(values('0-70/5', 0, 59)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    });

    it('drops stepped values below the minimum', () => {
      // Day 0 of a month does not exist. The stride stays anchored where the
      // expression put it — 0, 2, 4 — and the clamp drops 0 afterwards, so the
      // answer is 2 and 4, not 1, 3, 5 shifted up by the clamp.
      expect(values('0-5/2', 1, 31)).toEqual([2, 4]);
    });

    it('walks from a single start to the field maximum', () => {
      expect(values('10/20', 0, 59)).toEqual([10, 30, 50]);
    });

    it('walks an explicit range', () => {
      expect(values('5-10/2', 0, 59)).toEqual([5, 7, 9]);
    });

    it('names nothing for a step of zero', () => {
      // A zero step is a typo, not "every value": iterating it never advances.
      expect(values('*/0', 0, 59)).toEqual([]);
    });

    it('names nothing for a step that is not a number', () => {
      expect(values('*/x', 0, 59)).toEqual([]);
    });

    it('names nothing when the step is missing', () => {
      expect(values('*/', 0, 59)).toEqual([]);
    });

    it('names nothing when the range is missing', () => {
      // A leading slash names no range to walk.
      expect(values('/5', 0, 59)).toEqual([]);
    });

    it('reads the step from the last separator, not from the digits that follow it', () => {
      // `*/2/3` has two slashes. The step is what comes after the first one, so
      // this is step 2 with a stray `/3` attached — not step 23. Joining the tail
      // without its separator would silently turn 2 into 23 and walk every
      // twenty-third minute instead of every second one.
      expect(values('*/2/3', 0, 59)).toEqual(range(0, 59).filter((value) => value % 2 === 0));
    });

    it('reads a range bound from the last separator as well', () => {
      // Same shape without a step: `1-5-9` is 1..5 with a stray `-9`, and
      // `parseInt('5')` is 5 where `parseInt('59')` is 59.
      expect(values('1-5-9', 0, 59)).toEqual([1, 2, 3, 4, 5]);
    });

    it('reads a stepped range bound from the last separator as well', () => {
      expect(values('10-15-20/2', 0, 59)).toEqual([10, 12, 14]);
    });
  });

  describe('a list unions its parts', () => {
    it('unions literals', () => {
      expect(values('1,5,10', 0, 59)).toEqual([1, 5, 10]);
    });

    it('unions a range with a literal', () => {
      expect(values('10-12,20', 0, 59)).toEqual([10, 11, 12, 20]);
    });

    it('unions a star with a literal without duplicating it', () => {
      const every = values('*,30', 0, 59);
      expect(every).toEqual(range(0, 59));
    });

    it('does not duplicate a repeated literal', () => {
      expect(values('30,30', 0, 59)).toEqual([30]);
    });

    it('names nothing for an empty field', () => {
      expect(values('', 0, 59)).toEqual([]);
    });

    it('names nothing for a field of separators', () => {
      expect(values(',', 0, 59)).toEqual([]);
    });
  });

  describe('a five-field expression maps to five fields', () => {
    it('reads each position', () => {
      const schedule = parseCron('*/15 0-6 1,15 * 1-5');
      expect([...schedule.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
      expect([...schedule.hours].sort((a, b) => a - b)).toEqual(range(0, 6));
      expect([...schedule.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
      expect([...schedule.months].sort((a, b) => a - b)).toEqual(range(1, 12));
      expect([...schedule.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('tolerates surrounding and repeated whitespace', () => {
      const schedule = parseCron('  0\t3  *  *  *  ');
      expect([...schedule.minutes]).toEqual([0]);
      expect([...schedule.hours]).toEqual([3]);
    });

    it('ignores a sixth field', () => {
      // Dialects with a year field put it last; a scheduler that implements five
      // fields reads five and ignores the rest rather than misreading position 6.
      const schedule = parseCron('0 0 1 1 0 2026');
      expect([...schedule.daysOfMonth]).toEqual([1]);
      expect([...schedule.months]).toEqual([1]);
      expect([...schedule.daysOfWeek]).toEqual([0]);
    });

    it('rejects four fields', () => {
      expect(() => parseCron('0 3 * *')).toThrow(/expected 5 fields/);
    });

    it('rejects an empty expression', () => {
      expect(() => parseCron('')).toThrow(/expected 5 fields/);
    });
  });
});

describe('AC 63 — the grammar as the scheduler uses it', () => {
  let scheduler: MaintenanceWindowScheduler;

  beforeEach(() => {
    scheduler = new MaintenanceWindowScheduler();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects the one minute an expression names', () => {
    scheduler.registerWindow(window({ id: 'nightly', cronExpression: '0 3 * * *' }));
    const occurrences = scheduler.getUpcomingOccurrences(
      NOW + 3 * 60 * MINUTE_MS - 2 * MINUTE_MS,
      NOW + 3 * 60 * MINUTE_MS + 2 * MINUTE_MS,
    );
    expect(occurrences.map((occurrence) => occurrence.start)).toEqual([NOW + 3 * 60 * MINUTE_MS]);
  });

  it('projects nothing for a day the calendar does not have', () => {
    // 30 February: the field parses, the date never exists.
    scheduler.registerWindow(window({ id: 'feb-30', cronExpression: '0 3 30 2 *' }));
    expect(scheduler.getUpcomingOccurrences(NOW, NOW + 24 * 60 * MINUTE_MS)).toEqual([]);
  });

  it('projects nothing for a minute the field does not have', () => {
    scheduler.registerWindow(window({ id: 'minute-60', cronExpression: '60 * * * *' }));
    expect(scheduler.getUpcomingOccurrences(NOW, NOW + 24 * 60 * MINUTE_MS)).toEqual([]);
  });

  it('stops scanning at the iteration cap rather than running to the end of the range', () => {
    // 200 days is 288 000 minutes; the scan is bounded to 100 000 of them, so an
    // hourly expression yields the hours inside the bound and no more. A cap that
    // never increments would report every hour of 200 days instead, which is how
    // this bound is observable at all.
    scheduler.registerWindow(window({ id: 'hourly', cronExpression: '0 * * * *' }));
    const occurrences = scheduler.getUpcomingOccurrences(NOW, NOW + 200 * 24 * 60 * MINUTE_MS);
    expect(occurrences.length).toBe(1667);
    expect(occurrences[occurrences.length - 1]!.start).toBe(NOW + 99_960 * MINUTE_MS);
  });
});
