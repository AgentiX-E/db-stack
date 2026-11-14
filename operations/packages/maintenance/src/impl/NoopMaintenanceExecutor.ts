/**
 * NoopMaintenanceExecutor — IMaintenanceExecutor implementation that returns
 * fixed/empty results for all operations.
 *
 * Useful as a default/fallback when no maintenance system is configured,
 * or for testing higher-level orchestration.
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

/**
 * NoopMaintenanceExecutor — returns empty/fixed results for all operations.
 */
export class NoopMaintenanceExecutor implements IMaintenanceExecutor {
  private readonly _autoVacuumEnabled: boolean;
  private readonly _autoVacuumThreshold: number;

  constructor(autoVacuumEnabled = true, autoVacuumThreshold = 200) {
    this._autoVacuumEnabled = autoVacuumEnabled;
    this._autoVacuumThreshold = autoVacuumThreshold;
  }

  /**
   * Run VACUUM — returns success with fixed result.
   */
  async vacuum(options: VacuumOptions): Promise<MaintenanceResult> {
    return {
      success: true,
      operation: 'VACUUM',
      target: options.target,
      message: options.dryRun
        ? `[dry-run] VACUUM on ${options.target}`
        : `VACUUM completed on ${options.target}`,
      durationMs: 0,
      details: {
        dryRun: options.dryRun ?? false,
        full: options.full ?? false,
      },
    };
  }

  /**
   * Run ANALYZE — returns success with fixed result.
   */
  async analyze(options: AnalyzeOptions): Promise<MaintenanceResult> {
    return {
      success: true,
      operation: 'ANALYZE',
      target: options.target,
      message: `ANALYZE completed on ${options.target}`,
      durationMs: 0,
      details: {
        dryRun: options.dryRun ?? false,
      },
    };
  }

  /**
   * Run REINDEX — returns success with fixed result.
   */
  async reindex(options: ReindexOptions): Promise<MaintenanceResult> {
    return {
      success: true,
      operation: 'REINDEX',
      target: options.target,
      message: options.isTable
        ? `REINDEX table ${options.target} completed`
        : `REINDEX index ${options.target} completed`,
      durationMs: 0,
      details: {
        dryRun: options.dryRun ?? false,
        isTable: options.isTable ?? false,
      },
    };
  }

  /**
   * Get storage statistics — returns empty/fixed stats.
   */
  async getStorageStats(target: string): Promise<StorageStats> {
    return {
      fileSizeBytes: 0,
      pageCount: 0,
      pageSize: 4096,
      rowCount: 0,
      deadRowCount: 0,
      freeSpaceRatio: 0,
    };
  }

  /**
   * Get index fragmentation — returns empty array.
   */
  async getIndexFragmentation(target: string): Promise<IndexFragmentation[]> {
    return [];
  }

  /**
   * Get auto-vacuum status.
   */
  getAutoVacuumStatus(): { enabled: boolean; threshold: number } {
    return {
      enabled: this._autoVacuumEnabled,
      threshold: this._autoVacuumThreshold,
    };
  }
}
