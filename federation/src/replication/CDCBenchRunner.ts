/**
 * I25 — B3 CDC Hardening: CDCBenchRunner.
 *
 * Throughput and latency benchmarking for CDC sinks.
 * Measures:
 *   - Events per second (EPS) for batch sizes 1..N
 *   - Latency: p50, p95, p99, p99.9, max
 *   - Buffer pressure under sustained load
 *   - Batching efficiency factor
 */

import type { ICDCSink, CDCEvent } from '../interfaces/replication/ICDCSink';

// ── Types ──────────────────────────────────────────────────

export interface CDCBenchConfig {
  /** Number of total events to emit. Default: 10_000 */
  totalEvents: number;
  /** Batch sizes to test. Default: [1, 10, 100, 500, 1000] */
  batchSizes: number[];
  /** Number of warmup events before measurement. Default: 100 */
  warmupEvents: number;
  /** Concurrent emit parallelism. Default: 1 (serial) */
  concurrency: number;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  p99_9: number;
  min: number;
  max: number;
  mean: number;
}

export interface BatchBenchResult {
  batchSize: number;
  totalEvents: number;
  totalDurationMs: number;
  eventsPerSecond: number;
  latency: LatencyPercentiles;
}

export interface CDCBenchReport {
  totalEvents: number;
  overallDurationMs: number;
  overallEps: number;
  batches: BatchBenchResult[];
}

const DEFAULT_CONFIG: CDCBenchConfig = {
  totalEvents: 10_000,
  batchSizes: [1, 10, 100, 500, 1000],
  warmupEvents: 100,
  concurrency: 1,
};

// ── CDCBenchRunner ─────────────────────────────────────────

export class CDCBenchRunner {
  private config: CDCBenchConfig;

  constructor(config: Partial<CDCBenchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a full benchmark suite against a sink.
   * Tests each batch size, measures throughput + latency.
   */
  async run(sink: ICDCSink): Promise<CDCBenchReport> {
    await sink.connect();

    const overallStart = Date.now();
    const batchResults: BatchBenchResult[] = [];

    for (const batchSize of this.config.batchSizes) {
      const result = await this._benchBatchSize(sink, batchSize);
      batchResults.push(result);
    }

    const overallDurationMs = Date.now() - overallStart;
    const totalEmitted = batchResults.reduce((sum, r) => sum + r.totalEvents, 0);

    await sink.disconnect();

    return {
      totalEvents: totalEmitted,
      overallDurationMs,
      overallEps: totalEmitted / (overallDurationMs / 1000),
      batches: batchResults,
    };
  }

  /**
   * Run a single batch size benchmark.
   */
  private async _benchBatchSize(sink: ICDCSink, batchSize: number): Promise<BatchBenchResult> {
    const total = this.config.totalEvents;
    const latencies: number[] = [];
    const batchStart = Date.now();

    // Warmup
    await this._emitWarmup(sink, batchSize);

    // Measurement
    let emitted = 0;
    while (emitted < total) {
      const batchCount = Math.min(batchSize, total - emitted);
      const events = this._generateEvents(batchCount, emitted);

      const t0 = Date.now();
      await sink.emit(events);
      const t1 = Date.now();

      latencies.push(t1 - t0);
      emitted += batchCount;
    }

    const batchDurationMs = Date.now() - batchStart;

    return {
      batchSize,
      totalEvents: total,
      totalDurationMs: batchDurationMs,
      eventsPerSecond: total / (batchDurationMs / 1000),
      latency: this._computePercentiles(latencies),
    };
  }

  /**
   * Run a latency-only benchmark (single batch size, detailed measurements).
   */
  async latencyBench(sink: ICDCSink, batchSize = 100, samples = 1000): Promise<LatencyPercentiles> {
    await sink.connect();

    // Warmup
    await this._emitWarmup(sink, batchSize);

    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
      const events = this._generateEvents(batchSize, i * batchSize);
      const t0 = performance.now();
      await sink.emit(events);
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }

    await sink.disconnect();
    return this._computePercentiles(latencies);
  }

  // ── Internal ─────────────────────────────────────────────

  private async _emitWarmup(sink: ICDCSink, batchSize: number): Promise<void> {
    const warmupBatches = Math.ceil(this.config.warmupEvents / batchSize);
    for (let i = 0; i < warmupBatches; i++) {
      const events = this._generateEvents(batchSize, i * batchSize);
      await sink.emit(events);
    }
  }

  private _generateEvents(count: number, startIdx: number): CDCEvent[] {
    const events: CDCEvent[] = [];
    for (let i = 0; i < count; i++) {
      events.push({
        id: `evt-${startIdx + i}`,
        type: 'insert',
        table: 'bench_table',
        key: `key-${startIdx + i}`,
        data: { idx: startIdx + i, payload: `data-${startIdx + i}` },
        timestamp: BigInt(Date.now()),
      });
    }
    return events;
  }

  private _computePercentiles(latencies: number[]): LatencyPercentiles {
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, p99_9: 0, min: 0, max: 0, mean: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;

    const percentile = (p: number): number => {
      const idx = Math.ceil((p / 100) * n) - 1;
      // Guarded by the empty-check above, `n >= 1` here and the clamped index
      // is always within [0, n-1], so the element is always defined.
      return sorted[Math.min(Math.max(idx, 0), n - 1)]!;
    };

    return {
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      p99_9: percentile(99.9),
      min: sorted[0]!,
      max: sorted[n - 1]!,
      mean: latencies.reduce((sum, v) => sum + v, 0) / n,
    };
  }
}
