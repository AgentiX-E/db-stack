/**
 * D3 Maintenance Window Scheduler — production-grade window lifecycle manager.
 *
 * Features:
 *   - 5 recurrence modes: once, daily, weekly, monthly, cron
 *   - Full approval lifecycle: pending→approved→scheduled→in_progress→completed
 *   - Overlap detection with time-range conflicts
 *   - Priority-based conflict resolution (defer_lower, defer_newer, allow_both)
 *   - Emergency force-override (bypasses approval + scheduling)
 *   - Graceful pause/resume of dependent resources
 *   - Upcoming occurrence projection within time windows
 *
 * The cron grammar it schedules from lives in `cron.ts`: it is a pure function of
 * a string, it has its own tests, and it is mutated as its own module.
 *
 * @module @agentix-e/db-operations-node/maintenance/impl
 */

import type {
  IMaintenanceScheduler,
  MaintenanceWindow,
  WindowState,
  WindowInstance,
  WindowOccurrence,
  WindowConflict,
  MaintenanceSchedulerStats,
  PauseRequest,
  ResumeRequest,
  RecurrenceMode,
  DayOfWeek,
} from '../interfaces/IMaintenanceScheduler.js';
import { parseCron } from './cron.js';

// ── Constants ───────────────────────────────────────────────

const DAY_INDEX: Record<DayOfWeek, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Parse a `HH:MM` start time, or `null` when the value cannot name a time of day.
 *
 * `Number('25')` is 25 rather than `NaN`, and `setUTCHours(25, 0)` rolls over to
 * 01:00 the next day, so a range check is the only thing separating a real time
 * from a typo. Without it a window described as `25:00` is silently scheduled an
 * hour nobody asked for — the failure a schedule must never have.
 *
 * Out-of-range values are malformed in exactly the way `'aa:bb'` is: the
 * projection yields no occurrences and throws nothing.
 */
function parseStartTime(value: string): { hour: number; minute: number } | null {
  const parts = value.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const hourInvalid = !Number.isInteger(hour) || hour < 0 || hour > 23;
  const minuteInvalid = !Number.isInteger(minute) || minute < 0 || minute > 59;
  if (hourInvalid || minuteInvalid) return null;
  return { hour, minute };
}

/**
 * Days of the month that name a real calendar day, in `1..31`.
 *
 * `Date.UTC(year, month, 0)` is the last day of the *previous* month, so a `0`
 * entry fires a window one month early on a date the operator never named;
 * `>31` has no meaning at all. Both are dropped rather than clamped.
 */
function validDaysOfMonth(days: readonly number[]): Set<number> {
  const result = new Set<number>();
  for (const day of days) {
    const isDayOfMonth = Number.isInteger(day) && day >= 1 && day <= 31;
    if (isDayOfMonth) result.add(day);
  }
  return result;
}

// ── Scheduler ───────────────────────────────────────────────

export class MaintenanceWindowScheduler implements IMaintenanceScheduler {
  private windows = new Map<string, MaintenanceWindow>();
  private instances = new Map<string, WindowInstance>();
  private nextInstanceId = 1;
  private nextWindowIdCounter = 1;
  private conflictsDetected = 0;
  private conflictsResolved = 0;

  // ── Window Registration ─────────────────────────────────

  registerWindow(window: MaintenanceWindow): void {
    this._validateWindow(window);
    this.windows.set(window.id, { ...window });
  }

  // ── Approval & Lifecycle ────────────────────────────────

  approveWindow(instanceId: string, approvedBy: string): void {
    const inst = this._getInstance(instanceId);
    if (inst.state !== 'pending') {
      throw new Error(`Cannot approve instance in state "${inst.state}"`);
    }
    inst.state = 'approved';
    inst.approvedBy = approvedBy;
    inst.approvedAt = Date.now();
  }

  cancelWindow(instanceId: string, reason: string): void {
    const inst = this._getInstance(instanceId);
    if (inst.state === 'completed' || inst.state === 'cancelled') {
      throw new Error(`Cannot cancel instance in state "${inst.state}"`);
    }
    inst.state = 'cancelled';
    inst.error = reason;
    inst.actualEnd = Date.now();
  }

  /**
   * Move an approved or scheduled instance into `in_progress`.
   *
   * `WindowState` has declared `in_progress` since the scheduler was written and
   * `getStats().activeWindows` counts it, but no code path could produce it: a
   * running maintenance window and one still waiting to start were both reported
   * as `scheduled`. The executor calls this when it begins a run, so the
   * difference between "queued" and "running" is visible to `getStats()` and to
   * anything reading `getInstanceState()`.
   *
   * A `pending` instance is refused. `requiresApproval` exists so that a human
   * decides before the database is taken offline; starting the run without that
   * decision would make the flag advisory.
   */
  startWindow(instanceId: string): WindowInstance {
    const inst = this._getInstance(instanceId);
    const isStartable = inst.state === 'scheduled' || inst.state === 'approved';
    if (!isStartable) {
      throw new Error(`Cannot start instance in state "${inst.state}"`);
    }
    inst.state = 'in_progress';
    inst.actualStart = Date.now();
    return { ...inst };
  }

  /**
   * Record a successful outcome for an instance.
   *
   * `WindowInstanceState` documents `completed` and `actualEnd`, and
   * `getStats()` reports `completedInstances`, but nothing could ever set that
   * state — the counters were unreachable. The executor calls this when a
   * maintenance window finishes.
   */
  completeWindow(instanceId: string): WindowInstance {
    return this._finishInstance(instanceId, 'completed');
  }

  /**
   * Record a failed outcome for an instance.
   *
   * The failure reason is kept on the instance so `getInstanceState()` can
   * surface why a window did not finish, and `getStats().failedInstances`
   * reflects reality.
   */
  failWindow(instanceId: string, reason: string): WindowInstance {
    return this._finishInstance(instanceId, 'failed', reason);
  }

  /** Shared terminal transition for `completeWindow` / `failWindow`. */
  private _finishInstance(instanceId: string, state: 'completed' | 'failed', reason?: string): WindowInstance {
    const inst = this._getInstance(instanceId);
    if (inst.state === 'completed' || inst.state === 'failed') {
      throw new Error(`Cannot finish instance in state "${inst.state}"`);
    }
    if (inst.state === 'cancelled') {
      throw new Error(`Cannot finish instance in state "${inst.state}"`);
    }
    inst.state = state;
    inst.actualEnd = Date.now();
    if (reason !== undefined) inst.error = reason;
    return { ...inst };
  }

  forceStart(windowId: string): WindowInstance {
    const win = this._getWindow(windowId);
    const now = Date.now();
    const instance: WindowInstance = {
      id: this._nextInstanceId(),
      windowId: win.id,
      state: 'force_override',
      scheduledStart: now,
      scheduledEnd: win.maxDurationMin > 0 ? now + win.maxDurationMin * MINUTE_MS : now + HOUR_MS,
      actualStart: now,
    };
    this.instances.set(instance.id, instance);
    return { ...instance };
  }

  // ── Occurrence Projection ────────────────────────────────

  getUpcomingOccurrences(fromMs: number, toMs: number): WindowOccurrence[] {
    const results: WindowOccurrence[] = [];

    for (const win of this.windows.values()) {
      const occs = this._projectOccurrences(win, fromMs, toMs);
      for (const occ of occs) {
        results.push(occ);
      }
    }

    // Sort by start time
    results.sort((a, b) => a.start - b.start);
    return results;
  }

  // ── Conflict Detection ───────────────────────────────────

  checkConflict(a: WindowOccurrence, b: WindowOccurrence): WindowConflict {
    // An occurrence cannot overlap itself. Identity is the instance, not the
    // window: two different instances of one window are two runs of the same
    // maintenance on the same targets, and a window whose duration exceeds its
    // period produces exactly that. Reporting "coexist" for them — which is
    // what comparing window ids did before iteration 27 — hid the one overlap
    // the scheduler can still prevent.
    if (a.instanceId === b.instanceId) {
      return {
        hasConflict: false,
        conflictingWindowIds: [],
        conflictingSides: [],
        description: 'Same instance',
        recommendation: 'coexist',
      };
    }

    const aBeforeBEnd = a.start < b.end;
    const bBeforeAEnd = b.start < a.end;
    const overlap = aBeforeBEnd && bBeforeAEnd;
    if (!overlap) {
      return {
        hasConflict: false,
        conflictingWindowIds: [],
        conflictingSides: [],
        description: 'No overlap',
        recommendation: 'coexist',
      };
    }

    const bothHighPriority = a.priority > 5 && b.priority > 5;
    const equalPriority = a.priority === b.priority;
    let recommendation: WindowConflict['recommendation'];
    if (bothHighPriority) {
      recommendation = 'coexist';
    } else if (equalPriority) {
      recommendation = 'split';
    } else {
      recommendation = 'defer';
    }

    // Earliest start first, so `defer_newer` reads as "the second side".
    const sides =
      a.start <= b.start
        ? [
            { windowId: a.windowId, instanceId: a.instanceId, start: a.start, end: a.end },
            { windowId: b.windowId, instanceId: b.instanceId, start: b.start, end: b.end },
          ]
        : [
            { windowId: b.windowId, instanceId: b.instanceId, start: b.start, end: b.end },
            { windowId: a.windowId, instanceId: a.instanceId, start: a.start, end: a.end },
          ];

    return {
      hasConflict: true,
      conflictingWindowIds: [a.windowId, b.windowId],
      conflictingSides: sides,
      description:
        `Overlap: ${a.windowId} ${new Date(a.start).toISOString()}..${new Date(a.end).toISOString()} ` +
        `overlaps ${b.windowId} ${new Date(b.start).toISOString()}..${new Date(b.end).toISOString()}`,
      recommendation,
    };
  }

  detectConflicts(fromMs: number, toMs: number): WindowConflict[] {
    const occs = this.getUpcomingOccurrences(fromMs, toMs);
    const conflicts: WindowConflict[] = [];

    // Each pair is examined once: an occurrence only needs the ones after it,
    // because `checkConflict` is symmetric in its overlap test.
    occs.forEach((left, index) => {
      for (const right of occs.slice(index + 1)) {
        const conflict = this.checkConflict(left, right);
        if (conflict.hasConflict) conflicts.push(conflict);
      }
    });

    this.conflictsDetected += conflicts.length;
    return conflicts;
  }

  resolveConflict(conflict: WindowConflict, strategy: 'defer_lower' | 'defer_newer' | 'allow_both'): void {
    if (!conflict.hasConflict) return;
    if (strategy === 'allow_both') return;

    // A conflict that names no instance names nothing to defer. Returning here
    // is deliberate: the previous code fell back to "cancel everything this
    // window has scheduled", which is the over-broad behaviour being retired.
    const sides = conflict.conflictingSides;
    if (sides.length === 0) return;

    let deferred = 0;
    if (strategy === 'defer_lower') {
      const priorities = sides.map((side) => this.windows.get(side.windowId)?.priority);
      // A side whose window is no longer registered has no priority to compare;
      // it cannot be shown to be the lower one, so it is left alone.
      const known = priorities.filter((p): p is number => p !== undefined);
      // `every` on an empty list is true, so "no side has a comparable priority"
      // needs no separate test: either way there is no lowest, and the conflict
      // stands for a human.
      const everyKnownIsEqual = known.every((p) => p === known[0]);
      if (everyKnownIsEqual) return;

      const lowest = Math.min(...known);
      sides.forEach((side, index) => {
        if (priorities[index] !== lowest) return;
        if (this._deferInstance(side.instanceId, 'Deferred due to conflict with higher-priority window')) {
          deferred++;
        }
      });
    } else {
      // defer_newer — the later start gives way, and only it. On identical
      // starts the second side is the later one, which is the same rule
      // `checkConflict` used to order the pair.
      const newest = sides.reduce((later, side) => (side.start >= later.start ? side : later));
      if (this._deferInstance(newest.instanceId, 'Deferred due to newer window conflict')) deferred++;
    }

    if (deferred > 0) this.conflictsResolved++;
  }

  // ── Instance Queries ─────────────────────────────────────

  getInstanceState(instanceId: string): WindowInstance | null {
    const inst = this.instances.get(instanceId);
    return inst ? { ...inst } : null;
  }

  getWindowInstances(windowId: string): WindowInstance[] {
    return Array.from(this.instances.values())
      .filter((i) => i.windowId === windowId)
      .map((i) => ({ ...i }));
  }

  // ── Pause/Resume ─────────────────────────────────────────

  async requestPause(request: PauseRequest): Promise<void> {
    for (const resource of request.resources) {
      await request.onPaused(resource);
    }
  }

  async requestResume(request: ResumeRequest): Promise<void> {
    // Drives the caller's callback for every resource and awaits it, exactly as
    // requestPause does for onPaused. The body used to be empty, so `await
    // requestResume(resources)` resolved with nothing resumed: the caller was
    // told the database was back in service while it stayed paused.
    for (const resource of request.resources) {
      await request.onResume(resource);
    }
  }

  // ── Statistics ───────────────────────────────────────────

  getStats(): MaintenanceSchedulerStats {
    const allInstances = Array.from(this.instances.values());
    const counts = {
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pendingApprovals: 0,
    };
    for (const i of allInstances) {
      // `force_override` is an emergency run that is executing right now. It was
      // left out of the active count, so a cluster in the middle of a forced
      // maintenance window reported itself idle (AC 61.12).
      const isRunning = i.state === 'in_progress' || i.state === 'force_override';
      const isAhead = i.state === 'scheduled';
      if (isRunning || isAhead) counts.active++;
      if (i.state === 'completed') counts.completed++;
      if (i.state === 'failed') counts.failed++;
      if (i.state === 'cancelled') counts.cancelled++;
      if (i.state === 'pending') counts.pendingApprovals++;
    }
    return {
      totalWindows: this.windows.size,
      activeWindows: counts.active,
      completedInstances: counts.completed,
      failedInstances: counts.failed,
      cancelledInstances: counts.cancelled,
      pendingApprovals: counts.pendingApprovals,
      conflictsDetected: this.conflictsDetected,
      conflictsResolved: this.conflictsResolved,
    };
  }

  // ── Internal: Projection ─────────────────────────────────

  private _projectOccurrences(win: MaintenanceWindow, fromMs: number, toMs: number): WindowOccurrence[] {
    const results: WindowOccurrence[] = [];

    switch (win.recurrence) {
      case 'once':
        this._projectOnce(win, results, fromMs, toMs);
        break;
      case 'daily':
        this._projectDaily(win, results, fromMs, toMs);
        break;
      case 'weekly':
        this._projectWeekly(win, results, fromMs, toMs);
        break;
      case 'monthly':
        this._projectMonthly(win, results, fromMs, toMs);
        break;
      case 'cron':
        this._projectCron(win, results, fromMs, toMs);
        break;
    }

    return results;
  }

  private _projectOnce(win: MaintenanceWindow, out: WindowOccurrence[], fromMs: number, toMs: number): void {
    const start = new Date(win.at!).getTime();
    // An `at` that cannot be read is not a date, and NaN fails every comparison
    // below — so it projects no occurrence without needing a guard of its own.
    // The guard that used to be here (`isNaN(start)`) was masked by exactly that
    // interval test, which is why no test could tell whether it was there.
    // Extract interval condition: start is inside [fromMs, toMs)
    const afterFrom = start >= fromMs;
    const beforeTo = start < toMs;
    if (afterFrom && beforeTo) {
      out.push(this._makeOccurrence(win, start));
    }
  }

  private _projectDaily(win: MaintenanceWindow, out: WindowOccurrence[], fromMs: number, toMs: number): void {
    const start = parseStartTime(win.startTime!);
    if (start === null) return;

    // Set cursor to today at startTime HH:MM
    let cursor = new Date(fromMs);
    cursor.setUTCHours(start.hour, start.minute, 0, 0);

    // If cursor is before the range start, advance to tomorrow
    const cursorTime = cursor.getTime();
    if (cursorTime < fromMs) {
      const nextDayMs = cursorTime + DAY_MS;
      cursor = new Date(nextDayMs);
    }

    // Iterate while inside the window range, advancing one day per step
    let currentMs = cursor.getTime();
    while (currentMs < toMs) {
      out.push(this._makeOccurrence(win, currentMs));
      currentMs += DAY_MS;
    }
  }

  private _projectWeekly(win: MaintenanceWindow, out: WindowOccurrence[], fromMs: number, toMs: number): void {
    const daysArr = win.daysOfWeek!;
    const start = parseStartTime(win.startTime!);
    if (start === null) return;

    const targetDays = new Set(daysArr.map((d) => DAY_INDEX[d]));
    // Align the cursor to HH:MM on the range-start day, then respect the lower
    // bound: that instant is already in the past whenever the caller asks later
    // in the day, and an occurrence that began before the range is not upcoming.
    // Without the step, a 23:00 weekly window asked about at 23:58 is reported
    // as still ahead — a start time the caller can never use. `_projectDaily`,
    // `_projectMonthly`, `_projectOnce` and `_projectCron` all guard this bound;
    // weekly was the only projection that did not.
    const startDate = new Date(fromMs);
    startDate.setUTCHours(start.hour, start.minute, 0, 0);
    let cursorMs = startDate.getTime();
    const cursorBeforeRange = cursorMs < fromMs;
    if (cursorBeforeRange) {
      cursorMs = cursorMs + DAY_MS;
    }

    while (cursorMs < toMs) {
      const cursorDate = new Date(cursorMs);
      const dayOfWeek = cursorDate.getUTCDay();
      const matchesDay = targetDays.has(dayOfWeek);
      if (matchesDay) {
        out.push(this._makeOccurrence(win, cursorMs));
      }
      cursorMs = cursorMs + DAY_MS;
    }
  }

  private _projectMonthly(win: MaintenanceWindow, out: WindowOccurrence[], fromMs: number, toMs: number): void {
    const start = parseStartTime(win.startTime!);
    if (start === null) return;

    // Entries that name no calendar day are dropped, not clamped. An empty set
    // then makes every month below contribute nothing, which is the answer a
    // window with no valid day should give.
    const targetDays = validDaysOfMonth(win.daysOfMonth!);

    let cursor = new Date(fromMs);
    cursor.setUTCHours(start.hour, start.minute, 0, 0);
    cursor.setUTCDate(1);

    let cursorMs = cursor.getTime();
    while (cursorMs < toMs) {
      const seen = new Set<number>();
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      // Last day of current month: day 0 of next month.
      // Must use Date.UTC (not local `new Date`) so the day is correct in any
      // host timezone — a local-time construction read via getUTCDate() is off
      // by one east of UTC (e.g. UTC+8 reports July as 30 days instead of 31).
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

      for (const day of targetDays) {
        const clampedDay = day > lastDay ? lastDay : day;
        const candidate = new Date(Date.UTC(year, month, clampedDay, start.hour, start.minute, 0, 0));
        const candidateMs = candidate.getTime();

        const afterStart = candidateMs >= fromMs;
        const beforeEnd = candidateMs < toMs;
        if (afterStart && beforeEnd) {
          const notSeen = !seen.has(candidateMs);
          if (notSeen) {
            seen.add(candidateMs);
            out.push(this._makeOccurrence(win, candidateMs));
          }
        }
      }

      // Advance to next month: month+1, handle year rollover
      const newMonth = month + 1;
      const rolloverYear = newMonth > 11 ? year + 1 : year;
      const rolledMonth = newMonth > 11 ? newMonth - 12 : newMonth;
      cursor = new Date(Date.UTC(rolloverYear, rolledMonth, 1, start.hour, start.minute, 0, 0));
      cursorMs = cursor.getTime();
    }
  }

  private _projectCron(win: MaintenanceWindow, out: WindowOccurrence[], fromMs: number, toMs: number): void {
    const cron = parseCron(win.cronExpression!);

    let cursor = new Date(fromMs);
    cursor.setUTCSeconds(0, 0);

    // Scan minute by minute within range (bounded to ~100k iterations to prevent hang)
    const maxIterations = 100_000;
    let iterations = 0;

    while (cursor.getTime() < toMs && iterations < maxIterations) {
      iterations++;
      const min = cursor.getUTCMinutes();
      const hour = cursor.getUTCHours();
      const dom = cursor.getUTCDate();
      const mon = cursor.getUTCMonth() + 1;
      const dow = cursor.getUTCDay();

      if (
        cron.minutes.has(min) &&
        cron.hours.has(hour) &&
        cron.daysOfMonth.has(dom) &&
        cron.months.has(mon) &&
        cron.daysOfWeek.has(dow)
      ) {
        if (cursor.getTime() >= fromMs) {
          out.push(this._makeOccurrence(win, cursor.getTime()));
        }
      }

      cursor = new Date(cursor.getTime() + MINUTE_MS);
    }
  }

  // ── Internal: Helpers ────────────────────────────────────

  private _makeOccurrence(win: MaintenanceWindow, start: number): WindowOccurrence {
    // Determine duration: use maxDurationMin if positive, otherwise default to HOUR_MS
    const maxDurVal = win.maxDurationMin;
    const hasValidDuration = maxDurVal > 0;
    const durationMs = hasValidDuration ? maxDurVal * MINUTE_MS : HOUR_MS;
    const end = start + durationMs;

    // Idempotency guard: projection may run multiple times (e.g. once by
    // getUpcomingOccurrences and again by detectConflicts → getUpcomingOccurrences).
    // Re-projecting the same (windowId, scheduledStart) must reuse the existing
    // instance instead of appending a duplicate; otherwise every repeated
    // projection leaks a fresh instance and inflates getStats / resolveConflict.
    const existing = this._findExistingInstance(win.id, start);
    if (existing) {
      return {
        windowId: win.id,
        instanceId: existing.id,
        start,
        end,
        recurrence: win.recurrence,
        priority: win.priority,
      };
    }

    const instanceId = this._nextInstanceId();
    const occ: WindowOccurrence = {
      windowId: win.id,
      instanceId,
      start,
      end,
      recurrence: win.recurrence,
      priority: win.priority,
    };

    // Persist as a WindowInstance for lifecycle tracking
    const state: WindowState = win.requiresApproval ? 'pending' : 'scheduled';
    this.instances.set(instanceId, {
      id: instanceId,
      windowId: win.id,
      state,
      scheduledStart: start,
      scheduledEnd: end,
    });

    return occ;
  }

  private _validateWindow(win: MaintenanceWindow): void {
    const missingId = !win.id;
    const missingName = !win.name;
    if (missingId || missingName) {
      throw new Error('Window id and name are required');
    }
    const negativeMaxDuration = win.maxDurationMin < 0;
    if (negativeMaxDuration) {
      throw new Error('maxDurationMin must be >= 0');
    }
    const negativePriority = win.priority < 0;
    if (negativePriority) {
      throw new Error('Priority must be >= 0');
    }
    const isOnce = win.recurrence === 'once';
    const missingAt = !win.at;
    if (isOnce && missingAt) {
      throw new Error("One-shot windows require 'at' to be set");
    }
    const needsStartTimeRecurrences =
      win.recurrence === 'daily' || win.recurrence === 'weekly' || win.recurrence === 'monthly';
    const missingStartTime = !win.startTime;
    if (needsStartTimeRecurrences && missingStartTime) {
      throw new Error(`${win.recurrence} windows require 'startTime'`);
    }
    const isWeekly = win.recurrence === 'weekly';
    const missingDaysOfWeek = !win.daysOfWeek || win.daysOfWeek.length === 0;
    if (isWeekly && missingDaysOfWeek) {
      throw new Error("Weekly windows require 'daysOfWeek'");
    }
    const isMonthly = win.recurrence === 'monthly';
    const missingDaysOfMonth = !win.daysOfMonth || win.daysOfMonth.length === 0;
    if (isMonthly && missingDaysOfMonth) {
      throw new Error("Monthly windows require 'daysOfMonth'");
    }
    const isCron = win.recurrence === 'cron';
    const missingCronExpression = !win.cronExpression;
    if (isCron && missingCronExpression) {
      throw new Error("Cron windows require 'cronExpression'");
    }
  }

  private _getWindow(id: string): MaintenanceWindow {
    const win = this.windows.get(id);
    if (!win) throw new Error(`Window "${id}" not found`);
    return win;
  }

  private _getInstance(id: string): WindowInstance {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Instance "${id}" not found`);
    return inst;
  }

  private _nextInstanceId(): string {
    return `inst-${this.nextInstanceId++}`;
  }

  private _findExistingInstance(windowId: string, scheduledStart: number): WindowInstance | null {
    for (const inst of this.instances.values()) {
      if (inst.windowId === windowId && inst.scheduledStart === scheduledStart) {
        return inst;
      }
    }
    return null;
  }

  /**
   * Cancel one occurrence as deferred, and report whether it changed anything.
   *
   * `pending` is left alone: the instance is waiting for an approver, and a
   * conflict resolution is not that approver. Terminal states are already out
   * of the schedule, so they are skipped rather than re-cancelled.
   */
  private _deferInstance(instanceId: string, reason: string): boolean {
    const inst = this.instances.get(instanceId);
    if (inst === undefined) return false;
    const isScheduled = inst.state === 'scheduled';
    const isApproved = inst.state === 'approved';
    if (!isScheduled && !isApproved) return false;
    inst.state = 'cancelled';
    inst.error = reason;
    inst.actualEnd = Date.now();
    return true;
  }
}
