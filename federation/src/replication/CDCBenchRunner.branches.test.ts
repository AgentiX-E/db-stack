/**
 * CDCBenchRunner — branch-completion tests.
 *
 * Targets the `_computePercentiles` decision branches that the CDC4-CDC6
 * suite leaves implicit:
 *   - empty latency sample (early return of all-zero percentile object)
 *   - single-element sample (percentile clamping to index 0)
 *   - percentile interpolation across the full [0, n-1] index range
 */

import { describe, it, expect } from 'vitest';
import { CDCBenchRunner } from './CDCBenchRunner';

describe('CDCBenchRunner — _computePercentiles branch completion', () => {
  it('returns an all-zero percentile object for an empty sample', () => {
    const bench = new CDCBenchRunner();
    const result = bench['_computePercentiles']([]);
    expect(result).toEqual({
      p50: 0,
      p95: 0,
      p99: 0,
      p99_9: 0,
      min: 0,
      max: 0,
      mean: 0,
    });
  });

  it('clamps percentile index to 0 for a single-element sample', () => {
    const bench = new CDCBenchRunner();
    const result = bench['_computePercentiles']([42]);
    expect(result.p50).toBe(42);
    expect(result.p95).toBe(42);
    expect(result.p99).toBe(42);
    expect(result.min).toBe(42);
    expect(result.max).toBe(42);
    expect(result.mean).toBe(42);
  });

  it('computes percentiles across the full index range', () => {
    const bench = new CDCBenchRunner();
    // 100 distinct ascending values 0..99
    const latencies = Array.from({ length: 100 }, (_, i) => i);
    const result = bench['_computePercentiles'](latencies);
    // idx = ceil(p/100 * n) - 1
    expect(result.p50).toBe(49); // ceil(50) - 1
    expect(result.p95).toBe(94); // ceil(95) - 1
    expect(result.p99).toBe(98); // ceil(99) - 1
    expect(result.p99_9).toBe(99); // ceil(99.9) - 1 = 99
    expect(result.min).toBe(0);
    expect(result.max).toBe(99);
    expect(result.mean).toBe(49.5);
  });
});
