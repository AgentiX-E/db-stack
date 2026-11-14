/**
 * AutoTunerWorker — Production-grade background auto-tuning service.
 *
 * Features:
 *   - Periodic analysis at configurable intervals
 *   - Smoothing: EMA smoothing of raw metrics to reduce oscillation
 *   - Cooldown: skip recommendation if same param was changed recently
 *   - Feedback: tracks whether applied recommendations improved the metric
 *   - Configurable min confidence and learning rate
 *
 * @module @agentix-e/db-operations-autotuner/impl
 */

import type { IAutoTuner } from '../interfaces/index.js';
import type { TuningRecommendation, AutoScalerMetrics } from '../interfaces/types.js';

// ── Config ───────────────────────────────────────────────────

export interface AutoTunerWorkerConfig {
  /** Analysis interval in ms (default: 60s). */
  analysisIntervalMs?: number;
  /** EMA alpha for metric smoothing (0-1, default: 0.3). */
  smoothingAlpha?: number;
  /** Cooldown in ms before re-tuning the same parameter (default: 300s). */
  cooldownMs?: number;
  /** Maximum recommendations per cycle (default: 3). */
  maxRecommendations?: number;
  /** Metric history window (number of samples, default: 10). */
  metricWindowSize?: number;
  /** Minimum confidence to auto-apply a recommendation (default: 0.7). */
  minConfidence?: number;
}

interface AppliedRecommendation {
  parameter: string;
  appliedAt: number;
  oldValue: number;
  newValue: number;
  metricBefore: { cpu: number; latency: number; qps: number };
  metricAfter?: { cpu: number; latency: number; qps: number };
}

// ══════════════════════════════════════════════════════════════
//  AutoTunerWorker
// ══════════════════════════════════════════════════════════════

export class AutoTunerWorker {
  readonly name = 'autotuner-worker';

  private readonly tuner: IAutoTuner;
  private readonly config: Required<AutoTunerWorkerConfig>;

  /** Smoothed metrics (EMA). */
  private smoothed: AutoScalerMetrics = { cpu: 0, latency: 0, qps: 0 };

  /** Metric history for trend analysis. */
  private metricHistory: AutoScalerMetrics[] = [];

  /** Recently applied recommendations (cooldown tracking). */
  private appliedHistory: AppliedRecommendation[] = [];

  /** Running timer. */
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(tuner: IAutoTuner, config?: AutoTunerWorkerConfig) {
    this.tuner = tuner;
    this.config = {
      analysisIntervalMs: config?.analysisIntervalMs ?? 60_000,
      smoothingAlpha: config?.smoothingAlpha ?? 0.3,
      cooldownMs: config?.cooldownMs ?? 300_000,
      maxRecommendations: config?.maxRecommendations ?? 3,
      metricWindowSize: config?.metricWindowSize ?? 10,
      minConfidence: config?.minConfidence ?? 0.7,
    };
  }

  // ── Metric smoothing ──────────────────────────────────────

  /**
   * Update raw metrics. Applies EMA smoothing internally.
   * Feed this from your monitoring pipeline.
   */
  feedMetrics(raw: AutoScalerMetrics): void {
    // EMA smoothing
    const alpha = this.config.smoothingAlpha;
    if (this.metricHistory.length === 0) {
      this.smoothed = { ...raw };
    } else {
      this.smoothed = {
        cpu: alpha * raw.cpu + (1 - alpha) * this.smoothed.cpu,
        latency: alpha * raw.latency + (1 - alpha) * this.smoothed.latency,
        qps: alpha * raw.qps + (1 - alpha) * this.smoothed.qps,
      };
    }

    this.metricHistory.push({ ...raw });
    if (this.metricHistory.length > this.config.metricWindowSize) {
      this.metricHistory.shift();
    }
  }

  /**
   * Get current smoothed metrics.
   */
  getSmoothedMetrics(): AutoScalerMetrics {
    return { ...this.smoothed };
  }

  // ── Background analysis ───────────────────────────────────

  /**
   * Start periodic analysis.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runAnalysis().catch((err) => {
        console.error('[AutoTunerWorker] Analysis failed:', err);
      });
    }, this.config.analysisIntervalMs);
  }

  /**
   * Stop periodic analysis.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single analysis cycle.
   */
  async runAnalysis(): Promise<TuningRecommendation[]> {
    const metrics = this.smoothed;
    const raw = await this.tuner.analyze(metrics);

    // Filter by cooldown and confidence
    const now = Date.now();
    let appliedCount = 0;

    for (const rec of raw) {
      if (appliedCount >= this.config.maxRecommendations) break;

      // Check cooldown
      const lastApplied = this.appliedHistory.find(
        (h) => h.parameter === rec.parameter,
      );
      if (lastApplied && (now - lastApplied.appliedAt) < this.config.cooldownMs) {
        continue;
      }

      // Check confidence
      if (rec.confidence < this.config.minConfidence) {
        continue;
      }

      // Apply
      await this.tuner.apply(rec);

      this.appliedHistory.push({
        parameter: rec.parameter,
        appliedAt: now,
        oldValue: rec.currentValue,
        newValue: rec.recommendedValue,
        metricBefore: { ...metrics },
      });

      appliedCount++;
    }

    return raw.filter((r) => r.confidence >= this.config.minConfidence);
  }

  /**
   * Feed back metrics after recommendation was applied.
   * Used for learning: was the recommendation effective?
   */
  feedbackEffect(parameter: string, currentMetrics: AutoScalerMetrics): void {
    const lastApplied = this.appliedHistory.find(
      (h) => h.parameter === parameter && !h.metricAfter,
    );
    if (lastApplied) {
      lastApplied.metricAfter = { ...currentMetrics };
    }
  }

  /**
   * Get applied recommendation history.
   */
  getAppliedHistory(): AppliedRecommendation[] {
    return [...this.appliedHistory];
  }
}
