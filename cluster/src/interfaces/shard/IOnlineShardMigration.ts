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

/**
 * What a migration reports about itself.
 *
 * Every field is measured against the source the migration is copying, not
 * against the coordinator's own progress through a loop. The three that predate
 * this shape were `phase`, `progress` and `remainingBytes` — and `progress` was a
 * count of batches over a byte total drawn from `Math.random()`, so a migration
 * of an empty shard and one of a full shard reported the same curve.
 */
export interface IMigrationStatus {
  phase: string;
  /** 0–100, from entries copied over entries the source holds. */
  progress: number;
  /** Bytes still to copy, by the source's measure. Never negative. */
  remainingBytes: number;
  /** Bytes already applied on the target. */
  bytesCopied: number;
  /** Entries applied on the target. */
  entriesCopied: number;
  /** Entries the source held when the pass that copied them began. */
  entriesTotal: number;
  /** The highest source version the coordinator has consumed. */
  caughtUpVersion: number;
  /** Why the migration failed, when it did. */
  error?: string;
}

export interface IOnlineShardMigration {
  startMigration(config: IMigrationConfig): Promise<{ migrationId: string }>;
  getStatus(migrationId: string): Promise<IMigrationStatus>;
  cutover(migrationId: string): Promise<void>;
  rollback(migrationId: string): Promise<void>;
  cancel(migrationId: string): Promise<void>;
}
