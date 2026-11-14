/**
 * run-all — Orchestrator that runs all YCSB benchmarks for db-cluster
 *
 * Executes all 6 workloads (A-F) sequentially and outputs results
 * to stdout (Markdown) and JSON files in bench/results/.
 *
 * @module bench/run-all
 */

import { YCSBExecutor, type YCSBResult } from './ycsb/YCSBExecutor.js';
import { defaultYCSBConfig, type WorkloadType, WORKLOAD_DESCRIPTIONS } from './ycsb/YCSBWorkload.js';
import { formatMarkdown, formatJSON, saveJSON } from './ycsb/result-formatter.js';

// ── In-memory target (same as raft-ycsb) ──────────────────────────

interface RecordValue {
  data: string;
  version: number;
}

class InMemBenchTarget {
  private store: Map<string, RecordValue> = new Map();
  private entries: string[] = [];
  private readCount = 0;

  async read(key: string): Promise<string> {
    this.readCount++;
    const val = this.store.get(key);
    if (val) return JSON.stringify(val);
    return '{}';
  }

  async update(key: string, value: string): Promise<void> {
    const existing = this.store.get(key) ?? { data: '', version: 0 };
    existing.data = value;
    existing.version++;
    this.store.set(key, existing);
    this.entries.push(`update:${key}:${value.length}`);
  }

  async insert(key: string, value: string): Promise<void> {
    this.store.set(key, { data: value, version: 1 });
    this.entries.push(`insert:${key}:${value.length}`);
  }

  async scan(count: number): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    const scanKeys = keys.slice(0, Math.min(count, keys.length));
    const results: string[] = [];
    for (const k of scanKeys) {
      const v = this.store.get(k);
      if (v) results.push(JSON.stringify({ key: k, value: v }));
    }
    return results;
  }

  reset(): void {
    this.store.clear();
    this.entries = [];
    this.readCount = 0;
  }
}

// ── Main orchestrator ─────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(80));
  console.log('  YCSB Performance Benchmarks — db-cluster');
  console.log('═'.repeat(80));
  console.log('');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Workloads: A (update heavy), B (read mostly), C (read only),`);
  console.log(`           D (read latest), E (short ranges), F (RMW)`);
  console.log(`Operations per workload: 1000`);
  console.log('');

  const allResults: YCSBResult[] = [];
  const workloads: WorkloadType[] = ['A', 'B', 'C', 'D', 'E', 'F'];

  for (const wl of workloads) {
    const target = new InMemBenchTarget();
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
    console.log(`  Read: P50=${result.readLatency.p50.toFixed(3)}ms  P95=${result.readLatency.p95.toFixed(3)}ms  P99=${result.readLatency.p99.toFixed(3)}ms`);
    console.log(`  Update: P50=${result.updateLatency.p50.toFixed(3)}ms  P95=${result.updateLatency.p95.toFixed(3)}ms  P99=${result.updateLatency.p99.toFixed(3)}ms`);
    if (result.errors > 0) console.log(`  ⚠ Errors: ${result.errors}`);
    console.log('');
  }

  // Markdown summary table
  console.log('-'.repeat(100));
  console.log(formatMarkdown(allResults));

  // JSON output
  const jsonStr = formatJSON(allResults);
  console.log('\n## JSON Output');
  console.log(jsonStr);

  // Save to file
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `bench/results/raft-ycsb-${dateStr}.json`;
  await saveJSON(allResults, filePath);
  console.log(`\nResults saved to: ${filePath}`);
  console.log('\nDone.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
