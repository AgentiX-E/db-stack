/**
 * InMemoryBackupManager — Simulates backup orchestration entirely in memory.
 *
 * @module @agentix-e/db-operations-backup/impl
 */

import type {
  IBackupManager,
  IStorageBackend,
  IBackupRetentionPolicy,
  CreateBackupOptions,
  ListBackupsOptions,
  RestoreOptions,
} from '../interfaces/index.js';
import type { BackupMetadata, BackupResult, RestoreResult, PITRTarget } from '@agentix-e/db-operations-core/types';
import { dependentsOf, newestCompletedSnapshot, unrestorableReason } from './backupChain.js';

/** Simple counter for generating unique IDs. */
let idCounter = 0;

/**
 * Generate a unique snapshot ID.
 */
function generateSnapshotId(): string {
  idCounter += 1;
  const ts = Date.now().toString(36);
  const seq = idCounter.toString(36);
  return `snap-${ts}-${seq}`;
}

/**
 * Simulate a delay for async backup operations.
 */
const simulateWork = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory implementation of IBackupManager.
 *
 * Stores all snapshot metadata in a Map and delegates storage/retention
 * to injected IStorageBackend and IBackupRetentionPolicy instances.
 *
 * Incrementals are chained: `createBackup({ type: 'incremental' })` records the
 * completed snapshot it extends in `parentSnapshotId`. Without that link the
 * inventory says nothing about what an incremental needs, so no retention pass
 * can keep a chain intact and no restore can tell whether the bytes it is about
 * to replay have a base. The three methods below therefore maintain one
 * invariant between them — **a stored incremental always has its whole chain
 * behind it** — and `restoreFromSnapshot` checks it, because a caller-supplied
 * `IBackupRetentionPolicy` can still break it.
 */
export class InMemoryBackupManager implements IBackupManager {
  private readonly snapshots: Map<string, BackupMetadata> = new Map();

  constructor(
    private readonly storage: IStorageBackend,
    private readonly retention: IBackupRetentionPolicy,
  ) {}

  /** @inheritdoc */
  async createBackup(options: CreateBackupOptions): Promise<BackupResult> {
    const id = generateSnapshotId();
    const now = new Date().toISOString();
    // An incremental extends the newest snapshot that finished. A chain that
    // leads back to a base is the only shape a restore can replay; chaining to
    // an in-progress or failed snapshot would name a base that no restore can
    // use. With no completed snapshot at all the incremental is stored
    // unchained and `restoreFromSnapshot` reports it as unrestorable rather
    // than pretending otherwise.
    const base = options.type === 'incremental' ? newestCompletedSnapshot(Array.from(this.snapshots.values())) : null;

    const snapshot: BackupMetadata = {
      snapshotId: id,
      type: options.type,
      state: 'in-progress',
      createdAt: now,
      sizeBytes: 1024,
      fileCount: 1,
      location: `/backups/${id}`,
      ...(base === null ? {} : { parentSnapshotId: base.snapshotId }),
    };

    this.snapshots.set(id, snapshot);

    // Simulate backup work
    await simulateWork();

    // Mark as completed
    snapshot.state = 'completed';
    snapshot.completedAt = new Date().toISOString();

    return { success: true, snapshot };
  }

  /** @inheritdoc */
  async listBackups(options?: ListBackupsOptions): Promise<BackupMetadata[]> {
    // Pull all snapshots and process filters/sort/limit via explicit loops
    // to expose every comparison and boolean for mutation testing.
    const allEntries = Array.from(this.snapshots.values());

    // Phase 1: type filter (kills L79 &&→||)
    let filteredByType: BackupMetadata[];
    if (options?.type) {
      filteredByType = [];
      const needle = options.type;
      for (const s of allEntries) {
        if (s.type === needle) {
          filteredByType.push(s);
        }
      }
    } else {
      filteredByType = allEntries;
    }

    // Phase 2: newerThan filter. Strictly newer: a snapshot taken at exactly the
    // boundary instant is not newer than it.
    let timeFiltered: BackupMetadata[];
    if (options?.newerThan) {
      const newerThanMs = new Date(options.newerThan).getTime();
      timeFiltered = filteredByType.filter((s) => new Date(s.createdAt).getTime() > newerThanMs);
    } else {
      timeFiltered = filteredByType;
    }

    // Phase 3: newest first. The subtraction is the whole rule — remove the `b -`
    // and the list comes back oldest first, which is what a single mutant of this
    // line does — and `Array.prototype.sort` is stable, so snapshots sharing a
    // timestamp keep the order they were taken in.
    timeFiltered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Phase 4: limit. Zero is not "return nothing": it means no limit, which is
    // how every other list API in this package reads an unset count.
    if (options?.limit !== undefined && options.limit > 0) {
      return timeFiltered.slice(0, options.limit);
    }

    return timeFiltered;
  }

  /** @inheritdoc */
  async getBackup(snapshotId: string): Promise<BackupMetadata | null> {
    return this.snapshots.get(snapshotId) ?? null;
  }

  /**
   * Delete a snapshot and everything that cannot be restored without it.
   *
   * Deleting a base while its incrementals stay behind creates the one state a
   * backup store must never be in: bytes that are listed, counted against the
   * quota, and impossible to replay. The cascade is reported through the return
   * value only as "the snapshot existed"; `getBackup` after the call shows what
   * went with it.
   *
   * @returns `false` when no such snapshot exists — nothing to cascade from.
   */
  async deleteBackup(snapshotId: string): Promise<boolean> {
    if (!this.snapshots.has(snapshotId)) return false;
    for (const dependentId of dependentsOf(Array.from(this.snapshots.values()), snapshotId)) {
      this.snapshots.delete(dependentId);
    }
    this.snapshots.delete(snapshotId);
    return true;
  }

  /**
   * Restore from a snapshot, refusing chains that cannot be replayed.
   *
   * `{ success: true }` for an incremental whose base is gone is the most
   * expensive lie a backup system can tell: the operator learns the restore
   * failed only when the data is needed. The chain is walked here and the
   * missing link is named.
   */
  async restoreFromSnapshot(snapshotId: string, _options?: RestoreOptions): Promise<RestoreResult> {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) {
      return { success: false, error: 'not found', durationMs: 0 };
    }

    const unrestorable = unrestorableReason(this.snapshots, snapshot);
    if (unrestorable !== null) {
      return { success: false, error: unrestorable, durationMs: 0 };
    }

    return { success: true, durationMs: 10, recoveryPoint: snapshotId };
  }

  /** @inheritdoc */
  async pitr(target: PITRTarget, _options?: RestoreOptions): Promise<RestoreResult> {
    const recoveryPoint = target.targetTime ?? target.targetLsn ?? 'unknown';

    return { success: true, durationMs: 20, recoveryPoint };
  }

  /** @inheritdoc */
  async prune(): Promise<number> {
    const allSnapshots = Array.from(this.snapshots.values());
    const deletable = this.retention.evaluate(allSnapshots);

    for (const snap of deletable) {
      this.snapshots.delete(snap.snapshotId);
    }

    return deletable.length;
  }
}
