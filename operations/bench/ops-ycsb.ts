/**
 * ops-ycsb — YCSB-style benchmarks for db-operations
 *
 * Maps YCSB operations to operations components:
 *   read    → MetricsRegistry snapshot
 *   update  → AuditStore write
 *   insert  → BackupManager backup entry
 *   scan    → HealthProbe aggregate
 *
 * Uses in-memory implementations of the operations components.
 * This is a standalone benchmark script (not a test).
 * Run: npx tsx bench/ops-ycsb.ts
 *
 * @module bench/ops-ycsb
 */

import { YCSBExecutor, type YCSBResult } from './ycsb/YCSBExecutor.js';
import { defaultYCSBConfig, type WorkloadType, WORKLOAD_DESCRIPTIONS } from './ycsb/YCSBWorkload.js';
import { formatMarkdown, saveJSON } from './ycsb/result-formatter.js';

// ── In-memory operations target ───────────────────────────────────

/**
 * Simulates the db-operations component stack:
 * - MetricsRegistry snapshots for reads
 * - AuditStore writes for updates
 * - BackupManager entries for inserts
 * - HealthProbe aggregates for scans
 */
class OperationsBenchTarget {
  private auditLog: Map<string, { data: string; timestamp: number }> = new Map();
  private backupEntries: string[] = [];
  private healthChecks: Array<{ component: string; status: string }> = [];

  constructor() {
    this.healthChecks = [
      { component: 'metrics', status: 'healthy' },
      { component: 'audit', status: 'healthy' },
      { component: 'backup', status: 'healthy' },
      { component: 'health', status: 'healthy' },
      { component: 'logger', status: 'healthy' },
    ];
  }

  /**
   * Maps to MetricsRegistry.snapshot() — captures current state.
   */
  async read(key: string): Promise<string> {
    // Simulate metrics snapshot
    const entry = this.auditLog.get(key);
    if (entry) {
      return JSON.stringify({
        key,
        data: entry.data,
        timestamp: entry.timestamp,
        metrics: {
          auditLogSize: this.auditLog.size,
          backupCount: this.backupEntries.length,
          healthStatus: this.healthChecks.map(h => h.status),
        },
      });
    }
    return JSON.stringify({ key, found: false });
  }

  /**
   * Maps to AuditStore.write() — records an audit entry.
   */
  async update(key: string, value: string): Promise<void> {
    this.auditLog.set(key, { data: value, timestamp: Date.now() });
  }

  /**
   * Maps to BackupManager.createBackupEntry() — stores a backup record.
   */
  async insert(key: string, value: string): Promise<void> {
    const entry = JSON.stringify({
      backupKey: key,
      data: value.slice(0, 100),
      timestamp: Date.now(),
      lsn: this.backupEntries.length + 1,
    });
    this.backupEntries.push(entry);
    // Also add to audit log
    this.auditLog.set(key, { data: value, timestamp: Date.now() });
  }

  /**
   * Maps to HealthProbe.aggregate() — scans all component health statuses.
   */
  async scan(count: number): Promise<string[]> {
    const results: string[] = [];
    const toTake = Math.min(count, this.healthChecks.length);
    for (let i = 0; i < toTake; i++) {
      results.push(JSON.stringify(this.healthChecks[i]));
    }
    return results;
  }

  reset(): void {
    this.auditLog.clear();
    this.backupEntries = [];
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('# YCSB Benchmark — Operations (db-operations)');
  console.log('');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`Workloads: A (update heavy), B (read mostly), C (read only), F (RMW)`);
  console.log(`Operations per workload: 1000`);
  console.log(`Record count: 1000`);
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

  console.log('─'.repeat(80));
  console.log(formatMarkdown(allResults));

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `bench/results/ops-ycsb-${dateStr}.json`;
  await saveJSON(allResults, filePath);
  console.log(`\nResults saved to: ${filePath}`);
  console.log('Done.');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Benchmark failed: ${msg}`);
  process.exit(1);
});
