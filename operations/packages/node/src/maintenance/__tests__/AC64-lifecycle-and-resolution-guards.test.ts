/**
 * AC 64 — the run that starts, and the guards that keep a resolution honest.
 *
 * Two gaps, both found by mutants that no test could kill:
 *
 * 1. `in_progress` was unreachable. `WindowState` declares it,
 *    `WindowInstance.actualStart` documents it, `getStats().activeWindows`
 *    counts it, and nothing in the package could produce it — so a window that
 *    was running and one that was still queued both reported `scheduled`, and a
 *    `completed` state could only be reached without ever having started.
 *    `startWindow` is the missing transition, on the interface as well as the
 *    implementation because the executor is what calls it.
 *
 * 2. `resolveConflict` carries guards whose only effect is on inputs the
 *    scheduler does not itself produce: a conflict object with `hasConflict`
 *    false but sides filled in, a conflict that names no side at all, a side
 *    whose window has since been unregistered, and sides that arrive out of
 *    order. Each of those used to be indistinguishable from the happy path,
 *    because nothing asserted that the unhappy ones do nothing.
 *
 * The projection case at the end is the smallest one in the file: a window whose
 * `at` cannot be read is not scheduled at an unreadable time, it is not
 * scheduled at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MaintenanceWindowScheduler } from '../impl/MaintenanceWindowScheduler.js';
import type {
  IMaintenanceScheduler,
  MaintenanceWindow,
  WindowConflict,
  WindowInstance,
} from '../interfaces/IMaintenanceScheduler.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

/**
 * Register one window and materialise its instance.
 *
 * The projection covers three hours and the occurrence is selected by window id:
 * projecting a later window's range would otherwise hand back the instance of a
 * window registered earlier in the same test.
 */
function scheduled(
  scheduler: MaintenanceWindowScheduler,
  overrides: Partial<MaintenanceWindow> & { id: string },
): WindowInstance {
  scheduler.registerWindow(window(overrides));
  const occurrence = scheduler
    .getUpcomingOccurrences(NOW, NOW + 3 * HOUR_MS)
    .find((candidate) => candidate.windowId === overrides.id);
  expect(occurrence).toBeDefined();
  const instance = scheduler.getInstanceState(occurrence!.instanceId);
  expect(instance).not.toBeNull();
  return instance!;
}

/** A conflict object as a caller could hand one back, sides and all. */
function conflict(sides: WindowConflict['conflictingSides'], hasConflict = true): WindowConflict {
  return {
    hasConflict,
    conflictingWindowIds: sides.map((side) => side.windowId),
    conflictingSides: sides,
    description: 'crafted',
    recommendation: 'defer',
  };
}

describe('AC 64 — a window that is running', () => {
  let scheduler: MaintenanceWindowScheduler;

  beforeEach(() => {
    scheduler = new MaintenanceWindowScheduler();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW + 30 * MINUTE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 64.1: startWindow moves a scheduled instance to in_progress and stamps actualStart', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });

    const started = scheduler.startWindow(instance.id);

    expect(started.state).toBe('in_progress');
    expect(started.actualStart).toBe(NOW + 30 * MINUTE_MS);
    expect(scheduler.getInstanceState(instance.id)!.state).toBe('in_progress');
  });

  it('AC 64.2: a running instance counts as active', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });
    expect(scheduler.getStats().activeWindows).toBe(1);

    scheduler.startWindow(instance.id);

    // Before `startWindow` existed this number could only ever come from
    // `scheduled` or `force_override`; `in_progress` was unreachable, and a
    // mutant that removed it from the active count survived every test.
    expect(scheduler.getStats().activeWindows).toBe(1);
  });

  it('AC 64.3: an approved instance may start', () => {
    const instance = scheduled(scheduler, { id: 'vacuum', requiresApproval: true });
    scheduler.approveWindow(instance.id, 'oncall');

    const started = scheduler.startWindow(instance.id);

    expect(started.state).toBe('in_progress');
    expect(started.approvedBy).toBe('oncall');
  });

  it('AC 64.4: a pending instance may not start', () => {
    const instance = scheduled(scheduler, { id: 'vacuum', requiresApproval: true });

    // Approval is the step that authorises taking the database offline; starting
    // without it would make `requiresApproval` advisory.
    expect(() => scheduler.startWindow(instance.id)).toThrow(/Cannot start instance in state "pending"/);
  });

  it('AC 64.5: an instance that is already running may not start again', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });
    scheduler.startWindow(instance.id);

    expect(() => scheduler.startWindow(instance.id)).toThrow(/Cannot start instance in state "in_progress"/);
  });

  it('AC 64.6: an unknown instance cannot start', () => {
    expect(() => scheduler.startWindow('inst-404')).toThrow(/Instance "inst-404" not found/);
  });

  it('AC 64.7: a run that started completes with an end time', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });
    scheduler.startWindow(instance.id);

    const completed = scheduler.completeWindow(instance.id);

    expect(completed.state).toBe('completed');
    expect(completed.actualStart).toBe(NOW + 30 * MINUTE_MS);
    expect(completed.actualEnd).toBe(NOW + 30 * MINUTE_MS);
    // A run that finished carries no failure reason — not even an `error` key
    // holding `undefined`, which is what stamping the optional field
    // unconditionally would leave on every completed instance.
    expect(Object.keys(completed)).not.toContain('error');
    expect(scheduler.getStats()).toMatchObject({ activeWindows: 0, completedInstances: 1 });
  });

  it('AC 64.8: a run that started fails with its reason', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });
    scheduler.startWindow(instance.id);

    const failed = scheduler.failWindow(instance.id, 'lock timeout');

    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('lock timeout');
    expect(scheduler.getStats()).toMatchObject({ activeWindows: 0, failedInstances: 1 });
  });

  it('AC 64.9: the lifecycle is reachable through the interface', () => {
    // The executor is typed against `IMaintenanceScheduler`; start, complete and
    // fail were implementation-only methods, so a caller holding the interface
    // could not drive a run at all. This assignment is the assertion.
    const typed: IMaintenanceScheduler = scheduler;
    const instance = scheduled(scheduler, { id: 'vacuum' });

    typed.startWindow(instance.id);
    expect(typed.completeWindow(instance.id).state).toBe('completed');
  });

  it('AC 64.10: a window whose at cannot be read is not scheduled', () => {
    scheduler.registerWindow(window({ id: 'broken', at: 'not-a-date' }));

    expect(scheduler.getUpcomingOccurrences(NOW - DAY_MS, NOW + DAY_MS)).toEqual([]);
  });
});

describe('AC 64 — the guards a resolution needs', () => {
  let scheduler: MaintenanceWindowScheduler;

  beforeEach(() => {
    scheduler = new MaintenanceWindowScheduler();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 64.11: a conflict that is not a conflict resolves nothing, even with sides attached', () => {
    const instance = scheduled(scheduler, { id: 'vacuum' });

    scheduler.resolveConflict(
      conflict([{ windowId: 'vacuum', instanceId: instance.id, start: NOW, end: NOW + HOUR_MS }], false),
      'defer_newer',
    );

    expect(scheduler.getInstanceState(instance.id)!.state).toBe('scheduled');
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 64.12: a conflict that names no side resolves nothing and does not throw', () => {
    // `defer_newer` reduces over the sides; an empty list has no first element to
    // seed that reduction, so the guard is what keeps this a no-op instead of a
    // TypeError from a resolution the caller expected to be harmless.
    expect(() => scheduler.resolveConflict(conflict([]), 'defer_newer')).not.toThrow();
    expect(() => scheduler.resolveConflict(conflict([]), 'defer_lower')).not.toThrow();
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 64.13: a side whose window was unregistered carries no priority to compare', () => {
    const high = scheduled(scheduler, { id: 'high', priority: 8 });
    const low = scheduled(scheduler, { id: 'low', priority: 3, at: new Date(NOW + 2 * HOUR_MS).toISOString() });

    // The lowest side is a window the scheduler no longer knows: it cannot be
    // shown to be the lower one, so it is left alone and the pair stands — the
    // known priority must not win by being the only one left in the comparison.
    scheduler.resolveConflict(
      conflict([
        { windowId: 'gone', instanceId: 'inst-gone', start: NOW, end: NOW + HOUR_MS },
        { windowId: 'low', instanceId: low.id, start: NOW, end: NOW + HOUR_MS },
        { windowId: 'high', instanceId: high.id, start: NOW, end: NOW + HOUR_MS },
      ]),
      'defer_lower',
    );

    // `low` is the lowest *known* priority, so it gives way; `gone` is untouched
    // because it cannot be found, and `high` because it is not the lowest.
    expect(scheduler.getInstanceState(low.id)!.state).toBe('cancelled');
    expect(scheduler.getInstanceState(high.id)!.state).toBe('scheduled');
  });

  it('AC 64.14: an unknown side is never the lowest by itself', () => {
    const known = scheduled(scheduler, { id: 'known', priority: 4 });

    // Every known side shares one priority, and the only other side is unknown:
    // there is no lower one among what can be compared, so the conflict stands.
    scheduler.resolveConflict(
      conflict([
        { windowId: 'gone', instanceId: 'inst-gone', start: NOW, end: NOW + HOUR_MS },
        { windowId: 'known', instanceId: known.id, start: NOW, end: NOW + HOUR_MS },
      ]),
      'defer_lower',
    );

    expect(scheduler.getInstanceState(known.id)!.state).toBe('scheduled');
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 64.15: defer_newer defers the later side even when the sides arrive out of order', () => {
    const early = scheduled(scheduler, { id: 'early' });
    const late = scheduled(scheduler, { id: 'late', at: new Date(NOW + 90 * MINUTE_MS).toISOString() });

    // `checkConflict` orders sides by start, so this is an input the scheduler
    // does not produce — but the method's contract is "the later start gives
    // way", and a reduction that assumes sorted input silently defers the earlier
    // one when the assumption breaks.
    scheduler.resolveConflict(
      conflict([
        { windowId: 'late', instanceId: late.id, start: NOW + 90 * MINUTE_MS, end: NOW + 150 * MINUTE_MS },
        { windowId: 'early', instanceId: early.id, start: NOW, end: NOW + HOUR_MS },
      ]),
      'defer_newer',
    );

    expect(scheduler.getInstanceState(late.id)!.state).toBe('cancelled');
    expect(scheduler.getInstanceState(early.id)!.state).toBe('scheduled');
    expect(scheduler.getStats().conflictsResolved).toBe(1);
  });

  it('AC 64.16: equal priorities leave the conflict for a human', () => {
    const first = scheduled(scheduler, { id: 'first', priority: 5 });
    const second = scheduled(scheduler, {
      id: 'second',
      priority: 5,
      at: new Date(NOW + 90 * MINUTE_MS).toISOString(),
    });

    scheduler.resolveConflict(
      conflict([
        { windowId: 'first', instanceId: first.id, start: NOW, end: NOW + HOUR_MS },
        { windowId: 'second', instanceId: second.id, start: NOW + 90 * MINUTE_MS, end: NOW + 150 * MINUTE_MS },
      ]),
      'defer_lower',
    );

    expect(scheduler.getInstanceState(first.id)!.state).toBe('scheduled');
    expect(scheduler.getInstanceState(second.id)!.state).toBe('scheduled');
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });

  it('AC 64.17: a pending side is left to its approver', () => {
    const pending = scheduled(scheduler, { id: 'pending', requiresApproval: true, priority: 1 });
    const approved = scheduled(scheduler, {
      id: 'approved',
      priority: 9,
      at: new Date(NOW + 90 * MINUTE_MS).toISOString(),
    });

    scheduler.resolveConflict(
      conflict([
        { windowId: 'pending', instanceId: pending.id, start: NOW, end: NOW + HOUR_MS },
        { windowId: 'approved', instanceId: approved.id, start: NOW + 90 * MINUTE_MS, end: NOW + 150 * MINUTE_MS },
      ]),
      'defer_lower',
    );

    // The lowest priority is also the one waiting for a person; deferring it
    // would answer that person's question for them.
    expect(scheduler.getInstanceState(pending.id)!.state).toBe('pending');
    expect(scheduler.getStats().conflictsResolved).toBe(0);
  });
});
