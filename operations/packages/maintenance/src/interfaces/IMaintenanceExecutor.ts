/**
 * IMaintenanceExecutor — Engine-agnostic maintenance operation interface.
 *
 * Defines VACUUM, ANALYZE, REINDEX, and REBUILD as abstract operations.
 * Each operation accepts a target (table, index, shard, or "all") and
 * returns a standardized MaintenanceResult.
 *
 * @module @agentix-e/db-operations-maintenance/interfaces
 */

import type { MaintenanceOp, MaintenanceResult, StorageStats, IndexFragmentation } from '@agentix-e/db-operations-core/types';

/** Options common to all maintenance operations. */
export interface MaintenanceOptions {
  /** If true, report only without actually executing. */
  dryRun?: boolean;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/** VACUUM-specific options. */
export interface VacuumOptions extends MaintenanceOptions {
  /** If true, run a full rebuild. Otherwise incremental. */
  full?: boolean;
  /** Target table or shard ID ('*' for all). */
  target: string;
}

/** ANALYZE-specific options. */
export interface AnalyzeOptions extends MaintenanceOptions {
  /** Target table or shard ID ('*' for all). */
  target: string;
}

/** REINDEX-specific options. */
export interface ReindexOptions extends MaintenanceOptions {
  /** Target table, index name, or shard ID ('*' for all). */
  target: string;
  /** If true, target is a table name (rebuild all indexes on the table). */
  isTable?: boolean;
}

/** REBUILD-specific options. */
export interface RebuildOptions extends MaintenanceOptions {
  /** Target shard or partition. */
  target: string;
}

/**
 * Maintenance executor — orchestrate database maintenance operations.
 */
export interface IMaintenanceExecutor {
  /**
   * Run VACUUM — reclaim storage space.
   *
   * sqlvec-db: wraps PRAGMA incremental_vacuum + PRAGMA optimize / full VACUUM
   * graphvec-db: triggers graph engine compaction
   */
  vacuum(options: VacuumOptions): Promise<MaintenanceResult>;

  /**
   * Run ANALYZE — update query planner statistics.
   *
   * sqlvec-db: runs ANALYZE on target tables
   * graphvec-db: updates graph index metadata
   */
  analyze(options: AnalyzeOptions): Promise<MaintenanceResult>;

  /**
   * Run REINDEX — rebuild indexes to eliminate fragmentation.
   *
   * sqlvec-db: drop + recreate index by stored DDL
   * graphvec-db: rebuild graph index structures
   */
  reindex(options: ReindexOptions): Promise<MaintenanceResult>;

  /**
   * Get storage statistics for a target.
   */
  getStorageStats(target: string): Promise<StorageStats>;

  /**
   * Get index fragmentation report.
   */
  getIndexFragmentation(target: string): Promise<IndexFragmentation[]>;

  /**
   * Get the auto-vacuum status.
   */
  getAutoVacuumStatus(): { enabled: boolean; threshold: number };
}
