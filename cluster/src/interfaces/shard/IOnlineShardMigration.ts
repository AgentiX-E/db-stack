export interface IMigrationConfig {
  shardId: number;
  sourceNode: string;
  targetNode: string;
  /** Batch size for incremental sync (entries per batch) */
  batchSize: number;
  /** Max time allowed for final sync (catch-up) before cutover */
  finalSyncTimeoutMs: number;
  /** Whether to pause writes during final cutover */
  pauseWritesOnCutover: boolean;
}

export interface IOnlineShardMigration {
  startMigration(config: IMigrationConfig): Promise<{ migrationId: string }>;
  getStatus(migrationId: string): Promise<{ phase: string; progress: number; remainingBytes: number }>;
  cutover(migrationId: string): Promise<void>;
  rollback(migrationId: string): Promise<void>;
  cancel(migrationId: string): Promise<void>;
}
