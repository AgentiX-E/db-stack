/**
 * SqlVecEngineFactory — Wraps the real sqlvec-adapter classes.
 *
 * Imports each built sqlvec-adapter dist file via file:// URL and provides
 * proper native engine dependency stubs, so the tests exercise the real
 * adapter bridge code rather than mocks.
 *
 * @module @agentix-e/db-operations-core/__tests__/e2e
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { EngineFactory } from './EngineFactory.js';
import { HealthOrchestrator } from '@agentix-e/db-operations-health';
import type { IHealthProbe, IHealthOrchestrator } from '@agentix-e/db-operations-health';
import type { IMetricsRegistry } from '@agentix-e/db-operations-metrics';
import type { IBackupManager, IStorageBackend, IBackupRetentionPolicy } from '@agentix-e/db-operations-backup';
import type { IAuditStore } from '@agentix-e/db-operations-audit';
import type { IDistributedTracer } from '@agentix-e/db-operations-observability';
import type {
  IDeadlockDetector,
  IAlertRuleManager,
  ISlowQueryRecorder,
  IConnectionMonitor,
} from '@agentix-e/db-operations-monitor';
import type { IMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';
import type { IAuthProvider } from '@agentix-e/db-operations-auth';
import type { ILogger, LogLevel } from '@agentix-e/db-operations-logger';

// ── Constants ────────────────────────────────────────────────────

/**
 * Where the built sqlvec-db adapter bundle lives.
 *
 * sqlvec-db is an EXTERNAL checkout (it is not part of this monorepo), so the
 * location cannot be hard-coded: the previous absolute path pointed at the
 * original author's home directory and made every SqlVec E2E case fail with
 * "Cannot find module" on any other machine, including CI. Resolution order:
 *
 *   1. `$SQLVEC_ADAPTER_DIR`
 *   2. `../sqlvec-db/packages/sqlvec-adapter/dist` (monorepo sibling checkout)
 *   3. `../../sqlvec-db/packages/sqlvec-adapter/dist`
 *
 * When none of them exists the SqlVec factory is reported as unavailable and
 * the suites skip that engine instead of failing.
 */
const ADAPTER_DIR_CANDIDATES: string[] = [
  process.env.SQLVEC_ADAPTER_DIR ?? '',
  path.resolve(process.cwd(), '..', 'sqlvec-db', 'packages', 'sqlvec-adapter', 'dist'),
  path.resolve(process.cwd(), '..', '..', 'sqlvec-db', 'packages', 'sqlvec-adapter', 'dist'),
].filter((p) => p.length > 0);

const ADAPTER_DIR = ADAPTER_DIR_CANDIDATES.find((dir) => existsSync(path.join(dir, 'SqlVecHealthAdapter.js'))) ?? '';

/** True when the external sqlvec-db adapter bundle is present on this machine. */
export function isSqlVecAdapterAvailable(): boolean {
  return ADAPTER_DIR.length > 0 && existsSync(path.join(ADAPTER_DIR, 'SqlVecHealthAdapter.js'));
}

// ── Native engine stubs (mimic sqlvec-db engine behavior) ────────

class NativeBackupStub {
  private manifests: Array<Record<string, any>> = [];
  private counter = 0;

  async createBackup(): Promise<Record<string, any>> {
    const id = `bkp-${++this.counter}-${Date.now()}`;
    const m = {
      backupId: id,
      timestamp: Date.now(),
      shards: [
        {
          shardId: 0,
          path: `/tmp/${id}/shard_0.db`,
          originalPath: '/var/lib/sqlvec/data/shard_0.db',
          checksum: `sha256-${id}`,
          size: 8192,
          compressed: false,
        },
      ],
      config: {
        backupDir: '/tmp/sqlvec-backup',
        enabled: true,
        intervalMs: 3600000,
        retentionCount: 5,
        compress: false,
      },
      sizeBytes: 8192,
    };
    this.manifests.push(m);
    return m;
  }

  async listBackups(): Promise<Array<Record<string, any>>> {
    return [...this.manifests];
  }

  async restoreBackup(_id: string): Promise<void> {
    /* no-op */
  }

  async deleteOldBackups(): Promise<void> {
    this.manifests = [];
  }
}

class NativeDeadlockStub {
  sessions = new Map<string, { resources: Set<string>; transactionId: string }>();
  lockResources = new Map<string, string>();

  reportWait(sid: string, r: string, tid: string): void {
    const s = this.sessions.get(sid) ?? {
      resources: new Set(),
      transactionId: tid,
    };
    s.resources.add(r);
    this.sessions.set(sid, s);
  }

  reportHold(sid: string, rs: string[], tid: string): void {
    const s = this.sessions.get(sid) ?? {
      resources: new Set(),
      transactionId: tid,
    };
    for (const r of rs) s.resources.add(r);
    this.sessions.set(sid, s);
  }

  releaseSession(sid: string): void {
    this.sessions.delete(sid);
  }
  acquireLock(sid: string, r: string): void {
    this.lockResources.set(r, sid);
  }

  detectDeadlocks(): Array<{
    cycle: string[];
    resources: string[];
    victim: string;
    detectedAt: number;
  }> {
    const waitFor = new Map<string, Set<string>>();
    for (const [sid, s] of this.sessions) {
      const w = new Set<string>();
      for (const r of s.resources) {
        const h = this.lockResources.get(r);
        if (h && h !== sid) w.add(h);
      }
      waitFor.set(sid, w);
    }
    const res: Array<any> = [];
    const visited = new Set<string>(),
      inStack = new Set<string>();
    const dfs = (node: string, p: string[]): void => {
      visited.add(node);
      inStack.add(node);
      p.push(node);
      for (const n of waitFor.get(node) ?? []) {
        if (inStack.has(n)) {
          const c = p.slice(p.indexOf(n));
          res.push({
            cycle: c,
            resources: c.map((s) => [...(this.sessions.get(s)?.resources ?? [])][0] ?? '?'),
            victim: c[c.length - 1],
            detectedAt: Date.now(),
          });
        } else if (!visited.has(n)) {
          dfs(n, p);
        }
      }
      p.pop();
      inStack.delete(node);
    };
    for (const s of this.sessions.keys()) {
      if (!visited.has(s)) dfs(s, []);
    }
    return res;
  }
}

// ══════════════════════════════════════════════════════════════════
//  Module Loader (lazy, one-shot)
// ══════════════════════════════════════════════════════════════════

let _adapters: Record<string, any> | null = null;

async function ensureAdaptersLoaded(): Promise<Record<string, any>> {
  if (_adapters) return _adapters;
  if (!isSqlVecAdapterAvailable()) {
    throw new Error(
      'sqlvec-db adapter bundle not found. Set SQLVEC_ADAPTER_DIR to ' +
        '<sqlvec-db>/packages/sqlvec-adapter/dist, or skip the SqlVec engine ' +
        `(searched: ${ADAPTER_DIR_CANDIDATES.join(', ')})`,
    );
  }
  const base = ADAPTER_DIR;
  const load = (fn: string) => import(`file://${path.resolve(base, fn)}`);
  const [
    { SqlVecHealthAdapter },
    { SqlVecMetricAdapter },
    { SqlVecBackupAdapter },
    { SqlVecAuditAdapter },
    { SqlVecTracerAdapter },
    { SqlVecDeadlockAdapter },
    { SqlVecSlowQueryAdapter },
    { SqlVecMaintenanceAdapter },
    { SqlVecAuthAdapter },
  ] = await Promise.all([
    load('SqlVecHealthAdapter.js'),
    load('SqlVecMetricAdapter.js'),
    load('SqlVecBackupAdapter.js'),
    load('SqlVecAuditAdapter.js'),
    load('SqlVecTracerAdapter.js'),
    load('SqlVecDeadlockAdapter.js'),
    load('SqlVecSlowQueryAdapter.js'),
    load('SqlVecMaintenanceAdapter.js'),
    load('SqlVecAuthAdapter.js'),
  ]);
  _adapters = {
    SqlVecHealthAdapter,
    SqlVecMetricAdapter,
    SqlVecBackupAdapter,
    SqlVecAuditAdapter,
    SqlVecTracerAdapter,
    SqlVecDeadlockAdapter,
    SqlVecSlowQueryAdapter,
    SqlVecMaintenanceAdapter,
    SqlVecAuthAdapter,
  };
  return _adapters;
}

// ══════════════════════════════════════════════════════════════════
//  SqlVecEngineFactory
// ══════════════════════════════════════════════════════════════════

/**
 * Factory producing real sqlvec-adapter implementations for all
 * EngineFactory interfaces. Each adapter wraps a native sqlvec-db stub
 * and exercises the same bridge code the real engine would use.
 */
export class SqlVecEngineFactory implements EngineFactory {
  private backupNative = new NativeBackupStub();
  private deadlockNative = new NativeDeadlockStub();
  private _logger?: ILogger;

  get engineRef(): Record<string, any> {
    return { backupManager: this.backupNative, getEngineType: () => 'sqlvec' };
  }

  async createHealthProbe(): Promise<IHealthProbe> {
    const { SqlVecHealthAdapter } = await ensureAdaptersLoaded();
    const probe = new SqlVecHealthAdapter('sqlvec-e2e', {
      isStarted: () => true,
      isLeaderElected: () => true,
      sqliteCheck: () => true,
      shardCount: () => 4,
      peerCount: () => 3,
    });
    probe.markStarted();
    return probe;
  }

  createHealthOrchestrator(): IHealthOrchestrator {
    const orch = new HealthOrchestrator();
    orch.registerFunctional('sqlvec-orch', 'SqlVec Orchestrator', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    return orch;
  }

  async createMetricsRegistry(): Promise<IMetricsRegistry> {
    const { SqlVecMetricAdapter } = await ensureAdaptersLoaded();
    return new SqlVecMetricAdapter();
  }

  async createBackupManager(): Promise<IBackupManager> {
    const { SqlVecBackupAdapter } = await ensureAdaptersLoaded();
    return new SqlVecBackupAdapter(this.engineRef);
  }

  async createStorageBackend(): Promise<IStorageBackend> {
    const { InMemoryStorageBackend } = await import('@agentix-e/db-operations-backup');
    return new InMemoryStorageBackend();
  }

  async createRetentionPolicy(): Promise<IBackupRetentionPolicy> {
    const { RetentionPolicyEvaluator } = await import('@agentix-e/db-operations-backup');
    return new RetentionPolicyEvaluator({
      maxFullSnapshots: 3,
      maxTotalBytes: 1_000_000_000,
    });
  }

  async createAuditStore(): Promise<IAuditStore> {
    const { SqlVecAuditAdapter } = await ensureAdaptersLoaded();
    const auditEntries: Array<any> = [];
    const native = {
      init: async () => {},
      record: (entry: any) => {
        auditEntries.push({
          id: auditEntries.length + 1,
          timestamp: entry.timestamp ?? new Date().toISOString(),
          sessionId: entry.sessionId,
          user: entry.user,
          actionType: entry.actionType,
          object: entry.object,
          detail: entry.detail,
        });
      },
      queryAuditLog: async (_from: Date, _to: Date, filter?: any) => {
        let results = [...auditEntries];
        if (filter?.user) results = results.filter((e) => e.user === filter.user);
        if (filter?.actionType) results = results.filter((e) => e.actionType === filter.actionType);
        return results;
      },
      close: async () => {},
    };
    return new SqlVecAuditAdapter(native);
  }

  async createDistributedTracer(): Promise<IDistributedTracer> {
    const { SqlVecTracerAdapter } = await ensureAdaptersLoaded();
    return new SqlVecTracerAdapter({
      startTrace: (_n: string, _a?: Record<string, string | number | boolean>) => `trace-${Date.now()}`,
      endTrace: () => {},
      startSpan: (n: string, _a?: Record<string, string | number | boolean>) => `span-${n}-${Date.now()}`,
      endSpan: (_e?: string) => {},
      getTraceId: () => 'native-trace-id',
      getPropagationHeaders: () => ({ traceparent: '00-native-01' }),
      continueTraceFromHeaders: (_h: Record<string, string>) => 'continued-trace',
      getCompletedSpans: () => [],
      isOpen: () => true,
    });
  }

  async createDeadlockDetector(): Promise<IDeadlockDetector> {
    const { SqlVecDeadlockAdapter } = await ensureAdaptersLoaded();
    return new SqlVecDeadlockAdapter(this.deadlockNative, 500, 100);
  }

  async createAlertRuleManager(): Promise<IAlertRuleManager> {
    const { InMemoryAlertRuleManager } = await import('@agentix-e/db-operations-monitor');
    return new InMemoryAlertRuleManager();
  }

  async createSlowQueryRecorder(): Promise<ISlowQueryRecorder> {
    const { SqlVecSlowQueryAdapter } = await ensureAdaptersLoaded();
    return new SqlVecSlowQueryAdapter(100, 1000, {});
  }

  async createConnectionMonitor(): Promise<IConnectionMonitor> {
    const { InMemoryConnectionMonitor } = await import('@agentix-e/db-operations-monitor');
    return new InMemoryConnectionMonitor();
  }

  async createMaintenanceExecutor(): Promise<IMaintenanceExecutor> {
    const { SqlVecMaintenanceAdapter } = await ensureAdaptersLoaded();
    return new SqlVecMaintenanceAdapter({
      vacuum: (_s: number, _t?: string, _f?: boolean) => ({
        success: true,
        command: 'VACUUM',
        message: 'OK',
        details: { rowsAffected: 0 },
      }),
      analyze: (_s: number, _t?: string) => ({
        success: true,
        command: 'ANALYZE',
        message: 'OK',
        details: {},
      }),
      reindex: (_s: number, _i: string, _t?: boolean) => ({
        success: true,
        command: 'REINDEX',
        message: 'OK',
        details: {},
      }),
      getDbFileSize: (_d: unknown) => 8192,
      getConfig: () => ({
        vacuumEnabled: true,
        analyzeEnabled: true,
        reindexEnabled: true,
        autoVacuumEnabled: true,
        autoVacuumThreshold: 0.2,
      }),
    });
  }

  async createAuthProvider(): Promise<IAuthProvider> {
    const { SqlVecAuthAdapter } = await ensureAdaptersLoaded();
    return new SqlVecAuthAdapter(
      {
        verifyPassword: async (u: string, p: string) => u === 'admin' && p === 'pass',
        computeHash: async (_pw: string) => 'hashed',
      },
      {
        hasPermission: async (role: string, ctx: { resource: string; action: string }) => {
          if (role === 'admin') return true;
          if (role === 'reader' && ctx.action === 'read') return true;
          return false;
        },
        listRoles: async () => ['admin', 'reader'],
        getUserRoles: async (_uid: string) => ['admin'],
      },
    );
  }

  createLogger(): ILogger {
    if (!this._logger) this._logger = new E2ELogger('sqlvec-e2e');
    return this._logger;
  }

  async cleanup(): Promise<void> {
    this._logger = undefined;
  }
}

// ── E2E Logger (implements ILogger) ──────────────────────────────

class E2ELogger implements ILogger {
  constructor(private readonly component: string) {}
  child(_b: Record<string, unknown>): ILogger {
    return new E2ELogger(`${this.component}-child`);
  }
  trace(...a: any[]): void {
    /* captured in e2e context */
  }
  debug(...a: any[]): void {
    /* captured in e2e context */
  }
  info(...a: any[]): void {
    /* captured in e2e context */
  }
  warn(...a: any[]): void {
    /* captured in e2e context */
  }
  error(...a: any[]): void {
    /* captured in e2e context */
  }
  fatal(...a: any[]): void {
    /* captured in e2e context */
  }
}
