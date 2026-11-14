/**
 * I31 — D1 Auto-Scaling interfaces.
 *
 * Production-grade auto-scaler with:
 *   - Multi-metric decision engine (CPU, memory, QPS, latency, connections)
 *   - Predictive scaling with linear regression trend analysis
 *   - Cooldown management (scale-up/down independent cooldowns)
 *   - Multi-strategy policies (aggressive, conservative, cost-optimized)
 *   - Gradient-based scaling amount (proportional to demand)
 *   - Over-provisioning guard (prevents oscillation)
 *   - Override/emergency scaling
 *
 * @module @agentix-e/db-operations-autoscaler
 */

// ── Metrics ─────────────────────────────────────────────────

/** Rich multi-dimensional metrics snapshot. */
export interface AutoScalerMetrics {
  /** CPU utilization (0.0–1.0). */
  cpu: number;
  /** Memory utilization (0.0–1.0). */
  memory?: number;
  /** Queries per second. */
  qps: number;
  /** P95 latency in milliseconds. */
  latencyP95: number;
  /** Active connection count. */
  connectionCount: number;
  /** Current node count. */
  currentNodeCount?: number;
  /** Custom metric values (extensible). */
  custom?: Record<string, number>;
}

// ── Scale Action ────────────────────────────────────────────

export type ScaleDirection = "scale_up" | "scale_down" | "none";

export interface ScaleAction {
  /** Direction of scaling. */
  action: ScaleDirection;
  /** Number of nodes to add or remove. */
  amount: number;
  /** Human-readable reason. */
  reason: string;
  /** Which metric(s) triggered the action. */
  triggeredBy: string[];
  /** Target node count after scaling. */
  targetCount: number;
  /** Timestamp of the action (epoch ms). */
  timestamp: number;
  /** Scaling policy that produced this action. */
  policy: string;
  /** Confidence score for predictive actions (0.0–1.0). */
  confidence?: number;
}

// ── Scaling Policy ──────────────────────────────────────────

export type ScalingStrategy = "aggressive" | "conservative" | "cost_optimized" | "custom";

export interface ScalingPolicy {
  /** Unique policy identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Scaling strategy. */
  strategy: ScalingStrategy;
  /** Minimum node count. */
  minNodes: number;
  /** Maximum node count. */
  maxNodes: number;
  /** CPU target utilization (0.0–1.0). */
  cpuTarget: number;
  /** Memory target utilization (0.0–1.0). */
  memoryTarget?: number;
  /** QPS per node target. */
  qpsPerNode?: number;
  /** P95 latency threshold (ms). */
  latencyThresholdMs?: number;
  /** Max connections per node. */
  connectionsPerNode?: number;
  /** Scale-up cooldown (ms). */
  scaleUpCooldownMs: number;
  /** Scale-down cooldown (ms). */
  scaleDownCooldownMs: number;
  /** Whether predictive scaling is enabled. */
  predictiveScaling: boolean;
  /** How many data points needed for prediction (min 3). */
  predictionWindow?: number;
  /** How much to overshoot scale-up (e.g., 1.2 = 20% over-provision). */
  overProvisionFactor: number;
  /** Minimum evaluation interval (ms) between decisions. */
  evaluationIntervalMs: number;
}

// ── Cooldown State ──────────────────────────────────────────

export interface CooldownState {
  scaleUpUntil: number;
  scaleDownUntil: number;
  lastEvaluationAt: number;
}

// ── Scaling History ─────────────────────────────────────────

export interface ScalingEvent {
  action: ScaleAction;
  metricsSnapshot: AutoScalerMetrics;
  cooldownAfter: CooldownState;
}

// ── Scaling Statistics ──────────────────────────────────────

export interface ScalingStats {
  totalScaleUps: number;
  totalScaleDowns: number;
  totalNoise: number;
  currentNodeCount: number;
  peakNodeCount: number;
  lastActionAt: number | null;
  averageEvaluationIntervalMs: number;
  predictionAccuracy?: number;
}

// ── Auto-Scaler Interface ───────────────────────────────────

export interface IAutoScaler {
  /** Evaluate metrics and produce a scaling decision. */
  evaluate(metrics: AutoScalerMetrics): Promise<ScaleAction | null>;

  /** Get scaling history. */
  getHistory(): ScalingEvent[];

  /** Get scaling statistics. */
  getStats(): ScalingStats;

  /** Register a scaling policy. */
  registerPolicy(policy: ScalingPolicy): void;

  /** Get active policy. */
  getPolicy(): ScalingPolicy | null;

  /** Force an immediate scale action (bypass cooldown and policy limits). */
  forceScale(direction: ScaleDirection, amount: number, reason: string): Promise<ScaleAction>;

  /** Get current cooldown state. */
  getCooldownState(): CooldownState;

  /** Reset all state (for testing). */
  reset(): void;
}
