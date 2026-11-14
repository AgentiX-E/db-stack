import { describe, it, expect } from 'vitest';
import { InMemoryAutoTuner } from '../impl/InMemoryAutoTuner.js';
import type { AutoScalerMetrics } from '../interfaces/types.js';

describe('InMemoryAutoTuner', () => {
  it('returns empty recommendations for low metrics', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.3, qps: 100, latency: 10, connectionCount: 5 };
    const recs = await tuner.analyze(metrics);
    expect(recs).toEqual([]);
  });

  it('recommends connection increase for high CPU', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.85, qps: 100, latency: 10, connectionCount: 5 };
    const recs = await tuner.analyze(metrics);
    const maxConn = recs.find(r => r.parameter === 'max_connections');
    expect(maxConn).toBeDefined();
    expect(maxConn!.confidence).toBeGreaterThan(0);
  });

  it('recommends timeout increase for high latency', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.3, qps: 100, latency: 200, connectionCount: 5 };
    const recs = await tuner.analyze(metrics);
    const timeout = recs.find(r => r.parameter === 'query_timeout_ms');
    expect(timeout).toBeDefined();
    expect(timeout!.recommendedValue).toBe(10000);
  });

  it('applies recommendation when confidence meets threshold', async () => {
    const tuner = new InMemoryAutoTuner();
    const rec = { parameter: 'max_connections', currentValue: 100, recommendedValue: 150, confidence: 0.85, reason: 'high CPU' };
    await tuner.apply(rec);
    expect(tuner.getHistory()).toHaveLength(1);
  });

  it('does not apply low-confidence recommendation', async () => {
    const tuner = new InMemoryAutoTuner();
    const rec = { parameter: 'unknown', currentValue: 1, recommendedValue: 2, confidence: 0.3, reason: 'uncertain' };
    await tuner.apply(rec);
    expect(tuner.getHistory()).toHaveLength(0);
  });

  it('configure updates thresholds', async () => {
    const tuner = new InMemoryAutoTuner();
    tuner.configure({ learningRate: 0.5, minConfidence: 0.9 });
    const rec = { parameter: 'pool_size', currentValue: 10, recommendedValue: 20, confidence: 0.85, reason: 'test' };
    await tuner.apply(rec);
    expect(tuner.getHistory()).toHaveLength(0);
  });

  it('recommends pool increase for high QPS', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.3, qps: 10000, latency: 10, connectionCount: 10 };
    const recs = await tuner.analyze(metrics);
    const pool = recs.find(r => r.parameter === 'pool_size');
    expect(pool).toBeDefined();
    expect(pool!.recommendedValue).toBeGreaterThan(10);
  });

  it('computes pool size as min(20, ceil(qps/500))', async () => {
    const tuner = new InMemoryAutoTuner();
    // qps = 5200 (exceeds 5000 threshold) → ceil(5200/500) = ceil(10.4) = 11
    // → min(20, 11) = 11. The `/500` divisor is observable here: a `*500`
    // mutant would yield min(20, 2_600_000) = 20, failing the exact assertion.
    const metrics: AutoScalerMetrics = { cpu: 0.3, qps: 5200, latency: 10, connectionCount: 10 };
    const recs = await tuner.analyze(metrics);
    const pool = recs.find(r => r.parameter === 'pool_size');
    expect(pool).toBeDefined();
    expect(pool!.recommendedValue).toBe(11);
  });

  it('reports CPU percentage in the recommendation reason', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.85, qps: 100, latency: 10, connectionCount: 5 };
    const recs = await tuner.analyze(metrics);
    const maxConn = recs.find(r => r.parameter === 'max_connections');
    expect(maxConn).toBeDefined();
    // 0.85 * 100 = 85%; a `/100` mutant would produce "0%" here.
    expect(maxConn!.reason).toContain('85%');
  });

  it('returns multiple recommendations when multiple thresholds exceeded', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.85, qps: 8000, latency: 200, connectionCount: 20 };
    const recs = await tuner.analyze(metrics);
    expect(recs.length).toBeGreaterThanOrEqual(3);
  });

  it('apply does not throw on valid recommendation', async () => {
    const tuner = new InMemoryAutoTuner();
    const rec = { parameter: 'query_timeout_ms', currentValue: 5000, recommendedValue: 10000, confidence: 0.9, reason: 'high latency' };
    await expect(tuner.apply(rec)).resolves.not.toThrow();
  });

  it('history is immutable snapshot', async () => {
    const tuner = new InMemoryAutoTuner();
    const rec = { parameter: 'pool_size', currentValue: 10, recommendedValue: 15, confidence: 0.8, reason: 'growth' };
    await tuner.apply(rec);
    const history = tuner.getHistory();
    history.push(rec);
    expect(tuner.getHistory()).toHaveLength(1);
  });

  it('handles zero QPS and latency gracefully', async () => {
    const tuner = new InMemoryAutoTuner();
    const metrics: AutoScalerMetrics = { cpu: 0.5, qps: 0, latency: 0, connectionCount: 0 };
    const recs = await tuner.analyze(metrics);
    expect(recs).toEqual([]);
  });
});
