/**
 * AC 99 — what the inventory read costs, and what it leaves behind.
 *
 * `AC 94` asks whether the listing is *right*. This file asks the two questions a
 * correct listing can still fail: how many requests it makes, and what it leaves on
 * disk afterwards. Both are invisible in an assertion about `snapshotId`, which is
 * exactly why they need their own cases — a manager that issued one listing per call
 * and one download per record per call would pass every case in `AC 94` and be
 * unusable against a bucket with a thousand snapshots.
 *
 *   DU.1  a burst of concurrent reads costs one listing
 *   DU.2  a second listing does not re-download what the first one read
 *   DU.3  a file under the inventory prefix that is not a record is not a snapshot
 *   DU.4  a record fixed in place stops being a problem
 *   DU.5  a record deleted after being reported stops being reported
 *   DU.6  reading the inventory leaves no scratch file behind
 *   DU.7  a chain whose base record was deleted out of band is refused, and says how long it took
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { inventoryKey, serializeRecord } from '../impl/inventory.js';
import type { IStorageBackend } from '../interfaces/index.js';

let root: string;
let dataDir: string;
let restoreDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

function manager(backend: IStorageBackend = storage, work = workDir): BackupManager {
  return new BackupManager(
    new DirectoryBackupSource(dataDir),
    backend,
    new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
    { workDir: work },
  );
}

/** The bucket, with the named methods counted and everything else real. */
function counted(): { backend: IStorageBackend; calls: { list: string[]; download: string[] } } {
  const calls = { list: [] as string[], download: [] as string[] };
  const backend: IStorageBackend = {
    name: 'counted',
    upload: storage.upload.bind(storage),
    download: async (key, destination) => {
      calls.download.push(key);
      await storage.download(key, destination);
    },
    list: async (prefix) => {
      calls.list.push(prefix);
      return storage.list(prefix);
    },
    delete: storage.delete.bind(storage),
    health: storage.health.bind(storage),
    getUsageBytes: storage.getUsageBytes.bind(storage),
  };
  return { backend, calls };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac99-'));
  dataDir = join(root, 'data');
  restoreDir = join(root, 'restore');
  workDir = join(root, 'work');
  for (const dir of [dataDir, restoreDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha-rows');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AC 99 — what the inventory read costs', () => {
  it('DU.1: a burst of concurrent reads costs one listing', async () => {
    await manager().createBackup({ type: 'full' });
    const { backend, calls } = counted();
    const second = manager(backend);

    // Five callers at once is what a dashboard polling three panels plus a health
    // check looks like. One listing serves all of them: the slot is shared while the
    // read is in flight and cleared when it settles.
    await Promise.all([
      second.listBackups(),
      second.listBackups(),
      second.getBackup('x'),
      second.prune(),
      second.listBackups(),
    ]);
    const inventoryListings = calls.list.filter((prefix) => prefix === 'backups/inventory/');
    expect(inventoryListings).toHaveLength(1);

    // And the next call lists again, because a cached listing is a manager that is
    // wrong about a snapshot somebody else took a second ago.
    await second.listBackups();
    expect(calls.list.filter((prefix) => prefix === 'backups/inventory/')).toHaveLength(2);
  });

  it('DU.2: a second listing does not re-download what the first one read', async () => {
    const first = manager();
    for (let index = 0; index < 3; index += 1) await first.createBackup({ type: 'full' });

    const { backend, calls } = counted();
    const second = manager(backend);
    expect(await second.listBackups()).toHaveLength(3);
    const loaded = calls.download.length;
    expect(loaded).toBe(3);

    for (let index = 0; index < 3; index += 1) await second.listBackups();
    // The listing's stamp — size and last-modified — is what a record is compared
    // against, so three more listings cost three listings and no downloads.
    expect(calls.download.length).toBe(loaded);
  });

  it('DU.3: a file under the inventory prefix that is not a record is not a snapshot', async () => {
    const first = manager();
    const created = await first.createBackup({ type: 'full' });

    // A person leaving a note next to the records, or a bucket tool writing a marker.
    const note = join(root, 'notes.txt');
    writeFileSync(note, 'do not delete these');
    await storage.upload(note, 'backups/inventory/README.txt');

    const listed = await first.listBackups();
    expect(listed.map((snapshot) => snapshot.snapshotId)).toEqual([created.snapshot!.snapshotId]);
    // Not a snapshot, and not a problem either: it is not a record, so there is
    // nothing about it to report.
    expect(first.inventoryProblems()).toEqual([]);
  });

  it('DU.6: reading the inventory leaves no scratch file behind', async () => {
    const first = manager();
    await first.createBackup({ type: 'full' });

    // A fresh manager has to download the record to read it, and the download lands
    // somewhere. Somewhere is a scratch directory, and the scratch is not a place
    // where a hundred records accumulate.
    const second = manager(storage, join(root, 'work-second'));
    expect(await second.listBackups()).toHaveLength(1);
    expect(readdirSync(join(root, 'work-second'))).toEqual([]);
  });
});

describe('AC 99 — damage that is repaired, and a chain that is not', () => {
  it('DU.4: a record fixed in place stops being a problem', async () => {
    const first = manager();
    const created = await first.createBackup({ type: 'full' });
    const key = inventoryKey('backups', created.snapshot!.snapshotId);

    const broken = join(root, 'broken.json');
    writeFileSync(broken, '{"format":"db-node/backup/inventory/v1","snap');
    await storage.upload(broken, key);

    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()).toHaveLength(1);

    // Reported on every listing, not just the one that discovered it: the record has
    // not changed, so nothing has changed about the fact that it cannot be read.
    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()).toHaveLength(1);

    // Somebody restores the object from a replica, or fixes the field. The next
    // listing reads it again — because the listing's stamp moved — and the problem
    // is gone rather than reported forever.
    const fixed = join(root, 'fixed.json');
    writeFileSync(
      fixed,
      JSON.stringify({ format: 'db-node/backup/inventory/v1', snapshot: { ...created.snapshot, sizeBytes: 1 } }),
    );
    await storage.upload(fixed, key);

    expect(await first.listBackups()).toHaveLength(1);
    expect(first.inventoryProblems()).toEqual([]);
    expect((await first.getBackup(created.snapshot!.snapshotId))!.sizeBytes).toBe(1);
  });

  it('DU.5: a record deleted after being reported stops being reported', async () => {
    const first = manager();
    const created = await first.createBackup({ type: 'full' });
    const key = inventoryKey('backups', created.snapshot!.snapshotId);

    const broken = join(root, 'broken.json');
    writeFileSync(broken, 'not JSON at all');
    await storage.upload(broken, key);
    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()).toHaveLength(1);

    // The remedy for a damaged record is to delete it, and a problem list that kept
    // naming a key nobody can find would send an operator after nothing.
    await storage.delete(key);
    expect(await first.listBackups()).toEqual([]);
    expect(first.inventoryProblems()).toEqual([]);
  });

  it('DU.7: a chain whose base record was deleted out of band is refused, and says how long it took', async () => {
    const first = manager();
    const base = await first.createBackup({ type: 'full' });
    const child = await first.createBackup({ type: 'incremental' });

    // Not through `deleteBackup`, which cascades — somebody deleted the base's record
    // and its object by hand, which is what a bucket console is for.
    await storage.delete(inventoryKey('backups', base.snapshot!.snapshotId));
    await storage.delete(base.snapshot!.location);

    const second = manager();
    expect(await second.listBackups()).toHaveLength(1);

    const refused = await second.restoreFromSnapshot(child.snapshot!.snapshotId);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/cannot be replayed|missing|no longer/i);
    // `durationMs` is elapsed time on this path too — `Date.now() + started` produces
    // a number a thousand times larger than any run of this test can take.
    expect(refused.durationMs).toBeGreaterThanOrEqual(0);
    expect(refused.durationMs).toBeLessThan(60_000);
  });
});

describe('AC 99 — a snapshot that is not a recovery point', () => {
  it('DU.8: pitr never chooses a snapshot whose state is not completed', async () => {
    const first = manager();
    const oldest = await first.createBackup({ type: 'full' });

    // A record someone wrote, or a future tool writes: it is in the bucket, it names a
    // real artefact, and it says the snapshot failed. A recovery point has to be a
    // snapshot that finished.
    const broken: typeof oldest.snapshot = {
      ...oldest.snapshot!,
      snapshotId: 'snap-failed',
      state: 'failed',
      createdAt: new Date(Date.parse(oldest.snapshot!.createdAt) + 60_000).toISOString(),
    };
    const path = join(root, 'failed.json');
    writeFileSync(path, serializeRecord(broken));
    await storage.upload(path, inventoryKey('backups', 'snap-failed'));

    const second = manager();
    expect(await second.listBackups()).toHaveLength(2);

    // The failed one is newer, and it is still not a candidate.
    const target = new Date(Date.parse(broken.createdAt) + 60_000).toISOString();
    expect(await second.pitr({ targetTime: target })).toMatchObject({
      success: true,
      recoveryPoint: oldest.snapshot!.snapshotId,
    });

    // With only the failed one before the target, there is no recovery point at all.
    const early = new Date(Date.parse(oldest.snapshot!.createdAt) - 60_000).toISOString();
    expect(await second.pitr({ targetTime: early })).toMatchObject({
      success: false,
      error: `no snapshot at or before ${early}`,
    });
  });
});
