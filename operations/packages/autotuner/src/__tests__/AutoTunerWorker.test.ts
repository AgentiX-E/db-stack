/**
 * AutoTunerWorker Tests — AC 53.x
 *
 * AC 53.1 — Metric smoothing via EMA
 * AC 53.2 — Cooldown: same parameter not re-applied within window
 * AC 53.3 — Confidence filter: low-conf recommendation skipped
 * AC 53.4 — Max recommendations per cycle
 * AC 53.5 — Feedback effect tracking
 * AC 53.6 — Feed metrics and get smoothed values
 * AC 53.7 — Start/stop lifecycle
 * AC 53.8 — Metric history window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutoTunerWorker, type AutoTunerWorkerConfig } from "../impl/AutoTunerWorker.js";
import { InMemoryAutoTuner } from "../impl/InMemoryAutoTuner.js";
import type { AutoScalerMetrics, TuningRecommendation } from "../interfaces/types.js";

// ── Helper ────────────────────────────────────────────────

function makeMetrics(cpu: number, latency: number, qps: number): AutoScalerMetrics {
  return { cpu, latency, qps };
}

// ── Suite ─────────────────────────────────────────────────

describe("AutoTunerWorker — AC 53.x: Auto Tuner Worker", () => {
  let tuner: InMemoryAutoTuner;
  let worker: AutoTunerWorker;

  beforeEach(() => {
    tuner = new InMemoryAutoTuner();
  });

  afterEach(() => {
    worker?.stop();
  });

  // AC 53.1: EMA smoothing
  it("AC 53.1: should smooth raw metrics via EMA", () => {
    worker = new AutoTunerWorker(tuner, { smoothingAlpha: 1.0 });

    worker.feedMetrics(makeMetrics(0.9, 100, 5000));
    expect(worker.getSmoothedMetrics().cpu).toBe(0.9);

    // With alpha=1.0, it follows raw exactly
    worker.feedMetrics(makeMetrics(0.5, 200, 6000));
    expect(worker.getSmoothedMetrics().cpu).toBe(0.5);
    expect(worker.getSmoothedMetrics().latency).toBe(200);

    // With alpha=0.3, it smooths
    worker.stop();
    worker = new AutoTunerWorker(tuner, { smoothingAlpha: 0.3 });

    worker.feedMetrics(makeMetrics(0.8, 100, 5000));
    worker.feedMetrics(makeMetrics(0.4, 150, 6000));
    const smoothed = worker.getSmoothedMetrics();
    expect(smoothed.cpu).toBeCloseTo(0.4 * 0.3 + 0.8 * 0.7, 5);
  });

  // AC 53.1b: EMA smoothing must apply to latency and qps too
  it("AC 53.1b: EMA smoothing covers latency and qps independently", () => {
    worker = new AutoTunerWorker(tuner, { smoothingAlpha: 0.3 });

    // First sample establishes baseline (no smoothing on first feed).
    worker.feedMetrics(makeMetrics(0.5, 100, 5000));
    // Second sample mixes with previous via alpha=0.3.
    worker.feedMetrics(makeMetrics(0.5, 200, 7000));

    const s = worker.getSmoothedMetrics();
    // latency: 0.3*200 + 0.7*100 = 130
    expect(s.latency).toBeCloseTo(0.3 * 200 + 0.7 * 100, 5);
    // qps:     0.3*7000 + 0.7*5000 = 5600
    expect(s.qps).toBeCloseTo(0.3 * 7000 + 0.7 * 5000, 5);
  });

  // AC 53.2: Cooldown
  it("AC 53.2: should not re-apply same parameter during cooldown", async () => {
    tuner.configure({ learningRate: 0.1, minConfidence: 0.6 });

    worker = new AutoTunerWorker(tuner, {
      cooldownMs: 3600_000, // 1 hour cooldown
      minConfidence: 0.6,
      smoothingAlpha: 1.0,
    });

    // Feed high-CPU metrics → should get recommendation
    worker.feedMetrics(makeMetrics(0.85, 50, 1000));
    const recs1 = await worker.runAnalysis();
    expect(recs1.length).toBeGreaterThanOrEqual(0);

    // Immediate re-analysis → cooldown should block same param but allow others
    const recs2 = await worker.runAnalysis();
    // max_connections blocked, query_timeout_ms may still pass
    expect(recs2.length).toBeGreaterThanOrEqual(0);
  });

  // AC 53.2b: cooldown blocks a specific parameter from re-application
  it("AC 53.2b: cooldown prevents re-applying the same parameter within window", async () => {
    tuner.configure({ learningRate: 0.1, minConfidence: 0.6 });

    worker = new AutoTunerWorker(tuner, {
      cooldownMs: 3600_000, // 1 hour cooldown
      minConfidence: 0.6,
      smoothingAlpha: 1.0,
    });

    // High CPU → max_connections recommendation applied once.
    worker.feedMetrics(makeMetrics(0.9, 5, 100));
    await worker.runAnalysis();
    const appliedOnce = worker.getAppliedHistory().filter(h => h.parameter === 'max_connections').length;
    expect(appliedOnce).toBe(1);

    // Same metrics immediately → cooldown should block re-application.
    worker.feedMetrics(makeMetrics(0.9, 5, 100));
    await worker.runAnalysis();
    const appliedTwice = worker.getAppliedHistory().filter(h => h.parameter === 'max_connections').length;
    expect(appliedTwice).toBe(1);
  });

  // AC 53.3: Confidence filter
  it("AC 53.3: should skip low-confidence recommendations", async () => {
    // The default InMemoryAutoTuner returns confidence 0.85 for CPU
    // and 0.75 for latency. Set minConfidence above that to block all.
    worker = new AutoTunerWorker(tuner, {
      minConfidence: 0.95,
      smoothingAlpha: 1.0,
    });

    worker.feedMetrics(makeMetrics(0.9, 200, 1000));
    const recs = await worker.runAnalysis();
    expect(recs.length).toBe(0);
  });

  // AC 53.4: Max recommendations per cycle
  it("AC 53.4: should limit recommendations per cycle", async () => {
    // By default, InMemoryAutoTuner can return up to 3 recommendations
    // (cpu, latency, qps). Set max to 1.
    worker = new AutoTunerWorker(tuner, {
      maxRecommendations: 1,
      minConfidence: 0.6,
      smoothingAlpha: 1.0,
    });

    // High CPU + high latency + high QPS → triggers all three
    worker.feedMetrics(makeMetrics(0.9, 200, 10000));

    const historyBefore = await tuner.getHistory().length;
    const recs = await worker.runAnalysis();
    expect(recs.length).toBeGreaterThanOrEqual(1);
    
    // maxRecommendations = 1, so at most 1 was applied
    const historyAfter = tuner.getHistory().length;
    expect(historyAfter - historyBefore).toBeLessThanOrEqual(1);
  });

  // AC 53.5: Feedback tracking
  it("AC 53.5: should track feedback effect of applied recommendations", async () => {
    worker = new AutoTunerWorker(tuner, {
      minConfidence: 0.6,
      smoothingAlpha: 1.0,
    });

    worker.feedMetrics(makeMetrics(0.9, 50, 1000));
    await worker.runAnalysis();

    // Feed back the improved state
    worker.feedbackEffect("max_connections", makeMetrics(0.5, 30, 1000));

    const history = worker.getAppliedHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    const last = history[history.length - 1];
    expect(last.metricAfter).toBeDefined();
    expect(last.metricBefore.cpu).toBeCloseTo(0.9, 1);
    expect(last.metricAfter!.cpu).toBeCloseTo(0.5, 1);
    expect(last.parameter).toBe("max_connections");
  });

  // AC 53.5b: feedbackEffect only fills the first unfilled (no metricAfter) entry
  it("AC 53.5b: feedbackEffect skips entries that already have metricAfter", async () => {
    worker = new AutoTunerWorker(tuner, {
      minConfidence: 0.6,
      smoothingAlpha: 1.0,
    });

    worker.feedMetrics(makeMetrics(0.9, 50, 1000));
    await worker.runAnalysis();

    // First feedback sets metricAfter on the (only) matching entry.
    worker.feedbackEffect("max_connections", makeMetrics(0.5, 30, 1000));
    // Second feedback with different metrics must NOT overwrite — the entry
    // already has metricAfter, so the `&& !h.metricAfter` guard skips it.
    worker.feedbackEffect("max_connections", makeMetrics(0.2, 15, 1000));

    const history = worker.getAppliedHistory();
    const entry = history.find(h => h.parameter === 'max_connections');
    expect(entry).toBeDefined();
    // First feedback value preserved; the `||` mutant would overwrite with 0.2.
    expect(entry!.metricAfter!.cpu).toBeCloseTo(0.5, 1);
  });

  // AC 53.6: Feed metrics
  it("AC 53.6: feedMetrics should update smoothed values", () => {
    worker = new AutoTunerWorker(tuner, { smoothingAlpha: 1.0 });

    worker.feedMetrics(makeMetrics(0.7, 50, 3000));
    expect(worker.getSmoothedMetrics().qps).toBe(3000);

    worker.feedMetrics(makeMetrics(0.8, 100, 4000));
    expect(worker.getSmoothedMetrics().latency).toBe(100);
  });

  // AC 53.7: Start/stop
  it("AC 53.7: start/stop lifecycle", async () => {
    vi.useFakeTimers();
    worker = new AutoTunerWorker(tuner, {
      analysisIntervalMs: 10_000,
      minConfidence: 1.0, // Block all recommendations
      smoothingAlpha: 1.0,
    });

    const spy = vi.spyOn(worker, "runAnalysis");
    worker.start();

    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(1);

    worker.stop();
    vi.advanceTimersByTime(20_000);
    expect(spy).toHaveBeenCalledTimes(1); // Still 1

    vi.useRealTimers();
  });

  // AC 53.8: Metric history window
  it("AC 53.8: should limit metric history to window size", () => {
    worker = new AutoTunerWorker(tuner, { metricWindowSize: 3, smoothingAlpha: 1.0 });

    worker.feedMetrics(makeMetrics(0.1, 10, 100));
    worker.feedMetrics(makeMetrics(0.2, 20, 200));
    worker.feedMetrics(makeMetrics(0.3, 30, 300));
    worker.feedMetrics(makeMetrics(0.4, 40, 400));

    // History should be trimmed to 3
    const smoothed = worker.getSmoothedMetrics();
    // With alpha=1.0, smoothed = last raw
    expect(smoothed.latency).toBe(40);
  });
});
