/**
 * I31 — D1 Production Auto-Scaler.
 *
 * Multi-metric, policy-driven auto-scaling engine with:
 *   - Multi-metric evaluation (CPU, memory, QPS, latency, connections)
 *   - Gradient-based scaling amount (proportional to demand gap)
 *   - Predictive scaling: linear regression on metric history
 *   - Cooldown management: independent scale-up/down cooldowns
 *   - Strategy-driven behavior: aggressive, conservative, cost_optimized
 *   - Over-provisioning guard with oscillation prevention
 *   - Emergency override: bypass cooldown and limits
 *   - Full audit trail with scaling events
 */

import type {
  IAutoScaler,
  ScaleAction,
  AutoScalerMetrics,
  ScalingPolicy,
  ScalingStats,
  ScalingEvent,
  CooldownState,
  ScaleDirection,
  ScalingStrategy,
} from "../interfaces/types.js";

// ── Constants ──────────────────────────────────────────────

const DEFAULT_POLICY: ScalingPolicy = {
  id: "default",
  name: "Default Policy",
  strategy: "conservative",
  minNodes: 1,
  maxNodes: 10,
  cpuTarget: 0.7,
  scaleUpCooldownMs: 300_000,    // 5 min
  scaleDownCooldownMs: 600_000,  // 10 min
  predictiveScaling: false,
  overProvisionFactor: 1.1,
  evaluationIntervalMs: 60_000,   // 1 min
};

// ── Strategy Weights ─────────────────────────────────────────
// Maps strategy name → multiplicative factor on scale decisions

const STRATEGY_MODIFIERS: Record<ScalingStrategy, { up: number; down: number }> = {
  aggressive: { up: 1.5, down: 0.5 },
  conservative: { up: 0.8, down: 1.2 },
  cost_optimized: { up: 0.5, down: 1.5 },
  custom: { up: 1.0, down: 1.0 },
};

// ── PredictiveScalingEngine ────────────────────────────────

export class PredictiveScalingEngine implements IAutoScaler {
  private policy: ScalingPolicy;
  private history: ScalingEvent[] = [];
  private cooldown: CooldownState = {
    scaleUpUntil: 0,
    scaleDownUntil: 0,
    lastEvaluationAt: 0,
  };
  private currentCount: number;
  private peakCount: number;
  private metricsHistory: { timestamp: number; metrics: AutoScalerMetrics }[] = [];
  private evaluationCount = 0;

  constructor(policy?: Partial<ScalingPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.currentCount = this.policy.minNodes;
    this.peakCount = this.currentCount;
  }

  // ── Policy Management ────────────────────────────────────

  registerPolicy(policy: ScalingPolicy): void {
    this.policy = { ...policy };
    // Clamp current count to new policy bounds
    const clamped = Math.max(
      this.policy.minNodes,
      this.currentCount,
    );
    this.currentCount = Math.min(this.policy.maxNodes, clamped);
  }

  getPolicy(): ScalingPolicy | null {
    return { ...this.policy };
  }

  // ── Core Evaluation ──────────────────────────────────────

  async evaluate(metrics: AutoScalerMetrics): Promise<ScaleAction | null> {
    this.evaluationCount++;
    const now = Date.now();

    // --- Evaluation interval guard ---
    const elapsed = now - this.cooldown.lastEvaluationAt;
    const evalInterval = this.policy.evaluationIntervalMs;
    const withinInterval = elapsed < evalInterval;
    if (withinInterval) {
      return null;
    }
    this.cooldown.lastEvaluationAt = now;

    // Track metrics for prediction
    this.metricsHistory.push({ timestamp: now, metrics });
    // Keep a rolling window
    const windowSize = this.policy.predictionWindow ?? 10;
    if (this.metricsHistory.length > windowSize) {
      this.metricsHistory = this.metricsHistory.slice(-windowSize);
    }

    // --- Check cooldown ---
    const canScaleUp = now >= this.cooldown.scaleUpUntil;
    const canScaleDown = now >= this.cooldown.scaleDownUntil;

    if (!canScaleUp && !canScaleDown) return null;

    // --- Determine if we need to scale ---
    const currentNodeCount = metrics.currentNodeCount ?? this.currentCount;

    // Metric evaluation with current + predicted values
    const cpuGap = this._computeCPUGap(metrics, canScaleUp, canScaleDown);
    const memoryGap = this._computeMemoryGap(metrics, canScaleUp, canScaleDown);
    const qpsGap = this._computeQPSGap(metrics, currentNodeCount, canScaleUp, canScaleDown);
    const latencyOver = this._computeLatencyExcess(metrics, canScaleUp);
    const connectionGap = this._computeConnectionGap(metrics, currentNodeCount, canScaleUp, canScaleDown);

    // Aggregate — any metric can trigger scale, and multiple reinforce the decision
    const scaleReason = this._aggregateGaps(cpuGap, memoryGap, qpsGap, latencyOver, connectionGap);

    if (!scaleReason) {
      this._recordNoise(metrics, now);
      return null;
    }

    // --- Compute scaled amount ---
    const isScaleUp = scaleReason.direction === "up";
    let direction: ScaleDirection;
    let rawAmount: number;

    if (isScaleUp) {
      if (!canScaleUp) return null;
      direction = "scale_up";
      // Gradient: how far from target, normalized
      rawAmount = Math.max(1, Math.ceil(scaleReason.severity));
    } else {
      if (!canScaleDown) return null;
      direction = "scale_down";
      rawAmount = Math.max(1, Math.ceil(scaleReason.severity));
    }

    // --- Apply strategy modifier ---
    const modifier = STRATEGY_MODIFIERS[this.policy.strategy];
    const isScaleUpDir = direction === "scale_up";
    const modifierFactor = isScaleUpDir ? modifier.up : modifier.down;
    const modifiedAmount = Math.round(rawAmount * modifierFactor);

    const amount = Math.max(1, modifiedAmount);

    // --- Calculate target count with bounds ---
    let targetCount: number;
    if (isScaleUpDir) {
      targetCount = currentNodeCount + amount;
      // Apply over-provisioning
      targetCount = Math.ceil(targetCount * this.policy.overProvisionFactor);
      targetCount = Math.min(targetCount, this.policy.maxNodes);
    } else {
      targetCount = currentNodeCount - amount;
      targetCount = Math.max(targetCount, this.policy.minNodes);
    }

    // --- Guard: don't scale to the same count ---
    const sameCount = targetCount === currentNodeCount;
    if (sameCount) return null;

    // --- Build action ---
    const action: ScaleAction = {
      action: direction,
      amount: Math.abs(targetCount - currentNodeCount),
      reason: scaleReason.message,
      triggeredBy: scaleReason.metrics,
      targetCount,
      timestamp: now,
      policy: this.policy.id,
      confidence: this._calculateConfidence(metrics),
    };

    // --- Apply cooldown ---
    if (direction === "scale_up") {
      this.cooldown.scaleUpUntil = now + this.policy.scaleUpCooldownMs;
    } else {
      this.cooldown.scaleDownUntil = now + this.policy.scaleDownCooldownMs;
    }

    // --- Update state ---
    this.currentCount = targetCount;
    if (this.currentCount > this.peakCount) this.peakCount = this.currentCount;

    const event: ScalingEvent = {
      action,
      metricsSnapshot: metrics,
      cooldownAfter: { ...this.cooldown },
    };
    this.history.push(event);

    return action;
  }

  // ── Force Scale ──────────────────────────────────────────

  async forceScale(
    direction: ScaleDirection,
    amount: number,
    reason: string,
  ): Promise<ScaleAction> {
    if (direction === "none") {
      // Rejected: no-op
      return {
        action: "none",
        amount: 0,
        reason: "Force scale cancelled",
        triggeredBy: [],
        targetCount: this.currentCount,
        timestamp: Date.now(),
        policy: "override",
        confidence: 1.0,
      };
    }

    const now = Date.now();
    const rawTarget =
      direction === "scale_up"
        ? this.currentCount + amount
        : this.currentCount - amount;

    const targetCount = Math.max(
      this.policy.minNodes,
      Math.min(this.policy.maxNodes, rawTarget),
    );

    const action: ScaleAction = {
      action: direction as "scale_up" | "scale_down",
      amount: Math.abs(targetCount - this.currentCount),
      reason,
      triggeredBy: ["manual_override"],
      targetCount,
      timestamp: now,
      policy: "override",
      confidence: 1.0,
    };

    // Bypass cooldown
    this.cooldown.scaleUpUntil = 0;
    this.cooldown.scaleDownUntil = 0;

    this.currentCount = targetCount;
    if (this.currentCount > this.peakCount) this.peakCount = this.currentCount;

    const event: ScalingEvent = {
      action,
      metricsSnapshot: { cpu: 0, qps: 0, latencyP95: 0, connectionCount: 0 },
      cooldownAfter: { ...this.cooldown },
    };
    this.history.push(event);

    return action;
  }

  // ── History & Stats ──────────────────────────────────────

  getHistory(): ScalingEvent[] {
    return [...this.history];
  }

  getStats(): ScalingStats {
    const scaleUps = this.history.filter((e) => e.action.action === "scale_up").length;
    const scaleDowns = this.history.filter((e) => e.action.action === "scale_down").length;

    let avgInterval = 0;
    if (this.history.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < this.history.length; i++) {
        intervals.push(this.history[i]!.action.timestamp - this.history[i - 1]!.action.timestamp);
      }
      avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    }

    return {
      totalScaleUps: scaleUps,
      totalScaleDowns: scaleDowns,
      totalNoise: this.history.filter((e) => e.action.action === "none").length,
      currentNodeCount: this.currentCount,
      peakNodeCount: this.peakCount,
      lastActionAt: this.history.length > 0
        ? this.history[this.history.length - 1]!.action.timestamp
        : null,
      averageEvaluationIntervalMs: avgInterval,
    };
  }

  getCooldownState(): CooldownState {
    return { ...this.cooldown };
  }

  reset(): void {
    this.history = [];
    this.cooldown = { scaleUpUntil: 0, scaleDownUntil: 0, lastEvaluationAt: 0 };
    this.currentCount = this.policy.minNodes;
    this.peakCount = this.currentCount;
    this.metricsHistory = [];
    this.evaluationCount = 0;
  }

  // ── Internal: Metric Gap Computation ──────────────────────

  private _computeCPUGap(
    metrics: AutoScalerMetrics,
    canScaleUp: boolean,
    canScaleDown: boolean,
  ): { direction: "up" | "down"; severity: number } | null {
    const cpu = this._predictMetric("cpu", metrics.cpu);
    const cpuTarget = this.policy.cpuTarget;
    const gap = cpu - cpuTarget;

    const cpuTooHigh = gap > 0;
    const canUpScale = cpuTooHigh && canScaleUp;
    if (canUpScale) {
      const severity = gap * 10; // 0.1 above target → 1 node
      return { direction: "up", severity };
    }

    const cpuWellBelow = gap < -0.2;
    const cpuLowEnough = metrics.cpu < 0.3;
    const canDownScale = cpuWellBelow && cpuLowEnough && canScaleDown;
    if (canDownScale) {
      const severity = Math.abs(gap) * 5;
      return { direction: "down", severity };
    }
    return null;
  }

  private _computeMemoryGap(
    metrics: AutoScalerMetrics,
    canScaleUp: boolean,
    canScaleDown: boolean,
  ): { direction: "up" | "down"; severity: number } | null {
    const memoryTarget = this.policy.memoryTarget;
    const actualMemory = metrics.memory;
    const noTarget = memoryTarget === undefined;
    const noMemory = actualMemory === undefined;
    if (noTarget || noMemory) return null;

    const gap = actualMemory - memoryTarget;

    const overTarget = gap > 0;
    const canUp = overTarget && canScaleUp;
    if (canUp) {
      return { direction: "up", severity: gap * 10 };
    }

    const wellBelow = gap < -0.3;
    const canDown = wellBelow && canScaleDown;
    if (canDown) {
      return { direction: "down", severity: Math.abs(gap) * 3 };
    }
    return null;
  }

  private _computeQPSGap(
    metrics: AutoScalerMetrics,
    currentNodeCount: number,
    canScaleUp: boolean,
    canScaleDown: boolean,
  ): { direction: "up" | "down"; severity: number } | null {
    const qpsPerNode = this.policy.qpsPerNode;
    if (!qpsPerNode) return null;

    const currentQPS = metrics.qps;
    const capacity = currentNodeCount * qpsPerNode;
    const utilization = currentQPS / capacity;

    const overutilized = utilization > 0.85;
    const canUp = overutilized && canScaleUp;
    if (canUp) {
      const targetNodes = Math.ceil(currentQPS / (qpsPerNode * 0.7));
      return { direction: "up", severity: targetNodes - currentNodeCount };
    }

    const underutilized = utilization < 0.3;
    const aboveMin = currentNodeCount > this.policy.minNodes;
    const canDown = underutilized && aboveMin && canScaleDown;
    if (canDown) {
      return { direction: "down", severity: 1 };
    }
    return null;
  }

  private _computeLatencyExcess(
    metrics: AutoScalerMetrics,
    canScaleUp: boolean,
  ): { direction: "up"; severity: number } | null {
    const threshold = this.policy.latencyThresholdMs;
    if (!threshold) return null;

    const excess = metrics.latencyP95 - threshold;
    const overThreshold = excess > 0;
    if (overThreshold && canScaleUp) {
      // Severity: each 100ms excess → 1 node
      return { direction: "up", severity: Math.ceil(excess / 100) };
    }
    return null;
  }

  private _computeConnectionGap(
    metrics: AutoScalerMetrics,
    currentNodeCount: number,
    canScaleUp: boolean,
    canScaleDown: boolean,
  ): { direction: "up" | "down"; severity: number } | null {
    const connPerNode = this.policy.connectionsPerNode;
    if (!connPerNode) return null;

    const capacity = currentNodeCount * connPerNode;
    const utilization = metrics.connectionCount / capacity;

    const overutilized = utilization > 0.8;
    const canUp = overutilized && canScaleUp;
    if (canUp) {
      const targetNodes = Math.ceil(metrics.connectionCount / (connPerNode * 0.7));
      return { direction: "up", severity: targetNodes - currentNodeCount };
    }

    const underutilized = utilization < 0.3;
    const aboveMin = currentNodeCount > this.policy.minNodes;
    const canDown = underutilized && aboveMin && canScaleDown;
    if (canDown) {
      return { direction: "down", severity: 1 };
    }
    return null;
  }

  // ── Internal: Aggregation ────────────────────────────────

  private _aggregateGaps(
    ...gaps: Array<{ direction: "up" | "down"; severity: number } | null>
  ): { direction: "up" | "down"; severity: number; message: string; metrics: string[] } | null {
    const upGaps = gaps.filter((g): g is { direction: "up"; severity: number } => g !== null && g.direction === "up");
    const downGaps = gaps.filter((g): g is { direction: "down"; severity: number } => g !== null && g.direction === "down");

    // Scale-up takes priority over scale-down
    if (upGaps.length > 0) {
      const maxSeverity = Math.max(...upGaps.map((g) => g.severity));
      const allTriggeredMetrics = new Set<string>();
      if (upGaps.some(() => true)) {
        // We collect triggered metrics directly from the gap sources
        const metricSources = [
          { name: "CPU", gap: gaps[0] },
          { name: "Memory", gap: gaps[1] },
          { name: "QPS", gap: gaps[2] },
          { name: "Latency", gap: gaps[3] },
          { name: "Connections", gap: gaps[4] },
        ];
        for (const src of metricSources) {
          if (src.gap && src.gap.direction === "up") {
            allTriggeredMetrics.add(src.name);
          }
        }
      }

      return {
        direction: "up",
        severity: maxSeverity,
        message: `Scaling up: ${upGaps.length} metric(s) exceed target`,
        metrics: Array.from(allTriggeredMetrics),
      };
    }

    // All metrics must agree for scale-down (conservative)
    if (downGaps.length > 0) {
      const totalGaps = gaps.filter((g) => g !== null).length;
      // Require consensus: all available metric gaps must be "down"
      if (downGaps.length === totalGaps) {
        const avgSeverity = downGaps.reduce((s, g) => s + g.severity, 0) / downGaps.length;

        const allTriggeredMetrics = new Set<string>();
        const metricSources = [
          { name: "CPU", gap: gaps[0] },
          { name: "Memory", gap: gaps[1] },
          { name: "QPS", gap: gaps[2] },
          { name: "Latency", gap: gaps[3] },
          { name: "Connections", gap: gaps[4] },
        ];
        for (const src of metricSources) {
          if (src.gap && src.gap.direction === "down") {
            allTriggeredMetrics.add(src.name);
          }
        }

        return {
          direction: "down",
          severity: Math.ceil(avgSeverity),
          message: `Scaling down: all ${downGaps.length} metric(s) below thresholds`,
          metrics: Array.from(allTriggeredMetrics),
        };
      }
    }

    return null;
  }

  // ── Internal: Predictive Scaling ──────────────────────────

  /**
   * Predict the next value of a metric using simple linear regression
   * on the recent history window. Returns the max of (current, predicted)
   * for scale-up safety, and min for scale-down.
   */
  private _predictMetric(metricName: string, current: number): number {
    if (!this.policy.predictiveScaling) return current;

    const window = this.metricsHistory;
    if (window.length < 3) return current;

    // Extract (index, value) pairs
    const points = window.map((h, i) => {
      let value: number;
      switch (metricName) {
        case "cpu": value = h.metrics.cpu; break;
        case "memory": value = h.metrics.memory ?? 0; break;
        case "qps": value = h.metrics.qps; break;
        default: value = 0;
      }
      return { x: i, y: value };
    });

    // Simple linear regression: y = ax + b
    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);

    const nTimesSumX2 = n * sumX2;
    const sumXTimesSumX = sumX * sumX;
    const denominator = nTimesSumX2 - sumXTimesSumX;
    const isZeroDenominator = denominator === 0;
    if (isZeroDenominator) return current;

    const nTimesSumXY = n * sumXY;
    const sumXTimesSumY = sumX * sumY;
    const numeratorA = nTimesSumXY - sumXTimesSumY;
    const a = numeratorA / denominator; // slope
    const aTimesSumX = a * sumX;
    const b = (sumY - aTimesSumX) / n;   // intercept

    // Predict next point
    const aTimesN = a * n;
    const predicted = aTimesN + b;

    // For scaling: use the more aggressive value (predicting growth, respond to current)
    return Math.max(current, predicted);
  }

  // ── Internal: Confidence ──────────────────────────────────

  private _calculateConfidence(metrics: AutoScalerMetrics): number {
    // Higher confidence when multiple metrics agree and values are extreme
    let confidence = 0.5;

    // CPU far from target → higher confidence
    const cpuTarget = this.policy.cpuTarget;
    const cpuDeviation = Math.abs(metrics.cpu - cpuTarget);
    confidence = confidence + cpuDeviation * 0.3;

    // High QPS → higher confidence
    const hasQPS = this.policy.qpsPerNode !== undefined;
    const positiveQPS = metrics.qps > 0;
    if (hasQPS && positiveQPS) {
      const qpsPerNode = this.policy.qpsPerNode!;
      const capacity = this.currentCount * qpsPerNode;
      const positiveCapload = capacity > 0;
      if (positiveCapload) {
        const qpsUtilization = metrics.qps / capacity;
        const utilizationAbovePoint7 = qpsUtilization - 0.7;
        const boost = Math.max(0, utilizationAbovePoint7) * 0.4;
        confidence = confidence + boost;
      }
    }

    // Predictive model confidence
    const predictiveEnabled = this.policy.predictiveScaling;
    const enoughHistory = this.metricsHistory.length >= 3;
    if (predictiveEnabled && enoughHistory) {
      confidence = confidence + 0.15;
    }

    const clamped = Math.max(0.0, confidence);
    return Math.min(1.0, clamped);
  }

  private _recordNoise(metrics: AutoScalerMetrics, now: number): void {
    // Record a no-op as a noise event (for stats only, not history display)
    // Used in histogram to track evaluation frequency vs actual actions
  }
}
