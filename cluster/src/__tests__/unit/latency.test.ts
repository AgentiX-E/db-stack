/**
 * The measuring instrument, tested as an instrument.
 *
 * A benchmark's numbers are only as good as its statistics, and the statistics
 * are the one part of a performance suite that is never checked — because the
 * output looks plausible either way. These cases pin the definitions the rest of
 * the suite relies on, with an injected clock so the answers are exact rather
 * than approximately right.
 *
 * Acceptance criteria:
 *   AC 40.1  percentiles are nearest-rank values taken from the samples
 *   AC 40.2  a percentile is always a value that was actually observed
 *   AC 40.3  summarise is independent of input order
 *   AC 40.4  summarising no samples is an error, not zeros
 *   AC 40.5  warmup iterations are executed but not reported
 *   AC 40.6  every measured iteration is recorded, in order
 *   AC 40.7  a failing iteration propagates instead of being timed as a sample
 *   AC 40.8  describeLatency names the sample count and the tail
 */

import { describe, it, expect } from 'vitest';
import { summarise, measureLatency, describeLatency, ms } from '../../testing/latency';

describe('latency statistics', () => {
  it('AC 40.1 — percentiles are nearest-rank values from the sorted samples', () => {
    // 1..10 ms: median is the 5th value (nearest rank of 0.5 × 10 = 5), P95 and
    // P99 both fall on the 10th, because ceil(0.95 × 10) = ceil(0.99 × 10) = 10.
    const samples = [3, 1, 10, 4, 9, 2, 8, 5, 7, 6].map((v) => v * 1e6);

    const summary = summarise(samples);

    expect(summary.n).toBe(10);
    expect(summary.min).toBe(1e6);
    expect(summary.p50).toBe(5e6);
    expect(summary.p95).toBe(10e6);
    expect(summary.p99).toBe(10e6);
    expect(summary.max).toBe(10e6);
    expect(summary.mean).toBe(5.5e6);
  });

  it('AC 40.2 — every reported percentile is an observed value', () => {
    // Two clusters of values with nothing in between: an interpolating
    // implementation would report a P95 that no request ever took.
    const samples = [1, 1, 1, 1, 1, 1, 1, 1, 9, 9];

    const summary = summarise(samples);

    for (const value of [summary.min, summary.p50, summary.p95, summary.p99, summary.max]) {
      expect(samples).toContain(value);
    }
  });

  it('AC 40.3 — the summary does not depend on the order samples arrived in', () => {
    const ascending = summarise([1, 2, 3, 4, 5]);
    const descending = summarise([5, 4, 3, 2, 1]);
    expect(descending).toEqual(ascending);
  });

  it('AC 40.4 — summarising nothing is an error', () => {
    // A benchmark that collected no samples is broken; returning zeros would let
    // it pass every budget it was compared against.
    expect(() => summarise([])).toThrow(/no samples/);
  });

  it('AC 40.5 — warmup iterations run but are not part of the distribution', async () => {
    // The clock reads 1s per iteration for the three warmup iterations and 2ms
    // per iteration afterwards: a median that included the warmup would be three
    // orders of magnitude wrong, which is exactly what one cold sample does to a
    // budget in practice. Each iteration reads the clock twice, so the sequence is
    // 2 × (3 + 4) values.
    const second = 1_000_000_000;
    const twoMs = 2_000_000;
    const ticks = [
      0,
      second,
      second,
      2 * second,
      2 * second,
      3 * second,
      3 * second,
      3 * second + twoMs,
      3 * second + twoMs,
      3 * second + 2 * twoMs,
      3 * second + 2 * twoMs,
      3 * second + 3 * twoMs,
      3 * second + 3 * twoMs,
      3 * second + 4 * twoMs,
    ];
    let tick = 0;
    const now = () => ticks[tick++]!;

    const result = await measureLatency({
      warmup: 3,
      samples: 4,
      run: () => undefined,
      now,
    });

    expect(result.warmupElapsed).toHaveLength(3);
    expect(result.summary.n).toBe(4);
    expect(result.summary.p50).toBe(2_000_000);
    // The warmup cost is still reported separately: it is a real number, just a
    // different question.
    expect(Math.max(...result.warmupElapsed)).toBe(1_000_000_000);
  });

  it('AC 40.6 — every measured iteration is recorded, in order, with its result', async () => {
    let value = 0;
    const result = await measureLatency({
      warmup: 0,
      samples: 3,
      run: () => ++value,
      now: (() => {
        let clock = 0;
        return () => (clock += 5);
      })(),
    });

    expect(result.elapsed).toEqual([5, 5, 5]);
    expect(result.results).toEqual([1, 2, 3]);
    expect(result.warmupElapsed).toEqual([]);
  });

  it('AC 40.7 — a throwing iteration propagates instead of being timed', async () => {
    await expect(
      measureLatency({
        warmup: 0,
        samples: 3,
        run: (i) => {
          if (i === 1) throw new Error('propose failed');
          return i;
        },
      }),
    ).rejects.toThrow(/propose failed/);
  });

  it('AC 40.8 — the log line names the sample count and the tail', () => {
    const line = describeLatency('propose', summarise([1e6, 2e6, 3e6]));
    expect(line).toContain('propose');
    expect(line).toContain('n=3');
    expect(line).toContain('p99=');
    expect(line).toContain('median=');
    expect(ms(1_500_000)).toBe(1.5);
  });
});
