/**
 * D3 Maintenance Windows types — scheduling, approval, conflict resolution,
 * and graceful pause/force-override for database maintenance operations.
 *
 * @module @agentix-e/db-operations-maintenance/interfaces
 */

// ── Window ──────────────────────────────────────────────────

/** Recurrence mode for a maintenance window. */
export type RecurrenceMode =
  | "once"          // One-shot window
  | "daily"         // Every day at specified time
  | "weekly"        // Specific days of week
  | "monthly"       // Specific day(s) of month
  | "cron";         // Raw cron expression

/** Weekly day selectors. */
export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

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
  | "pending"         // Awaiting approval
  | "approved"        // Approved, not yet active
  | "scheduled"       // Scheduled for a specific slot
  | "in_progress"     // Currently executing
  | "completed"       // Finished successfully
  | "failed"          // Failed during execution
  | "cancelled"       // Cancelled before execution
  | "force_override";  // Executed via emergency override

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

/** Result of an overlap/conflict check. */
export interface WindowConflict {
  /** Does the conflict exist? */
  hasConflict: boolean;
  /** Conflicting window IDs. */
  conflictingWindowIds: string[];
  /** Overlap description. */
  description: string;
  /** Resolution recommendation. */
  recommendation: "defer" | "override" | "split" | "coexist";
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
  activeWindows: number;
  completedInstances: number;
  failedInstances: number;
  cancelledInstances: number;
  pendingApprovals: number;
  conflictsDetected: number;
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
  /** Callback invoked when resume is requested. */
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

  /** Force start a window immediately (emergency override). */
  forceStart(windowId: string): WindowInstance;

  /** Get all upcoming occurrences within a time range. */
  getUpcomingOccurrences(fromMs: number, toMs: number): WindowOccurrence[];

  /** Check if two windows would overlap at given times. */
  checkConflict(a: WindowOccurrence, b: WindowOccurrence): WindowConflict;

  /** Get all conflicts among upcoming windows. */
  detectConflicts(fromMs: number, toMs: number): WindowConflict[];

  /** Resolve a conflict by deferring the lower-priority window. */
  resolveConflict(conflict: WindowConflict, strategy: "defer_lower" | "defer_newer" | "allow_both"): void;

  /** Get the lifecycle state of an instance. */
  getInstanceState(instanceId: string): WindowInstance | null;

  /** Get all instances for a window. */
  getWindowInstances(windowId: string): WindowInstance[];

  /** Schedule a pause of dependent resources. */
  requestPause(request: PauseRequest): Promise<void>;

  /** Resume previously paused resources. */
  requestResume(resources: string[]): Promise<void>;

  /** Get scheduler statistics. */
  getStats(): MaintenanceSchedulerStats;
}
