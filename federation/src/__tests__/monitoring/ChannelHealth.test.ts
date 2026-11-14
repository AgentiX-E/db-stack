/**
 * ChannelHealth 测试 — 覆盖健康分计算公式、边界值、批量计算。
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

  // ── 完美健康 ────────────────────────────────────────────────────

  it('健康分 = 100 当所有指标完美', () => {
    const result = calc.calculate(BASE_METRICS);
    expect(result.healthScore).toBe(100);
    expect(result.level).toBe('healthy');
  });

  it('健康分 = 100 当 lag ≤ 100ms 且 errorRate = 0', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 50, throughputOps: 1000 });
    // 50ms lag: penalty = 50/1000 * 30 = 1.5 → score ≈ 98.5
    expect(result.healthScore).toBeGreaterThan(95);
    expect(result.level).toBe('healthy');
  });

  // ── Lag 惩罚 ────────────────────────────────────────────────────

  it('Lag 500ms 应导致部分健康分下降', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 500 });
    // penalty = 500/1000 * 30 = 15 → score ≈ 85
    expect(result.healthScore).toBeLessThan(100);
    expect(result.healthScore).toBeGreaterThan(80);
    expect(result.breakdown.lagPenalty).toBeCloseTo(15, 1);
  });

  it('Lag 1000ms 扣满 30 分', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 1000 });
    expect(result.breakdown.lagPenalty).toBeCloseTo(30, 1);
    expect(result.healthScore).toBeCloseTo(70, 1);
  });

  it('Lag 5000ms 仍最多扣 30 分（cap）', () => {
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 5000 });
    expect(result.breakdown.lagPenalty).toBe(30);
    expect(result.healthScore).toBe(70);
  });

  // ── ErrorRate 惩罚 ──────────────────────────────────────────────

  it('ErrorRate = 0.1 惩罚比 Lag=500ms 更重', () => {
    const lagResult = calc.calculate({ ...BASE_METRICS, lagMs: 500 });
    const errorResult = calc.calculate({ ...BASE_METRICS, errorRate: 0.1 });
    
    expect(errorResult.breakdown.errorPenalty).toBeGreaterThan(lagResult.breakdown.lagPenalty);
    expect(errorResult.healthScore).toBeLessThan(lagResult.healthScore);
  });

  it('ErrorRate = 0 时无惩罚', () => {
    const result = calc.calculate({ ...BASE_METRICS, errorRate: 0 });
    expect(result.breakdown.errorPenalty).toBe(0);
  });

  it('ErrorRate = 1.0 时扣分接近 40', () => {
    const result = calc.calculate({ ...BASE_METRICS, errorRate: 1.0 });
    // 1.0 / (1.0 + 0.01) * 40 ≈ 39.6
    expect(result.breakdown.errorPenalty).toBeGreaterThan(38);
    expect(result.breakdown.errorPenalty).toBeLessThanOrEqual(40);
  });

  // ── Reconnect 惩罚 ──────────────────────────────────────────────

  it('ReconnectCount = 0 时无惩罚', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 0 });
    expect(result.breakdown.reconnectPenalty).toBe(0);
  });

  it('ReconnectCount = 5 扣满 25 分', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 5 });
    expect(result.breakdown.reconnectPenalty).toBe(25);
  });

  it('ReconnectCount = 10 仍最多扣 25 分（cap）', () => {
    const result = calc.calculate({ ...BASE_METRICS, reconnectCount: 10 });
    expect(result.breakdown.reconnectPenalty).toBe(25);
  });

  // ── Jitter 惩罚 ─────────────────────────────────────────────────

  it('Jitter = 0 时无惩罚', () => {
    const result = calc.calculate({ ...BASE_METRICS, jitterMs: 0 });
    expect(result.breakdown.jitterPenalty).toBe(0);
  });

  it('Jitter = 100ms 时有对数惩罚', () => {
    const result = calc.calculate({ ...BASE_METRICS, jitterMs: 100 });
    // log2(101) * 2 ≈ 13.3 (capped at 10)
    expect(result.breakdown.jitterPenalty).toBeGreaterThan(0);
    expect(result.breakdown.jitterPenalty).toBeLessThanOrEqual(10);
  });

  // ── 综合场景 ────────────────────────────────────────────────────

  it('综合降级场景健康分在 0-100 范围内', () => {
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

  it('极端坏情况健康分 = 0', () => {
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

  // ── 健康等级分段 ────────────────────────────────────────────────

  it('健康分 ≥ 80 被标记为 healthy', () => {
    // 只扣 20 分：400ms lag = 12 分
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 400 });
    expect(result.healthScore).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe('healthy');
  });

  it('健康分 50-79 被标记为 degraded', () => {
    // lag 800ms + reconnect 2: 24 + 10 = 34 扣分 → 健康分 66
    const result = calc.calculate({ ...BASE_METRICS, lagMs: 800, reconnectCount: 2 });
    expect(result.healthScore).toBeGreaterThanOrEqual(50);
    expect(result.healthScore).toBeLessThan(80);
    expect(result.level).toBe('degraded');
  });

  it('健康分 < 50 被标记为 critical', () => {
    // lag 1000 + reconnect 5 + error 0.5: 30 + 25 + 19.6 = 74.6 扣分
    const result = calc.calculate({
      ...BASE_METRICS,
      lagMs: 1000,
      reconnectCount: 5,
      errorRate: 0.5,
    });
    expect(result.healthScore).toBeLessThan(50);
    expect(result.level).toBe('critical');
  });

  // ── 批量计算 ────────────────────────────────────────────────────

  it('批量计算正确返回所有通道健康分', () => {
    const results = calc.calculateBatch([
      { name: 'us-east', metrics: { ...BASE_METRICS, lagMs: 50 } },
      { name: 'eu-west', metrics: { ...BASE_METRICS, lagMs: 500, errorRate: 0.02 } },
      { name: 'ap-south', metrics: { ...BASE_METRICS, lagMs: 2000, reconnectCount: 5 } },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe('us-east');
    expect(results[0]!.result.level).toBe('healthy');
    expect(results[2]!.result.level).toBe('critical');
  });
});
