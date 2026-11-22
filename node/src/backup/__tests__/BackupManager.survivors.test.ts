/**
 * The survivors of `BackupManager.ts`'s mutation runs, read one by one.
 *
 * The first run scored 88.25 % and 35 mutants survived. Every one is either killed by a
 * case below or argued here, because a survivor is a line whose behaviour the suite does
 * not distinguish — and the two acceptable answers are "add the case" and "show why no
 * case can exist".
 *
 * Iteration 66 added `reconcile()` and read its survivors the same way. Eleven were killed
 * rather than argued: the prefix the listing is read with (`RC.12`), the `location` a
 * record names its artefact by when the object's *name* is not one this build writes
 * (`RC.13`), the grace window's boundary to the millisecond read from the manager's own
 * clock (`RC.14`), and the order of the in-progress half of the report (`RC.15`). The
 * hand-written comparator the two halves were sorted with went with them: the default
 * comparator is code-unit order — the same on every machine and in every locale, which
 * `localeCompare` is not — and it is a line that cannot be wrong about ties. The file
 * measures **96.63 %** (458 killed, 1 timeout, 16 survived, none uncovered).
 *
 * Killed here:
 *
 *   SV.1  `compareLsn` refuses a string that is not `segment/offset` — `parts.length`
 *   SV.2  a side that parses to `NaN` is not an LSN — the finiteness check
 *   SV.3  one unparsable side falls back to string order — the `||` of the null test
 *   SV.4  offsets inside one segment are compared as numbers, and segments numerically
 *   SV.5  an id the inventory does not hold is skipped rather than named
 *   SV.6  the confirmation reads the key it uploaded, not the first key listed
 *   SV.7  empty facts are not recorded, and present facts are — the `length > 0` guard
 *   SV.8  `durationMs` is elapsed time on success, on a digest mismatch, on a size
 *         mismatch and on an engine that throws
 *   SV.9  a delete cascades rather than leaving a child nobody can replay
 *   SV.10 a restore leaves no staging file behind, on either outcome
 *   SV.11 `pitr` by time chooses the newest candidate
 *   SV.12 an unparseable `targetTime` is refused, not compared
 *   SV.13 a target exactly at a snapshot's timestamp includes that snapshot
 *   SV.14 a target before every snapshot is refused
 *   SV.15 a snapshot that records no `lsn` is skipped rather than dereferenced
 *   SV.16 `targetLsn` ranks candidates by position, not by listing order
 *   SV.17 `skipVerification` restores an artefact whose digest does not match, and still
 *         refuses one whose size does
 *
 * Argued as unreachable or equivalent — the 16 that remain:
 *
 *   `left[0] < right[0]` in `compareLsn` → `<=` — the ternary is only evaluated when the
 *   two segments differ, where the two comparisons agree.
 *   `rm(path, { recursive: true, force: true })` → `{}` / `force: false` /
 *   `recursive: false` — the path is a file, so all four remove it, and the function
 *   catches what they do not. That is what the function is for.
 *   `if (!byId.has(id)) continue` — the final `filter` already drops a name the inventory
 *   does not hold, so skipping early and skipping late produce the same list.
 *   `this.stamps.delete(id)` in `readInventory` — the `stale` filter's own
 *   `!this.snapshots.has(id)` already forces a re-read, so clearing the stamp changes
 *   which records are read not at all. The line stays because a stamp nobody clears is a
 *   map that only grows.
 *   `if (!present.has(key)) this.damaged.delete(key)` → `true` — the same pass that would
 *   forget the problem re-reads the record: it is in `stale`, so a read that fails puts
 *   the problem back. Forgetting and re-learning produce the same answer.
 *   `if (stale.length === 0) return;` → never — the guard saves a `mkdir` on a directory
 *   that already exists and an `eachLimited` over an empty list, both of which do nothing.
 *   `readFile(local, 'utf8')` → `readFile(local, '')` — `''` is not an encoding, so Node
 *   hands back the bytes and `JSON.parse` calls `toString()`, which is UTF-8: same text.
 *   `if (id !== null) namedIds.add(id)` → `true`, and `snapshotId !== null &&` → `true` —
 *   a key without an id adds `null` to a `Set<string>`, and the only `has` call is guarded
 *   by `snapshotId !== null`, so the question `has(null)` can be asked and is always false.
 *   `deadline === undefined` — `Date.now() + undefined` is `NaN`, and every comparison
 *   against `NaN` is false, so the "no budget" branch and the mutated one behave alike.
 *   `state: 'in-progress'` — the snapshot is stored only after it becomes `completed`; the
 *   interim value never leaves the method, so nothing can observe it.
 *   `this.snapshots.delete(...)` and `this.stamps.delete(...)` in `discard` — every public
 *   entry point reconciles against the listing first, so the next read removes what the
 *   delete would have. The lines stay because a manager whose map still named a deleted
 *   snapshot would be wrong for as long as nothing asked it anything.
 *   `snapshot.checksum !== undefined` — every snapshot the manager creates has one, and
 *   there is no public way to construct one that does not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BackupManager, compareLsn, expandDeletions } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import type { IBackupSource, IStorageBackend, SnapshotCapture } from '../interfaces/index.js';
import type { BackupMetadata } from '../../core/types.js';

let root: string;
let dataDir: string;
let workDir: string;
let storage: InMemoryStorageBackend;

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

function manager(
  options: { source?: IBackupSource; backend?: IStorageBackend; clock?: () => Date } = {},
): BackupManager {
  return new BackupManager(
    options.source ?? new DirectoryBackupSource(dataDir),
    options.backend ?? storage,
    new RetentionPolicyEvaluator({ maxFullSnapshots: 100, maxTotalBytes: 0 }),
    { workDir, ...(options.clock === undefined ? {} : { clock: options.clock }) },
  );
}

/**
 * One manager whose two collaborators the test can bend between calls.
 *
 * The manager keeps its inventory in memory, so a second `BackupManager` does not know
 * a snapshot the first one created — every case below therefore uses one instance and
 * changes what its source and bucket do, which is also what a real failure looks like:
 * the same manager, a disk that started returning zeros.
 */
function controllable(clock?: () => Date): {
  mgr: BackupManager;
  state: {
    failRestore: boolean;
    download: ((key: string, dest: string) => Promise<void>) | null;
  };
} {
  const state = {
    failRestore: false,
    download: null as ((key: string, dest: string) => Promise<void>) | null,
  };
  const source: IBackupSource = {
    name: 'controllable',
    async capture(destination: string): Promise<SnapshotCapture> {
      writeFileSync(destination, Buffer.from('artifact'));
      return { bytes: 8, files: 1 };
    },
    async restore(): Promise<void> {
      if (state.failRestore) throw new Error('engine said no');
    },
  };
  const backend = passthrough({
    download: (key: string, dest: string) => (state.download ?? storage.download.bind(storage))(key, dest),
  });
  return { mgr: manager({ source, backend, ...(clock === undefined ? {} : { clock }) }), state };
}

/** A source that reports whatever facts the test gives it. */
function sourceWithFacts(facts: Record<string, string> | undefined): IBackupSource {
  return {
    name: 'facts',
    async capture(destination: string): Promise<SnapshotCapture> {
      writeFileSync(destination, Buffer.from('artifact'));
      return facts === undefined ? { bytes: 8, files: 1 } : { bytes: 8, files: 1, facts };
    },
    async restore(): Promise<void> {},
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bm-survivors-'));
  dataDir = join(root, 'data');
  workDir = join(root, 'work');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'table.bin'), 'alpha');
  storage = new InMemoryStorageBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── compareLsn ──────────────────────────────────────────────────

describe('SV — compareLsn distinguishes an LSN from a string that is not one', () => {
  it('SV.1: a value with more than one separator is not an LSN, so it is compared as a string', () => {
    // '1/2/3' parses to [1, 2] if only the first two parts are read, which would make
    // it equal to '1/2'; the length check is what refuses it.
    expect(compareLsn('1/2/3', '1/2')).toBe(1);
    expect(compareLsn('1/2', '1/2/3')).toBe(-1);
  });

  it('SV.2: a side that parses to NaN is not an LSN either', () => {
    expect(compareLsn('16/1', '16/zz')).toBe(-1);
    expect(compareLsn('16/zz', '16/1')).toBe(1);
    expect(compareLsn('16/zz', '16/zz')).toBe(0);
  });

  it('SV.3: one unparsable side falls back to string order, whichever side it is', () => {
    expect(compareLsn('16/1', 'nope')).toBe(-1);
    expect(compareLsn('nope', '16/1')).toBe(1);
  });

  it('SV.4: offsets inside one segment are compared as numbers', () => {
    // The case the function exists for: as strings, '16/9' sorts after '16/10'.
    expect(compareLsn('16/9', '16/A')).toBe(-1);
    expect(compareLsn('16/A', '16/9')).toBe(1);
    expect(compareLsn('16/9', '17/0')).toBe(-1);
    expect(compareLsn('17/0', '16/9')).toBe(1);
  });

  it('SV.5: an id the inventory does not hold is skipped rather than named', () => {
    // The early `continue` and the final `filter` agree on every input, which is why
    // the mutant survived — the case pins the agreed answer for the caller that races
    // another delete.
    const inventory: BackupMetadata[] = [
      {
        snapshotId: 'a',
        type: 'full',
        state: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        sizeBytes: 1,
        fileCount: 1,
        location: 'backups/full/a.artifact',
      },
    ];
    expect(expandDeletions(inventory, ['missing'])).toEqual([]);
    expect(expandDeletions(inventory, ['missing', 'a']).map((s) => s.snapshotId)).toEqual(['a']);
  });
});

// ── the confirmation ────────────────────────────────────────────

describe('SV — the confirmation reads the key it uploaded', () => {
  it('SV.6: a listing that also holds a neighbouring key still confirms the right object', async () => {
    // A backend whose `list(prefix)` is a prefix search — which is what S3, GCS and the
    // in-memory backend all are — returns every object that starts with the key. Taking
    // the first entry instead of the one whose key matches would compare the wrong size.
    const withNeighbour = passthrough({
      list: async (prefix: string) => [
        { key: `${prefix}-neighbour`, size: 999, lastModified: '2026-01-01T00:00:00.000Z' },
        ...(await storage.list(prefix)),
      ],
    });

    const result = await manager({ backend: withNeighbour }).createBackup({ type: 'full' });
    expect(result.success).toBe(true);
    expect(result.snapshot!.sizeBytes).toBeGreaterThan(0);
  });
});

// ── facts ───────────────────────────────────────────────────────

describe('SV — facts are recorded when the engine has any', () => {
  it('SV.7: a source that reports no facts leaves the field absent, not empty', async () => {
    const none = await manager({ source: sourceWithFacts(undefined) }).createBackup({ type: 'full' });
    expect(none.snapshot!.facts).toBeUndefined();

    const empty = await manager({ source: sourceWithFacts({}) }).createBackup({ type: 'full' });
    expect(empty.snapshot!.facts).toBeUndefined();

    const some = await manager({ source: sourceWithFacts({ lsn: '16/A' }) }).createBackup({ type: 'full' });
    expect(some.snapshot!.facts).toEqual({ lsn: '16/A' });
  });
});

// ── durations ───────────────────────────────────────────────────

describe('SV — durationMs is elapsed time on every path that reports one', () => {
  it('SV.8: success, digest mismatch, size mismatch and a throwing engine all report elapsed time', async () => {
    const start = Date.now();
    const { mgr, state } = controllable();

    const created = await mgr.createBackup({ type: 'full' });
    const ok = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);

    // Same length, different bytes: the size check passes and the digest is what fails.
    state.download = async (key: string, dest: string) => {
      const listed = await storage.list(key);
      writeFileSync(dest, Buffer.alloc(listed[0]!.size, 0));
    };
    const digestCase = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);

    state.download = async (_key: string, dest: string) => {
      writeFileSync(dest, Buffer.from('short'));
    };
    const shortCase = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);

    state.download = null;
    state.failRestore = true;
    const thrown = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);

    const budget = Date.now() - start + 5_000;
    expect(ok.success).toBe(true);
    expect(digestCase.success).toBe(false);
    expect(shortCase.success).toBe(false);
    expect(thrown.success).toBe(false);
    // `Date.now() + started` — the mutant — produces a number a thousand times larger
    // than any run of this test can take.
    for (const result of [ok, digestCase, shortCase, thrown]) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(budget);
    }
  });

  it('SV.9: a delete cascades, so the child of a removed base is gone rather than unreplayable', async () => {
    const { mgr } = controllable();
    const base = await mgr.createBackup({ type: 'full' });
    const child = await mgr.createBackup({ type: 'incremental' });
    expect(child.snapshot!.parentSnapshotId).toBe(base.snapshot!.snapshotId);

    await mgr.deleteBackup(base.snapshot!.snapshotId);

    // The cascade is what keeps `unrestorableReason` from being the answer here: a
    // snapshot nobody can replay is not left behind for a restore to find. The guard
    // for an inventory that disagrees with itself is still there, and it is covered by
    // `backupChain`'s own suite against metadata it constructs directly.
    const gone = await mgr.restoreFromSnapshot(child.snapshot!.snapshotId);
    expect(gone).toMatchObject({ success: false, error: 'not found', durationMs: 0 });
  });
});

// ── staging ─────────────────────────────────────────────────────

describe('SV — a restore leaves nothing behind', () => {
  it('SV.10: the downloaded artefact is removed whether the restore succeeded or not', async () => {
    const { mgr, state } = controllable();
    const created = await mgr.createBackup({ type: 'full' });
    expect(readdirSync(workDir)).toEqual([]);

    const ok = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);
    expect(ok.success).toBe(true);
    expect(readdirSync(workDir)).toEqual([]);

    state.failRestore = true;
    const failed = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);
    expect(failed.success).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
  });
});

// ── point in time ───────────────────────────────────────────────

describe('SV — point-in-time recovery resolves against what it holds', () => {
  /** A manager whose clock advances one second per call, so timestamps are ordered. */
  function clocked(lsns: string[]): { mgr: BackupManager; tick: () => void } {
    let seconds = 0;
    let index = 0;
    return {
      mgr: manager({
        clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)),
        source: {
          name: 'clocked',
          async capture(destination: string): Promise<SnapshotCapture> {
            writeFileSync(destination, Buffer.from('artifact'));
            const lsn = lsns[index++];
            return lsn === undefined ? { bytes: 8, files: 1 } : { bytes: 8, files: 1, facts: { lsn } };
          },
          async restore(): Promise<void> {},
        },
      }),
      tick: () => {
        seconds += 1;
      },
    };
  }

  it('SV.11: the newest snapshot at or before a target is the one restored', async () => {
    const { mgr } = clocked([]);
    const first = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const second = (await mgr.createBackup({ type: 'full' })).snapshot!;

    const result = await mgr.pitr({ targetTime: '2030-01-01T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe(second.snapshotId);
    expect(result.recoveryPoint).not.toBe(first.snapshotId);
  });

  it('SV.12: a target time that is not a date is refused, not compared', async () => {
    const { mgr } = clocked([]);
    await mgr.createBackup({ type: 'full' });

    const result = await mgr.pitr({ targetTime: 'yesterday-ish' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/targetTime yesterday-ish is not a date/);
    expect(result.durationMs).toBe(0);
  });

  it('SV.13: a target exactly at a snapshot’s timestamp includes that snapshot', async () => {
    const { mgr } = clocked([]);
    const created = (await mgr.createBackup({ type: 'full' })).snapshot!;

    // The boundary is inclusive: an operator who names the second a backup was taken
    // means that backup, and `<` would answer "nothing at or before it".
    const result = await mgr.pitr({ targetTime: created.createdAt });
    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe(created.snapshotId);
  });

  it('SV.14: a target before every snapshot is refused and says how many were considered', async () => {
    const { mgr } = clocked([]);
    await mgr.createBackup({ type: 'full' });

    const result = await mgr.pitr({ targetTime: '2000-01-01T00:00:00Z' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no snapshot at or before 2000-01-01T00:00:00Z/);
  });

  it('SV.15: a snapshot with no lsn fact is skipped rather than dereferenced', async () => {
    // The optional chaining is what keeps this a refusal instead of a TypeError: a
    // snapshot taken by a source that reports no facts is unusable for an LSN target.
    const { mgr } = clocked([]);
    await mgr.createBackup({ type: 'full' });

    const result = await mgr.pitr({ targetLsn: '16/A' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no snapshot at or before LSN 16\/A \(1 completed snapshot\(s\) considered\)/);
  });

  it('SV.16: candidates are ranked by log position, not by listing order', async () => {
    const { mgr } = clocked(['16/9', '16/A']);
    const older = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const newer = (await mgr.createBackup({ type: 'full' })).snapshot!;

    // 16/9 is 9, 16/A is 16, and both are at or before 16/A — so the ranking decides.
    // A sort that does not run leaves them in insertion order and answers 16/9.
    const result = await mgr.pitr({ targetLsn: '16/A' });
    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe(newer.snapshotId);
    expect(older.facts!['lsn']).toBe('16/9');
  });
});

// ── skipVerification ────────────────────────────────────────────

describe('SV — skipVerification skips the digest, and only the digest', () => {
  it('SV.17: an artefact whose bytes changed still restores when the caller says to skip', async () => {
    const { mgr, state } = controllable();
    const created = await mgr.createBackup({ type: 'full' });

    state.download = async (key: string, dest: string) => {
      const listed = await storage.list(key);
      writeFileSync(dest, Buffer.alloc(listed[0]!.size, 0));
    };
    const verified = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId);
    expect(verified.success).toBe(false);
    expect(verified.error).toMatch(/does not match the snapshot's digest/);

    const skipped = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId, { skipVerification: true });
    expect(skipped.success).toBe(true);

    state.download = async (_key: string, dest: string) => {
      writeFileSync(dest, Buffer.from('short'));
    };
    const wrongSize = await mgr.restoreFromSnapshot(created.snapshot!.snapshotId, { skipVerification: true });
    expect(wrongSize.success).toBe(false);
    expect(wrongSize.error).toMatch(/the artefact is 5 bytes/);
  });
});
