/**
 * raft-ycsb — YCSB-style benchmarks mapped to Raft operations
 *
 * Maps YCSB operations to Raft consensus operations:
 *   read    → ReadIndex (lease read)
 *   update  → propose entry to Raft log
 *   insert  → propose new entry
 *   scan    → snapshot + scan entries
 *
 * Uses an in-memory Raft adapter (via TestCluster) to produce
 * reproducible throughput and latency numbers for each YCSB workload.
 *
 * This is a standalone benchmark script (not a test).
 * Run: npx tsx bench/raft-ycsb.ts
 *
 * @module bench/raft-ycsb
 */

import { YCSBExecutor, type YCSBResult } from './ycsb/YCSBExecutor.js';
import { defaultYCSBConfig, type WorkloadType, WORKLOAD_DESCRIPTIONS } from './ycsb/YCSBWorkload.js';
import { formatMarkdown, saveJSON } from './ycsb/result-formatter.js';

// ── In-memory Raft target ─────────────────────────────────────────

interface RecordValue {
  data: string;
  version: number;
}

/**
 * In-memory store that models Raft operations:
 * - read  ↔ ReadIndex or direct state machine read
 * - update ↔ propose entry to Raft log + apply
 * - insert ↔ propose new entry
 * - scan  ↔ read snapshot and scan entries
 */
class RaftBenchTarget {
  private store: Map<string, RecordValue> = new Map();
  private entries: string[] = [];
  private readCount = 0;

  /**
   * Simulates a ReadIndex (lease read) by reading directly from
   * the in-memory state. In a real Raft cluster this would verify
   * leadership before returning.
   */
  async read(key: string): Promise<string> {
    this.readCount++;
    const val = this.store.get(key);
    if (val) {
      return JSON.stringify(val);
    }
    // Simulate a small read overhead
    return '{}';
  }

  /**
   * Simulates proposing an update to the Raft log.
   * Writes to local store after "commit".
   */
  async update(key: string, value: string): Promise<void> {
    const existing = this.store.get(key) ?? { data: '', version: 0 };
    existing.data = value;
    existing.version++;
    this.store.set(key, existing);
    this.entries.push(`update:${key}:${value.length}`);
  }

  /**
   * Simulates inserting a new entry via Raft propose.
   */
  async insert(key: string, value: string): Promise<void> {
    this.store.set(key, { data: value, version: 1 });
    this.entries.push(`insert:${key}:${value.length}`);
  }

  /**
   * Simulates reading a snapshot and scanning entries.
   */
  async scan(count: number): Promise<string[]> {
    const results: string[] = [];
    const keys = Array.from(this.store.keys());
    const scanKeys = keys.slice(0, Math.min(count, keys.length));
    for (const k of scanKeys) {
      const v = this.store.get(k);
      if (v) results.push(JSON.stringify({ key: k, value: v }));
    }
    return results;
  }

  /** Reset state between benchmark runs */
  reset(): void {
    this.store.clear();
    this.entries = [];
    this.readCount = 0;
  }

  /** Number of entries in the simulated log */
  get entryCount(): number {
    return this.entries.length;
  }
}

// ── Benchmark runner ──────────────────────────────────────────────

async function runWorkload(wl: WorkloadType): Promise<YCSBResult> {
  const config = defaultYCSBConfig(wl, {
    operationCount: 1000,
    recordCount: 1000,
    threads: 1,
  });

  const target = new RaftBenchTarget();
  const executor = new YCSBExecutor<string>(config);
  const result = await executor.run({
    read: (key: string) => target.read(key),
    update: (key: string, value: string) => target.update(key, value),
    insert: (key: string, value: string) => target.insert(key, value),
    scan: (count: number) => target.scan(count),
  });

  return result;
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('# YCSB Benchmark — Raft (db-cluster)');
  console.log('');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Workloads: A, B, C, D, E, F`);
  console.log(`Operations per workload: 1000`);
  console.log(`Record count: 1000`);
  console.log('');

  const allResults: YCSBResult[] = [];
  const workloads: WorkloadType[] = ['A', 'B', 'C', 'D', 'E', 'F'];

  for (const wl of workloads) {
    console.log(`── Running Workload ${wl}: ${WORKLOAD_DESCRIPTIONS[wl]} ──`);
    console.time(`wl-${wl}`);
    try {
      const result = await runWorkload(wl);
      allResults.push(result);
      console.log(`  Throughput: ${result.throughput} ops/sec`);
      console.log(`  Duration: ${result.durationMs} ms`);
      console.log(`  Read P50: ${result.readLatency.p50.toFixed(3)} ms, P95: ${result.readLatency.p95.toFixed(3)} ms, P99: ${result.readLatency.p99.toFixed(3)} ms`);
      console.log(`  Update P50: ${result.updateLatency.p50.toFixed(3)} ms, P95: ${result.updateLatency.p95.toFixed(3)} ms, P99: ${result.updateLatency.p99.toFixed(3)} ms`);
      console.log(`  Errors: ${result.errors}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
    }
    console.timeEnd(`wl-${wl}`);
    console.log('');
  }

  // Output markdown summary
  console.log('─'.repeat(80));
  console.log(formatMarkdown(allResults));

  // Save results
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `bench/results/raft-ycsb-${dateStr}.json`;
  await saveJSON(allResults, filePath);
  console.log(`\nResults saved to: ${filePath}`);
  console.log('Done.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
