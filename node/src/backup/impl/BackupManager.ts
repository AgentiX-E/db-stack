/**
 * BackupManager — the real one: it moves bytes, and it knows when it has not.
 *
 * The class this replaces (`InMemoryBackupManager`) recorded `sizeBytes: 1024` after
 * a five-millisecond timer and answered `{ success: true }` to a restore without
 * touching a database. It implemented `IBackupManager` by name only, which made
 * every document that said this package backs a database up a description of the
 * interface rather than of the product.
 *
 * The shape here is four steps, and each of them exists because skipping it is a
 * failure mode that a green test cannot see:
 *
 * ```
 *   source.capture(staging)      a consistent cut, as a file on disk
 *           │
 *           ├─ digest + size     what the bucket is about to hold
 *           ▼
 *   storage.upload(staging,key)  the bytes leave this machine
 *           │
 *           ├─ storage.list(key)  the bucket says it has them, at that size
 *           ▼
 *   metadata completed           only now is a snapshot a snapshot
 * ```
 *
 * A snapshot that reached `completed` therefore names a key that the bucket answers
 * for, at the length the manager measured. A restore is the same list read
 * backwards: download, check the digest against the metadata, and only then hand the
 * file to the engine.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CreateBackupOptions,
  IBackupManager,
  IBackupRetentionPolicy,
  IBackupSource,
  IStorageBackend,
  ListBackupsOptions,
  RestoreOptions,
} from '../interfaces/index.js';
import type { BackupMetadata, BackupResult, PITRTarget, RestoreResult } from '../../core/types.js';
import { dependentsOf, newestCompletedSnapshot, unrestorableReason } from './backupChain.js';
import { hashFile } from './backupArtifact.js';

/** Optional collaborators of a `BackupManager`. */
export interface BackupManagerOptions {
  /** Key prefix inside the bucket (default `backups`). */
  prefix?: string;
  /**
   * Directory the artefact is written to before it is uploaded.
   *
   * Defaults to the system temp directory. Point it at a volume with room for one
   * artefact: the capture is written here in full before a byte leaves the machine,
   * so a 200 GB database needs 200 GB of scratch space. A manager that streamed the
   * capture straight into the bucket would need none, and would also be unable to
   * compute the digest the bucket's contents are checked against.
   */
  workDir?: string;
  /** Clock, injectable so a test can name a timestamp without racing one. */
  clock?: () => Date;
}

/** Number of the next snapshot this process will create. */
let sequence = 0;

/**
 * Compare two log sequence numbers.
 *
 * `16/B374D848` is a segment and an offset in hex, which is how PostgreSQL writes
 * them and how most engines that speak "LSN" inherited the shape. Comparing those as
 * strings puts `16/9` after `16/10`, and a point-in-time target that resolves to the
 * wrong snapshot is a restore to the wrong minute. Anything that does not have that
 * shape is compared as a string, which is at least a total order.
 */
export function compareLsn(a: string, b: string): number {
  const split = (value: string): [number, number] | null => {
    const parts = value.split('/');
    if (parts.length !== 2) return null;
    const high = Number.parseInt(parts[0]!, 16);
    const low = Number.parseInt(parts[1]!, 16);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    return [high, low];
  };
  const left = split(a);
  const right = split(b);
  if (left === null || right === null) return a < b ? -1 : a > b ? 1 : 0;
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
}

/** One sentence for a rejection, with the cause kept when it has one. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Delete a file and forget its failure.
 *
 * Staging files are removed in a `finally`, and a failure to remove one must not
 * replace the error that is already travelling to the caller — the operator needs the
 * reason the backup failed, not the reason the cleanup did. The function exists as a
 * function so that the "cannot remove it" arm is a branch a test can reach, with a
 * path under a file.
 */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // A staging directory that cannot be removed is a disk to look at, not a backup
    // to report as failed for a second reason.
  }
}

/**
 * Expand a delete list to the snapshots that cannot be replayed without it.
 *
 * Retention names snapshots; the invariant is about **sets**. A policy that returns a
 * base and leaves its deltas would produce bytes that are listed, billed and
 * impossible to restore, so the expansion happens in one place, keeps the input order,
 * and answers a name it does not hold by skipping it — a caller that raced another
 * delete gets the deletion it asked for rather than a throw.
 */
export function expandDeletions(inventory: readonly BackupMetadata[], ids: readonly string[]): BackupMetadata[] {
  const byId = new Map(inventory.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const targets = new Set<string>();
  for (const id of ids) {
    // A name the inventory does not hold is skipped, not thrown at: a caller that
    // raced another delete gets the deletion it asked for.
    if (!byId.has(id)) continue;
    targets.add(id);
    for (const dependent of dependentsOf(inventory, id)) targets.add(dependent);
  }
  // The answer is in inventory order rather than in the order the caller named them,
  // so two policies that name the same set produce the same log line.
  return inventory.filter((snapshot) => targets.has(snapshot.snapshotId));
}

/**
 * Backup orchestration over an engine port, a bucket and a retention policy.
 *
 * The three collaborators are positional and required: each is an interface with
 * more than one implementation and none has a sensible default. A manager that
 * quietly backed up to memory would be a manager whose backups are gone at the next
 * restart, and a manager that invented a retention policy would delete evidence
 * nobody asked it to delete.
 */
export class BackupManager implements IBackupManager {
  private readonly source: IBackupSource;
  private readonly storage: IStorageBackend;
  private readonly retention: IBackupRetentionPolicy;
  private readonly prefix: string;
  private readonly workDir: string;
  private readonly clock: () => Date;
  private readonly snapshots: Map<string, BackupMetadata> = new Map();

  constructor(
    source: IBackupSource,
    storage: IStorageBackend,
    retention: IBackupRetentionPolicy,
    options: BackupManagerOptions = {},
  ) {
    this.source = source;
    this.storage = storage;
    this.retention = retention;
    this.prefix = options.prefix ?? 'backups';
    this.workDir = options.workDir ?? tmpdir();
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Take a backup, and answer `success: true` only if the bucket holds it.
   *
   * Every step that can fail is named in the error, because the operator reading it
   * has to decide between retrying, freeing space and calling the storage team — and
   * "backup failed" answers none of those. A failure leaves no `completed` metadata
   * behind: a listing that shows a snapshot the bucket does not have is worse than an
   * empty listing.
   */
  async createBackup(options: CreateBackupOptions): Promise<BackupResult> {
    const id = `snap-${this.clock().getTime().toString(36)}-${(sequence += 1).toString(36)}-${randomUUID().slice(0, 8)}`;
    const staging = join(this.workDir, `${id}.artifact`);
    const key = `${this.prefix}/${options.type}/${id}.artifact`;
    const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;

    const base = options.type === 'incremental' ? newestCompletedSnapshot(Array.from(this.snapshots.values())) : null;
    const snapshot: BackupMetadata = {
      snapshotId: id,
      type: options.type,
      state: 'in-progress',
      createdAt: this.clock().toISOString(),
      sizeBytes: 0,
      fileCount: 0,
      location: key,
      ...(base === null ? {} : { parentSnapshotId: base.snapshotId }),
    };

    try {
      await mkdir(this.workDir, { recursive: true });
      const capture = await this.source.capture(staging);
      if (deadline !== null && Date.now() > deadline) {
        throw new Error(`the capture took longer than ${options.timeoutMs} ms`);
      }

      // The size on disk, not the size the source reported: one of them is a fact
      // and the other is a number a bug can produce, and the bucket is about to be
      // asked about the first one.
      const { size } = await stat(staging);
      if (size !== capture.bytes) {
        throw new Error(`${this.source.name} reported ${capture.bytes} bytes but wrote ${size}`);
      }
      const { sha256 } = await hashFile(staging);

      await this.storage.upload(staging, key);
      if (deadline !== null && Date.now() > deadline) {
        throw new Error(`the upload finished after the ${options.timeoutMs} ms budget`);
      }

      // The confirmation. `upload` resolving means the bytes were sent; whether the
      // bucket lists them is a different question, and it is the one a restore will
      // ask. A snapshot that reached `completed` without this check is a promise made
      // from the sender's side only.
      const listed = await this.storage.list(key);
      const object = listed.find((entry) => entry.key === key);
      if (object === undefined) {
        throw new Error(`the bucket does not list ${key} after the upload (listed ${listed.length} object(s))`);
      }
      if (object.size !== size) {
        throw new Error(`the bucket lists ${key} at ${object.size} bytes, ${size} were uploaded`);
      }

      snapshot.sizeBytes = size;
      snapshot.fileCount = capture.files;
      snapshot.checksum = sha256;
      snapshot.state = 'completed';
      snapshot.completedAt = this.clock().toISOString();
      if (capture.facts !== undefined && Object.keys(capture.facts).length > 0) snapshot.facts = capture.facts;
      this.snapshots.set(id, snapshot);

      return { success: true, snapshot };
    } catch (error) {
      // No metadata is stored for a failed attempt. A listing that shows a snapshot
      // the bucket does not hold is worse than an empty listing, because it is a
      // snapshot somebody will plan a recovery around.
      return { success: false, error: `${this.source.name} → ${key}: ${reason(error)}` };
    } finally {
      await removeQuietly(staging);
    }
  }

  /** @inheritdoc */
  async listBackups(options?: ListBackupsOptions): Promise<BackupMetadata[]> {
    let result = Array.from(this.snapshots.values());
    if (options?.type !== undefined) result = result.filter((s) => s.type === options.type);
    if (options?.newerThan !== undefined) {
      const boundary = new Date(options.newerThan).getTime();
      result = result.filter((s) => new Date(s.createdAt).getTime() > boundary);
    }
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (options?.limit !== undefined && options.limit > 0) result = result.slice(0, options.limit);
    return result;
  }

  /** @inheritdoc */
  async getBackup(snapshotId: string): Promise<BackupMetadata | null> {
    return this.snapshots.get(snapshotId) ?? null;
  }

  /**
   * Remove these snapshots' objects and records, and report how many went.
   *
   * One place, because the count a caller reads depends on it: deleting a base takes
   * its dependents with it, and a `prune()` that reported "1 deleted" while two
   * records disappeared would be a number nobody can reconcile with the listing.
   * The object goes before the record, so a failed delete leaves something to retry
   * from rather than a metadata row pointing at nothing.
   */
  private async discard(snapshots: readonly BackupMetadata[]): Promise<number> {
    let removed = 0;
    for (const snapshot of snapshots) {
      await this.storage.delete(snapshot.location);
      this.snapshots.delete(snapshot.snapshotId);
      removed += 1;
    }
    return removed;
  }

  /** @inheritdoc */
  async deleteBackup(snapshotId: string): Promise<boolean> {
    if (!this.snapshots.has(snapshotId)) return false;
    // Dependents first: an incremental without its base is unrestorable, and a
    // failure part way through then leaves a chain that still works rather than a
    // head that cannot.
    await this.discard(expandDeletions(Array.from(this.snapshots.values()), [snapshotId]));
    return true;
  }

  /**
   * Restore a snapshot: download, verify, and only then touch the engine.
   *
   * The order is the whole method. Every check that can be made against the metadata
   * — the chain, the size, the digest — happens before `restore` is called, because
   * the one thing a rejected restore must not have done is replace half of a healthy
   * database with half of a corrupt artefact.
   */
  async restoreFromSnapshot(snapshotId: string, options?: RestoreOptions): Promise<RestoreResult> {
    const started = Date.now();
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) return { success: false, error: 'not found', durationMs: 0 };

    const unrestorable = unrestorableReason(this.snapshots, snapshot);
    if (unrestorable !== null) return { success: false, error: unrestorable, durationMs: Date.now() - started };

    const staging = join(this.workDir, `${snapshotId}.restore.artifact`);
    try {
      await mkdir(this.workDir, { recursive: true });
      await this.storage.download(snapshot.location, staging);

      const { size } = await stat(staging);
      if (size !== snapshot.sizeBytes) {
        return {
          success: false,
          error: `the artefact is ${size} bytes, the snapshot recorded ${snapshot.sizeBytes}`,
          durationMs: Date.now() - started,
        };
      }
      if (options?.skipVerification !== true && snapshot.checksum !== undefined) {
        const { sha256 } = await hashFile(staging);
        if (sha256 !== snapshot.checksum) {
          return {
            success: false,
            error: `the artefact does not match the snapshot's digest (${sha256.slice(0, 12)}… ≠ ${snapshot.checksum.slice(0, 12)}…)`,
            durationMs: Date.now() - started,
          };
        }
      }

      await this.source.restore(staging);
      return { success: true, recoveryPoint: snapshotId, durationMs: Date.now() - started };
    } catch (error) {
      return { success: false, error: reason(error), durationMs: Date.now() - started };
    } finally {
      await removeQuietly(staging);
    }
  }

  /**
   * Point-in-time recovery, resolved against what this manager actually holds.
   *
   * Three ways to name a target, and each one is answered by a comparison rather than
   * by an invention:
   *
   *   - `snapshotId` — restore that snapshot.
   *   - `targetTime` — the newest completed snapshot taken at or before it.
   *   - `targetLsn`  — the newest completed snapshot whose recorded `lsn` is at or
   *     before it. An engine that does not record an `lsn` fact cannot satisfy this,
   *     and saying so is the correct answer: the alternative is a recovery point that
   *     was never compared to anything.
   *
   * `recoveryPoint` in the result is the position that was reached, not the target
   * that was asked for. A caller that wanted 12:30 and got 12:27 has to be able to
   * see that in the answer.
   */
  async pitr(target: PITRTarget, options?: RestoreOptions): Promise<RestoreResult> {
    if (target.snapshotId !== undefined) return this.restoreFromSnapshot(target.snapshotId, options);

    const completed = Array.from(this.snapshots.values()).filter((s) => s.state === 'completed');

    if (target.targetTime !== undefined) {
      const boundary = new Date(target.targetTime).getTime();
      if (Number.isNaN(boundary)) {
        return { success: false, error: `targetTime ${target.targetTime} is not a date`, durationMs: 0 };
      }
      const candidates = completed.filter((s) => new Date(s.createdAt).getTime() <= boundary);
      const chosen = candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (chosen === undefined) {
        return { success: false, error: `no snapshot at or before ${target.targetTime}`, durationMs: 0 };
      }
      return this.restoreFromSnapshot(chosen.snapshotId, options);
    }

    if (target.targetLsn !== undefined) {
      const candidates = completed.filter((s) => {
        const lsn = s.facts?.['lsn'];
        return lsn !== undefined && compareLsn(lsn, target.targetLsn!) <= 0;
      });
      const chosen = candidates.sort((a, b) => compareLsn(b.facts!['lsn']!, a.facts!['lsn']!))[0];
      if (chosen === undefined) {
        return {
          success: false,
          error: `no snapshot at or before LSN ${target.targetLsn} (${completed.length} completed snapshot(s) considered)`,
          durationMs: 0,
        };
      }
      return this.restoreFromSnapshot(chosen.snapshotId, options);
    }

    return { success: false, error: 'the target names neither a time nor an LSN', durationMs: 0 };
  }

  /**
   * @inheritdoc
   *
   * The number returned is what was deleted, which is not what the policy asked for
   * whenever the policy names a base and leaves its deltas: those go too, and they
   * are counted. A caller comparing the return value with a listing is the check
   * that keeps the two in step.
   */
  async prune(): Promise<number> {
    const inventory = Array.from(this.snapshots.values());
    const named = this.retention.evaluate(inventory).map((snapshot) => snapshot.snapshotId);
    return this.discard(expandDeletions(inventory, named));
  }
}
