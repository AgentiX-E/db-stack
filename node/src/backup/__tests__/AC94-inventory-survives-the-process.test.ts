/**
 * AC 94 — a backup outlives the process that took it.
 *
 * The defect this file answers was found while writing the mutation survivors' cases
 * of iteration 63: a second `BackupManager` over the same bucket answered `not found`
 * for a snapshot the first one had just written. The class was right in every other
 * respect — it captured, hashed, uploaded, confirmed — and the one thing that could
 * name the result was a `Map` on the instance. Kill the process and the bytes are in
 * the bucket, the digest that proves them is in the bucket, and nothing in the bucket
 * says they are a snapshot.
 *
 * This is not a hypothetical. A backup is a thing that has to be restorable by the
 * binary that is running *after* the crash it exists for; a manager whose inventory
 * is its own heap is a backup system that works only until it is needed.
 *
 * The fix is one immutable record per snapshot under `<prefix>/inventory/`, written
 * after the artefact is confirmed and read back by every public method. What each case
 * below is for:
 *
 *   The record
 *     IV.1  a backup writes a record beside the artefact, at the key the id derives
 *     IV.2  the record carries the whole snapshot, not a summary of it
 *     IV.3  the record is written *after* the artefact it names
 *     IV.4  a bucket that will not keep the record makes the backup a failure
 *
 *   A different process
 *     IV.5  a second manager lists what the first one took, field for field
 *     IV.6  a second manager restores it, and the engine gets the captured bytes
 *     IV.7  a second manager rebuilds the chain, so an incremental is restorable
 *     IV.8  deleting the base in the second manager takes the child with it
 *     IV.9  `prune()` in the second manager removes both halves of each snapshot
 *     IV.10 `pitr(targetTime)` in a fresh manager resolves against another's snapshots
 *     IV.11 a restore in a fresh manager still checks the digest
 *     IV.12 a record is write-once: listing it again leaves the bytes alone
 *
 *   The bucket is the inventory
 *     IV.13 a snapshot deleted elsewhere stops being listed here
 *     IV.14 a snapshot taken elsewhere starts being listed here, without a restart
 *     IV.15 a record deleted out of band is a snapshot that is gone
 *     IV.16 an empty bucket is an empty listing, not an error
 *
 *   Damage
 *     IV.17 a record that is not JSON is reported, and does not stop the next backup
 *     IV.18 a record that names another snapshot is damage, and says so
 *     IV.19 a record missing a field is damage, and names the field
 *     IV.20 the hydrate is bounded, so a bucket with a hundred records is not a hundred
 *           sequential downloads
 *     IV.21 a record is never written for a snapshot the bucket does not hold
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { INVENTORY_FORMAT, inventoryKey, parseRecord, serializeRecord } from '../impl/inventory.js';
import type { IStorageBackend } from '../interfaces/index.js';
import type { BackupMetadata, RetentionPolicy } from '../../core/types.js';

let root: string;
let dataDir: string;
let restoreDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

/** A manager over the shared bucket, capturing `dataDir` and restoring into `target`. */
function manager(
  target: string,
  options: { retention?: RetentionPolicy; source?: string; clock?: () => Date } = {},
): BackupManager {
  return new BackupManager(
    new DirectoryBackupSource(options.source ?? target),
    storage,
    new RetentionPolicyEvaluator(options.retention ?? { maxFullSnapshots: 100, maxTotalBytes: 0 }),
    { workDir, ...(options.clock === undefined ? {} : { clock: options.clock }) },
  );
}

/** A clock that moves a millisecond per call, so "newest" is a fact rather than a tie. */
function ticking(start = Date.UTC(2026, 10, 21, 12, 0, 0)): () => Date {
  let at = start;
  return () => {
    at += 1;
    return new Date(at);
  };
}

/** The bucket, with one method replaced and the rest still real. */
function passthrough(overrides: Partial<IStorageBackend>): IStorageBackend {
  return {
    name: 'passthrough',
    upload: storage.upload.bind(storage),
    download: storage.download.bind(storage),
    list: storage.list.bind(storage),
    delete: storage.delete.bind(storage),
    health: storage.health.bind(storage),
    getUsageBytes: storage.getUsageBytes.bind(storage),
    ...overrides,
  };
}

/** Put arbitrary bytes in the bucket, the way another process or a person would. */
async function put(key: string, body: string): Promise<void> {
  const path = join(root, `put-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, body);
  await storage.upload(path, key);
}

async function text(key: string): Promise<string> {
  const path = join(root, `get-${Math.random().toString(36).slice(2)}`);
  await storage.download(key, path);
  return readFileSync(path, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac94-'));
  dataDir = join(root, 'data');
  restoreDir = join(root, 'restore');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha-rows');
  writeFileSync(join(dataDir, 'wal.log'), 'lsn 0/1');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AC 94 — the record', () => {
  it('IV.1: a backup writes a record beside the artefact, at the key its id derives', async () => {
    const first = manager(dataDir);
    const { snapshot } = await first.createBackup({ type: 'full' });

    const key = inventoryKey('backups', snapshot!.snapshotId);
    expect(key).toBe(`backups/inventory/${snapshot!.snapshotId}.json`);
    const keys = (await storage.list('backups/')).map((object) => object.key).sort();
    expect(keys).toEqual([`backups/full/${snapshot!.snapshotId}.artifact`, key]);
  });

  it('IV.2: the record carries the whole snapshot, not a summary of it', async () => {
    const first = manager(dataDir);
    const { snapshot } = await first.createBackup({ type: 'full' });

    const parsed = JSON.parse(await text(inventoryKey('backups', snapshot!.snapshotId))) as {
      format: string;
      snapshot: BackupMetadata;
    };
    expect(parsed.format).toBe(INVENTORY_FORMAT);
    // Field for field, because every one of them is used by some decision: a caller
    // that had to re-derive one from the artefact would be reimplementing the format.
    expect(parsed.snapshot).toEqual(snapshot);
    expect(parsed.snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.snapshot.facts).toEqual({
      'dir.files': '2',
      'dir.bytes': String('alpha-rows'.length + 'lsn 0/1'.length),
    });
  });

  it('IV.3: the record is written after the artefact it names', async () => {
    const writes: string[] = [];
    const backend = passthrough({
      upload: async (sourcePath: string, destKey: string) => {
        writes.push(destKey);
        await storage.upload(sourcePath, destKey);
      },
    });
    const first = new BackupManager(
      new DirectoryBackupSource(dataDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const { snapshot } = await first.createBackup({ type: 'full' });
    // The artefact first, because a record that names an object that is not there is
    // the exact lie the next process would act on.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(snapshot!.location);
    expect(writes[1]).toBe(inventoryKey('backups', snapshot!.snapshotId));
  });

  it('IV.4: a bucket that will not keep the record makes the backup a failure', async () => {
    const backend = passthrough({
      upload: async (sourcePath: string, destKey: string) => {
        if (destKey.endsWith('.json')) throw new Error('the bucket is read-only for records');
        await storage.upload(sourcePath, destKey);
      },
    });
    const first = new BackupManager(
      new DirectoryBackupSource(dataDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const result = await first.createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inventory record backups\/inventory\/snap-.+\.json: the bucket is read-only/);
    // And nothing anywhere claims otherwise: the artefact is in the bucket, and no
    // manager — this one or a fresh one — lists a snapshot for it.
    expect(await first.listBackups()).toEqual([]);
    expect(await manager(restoreDir).listBackups()).toEqual([]);
    expect((await storage.list('backups/')).map((o) => o.key).filter((k) => k.endsWith('.json'))).toEqual([]);
  });

  it('IV.22: a record the bucket does not list is a backup that did not happen', async () => {
    // The artefact confirms; the record does not. A manager that returned success here
    // would be announcing a snapshot that only this process can name.
    const backend = passthrough({
      // Invisible to the confirmation *and* to the hydrate: the bucket accepted the
      // record and will not list it, which is the failure an eventually-consistent
      // store or a wrong prefix produces.
      list: async (prefix: string) => (prefix.includes('/inventory/') ? [] : storage.list(prefix)),
    });
    const first = new BackupManager(
      new DirectoryBackupSource(dataDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const result = await first.createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inventory record backups\/inventory\/snap-.+\.json: the bucket does not list it/);
    expect(await first.listBackups()).toEqual([]);
    // Nothing was left behind: the artefact went back too, because an artefact no
    // record names is not a backup and nobody will ever name it.
    expect(await storage.list('backups/')).toEqual([]);
  });

  it('IV.23: a record the bucket lists at another size is a backup that did not happen', async () => {
    const backend = passthrough({
      list: async (prefix: string) =>
        (await storage.list(prefix)).map((object) =>
          object.key.endsWith('.json') ? { ...object, size: object.size + 1 } : object,
        ),
    });
    const first = new BackupManager(
      new DirectoryBackupSource(dataDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const result = await first.createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inventory record backups\/inventory\/snap-.+\.json: the bucket lists \d+ bytes/);
    expect(await first.listBackups()).toEqual([]);
    expect(await storage.list('backups/')).toEqual([]);
  });
});

describe('AC 94 — a different process', () => {
  it('IV.5: a second manager lists what the first one took, field for field', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });

    // Nothing is shared with `second` except the bucket: it is constructed after the
    // snapshot exists and has never seen it.
    const second = manager(restoreDir);
    expect(await second.listBackups()).toEqual([created.snapshot]);
    expect(await second.getBackup(created.snapshot!.snapshotId)).toEqual(created.snapshot);
  });

  it('IV.6: a second manager restores it, and the engine gets the captured bytes', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });

    const second = manager(restoreDir);
    const result = await second.restoreFromSnapshot(created.snapshot!.snapshotId);

    expect(result).toMatchObject({ success: true, recoveryPoint: created.snapshot!.snapshotId });
    expect(readFileSync(join(restoreDir, 'table.bin'), 'utf8')).toBe('alpha-rows');
    expect(readFileSync(join(restoreDir, 'wal.log'), 'utf8')).toBe('lsn 0/1');
  });

  it('IV.7: a second manager rebuilds the chain, so an incremental is restorable', async () => {
    const first = manager(dataDir);
    const base = await first.createBackup({ type: 'full' });
    const child = await first.createBackup({ type: 'incremental' });
    expect(child.snapshot!.parentSnapshotId).toBe(base.snapshot!.snapshotId);

    // The parent link travelled in the record; nothing about it was remembered here.
    const second = manager(restoreDir);
    expect(await second.getBackup(child.snapshot!.snapshotId)).toMatchObject({
      parentSnapshotId: base.snapshot!.snapshotId,
    });
    expect(await second.restoreFromSnapshot(child.snapshot!.snapshotId)).toMatchObject({ success: true });
  });

  it('IV.8: deleting the base in the second manager takes the child with it', async () => {
    const first = manager(dataDir);
    const base = await first.createBackup({ type: 'full' });
    const child = await first.createBackup({ type: 'incremental' });

    const second = manager(restoreDir);
    expect(await second.deleteBackup(base.snapshot!.snapshotId)).toBe(true);

    // Both halves went, in the bucket and in the listing the first manager now reads.
    expect(await storage.list('backups/')).toEqual([]);
    expect(await first.listBackups()).toEqual([]);
    expect(await first.getBackup(child.snapshot!.snapshotId)).toBeNull();
    expect(await second.restoreFromSnapshot(child.snapshot!.snapshotId)).toMatchObject({
      success: false,
      error: 'not found',
    });
  });

  it('IV.9: prune in the second manager removes both halves of each snapshot', async () => {
    // Distinct timestamps, because "keep the newest" is a comparison and three
    // snapshots created inside one millisecond are three snapshots at the same time.
    const first = manager(dataDir, {
      retention: { maxFullSnapshots: 1, maxTotalBytes: 0 },
      clock: ticking(),
    });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push((await first.createBackup({ type: 'full' })).snapshot!.snapshotId);
    }

    const second = manager(restoreDir, { retention: { maxFullSnapshots: 1, maxTotalBytes: 0 } });
    expect(await second.prune()).toBe(2);
    // A prune that had removed only the artefacts would leave two records naming
    // objects that are gone; one that had removed only the records would leave two
    // artefacts nobody can name. Neither is a bucket a person can reason about.
    expect((await storage.list('backups/')).map((o) => o.key).sort()).toEqual([
      `backups/full/${ids[2]}.artifact`,
      `backups/inventory/${ids[2]}.json`,
    ]);
    expect(await first.listBackups()).toHaveLength(1);
  });

  it('IV.10: pitr by time in a fresh manager resolves against another process’s snapshots', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    const at = new Date(Date.parse(created.snapshot!.createdAt) + 60_000).toISOString();

    const second = manager(restoreDir);
    const result = await second.pitr({ targetTime: at });
    expect(result).toMatchObject({ success: true, recoveryPoint: created.snapshot!.snapshotId });
    // And a target before every snapshot is refused rather than answered with one.
    const before = new Date(Date.parse(created.snapshot!.createdAt) - 60_000).toISOString();
    expect(await second.pitr({ targetTime: before })).toMatchObject({
      success: false,
      error: `no snapshot at or before ${before}`,
    });
  });

  it('IV.11: a restore in a fresh manager still checks the digest', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });

    // The same key, the same length, different bytes — what a corrupted object looks
    // like to everything except a digest.
    const local = join(root, 'replacement.bin');
    writeFileSync(local, Buffer.alloc(created.snapshot!.sizeBytes, 0x41));
    await storage.upload(local, created.snapshot!.location);

    const second = manager(restoreDir);
    const result = await second.restoreFromSnapshot(created.snapshot!.snapshotId);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not match the snapshot's digest/);
  });

  it('IV.12: a record is write-once — listing it again leaves the bytes alone', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    const key = inventoryKey('backups', created.snapshot!.snapshotId);
    const before = await text(key);

    await manager(restoreDir).listBackups();
    await manager(restoreDir).listBackups();
    expect(await text(key)).toBe(before);
    // And the bucket still holds exactly two objects: a second manager that rewrote
    // the record would be a second writer, which is what the per-snapshot key exists
    // to prevent.
    expect(await storage.list('backups/')).toHaveLength(2);
  });
});

describe('AC 94 — the bucket is the inventory', () => {
  it('IV.13: a snapshot deleted elsewhere stops being listed here', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    expect(await first.listBackups()).toHaveLength(1);

    await manager(restoreDir).deleteBackup(created.snapshot!.snapshotId);
    // No restart, no refresh call: the next listing is a listing of the bucket.
    expect(await first.listBackups()).toEqual([]);
    expect(await first.getBackup(created.snapshot!.snapshotId)).toBeNull();
  });

  it('IV.14: a snapshot taken elsewhere starts being listed here, without a restart', async () => {
    const second = manager(restoreDir);
    expect(await second.listBackups()).toEqual([]);

    const created = await manager(dataDir).createBackup({ type: 'full' });
    expect(await second.listBackups()).toEqual([created.snapshot]);
  });

  it('IV.15: a record deleted out of band is a snapshot that is gone', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    await storage.delete(inventoryKey('backups', created.snapshot!.snapshotId));

    expect(await first.listBackups()).toEqual([]);
    // The artefact is still there — that is the price of deleting the record first,
    // and it is the cheaper half of the trade: bytes nobody lists cannot be restored
    // *from*, and cannot be mistaken for a backup *for*.
    expect((await storage.list('backups/')).map((o) => o.key)).toEqual([created.snapshot!.location]);
  });

  it('IV.16: an empty bucket is an empty listing, not an error', async () => {
    const first = manager(dataDir);
    expect(await first.listBackups()).toEqual([]);
    expect(await first.getBackup('snap-nothing')).toBeNull();
    expect(await first.deleteBackup('snap-nothing')).toBe(false);
    expect(await first.prune()).toBe(0);
    expect(first.inventoryProblems()).toEqual([]);
  });
});

describe('AC 94 — damage', () => {
  it('IV.17: a record that is not JSON is reported, and does not stop the next backup', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });

    // A truncated object: what a half-finished copy or a bad restore leaves behind.
    // It is rewritten in place under a key this manager already knows, so what makes
    // it visible at all is the listing's stamp — size and last-modified — having moved.
    const key = inventoryKey('backups', created.snapshot!.snapshotId);
    await put(key, '{"format":"db-node/backup/inventory/v1","snapsh');

    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()).toHaveLength(1);
    expect(first.inventoryProblems()[0]!.key).toBe(key);
    expect(first.inventoryProblems()[0]!.reason).toMatch(/not JSON/);

    // A damaged record is one snapshot lost, not a backup system that stops: the next
    // backup is taken and listed, and the problem is still on the record for an
    // operator to act on.
    const next = await first.createBackup({ type: 'full' });
    expect(next.success).toBe(true);
    expect(await first.listBackups()).toHaveLength(1);
    expect(first.inventoryProblems()).toHaveLength(1);
  });

  it('IV.18: a record that names another snapshot is damage, and says so', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    const key = inventoryKey('backups', created.snapshot!.snapshotId);
    const moved = { ...created.snapshot!, snapshotId: 'snap-somewhere-else' };
    await put(key, serializeRecord(moved));

    expect(await first.listBackups()).toEqual([]);
    // The key is the identity; a record that disagrees with it was copied or renamed,
    // and trusting either half is a coin toss.
    expect(first.inventoryProblems()[0]!.reason).toMatch(
      /this record names snap-somewhere-else, not the snapshot its key names/,
    );
  });

  it('IV.19: a record missing a field is damage, and names the field', async () => {
    const first = manager(dataDir);
    const created = await first.createBackup({ type: 'full' });
    const key = inventoryKey('backups', created.snapshot!.snapshotId);

    const { location: _location, ...withoutLocation } = created.snapshot!;
    await put(key, JSON.stringify({ format: INVENTORY_FORMAT, snapshot: withoutLocation }));

    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()[0]!.reason).toMatch(/the snapshot has no location/);
  });

  it('IV.20: the hydrate is bounded, so a hundred records are not a hundred sequential reads', async () => {
    const first = manager(dataDir);
    const ids: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      ids.push((await first.createBackup({ type: 'full' })).snapshot!.snapshotId);
    }

    let inFlight = 0;
    let peak = 0;
    const backend = passthrough({
      download: async (sourceKey: string, destPath: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // A bucket has latency; without it the pool would never be more than one deep
        // and the bound would be untested in the direction that matters.
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          await storage.download(sourceKey, destPath);
        } finally {
          inFlight -= 1;
        }
      },
    });
    const second = new BackupManager(
      new DirectoryBackupSource(restoreDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    expect(await second.listBackups()).toHaveLength(24);
    // Parallel, and bounded: not one at a time, and not one connection per record.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('IV.21: a record is never written for a snapshot the bucket does not hold', async () => {
    const backend = passthrough({
      // The artefact's confirmation is what fails here: the upload is accepted and the
      // listing does not show it.
      list: async (prefix: string) => (prefix.endsWith('.artifact') ? [] : storage.list(prefix)),
    });
    const first = new BackupManager(
      new DirectoryBackupSource(dataDir),
      backend,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
      { workDir },
    );

    const result = await first.createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/the bucket does not list backups\/full\/snap-.+\.artifact after the upload/);
    // Not even bytes: what the bucket would not confirm, the manager took back.
    expect(await storage.list('backups/')).toEqual([]);
  });
});
