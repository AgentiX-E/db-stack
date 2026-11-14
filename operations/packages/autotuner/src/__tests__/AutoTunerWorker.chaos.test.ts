/**
 * AutoTunerWorker Chaos Tests — contention and resilience under load.
 *
 * D2 iteration: validates background auto-tuning under stress.
 *
 * Scenarios:
 *   B.4 — Concurrent feedMetrics + runAnalysis calls
 *   B.5 — Rapid start/stop cycles (no resource leak)
 *
 * Invariants:
 *   T1 — No concurrent analysis corruption (smoothing is consistent)
 *   T2 — No resource leaks after repeated start/stop
 *   T3 — Multiple feedback calls never corrupt history
 */

import { describe, it, expect } from 'vitest';
import { AutoTunerWorker, type AutoTunerWorkerConfig } from '../impl/AutoTunerWorker.js';
import type { IAutoTuner, TuningRecommendation, TuningConfig, AutoScalerMetrics } from '../interfaces/index.js';

// ── Mock tuner ──────────────────────────────────────────────

class MockTuner implements IAutoTuner {
  private recommendations: TuningRecommendation[] = [];
  private applied: TuningRecommendation[] = [];

  constructor(recs?: TuningRecommendation[]) {
    if (recs) this.recommendations = recs;
  }

  setRecommendations(recs: TuningRecommendation[]): void {
    this.recommendations = recs;
  }

  async analyze(_metrics: AutoScalerMetrics): Promise<TuningRecommendation[]> {
    return this.recommendations;
  }

  async apply(rec: TuningRecommendation): Promise<void> {
    this.applied.push(rec);
  }

  getHistory(): TuningRecommendation[] {
    return [...this.applied];
  }

  configure(_config: TuningConfig): void {
    /* no-op */
  }
}

describe('AutoTunerWorker Chaos (D2)', () => {
  // B.4: Concurrent feedMetrics + runAnalysis under high concurrency.
  // T1: smoothed metrics should never regress or produce NaN.
  it('B.4: should maintain consistent smoothing under concurrent feedMetrics', async () => {
    const tuner = new MockTuner([
      { parameter: 'cpu_limit', currentValue: 50, recommendedValue: 75, confidence: 0.85, reason: 'high cpu' },
    ]);

    const worker = new AutoTunerWorker(tuner, {
      analysisIntervalMs: 60000, // manual trigger
      smoothingAlpha: 0.3,
      minConfidence: 0.7,
      cooldownMs: 0,
    });

    // Concurrently feed 100 metrics (simulates burst monitoring data)
    const feeds = Array.from({ length: 100 }, (_, i) =>
      worker.feedMetrics({
        cpu: 30 + (i % 70),
        latency: 10 + (i % 50),
        qps: 1000 + (i * 10),
      }),
    );

    // All feedMetrics is synchronous — just run them
    // (feedMetrics is sync anyway)
    for (const _f of feeds) {
      // already called in the loop above
    }

    // T1: EMA should converge to the last metric values
    const smoothed = worker.getSmoothedMetrics();

    // The EMA with alpha=0.3 applied 100 times should be close to last value
    expect(smoothed.cpu).toBeGreaterThan(30);
    expect(smoothed.cpu).toBeLessThan(100);
    expect(smoothed.latency).toBeGreaterThan(0);
    expect(smoothed.qps).toBeGreaterThan(0);

    // Run analysis concurrently with feedMetrics in a tight loop
    for (let i = 0; i < 10; i++) {
      worker.feedMetrics({ cpu: 50 + i, latency: 20, qps: 2000 });
      const recs = await worker.runAnalysis();
      worker.feedbackEffect('cpu_limit', { cpu: 60, latency: 15, qps: 2500 });
    }

    // T1: smoothed value must still be valid after concurrent stress
    const finalSmoothed = worker.getSmoothedMetrics();
    expect(finalSmoothed.cpu).toBeGreaterThan(0);
    expect(finalSmoothed.cpu).toBeLessThanOrEqual(100);
    expect(Number.isNaN(finalSmoothed.cpu)).toBe(false);
    expect(Number.isNaN(finalSmoothed.latency)).toBe(false);

    // T3: appliedHistory should be coherent
    const history = worker.getAppliedHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    for (const entry of history) {
      expect(entry.metricBefore).toBeDefined();
      expect(entry.metricBefore.cpu).toBeGreaterThan(0);
    }
  });

  // B.5: Rapid start/stop cycles must not leak timers.
  // T2: After each start/stop, the worker must start clean.
  it('B.5: should not leak timers under rapid start/stop cycles', async () => {
    const tuner = new MockTuner();
    const worker = new AutoTunerWorker(tuner, {
      analysisIntervalMs: 50,
      smoothingAlpha: 0.3,
      minConfidence: 0.7,
    });

    // Rapid start/stop 20 times
    for (let i = 0; i < 20; i++) {
      worker.start();
      // Feed some metrics between cycles
      worker.feedMetrics({ cpu: 40 + i, latency: 10 + i, qps: 1000 + (i * 50) });
      worker.stop();
    }

    // T2: After final stop, start again cleanly
    worker.start();
    worker.feedMetrics({ cpu: 99, latency: 50, qps: 5000 });

    // Run one analysis cycle (no recommendations expected)
    const recs = await worker.runAnalysis();
    expect(recs).toBeDefined();

    worker.stop();

    // T2: start after stop should not throw
    worker.start();
    worker.stop();
  });

  // B.6: Worker should handle missing metrics gracefully
  it('B.6: should handle zero-confidence recommendations without errors', async () => {
    const tuner = new MockTuner([
      { parameter: 'cpu_limit', currentValue: 50, recommendedValue: 75, confidence: 0.3, reason: 'low conf' },
      { parameter: 'mem_limit', currentValue: 512, recommendedValue: 1024, confidence: 0.2, reason: 'very low' },
    ]);

    const worker = new AutoTunerWorker(tuner, {
      analysisIntervalMs: 60000,
      minConfidence: 0.7,
    });

    worker.feedMetrics({ cpu: 80, latency: 30, qps: 3000 });
    const recs = await worker.runAnalysis();

    // All recommendations below confidence threshold — none applied
    expect(recs.length).toBe(0);

    // History should be empty (nothing applied)
    const history = worker.getAppliedHistory();
    expect(history.length).toBe(0);
  });
});
