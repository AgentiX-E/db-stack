import type { IAutoScaler } from '../interfaces/index.js';
import type {
  AutoScalerMetrics,
  CooldownState,
  ScaleAction,
  ScaleDirection,
  ScalingEvent,
  ScalingPolicy,
  ScalingStats,
} from '../interfaces/types.js';

/**
 * InMemoryAutoScaler — lightweight, dependency-free `IAutoScaler`.
 *
 * A threshold-based scaler (CPU / QPS) used as the default implementation and
 * as the reference behaviour for the richer `PredictiveScalingEngine`.
 *
 * Thresholds are configurable through `configure()`, and a full
 * `ScalingPolicy` can be registered with `registerPolicy()`; the policy then
 * supplies the node bounds, cooldowns and the label recorded on each action.
 * With no policy registered the cooldowns are zero, so `evaluate()` always
 * reflects the current metrics.
 */
export class InMemoryAutoScaler implements IAutoScaler {
  private history: ScalingEvent[] = [];
  private policy: ScalingPolicy | null = null;

  private min = 1;
  private max = 10;
  private scaleUpThreshold = 0.8;
  private scaleDownThreshold = 0.2;

  /** Node count the scaler believes is currently running. */
  private currentNodes = 1;
  private peakNodes = 1;

  private totalScaleUps = 0;
  private totalScaleDowns = 0;
  private lastActionAt: number | null = null;
  private lastEvaluationAt = 0;
  private evaluationIntervals: number[] = [];

  private scaleUpUntil = 0;
  private scaleDownUntil = 0;

  /** Tune the threshold-based behaviour directly (schema-free usage). */
  configure(min: number, max: number, scaleUpThreshold: number, scaleDownThreshold: number): void {
    this.min = min;
    this.max = max;
    this.scaleUpThreshold = scaleUpThreshold;
    this.scaleDownThreshold = scaleDownThreshold;
    this.currentNodes = Math.min(Math.max(this.currentNodes, min), max);
    this.peakNodes = Math.max(this.peakNodes, this.currentNodes);
  }

  async evaluate(metrics: AutoScalerMetrics): Promise<ScaleAction | null> {
    const now = Date.now();
    this._recordEvaluation(now);

    if (metrics.currentNodeCount !== undefined) {
      this.currentNodes = metrics.currentNodeCount;
    }

    const { min, max } = this._bounds();
    const policyLabel = this.policy?.id ?? 'threshold';

    // ── Scale up ──
    if (metrics.cpu > this.scaleUpThreshold || metrics.qps >= 10000) {
      if (now < this.scaleUpUntil) return null;

      const triggeredBy: string[] = [];
      if (metrics.cpu > this.scaleUpThreshold) triggeredBy.push('cpu');
      if (metrics.qps >= 10000) triggeredBy.push('qps');

      const amount = Math.ceil((metrics.cpu + this.scaleUpThreshold) * 10) || 1;

      const action: ScaleAction = {
        action: 'scale_up',
        amount,
        reason: `CPU at ${(metrics.cpu * 100).toFixed(0)}% exceeding threshold ${(this.scaleUpThreshold * 100).toFixed(0)}%`,
        triggeredBy,
        targetCount: this.currentNodes + amount,
        timestamp: now,
        policy: policyLabel,
      };

      this._applyAction(action, metrics, now, 'up');
      return action;
    }

    // ── Scale down ──
    if (metrics.cpu < this.scaleDownThreshold) {
      if (now < this.scaleDownUntil) return null;

      const amount = 1;

      const action: ScaleAction = {
        action: 'scale_down',
        amount,
        reason: `CPU at ${(metrics.cpu * 100).toFixed(0)}% below threshold ${(this.scaleDownThreshold * 100).toFixed(0)}%`,
        triggeredBy: ['cpu'],
        targetCount: this.currentNodes - amount,
        timestamp: now,
        policy: policyLabel,
      };

      this._applyAction(action, metrics, now, 'down');
      return action;
    }

    return null;
  }

  getHistory(): ScalingEvent[] {
    return [...this.history];
  }

  getStats(): ScalingStats {
    const avgInterval =
      this.evaluationIntervals.length === 0
        ? 0
        : this.evaluationIntervals.reduce((a, b) => a + b, 0) / this.evaluationIntervals.length;

    return {
      totalScaleUps: this.totalScaleUps,
      totalScaleDowns: this.totalScaleDowns,
      totalNoise: 0,
      currentNodeCount: this.currentNodes,
      peakNodeCount: this.peakNodes,
      lastActionAt: this.lastActionAt,
      averageEvaluationIntervalMs: avgInterval,
    };
  }

  registerPolicy(policy: ScalingPolicy): void {
    this.policy = { ...policy };
    this.configure(policy.minNodes, policy.maxNodes, policy.cpuTarget, this.scaleDownThreshold);
  }

  getPolicy(): ScalingPolicy | null {
    return this.policy ? { ...this.policy } : null;
  }

  async forceScale(direction: ScaleDirection, amount: number, reason: string): Promise<ScaleAction> {
    const now = Date.now();
    const { min, max } = this._bounds();

    if (direction === 'none') {
      const action: ScaleAction = {
        action: 'none',
        amount: 0,
        reason,
        triggeredBy: ['manual'],
        targetCount: this.currentNodes,
        timestamp: now,
        policy: 'override',
      };
      this._applyAction(action, undefined, now, 'none');
      return action;
    }

    const delta = Math.max(0, amount);
    const target =
      direction === 'scale_up'
        ? Math.min(max, this.currentNodes + delta)
        : Math.max(min, this.currentNodes - delta);

    const action: ScaleAction = {
      action: direction,
      amount: Math.abs(target - this.currentNodes),
      reason,
      triggeredBy: ['manual'],
      targetCount: target,
      timestamp: now,
      policy: 'override',
    };

    this._applyAction(action, undefined, now, direction === 'scale_up' ? 'up' : 'down');
    return action;
  }

  getCooldownState(): CooldownState {
    return {
      scaleUpUntil: this.scaleUpUntil,
      scaleDownUntil: this.scaleDownUntil,
      lastEvaluationAt: this.lastEvaluationAt,
    };
  }

  reset(): void {
    this.history = [];
    this.policy = null;
    this.min = 1;
    this.max = 10;
    this.scaleUpThreshold = 0.8;
    this.scaleDownThreshold = 0.2;
    this.currentNodes = 1;
    this.peakNodes = 1;
    this.totalScaleUps = 0;
    this.totalScaleDowns = 0;
    this.lastActionAt = null;
    this.lastEvaluationAt = 0;
    this.evaluationIntervals = [];
    this.scaleUpUntil = 0;
    this.scaleDownUntil = 0;
  }

  // ── Internals ──────────────────────────────────────────────

  private _bounds(): { min: number; max: number } {
    return this.policy
      ? { min: this.policy.minNodes, max: this.policy.maxNodes }
      : { min: this.min, max: this.max };
  }

  private _recordEvaluation(now: number): void {
    if (this.lastEvaluationAt > 0) {
      this.evaluationIntervals.push(now - this.lastEvaluationAt);
      // Keep the average representative without unbounded growth.
      if (this.evaluationIntervals.length > 256) this.evaluationIntervals.shift();
    }
    this.lastEvaluationAt = now;
  }

  private _applyAction(
    action: ScaleAction,
    metrics: AutoScalerMetrics | undefined,
    now: number,
    direction: 'up' | 'down' | 'none',
  ): void {
    this.currentNodes = action.targetCount;
    this.peakNodes = Math.max(this.peakNodes, this.currentNodes);
    this.lastActionAt = now;

    if (direction === 'up') {
      this.totalScaleUps++;
      this.scaleUpUntil = now + (this.policy?.scaleUpCooldownMs ?? 0);
    } else if (direction === 'down') {
      this.totalScaleDowns++;
      this.scaleDownUntil = now + (this.policy?.scaleDownCooldownMs ?? 0);
    }

    this.history.push({
      action,
      metricsSnapshot: metrics ?? {
        cpu: 0,
        qps: 0,
        latencyP95: 0,
        connectionCount: 0,
        currentNodeCount: this.currentNodes,
      },
      cooldownAfter: this.getCooldownState(),
    });
  }
}
