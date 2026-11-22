/**
 * backup interfaces — Engine-agnostic backup and PITR abstraction.
 *
 * Defines three layers:
 *   1. IBackupManager — orchestration (create, list, restore, prune)
 *   2. IPITRManager — point-in-time recovery (continuous WAL archiving, PITR)
 *   3. IStorageBackend — pluggable storage (local FS, S3, GCS, etc.)
 *   4. IBackupRetentionPolicy — pluggable retention/purge logic
 *
 * @module @agentix-e/db-node/backup/interfaces
 */

import type {
  BackupMetadata,
  BackupResult,
  RestoreResult,
  PITRTarget,
  RetentionPolicy,
  SnapshotType,
} from '../../core/types.js';

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
   *
   * An `incremental` must record the snapshot it extends in
   * `parentSnapshotId`; the link is what lets retention keep a chain whole and
   * what lets a restore verify that the bytes it needs are still there.
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
   * Delete a backup snapshot, and every snapshot that cannot be restored
   * without it.
   *
   * Deleting a base and leaving its incrementals behind produces bytes that are
   * listed, billed and impossible to replay, so an implementation must cascade
   * to the descendants named by `parentSnapshotId`.
   *
   * @returns `false` when no such snapshot exists.
   */
  deleteBackup(snapshotId: string): Promise<boolean>;

  /**
   * Restore from a backup snapshot.
   *
   * An incremental can be replayed only on top of its whole chain, so an
   * implementation must report `success: false` and name the missing link when
   * the base is gone — reporting success for an unrestorable chain is the
   * failure mode a backup product cannot afford.
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
 * What a capture reports about itself.
 *
 * The three numbers are facts about the artefact, not estimates: `bytes` is what
 * the file the manager uploads is long, and `files` is how many things went into it.
 * A backup listing that says 1 024 bytes because nobody measured is a listing an
 * operator cannot use to decide whether the bucket will fill.
 */
export interface SnapshotCapture {
  /** Size of the artefact on disk, in bytes. */
  bytes: number;
  /** Number of files (or keys, or chunks) the artefact was built from. */
  files: number;
  /**
   * Engine facts recorded with the snapshot — `lsn`, `schemaVersion`, an epoch.
   *
   * A restore decision needs them and cannot derive them afterwards, which is why
   * they travel in the metadata rather than in a log line.
   */
  facts?: Record<string, string>;
}

/**
 * The engine side of a backup: how a consistent cut is taken, and how it is put back.
 *
 * This is the one port the middleware cannot supply. Everything around it — the
 * artefact's checksum, the upload, the confirmation that the bucket holds what was
 * uploaded, the store's own retention rules — is the same for every engine, and
 * lives in `BackupManager`. What differs is how a database produces a cut of
 * itself: a `pg_basebackup`, a SQLite `VACUUM INTO`, an LSM checkpoint, a copy of a
 * data directory.
 *
 * `capture` must produce a **consistent** cut — the engine quiesced, or the cut
 * taken from its own snapshot — because a backup of a moving target is a state no
 * moment ever held. The reference implementation in this package refuses any file
 * that changed while it was being copied, which turns a racy capture into an error
 * instead of a silently wrong artefact.
 *
 * **A source must say which of two things it is.** Either every artefact it
 * captures is a whole copy of the engine (`whole: true` — a directory tree, a
 * `VACUUM INTO`), in which case the newest artefact alone is a restore and the
 * chain above it is history; or an artefact may be a delta that is replayable only
 * on top of its ancestors, in which case the source implements `restoreChain` and
 * is handed all of them, oldest first. The manager will not guess: a chain longer
 * than one artefact reaching a source that declares neither is refused rather than
 * delivered as a single file, because a restored fragment reports success.
 */
export interface IBackupSource {
  /** Stable identifier for logs, metrics and listings. */
  readonly name: string;

  /**
   * Whether every artefact this source captures is a complete copy of the engine.
   *
   * `true` means a restore needs exactly one artefact — the newest — and that the
   * manager may hand it the head of an incremental chain. `false` or absent means
   * the manager must assume a delta and give the source its whole chain.
   *
   * A source that declares this takes on the obligation it names: if some artefacts
   * are whole and some are deltas, the answer is `false`.
   */
  readonly whole?: boolean;

  /**
   * Write a consistent cut to `destination` (a file path the manager chose) and
   * describe it.
   *
   * The manager uploads exactly this file once this resolves, so a partial artefact
   * that resolves is a backup that cannot be restored. Throwing is expected on a
   * full disk, a quiesce failure, or an unreadable file.
   */
  capture(destination: string): Promise<SnapshotCapture>;

  /**
   * Replace the engine's state with the artefact at `source` (a file path the
   * manager downloaded and verified).
   *
   * Replace, not merge: a merge leaves keys the snapshot never had, which is how a
   * restored replica diverges from the cluster it is about to rejoin. A rejection
   * means the engine's state is unknown — the caller must restore again rather than
   * assume it still holds what it held before.
   */
  restore(source: string): Promise<void>;

  /**
   * Rebuild the engine's state from `chain`, oldest artefact first and the target
   * last — the operation a delta engine actually needs.
   *
   * Every path the manager passes has already been downloaded and verified, and
   * `chain[chain.length - 1]` is the artefact of the snapshot the caller asked for.
   * The list is contiguous from a base to that snapshot: no link is skipped, because
   * a skipped delta is a state that never existed.
   *
   * Optional, and mandatory only for a source that captures deltas. A source
   * declares `whole: true` instead and is never asked. A source that declares
   * neither is refused a chain — see the note on this interface — which is the
   * behaviour that stops a delta being written over a data directory as if it were
   * a full copy.
   *
   * Same contract as `restore` about replacement and about what a rejection means,
   * and one rule more: by the time this is called, the engine is about to be
   * destroyed and rebuilt, so partial work on a rejection has to be recoverable by
   * calling it again from the same chain.
   */
  restoreChain?(chain: readonly string[]): Promise<void>;
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
