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
 * Where the metadata lives
 * ------------------------
 * In the bucket, beside the artefacts: one immutable record per snapshot under
 * `<prefix>/inventory/`. It used to live in a `Map` on this instance, which meant the
 * artefacts outlived the process and their names did not — a restarted manager
 * answered `not found` for a backup the same binary had written an hour earlier.
 *
 * Every public method starts by reading that listing, so a manager is never wrong
 * about what the bucket holds; the read is single-flight, so a burst of calls costs
 * one listing rather than one each. The listing is also the reconciliation: a record
 * that is gone is a snapshot that is gone, wherever it was deleted from, and a record
 * in the bucket that this instance has never seen is a snapshot another process took.
 * The bucket is the inventory — there is no second source of truth to disagree with.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { dependentsOf, newestCompletedSnapshot, resolveChain } from './backupChain.js';
import { hashFile } from './backupArtifact.js';
import { inventoryIdOf, inventoryKey, inventoryPrefix, parseRecord, serializeRecord } from './inventory.js';

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
 * The snapshot id an artefact's key carries, or `null` when the name is not one this
 * package writes.
 *
 * `${prefix}/${type}/${id}.artifact` is the shape `createBackup` produces, and the id is
 * the only part of it a record can be matched by when the record itself cannot be read.
 * `null` rather than a guess: an object under the prefix whose name does not have this
 * shape is still an object no record names, and reporting it is the honest answer — it
 * simply cannot be attributed to a snapshot, which is what `null` says.
 */
export function artifactIdOf(key: string): string | null {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const suffix = '.artifact';
  if (!name.endsWith(suffix)) return null;
  const id = name.slice(0, -suffix.length);
  return id === '' ? null : id;
}

/**
 * How many record downloads may be in flight at once while hydrating.
 *
 * One per record would be a bucket listing's worth of latency spent in series; all of
 * them at once is a hundred GETs against a bucket that will start answering `503`.
 * Eight is the compromise, and it is a constant rather than a knob because the correct
 * value is a property of the operator's bucket, not of this class.
 */
const INVENTORY_CONCURRENCY = 8;

/** A record in the bucket that this manager could not read. */
export interface InventoryProblem {
  /** Key of the record. */
  key: string;
  /** Why it could not be read, as the reader reported it. */
  reason: string;
}

/** The listing's own fingerprint of an object, as the bucket reported it. */
function stampOf(entry: { size: number; lastModified: string }): string {
  return `${entry.size}:${entry.lastModified}`;
}

/**
 * How long an object no record names is still read as a backup in progress.
 *
 * `createBackup` uploads the artefact and *then* writes its record, so for the length of
 * one confirmation there is an object in the bucket that nothing names — and it is a
 * backup, not garbage. Ten minutes is longer than any confirmation (one upload, one
 * listing, one small PUT) and far shorter than a retention cycle, so an object that is
 * still nameless ten minutes later is a delete that failed, not a backup that is
 * running.
 *
 * A parameter rather than a constant in the method because two deployments disagree
 * about it: a bucket with a slow replication path needs longer, and an operator cleaning
 * up after an incident wants it shorter.
 */
export const RECONCILE_GRACE_MS = 10 * 60 * 1000;

/** An object under the backup prefix that no record names. */
export interface OrphanArtifact {
  /** Where the object is. */
  key: string;
  /** How large the bucket says it is. */
  size: number;
  /** When the bucket says it was last written. */
  lastModified: string;
  /** The snapshot id its name carries, or `null` for an object this package did not name. */
  snapshotId: string | null;
}

/** A record whose artefact the bucket does not hold. */
export interface MissingArtefact {
  /** The snapshot the record describes. */
  snapshotId: string;
  /** The key the record names. */
  key: string;
}

/** What `reconcile` found, and whether it acted. */
export interface ReconcileReport {
  /** Nameless objects old enough to be garbage. */
  orphaned: OrphanArtifact[];
  /**
   * Nameless objects young enough to be a backup in progress.
   *
   * Reported separately because the two demand opposite actions: one is bytes to reclaim,
   * the other is bytes to leave alone. A single list would make the caller decide which
   * is which, and the wrong decision here deletes a backup that was about to be written.
   */
  inFlight: OrphanArtifact[];
  /** Records whose artefact is absent: listed, restorable in principle, gone in fact. */
  missing: MissingArtefact[];
  /** How many orphans were deleted — `0` unless `reclaim` was asked for. */
  reclaimed: number;
}

/** Options for `reconcile`. */
export interface ReconcileOptions {
  /**
   * Delete the orphans.
   *
   * Off by default, and the default is the point: a listing that is merely stale — a
   * bucket which has not finished replicating, a cache in front of it — makes a record
   * look absent, and an object no record *appears* to name is one delete away from being
   * a backup nobody has.
   */
  reclaim?: boolean;
  /** Override `RECONCILE_GRACE_MS`. */
  graceMs?: number;
}

/**
 * Run `run` over every item, at most `limit` at a time.
 *
 * Written as workers pulling from a cursor rather than as chunked batches, so one slow
 * download does not hold up the next batch: the pool stays full until the work runs out.
 */
async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await run(item as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
  private readonly damaged: Map<string, string> = new Map();
  /**
   * What the bucket said about each record when it was last read — `${size}:${lastModified}`.
   *
   * Without this, a record rewritten in place under the same key would never be read
   * again: the id is already known, so the reconcile would skip it and a manager that
   * has been up for a week would keep serving the first version it saw. The stamp is
   * the listing's own two numbers, so noticing a change costs nothing beyond the
   * listing that was already being made.
   */
  private readonly stamps: Map<string, string> = new Map();
  /** The listing in flight, so concurrent callers share one read of the bucket. */
  private listing: Promise<void> | null = null;

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
   * Read the bucket's inventory into this instance.
   *
   * Single-flight: a burst of concurrent calls shares one listing, and the slot is
   * cleared when it settles so the *next* call reads again. That is what makes a
   * second worker's backup visible without an API to poll — the alternative, hydrating
   * once at construction, is a manager that is correct only about the bucket as it was
   * when the process started.
   *
   * The reconciliation runs both ways, because a listing is the truth in both
   * directions: a snapshot this instance holds whose record is gone was deleted
   * elsewhere and must stop being listed, and a record it has never seen was written
   * elsewhere and must start being listed. Nothing drops entries on the strength of a
   * *failed* read — that is damage, and damage is reported rather than acted on.
   */
  private async sync(): Promise<void> {
    if (this.listing === null) {
      const inFlight = this.readInventory();
      // The slot is cleared when the read settles, whichever way it settles: a failed
      // listing must not be cached as if the bucket were empty.
      this.listing = inFlight.finally(() => {
        this.listing = null;
      });
      // Awaited through the field, not through `inFlight`: the wrapped promise is the
      // one that is stored, and a rejection nobody awaits is a rejection Node reports
      // as unhandled.
      await this.listing;
      return;
    }
    await this.listing;
  }

  /** One read of the bucket: list the records, load the ones this instance lacks or holds an old copy of. */
  private async readInventory(): Promise<void> {
    const prefix = this.prefix;
    const listed = await this.storage.list(inventoryPrefix(prefix));
    const records = listed.filter((entry) => inventoryIdOf(prefix, entry.key) !== null);

    const present = new Set(records.map((entry) => entry.key));
    for (const id of [...this.snapshots.keys()]) {
      if (!present.has(inventoryKey(prefix, id))) {
        this.snapshots.delete(id);
        this.stamps.delete(id);
      }
    }
    // A problem about a record that is no longer in the bucket is a problem that has
    // been dealt with by whoever deleted it.
    for (const key of [...this.damaged.keys()]) {
      if (!present.has(key)) this.damaged.delete(key);
    }

    const stale = records.filter((entry) => {
      const id = inventoryIdOf(prefix, entry.key) as string;
      return !this.snapshots.has(id) || this.stamps.get(id) !== stampOf(entry);
    });
    if (stale.length === 0) return;
    await mkdir(this.workDir, { recursive: true });
    await eachLimited(stale, INVENTORY_CONCURRENCY, async (entry) => {
      const id = inventoryIdOf(prefix, entry.key) as string;
      const local = join(this.workDir, `${id}.record.reading`);
      this.stamps.set(id, stampOf(entry));
      try {
        await this.storage.download(entry.key, local);
        this.snapshots.set(id, parseRecord(id, await readFile(local, 'utf8')));
        this.damaged.delete(entry.key);
      } catch (error) {
        // A record that cannot be read is a snapshot that cannot be restored, and a
        // manager that threw here would let one damaged kilobyte stop every backup in
        // the deployment. It is reported through `inventoryProblems()` instead, and
        // the stamp keeps it from being re-read on every listing.
        this.snapshots.delete(id);
        this.damaged.set(entry.key, reason(error));
      } finally {
        await removeQuietly(local);
      }
    });
  }

  /**
   * Undo an upload the bucket would not confirm.
   *
   * A backup either exists completely or not at all: a caller told `success: false`
   * that leaves a listable snapshot behind has been told something the bucket
   * contradicts, and an operator is entitled to believe the answer. So a failed
   * confirmation removes what was uploaded before it returns.
   *
   * The failure to remove is swallowed, and only here: the caller needs the reason the
   * backup failed, not the reason the tidying failed. What survives is an object no
   * record names — invisible, not a snapshot — and a bucket lifecycle rule is what
   * eventually reclaims it.
   */
  private async abandon(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // Deliberate: see above.
      }
    }
  }

  /**
   * Write and confirm a snapshot's record.
   *
   * The confirmation is here for the same reason the artefact's is: `upload` resolving
   * says the bytes were sent, and the listing is what the next process will consult.
   * A record that the bucket did not keep is a snapshot nobody can name, so it is not
   * a snapshot — the caller is told the backup failed, and the artefact it left behind
   * is invisible rather than half-announced.
   */
  private async writeRecord(snapshot: BackupMetadata): Promise<void> {
    const key = inventoryKey(this.prefix, snapshot.snapshotId);
    const local = join(this.workDir, `${snapshot.snapshotId}.record.writing`);
    try {
      await writeFile(local, serializeRecord(snapshot));
      const { size } = await stat(local);
      try {
        await this.storage.upload(local, key);
        const listed = await this.storage.list(key);
        const object = listed.find((entry) => entry.key === key);
        if (object === undefined) throw new Error('the bucket does not list it after the upload');
        if (object.size !== size) throw new Error(`the bucket lists ${object.size} bytes, ${size} were written`);
        // Recorded now so the next listing does not download what this call just wrote.
        this.stamps.set(snapshot.snapshotId, stampOf(object));
      } catch (error) {
        // The artefact is already in the bucket by the time this runs, so the error
        // has to say which half failed — otherwise the caller reads the artefact's key
        // in the message and goes looking at the bytes — and both halves go, because
        // an artefact no record names is not a backup.
        await this.abandon([key, snapshot.location]);
        throw new Error(`inventory record ${key}: ${reason(error)}`);
      }
    } finally {
      await removeQuietly(local);
    }
  }

  /**
   * Records in the bucket that this manager could not read, with the reason.
   *
   * A damaged record is not thrown and not silently skipped: the snapshot it describes
   * cannot be restored, an operator has to be able to see that, and the remedy is to
   * look at the object — so it is reported here, keyed, with the reader's own words.
   * The list reflects the most recent inventory read, which every public method does.
   */
  inventoryProblems(): InventoryProblem[] {
    return [...this.damaged.entries()].map(([key, failure]) => ({ key, reason: failure }));
  }

  /**
   * List the objects under the backup prefix that no record names, and say what is missing.
   *
   * The bucket is the inventory, so an object no record names is not a snapshot: it is
   * invisible bytes. The delete path produces them on purpose — the record goes first, so
   * that a listing never names an artefact that cannot be restored — and the price is that
   * a delete which fails between the two leaves bytes that cost money, cannot be restored,
   * and cannot be found without listing the bucket. This is that listing.
   *
   * Three answers, and the split between them is the whole design:
   *
   *   - **orphaned** — no record names it, and it has been that way for longer than the
   *     grace window. Garbage from a failed delete.
   *   - **inFlight** — no record names it *yet*. `createBackup` uploads and then records,
   *     so an object in that window is a backup being taken, and reclaiming it would delete
   *     the thing the caller is waiting for. Age is how the two are told apart, because
   *     nothing else about an object says which of the two it is.
   *   - **missing** — a record whose artefact is gone. The mirror image, and worse in one
   *     way: a listing names a snapshot that cannot be restored.
   *
   * Nothing is deleted unless `reclaim` is asked for, and even then only the first kind.
   * A reconcile that deleted on its own would turn one stale listing into a bucket of
   * missing backups, and a stale listing is the ordinary state of a bucket behind a cache.
   *
   * A record this process could not read still protects its artefact: the id is in the
   * record's *key*, which needs no parsing, and a damaged record is a snapshot an operator
   * has to be able to look at rather than a licence to delete bytes.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileReport> {
    await this.sync();
    const listed = await this.storage.list(`${this.prefix}/`);
    const listedKeys = new Set(listed.map((entry) => entry.key));

    // Both ways a record names an object: the `location` a readable one carries, and the id
    // every record's key carries — the second is what protects a record this process could
    // not parse.
    const namedLocations = new Set<string>();
    for (const snapshot of this.snapshots.values()) namedLocations.add(snapshot.location);
    const namedIds = new Set<string>();
    for (const entry of listed) {
      const id = inventoryIdOf(this.prefix, entry.key);
      if (id !== null) namedIds.add(id);
    }

    const graceMs = options.graceMs ?? RECONCILE_GRACE_MS;
    // The manager's own clock, not `Date.now()`. `createBackup` stamps `createdAt` with
    // `this.clock()`, so an age measured against a different clock is an age an operator
    // cannot reconcile — and a boundary no test can stand exactly on, which is how a
    // `<` and a `<=` come to be the same line.
    const now = this.clock().getTime();
    const unnamed = new Map<string, OrphanArtifact>();
    const garbage: string[] = [];
    const pending: string[] = [];
    for (const entry of listed) {
      if (inventoryIdOf(this.prefix, entry.key) !== null) continue;
      const snapshotId = artifactIdOf(entry.key);
      if (namedLocations.has(entry.key)) continue;
      if (snapshotId !== null && namedIds.has(snapshotId)) continue;
      unnamed.set(entry.key, { key: entry.key, size: entry.size, lastModified: entry.lastModified, snapshotId });
      // An object whose age cannot be read is not one to reclaim: `Date.parse` answering
      // `NaN` is the bucket saying something this code does not understand, and a failed
      // observation is not a verdict about age — the same rule the audit store's prune
      // applies to a segment it cannot date.
      const age = now - Date.parse(entry.lastModified);
      if (!Number.isFinite(age) || age < graceMs) pending.push(entry.key);
      else garbage.push(entry.key);
    }

    let reclaimed = 0;
    if (options.reclaim === true) {
      for (const key of garbage) {
        try {
          await this.storage.delete(key);
          reclaimed += 1;
        } catch {
          // A delete that fails is an object that stays, and the next reconcile reports it
          // again. Swallowed for the reason `abandon` swallows: the report the caller is
          // holding is worth more than the reason one line of it could not be tidied.
        }
      }
    }

    const missing: MissingArtefact[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (!listedKeys.has(snapshot.location)) {
        missing.push({ snapshotId: snapshot.snapshotId, key: snapshot.location });
      }
    }

    // Sorted, because a listing's order is the backend's business: two runs against two
    // backends that hold the same objects have to produce the same report. The default
    // comparator is code-unit order — the same on every machine and in every locale,
    // which `localeCompare` is not — and it needs no comparator function to be written
    // and no ties to be arbitrated: a bucket holds one object per key.
    const inKeyOrder = (keys: string[]): OrphanArtifact[] =>
      keys.sort().map((key) => unnamed.get(key) as OrphanArtifact);
    return { orphaned: inKeyOrder(garbage), inFlight: inKeyOrder(pending), missing, reclaimed };
  }

  /**
   * Take a backup, and answer `success: true` only if the bucket holds it.
   *
   * Every step that can fail is named in the error, because the operator reading it
   * has to decide between retrying, freeing space and calling the storage team — and
   * "backup failed" answers none of those. A failure leaves no `completed` metadata
   * behind: a listing that shows a snapshot the bucket does not have is worse than an
   * empty listing. An upload the bucket will not confirm is taken back for the same
   * reason — `success: false` and a listable snapshot cannot both be true.
   */
  async createBackup(options: CreateBackupOptions): Promise<BackupResult> {
    const id = `snap-${this.clock().getTime().toString(36)}-${(sequence += 1).toString(36)}-${randomUUID().slice(0, 8)}`;
    const staging = join(this.workDir, `${id}.artifact`);
    const key = `${this.prefix}/${options.type}/${id}.artifact`;
    // The manager's own clock, like every other timestamp it writes. A budget measured on
    // `Date.now()` is a budget a test cannot spend: the capture and the upload are timed by
    // wall-clock reads this class does not own, so "the upload overran" was a claim about
    // how loaded the runner was. With the clock injected, the test moves it.
    const deadline = options.timeoutMs === undefined ? null : this.clock().getTime() + options.timeoutMs;

    const snapshot: BackupMetadata = {
      snapshotId: id,
      type: options.type,
      state: 'in-progress',
      createdAt: this.clock().toISOString(),
      sizeBytes: 0,
      fileCount: 0,
      location: key,
    };

    try {
      // The base is chosen from the bucket, not from what this process remembers
      // creating: otherwise the first incremental after a restart would record no
      // parent, and a delta with no parent is a snapshot a restore treats as a base —
      // which is a database restored from one eighth of itself.
      await this.sync();
      if (options.type === 'incremental') {
        const base = newestCompletedSnapshot(Array.from(this.snapshots.values()));
        if (base !== null) snapshot.parentSnapshotId = base.snapshotId;
      }

      await mkdir(this.workDir, { recursive: true });
      const capture = await this.source.capture(staging);
      if (deadline !== null && this.clock().getTime() > deadline) {
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
      if (deadline !== null && this.clock().getTime() > deadline) {
        throw new Error(`the upload finished after the ${options.timeoutMs} ms budget`);
      }

      // The confirmation. `upload` resolving means the bytes were sent; whether the
      // bucket lists them is a different question, and it is the one a restore will
      // ask. A snapshot that reached `completed` without this check is a promise made
      // from the sender's side only.
      const listed = await this.storage.list(key);
      const object = listed.find((entry) => entry.key === key);
      if (object === undefined) {
        // The upload was accepted and the bucket will not answer for it, so it is not
        // there — and what was sent is taken back, so the answer matches the bucket.
        await this.abandon([key]);
        throw new Error(`the bucket does not list ${key} after the upload (listed ${listed.length} object(s))`);
      }
      if (object.size !== size) {
        await this.abandon([key]);
        throw new Error(`the bucket lists ${key} at ${object.size} bytes, ${size} were uploaded`);
      }

      snapshot.sizeBytes = size;
      snapshot.fileCount = capture.files;
      snapshot.checksum = sha256;
      snapshot.state = 'completed';
      snapshot.completedAt = this.clock().toISOString();
      if (capture.facts !== undefined && Object.keys(capture.facts).length > 0) snapshot.facts = capture.facts;

      // The record is what makes the snapshot exist for anybody else — including
      // this manager after a restart — so it is written and confirmed before the
      // caller is told the backup succeeded.
      await this.writeRecord(snapshot);
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
    await this.sync();
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
    await this.sync();
    return this.snapshots.get(snapshotId) ?? null;
  }

  /**
   * Remove these snapshots' objects and records, and report how many went.
   *
   * One place, because the count a caller reads depends on it: deleting a base takes
   * its dependents with it, and a `prune()` that reported "1 deleted" while two
   * records disappeared would be a number nobody can reconcile with the listing.
   *
   * The **record goes first**. A record whose artefact is gone is a listing entry
   * that cannot be restored, and the listing is what an operator plans a recovery
   * from; an artefact whose record is gone is invisible bytes, which costs money and
   * cannot be mistaken for a backup. The second failure is the one to prefer, and a
   * bucket lifecycle rule is what eventually reclaims it.
   */
  private async discard(snapshots: readonly BackupMetadata[]): Promise<number> {
    let removed = 0;
    for (const snapshot of snapshots) {
      await this.storage.delete(inventoryKey(this.prefix, snapshot.snapshotId));
      await this.storage.delete(snapshot.location);
      this.snapshots.delete(snapshot.snapshotId);
      this.stamps.delete(snapshot.snapshotId);
      removed += 1;
    }
    return removed;
  }

  /** @inheritdoc */
  async deleteBackup(snapshotId: string): Promise<boolean> {
    await this.sync();
    if (!this.snapshots.has(snapshotId)) return false;
    // Dependents first: an incremental without its base is unrestorable, and a
    // failure part way through then leaves a chain that still works rather than a
    // head that cannot.
    await this.discard(expandDeletions(Array.from(this.snapshots.values()), [snapshotId]));
    return true;
  }

  /**
   * Restore a snapshot: resolve the chain, download and verify every link, and only
   * then touch the engine.
   *
   * The order is the whole method. Every check that can be made against the metadata
   * — the chain, the size, the digest — happens before an engine method is called,
   * because the one thing a rejected restore must not have done is replace half of a
   * healthy database with half of a corrupt artefact.
   *
   * **A chain is replayed, not assumed away.** An incremental is replayable only on
   * top of its ancestors, and the inventory has always been able to say which
   * ancestors those are — `resolveChain` — while this method used to hand the source
   * one file and call it a restore. For a whole-capture source that is correct and
   * stays correct (`whole: true`, one download); for a delta source it would write
   * the newest delta over a data directory as if it were a full copy, and report
   * success. So a chain of more than one artefact reaching a source that declares
   * neither a whole capture nor a chain replay is refused by name, and a source that
   * can replay one is handed every link oldest first.
   */
  async restoreFromSnapshot(snapshotId: string, options?: RestoreOptions): Promise<RestoreResult> {
    const started = Date.now();
    // The inventory first: this may be a snapshot another process took, or one this
    // process took before it restarted, and `not found` is only a true answer about
    // the bucket.
    await this.sync();
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) return { success: false, error: 'not found', durationMs: 0 };

    // One walk, two answers: what to replay and whether it may be replayed at all.
    const { chain, reason: unrestorable } = resolveChain(this.snapshots, snapshot);
    if (unrestorable !== null) return { success: false, error: unrestorable, durationMs: Date.now() - started };

    // Two questions for the source, asked once: is every artefact a whole copy, and if
    // not, can it replay a chain? A source that says "whole" is never handed a chain —
    // the newest artefact is a restore, and the ones above it are history.
    const declaresWhole = this.source.whole === true;
    const replayChain = declaresWhole ? null : (this.source.restoreChain ?? null);
    if (replayChain === null && !declaresWhole && chain.length > 1) {
      return {
        success: false,
        error:
          `snapshot ${snapshotId} needs ${chain.length} artefacts to replay and source "${this.source.name}" ` +
          'can neither replay a chain nor declare itself whole',
        durationMs: Date.now() - started,
      };
    }

    const links = replayChain === null ? [snapshot] : chain;
    const staged: string[] = [];
    try {
      await mkdir(this.workDir, { recursive: true });
      for (const link of links) {
        const path = join(this.workDir, `${link.snapshotId}.restore.artifact`);
        staged.push(path);
        await this.storage.download(link.location, path);
        const wrong = await this.verifyArtefact(link, path, options);
        if (wrong !== null) return { success: false, error: wrong, durationMs: Date.now() - started };
      }

      if (replayChain === null) {
        await this.source.restore(staged[staged.length - 1]!);
      } else {
        // `call` rather than a bare reference: the source's own `this` has to travel
        // with it, and a destructured method would arrive detached.
        await replayChain.call(this.source, staged);
      }
      return { success: true, recoveryPoint: snapshotId, artefacts: links.length, durationMs: Date.now() - started };
    } catch (error) {
      return { success: false, error: reason(error), durationMs: Date.now() - started };
    } finally {
      for (const path of staged) await removeQuietly(path);
    }
  }

  /**
   * Why the artefact at `path` is not the one `snapshot` describes, or `null` when it
   * is.
   *
   * Names the snapshot in both messages because a chain restore verifies several
   * artefacts and "the artefact is 20 bytes" does not say which one was wrong.
   */
  private async verifyArtefact(
    snapshot: BackupMetadata,
    path: string,
    options?: RestoreOptions,
  ): Promise<string | null> {
    const { size } = await stat(path);
    if (size !== snapshot.sizeBytes) {
      return `the artefact of ${snapshot.snapshotId} is ${size} bytes, the snapshot recorded ${snapshot.sizeBytes}`;
    }
    if (options?.skipVerification === true || snapshot.checksum === undefined) return null;

    const { sha256 } = await hashFile(path);
    if (sha256 === snapshot.checksum) return null;
    return (
      `the artefact of ${snapshot.snapshotId} does not match the snapshot's digest ` +
      `(${sha256.slice(0, 12)}… ≠ ${snapshot.checksum.slice(0, 12)}…)`
    );
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
    await this.sync();
    if (target.snapshotId !== undefined) return this.restoreFromSnapshot(target.snapshotId, options);

    const completed = Array.from(this.snapshots.values()).filter((s) => s.state === 'completed');

    if (target.targetTime !== undefined) {
      const boundary = new Date(target.targetTime).getTime();
      if (Number.isNaN(boundary)) {
        return { success: false, error: `targetTime ${target.targetTime} is not a date`, durationMs: 0 };
      }
      const candidates = completed.filter((s) => new Date(s.createdAt).getTime() <= boundary);
      const chosen = this.newest(
        candidates,
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
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
      const chosen = this.newest(candidates, (a, b) => compareLsn(b.facts!['lsn']!, a.facts!['lsn']!));
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
   * The newest candidate under `newer`, with a tie broken by depth and then by id.
   *
   * A tie is not hypothetical. `createBackup` stamps `createdAt` from the manager's clock,
   * so two incrementals taken inside one millisecond share a timestamp — and two snapshots
   * that recorded the same `lsn` are exactly as close. A plain sort decides those by
   * whatever order the bucket listed them in, and the *older* candidate comes first there,
   * so a caller asking for "the newest at or before T" would be handed the base of a chain
   * whose head is also at T and be told that is the recovery point. Depth — the number of
   * artefacts it takes to replay the snapshot — is the tie-break that means "more history
   * replayed", and the id makes the answer total.
   *
   * `createBackup` does not need this and does not use it: any completed snapshot is a
   * valid parent for a delta, and picking the shallower one costs a re-recorded file
   * rather than a recovery point that is older than it says.
   */
  private newest(
    candidates: readonly BackupMetadata[],
    newer: (a: BackupMetadata, b: BackupMetadata) => number,
  ): BackupMetadata | undefined {
    const ranked = candidates.map((snapshot) => ({
      snapshot,
      depth: resolveChain(this.snapshots, snapshot).chain.length,
    }));
    ranked.sort((a, b) => {
      const byAge = newer(a.snapshot, b.snapshot);
      if (byAge !== 0) return byAge;
      if (a.depth !== b.depth) return b.depth - a.depth;
      return a.snapshot.snapshotId.localeCompare(b.snapshot.snapshotId);
    });
    return ranked[0]?.snapshot;
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
    await this.sync();
    const inventory = Array.from(this.snapshots.values());
    const named = this.retention.evaluate(inventory).map((snapshot) => snapshot.snapshotId);
    return this.discard(expandDeletions(inventory, named));
  }
}
