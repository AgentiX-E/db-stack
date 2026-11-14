/**
 * InMemoryMaintenanceExecutor — IMaintenanceExecutor implementation that
 * simulates maintenance operations (VACUUM, ANALYZE, REINDEX) with in-memory
 * storage stats and fragmentation tracking.
 *
 * Useful for integration testing of higher-level orchestration without
 * a real database engine attached.
 *
 * @module @agentix-e/db-operations-maintenance/impl
 */

import type { MaintenanceResult, StorageStats, IndexFragmentation } from '@agentix-e/db-operations-core/types';
import type {
  IMaintenanceExecutor,
  VacuumOptions,
  AnalyzeOptions,
  ReindexOptions,
} from '../interfaces/IMaintenanceExecutor.js';

/** Default simulated storage stats before any VACUUM. */
const DEFAULT_STORAGE: StorageStats = {
  fileSizeBytes: 104_857_600, // 100 MB
  pageCount: 25_600,
  pageSize: 4096,
  rowCount: 1_000_000,
  deadRowCount: 150_000,
  freeSpaceRatio: 0.3,
};

const DEFAULT_FRAGMENTATION: IndexFragmentation[] = [
  { indexName: 'idx_users_email', tableName: 'users', pageCount: 1200, fragmentationRatio: 0.45 },
  { indexName: 'idx_orders_user_id', tableName: 'orders', pageCount: 3400, fragmentationRatio: 0.33 },
  { indexName: 'idx_orders_created_at', tableName: 'orders', pageCount: 2100, fragmentationRatio: 0.18 },
  { indexName: 'idx_products_name', tableName: 'products', pageCount: 800, fragmentationRatio: 0.05 },
];

/**
 * InMemoryMaintenanceExecutor — simulates maintenance operations.
 */
export class InMemoryMaintenanceExecutor implements IMaintenanceExecutor {
  private readonly _storageStats: StorageStats;
  private readonly _fragmentation: IndexFragmentation[];
  private readonly _opsLog: MaintenanceResult[] = [];
  private readonly _autoVacuumEnabled: boolean;
  private readonly _autoVacuumThreshold: number;

  constructor(
    initialStats?: Partial<StorageStats>,
    initialFragmentation?: IndexFragmentation[],
    autoVacuumEnabled = true,
    autoVacuumThreshold = 200,
  ) {
    this._storageStats = { ...DEFAULT_STORAGE, ...initialStats };
    this._fragmentation = initialFragmentation
      ? initialFragmentation.map((f) => ({ ...f }))
      : DEFAULT_FRAGMENTATION.map((f) => ({ ...f }));
    this._autoVacuumEnabled = autoVacuumEnabled;
    this._autoVacuumThreshold = autoVacuumThreshold;
  }

  get opsLog(): readonly MaintenanceResult[] {
    return [...this._opsLog];
  }

  /**
   * Run VACUUM — simulates storage compaction.
   */
  async vacuum(options: VacuumOptions): Promise<MaintenanceResult> {
    const start = Date.now();

    if (options.dryRun) {
      const result: MaintenanceResult = {
        success: true,
        operation: 'VACUUM',
        target: options.target,
        message: `[dry-run] VACUUM on ${options.target}`,
        durationMs: 0,
        details: { dryRun: true, full: options.full ?? false },
      };
      this._opsLog.push(result);
      return result;
    }

    const isFull = options.full ?? false;

    // Simulate compaction: freeSpaceRatio decreases
    const prevFree = this._storageStats.freeSpaceRatio;
    this._storageStats.freeSpaceRatio = Math.max(0, prevFree - 0.25);
    this._storageStats.freeSpaceRatio = Math.round(this._storageStats.freeSpaceRatio * 1000) / 1000;

    // Simulate dead row reclamation
    const prevDead = this._storageStats.deadRowCount;
    this._storageStats.deadRowCount = Math.max(0, prevDead - 140_000);

    if (isFull) {
      // Full VACUUM also reduces page count
      this._storageStats.pageCount = Math.max(10, Math.round(this._storageStats.pageCount * 0.85));
      this._storageStats.fileSizeBytes = this._storageStats.pageCount * this._storageStats.pageSize;
    }

    const durationMs = Date.now() - start || 1;

    const result: MaintenanceResult = {
      success: true,
      operation: 'VACUUM',
      target: options.target,
      message: isFull
        ? `Full VACUUM completed on ${options.target}`
        : `VACUUM completed on ${options.target}`,
      durationMs,
      details: { dryRun: false, full: isFull },
    };
    this._opsLog.push(result);
    return result;
  }

  /**
   * Run ANALYZE — simulates statistics update.
   */
  async analyze(options: AnalyzeOptions): Promise<MaintenanceResult> {
    const durationMs = 5;

    const result: MaintenanceResult = {
      success: true,
      operation: 'ANALYZE',
      target: options.target,
      message: `Analyzed ${options.target}`,
      durationMs,
      details: { dryRun: options.dryRun ?? false },
    };
    this._opsLog.push(result);
    return result;
  }

  /**
   * Run REINDEX — simulates index rebuild, reducing fragmentation.
   */
  async reindex(options: ReindexOptions): Promise<MaintenanceResult> {
    const start = Date.now();

    // Reduce fragmentation for matching targets
    for (const frag of this._fragmentation) {
      const matchesTarget =
        frag.indexName === options.target ||
        (options.isTable && frag.tableName === options.target);
      if (matchesTarget) {
        frag.fragmentationRatio = Math.max(0.02, frag.fragmentationRatio * 0.1);
        frag.fragmentationRatio = Math.round(frag.fragmentationRatio * 1000) / 1000;
        // Page count also reduces modestly
        frag.pageCount = Math.max(10, Math.round(frag.pageCount * 0.7));
      }
    }

    const durationMs = Date.now() - start || 1;

    const result: MaintenanceResult = {
      success: true,
      operation: 'REINDEX',
      target: options.target,
      message: options.isTable
        ? `REINDEX table ${options.target} completed`
        : `REINDEX index ${options.target} completed`,
      durationMs,
      details: { dryRun: options.dryRun ?? false, isTable: options.isTable ?? false },
    };
    this._opsLog.push(result);
    return result;
  }

  /**
   * Get storage statistics for a target.
   */
  async getStorageStats(_target: string): Promise<StorageStats> {
    return { ...this._storageStats };
  }

  /**
   * Get index fragmentation report.
   */
  async getIndexFragmentation(target: string): Promise<IndexFragmentation[]> {
    return this._fragmentation
      .filter((f) => f.tableName === target || f.indexName === target || target === '*')
      .map((f) => ({ ...f }));
  }

  /**
   * Get the auto-vacuum status.
   */
  getAutoVacuumStatus(): { enabled: boolean; threshold: number } {
    return {
      enabled: this._autoVacuumEnabled,
      threshold: this._autoVacuumThreshold,
    };
  }
}
