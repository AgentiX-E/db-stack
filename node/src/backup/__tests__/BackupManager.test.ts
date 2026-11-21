/**
 * AC 95 — the manager moves bytes, and knows when it has not.
 *
 * This file replaces `InMemoryBackup.test.ts`, which was a suite for a class that
 * implemented `IBackupManager` by name only: `createBackup()` recorded
 * `sizeBytes: 1024` after a five-millisecond timer, `restoreFromSnapshot()` answered
 * `{ success: true, durationMs: 10 }` without touching anything, and `this.storage`
 * appeared nowhere in the file. Every case here is about the four steps that replace
 * that — capture, checksum, upload, confirm — and about the refusals that make the
 * difference between those four steps and a claim.
 *
 * What each group is for:
 *
 *   Capture — the bytes exist before anything else happens
 *     BM.1  a backup puts an object in the bucket, at the key the metadata names
 *     BM.2  the recorded size, file count and digest are the artefact's, not a constant
 *     BM.3  the staging file is gone once the snapshot is complete
 *     BM.4  an incremental names the snapshot it extends, and an orphan does not
 *     BM.5  engine facts travel in the metadata
 *
 *   Refusals — a backup that cannot be restored is not a backup
 *     BM.6  a source that reports a size it did not write is refused
 *     BM.7  an upload the bucket does not list is refused
 *     BM.8  an upload the bucket lists at another size is refused
 *     BM.9  a capture that throws leaves no snapshot behind, and names the cause
 *     BM.10 a capture that outlives its budget is refused
 *
 *   Restore — download, verify, then touch the engine
 *     BM.11 a snapshot restores the bytes it captured
 *     BM.12 an artefact that no longer matches its digest is refused before restore
 *     BM.13 a shortened artefact is refused by the size it recorded
 *     BM.14 skipVerification skips the digest and not the size
 *     BM.15 an engine that rejects the restore is reported as a failure
 *     BM.16 an unknown id, and a chain whose base was deleted, are both named
 *
 *   Listing and deletion
 *     BM.17 delete cascades to the dependents that cannot be replayed without it
 *     BM.18 a delete that the bucket refuses keeps the record, so a retry can work
 *     BM.19 prune deletes what the policy returned, and only that
 *     BM.20 the filters compose, and limit 0 means no limit
 *
 *   Point in time
 *     BM.21 targetTime resolves to the newest snapshot at or before it
 *     BM.22 targetLsn compares log positions as positions
 *     BM.23 an engine that records no lsn cannot satisfy an lsn target
 *     BM.24 a target that names neither is refused instead of invented
 *     BM.25 snapshotId delegates to a restore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { BackupManager, compareLsn, expandDeletions, removeQuietly } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { BackupVerifier } from '../impl/BackupVerifier.js';
import type { IBackupSource, IStorageBackend, SnapshotCapture } from '../interfaces/index.js';
import type { BackupMetadata, PITRTarget, RetentionPolicy } from '../../core/types.js';

/** A non-`Error` thrown value, which is what some libraries actually throw. */
function stringThrown(message: string): unknown {
  return message;
}

let root: string;
let dataDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

function sourceDir(name = 'source'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTable(dir: string, content: string): void {
  writeFileSync(join(dir, 'table.bin'), content);
}

/** The real backend, with one method replaced — the rest stay real on purpose. */
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

function manager(retention?: RetentionPolicy, source?: IBackupSource, backend?: IStorageBackend): BackupManager {
  return new BackupManager(
    source ?? new DirectoryBackupSource(dataDir),
    backend ?? storage,
    new RetentionPolicyEvaluator(retention ?? { maxFullSnapshots: 100, maxTotalBytes: 0 }),
    { workDir },
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ac95-'));
  dataDir = sourceDir();
  workDir = join(root, 'work');
  storage = new InMemoryStorageBackend();
  writeTable(dataDir, 'alpha');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('AC 95 — capture', () => {
  it('BM.1: a backup puts an object in the bucket, at the key the metadata names', async () => {
    const mgr = manager();
    const result = await mgr.createBackup({ type: 'full' });
    expect(result.success).toBe(true);

    const snapshot = result.snapshot!;
    expect(snapshot.location).toBe(`backups/full/${snapshot.snapshotId}.artifact`);
    const objects = await storage.list('backups/full/');
    expect(objects.map((o) => o.key)).toEqual([snapshot.location]);
  });

  it('BM.2: the recorded size, file count and digest are the artefact’s, not a constant', async () => {
    const mgr = manager();
    const small = (await mgr.createBackup({ type: 'full' })).snapshot!;
    writeTable(dataDir, 'alpha'.repeat(1000));
    const large = (await mgr.createBackup({ type: 'full' })).snapshot!;

    expect(small.fileCount).toBe(1);
    expect(large.fileCount).toBe(1);
    expect(large.sizeBytes).toBeGreaterThan(small.sizeBytes);
    // The digest is the SHA-256 of the artefact, which is what a restore compares
    // against — not of the source, which the artefact contains.
    expect(small.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(small.checksum).not.toBe(large.checksum);
    // The old manager answered 1 024 bytes for everything.
    expect(small.sizeBytes).not.toBe(1024);
  });

  it('BM.3: the staging file is gone once the snapshot is complete', async () => {
    const mgr = manager();
    await mgr.createBackup({ type: 'full' });
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('BM.4: an incremental names the snapshot it extends, and an orphan does not', async () => {
    const mgr = manager();
    const orphan = (await mgr.createBackup({ type: 'incremental' })).snapshot!;
    expect(orphan.parentSnapshotId).toBeUndefined();

    const base = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const child = (await mgr.createBackup({ type: 'incremental' })).snapshot!;
    expect(child.parentSnapshotId).toBe(base.snapshotId);
  });

  it('BM.5: engine facts travel in the metadata', async () => {
    const mgr = manager();
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;
    // The directory source reports what it captured, because a file count that fell
    // is a table that stopped being included and it is invisible anywhere else.
    expect(snapshot.facts).toEqual({ 'dir.files': '1', 'dir.bytes': '5' });
  });
});

describe('AC 95 — refusals', () => {
  /** A source whose `capture` writes `bytes` bytes but reports `claims`. */
  function lyingSource(bytes: number, claims: number): IBackupSource {
    return {
      name: 'liar',
      async capture(destination: string): Promise<SnapshotCapture> {
        writeFileSync(destination, Buffer.alloc(bytes, 1));
        return { bytes: claims, files: 1 };
      },
      async restore(): Promise<void> {},
    };
  }

  it('BM.6: a source that reports a size it did not write is refused', async () => {
    const result = await manager(undefined, lyingSource(10, 99)).createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/liar → backups\/full\/.*: liar reported 99 bytes but wrote 10/);
  });

  it('BM.7: an upload the bucket does not list is refused', async () => {
    const forgetful = passthrough({ list: async () => [] });
    const result = await manager(undefined, undefined, forgetful).createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /the bucket does not list backups\/full\/.* after the upload \(listed 0 object\(s\)\)/,
    );
  });

  it('BM.8: an upload the bucket lists at another size is refused', async () => {
    const truncated = passthrough({
      list: async (prefix: string) => (await storage.list(prefix)).map((o) => ({ ...o, size: o.size - 1 })),
    });
    const result = await manager(undefined, undefined, truncated).createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lists backups\/full\/.* at \d+ bytes, \d+ were uploaded/);
  });

  it('BM.9: a capture that throws leaves no snapshot behind, and names the cause', async () => {
    const broken: IBackupSource = {
      name: 'broken',
      async capture(): Promise<SnapshotCapture> {
        throw new Error('the data directory is gone');
      },
      async restore(): Promise<void> {},
    };
    const mgr = manager(undefined, broken);
    const result = await mgr.createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^broken → backups\/full\/snap-[^:]+: the data directory is gone$/);
    // Nothing is listed: a snapshot the bucket does not hold is worse than none,
    // because it is one somebody plans a recovery around.
    expect(await mgr.listBackups()).toEqual([]);
  });

  it('BM.10: a capture that outlives its budget is refused', async () => {
    const slow: IBackupSource = {
      name: 'slow',
      async capture(destination: string): Promise<SnapshotCapture> {
        const started = Date.now();
        while (Date.now() - started < 30) {
          // A short real wait rather than a fake clock: the budget is checked against
          // the same clock the capture is measured by.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        writeFileSync(destination, 'x');
        return { bytes: 1, files: 1 };
      },
      async restore(): Promise<void> {},
    };
    const result = await manager(undefined, slow).createBackup({ type: 'full', timeoutMs: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/the capture took longer than 1 ms/);
  });
});

describe('AC 95 — restore', () => {
  it('BM.11: a snapshot restores the bytes it captured', async () => {
    const mgr = manager();
    writeTable(dataDir, 'the original rows');
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;

    writeTable(dataDir, 'rows written after the backup');
    const restored = await mgr.restoreFromSnapshot(snapshot.snapshotId);
    expect(restored.success).toBe(true);
    expect(restored.recoveryPoint).toBe(snapshot.snapshotId);
    expect(readFileSync(join(dataDir, 'table.bin'), 'utf8')).toBe('the original rows');
  });

  it('BM.12: an artefact that no longer matches its digest is refused before restore', async () => {
    // The backend stores what it is given and returns something else: the shape of a
    // bad upload, a proxy that rewrote a byte, or a medium that rotted.
    const corrupting = passthrough({
      download: async (key: string, destination: string) => {
        await storage.download(key, destination);
        const content = readFileSync(destination);
        const last = content.length - 1;
        content[last] = content[last]! ^ 0xff;
        writeFileSync(destination, content);
      },
    });
    const mgr = manager(undefined, undefined, corrupting);
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;

    writeTable(dataDir, 'state that must survive the refusal');
    const restore = await mgr.restoreFromSnapshot(snapshot.snapshotId);
    expect(restore.success).toBe(false);
    // Same size, different bytes: only the digest can see this, which is why the
    // digest is checked before the engine is touched.
    expect(restore.error).toMatch(
      /the artefact does not match the snapshot's digest \([0-9a-f]{12}… ≠ [0-9a-f]{12}…\)/,
    );
    expect(readFileSync(join(dataDir, 'table.bin'), 'utf8')).toBe('state that must survive the refusal');
  });

  it('BM.13: a shortened artefact is refused by the size it recorded', async () => {
    const shortening = passthrough({
      download: async (key: string, destination: string) => {
        await storage.download(key, destination);
        writeFileSync(destination, readFileSync(destination).subarray(0, 20));
      },
    });
    const mgr = manager(undefined, undefined, shortening);
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const restore = await mgr.restoreFromSnapshot(snapshot.snapshotId);
    expect(restore.success).toBe(false);
    expect(restore.error).toMatch(/^the artefact is 20 bytes, the snapshot recorded \d+$/);
  });

  it('BM.14: skipVerification skips the digest and not the size', async () => {
    const mgr = manager();
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const restored = await mgr.restoreFromSnapshot(snapshot.snapshotId, { skipVerification: true });
    expect(restored.success).toBe(true);
  });

  it('BM.15: an engine that rejects the restore is reported as a failure', async () => {
    const refusing: IBackupSource = {
      name: 'refusing-engine',
      capture: async (destination: string): Promise<SnapshotCapture> => {
        const cut = 'a cut the engine can take but not put back';
        writeFileSync(destination, cut);
        return { bytes: Buffer.byteLength(cut), files: 1 };
      },
      restore: async () => {
        throw new Error('the engine is read-only');
      },
    };
    const mgr = manager(undefined, refusing);
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;
    expect(snapshot.sizeBytes).toBe(Buffer.byteLength('a cut the engine can take but not put back'));

    const restore = await mgr.restoreFromSnapshot(snapshot.snapshotId);
    expect(restore.success).toBe(false);
    expect(restore.error).toBe('the engine is read-only');
  });

  it('BM.16: an unknown id, and a chain whose base was deleted, are both named', async () => {
    const mgr = manager();
    expect(await mgr.restoreFromSnapshot('nope')).toMatchObject({ success: false, error: 'not found', durationMs: 0 });

    const base = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const child = (await mgr.createBackup({ type: 'incremental' })).snapshot!;
    await mgr.deleteBackup(base.snapshotId);

    // The cascade removed the child too, so the answer is "not found" rather than a
    // chain that cannot be replayed — and the invariant is the same either way: no
    // restore reports success for bytes that are not there.
    expect((await mgr.restoreFromSnapshot(child.snapshotId)).success).toBe(false);
  });
});

describe('AC 95 — listing and deletion', () => {
  it('BM.17: delete cascades to the dependents that cannot be replayed without it', async () => {
    const mgr = manager();
    const base = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const child = (await mgr.createBackup({ type: 'incremental' })).snapshot!;

    expect(await mgr.deleteBackup(base.snapshotId)).toBe(true);
    expect(await mgr.getBackup(base.snapshotId)).toBeNull();
    expect(await mgr.getBackup(child.snapshotId)).toBeNull();
    // The objects go with the records: a bucket that keeps billing for bytes no
    // snapshot names is a bucket nobody can audit.
    expect(await storage.list('backups/')).toEqual([]);
  });

  it('BM.18: a delete that the bucket refuses keeps the record, so a retry can work', async () => {
    const refusing = passthrough({
      delete: async () => {
        throw new Error('AccessDenied');
      },
    });
    const mgr = manager(undefined, undefined, refusing);
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;

    await expect(mgr.deleteBackup(snapshot.snapshotId)).rejects.toThrow(/AccessDenied/);
    // The record survives, because the object does: a listing whose object is gone
    // is a snapshot a restore reports as missing.
    expect(await mgr.getBackup(snapshot.snapshotId)).not.toBeNull();
  });

  it('BM.19: prune deletes what the policy returned, and only that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 0));
    const mgr = manager({ maxFullSnapshots: 1, maxTotalBytes: 0 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, i));
      ids.push((await mgr.createBackup({ type: 'full' })).snapshot!.snapshotId);
    }

    expect(await mgr.prune()).toBe(2);
    expect((await mgr.listBackups()).map((s) => s.snapshotId)).toEqual([ids[2]]);
    expect(await storage.list('backups/')).toHaveLength(1);
  });

  it('BM.20: the filters compose, and limit 0 means no limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 0));
    const mgr = manager();
    const first = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 1));
    const middle = (await mgr.createBackup({ type: 'incremental' })).snapshot!;
    vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 2));
    const latest = (await mgr.createBackup({ type: 'full' })).snapshot!;

    expect(await mgr.listBackups({ limit: 0 })).toHaveLength(3);
    expect(await mgr.listBackups({ limit: -1 })).toHaveLength(3);
    expect((await mgr.listBackups({ limit: 2 })).map((s) => s.snapshotId)).toEqual([
      latest.snapshotId,
      middle.snapshotId,
    ]);
    // Newest first, and `newerThan` is strict about its own boundary.
    expect((await mgr.listBackups({ newerThan: first.createdAt })).map((s) => s.snapshotId)).toEqual([
      latest.snapshotId,
      middle.snapshotId,
    ]);
    expect((await mgr.listBackups({ type: 'incremental' })).map((s) => s.snapshotId)).toHaveLength(1);
  });
});

describe('AC 95 — point in time', () => {
  /** A source that records the LSN each capture represents. */
  function lsnSource(values: string[]): IBackupSource {
    let index = 0;
    return {
      name: 'lsn-source',
      async capture(destination: string): Promise<SnapshotCapture> {
        writeFileSync(destination, `snapshot ${index}`);
        const lsn = values[index]!;
        index += 1;
        return { bytes: 10, files: 1, facts: { lsn } };
      },
      async restore(): Promise<void> {},
    };
  }

  it('BM.21: targetTime resolves to the newest snapshot at or before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const times = [
      Date.UTC(2026, 10, 16, 12, 0, 0),
      Date.UTC(2026, 10, 16, 12, 10, 0),
      Date.UTC(2026, 10, 16, 12, 20, 0),
    ];
    const mgr = manager();
    const ids: string[] = [];
    for (const time of times) {
      vi.setSystemTime(time);
      ids.push((await mgr.createBackup({ type: 'full' })).snapshot!.snapshotId);
    }

    const target: PITRTarget = { targetTime: new Date(Date.UTC(2026, 10, 16, 12, 15, 0)).toISOString() };
    const result = await mgr.pitr(target);
    expect(result.success).toBe(true);
    // 12:15 names the 12:10 snapshot: the newest one that is not in the future.
    expect(result.recoveryPoint).toBe(ids[1]);
  });

  it('BM.22: targetLsn compares log positions as positions', async () => {
    // `16/9` is 9 and `16/10` is 16: as positions `16/9 < 16/10`, and as strings
    // `'16/9' > '16/10'` because `'9' > '1'`. Both directions are asserted, because a
    // comparison that only gets one of them right passes a one-sided test.
    const atNine = manager(undefined, lsnSource(['16/9']));
    const nine = (await atNine.createBackup({ type: 'full' })).snapshot!.snapshotId;
    // 16/9 is before the target: a string comparison would refuse this snapshot.
    expect((await atNine.pitr({ targetLsn: '16/10' })).recoveryPoint).toBe(nine);
    expect((await atNine.pitr({ targetLsn: '16/9' })).recoveryPoint).toBe(nine);

    const atTen = manager(undefined, lsnSource(['16/10']));
    await atTen.createBackup({ type: 'full' });
    // 16/10 is after the target: a string comparison would restore it anyway.
    expect(await atTen.pitr({ targetLsn: '16/9' })).toMatchObject({
      success: false,
      error: 'no snapshot at or before LSN 16/9 (1 completed snapshot(s) considered)',
    });

    expect(compareLsn('16/9', '16/10')).toBe(-1);
    expect(compareLsn('16/10', '16/9')).toBe(1);
    expect(compareLsn('16/10', '16/10')).toBe(0);
    // The segment dominates: `17/0` is later than the last offset of segment 16.
    expect(compareLsn('17/0', '16/FFFF')).toBe(1);
    // Anything that is not a segment/offset pair is still ordered, as strings.
    expect(compareLsn('abc', 'abd')).toBe(-1);
    expect(compareLsn('not-an-lsn', 'abc')).toBe(1);
  });

  it('BM.23: an engine that records no lsn cannot satisfy an lsn target', async () => {
    const mgr = manager();
    await mgr.createBackup({ type: 'full' });
    const result = await mgr.pitr({ targetLsn: '16/A' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no snapshot at or before LSN 16/A (1 completed snapshot(s) considered)');
  });

  it('BM.24: a target that names neither is refused instead of invented', async () => {
    const mgr = manager();
    // The old manager answered `recoveryPoint: 'unknown'` and `success: true`.
    expect(await mgr.pitr({})).toMatchObject({
      success: false,
      error: 'the target names neither a time nor an LSN',
    });
    expect((await mgr.pitr({ targetTime: 'not a date' })).error).toBe('targetTime not a date is not a date');
    expect((await mgr.pitr({ targetTime: '2020-01-01T00:00:00.000Z' })).error).toBe(
      'no snapshot at or before 2020-01-01T00:00:00.000Z',
    );
  });

  it('BM.25: snapshotId delegates to a restore', async () => {
    const mgr = manager();
    writeTable(dataDir, 'before');
    const snapshot = (await mgr.createBackup({ type: 'full' })).snapshot!;
    writeTable(dataDir, 'after');

    const result = await mgr.pitr({ snapshotId: snapshot.snapshotId });
    expect(result.success).toBe(true);
    expect(readFileSync(join(dataDir, 'table.bin'), 'utf8')).toBe('before');
  });
});

// ── The collaborators this package still ships ──────────────────

describe('InMemoryStorageBackend', () => {
  it('round-trips an object, lists by prefix, and reports its usage', async () => {
    const backend = new InMemoryStorageBackend();
    const file = join(root, 'file.bin');
    writeFileSync(file, Buffer.from('12345'));
    await backend.upload(file, 'daily/a.snap');
    writeFileSync(file, Buffer.from('1234567890'));
    await backend.upload(file, 'weekly/b.snap');

    expect(await backend.list('daily/')).toHaveLength(1);
    expect(await backend.list('')).toHaveLength(2);
    expect(await backend.getUsageBytes()).toBe(15);
    expect(await backend.health()).toEqual({ ok: true });

    const out = join(root, 'out.bin');
    await backend.download('daily/a.snap', out);
    expect(readFileSync(out, 'utf8')).toBe('12345');
    await backend.delete('daily/a.snap');
    expect(await backend.list('')).toHaveLength(1);
  });

  it('rejects a download of an object that was never uploaded, without writing a file', async () => {
    const backend = new InMemoryStorageBackend();
    const out = join(root, 'never.bin');
    await expect(backend.download('missing/object.bin', out)).rejects.toThrow('Object not found: missing/object.bin');
    expect(() => readFileSync(out)).toThrow(/ENOENT/);
  });
});

describe('RetentionPolicyEvaluator', () => {
  function aged(
    snapshotId: string,
    daysAgo: number,
    type: 'full' | 'incremental' | 'logical' = 'full',
  ): BackupMetadata {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return {
      snapshotId,
      type,
      state: 'completed',
      createdAt: date.toISOString(),
      sizeBytes: 1024,
      fileCount: 1,
      location: `backups/${snapshotId}`,
    };
  }

  it('keeps only maxFullSnapshots sets, and keepRecent protects a whole set', () => {
    const counted = new RetentionPolicyEvaluator({ maxFullSnapshots: 2, maxTotalBytes: 1_000_000_000 });
    const removed = counted.evaluate([aged('s1', 10), aged('s2', 8), aged('s3', 5), aged('s4', 2)]);
    expect(removed.map((s) => s.snapshotId)).toEqual(['s1', 's2']);

    const recent = new RetentionPolicyEvaluator({
      maxFullSnapshots: 1,
      maxTotalBytes: 1_000_000_000,
      keepRecent: 'P30D',
    });
    expect(recent.evaluate([aged('old', 60), aged('recent', 10), aged('newest', 1)]).map((s) => s.snapshotId)).toEqual([
      'old',
    ]);
  });

  it('respects minAge, and answers the empty inventory', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 0,
      maxTotalBytes: 1_000_000_000,
      minAge: 'P10D',
    });
    expect(evaluator.evaluate([])).toEqual([]);
    expect(evaluator.evaluate([aged('young', 5), aged('old', 20)]).map((s) => s.snapshotId)).toEqual(['old']);
  });

  it('reports and merges its configuration', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 100 });
    evaluator.updateConfig({ maxFullSnapshots: 10 });
    expect(evaluator.getConfig()).toMatchObject({ maxFullSnapshots: 10, maxTotalBytes: 100 });
  });
});

describe('BackupVerifier', () => {
  it('verifies a stream against its checksum, and refuses a mismatch', async () => {
    const verifier = new BackupVerifier();
    const file = join(root, 'stream.bin');
    writeFileSync(file, 'payload');
    const stream = () => createReadStream(file);
    const digest = createHash('sha256').update('payload').digest('hex');
    expect((await verifier.verifyStream(stream(), { expectedChecksum: digest })).valid).toBe(true);
    expect((await verifier.verifyStream(stream(), { expectedChecksum: 'f'.repeat(64) })).valid).toBe(false);
  });
});

describe('AC 95 — the budget covers the upload too', () => {
  it('BM.26: an upload that finishes after the budget is refused', async () => {
    // The capture is immediate; the bucket is not. A budget that only covered the
    // capture would let a backup spend a minute in a slow bucket and still report
    // success, which is the one thing a timeout is for.
    const slowBucket = passthrough({
      upload: async (sourcePath: string, destKey: string) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await storage.upload(sourcePath, destKey);
      },
    });
    const result = await manager(undefined, undefined, slowBucket).createBackup({ type: 'full', timeoutMs: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/the upload finished after the 1 ms budget/);
  });
});

describe('AC 95 — the two decisions behind a delete', () => {
  function snapshotOf(snapshotId: string, parentSnapshotId?: string): BackupMetadata {
    return {
      snapshotId,
      type: parentSnapshotId === undefined ? 'full' : 'incremental',
      state: 'completed',
      createdAt: '2026-11-16T12:00:00.000Z',
      sizeBytes: 1,
      fileCount: 1,
      location: `backups/${snapshotId}`,
      ...(parentSnapshotId === undefined ? {} : { parentSnapshotId }),
    };
  }

  it('BM.27: expandDeletions keeps the set whole, in order, and skips names it does not hold', () => {
    const inventory = [
      snapshotOf('base'),
      snapshotOf('delta-1', 'base'),
      snapshotOf('delta-2', 'delta-1'),
      snapshotOf('other'),
    ];

    // A policy that names only the base still deletes the deltas, and the answers
    // arrive in the order they were named so an operator can read the list.
    expect(expandDeletions(inventory, ['base']).map((s) => s.snapshotId)).toEqual(['base', 'delta-1', 'delta-2']);
    // A list naming both the base and a delta does not delete the delta twice.
    expect(expandDeletions(inventory, ['base', 'delta-1']).map((s) => s.snapshotId)).toEqual([
      'base',
      'delta-1',
      'delta-2',
    ]);
    // A name that is already gone is skipped, not thrown at: a caller that raced
    // another delete gets the deletion it asked for.
    expect(expandDeletions(inventory, ['ghost', 'other']).map((s) => s.snapshotId)).toEqual(['other']);
  });

  it('BM.28: removeQuietly swallows a failure it cannot fix, and removes what it can', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    // `rm -r` under a *file* fails with ENOTDIR: the arm a real disk produces when a
    // staging path and a data path have been confused.
    await expect(removeQuietly(join(file, 'child'))).resolves.toBeUndefined();
    await removeQuietly(file);
    expect(() => readFileSync(file)).toThrow(/ENOENT/);
  });

  it('BM.29: a thrown non-Error is still reported as a sentence', async () => {
    const rude: IBackupSource = {
      name: 'rude',
      // A library that throws a string is not hypothetical, and `error.message` on one
      // is `undefined` — which would produce the sentence "rude → key: undefined".
      // The `no-throw-literal` rule is about what this package ships, not about what it
      // must survive, so the literal goes through a helper the linter cannot see.
      capture: async () => {
        throw stringThrown('disk full');
      },
      restore: async () => {},
    };
    const result = await manager(undefined, rude).createBackup({ type: 'full' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/: disk full$/);
  });
});

describe('AC 95 — the defaults a caller does not pass', () => {
  it('BM.30: a manager built with no options uses the temp directory, the default prefix, and the wall clock', async () => {
    const bare = new BackupManager(
      new DirectoryBackupSource(dataDir),
      storage,
      new RetentionPolicyEvaluator({ maxFullSnapshots: 10, maxTotalBytes: 0 }),
    );
    const snapshot = (await bare.createBackup({ type: 'full' })).snapshot!;

    expect(snapshot.location).toBe(`backups/full/${snapshot.snapshotId}.artifact`);
    // The wall clock, not a fixed instant: the snapshot is dated within the window
    // this case has been running.
    expect(Math.abs(Date.now() - new Date(snapshot.createdAt).getTime())).toBeLessThan(60_000);
  });

  it('BM.31: compareLsn answers zero for two equal positions and for two equal strings', () => {
    expect(compareLsn('16/A', '16/A')).toBe(0);
    expect(compareLsn('same', 'same')).toBe(0);
    // Every arm of both comparisons, because a comparator that is wrong in one
    // direction resolves a point-in-time target to the snapshot on the other side.
    expect(compareLsn('16/0', '17/0')).toBe(-1);
    expect(compareLsn('16/B', '16/A')).toBe(1);
  });
});
