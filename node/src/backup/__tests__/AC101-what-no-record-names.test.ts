/**
 * AC 101 — the bytes no record names, and the records no bytes answer for.
 *
 * `createBackup` produces a snapshot in two halves: an artefact the bucket holds and a
 * record that names it. Deleting takes them in the opposite order on purpose — the record
 * first, so a listing never names something that cannot be restored — and the price of
 * that order is the one state this package could not see: a delete that fails between the
 * two steps leaves an object no record names. Invisible, billed, unrestorable, and
 * impossible to find without listing the bucket and comparing it with the inventory.
 *
 * `reconcile()` is that comparison. What each case is for:
 *
 *   RC.1  the roadmap's case: a delete that fails after the record went is reported, and
 *         nothing lists it as a snapshot
 *   RC.2  `reclaim` deletes it, and the next reconcile has nothing to say
 *   RC.3  an object younger than the grace window is a backup in progress, and reclaim
 *         leaves it alone
 *   RC.4  a record whose artefact is gone is reported — the mirror image, and the worse one
 *   RC.5  a record that cannot be read still protects its artefact
 *   RC.6  an object this package never named is still an object no record names
 *   RC.7  an object whose age cannot be read is not reclaimed; the window is configurable
 *   RC.8  a clean bucket produces an empty report, and a report alone deletes nothing
 *   RC.9  the report is ordered by key, not by whatever the backend listed first
 *   RC.10 a reclaim whose delete fails reports it again next time, and counts what went
 *   RC.11 a failed tidy does not replace the reason a backup failed
 *   RC.12 an object outside this manager's prefix is not this manager's business
 *   RC.13 a record names its artefact by `location`, whatever the object is called
 *   RC.14 the grace window's boundary: exactly `graceMs` old is garbage, a millisecond
 *         younger is a backup in progress
 *   RC.15 both halves of the report are in key order, not just the orphans
 *   RC.16 a damaged record is still reported after the listing is read again
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupManager, RECONCILE_GRACE_MS, type ReconcileReport } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { inventoryKey, serializeRecord } from '../impl/inventory.js';
import type { IStorageBackend } from '../interfaces/index.js';
import type { BackupMetadata } from '../../core/types.js';

let root: string;
let dataDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac101-'));
  dataDir = join(root, 'data');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha-rows');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A manager over a given view of the bucket, reading the clock the test chooses. */
function managerOver(backend: IStorageBackend, clock?: () => Date): BackupManager {
  return new BackupManager(
    new DirectoryBackupSource(dataDir),
    backend,
    new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
    clock === undefined ? { workDir } : { workDir, clock },
  );
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

/** The same objects, all of them `ms` older than the backend reports; other behaviour is a parameter. */
function ago(ms: number, overrides: Partial<IStorageBackend> = {}): IStorageBackend {
  return passthrough({
    list: async (prefix) =>
      (await storage.list(prefix)).map((entry) => ({
        ...entry,
        lastModified: new Date(Date.now() - ms).toISOString(),
      })),
    ...overrides,
  });
}

/** Put arbitrary bytes in the bucket, the way another process or a person would. */
async function put(key: string, body: string): Promise<void> {
  const path = join(root, `put-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, body);
  await storage.upload(path, key);
}

/** One completed backup, returned with the manager that took it. */
async function backup(): Promise<{ snapshot: BackupMetadata; manager: BackupManager }> {
  const manager = managerOver(storage);
  const result = await manager.createBackup({ type: 'full' });
  expect(result.success).toBe(true);
  return { snapshot: result.snapshot!, manager };
}

describe('AC 101 — reconcile reports what no record names', () => {
  it('RC.1: a delete that fails after the record went leaves an orphan, not a snapshot', async () => {
    // The exact case the roadmap names. The record is removed first, so a listing never
    // offers a snapshot that cannot be restored; the artefact delete then fails, and what
    // is left is bytes that cost money and belong to no backup. Before `reconcile` the
    // only way to find them was to list the bucket by hand and compare it with the
    // inventory.
    const { snapshot, manager } = await backup();
    const refusing = passthrough({
      delete: async (key) => {
        if (key.includes('/inventory/')) return storage.delete(key);
        throw new Error('Access Denied');
      },
    });
    await expect(managerOver(refusing).deleteBackup(snapshot.snapshotId)).rejects.toThrow(/Access Denied/);

    // An hour later, from a process that never saw the delete: the bucket holds the
    // artefact and no record.
    const report = await managerOver(ago(RECONCILE_GRACE_MS + 3_600_000)).reconcile();
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0]).toMatchObject({ key: snapshot.location, snapshotId: snapshot.snapshotId });
    expect(report.orphaned[0]!.size).toBeGreaterThan(0);
    expect(report.inFlight).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.reclaimed).toBe(0);

    // And nothing lists it as a snapshot: the report is the only place it appears.
    expect(await managerOver(storage).listBackups()).toEqual([]);
    expect(manager.inventoryProblems()).toEqual([]);
  });

  it('RC.2: `reclaim` deletes the orphan, and the next reconcile has nothing to say', async () => {
    const { snapshot, manager } = await backup();
    await manager.deleteBackup(snapshot.snapshotId);
    // The ordinary path is clean: the delete removed both halves.
    expect((await managerOver(storage).reconcile()).orphaned).toEqual([]);

    // Now the failed half of one, by hand: put the artefact back with no record beside it.
    await put(`${snapshot.location}`, 'half a backup');
    const aged = ago(RECONCILE_GRACE_MS + 60_000);
    const before = await managerOver(aged).reconcile();
    expect(before.orphaned).toHaveLength(1);

    const after = await managerOver(aged).reconcile({ reclaim: true });
    expect(after.reclaimed).toBe(1);
    expect(after.orphaned).toHaveLength(1); // what it found, not what is left
    expect((await managerOver(aged).reconcile()).orphaned).toEqual([]);
    expect(await storage.getUsageBytes()).toBe(0);
  });

  it('RC.3: an object younger than the grace window is a backup in progress', async () => {
    // `createBackup` uploads and then records, so during that window there is an object
    // no record names — and it is the backup the caller is waiting for. Age is the only
    // thing that separates the two states, and reclaiming on the wrong side of it deletes
    // a backup that was about to exist.
    await backup();
    // A *new* key: the artefact of a snapshot whose record has not been written yet. The
    // artefact of an existing snapshot would not be an orphan at all, and the case would
    // pass without testing the window.
    const inProgress = 'backups/full/snap-in-progress.artifact';
    await put(inProgress, 'uploaded, not yet recorded');

    const report = await managerOver(storage).reconcile({ reclaim: true });
    expect(report.orphaned).toEqual([]);
    expect(report.inFlight).toHaveLength(1);
    expect(report.inFlight[0]!.key).toBe(inProgress);
    expect(report.reclaimed).toBe(0);
    // It is still there: a report that names it is not a licence to delete it.
    expect(await storage.getUsageBytes()).toBeGreaterThan(0);
  });

  it('RC.4: a record whose artefact is gone is reported, because it is listed', async () => {
    // The mirror image, and the worse one: an orphan is money, a dangling record is a
    // recovery plan. `listBackups()` keeps naming it — the record is the inventory, and it
    // is there — so the only place the disagreement can appear is here.
    const { snapshot } = await backup();
    await storage.delete(snapshot.location);

    const fresh = managerOver(storage);
    expect(await fresh.listBackups()).toHaveLength(1);
    const report = await fresh.reconcile();
    expect(report.missing).toEqual([{ snapshotId: snapshot.snapshotId, key: snapshot.location }]);
    expect(report.orphaned).toEqual([]);
    // Nothing was deleted: a record with no bytes is an operator's decision, not a cleanup.
    expect(await fresh.listBackups()).toHaveLength(1);
  });

  it('RC.5: a record that cannot be read still protects its artefact', async () => {
    // A damaged record is a snapshot nobody can restore and nobody may delete: it is the
    // only evidence of what the artefact is. The id lives in the record's *key*, which
    // needs no parsing, so the protection holds even when the bytes of the record do not.
    const { snapshot } = await backup();
    await put(inventoryKey('backups', snapshot.snapshotId), 'not a record');

    const fresh = managerOver(ago(RECONCILE_GRACE_MS * 2));
    const report = await fresh.reconcile({ reclaim: true });
    expect(report.orphaned).toEqual([]);
    expect(report.reclaimed).toBe(0);
    expect(fresh.inventoryProblems()).toHaveLength(1);
    expect(fresh.inventoryProblems()[0]!.key).toBe(inventoryKey('backups', snapshot.snapshotId));
    // The artefact is still in the bucket, and still the only copy of that backup.
    expect((await storage.list('backups/')).map((e) => e.key)).toContain(snapshot.location);
  });

  it('RC.6: an object this package never named is still an object no record names', async () => {
    // A copy that was started by hand, a file an operator dropped in the prefix, an
    // artefact written by a version that named things differently. It cannot be attributed
    // to a snapshot — so it is reported with no id rather than guessed at, and reclaiming
    // it is the caller's decision, not the report's.
    await backup();
    await put('backups/full/leftover.bin', 'not a name this package writes');

    // The id is read from the name, and a name that has the suffix with no id in front of
    // it has none either: answering `''` would make the report look like it had attributed
    // the object to a snapshot called nothing.
    await put('backups/full/.artifact', 'a suffix and no id');

    const report = await managerOver(ago(RECONCILE_GRACE_MS * 2)).reconcile();
    expect(report.orphaned.map((a) => a.key)).toEqual(['backups/full/.artifact', 'backups/full/leftover.bin']);
    expect(report.orphaned.map((a) => a.snapshotId)).toEqual([null, null]);
  });

  it('RC.7: an object whose age cannot be read is not reclaimed, and the window is a choice', async () => {
    // `Date.parse` answering `NaN` is the bucket saying something this code does not
    // understand, and a failed observation is not a verdict about age — the same rule the
    // audit store's prune applies to a segment it cannot date. The second half is the knob:
    // a deployment that knows its objects are minutes old can say so.
    const { snapshot } = await backup();
    await storage.delete(inventoryKey('backups', snapshot.snapshotId));

    const odd = passthrough({
      list: async (prefix) => (await storage.list(prefix)).map((entry) => ({ ...entry, lastModified: 'yesterday' })),
    });
    const report = await managerOver(odd).reconcile({ reclaim: true });
    expect(report.orphaned).toEqual([]);
    expect(report.inFlight.map((a) => a.key)).toEqual([snapshot.location]);
    expect(report.reclaimed).toBe(0);

    // A window of zero says "nothing is in progress": the same object is then garbage.
    const now = await managerOver(ago(60_000)).reconcile({ reclaim: true, graceMs: 0 });
    expect(now.orphaned.map((a) => a.key)).toEqual([snapshot.location]);
    expect(now.reclaimed).toBe(1);
  });

  it('RC.8: a clean bucket is an empty report, and a report deletes nothing', async () => {
    // The answer that has to be cheap and boring, because it is the one an operator runs
    // on a schedule. `reclaim` is off by default for the case this cannot cover: a listing
    // that is merely stale — a bucket behind a cache, a replica that has not caught up —
    // makes a record *look* absent, and an object that looks unnamed is one delete away
    // from being a backup nobody has.
    const first = await backup();
    const second = await managerOver(storage);
    expect((await second.createBackup({ type: 'full' })).success).toBe(true);
    const usage = await storage.getUsageBytes();

    const report = await managerOver(storage).reconcile();
    expect(report).toEqual<ReconcileReport>({ orphaned: [], inFlight: [], missing: [], reclaimed: 0 });
    expect(await storage.getUsageBytes()).toBe(usage);
    expect(await managerOver(storage).listBackups()).toHaveLength(2);
    const listed = await managerOver(storage).listBackups();
    expect(listed.map((s) => s.snapshotId)).toContain(first.snapshot.snapshotId);
  });

  it('RC.9: the report is ordered by key, not by the order the backend listed', async () => {
    // Two backends that hold the same objects have to produce the same report: a diff of
    // two reconciles is how an operator sees that something changed, and a listing order
    // that comes from `readdir` or from an S3 page makes every diff show everything.
    await put('backups/full/c.artifact', 'c');
    await put('backups/full/a.artifact', 'a');
    await put('backups/full/b.artifact', 'b');

    const report = await managerOver(ago(RECONCILE_GRACE_MS * 2)).reconcile();
    expect(report.orphaned.map((a) => a.key)).toEqual([
      'backups/full/a.artifact',
      'backups/full/b.artifact',
      'backups/full/c.artifact',
    ]);
  });
  it('RC.10: a reclaim whose delete fails leaves the orphan, and says so by the count', async () => {
    // `reclaimed` is the number of objects that are gone, not the number the report named.
    // A caller that treated the two as the same would believe a bucket was clean after a
    // run in which a policy refused every delete.
    await put('backups/full/stuck.artifact', 'nobody may delete this');
    const refusing = ago(RECONCILE_GRACE_MS * 2, {
      delete: async () => {
        throw new Error('Access Denied');
      },
    });

    const refused = await managerOver(refusing).reconcile({ reclaim: true });
    expect(refused.orphaned.map((a) => a.key)).toEqual(['backups/full/stuck.artifact']);
    expect(refused.reclaimed).toBe(0);
    expect((await storage.list('backups/')).map((e) => e.key)).toContain('backups/full/stuck.artifact');
  });

  it('RC.11: a failed tidy does not replace the reason a backup failed', async () => {
    // `abandon` removes what an unconfirmed backup left behind, and swallows its own
    // failure — the caller needs the reason the backup failed, not the reason the tidying
    // did. Both halves fail here: the record's upload is refused, and so is the delete that
    // follows it.
    const refusing = passthrough({
      upload: async (sourcePath: string, destKey: string) => {
        if (destKey.includes('/inventory/')) throw new Error('the bucket is read-only for records');
        await storage.upload(sourcePath, destKey);
      },
      delete: async () => {
        throw new Error('Access Denied');
      },
    });

    const result = await managerOver(refusing).createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/read-only for records/);
    // What survives is an object no record names — which is exactly what RC.1 reports, and
    // the reason the report exists at all.
    const report = await managerOver(ago(RECONCILE_GRACE_MS * 2)).reconcile();
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0]!.snapshotId).not.toBeNull();
  });

  it('RC.12: an object outside this manager’s prefix is not this manager’s business', async () => {
    // `reconcile` reports what *this* inventory cannot name, so it reads its own prefix and
    // nothing else. A bucket shared with another deployment — a second cluster, a warehouse
    // of restored copies — would otherwise have its objects reported as garbage and, with
    // `reclaim`, deleted by a manager that never wrote them.
    await put('elsewhere/full/snap-theirs.artifact', 'another deployment');
    const report = await managerOver(ago(RECONCILE_GRACE_MS * 2)).reconcile({ reclaim: true });
    expect(report).toEqual<ReconcileReport>({ orphaned: [], inFlight: [], missing: [], reclaimed: 0 });
    expect((await storage.list('')).map((e) => e.key)).toEqual(['elsewhere/full/snap-theirs.artifact']);
  });

  it('RC.13: a record names its artefact by `location`, whatever the object is called', async () => {
    // Two ways a record names an object: the `location` it carries, and the id in its own
    // key. The second is what protects a record that cannot be parsed; the first is what
    // protects an artefact whose *name* is not the shape this version writes — a bucket
    // migrated from an earlier build, or one whose objects were copied under another
    // suffix. Reading only the name would report a live, listed, restorable backup as
    // garbage, and `reclaim` would delete it.
    const { snapshot } = await backup();
    const legacyKey = `backups/full/${snapshot.snapshotId}.tar.gz`;
    await put(legacyKey, 'the same bytes under a name this build does not write');
    await storage.delete(snapshot.location);
    await put(inventoryKey('backups', snapshot.snapshotId), serializeRecord({ ...snapshot, location: legacyKey }));

    const report = await managerOver(ago(RECONCILE_GRACE_MS * 2)).reconcile({ reclaim: true });
    expect(report.orphaned).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.reclaimed).toBe(0);
    expect((await storage.list('backups/full/')).map((e) => e.key)).toEqual([legacyKey]);
  });

  it('RC.14: exactly `graceMs` old is garbage, a millisecond younger is in progress', async () => {
    // The boundary, stood on rather than approached. Two objects, one millisecond apart,
    // and the window says which side each falls on — the difference between reclaiming
    // them and leaving them alone is the whole reason the default is off. The clock is the
    // manager's own, the one `createBackup` stamps with, so the comparison is against the
    // same time source that wrote the record rather than against whatever the process
    // happens to read mid-listing.
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    await put('backups/full/b-exact.artifact', 'exactly at the window');
    await put('backups/full/a-younger.artifact', 'one millisecond younger');
    const dated = passthrough({
      list: async (prefix) =>
        (await storage.list(prefix)).map((entry) => ({
          ...entry,
          lastModified: new Date(
            entry.key.includes('exact') ? at - RECONCILE_GRACE_MS : at - RECONCILE_GRACE_MS + 1,
          ).toISOString(),
        })),
    });

    const report = await managerOver(dated, () => new Date(at)).reconcile();
    expect(report.orphaned.map((a) => a.key)).toEqual(['backups/full/b-exact.artifact']);
    expect(report.inFlight.map((a) => a.key)).toEqual(['backups/full/a-younger.artifact']);
  });

  it('RC.15: both halves of the report are in key order', async () => {
    // The orphans were ordered by RC.9 and the in-progress objects were not, which is the
    // kind of half-finished promise a diff shows: an operator comparing two reconciles
    // would see one list move for no reason. Both are sorted, and the order is the default
    // comparator's — code-unit order, identical on every machine and in every locale,
    // which `localeCompare` is not.
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    for (const name of ['c', 'a', 'b']) {
      await put(`backups/full/${name}-old.artifact`, 'garbage');
      await put(`backups/full/${name}-new.artifact`, 'in flight');
    }
    const dated = passthrough({
      list: async (prefix) =>
        (await storage.list(prefix)).map((entry) => ({
          ...entry,
          lastModified: new Date(entry.key.includes('-old') ? at - RECONCILE_GRACE_MS * 2 : at).toISOString(),
        })),
    });

    const report = await managerOver(dated, () => new Date(at)).reconcile();
    expect(report.orphaned.map((a) => a.key)).toEqual([
      'backups/full/a-old.artifact',
      'backups/full/b-old.artifact',
      'backups/full/c-old.artifact',
    ]);
    expect(report.inFlight.map((a) => a.key)).toEqual([
      'backups/full/a-new.artifact',
      'backups/full/b-new.artifact',
      'backups/full/c-new.artifact',
    ]);
  });

  it('RC.16: a damaged record is reported again by the next listing, not once', async () => {
    // `inventoryProblems()` is a question an operator asks after a reconcile, and a manager
    // reads the bucket on every entry point. Forgetting the problem on the second read
    // would make the answer depend on how many times the question had been asked — the
    // record is still unreadable, so it is still a problem.
    const { snapshot } = await backup();
    await put(inventoryKey('backups', snapshot.snapshotId), 'not a record');

    const fresh = managerOver(storage);
    expect(await fresh.listBackups()).toHaveLength(0);
    expect(fresh.inventoryProblems()).toHaveLength(1);
    expect(await fresh.listBackups()).toHaveLength(0);
    expect(fresh.inventoryProblems()).toHaveLength(1);
    expect(fresh.inventoryProblems()[0]!.reason).toMatch(/not a record|JSON|format/);
  });
});
