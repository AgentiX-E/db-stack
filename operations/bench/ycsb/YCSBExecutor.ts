/**
 * YCSBExecutor — Runs a YCSB workload against a target interface
 *
 * @module bench/ycsb/YCSBExecutor
 */

import type { YCSBConfig, WorkloadType } from './YCSBWorkload.js';

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface YCSBResult {
  workload: WorkloadType;
  totalOps: number;
  durationMs: number;
  throughput: number;
  readLatency: LatencyStats;
  updateLatency: LatencyStats;
  errors: number;
  timestamp: string;
  nodeVersion: string;
  platform: string;
}

export interface YCSBTarget<T> {
  read: (key: string) => Promise<T>;
  update: (key: string, value: T) => Promise<void>;
  insert: (key: string, value: T) => Promise<void>;
  scan: (count: number) => Promise<T[]>;
}

function computeLatencyStats(sortedLatencies: number[]): LatencyStats {
  if (sortedLatencies.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const p50Index = Math.floor(sortedLatencies.length * 0.50);
  const p95Index = Math.floor(sortedLatencies.length * 0.95);
  const p99Index = Math.floor(sortedLatencies.length * 0.99);
  const last = sortedLatencies[sortedLatencies.length - 1];
  return {
    p50: sortedLatencies[p50Index] ?? last,
    p95: sortedLatencies[p95Index] ?? last,
    p99: sortedLatencies[p99Index] ?? last,
    max: last,
  };
}

function* zipfianGenerator(alpha: number, seed: number): Generator<number> {
  const theta = 1.0 - alpha;
  const zetaN = 1.0 / (1.0 - theta);
  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    const u = state / 2147483647;
    const uz = u * zetaN;
    if (uz < 1.0) yield Math.pow(uz, 1.0 / (1.0 - theta));
    else yield u;
  }
}

function* uniformGenerator(seed: number): Generator<number> {
  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    yield state / 2147483647;
  }
}

function* latestGenerator(seed: number): Generator<number> {
  let state = seed;
  while (true) {
    state = (state * 16807) % 2147483647;
    yield Math.pow(state / 2147483647, 3);
  }
}

type DistributionGenerator = Generator<number>;

function createDistribution(type: 'uniform' | 'zipfian' | 'latest', seed: number): DistributionGenerator {
  switch (type) {
    case 'uniform': return uniformGenerator(seed);
    case 'zipfian': return zipfianGenerator(0.99, seed);
    case 'latest': return latestGenerator(seed);
  }
}

export class YCSBExecutor<T = string> {
  private config: YCSBConfig;

  constructor(config: YCSBConfig) {
    this.config = { ...config };
  }

  async run(target: YCSBTarget<T>): Promise<YCSBResult> {
    const { recordCount, operationCount } = this.config;

    await this.populate(target, recordCount);

    const operations = this.generateOperations();
    const warmupOps = operations.slice(0, 100);
    await this.executeBatch(target, warmupOps);

    const measureOps = operations.slice(100);
    const cooldownCut = Math.floor(measureOps.length * 0.1);
    const trimmedOps = measureOps.slice(cooldownCut, measureOps.length - cooldownCut);

    const { readLatencies, updateLatencies, errorCount, durationMs } =
      await this.executeBatch(target, trimmedOps);

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

  private async populate(target: YCSBTarget<T>, count: number): Promise<void> {
    const value = this.generateRecordValue();
    for (let i = 0; i < count; i++) {
      await target.insert(`user${i}`, value);
    }
  }

  private generateRecordValue(): T {
    const { fieldLength } = this.config;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < fieldLength; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result as unknown as T;
  }

  private generateOperations(): Array<{ type: 'read' | 'update' | 'insert' | 'scan' | 'readModifyWrite'; key: string }> {
    const { operationCount, recordCount, readProportion, updateProportion, insertProportion, scanProportion, readModifyWriteProportion, requestDistribution } = this.config;
    const dist = createDistribution(requestDistribution, 42);
    const typeDist = uniformGenerator(12345);
    const ops: Array<{ type: 'read' | 'update' | 'insert' | 'scan' | 'readModifyWrite'; key: string }> = [];
    let insertCounter = recordCount;

    for (let i = 0; i < operationCount; i++) {
      const u = typeDist.next().value ?? 0.5;
      if (u < readProportion) {
        ops.push({ type: 'read', key: `user${Math.floor((dist.next().value ?? 0.5) * recordCount)}` });
      } else if (u < readProportion + updateProportion) {
        ops.push({ type: 'update', key: `user${Math.floor((dist.next().value ?? 0.5) * recordCount)}` });
      } else if (u < readProportion + updateProportion + insertProportion) {
        ops.push({ type: 'insert', key: `user${insertCounter++}` });
      } else if (u < readProportion + updateProportion + insertProportion + scanProportion) {
        ops.push({ type: 'scan', key: `scan-${i}` });
      } else {
        ops.push({ type: 'readModifyWrite', key: `user${Math.floor((dist.next().value ?? 0.5) * recordCount)}` });
      }
    }

    return ops;
  }

  private async executeBatch(
    target: YCSBTarget<T>,
    operations: Array<{ type: string; key: string }>,
  ): Promise<{ readLatencies: number[]; updateLatencies: number[]; errorCount: number; durationMs: number }> {
    const readLatencies: number[] = [];
    const updateLatencies: number[] = [];
    let errorCount = 0;
    const start = Date.now();

    for (const op of operations) {
      try {
        const value = this.generateRecordValue();
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
            const t0 = performance.now();
            await target.read(op.key);
            readLatencies.push(performance.now() - t0);
            const t1 = performance.now();
            await target.update(op.key, value);
            updateLatencies.push(performance.now() - t1);
            break;
          }
        }
      } catch {
        errorCount++;
      }
    }

    return { readLatencies, updateLatencies, errorCount, durationMs: Date.now() - start };
  }
}
