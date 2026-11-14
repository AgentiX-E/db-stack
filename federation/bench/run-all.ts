/**
 * run-all — Orchestrator that runs all YCSB benchmarks for db-federation
 *
 * Executes 4 federation-relevant workloads (A, B, C, F) sequentially.
 *
 * @module bench/run-all
 */

import { YCSBExecutor, type YCSBResult } from './ycsb/YCSBExecutor.js';
import { defaultYCSBConfig, type WorkloadType, WORKLOAD_DESCRIPTIONS } from './ycsb/YCSBWorkload.js';
import { formatMarkdown, formatJSON, saveJSON } from './ycsb/result-formatter.js';

// ── In-memory federation target (same as federation-ycsb) ─────────

interface ShardRecord {
  data: string;
  version: number;
}

class FederationBenchTarget {
  private shards: Map<string, Map<string, ShardRecord>> = new Map();
  private cdcLog: string[] = [];
  private shardCount = 3;

  constructor() {
    for (let s = 0; s < this.shardCount; s++) this.shards.set(`shard-${s}`, new Map());
  }

  private getShard(key: string): Map<string, ShardRecord> {
    const idx = Math.abs(this.hashKey(key)) % this.shardCount;
    return this.shards.get(`shard-${idx}`)!;
  }

  private hashKey(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) ((hash = (hash << 5) - hash + key.charCodeAt(i)), (hash |= 0));
    return Math.abs(hash);
  }

  async read(key: string): Promise<string> {
    const shard = this.getShard(key);
    const val = shard.get(key);
    return val ? JSON.stringify(val) : '{}';
  }

  async update(key: string, value: string): Promise<void> {
    const shard = this.getShard(key);
    const existing = shard.get(key) ?? { data: '', version: 0 };
    existing.data = value;
    existing.version++;
    shard.set(key, existing);
    this.cdcLog.push(JSON.stringify({ type: 'update', key, version: existing.version }));
  }

  async insert(key: string, value: string): Promise<void> {
    const shard = this.getShard(key);
    shard.set(key, { data: value, version: 1 });
    this.cdcLog.push(JSON.stringify({ type: 'insert', key }));
  }

  async scan(count: number): Promise<string[]> {
    const results: string[] = [];
    let remaining = count;
    for (let s = 0; s < this.shardCount && remaining > 0; s++) {
      const shard = this.shards.get(`shard-${s}`)!;
      const keys = Array.from(shard.keys());
      const toTake = Math.min(remaining, 5);
      for (let i = 0; i < toTake && i < keys.length; i++) {
        const v = shard.get(keys[i]);
        if (v) results.push(JSON.stringify({ key: keys[i], value: v }));
      }
      remaining -= toTake;
    }
    return results;
  }

  reset(): void {
    this.shards.clear();
    for (let s = 0; s < this.shardCount; s++) this.shards.set(`shard-${s}`, new Map());
    this.cdcLog = [];
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(80));
  console.log('  YCSB Performance Benchmarks — db-federation');
  console.log('═'.repeat(80));
  console.log('');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Workloads: A (update heavy), B (read mostly), C (read only), F (RMW)`);
  console.log(`Operations per workload: 1000`);
  console.log('');

  const allResults: YCSBResult[] = [];
  const workloads: WorkloadType[] = ['A', 'B', 'C', 'F'];

  for (const wl of workloads) {
    const target = new FederationBenchTarget();
    const config = defaultYCSBConfig(wl);
    config.operationCount = 1000;
    config.recordCount = 1000;

    const executor = new YCSBExecutor<string>(config);
    console.log(`── Workload ${wl}: ${WORKLOAD_DESCRIPTIONS[wl]} ──`);

    const result = await executor.run({
      read: (key: string) => target.read(key),
      update: (key: string, value: string) => target.update(key, value),
      insert: (key: string, value: string) => target.insert(key, value),
      scan: (count: number) => target.scan(count),
    });

    allResults.push(result);
    console.log(`  Throughput: ${result.throughput} ops/s`);
    console.log(
      `  Read: P50=${result.readLatency.p50.toFixed(3)}ms  P95=${result.readLatency.p95.toFixed(3)}ms  P99=${result.readLatency.p99.toFixed(3)}ms`,
    );
    console.log(
      `  Update: P50=${result.updateLatency.p50.toFixed(3)}ms  P95=${result.updateLatency.p95.toFixed(3)}ms  P99=${result.updateLatency.p99.toFixed(3)}ms`,
    );
    if (result.errors > 0) console.log(`  ⚠ Errors: ${result.errors}`);
    console.log('');
  }

  console.log('-'.repeat(100));
  console.log(formatMarkdown(allResults));

  const jsonStr = formatJSON(allResults);
  console.log('\n## JSON Output');
  console.log(jsonStr);

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `bench/results/federation-ycsb-${dateStr}.json`;
  await saveJSON(allResults, filePath);
  console.log(`\nResults saved to: ${filePath}`);
  console.log('\nDone.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
