/**
 * ChannelHealth tests — covers the health score formula, boundary values and batch calculation.
 */
import { describe, it, expect } from 'vitest';
import { ChannelHealthCalculator, type ChannelHealthMetrics } from '../../monitoring/ChannelHealth';

const BASE_METRICS: ChannelHealthMetrics = {
  lagMs: 0,
  jitterMs: 0,
  throughputOps: 1000,
  errorRate: 0,
  reconnectCount: 0,
};

describe('ChannelHealthCalculator', () => {
  const calc = new ChannelHealthCalculator();

  // ── Perfect health ──────────────────────────────────────────────

  it('health score = 100 when every metric is perfect', () => {
    const result = calc.calculate(BASE_METRICS);
    expect(result.healthScore).toBe(100);
    expect(result.level).toBe('healthy');
  });

  it('health score = 100 when lag ≤ 100ms and errorRate = 0', () => {
    const result = calc.calculate({
      ...BASE_METRICS,
      lagMs: 50,
      throughputOps: 1000,
    });
    // 50ms lag: penalty = 50/1000 * 30 = 1.5 → score ≈ 98.5
    expect(result.healthScore).toBeGreaterThan(95);
    expect(result.level).toBe('healthy');
  });

  // ── Lag penalty ─────────────────────────────────────────────────

  it('a 500ms lag lowers the health score partially', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 500 });
    // penalty = 500/1000 * 30 = 15 → score ≈ 85
    expect(result.healthScore).toBeLessThan(100);
    expect(result.healthScore).toBeGreaterThan(80);
    expect(result.breakdown.lagPenalty).toBeCloseTo(15, 1);
  });

  it('a 1000ms lag deducts the full 30 points', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 1000 });
    expect(result.breakdown.lagPenalty).toBeCloseTo(30, 1);
    expect(result.healthScore).toBeCloseTo(70, 1);
  });

  it('a 5000ms lag still deducts at most 30 points (cap)', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 5000 });
    expect(result.breakdown.lagPenalty).toBe(30);
    expect(result.healthScore).toBe(70);
  });

  // ── ErrorRate penalty ───────────────────────────────────────────

  it('ErrorRate = 0.1 weighs more than Lag = 500ms', () => {
    const lagResult = calc.calculate({ ...BASE_METRICS, lagMs: 500 });
    const errorResult = calc.calculate({ ...BASE_METRICS, errorRate: 0.1 });

    expect(errorResult.breakdown.errorPenalty).toBeGreaterThan(lagResult.breakdown.lagPenalty);
    expect(errorResult.healthScore).toBeLessThan(lagResult.healthScore);
  });

  it('no penalty when ErrorRate = 0', () => {
    const result = calc.calculate({ ...BASE_METRICS, errorRate: 0 });
    expect(result.breakdown.errorPenalty).toBe(0);
  });

  it('ErrorRate = 1.0 deducts close to 40', () => {
    const result = calc.calculate({ ...BASE_METRICS, errorRate: 1.0 });
    // 1.0 / (1.0 + 0.01) * 40 ≈ 39.6
    expect(result.breakdown.errorPenalty).toBeGreaterThan(38);
    expect(result.breakdown.errorPenalty).toBeLessThanOrEqual(40);
  });

  // ── Reconnect penalty ───────────────────────────────────────────

  it('no penalty when ReconnectCount = 0', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 0 });
    expect(result.breakdown.reconnectPenalty).toBe(0);
  });

  it('ReconnectCount = 5 deducts the full 25 points', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 5 });
    expect(result.breakdown.reconnectPenalty).toBe(25);
  });

  it('ReconnectCount = 10 still deducts at most 25 points (cap)', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 10 });
    expect(result.breakdown.reconnectPenalty).toBe(25);
  });

  // ── Jitter penalty ──────────────────────────────────────────────

  it('no penalty when Jitter = 0', () => {
    const result = calc.calculate({ ...BASE_METRICS, jitterMs: 0 });
    expect(result.breakdown.jitterPenalty).toBe(0);
  });

  it('Jitter = 100ms incurs a logarithmic penalty', () => {
    const result = calc.calculate({ ...BASE_METRICS, jitterMs: 100 });
    // log2(101) * 2 ≈ 13.3 (capped at 10)
    expect(result.breakdown.jitterPenalty).toBeGreaterThan(0);
    expect(result.breakdown.jitterPenalty).toBeLessThanOrEqual(10);
  });

  // ── Combined scenario ───────────────────────────────────────────

  it('a combined degraded scenario keeps the health score within 0-100', () => {
    const result = calc.calculate({
      lagMs: 800,
      jitterMs: 50,
      throughputOps: 100,
      errorRate: 0.05,
      reconnectCount: 3,
    });
    expect(result.healthScore).toBeGreaterThanOrEqual(0);
    expect(result.healthScore).toBeLessThanOrEqual(100);
  });

  it('the worst case gives a health score of 0', () => {
    const result = calc.calculate({
      lagMs: 5000,
      jitterMs: 5000,
      throughputOps: 0,
      errorRate: 1.0,
      reconnectCount: 10,
    });
    expect(result.healthScore).toBe(0);
    expect(result.level).toBe('critical');
  });

  // ── Health level bands ──────────────────────────────────────────

  it('a health score ≥ 80 is marked healthy', () => {
    // only 20 points deducted: 400ms lag = 12 points
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 400 });
    expect(result.healthScore).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe('healthy');
  });

  it('a health score of 50-79 is marked degraded', () => {
    // lag 800ms + reconnect 2: 24 + 10 = 34 points deducted → health score 66
    const result = calc.calculate({
      ...BASE_METRICS,
      lagMs: 800,
      reconnectCount: 2,
    });
    expect(result.healthScore).toBeGreaterThanOrEqual(50);
    expect(result.healthScore).toBeLessThan(80);
    expect(result.level).toBe('degraded');
  });

  it('a health score < 50 is marked critical', () => {
    // lag 1000 + reconnect 5 + error 0.5: 30 + 25 + 19.6 = 74.6 points deducted
    const result = calc.calculate({
      ...BASE_METRICS,
      lagMs: 1000,
      reconnectCount: 5,
      errorRate: 0.5,
    });
    expect(result.healthScore).toBeLessThan(50);
    expect(result.level).toBe('critical');
  });

  // ── Batch calculation ───────────────────────────────────────────

  it('batch calculation returns the health score of every channel', () => {
    const results = calc.calculateBatch([
      { name: 'us-east', metrics: { ...BASE_METRICS, lagMs: 50 } },
      {
        name: 'eu-west',
        metrics: { ...BASE_METRICS, lagMs: 500, errorRate: 0.02 },
      },
      {
        name: 'ap-south',
        metrics: { ...BASE_METRICS, lagMs: 2000, reconnectCount: 5 },
      },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe('us-east');
    expect(results[0]!.result.level).toBe('healthy');
    expect(results[2]!.result.level).toBe('critical');
  });
});
