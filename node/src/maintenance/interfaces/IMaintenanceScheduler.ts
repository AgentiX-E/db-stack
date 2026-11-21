/**
 * D3 Maintenance Windows types — scheduling, approval, conflict resolution,
 * and graceful pause/force-override for database maintenance operations.
 *
 * @module @agentix-e/db-node/maintenance/interfaces
 */

// ── Window ──────────────────────────────────────────────────

/** Recurrence mode for a maintenance window. */
export type RecurrenceMode =
  | 'once' // One-shot window
  | 'daily' // Every day at specified time
  | 'weekly' // Specific days of week
  | 'monthly' // Specific day(s) of month
  | 'cron'; // Raw cron expression

/** Weekly day selectors. */
export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** A single maintenance window definition. */
export interface MaintenanceWindow {
  /** Unique window identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this window is for (VACUUM, REINDEX, upgrade, etc.). */
  operationType: string;
  /** Target resources (table names, shard IDs, cluster IDs). */
  targets: string[];
  /** Recurrence pattern. */
  recurrence: RecurrenceMode;
  /** For once/at: ISO-8601 start datetime. */
  at?: string;
  /** For daily/weekly/monthly: start time in HH:mm format. */
  startTime?: string;
  /** For daily/weekly/monthly: end time in HH:mm format. */
  endTime?: string;
  /** For weekly: which days of the week. */
  daysOfWeek?: DayOfWeek[];
  /** For monthly: day(s) of month (1-31). */
  daysOfMonth?: number[];
  /** For cron: raw cron expression. */
  cronExpression?: string;
  /** Timezone for window interpretation. */
  timezone?: string;
  /** Priority (higher = more important, overrides lower in conflicts). */
  priority: number;
  /** Owner / team identifier. */
  owner: string;
  /** Maximum duration in minutes (0 = unbounded). */
  maxDurationMin: number;
  /** Resources that must be paused during this window. */
  pauseDuringWindow?: string[];
  /** If true, this window requires explicit approval. */
  requiresApproval: boolean;
}

// ── Window State & Approval ─────────────────────────────────

/** Lifecycle state of a maintenance window instance. */
export type WindowState =
  | 'pending' // Awaiting approval
  | 'approved' // Approved, not yet active
  | 'scheduled' // Scheduled for a specific slot
  | 'in_progress' // Currently executing
  | 'completed' // Finished successfully
  | 'failed' // Failed during execution
  | 'cancelled' // Cancelled before execution
  | 'force_override'; // Executed via emergency override

/** A concrete instance of a window scheduled at a specific time. */
export interface WindowInstance {
  /** Unique instance ID. */
  id: string;
  /** Parent window definition ID. */
  windowId: string;
  /** Operational state. */
  state: WindowState;
  /** Scheduled start time (ms since epoch). */
  scheduledStart: number;
  /** Scheduled end time (ms since epoch). */
  scheduledEnd: number;
  /** Actual start time (set when in_progress). */
  actualStart?: number;
  /** Actual end time (set when completed/failed). */
  actualEnd?: number;
  /** Approver identity (set when approved). */
  approvedBy?: string;
  /** Approval timestamp. */
  approvedAt?: number;
  /** Failure reason (if failed). */
  error?: string;
}

// ── Conflict ────────────────────────────────────────────────

/**
 * One side of an overlap: the exact instance that would run at the same time.
 *
 * A conflict is a fact about two *occurrences*, not about two window
 * definitions. `defer_lower` used to resolve it by cancelling every future
 * instance of the losing window — including the ones that did not overlap
 * anything — because the conflict carried no instance identity. These are the
 * instances a resolution is allowed to touch, and nothing else.
 */
export interface ConflictSide {
  /** Window definition the instance belongs to. */
  windowId: string;
  /** Instance that overlaps. */
  instanceId: string;
  /** Start time (ms since epoch). */
  start: number;
  /** End time (ms since epoch). */
  end: number;
}

/** Result of an overlap/conflict check. */
export interface WindowConflict {
  /** Does the conflict exist? */
  hasConflict: boolean;
  /** Conflicting window IDs, in occurrence order. */
  conflictingWindowIds: string[];
  /**
   * The overlapping occurrences, earliest start first, and empty when
   * `hasConflict` is false.
   *
   * Two occurrences of the *same* window can appear here: a window whose
   * duration exceeds its recurrence period schedules its next run before the
   * previous one has finished, which is the overlap the scheduler exists to
   * report. Only an occurrence is exempt from conflicting with itself.
   */
  conflictingSides: ConflictSide[];
  /** Overlap description, with both intervals in ISO-8601. */
  description: string;
  /** Resolution recommendation. */
  recommendation: 'defer' | 'override' | 'split' | 'coexist';
}

// ── Schedule ────────────────────────────────────────────────

/** A computed upcoming occurrence of a window. */
export interface WindowOccurrence {
  /** Window definition ID. */
  windowId: string;
  /** Instance ID (generated). */
  instanceId: string;
  /** Start time (ms since epoch). */
  start: number;
  /** End time (ms since epoch). */
  end: number;
  /** Recurrence mode of parent window. */
  recurrence: RecurrenceMode;
  /** Priority from parent window. */
  priority: number;
}

/** Statistics for the maintenance scheduler. */
export interface MaintenanceSchedulerStats {
  totalWindows: number;
  /** Instances that are `scheduled`, `in_progress` or running under a `force_override`. */
  activeWindows: number;
  completedInstances: number;
  failedInstances: number;
  cancelledInstances: number;
  pendingApprovals: number;
  /**
   * Overlapping pairs reported by `detectConflicts`, cumulative over calls.
   *
   * Repeated projections of the same pair count again: this is a measure of how
   * often the scheduler was told to look, not a deduplicated registry. Both
   * counters were hardcoded to `0` before iteration 27, so a dashboard built on
   * them showed a quiet cluster during a conflict storm.
   */
  conflictsDetected: number;
  /** Conflicts whose resolution actually cancelled at least one instance. */
  conflictsResolved: number;
}

// ── Pause Request ───────────────────────────────────────────

/** Request to pause dependent resources before a window. */
export interface PauseRequest {
  /** Window instance triggering the pause. */
  instanceId: string;
  /** Resources to pause. */
  resources: string[];
  /** Pause start time (ms since epoch). */
  pauseAt: number;
  /** Expected resume time (ms since epoch). */
  resumeAt: number;
  /** Callback invoked when pause is confirmed. */
  onPaused: (resource: string) => Promise<void>;
}

/**
 * Request to resume resources paused by a maintenance window.
 *
 * The resume half of a `PauseRequest`. It carries the confirmation callback the
 * pause already had, because a resume that resolves without calling back is
 * indistinguishable from one that resumed nothing — which is what
 * `requestResume` used to be.
 */
export interface ResumeRequest {
  /** Window instance that opened the pause interval. */
  instanceId: string;
  /** Resources to resume. */
  resources: string[];
  /** Resume time (ms since epoch). */
  resumeAt: number;
  /** Callback invoked once a resource is resumed. */
  onResume: (resource: string) => Promise<void>;
}

// ── Scheduler Interface ─────────────────────────────────────

export interface IMaintenanceScheduler {
  /** Register a maintenance window definition. */
  registerWindow(window: MaintenanceWindow): void;

  /** Approve a pending window instance. */
  approveWindow(instanceId: string, approvedBy: string): void;

  /** Cancel a window instance. */
  cancelWindow(instanceId: string, reason: string): void;

  /**
   * Move an approved or scheduled instance into `in_progress`.
   *
   * The transition was missing: `WindowState` defines `in_progress`,
   * `WindowInstance.actualStart` is documented as "set when in_progress", and
   * `activeWindows` counts it, but nothing in the package could ever put an
   * instance there. A window that actually started was indistinguishable from
   * one still waiting to, and `completed` could only be reached by skipping the
   * run entirely.
   *
   * A `pending` instance is refused: approval is the step that authorises the
   * run, and starting without it would make `requiresApproval` advisory.
   *
   * @throws When the instance is pending, or already in a terminal state.
   */
  startWindow(instanceId: string): WindowInstance;

  /**
   * Move a running instance to `completed` and stamp `actualEnd`.
   *
   * Part of the interface rather than a method only the implementation knows:
   * the executor is the component that knows a run finished, and it is typed
   * against this interface.
   */
  completeWindow(instanceId: string): WindowInstance;

  /** Move a running instance to `failed`, recording why. */
  failWindow(instanceId: string, reason: string): WindowInstance;

  /** Force start a window immediately (emergency override). */
  forceStart(windowId: string): WindowInstance;

  /**
   * Project the occurrences of every registered window in `[fromMs, toMs)`.
   *
   * An occurrence is reported when its *start* lies in the range: `fromMs` is
   * inclusive, `toMs` is exclusive. A window that began before `fromMs` is not
   * reported even if its duration is still running — call `getWindowInstances()`
   * for windows already in progress. Occurrences are sorted by start time and
   * repeated projections are idempotent.
   */
  getUpcomingOccurrences(fromMs: number, toMs: number): WindowOccurrence[];

  /** Check if two windows would overlap at given times. */
  checkConflict(a: WindowOccurrence, b: WindowOccurrence): WindowConflict;

  /** Get all conflicts among upcoming windows. */
  detectConflicts(fromMs: number, toMs: number): WindowConflict[];

  /**
   * Resolve a conflict by deferring the occurrence that should give way.
   *
   * Only the instances named in `conflict.conflictingSides` are touched. The
   * other runs of both windows are untouched: a conflict at 03:00 says nothing
   * about the same window's run next week, and cancelling those too — which is
   * what this did before iteration 27 — silently removed maintenance an
   * operator had scheduled and never asked to move.
   *
   * - `defer_lower` cancels the conflicting occurrence of the lower-priority
   *   window. When every side has the same priority there is no lower one, so
   *   the call is a no-op and the conflict stands for a human to split.
   * - `defer_newer` cancels the later-starting conflicting occurrence, leaving
   *   the earlier one in place.
   * - `allow_both` changes nothing.
   *
   * Only `scheduled` and `approved` instances are deferred; a pending instance
   * is waiting for an approver, and cancelling it here would hide an approval
   * decision from the person who has to make it.
   */
  resolveConflict(conflict: WindowConflict, strategy: 'defer_lower' | 'defer_newer' | 'allow_both'): void;

  /** Get the lifecycle state of an instance. */
  getInstanceState(instanceId: string): WindowInstance | null;

  /** Get all instances for a window. */
  getWindowInstances(windowId: string): WindowInstance[];

  /** Schedule a pause of dependent resources. */
  requestPause(request: PauseRequest): Promise<void>;

  /**
   * Resume resources paused by a window, awaiting `onResume` for each one.
   *
   * The first rejection propagates and the remaining resources are not touched,
   * so the caller learns which resource refused to come back.
   *
   * **Breaking:** this took a bare `resources: string[]` and had an empty body,
   * so it reported success without resuming anything.
   */
  requestResume(request: ResumeRequest): Promise<void>;

  /** Get scheduler statistics. */
  getStats(): MaintenanceSchedulerStats;
}
