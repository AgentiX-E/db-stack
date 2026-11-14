/**
 * I26 — B4 ISnapshotManager interface.
 *
 * Manages snapshot lifecycle: creation, retention, compaction, verification,
 * and garbage collection. Sits above InstallSnapshotHandler (wire protocol)
 * and provides operational control over snapshot storage.
 */

import type { SnapshotMeta } from "../interfaces/types";

// ── Types ──────────────────────────────────────────────────

/** Full snapshot descriptor (meta + storage info). */
export interface SnapshotDescriptor {
  /** Unique snapshot identifier */
  id: string;
  /** Metadata (index, term, group) */
  meta: SnapshotMeta;
  /** File size in bytes */
  sizeBytes: number;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** SHA-256 checksum of the snapshot file */
  checksum: string;
  /** Whether this snapshot has been verified */
  verified: boolean;
  /** Whether this snapshot is marked for compaction */
  compacted: boolean;
}

/** Retention policy for snapshot pruning. */
export interface SnapshotRetentionPolicy {
  /** Maximum number of snapshots to retain (oldest pruned first). Default: 10 */
  maxSnapshots: number;
  /** Maximum age in milliseconds before a snapshot is eligible for pruning.
   * 0 = no age-based pruning. Default: 0 */
  maxAgeMs: number;
  /** Minimum snapshots to retain even if aged out. Default: 1 */
  minRetain: number;
  /** Keep at least one snapshot per interval (ms). 0 = disabled.
   * E.g. 86400000 = keep one per day. Default: 0 */
  intervalMs: number;
}

/** Compaction strategy for merging snapshots. */
export type CompactStrategy = "none" | "merge" | "selective";

export interface CompactOptions {
  /** Strategy for compaction. Default: "none" */
  strategy: CompactStrategy;
  /** Maximum number of snapshots to merge into a single compacted snapshot.
   * Only applies to "merge" and "selective" strategies. Default: 3 */
  maxMergeCount: number;
  /** Only compact snapshots older than this (ms). 0 = any age. Default: 0 */
  minAgeMs: number;
  /** Minimum snapshots to keep uncompacted. Default: 3 */
  keepUncompacted: number;
}

/** Configuration for the SnapshotManager. */
export interface SnapshotManagerConfig {
  /** Directory where snapshots are stored. Default: "./data/snapshots" */
  storageDir: string;
  /** Retention policy */
  retention: SnapshotRetentionPolicy;
  /** Compaction options */
  compact: CompactOptions;
  /** Automatically verify snapshots on creation. Default: true */
  verifyOnCreate: boolean;
  /** Automatically prune after creating N new snapshots. 0 = manual only. Default: 5 */
  autoPruneEvery: number;
}

/** Result of a snapshot verification. */
export interface VerificationResult {
  snapshotId: string;
  valid: boolean;
  checksum: string;
  sizeBytes: number;
  errors: string[];
}

// ── Interface ──────────────────────────────────────────────

export interface ISnapshotManager {
  // Lifecycle
  /** Initialize the snapshot manager, scan existing snapshots. */
  init(): Promise<void>;
  /** Shutdown and release resources. */
  shutdown(): Promise<void>;

  // CRUD
  /** Create a new snapshot from raw data. Returns a descriptor. */
  createSnapshot(
    data: Buffer,
    meta: SnapshotMeta,
  ): Promise<SnapshotDescriptor>;
  /** Delete a specific snapshot by ID. */
  deleteSnapshot(snapshotId: string): Promise<boolean>;
  /** Get descriptor for a specific snapshot. */
  getSnapshot(snapshotId: string): Promise<SnapshotDescriptor | null>;
  /** List all snapshots, optionally filtered by groupId. */
  listSnapshots(groupId?: string): Promise<SnapshotDescriptor[]>;
  /** Get the total storage used by all snapshots (bytes). */
  totalStorageBytes(): Promise<number>;

  // Verification
  /** Verify a single snapshot (checksum + integrity). */
  verifySnapshot(snapshotId: string): Promise<VerificationResult>;
  /** Verify all snapshots. Returns results keyed by snapshotId. */
  verifyAll(): Promise<Map<string, VerificationResult>>;

  // Retention & Pruning
  /** Prune snapshots according to the retention policy.
   * Returns the IDs of removed snapshots. */
  prune(): Promise<string[]>;

  // Compaction
  /** Compact snapshots according to the compaction strategy.
   * Returns the ID of the new compacted snapshot (or null if nothing compacted). */
  compact(): Promise<SnapshotDescriptor | null>;

  // Queries
  /** Find the snapshot nearest to (and ≤) a given index. */
  findNearest(index: number, groupId?: string): Promise<SnapshotDescriptor | null>;
  /** Get the latest snapshot. */
  latest(groupId?: string): Promise<SnapshotDescriptor | null>;
  /** Get snapshot count. */
  count(groupId?: string): Promise<number>;

  // Events
  /** Callback fired after a new snapshot is created. */
  onCreated(callback: (descriptor: SnapshotDescriptor) => void): () => void;
  /** Callback fired after a snapshot is pruned. */
  onPruned(callback: (ids: string[]) => void): () => void;
}
