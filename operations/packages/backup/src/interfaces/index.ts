/**
 * backup interfaces — Engine-agnostic backup and PITR abstraction.
 *
 * Defines three layers:
 *   1. IBackupManager — orchestration (create, list, restore, prune)
 *   2. IPITRManager — point-in-time recovery (continuous WAL archiving, PITR)
 *   3. IStorageBackend — pluggable storage (local FS, S3, GCS, etc.)
 *   4. IBackupRetentionPolicy — pluggable retention/purge logic
 *
 * @module @agentix-e/db-operations-backup/interfaces
 */

import type {
  BackupMetadata,
  BackupResult,
  RestoreResult,
  PITRTarget,
  RetentionPolicy,
  SnapshotType,
} from '@agentix-e/db-operations-core/types';

/** Single backup entry returned in listings. */
export type BackupEntry = {
  id: string;
  database: string;
  type: 'full' | 'incremental' | 'diff';
  sizeBytes: number;
  createdAt: Date;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'expired';
  tags?: string[];
};

/** Point-in-time restore point. */
export type RestorePoint = {
  id: string;
  timestamp: Date;
  database: string;
  type: 'log' | 'snapshot';
  sizeBytes: number;
};

/** Backup schedule configuration. */
export type IBackupScheduleConfig = {
  enabled: boolean;
  intervalMs: number;
  retentionCount: number;
};

/** Backup scheduler — manages recurring backup cycles. */
export type IBackupScheduler = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getNextScheduled(): Promise<Date | null>;
  triggerNow(): Promise<string>;
  onBackupReady(callback: (backupId: string) => void): void;
};

/** Backup manifest — metadata for a stored backup. */
export type IBackupManifest = {
  id: string;
  metadata: { database: string; type: string };
  status: string;
  sizeBytes: number;
  createdAt: Date;
};

/** Individual retention rule. */
export type IBackupRetentionRule = {
  maxCount: number;
  maxAgeDays: number;
  minInterval: number;
};

/** Options for creating a backup. */
export interface CreateBackupOptions {
  /** Snapshot type. */
  type: SnapshotType;
  /** Optional description or tags. */
  tags?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/** Options for listing backups. */
export interface ListBackupsOptions {
  /** Filter by type. */
  type?: SnapshotType;
  /** Limit the number of results. */
  limit?: number;
  /** Return only snapshots newer than this timestamp (ISO-8601). */
  newerThan?: string;
}

/** Options for restoring from a backup. */
export interface RestoreOptions {
  /** Target shard IDs to restore (empty = all). */
  shardIds?: string[];
  /** Skip integrity verification. */
  skipVerification?: boolean;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Backup manager — top-level backup orchestration.
 */
export interface IBackupManager {
  /**
   * Create a backup snapshot.
   */
  createBackup(options: CreateBackupOptions): Promise<BackupResult>;

  /**
   * List all available backup snapshots.
   */
  listBackups(options?: ListBackupsOptions): Promise<BackupMetadata[]>;

  /**
   * Get metadata for a specific snapshot.
   */
  getBackup(snapshotId: string): Promise<BackupMetadata | null>;

  /**
   * Delete a backup snapshot.
   */
  deleteBackup(snapshotId: string): Promise<boolean>;

  /**
   * Restore from a backup snapshot.
   */
  restoreFromSnapshot(snapshotId: string, options?: RestoreOptions): Promise<RestoreResult>;

  /**
   * Execute point-in-time recovery to a specific target.
   * Wraps IPITRManager with additional coordination.
   */
  pitr(target: PITRTarget, options?: RestoreOptions): Promise<RestoreResult>;

  /**
   * Prune old backups according to the retention policy.
   * Returns number of deleted snapshots.
   */
  prune(): Promise<number>;
}

/**
 * Point-in-Time Recovery manager.
 */
export interface IPITRManager {
  /**
   * Get the current WAL position.
   */
  getCurrentLSN(): Promise<string>;

  /**
   * Get the current WAL position as a timestamp (ISO-8601).
   */
  getCurrentTimestamp(): Promise<string>;

  /**
   * Archive the current WAL segment.
   */
  archiveCurrentWal(): Promise<void>;

  /**
   * Get the recovery point closest to the target time.
   */
  resolveTarget(target: PITRTarget): Promise<{
    snapshotId: string;
    walEndLsn: string;
    approxTime: string;
  }>;

  /**
   * Check if PITR is enabled and operational.
   */
  isEnabled(): boolean;
}

/**
 * Storage backend for backup data.
 */
export interface IStorageBackend {
  /** Unique storage backend identifier. */
  readonly name: string;

  /** Upload a file to the storage backend. */
  upload(sourcePath: string, destKey: string): Promise<void>;

  /** Download a file from the storage backend. */
  download(sourceKey: string, destPath: string): Promise<void>;

  /** List objects with the given prefix. */
  list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: string }>>;

  /** Delete an object. */
  delete(key: string): Promise<void>;

  /** Check if the backend is accessible. */
  health(): Promise<{ ok: boolean; message?: string }>;

  /** Get total storage usage in bytes. */
  getUsageBytes(): Promise<number>;
}

/**
 * Backup retention policy.
 */
export interface IBackupRetentionPolicy {
  /**
   * Evaluate which snapshots to keep/prune given the current inventory.
   * Returns the snapshot IDs to delete.
   */
  evaluate(snapshots: BackupMetadata[]): BackupMetadata[];

  /**
   * Get the policy configuration.
   */
  getConfig(): RetentionPolicy;

  /**
   * Update the policy configuration at runtime.
   */
  updateConfig(config: Partial<RetentionPolicy>): void;
}
