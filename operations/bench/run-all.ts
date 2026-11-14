/**
 * run-all — Orchestrator that runs all YCSB benchmarks for db-operations
 *
 * Executes 4 operations-relevant workloads (A, B, C, F) sequentially.
 *
 * @module bench/run-all
 */

import { YCSBExecutor, type YCSBResult } from './ycsb/YCSBExecutor.js';
import { defaultYCSBConfig, type WorkloadType, WORKLOAD_DESCRIPTIONS } from './ycsb/YCSBWorkload.js';
import { formatMarkdown, formatJSON, saveJSON } from './ycsb/result-formatter.js';

// ── In-memory operations target ───────────────────────────────────

class OperationsBenchTarget {
  private auditLog: Map<string, { data: string; timestamp: number }> = new Map();
  private backupEntries: string[] = [];
  private healthChecks: Array<{ component: string; status: string }> = [
    { component: 'metrics', status: 'healthy' },
    { component: 'audit', status: 'healthy' },
    { component: 'backup', status: 'healthy' },
    { component: 'health', status: 'healthy' },
    { component: 'logger', status: 'healthy' },
  ];

  async read(key: string): Promise<string> {
    const entry = this.auditLog.get(key);
    if (entry) return JSON.stringify({ key, data: entry.data, timestamp: entry.timestamp, auditLogSize: this.auditLog.size, backupCount: this.backupEntries.length });
    return JSON.stringify({ key, found: false });
  }

  async update(key: string, value: string): Promise<void> {
    this.auditLog.set(key, { data: value, timestamp: Date.now() });
  }

  async insert(key: string, value: string): Promise<void> {
    this.backupEntries.push(JSON.stringify({ backupKey: key, timestamp: Date.now(), lsn: this.backupEntries.length + 1 }));
    this.auditLog.set(key, { data: value, timestamp: Date.now() });
  }

  async scan(count: number): Promise<string[]> {
    return this.healthChecks.slice(0, Math.min(count, this.healthChecks.length)).map(h => JSON.stringify(h));
  }

  reset(): void {
    this.auditLog.clear();
    this.backupEntries = [];
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(80));
  console.log('  YCSB Performance Benchmarks — db-operations');
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
    const target = new OperationsBenchTarget();
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

  console.log('-'.repeat(100));
  console.log(formatMarkdown(allResults));
  console.log('\n## JSON Output');
  console.log(formatJSON(allResults));

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `bench/results/ops-ycsb-${dateStr}.json`;
  await saveJSON(allResults, filePath);
  console.log(`\nResults saved to: ${filePath}`);
  console.log('\nDone.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
