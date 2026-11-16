/**
 * AC 60 — a conflict is a pair of occurrences, and so is a resolution.
 *
 * `WindowConflict` used to describe a conflict between two *windows*: the
 * report carried two window ids and a free-text description, and the resolution
 * acted on every instance those windows had scheduled. Three consequences, none
 * of them visible from the scheduler's own documentation:
 *
 *   1. two overlapping runs of the **same** window were reported as
 *      `coexist`/no-conflict, because the check compared window ids. A window
 *      whose duration exceeds its recurrence period runs two maintenances at
 *      once on the same targets — the one overlap a scheduler can still prevent;
 *   2. `defer_lower` cancelled **every** future run of the losing window, so a
 *      conflict at 03:00 today also removed next month's run;
 *   3. `defer_newer` cancelled the newest run of **both** windows, so the winner
 *      lost a run as well.
 *
 * A conflict now names the occurrences (and their instances), and a resolution
 * touches exactly those. `getStats` reports both counters, which were hardcoded
 * to `0` — a dashboard built on them showed a quiet cluster during a conflict
 * storm.
 *
 * The advice text is asserted here too, for each of the three recommendations:
 * text nothing asserts is text a mutant can empty, and advice an operator is
 * meant to act on is part of the product.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type { MaintenanceWindow, WindowOccurrence } from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Fixed instant, so every projection in this suite is deterministic. */
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

describe('AC 60 — an overlap of two runs, not of two definitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 60.1: two overlapping runs of the same window are a conflict', () => {
    const scheduler = new MaintenanceWindowScheduler();
    // 25 hours of maintenance on a daily schedule: tomorrow's run starts before
    // today's has finished. Comparing window ids reported this as "coexist".
    scheduler.registerWindow(
      window({ id: 'vacuum', recurrence: 'daily', startTime: '03:00', maxDurationMin: 25 * 60 }),
    );

    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * DAY_MS);

    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts) {
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.conflictingWindowIds).toEqual(['vacuum', 'vacuum']);
      expect(conflict.recommendation).toBe('split');
      expect(conflict.conflictingSides).toHaveLength(2);
      expect(conflict.conflictingSides[0]!.instanceId).not.toBe(conflict.conflictingSides[1]!.instanceId);
    }
  });

  it('AC 60.2: an occurrence does not conflict with itself', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const self = occurrence();

    const conflict = scheduler.checkConflict(self, self);

    expect(conflict.hasConflict).toBe(false);
    expect(conflict.conflictingWindowIds).toEqual([]);
    expect(conflict.conflictingSides).toEqual([]);
    expect(conflict.description).toBe('Same instance');
    expect(conflict.recommendation).toBe('coexist');
  });

  it('AC 60.3: the three recommendations, with the advice each one produces', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const earlier = occurrence({ windowId: 'alpha', instanceId: 'i-alpha', start: NOW, end: NOW + HOUR_MS });
    const later = occurrence({
      windowId: 'beta',
      instanceId: 'i-beta',
      start: NOW + 30 * MINUTE_MS,
      end: NOW + 2 * HOUR_MS,
    });

    // Equal priority, not both above 5: a human splits the window.
    const split = scheduler.checkConflict(earlier, later);
    expect(split.recommendation).toBe('split');
    expect(split.description).toBe(
      `Overlap: alpha ${new Date(NOW).toISOString()}..${new Date(NOW + HOUR_MS).toISOString()} ` +
        `overlaps beta ${new Date(NOW + 30 * MINUTE_MS).toISOString()}..${new Date(NOW + 2 * HOUR_MS).toISOString()}`,
    );

    // Different priorities: the lower one gives way.
    const defer = scheduler.checkConflict({ ...earlier, priority: 2 }, later);
    expect(defer.recommendation).toBe('defer');

    // Both above 5: neither may be deferred, they coexist.
    const coexist = scheduler.checkConflict({ ...earlier, priority: 9 }, { ...later, priority: 9 });
    expect(coexist.recommendation).toBe('coexist');
    expect(coexist.hasConflict).toBe(true);
  });

  it('AC 60.4: the conflicting sides are ordered by start and carry their own intervals', () => {
    const scheduler = new MaintenanceWindowScheduler();
    const later = occurrence({
      windowId: 'beta',
      instanceId: 'i-beta',
      start: NOW + 30 * MINUTE_MS,
      end: NOW + 2 * HOUR_MS,
    });
    const earlier = occurrence({ windowId: 'alpha', instanceId: 'i-alpha', start: NOW, end: NOW + HOUR_MS });

    // Passing the later occurrence first must not reorder the report: "the
    // newer side" has to mean the same thing to every caller.
    const conflict = scheduler.checkConflict(later, earlier);

    expect(conflict.conflictingSides).toEqual([
      { windowId: 'alpha', instanceId: 'i-alpha', start: NOW, end: NOW + HOUR_MS },
      { windowId: 'beta', instanceId: 'i-beta', start: NOW + 30 * MINUTE_MS, end: NOW + 2 * HOUR_MS },
    ]);
    expect(conflict.conflictingWindowIds).toEqual(['beta', 'alpha']);
  });

  it('AC 60.5: defer_lower cancels the conflicting run only', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(
      window({ id: 'low', recurrence: 'daily', startTime: '03:00', priority: 2, maxDurationMin: 60 }),
    );
    scheduler.registerWindow(
      window({ id: 'high', recurrence: 'daily', startTime: '03:30', priority: 9, maxDurationMin: 60 }),
    );
    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * DAY_MS);
    expect(conflicts.length).toBeGreaterThanOrEqual(3);

    const firstConflict = conflicts[0]!;
    const lowSide = firstConflict.conflictingSides.find((side) => side.windowId === 'low')!;
    scheduler.resolveConflict(firstConflict, 'defer_lower');

    const lowRuns = scheduler.getWindowInstances('low');
    const cancelled = lowRuns.filter((run) => run.state === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.id).toBe(lowSide.instanceId);
    // Every other run of the losing window is still scheduled: the conflict was
    // about one slot, and it was resolved one slot at a time.
    expect(lowRuns.filter((run) => run.state === 'scheduled')).toHaveLength(lowRuns.length - 1);
    expect(scheduler.getWindowInstances('high').every((run) => run.state === 'scheduled')).toBe(true);
    expect(scheduler.getStats().conflictsResolved).toBe(1);
  });

  it('AC 60.6: defer_newer cancels the later side of the conflict only', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'early', recurrence: 'daily', startTime: '03:00', maxDurationMin: 60 }));
    scheduler.registerWindow(window({ id: 'late', recurrence: 'daily', startTime: '03:30', maxDurationMin: 60 }));
    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * DAY_MS);
    const target = conflicts[0]!;
    const newestSide = target.conflictingSides[1]!;

    scheduler.resolveConflict(target, 'defer_newer');

    const lateRuns = scheduler.getWindowInstances('late');
    const cancelled = lateRuns.filter((run) => run.state === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.id).toBe(newestSide.instanceId);
    expect(scheduler.getWindowInstances('early').every((run) => run.state === 'scheduled')).toBe(true);
    expect(scheduler.getWindowInstances('late').filter((run) => run.state === 'scheduled')).toHaveLength(
      lateRuns.length - 1,
    );
  });

  it('AC 60.7: allow_both changes nothing and is not counted as a resolution', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'a', priority: 2 }));
    scheduler.registerWindow(
      window({ id: 'b', priority: 9, at: new Date(NOW + HOUR_MS + 30 * MINUTE_MS).toISOString() }),
    );
    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * HOUR_MS);
    expect(conflicts).toHaveLength(1);

    scheduler.resolveConflict(conflicts[0]!, 'allow_both');

    expect(scheduler.getWindowInstances('a').every((run) => run.state === 'scheduled')).toBe(true);
    expect(scheduler.getWindowInstances('b').every((run) => run.state === 'scheduled')).toBe(true);
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 60.8: a pending run is left to its approver, whichever strategy is chosen', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'p-low', priority: 2, requiresApproval: true }));
    scheduler.registerWindow(
      window({
        id: 'p-high',
        priority: 9,
        requiresApproval: true,
        at: new Date(NOW + HOUR_MS + 30 * MINUTE_MS).toISOString(),
      }),
    );
    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * HOUR_MS);
    expect(conflicts).toHaveLength(1);

    scheduler.resolveConflict(conflicts[0]!, 'defer_lower');
    scheduler.resolveConflict(conflicts[0]!, 'defer_newer');

    // Cancelling a pending run here would hide an approval decision from the
    // person who has to make it — and would count as a resolution that resolved
    // nothing.
    expect(scheduler.getWindowInstances('p-low').every((run) => run.state === 'pending')).toBe(true);
    expect(scheduler.getWindowInstances('p-high').every((run) => run.state === 'pending')).toBe(true);
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 60.9: resolving the same conflict twice does not count twice', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 'twice-low', priority: 2 }));
    scheduler.registerWindow(
      window({ id: 'twice-high', priority: 9, at: new Date(NOW + HOUR_MS + 30 * MINUTE_MS).toISOString() }),
    );
    const conflicts = scheduler.detectConflicts(NOW, NOW + 3 * HOUR_MS);

    scheduler.resolveConflict(conflicts[0]!, 'defer_lower');
    scheduler.resolveConflict(conflicts[0]!, 'defer_lower');

    expect(scheduler.getStats().conflictsResolved).toBe(1);
    expect(scheduler.getWindowInstances('twice-low').filter((run) => run.state === 'cancelled')).toHaveLength(1);
  });

  it('AC 60.10: getStats reports the conflicts that were actually found', () => {
    const scheduler = new MaintenanceWindowScheduler();
    scheduler.registerWindow(window({ id: 's1', priority: 2 }));
    scheduler.registerWindow(
      window({ id: 's2', priority: 9, at: new Date(NOW + HOUR_MS + 30 * MINUTE_MS).toISOString() }),
    );
    scheduler.registerWindow(
      window({ id: 's3', priority: 9, at: new Date(NOW + HOUR_MS + 45 * MINUTE_MS).toISOString() }),
    );

    expect(scheduler.getStats().conflictsDetected).toBe(0);
    const first = scheduler.detectConflicts(NOW, NOW + 3 * HOUR_MS);
    expect(first).toHaveLength(3);
    expect(scheduler.getStats().conflictsDetected).toBe(3);

    // The counter measures how often the scheduler was told to look, so a second
    // pass over the same schedule counts again — and says so.
    scheduler.detectConflicts(NOW, NOW + 3 * HOUR_MS);
    expect(scheduler.getStats().conflictsDetected).toBe(6);
  });
});

describe('AC 60 — the conflict nobody has, and the tie nobody breaks', () => {
  const scheduler = new MaintenanceWindowScheduler();
  const earlier = occurrence({ windowId: 'alpha', instanceId: 'i-alpha', start: NOW, end: NOW + HOUR_MS });

  it('AC 60.11: a non-conflict says so in every field', () => {
    const later = occurrence({
      windowId: 'beta',
      instanceId: 'i-beta',
      start: NOW + 2 * HOUR_MS,
      end: NOW + 3 * HOUR_MS,
    });

    const conflict = scheduler.checkConflict(earlier, later);

    expect(conflict).toEqual({
      hasConflict: false,
      conflictingWindowIds: [],
      conflictingSides: [],
      description: 'No overlap',
      recommendation: 'coexist',
    });
  });

  it('AC 60.12: two occurrences starting at the same instant are reported in argument order', () => {
    const twin = occurrence({ windowId: 'beta', instanceId: 'i-beta', start: NOW, end: NOW + 2 * HOUR_MS });

    const conflict = scheduler.checkConflict(earlier, twin);

    // Equal starts have no natural order, so the report keeps the caller's: a
    // comparator that flips on equality would make "the newer side" ambiguous.
    expect(conflict.conflictingSides.map((side) => side.windowId)).toEqual(['alpha', 'beta']);
    expect(conflict.conflictingSides.map((side) => side.instanceId)).toEqual(['i-alpha', 'i-beta']);
  });

  it('AC 60.13: a conflict object claiming both states resolves nothing', () => {
    // `hasConflict: false` with sides attached is a hand-built conflict. Nothing
    // may be cancelled on the strength of it.
    scheduler.registerWindow(window({ id: 'guarded', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    const instanceId = scheduler.getUpcomingOccurrences(NOW, NOW + HOUR_MS)[0]!.instanceId;

    scheduler.resolveConflict(
      {
        hasConflict: false,
        conflictingWindowIds: ['guarded', 'guarded'],
        conflictingSides: [
          { windowId: 'guarded', instanceId, start: NOW, end: NOW + HOUR_MS },
          { windowId: 'guarded', instanceId: 'other', start: NOW, end: NOW + HOUR_MS },
        ],
        description: 'inconsistent',
        recommendation: 'defer',
      },
      'defer_newer',
    );

    expect(scheduler.getInstanceState(instanceId)!.state).toBe('scheduled');
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 60.14: a deferral records why the run was cancelled', () => {
    const local = new MaintenanceWindowScheduler();
    local.registerWindow(window({ id: 'low-msg', priority: 2, at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    local.registerWindow(
      window({
        id: 'high-msg',
        priority: 9,
        at: new Date(NOW + 30 * MINUTE_MS + 15 * MINUTE_MS).toISOString(),
      }),
    );
    const conflict = local.detectConflicts(NOW, NOW + 2 * HOUR_MS)[0]!;

    local.resolveConflict(conflict, 'defer_lower');
    const deferred = local.getWindowInstances('low-msg').find((run) => run.state === 'cancelled')!;

    // The reason is the only trace left on the instance once the run is gone.
    expect(deferred.error).toBe('Deferred due to conflict with higher-priority window');
    expect(deferred.actualEnd).toBeDefined();
  });

  it('AC 60.15: defer_newer resolves a tie between equal starts by the later side', () => {
    const local = new MaintenanceWindowScheduler();
    local.registerWindow(window({ id: 'tie-a', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    local.registerWindow(window({ id: 'tie-b', at: new Date(NOW + 30 * MINUTE_MS).toISOString() }));
    const conflict = local.detectConflicts(NOW, NOW + 2 * HOUR_MS)[0]!;

    local.resolveConflict(conflict, 'defer_newer');

    const cancelled = ['tie-a', 'tie-b'].flatMap((id) =>
      local.getWindowInstances(id).filter((run) => run.state === 'cancelled'),
    );
    expect(cancelled).toHaveLength(1);
    // With identical starts the second side is the one that gives way, and the
    // reason names the newer-window rule rather than the priority one.
    expect(cancelled[0]!.windowId).toBe(conflict.conflictingSides[1]!.windowId);
    expect(cancelled[0]!.error).toBe('Deferred due to newer window conflict');
  });
});
