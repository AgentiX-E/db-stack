/**
 * Latency statistics — the measuring instrument the performance suite uses.
 *
 * Why this file exists
 * --------------------
 * The cluster performance suite used to time *one cold call* per case and print
 * the number next to a `P50` label. A single sample is not a percentile, and a
 * cold one is not even a typical sample: it carries JIT compilation, first-touch
 * page faults and connection setup. The federation load job failed on exactly
 * that defect — `1.0086 ms` against a `1 ms` budget for a call whose steady-state
 * cost was `380 ns` — and the same instrument is what a regression baseline is
 * built from, so it has to be correct before any number it prints is believed.
 *
 * Design decisions:
 *
 *   - **Nearest rank, never interpolation.** A percentile must be a value the
 *     system actually produced. Averaging the two neighbours of a fractional rank
 *     invents a latency no request ever had, which is fine for a histogram and
 *     wrong for a claim like "P99 < 5 ms".
 *   - **Warmup is explicit and discarded.** The caller says how many iterations to
 *     run first; they are executed, timed for the record but never reported.
 *   - **Empty input is an error, not zero.** A benchmark that collected no samples
 *     is a broken benchmark, and returning `{p50: 0}` would let it pass.
 */

/** A latency distribution as observed, in nanoseconds. */
export interface LatencySummary {
  /** Samples that were measured (warmup excluded). */
  n: number;
  min: number;
  /** Median. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Options for {@link measureLatency}. */
export interface MeasureOptions<T> {
  /** Iterations to run and discard before measuring. */
  warmup: number;
  /** Iterations to measure. */
  samples: number;
  /** The operation under test. `i` counts every iteration, warmup included. */
  run: (i: number) => T | Promise<T>;
  /** Nanosecond clock, injectable so the statistics can be tested exactly. */
  now?: () => number;
}

/** What {@link measureLatency} returns. */
export interface MeasureResult<T> {
  summary: LatencySummary;
  /** Per-iteration elapsed nanoseconds, in the order they were measured. */
  elapsed: number[];
  /** Values returned by the measured iterations, in order. */
  results: T[];
  /** Elapsed time of the discarded warmup iterations — reported, never asserted on. */
  warmupElapsed: number[];
}

/**
 * Nearest-rank percentile of an already-sorted array.
 *
 * @param sorted Ascending samples; must not be empty.
 * @param fraction Percentile as a fraction in (0, 1].
 */
function percentileOfSorted(sorted: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
}

/**
 * Summarise a set of samples.
 *
 * @param samples Elapsed times in nanoseconds, in measurement order.
 * @throws When `samples` is empty — a distribution with no observations is not a
 *         measurement, and silently returning zeros makes a broken benchmark green.
 */
export function summarise(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    throw new Error('summarise: no samples — a benchmark that measured nothing has no percentiles');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    p50: percentileOfSorted(sorted, 0.5),
    p95: percentileOfSorted(sorted, 0.95),
    p99: percentileOfSorted(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
    mean: total / sorted.length,
  };
}

/**
 * Run `options.run` `warmup + samples` times and summarise the measured half.
 *
 * The warmup iterations are still timed, because "how much does the first call
 * cost" is a question worth answering — it is just a different question from "how
 * fast is this in steady state", and only the second one belongs in a P50.
 */
export async function measureLatency<T>(options: MeasureOptions<T>): Promise<MeasureResult<T>> {
  const now = options.now ?? (() => Number(process.hrtime.bigint()));
  const warmupElapsed: number[] = [];
  const elapsed: number[] = [];
  const results: T[] = [];

  for (let i = 0; i < options.warmup; i++) {
    const start = now();
    await options.run(i);
    warmupElapsed.push(now() - start);
  }
  for (let i = 0; i < options.samples; i++) {
    const start = now();
    const result = await options.run(options.warmup + i);
    elapsed.push(now() - start);
    results.push(result);
  }

  return { summary: summarise(elapsed), elapsed, results, warmupElapsed };
}

/** Milliseconds with three decimals — the unit every budget in this suite is written in. */
export function ms(ns: number): number {
  return Math.round((ns / 1e6) * 1000) / 1000;
}

/** One line for a CI log: sample count, median, tail, spread. */
export function describeLatency(label: string, summary: LatencySummary): string {
  return (
    `${label}: n=${summary.n} median=${ms(summary.p50)}ms p95=${ms(summary.p95)}ms ` +
    `p99=${ms(summary.p99)}ms min=${ms(summary.min)}ms max=${ms(summary.max)}ms`
  );
}
