/**
 * D2 Rolling Upgrade types — production-grade orchestration for
 * zero-downtime upgrades: batch strategies, canary deployment,
 * health gating, and automatic rollback.
 *
 * @module @agentix-e/db-operations-rollingupgrade/interfaces
 */

// ── Health ──────────────────────────────────────────────────

/** Health check result for a single node or service. */
export interface HealthStatus {
  /** Whether the check passed. */
  healthy: boolean;
  /** Named check outputs (e.g. "latency": "12ms", "errors": "0"). */
  details: Record<string, string | number | boolean>;
  /** Timestamp of the check (ms since epoch). */
  checkedAt: number;
}

/** Aggregated health of a candidate (canary or batch). */
export interface BatchHealth {
  /** Aggregate healthy? (all checks passed). */
  healthy: boolean;
  /** Per-node health snapshots. */
  nodes: HealthStatus[];
  /** Evaluation timestamp. */
  evaluatedAt: number;
}

// ── Strategy ────────────────────────────────────────────────

/** Rolling upgrade batch strategy. */
export type BatchStrategy =
  | "fixed_size"   // Fixed node count per batch
  | "percentage"   // Percentage of remaining nodes
  | "one_by_one"   // Serial, one node at a time
  | "all_at_once"; // Immediate full rollout (no batches)

/** Canary deployment strategy. */
export interface CanaryConfig {
  /** Fraction of nodes (0-1) promoted to canary phase first. */
  fraction: number;
  /** How long the canary runs before promotion (ms). */
  bakeTimeMs: number;
  /** Health checks that must pass before full rollout. */
  requiredChecks: string[];
  /** Maximum canary nodes (absolute cap). */
  maxCanaryNodes?: number;
  /** If true, auto-promote canary on health pass. */
  autoPromote: boolean;
}

/** Rollback trigger policy. */
export type RollbackTrigger =
  | "on_first_failure"      // Any single node failure
  | "on_batch_threshold"    // >N% of batch fails
  | "on_canary_failure"     // Canary health check fails
  | "on_degradation"        // SLO degradation detected
  | "manual_only";           // Only manual rollback

/** Graceful drain configuration for nodes being replaced. */
export interface DrainConfig {
  /** Drain timeout (ms) before force-kill. */
  timeoutMs: number;
  /** Whether to wait for in-flight requests to complete. */
  waitForInflight: boolean;
  /** Connection draining delay before shutdown (ms). */
  connectionDrainMs: number;
}

// ── Plan ────────────────────────────────────────────────────

/** Full rolling upgrade plan. */
export interface RollingUpgradePlan {
  /** Unique plan identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Target version or build identifier. */
  targetVersion: string;
  /** Node identifiers to upgrade. */
  nodes: string[];
  /** Batch strategy. */
  batchStrategy: BatchStrategy;
  /** Batch size (used with fixed_size and percentage strategies). */
  batchSize?: number;
  /** Canary configuration (if nil, no canary). */
  canary?: CanaryConfig;
  /** Rollback trigger policy. */
  rollbackTrigger: RollbackTrigger;
  /** Batch failure threshold (0-1) for on_batch_threshold. */
  batchFailureThreshold?: number;
  /** Drain configuration for nodes. */
  drain?: DrainConfig;
  /** Pre-upgrade script / hook identifier. */
  preScript?: string;
  /** Post-upgrade script / hook identifier. */
  postScript?: string;
  /** Health checks required before promoting a batch. */
  healthCheckNames: string[];
  /** Maximum total duration (ms) before auto-abort. */
  maxDurationMs?: number;
}

// ── Batch & Phase ───────────────────────────────────────────

/** State of a single node during the upgrade. */
export interface NodeUpgradeState {
  nodeId: string;
  status: "pending" | "draining" | "upgrading" | "health_check" | "completed" | "failed" | "rolled_back";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/** A batch of nodes progressing through the rollout. */
export interface UpgradeBatch {
  /** 1-based batch index. */
  index: number;
  /** Node states in this batch. */
  nodes: NodeUpgradeState[];
  /** Overall batch status. */
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  /** If this is the canary batch. */
  isCanary: boolean;
}

/** Overall phase of the upgrade orchestration. */
export type UpgradePhase =
  | "idle"
  | "validating"
  | "canary"
  | "rolling"
  | "health_checking"
  | "completing"
  | "rolling_back"
  | "completed"
  | "failed"
  | "aborted"
  | "paused";

// ── Events ──────────────────────────────────────────────────

/** Event emitted during a rolling upgrade lifecycle. */
export interface RollingUpgradeEvent {
  type:
    | "plan_validated"
    | "batch_started"
    | "batch_health_checked"
    | "batch_promoted"
    | "batch_failed"
    | "canary_started"
    | "canary_health_checked"
    | "canary_promoted"
    | "canary_failed"
    | "rollback_triggered"
    | "rollback_completed"
    | "upgrade_completed"
    | "upgrade_aborted"
    | "paused"
    | "resumed";
  timestamp: number;
  batchIndex?: number;
  nodeId?: string;
  details: Record<string, unknown>;
}

/** Aggregate statistics after upgrade. */
export interface RollingUpgradeStats {
  planId: string;
  totalNodes: number;
  upgradedNodes: number;
  failedNodes: number;
  rolledBackNodes: number;
  totalBatches: number;
  completedBatches: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  phase: UpgradePhase;
  events: RollingUpgradeEvent[];
}
