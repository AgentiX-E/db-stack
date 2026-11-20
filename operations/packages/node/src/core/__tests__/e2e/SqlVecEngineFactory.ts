/**
 * SqlVecEngineFactory — Wraps the real sqlvec-adapter classes.
 *
 * Imports each built sqlvec-adapter dist file via file:// URL and provides
 * proper native engine dependency stubs, so the tests exercise the real
 * adapter bridge code rather than mocks.
 *
 * @module @agentix-e/db-operations-node/core/__tests__/e2e
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { EngineFactory } from './EngineFactory.js';
import { HealthOrchestrator } from '../../../health/index.js';
import type { IHealthProbe, IHealthOrchestrator } from '../../../health/index.js';
import type { IMetricsRegistry } from '../../../metrics/index.js';
import {
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
  type IBackupManager,
  type IStorageBackend,
  type IBackupRetentionPolicy,
} from '../../../backup/index.js';
import type { IAuditStore } from '../../../audit/index.js';
import type { IDistributedTracer } from '../../../observability/index.js';
import {
  InMemoryAlertRuleManager,
  InMemoryConnectionMonitor,
  type IDeadlockDetector,
  type IAlertRuleManager,
  type ISlowQueryRecorder,
  type IConnectionMonitor,
} from '../../../monitor/index.js';
import type { IMaintenanceExecutor } from '../../../maintenance/index.js';
import type { IAuthProvider } from '../../../auth/index.js';
import type { ILogger, LogLevel } from '../../../logger/index.js';

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

/** A shard entry inside a native backup manifest. */
interface NativeBackupShard {
  shardId: number;
  path: string;
  originalPath: string;
  checksum: string;
  size: number;
  compressed: boolean;
}

/** Backup manifest as produced by the native backup API. */
interface NativeBackupManifest {
  backupId: string;
  timestamp: number;
  shards: NativeBackupShard[];
  config: {
    backupDir: string;
    enabled: boolean;
    intervalMs: number;
    retentionCount: number;
    compress: boolean;
  };
  sizeBytes: number;
}

/** An audit record as stored by the native audit log. */
interface NativeAuditRecord {
  id: string;
  timestamp: string;
  user?: string;
  actionType: string;
  object: string;
  detail?: string;
}

/** Filter passed to the native audit log query. */
interface NativeAuditFilter {
  user?: string;
  actionType?: string;
}

/** A detected deadlock as reported by the native session monitor. */
interface NativeDeadlock {
  cycle: string[];
  resources: string[];
  victim: string;
  detectedAt: number;
}

class NativeBackupStub {
  private manifests: NativeBackupManifest[] = [];
  private counter = 0;

  async createBackup(): Promise<NativeBackupManifest> {
    const id = `bkp-${++this.counter}-${Date.now()}`;
    const m: NativeBackupManifest = {
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

  async listBackups(): Promise<NativeBackupManifest[]> {
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

  detectDeadlocks(): NativeDeadlock[] {
    const waitFor = new Map<string, Set<string>>();
    for (const [sid, s] of this.sessions) {
      const w = new Set<string>();
      for (const r of s.resources) {
        const h = this.lockResources.get(r);
        if (h && h !== sid) w.add(h);
      }
      waitFor.set(sid, w);
    }
    const res: NativeDeadlock[] = [];
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
            victim: c[c.length - 1]!,
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
//  Module Loader (one-shot, at module evaluation)
// ══════════════════════════════════════════════════════════════════

const ADAPTER_EXPORTS = [
  'SqlVecHealthAdapter',
  'SqlVecMetricAdapter',
  'SqlVecBackupAdapter',
  'SqlVecAuditAdapter',
  'SqlVecTracerAdapter',
  'SqlVecDeadlockAdapter',
  'SqlVecSlowQueryAdapter',
  'SqlVecMaintenanceAdapter',
  'SqlVecAuthAdapter',
] as const;

/** Typed handle on a class exported by the untyped sqlvec-db adapter bundle. */
interface ExternalCtor<T> {
  new (...args: unknown[]): T;
}

let _adapters: Record<string, unknown> | null = null;

/**
 * The bundle is loaded once, at module evaluation. `EngineFactory` promises
 * synchronous construction (the health orchestrator calls `readiness()` on the
 * probe it is given, without awaiting), so the dynamic `import()` of the
 * external bundle cannot happen inside `create*()`. When the bundle is absent
 * the load is skipped and the factory reports that it is unavailable.
 */
if (isSqlVecAdapterAvailable()) {
  const base = ADAPTER_DIR;
  try {
    const modules = await Promise.all(
      ADAPTER_EXPORTS.map(
        (name) => import(`file://${path.resolve(base, `${name}.js`)}`) as Promise<Record<string, unknown>>,
      ),
    );
    const bundle: Record<string, unknown> = {};
    for (const mod of modules) Object.assign(bundle, mod);
    _adapters = bundle;
  } catch {
    _adapters = null;
  }
}

/** Resolve an adapter class from the bundle, or explain why it is unavailable. */
function adapterClass<T>(name: string): ExternalCtor<T> {
  if (!_adapters) {
    throw new Error(
      'sqlvec-db adapter bundle not found. Set SQLVEC_ADAPTER_DIR to ' +
        '<sqlvec-db>/packages/sqlvec-adapter/dist, or skip the SqlVec engine ' +
        `(searched: ${ADAPTER_DIR_CANDIDATES.join(', ')})`,
    );
  }
  const ctor = _adapters[name];
  if (typeof ctor !== 'function') {
    throw new Error(`sqlvec-db adapter bundle has no class export named ${name}`);
  }
  return ctor as ExternalCtor<T>;
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

  get engineRef(): Record<string, unknown> {
    return { backupManager: this.backupNative, getEngineType: () => 'sqlvec' };
  }

  createHealthProbe(): IHealthProbe {
    const SqlVecHealthAdapter = adapterClass<IHealthProbe & { markStarted(): void }>('SqlVecHealthAdapter');
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

  createHealthOrchestrator(): HealthOrchestrator {
    const orch = new HealthOrchestrator();
    orch.registerFunctional('sqlvec-orch', 'SqlVec Orchestrator', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    return orch;
  }

  createMetricsRegistry(): IMetricsRegistry {
    const SqlVecMetricAdapter = adapterClass<IMetricsRegistry>('SqlVecMetricAdapter');
    return new SqlVecMetricAdapter();
  }

  createBackupManager(): IBackupManager {
    const SqlVecBackupAdapter = adapterClass<IBackupManager>('SqlVecBackupAdapter');
    return new SqlVecBackupAdapter(this.engineRef);
  }

  createStorageBackend(): IStorageBackend {
    return new InMemoryStorageBackend();
  }

  createRetentionPolicy(): IBackupRetentionPolicy {
    return new RetentionPolicyEvaluator({
      maxFullSnapshots: 3,
      maxTotalBytes: 1_000_000_000,
    });
  }

  createAuditStore(): IAuditStore {
    const SqlVecAuditAdapter = adapterClass<IAuditStore>('SqlVecAuditAdapter');
    const auditEntries: NativeAuditRecord[] = [];
    const native = {
      init: async () => {},
      record: (entry: NativeAuditRecord) => {
        auditEntries.push({
          id: String(auditEntries.length + 1),
          timestamp: entry.timestamp ?? new Date().toISOString(),
          actionType: entry.actionType,
          object: entry.object,
          detail: entry.detail,
          user: entry.user,
        });
      },
      queryAuditLog: async (_from: Date, _to: Date, filter?: NativeAuditFilter) => {
        let results = [...auditEntries];
        if (filter?.user) results = results.filter((e) => e.user === filter.user);
        if (filter?.actionType) results = results.filter((e) => e.actionType === filter.actionType);
        return results;
      },
      close: async () => {},
    };
    return new SqlVecAuditAdapter(native);
  }

  createDistributedTracer(): IDistributedTracer {
    const SqlVecTracerAdapter = adapterClass<IDistributedTracer>('SqlVecTracerAdapter');
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

  createDeadlockDetector(): IDeadlockDetector {
    const SqlVecDeadlockAdapter = adapterClass<IDeadlockDetector>('SqlVecDeadlockAdapter');
    return new SqlVecDeadlockAdapter(this.deadlockNative, 500, 100);
  }

  createAlertRuleManager(): IAlertRuleManager {
    return new InMemoryAlertRuleManager();
  }

  createSlowQueryRecorder(): ISlowQueryRecorder {
    const SqlVecSlowQueryAdapter = adapterClass<ISlowQueryRecorder>('SqlVecSlowQueryAdapter');
    return new SqlVecSlowQueryAdapter(100, 1000, {});
  }

  createConnectionMonitor(): IConnectionMonitor {
    return new InMemoryConnectionMonitor();
  }

  createMaintenanceExecutor(): IMaintenanceExecutor {
    const SqlVecMaintenanceAdapter = adapterClass<IMaintenanceExecutor>('SqlVecMaintenanceAdapter');
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

  createAuthProvider(): IAuthProvider {
    const SqlVecAuthAdapter = adapterClass<IAuthProvider>('SqlVecAuthAdapter');
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
  trace(...a: unknown[]): void {
    /* captured in e2e context */
  }
  debug(...a: unknown[]): void {
    /* captured in e2e context */
  }
  info(...a: unknown[]): void {
    /* captured in e2e context */
  }
  warn(...a: unknown[]): void {
    /* captured in e2e context */
  }
  error(...a: unknown[]): void {
    /* captured in e2e context */
  }
  fatal(...a: unknown[]): void {
    /* captured in e2e context */
  }
}
