/**
 * RaftMetricsCollector — branch completion
 *
 * Complements observability.test.ts with the histogram overflow branch:
 * `recordCommitLatency` with a latency above the last bucket boundary
 * (1000ms) must still be counted (overflow bucket), covering L87/L88.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RaftMetricsCollector } from '../../observability/RaftMetricsCollector';

describe('RaftMetricsCollector — branch completion', () => {
  let metrics: RaftMetricsCollector;

  beforeEach(() => {
    metrics = new RaftMetricsCollector();
  });

  it('records latency overflow above the last bucket boundary', () => {
    // ms > LATENCY_BUCKETS[last] (1000) drives the overflow bucket increment.
    metrics.recordCommitLatency(1500);
    metrics.recordCommitLatency(5000);

    const s = metrics.snapshot();
    // Last bucket (index 8, boundary 1000) receives the overflow samples.
    expect(s.commitLatencyBuckets[8]).toBe(2);
    // All other buckets stay empty (values exceed every boundary).
    expect(s.commitLatencyBuckets.slice(0, 8).reduce((a, b) => a + b, 0)).toBe(0);
    // Overflow samples still counted in the average.
    expect(s.commitLatencyMs).toBeGreaterThan(0);
  });

  it('latency exactly at the boundary is not overflow', () => {
    metrics.recordCommitLatency(1000);
    const s = metrics.snapshot();
    // 1000 <= 1000 → goes into the normal (≤1000) bucket, not overflow.
    expect(s.commitLatencyBuckets[8]).toBe(1);
  });
});
