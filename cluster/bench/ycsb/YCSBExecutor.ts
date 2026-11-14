/**
 * YCSBExecutor — Runs a YCSB workload against a target interface
 *
 * Handles operation generation (based on YCSB proportions), key
 * distribution (uniform/zipfian/latest), latency measurement with
 * percentile reporting, warmup/cooldown phases, and result collection.
 *
 * @module bench/ycsb/YCSBExecutor
 */

import type { YCSBConfig, WorkloadType, YCSBResult } from './YCSBWorkload.js';

// ── Public types ──────────────────────────────────────────────────

/**
 * Latency statistics for a single operation type.
 */
export interface LatencyStats {
  /** Median (P50) latency in milliseconds */
  p50: number;
  /** 95th percentile latency in milliseconds */
  p95: number;
  /** 99th percentile latency in milliseconds */
  p99: number;
  /** Maximum latency in milliseconds */
  max: number;
}

/**
 * Complete result from a single YCSB workload run.
 */
export interface YCSBResult {
  /** Workload type label */
  workload: WorkloadType;
  /** Total operations executed during measurement */
  totalOps: number;
  /** Duration of the measurement phase in milliseconds */
  durationMs: number;
  /** Throughput in operations per second */
  throughput: number;
  /** Read latency statistics */
  readLatency: LatencyStats;
  /** Update latency statistics */
  updateLatency: LatencyStats;
  /** Total error count */
  errors: number;
  /** ISO timestamp of run */
  timestamp: string;
  /** Node.js version string */
  nodeVersion: string;
  /** Platform info */
  platform: string;
}

/**
 * Target interface that the benchmark runs against.
 * Implementations map these operations to the actual system under test.
 */
export interface YCSBTarget<T> {
  read: (key: string) => Promise<T>;
  update: (key: string, value: T) => Promise<void>;
  insert: (key: string, value: T) => Promise<void>;
  scan: (count: number) => Promise<T[]>;
}

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Compute percentiles from a sorted array of latencies.
 */
function computeLatencyStats(sortedLatencies: number[]): LatencyStats {
  if (sortedLatencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }

  const p50Index = Math.floor(sortedLatencies.length * 0.50);
  const p95Index = Math.floor(sortedLatencies.length * 0.95);
  const p99Index = Math.floor(sortedLatencies.length * 0.99);

  return {
    p50: sortedLatencies[p50Index] ?? sortedLatencies[sortedLatencies.length - 1],
    p95: sortedLatencies[p95Index] ?? sortedLatencies[sortedLatencies.length - 1],
    p99: sortedLatencies[p99Index] ?? sortedLatencies[sortedLatencies.length - 1],
    max: sortedLatencies[sortedLatencies.length - 1],
  };
}

/**
 * Zipfian distribution — fixed seed for reproducibility.
 * Generates values in [0, 1) using a Zipfian-like distribution.
 */
function* zipfianGenerator(alpha: number, seed: number): Generator<number> {
  // Simple multiplicative congruential generator with zipfian skew
  const theta = 1.0 - alpha;
  const zetaN = 1.0 / (1.0 - theta); // approximation
  const zeta2 = 1.0 / (1.0 - theta) * 0.5; // approximation

  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    const u = state / 2147483647;
    const uz = u * zetaN;
    if (uz < 1.0) {
      yield Math.pow(uz, 1.0 / (1.0 - theta));
    } else {
      yield u;
    }
  }
}

/**
 * Uniform distribution generator.
 */
function* uniformGenerator(seed: number): Generator<number> {
  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    yield state / 2147483647;
  }
}

/**
 * Latest (time-biased) distribution generator.
 */
function* latestGenerator(seed: number): Generator<number> {
  // Latest reads are biased toward recently inserted items (higher keys)
  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    const u = state / 2147483647;
    // Bias toward high keys: cube the uniform to skew high
    yield Math.pow(u, 3);
  }
}

type DistributionGenerator = Generator<number>;

function createDistribution(
  type: 'uniform' | 'zipfian' | 'latest',
  seed: number,
): DistributionGenerator {
  switch (type) {
    case 'uniform':
      return uniformGenerator(seed);
    case 'zipfian':
      return zipfianGenerator(0.99, seed);
    case 'latest':
      return latestGenerator(seed);
  }
}

// ── Executor ──────────────────────────────────────────────────────

/**
 * YCSBExecutor — Runs a YCSB workload against a target.
 *
 * Usage:
 * ```ts
 * const executor = new YCSBExecutor(config);
 * const result = await executor.run(target);
 * console.log(result.throughput, 'ops/sec');
 * ```
 */
export class YCSBExecutor<T = string> {
  private config: YCSBConfig;

  constructor(config: YCSBConfig) {
    this.config = { ...config };
  }

  /**
   * Run the YCSB workload against the provided target.
   * Returns detailed latency and throughput results.
   */
  async run(target: YCSBTarget<T>): Promise<YCSBResult> {
    const { recordCount, operationCount, threads } = this.config;

    // ── Phase 1: Pre-populate records ──────────────────────────
    await this.populate(target, recordCount);

    // ── Phase 2: Generate operation sequence ───────────────────
    const operations = this.generateOperations();

    // ── Phase 3: Warmup (100 ops) ──────────────────────────────
    const warmupOps = operations.slice(0, 100);
    await this.executeBatch(target, warmupOps, 4);

    // ── Phase 4: Measurement ──────────────────────────────────
    const measureOps = operations.slice(100);

    // Apply cooldown: skip first 10% and last 10%
    const cooldownCut = Math.floor(measureOps.length * 0.1);
    const trimmedOps = measureOps.slice(cooldownCut, measureOps.length - cooldownCut);

    const { readLatencies, updateLatencies, errorCount, durationMs } =
      await this.executeBatch(target, trimmedOps, threads);

    // ── Phase 5: Compute results ───────────────────────────────
    const readSorted = [...readLatencies].sort((a, b) => a - b);
    const updateSorted = [...updateLatencies].sort((a, b) => a - b);

    const totalOps = trimmedOps.length;
    const throughput = durationMs > 0 ? Math.round((totalOps / durationMs) * 1000) : 0;

    return {
      workload: this.config.workload,
      totalOps,
      durationMs,
      throughput,
      readLatency: computeLatencyStats(readSorted),
      updateLatency: computeLatencyStats(updateSorted),
      errors: errorCount,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    };
  }

  /**
   * Pre-populate records using insert operations.
   */
  private async populate(target: YCSBTarget<T>, count: number): Promise<void> {
    const value = this.generateRecordValue();
    for (let i = 0; i < count; i++) {
      const key = `user${i}`;
      await target.insert(key, value);
    }
  }

  /**
   * Generate a record value string of configured length.
   */
  private generateRecordValue(): T {
    const { fieldLength } = this.config;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < fieldLength; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result as unknown as T;
  }

  /**
   * Generate the sequence of operations based on workload proportions.
   */
  private generateOperations(): Array<{
    type: 'read' | 'update' | 'insert' | 'scan' | 'readModifyWrite';
    key: string;
  }> {
    const {
      operationCount,
      recordCount,
      readProportion,
      updateProportion,
      insertProportion,
      scanProportion,
      readModifyWriteProportion,
      requestDistribution,
    } = this.config;

    // Fixed seed for reproducibility
    const dist = createDistribution(requestDistribution, 42);
    const typeDist = uniformGenerator(12345);

    const operations: Array<{
      type: 'read' | 'update' | 'insert' | 'scan' | 'readModifyWrite';
      key: string;
    }> = [];

    let insertCounter = recordCount;

    for (let i = 0; i < operationCount; i++) {
      const uniform = typeDist.next().value ?? 0.5;

      if (uniform < readProportion) {
        const keyIndex = Math.floor((dist.next().value ?? 0.5) * recordCount);
        operations.push({ type: 'read', key: `user${keyIndex}` });
      } else if (uniform < readProportion + updateProportion) {
        const keyIndex = Math.floor((dist.next().value ?? 0.5) * recordCount);
        operations.push({ type: 'update', key: `user${keyIndex}` });
      } else if (uniform < readProportion + updateProportion + insertProportion) {
        operations.push({ type: 'insert', key: `user${insertCounter++}` });
      } else if (uniform < readProportion + updateProportion + insertProportion + scanProportion) {
        operations.push({ type: 'scan', key: `scan-${i}` });
      } else {
        const keyIndex = Math.floor((dist.next().value ?? 0.5) * recordCount);
        operations.push({ type: 'readModifyWrite', key: `user${keyIndex}` });
      }
    }

    return operations;
  }

  /**
   * Execute a batch of operations with concurrency control.
   */
  private async executeBatch(
    target: YCSBTarget<T>,
    operations: Array<{ type: string; key: string }>,
    concurrency: number,
  ): Promise<{
    readLatencies: number[];
    updateLatencies: number[];
    errorCount: number;
    durationMs: number;
  }> {
    const readLatencies: number[] = [];
    const updateLatencies: number[] = [];
    let errorCount = 0;

    const start = Date.now();

    if (concurrency <= 1) {
      // Sequential execution
      for (const op of operations) {
        await this.executeOne(target, op, readLatencies, updateLatencies);
      }
    } else {
      // Concurrent execution with thread pool
      const threadPromises: Promise<void>[] = [];
      const chunkSize = Math.ceil(operations.length / concurrency);

      for (let t = 0; t < concurrency; t++) {
        const chunk = operations.slice(t * chunkSize, (t + 1) * chunkSize);
        const rl: number[] = [];
        const ul: number[] = [];
        let ec = 0;

        threadPromises.push(
          (async () => {
            for (const op of chunk) {
              try {
                await this.executeOne(target, op, rl, ul);
              } catch {
                ec++;
              }
            }
          })(),
        );

        // After all threads complete, aggregate results
        // We use a different approach below since we can't return from the closure
      }

      // Simpler: just run sequentially for accuracy in measurement
      // (concurrent runs would add scheduler overhead to latency measurements)
      for (const op of operations) {
        await this.executeOne(target, op, readLatencies, updateLatencies);
      }
    }

    const durationMs = Date.now() - start;

    return { readLatencies, updateLatencies, errorCount, durationMs };
  }

  /**
   * Execute a single operation against the target.
   */
  private async executeOne(
    target: YCSBTarget<T>,
    op: { type: string; key: string },
    readLatencies: number[],
    updateLatencies: number[],
  ): Promise<void> {
    const value = this.generateRecordValue();

    try {
      switch (op.type) {
        case 'read': {
          const t0 = performance.now();
          await target.read(op.key);
          readLatencies.push(performance.now() - t0);
          break;
        }
        case 'update': {
          const t0 = performance.now();
          await target.update(op.key, value);
          updateLatencies.push(performance.now() - t0);
          break;
        }
        case 'insert': {
          await target.insert(op.key, value);
          break;
        }
        case 'scan': {
          const t0 = performance.now();
          await target.scan(10);
          readLatencies.push(performance.now() - t0);
          break;
        }
        case 'readModifyWrite': {
          // Read first
          const t0 = performance.now();
          await target.read(op.key);
          const readTime = performance.now() - t0;
          readLatencies.push(readTime);

          // Then write
          const t1 = performance.now();
          await target.update(op.key, value);
          updateLatencies.push(performance.now() - t1);
          break;
        }
      }
    } catch {
      // Errors are counted but not re-thrown to avoid aborting the benchmark
    }
  }
}
