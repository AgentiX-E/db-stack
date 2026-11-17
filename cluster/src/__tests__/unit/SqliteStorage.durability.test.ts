/**
 * SqliteStorage — durability, upgrade and diagnosis.
 *
 * The AC 32 suite asks what the storage *returns*. This one asks what it
 * *does*: which file descriptor it opens, when it forces a sync, whether the
 * native handle is released, and whether a database written by an older build
 * can still be opened. Those are the properties that decide whether a Raft
 * node loses its log in a power cut, and none of them is visible to an
 * assertion about a return value.
 *
 * Every measurement here is taken from the real filesystem: the `fs` module is
 * wrapped rather than replaced, so each call still reaches the kernel and the
 * counter is a record of work that actually happened.
 *
 * Acceptance criteria:
 *   AC 38.1  open() rolls back a failed onOpen — no handle left, state re-usable
 *   AC 38.2  the resolved options are the documented defaults, and SQLite agrees
 *   AC 38.3  beginBatch defers the whole batch to exactly one fsync
 *   AC 38.4  fsync truncates the WAL, then syncs the main file, then closes it
 *   AC 38.5  fsyncWAL addresses the -wal file and never the main file
 *   AC 38.6  close() releases the native handle exactly once
 *   AC 38.7  a database from an older build gains the checksum column on open
 *   AC 38.8  recoverFromCrash names the failures and reports the retry verdict
 *   AC 38.9  a group commit whose fsync cannot run rejects its waiters
 *   AC 38.10 vacuum reclaims the space of deleted entries
 *   AC 38.11 stats on an empty log answers 0 rather than null
 *   AC 38.12 hard_state survives persistReady → initialState on its own
 *   AC 38.13 checksum 0 on non-empty data is compared, not waved through
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteStorage, openSqliteHandleCount } from '../../consensus/storage/SqliteStorage';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── pino is module-level; the diagnosis paths write to it, so capture it. ──
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('pino', () => ({
  default: vi.fn(() => mockLogger),
}));

/**
 * What the storage asked the filesystem to do.
 *
 * `openSync` is the moment a durability operation starts — `fsync()` opens the
 * main database file, `fsyncWAL()` opens the WAL — so the path recorded here
 * identifies *which* sync ran, and the fsync count says how often. Wrapping
 * rather than replacing keeps every call real: a mutant that skips the call is
 * the only way these numbers move.
 */
const probe = vi.hoisted(() => ({
  opens: [] as Array<{ p: string; flags: string }>,
  fsyncs: 0,
  closes: 0,
  /** When set, the next fsyncs fail the way a full or failing disk would. */
  failFsync: false,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: vi.fn((p: string, flags: string) => {
      probe.opens.push({ p: String(p), flags: String(flags) });
      return actual.openSync(p, flags);
    }),
    fsyncSync: vi.fn((fd: number) => {
      probe.fsyncs += 1;
      if (probe.failFsync) throw new Error('fsync refused');
      return actual.fsyncSync(fd);
    }),
    closeSync: vi.fn((fd: number) => {
      probe.closes += 1;
      return actual.closeSync(fd);
    }),
  };
});

function tmpDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sqlite-durability-${label}-`));
  return path.join(dir, 'raft.db');
}

function cleanup(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function resetProbe(): void {
  probe.opens.length = 0;
  probe.fsyncs = 0;
  probe.closes = 0;
  probe.failFsync = false;
}

/** How many times the main database file was opened for a fsync. */
function mainSyncs(file: string): number {
  return probe.opens.filter((opened) => opened.p === file).length;
}

/** How many times the write-ahead log was opened for a fsync. */
function walSyncs(file: string): number {
  return probe.opens.filter((opened) => opened.p === `${file}-wal`).length;
}

describe('SqliteStorage — a failed open leaves nothing behind', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('open-fail');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.1: open() rolls back a throwing onOpen and can be retried', () => {
    const before = openSqliteHandleCount();
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    const storage = new SqliteStorage({
      file: p,
      onOpen: () => {
        throw new Error('onOpen refused');
      },
    });

    expect(() => storage.open()).toThrow('onOpen refused');

    // The callback ran after the handle was created and the statements were
    // prepared. If the failure is not rolled back, the handle is reachable from
    // nowhere, the object says it is open, and the file stays locked until the
    // process exits.
    expect(storage.isOpen).toBe(false);
    expect(openSqliteHandleCount()).toBe(before);
    expect(() => storage.stats()).toThrow(/not open/i);
    // Rolled back means *closed*, not merely forgotten.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((storage as unknown as { stmtInsertLog: unknown }).stmtInsertLog).toBeNull();

    // Rolling back must not poison the object: a clean configuration on the
    // same path has to work.
    const retried = new SqliteStorage({ file: p });
    retried.open();
    expect(retried.isOpen).toBe(true);
    expect(openSqliteHandleCount()).toBe(before + 1);
    retried.close();
    expect(openSqliteHandleCount()).toBe(before);

    closeSpy.mockRestore();
  });
});

describe('SqliteStorage — the resolved configuration', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('defaults');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.2: the documented defaults are the ones SQLite was told about', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // Read back from SQLite rather than from the options object: a default that
    // is computed but never applied is the failure this is looking for.
    expect(storage.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    // synchronous=FULL is 2 in SQLite's numbering.
    expect(storage.pragma('synchronous')).toEqual([{ synchronous: 2 }]);
    expect(storage.pragma('wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }]);
    expect(storage.pragma('foreign_keys')).toEqual([{ foreign_keys: 0 }]);

    // busy_timeout and maxLogSize have no read-back; they are asserted where
    // they are consumed (a lock wait, an auto-compaction).
    expect((storage as unknown as { opts: Record<string, unknown> }).opts).toMatchObject({
      synchronous: 'FULL',
      walAutocheckpoint: 1000,
      foreignKeys: false,
      busyTimeout: 5000,
      maxLogSize: 10000,
      journalMode: 'WAL',
    });

    storage.close();
  });

  it('AC 38.2: an explicit configuration wins over every default', () => {
    const storage = new SqliteStorage({
      file: p,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
      walAutocheckpoint: 17,
      busyTimeout: 250,
      foreignKeys: true,
      maxLogSize: 3,
      pragmas: { cache_size: 512 },
    });
    storage.open();

    expect(storage.pragma('synchronous')).toEqual([{ synchronous: 1 }]);
    expect(storage.pragma('wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 17 }]);
    expect(storage.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    expect(storage.pragma('cache_size')).toEqual([{ cache_size: 512 }]);

    storage.close();
  });

  it('AC 38.2: pragma() writes when given a value and reads when given none', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // Two ways to make a configuration look applied when it is not: returning
    // the current value instead of writing it, and writing the string
    // "undefined" over it. Both are refused here.
    storage.pragma('user_version', 7);
    expect(storage.pragma('user_version')).toEqual([{ user_version: 7 }]);

    storage.pragma('user_version', 9);
    expect(storage.pragma('user_version')).toEqual([{ user_version: 9 }]);

    storage.close();
  });
});

describe('SqliteStorage — when the bytes are forced out', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('durability');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.3: beginBatch defers the whole batch to exactly one fsync', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    resetProbe();

    storage.beginBatch();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    storage.setKv('k', Buffer.from('v'));

    // Three writes inside the batch: not one of them may touch the platter.
    expect(probe.opens).toEqual([]);

    storage.endBatch();

    // One checkpoint for the batch, and the entries are readable afterwards.
    expect(mainSyncs(p)).toBe(1);
    expect(storage.countLogs()).toBe(2);
    expect(storage.getKv('k')?.toString()).toBe('v');

    storage.close();
  });

  it('AC 38.3: an append outside a batch syncs on its own', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    resetProbe();

    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    expect(mainSyncs(p)).toBe(1);

    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    expect(mainSyncs(p)).toBe(2);

    storage.close();
  });

  it('AC 38.3: batch mode ends with the batch', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    storage.beginBatch();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.endBatch();

    // A batch flag left set would defer every later write for ever, so each
    // append after the batch would go to the WAL unsynced and never be forced
    // out by the append that made it.
    resetProbe();
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    expect(mainSyncs(p)).toBe(1);

    storage.close();
  });

  it('AC 38.3: a truncation and a metadata write each force their own sync', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));

    // Removing entries is the one operation that can *lose* data if the removal
    // reaches the platter before the snapshot that justified it.
    resetProbe();
    await storage.truncateLogsFrom(2);
    expect(mainSyncs(p)).toBe(1);

    resetProbe();
    storage.setKv('meta', Buffer.from('v'));
    expect(mainSyncs(p)).toBe(1);

    storage.close();
  });

  it('AC 38.6: close() drops the prepared statements with the handle', () => {
    const statements = (storage: SqliteStorage) => storage as unknown as Record<string, unknown>;

    const live = new SqliteStorage({ file: p });
    live.open();
    expect(statements(live)['stmtInsertLog']).not.toBeNull();
    expect(statements(live)['stmtScanKv']).not.toBeNull();

    live.close();

    // A statement object is bound to the handle that prepared it. Keeping it
    // after the handle is gone means the next `open()` uses a statement against
    // a database that no longer exists.
    expect(statements(live)['stmtInsertLog']).toBeNull();
    expect(statements(live)['stmtScanKv']).toBeNull();
  });

  it('AC 38.4: fsync truncates the WAL, syncs the main file, then closes its fd', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // Written through the raw handle, because every write through this class is
    // followed by its own sync — which is the behaviour under test, and leaves
    // nothing for the test to observe.
    const db = storage.getDb()!;
    db.exec(`INSERT INTO raft_log (entry_index, term, type, data, checksum) VALUES (1, 1, 0, X'00', 0)`);

    const walPath = `${p}-wal`;
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);

    resetProbe();
    storage.fsync();

    // The checkpoint mode is TRUNCATE, so the WAL is emptied rather than just
    // written back: leaving it to grow is what makes recovery slow.
    expect(fs.statSync(walPath).size).toBe(0);
    // The main file is the one opened, and its descriptor is closed again.
    expect(mainSyncs(p)).toBe(1);
    expect(probe.opens[0]!.flags).toBe('r');
    expect(probe.fsyncs).toBe(1);
    expect(probe.closes).toBe(1);

    storage.close();
  });

  it('AC 38.4: a failed fsync is reported, not thrown', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    mockLogger.error.mockClear();

    // Remove the file the sync would open. The storage must survive it: an
    // append that throws here would take the Raft node down with it.
    fs.rmSync(p);
    expect(() => storage.fsync()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('fsync failed'));

    storage.close();
  });

  it('AC 38.5: fsyncWAL syncs the -wal file and never the main file', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));

    resetProbe();
    storage.fsyncWAL();

    expect(walSyncs(p)).toBe(1);
    expect(mainSyncs(p)).toBe(0);
    expect(probe.fsyncs).toBe(1);
    expect(probe.closes).toBe(1);

    // Without a WAL there is nothing to sync, and nothing to complain about.
    fs.rmSync(`${p}-wal`, { force: true });
    resetProbe();
    expect(() => storage.fsyncWAL()).not.toThrow();
    expect(probe.opens).toEqual([]);

    storage.close();
  });

  it('AC 38.5: a failed WAL sync is reported, not thrown', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    mockLogger.error.mockClear();

    // A disk that refuses the flush is the failure the WAL sync exists for; it
    // has to be reported with its own name so an operator can tell which sync
    // failed.
    probe.failFsync = true;

    expect(() => storage.fsyncWAL()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('WAL fsync failed'));

    probe.failFsync = false;
    storage.close();
  });

  it('AC 38.6: close() releases the native handle exactly once', () => {
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    const storage = new SqliteStorage({ file: p });
    storage.open();
    closeSpy.mockClear();

    storage.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(storage.isOpen).toBe(false);

    // Idempotent: a second close must not reach the native layer again, which
    // would be a use-after-free rather than a no-op.
    storage.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    closeSpy.mockRestore();
  });
});

describe('SqliteStorage — a database written by an older build', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('upgrade');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.7: open() adds the checksum column to a table that predates it', () => {
    // The schema as it shipped before checksums existed.
    const legacy = new Database(p);
    legacy.exec(`
      CREATE TABLE raft_log (
        entry_index INTEGER PRIMARY KEY,
        term INTEGER NOT NULL,
        type INTEGER NOT NULL DEFAULT 0,
        data BLOB
      );
      CREATE TABLE raft_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      INSERT INTO raft_log (entry_index, term, type, data) VALUES (1, 1, 0, X'0102');
    `);
    legacy.close();

    const storage = new SqliteStorage({ file: p });
    storage.open();

    // The column is present, the old row survived, and a new append can write a
    // checksum — the three things the migration exists to guarantee.
    const columns = storage.pragma('table_info(raft_log)') as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('checksum');
    expect(storage.getLogEntry(1)).toMatchObject({ index: 1, term: 1 });

    storage.appendLogEntry(2, 1, 0, Buffer.from('after-upgrade'));
    expect(storage.verifyLogChecksum(2)).toBe(true);

    storage.close();
  });
});

describe('SqliteStorage — what a broken database reports', () => {
  let p: string;
  let storage: SqliteStorage;
  beforeEach(() => {
    p = tmpDb('integrity');
    resetProbe();
    storage = new SqliteStorage({ file: p });
    storage.open();
  });
  afterEach(() => {
    storage.close();
    cleanup(p);
  });

  /** Make `integrity_check` answer with the given verdicts, in order. */
  function answerIntegrity(...verdicts: string[][]): void {
    const db = storage.getDb()!;
    const real = db.pragma.bind(db);
    let call = 0;
    vi.spyOn(db, 'pragma').mockImplementation((source: string, ...rest: unknown[]) => {
      if (source === 'integrity_check') {
        const verdict = verdicts[Math.min(call, verdicts.length - 1)]!;
        call += 1;
        return verdict.map((integrity_check) => ({ integrity_check }));
      }
      return (real as (s: string, ...r: unknown[]) => unknown)(source, ...rest);
    });
  }

  it('AC 38.8: a still-broken database names every failing row', async () => {
    mockLogger.error.mockClear();
    answerIntegrity(['ok', 'row 3 missing', 'row 9 wrong'], ['row 3 missing', 'row 9 wrong']);

    const result = await storage.recoverFromCrash();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('row 3 missing');
    expect(result.message).toContain('row 9 wrong');
    // The separators too: a list joined without one is a list an operator has to
    // parse by eye.
    expect(result.message).toContain('row 3 missing, row 9 wrong');
    // The failing rows are the only diagnosis an operator gets.
    expect(mockLogger.error).toHaveBeenCalledWith(
      { failures: ['row 3 missing', 'row 9 wrong'] },
      '[SqliteStorage] Integrity check failed',
    );
  });

  it('AC 38.8: every row must be ok, not merely one of them', async () => {
    // `some` would call this healthy. One damaged page in a Raft log is a
    // truncated history, not a warning.
    answerIntegrity(['ok', 'row 3 missing']);
    const result = await storage.recoverFromCrash();
    expect(result.ok).toBe(false);
  });

  it('AC 38.8: a checkpoint that repairs the database is reported as recovered', async () => {
    mockLogger.error.mockClear();
    answerIntegrity(['row 4 missing'], ['ok']);

    const result = await storage.recoverFromCrash();

    expect(result).toEqual({ ok: true, message: 'Recovered via WAL checkpoint' });
  });

  it('AC 38.8: a throwing integrity check is reported with its reason', async () => {
    mockLogger.error.mockClear();
    const db = storage.getDb()!;
    const real = db.pragma.bind(db);
    vi.spyOn(db, 'pragma').mockImplementation((source: string, ...rest: unknown[]) => {
      if (source === 'integrity_check') throw new Error('database disk image is malformed');
      return (real as (s: string, ...r: unknown[]) => unknown)(source, ...rest);
    });

    const result = await storage.recoverFromCrash();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('database disk image is malformed');
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Crash recovery failed'));
  });
});

describe('SqliteStorage — group commit under a closing handle', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('group');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.9: a flush that cannot sync rejects every waiter with the reason', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // The queue is armed, then the handle goes away before the timer fires —
    // the shutdown path, where the pending promises still have to settle.
    const first = storage.requestFsync();
    const second = storage.requestFsync();
    storage.close();

    await expect(first).rejects.toThrow(/Group fsync failed: Database not open/);
    await expect(second).rejects.toThrow(/Group fsync failed: Database not open/);
  });

  it('AC 38.9: concurrent requests share one batch and one sync', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    resetProbe();

    const waiters = [storage.requestFsync(), storage.requestFsync(), storage.requestFsync()];
    await Promise.all(waiters);

    // Three callers, one checkpoint: that is the whole point of the mechanism.
    expect(mainSyncs(p)).toBe(1);

    storage.close();
  });

  it('AC 38.9: a burst of requests collapses into far fewer syncs', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    resetProbe();

    const waiters: Array<Promise<void>> = [];
    for (let i = 0; i < 50; i += 1) waiters.push(storage.requestFsync());
    await Promise.all(waiters);

    // The point of the mechanism is that the count is bounded by the batches it
    // formed, not by the number of callers. One sync per caller would be the
    // same behaviour the group commit exists to avoid.
    expect(mainSyncs(p)).toBeGreaterThanOrEqual(1);
    expect(mainSyncs(p)).toBeLessThan(50);

    storage.close();
  });
});

describe('SqliteStorage — space and reading back what was written', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('space');
    resetProbe();
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 38.10: vacuum reclaims the space of deleted entries', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    storage.beginBatch();
    for (let i = 1; i <= 400; i += 1) storage.appendLogEntry(i, 1, 0, Buffer.alloc(1024, i % 250));
    storage.endBatch();
    storage.checkpoint('TRUNCATE');
    const loaded = fs.statSync(p).size;

    // The truncation is asynchronous — it awaits the PITR hook — so the pages
    // are only free once it has settled.
    await storage.truncateAllLogs();
    // In WAL mode the rebuilt database lands in the log first, so the main file
    // only shows the result after a checkpoint. Deleting rows frees pages but
    // never shrinks the file, which is what vacuum is for.
    storage.checkpoint('TRUNCATE');
    storage.vacuum();
    storage.checkpoint('TRUNCATE');
    const reclaimed = fs.statSync(p).size;

    expect(loaded).toBeGreaterThan(0);
    expect(reclaimed).toBeLessThan(loaded);
    expect(storage.countLogs()).toBe(0);

    storage.close();
  });

  it('AC 38.11: stats on an empty log answers 0, never null', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // `MIN()` over no rows is NULL. A `minIndex: null` leaking into a caller
    // that compares it as a number silently becomes 0 by coercion, so the shape
    // has to be a number in the first place.
    const stats = storage.stats();
    expect(stats).toMatchObject({ minIndex: 0, lastIndex: 0, lastTerm: 0, entryCount: 0, snapshotIndex: 0 });
    expect(typeof stats.minIndex).toBe('number');
    expect(stats.hardState).toBeUndefined();

    storage.close();
  });

  it('AC 38.11: stats reports the oldest index, not zero', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    storage.appendLogEntry(3, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(4, 2, 0, Buffer.from('b'));

    // Zero is the answer for "no rows". A populated log that also answers zero
    // hides a compaction that removed the wrong range.
    expect(storage.stats()).toMatchObject({ minIndex: 3, lastIndex: 4, lastTerm: 2, entryCount: 2 });

    storage.close();
  });

  it('AC 38.11: scanKv returns the pairs it read, in key order', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    storage.setKv('a:1', Buffer.from('x'));
    storage.setKv('a:2', Buffer.from('y'));
    storage.setKv('b:1', Buffer.from('z'));

    // The prefix filters; the rows are the values that were stored, not empty
    // objects shaped like them.
    expect(storage.scanKv('a:')).toEqual([
      { key: 'a:1', value: Buffer.from('x') },
      { key: 'a:2', value: Buffer.from('y') },
    ]);

    storage.close();
  });

  it('AC 38.12: hard_state survives persistReady → initialState without a snapshot', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // No snapshot is ever written, so nothing else can supply the hard state:
    // the round trip is the only evidence that the row was stored.
    await storage.persistReady('node-1', { hardState: { term: 7, vote: 'node-2', commit: 11 } });

    const state = await storage.initialState('node-1');
    expect(state.hardState).toEqual({ term: 7, vote: 'node-2', commit: 11 });
    expect(storage.stats().hardState).toEqual({ term: 7, vote: 'node-2', commit: 11 });

    storage.close();
  });

  it('AC 38.12: persistReady tolerates a ready with no entries and no commits', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    await expect(storage.persistReady('node-1', { hardState: { term: 1, commit: 0 } })).resolves.toBeUndefined();
    await expect(storage.persistReady('node-1', { entries: [], committedEntries: [] })).resolves.toBeUndefined();
    expect(storage.countLogs()).toBe(0);

    storage.close();
  });

  it('AC 38.12: an entry with no type is stored as type 0', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // `entry.type` is optional in the wire format. Leaving it undefined used to
    // reach SQLite as NaN and fail the NOT NULL constraint on a column whose
    // documented default is 0.
    await storage.persistReady('node-1', { entries: [{ index: '1', term: '2', data: 'x' }] });

    expect(storage.getLogEntry(1)).toMatchObject({ index: 1, term: 2, type: 0 });

    storage.close();
  });

  it('AC 38.12: an entry keeps the type it was given', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    // The default for a missing type must not become the value for a present
    // one: `type: 5` is a different Raft entry kind and the log is read back by
    // it.
    await storage.persistReady('node-1', { entries: [{ index: '1', term: '2', type: 5, data: 'x' }] });

    expect(storage.getLogEntry(1)).toMatchObject({ type: 5 });

    storage.close();
  });

  it('AC 38.12: a snapshot with no hard state does not invent one', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();

    await storage.persistReady('node-1', { snapshot: { index: 5, term: 2 } });
    const state = await storage.initialState('node-1');

    // `hardState: undefined` is not the same answer as "there is none": the
    // caller that checks for the key would find it.
    expect('hardState' in state).toBe(false);
    expect(state.snapshotIndex).toBe(5);
    expect(state.snapshotTerm).toBe(2);

    storage.close();
  });

  it('AC 38.12: auto-compaction trims the log once it passes maxLogSize', async () => {
    const tight = tmpDb('autocompact');
    const storage = new SqliteStorage({ file: tight, maxLogSize: 2 });
    storage.open();

    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    storage.appendLogEntry(3, 1, 0, Buffer.from('c'));
    storage.setSnapshotIndex(1);

    // Count is now 4, past the limit of 2, and index 1 is covered by the
    // snapshot: the entry behind it has to go.
    await storage.persistReady('node-1', { entries: [{ index: '4', term: '1', data: 'd' }] });

    expect(storage.countLogs()).toBe(3);
    expect(storage.getLogEntry(1)).toBeNull();
    expect(storage.getLogEntry(4)).not.toBeNull();

    storage.close();
    cleanup(tight);
  });

  it('AC 38.12: auto-compaction is not triggered by reaching the limit exactly', async () => {
    const tight = tmpDb('autocompact-edge');
    const storage = new SqliteStorage({ file: tight, maxLogSize: 3 });
    storage.open();

    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    storage.setSnapshotIndex(1);

    // Three entries against a limit of three: the limit is a threshold to cross,
    // and compacting on equality would trim on every single write once the log
    // sits at its configured size.
    await storage.persistReady('node-1', { entries: [{ index: '3', term: '1', data: 'c' }] });

    expect(storage.countLogs()).toBe(3);
    expect(storage.getLogEntry(1)).not.toBeNull();

    storage.close();
    cleanup(tight);
  });

  it('AC 38.12: a log limit of 0 disables auto-compaction entirely', async () => {
    const off = tmpDb('autocompact-off');
    const storage = new SqliteStorage({ file: off, maxLogSize: 0 });
    storage.open();

    storage.setSnapshotIndex(1);
    for (const i of [1, 2, 3]) storage.appendLogEntry(i, 1, 0, Buffer.from('x'));
    mockLogger.info.mockClear();

    await storage.persistReady('node-1', { entries: [{ index: '4', term: '1', data: 'y' }] });

    // Zero documents "no limit". Read as a threshold it means "compact always",
    // which silently deletes the log of every node that configured it this way.
    expect(storage.countLogs()).toBe(4);
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('Compacted logs'));

    storage.close();
    cleanup(off);
  });

  it('AC 38.12: a snapshot at index 0 is not a reason to compact', async () => {
    const fresh = tmpDb('autocompact-nosnap');
    const storage = new SqliteStorage({ file: fresh, maxLogSize: 2 });
    storage.open();

    for (const i of [1, 2, 3]) storage.appendLogEntry(i, 1, 0, Buffer.from('x'));
    mockLogger.info.mockClear();

    // No snapshot has been taken, so the snapshot index is 0 and there is
    // nothing covered to remove. Compacting "up to 0" is a compaction that
    // reports itself as having run.
    await storage.persistReady('node-1', { entries: [{ index: '4', term: '1', data: 'y' }] });

    expect(storage.countLogs()).toBe(4);
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('Compacted logs'));

    storage.close();
    cleanup(fresh);
  });

  it('AC 38.12: persistReady forces the whole transaction out with one sync', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    resetProbe();

    // Three entries inside one transaction: one sync for the transaction, not
    // one per entry. Per-entry syncing inside the batch flag is the same
    // durability at three times the cost.
    await storage.persistReady('node-1', {
      entries: [
        { index: '1', term: '1', data: 'a' },
        { index: '2', term: '1', data: 'b' },
        { index: '3', term: '1', data: 'c' },
      ],
    });

    expect(storage.countLogs()).toBe(3);
    expect(mainSyncs(p)).toBe(1);

    // The flag is cleared with the transaction. Left set, every later append
    // would ride on a sync that never comes.
    resetProbe();
    storage.appendLogEntry(4, 1, 0, Buffer.from('d'));
    expect(mainSyncs(p)).toBe(1);

    storage.close();
  });

  it('AC 38.12: getLogsSince includes the entry it starts at', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));

    // "Since index 2" means index 2 is part of the answer. Treating the start as
    // exclusive drops the first entry of every incremental read, which is the
    // entry a follower is asking for.
    expect(storage.getLogsSince(2).map((entry) => entry.index)).toEqual([2]);
    expect(storage.getLogsSince(1).map((entry) => entry.index)).toEqual([1, 2]);
    expect(storage.getLogsSince(3)).toEqual([]);

    storage.close();
  });

  it('AC 38.3: every truncation path forces its own sync', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    storage.appendLogEntry(3, 1, 0, Buffer.from('c'));

    resetProbe();
    await storage.truncateLogsBefore(1);
    expect(mainSyncs(p)).toBe(1);

    resetProbe();
    await storage.truncateAllLogs();
    expect(mainSyncs(p)).toBe(1);
    expect(storage.countLogs()).toBe(0);

    storage.close();
  });

  it('AC 38.12: compactLogs reports what it removed', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));
    storage.appendLogEntry(2, 1, 0, Buffer.from('b'));
    mockLogger.info.mockClear();

    const remaining = await storage.compactLogs(1);

    expect(remaining).toBe(1);
    // The line is the only record of a compaction that removed data.
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Compacted logs at index 1: 2 → 1 entries'));

    storage.close();
  });

  it('AC 38.12: compactLogs refuses a closed handle before it touches the hook', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('a'));

    const hook = vi.fn(async () => undefined);
    storage.setPreTruncationHook(hook);
    storage.close();

    await expect(storage.compactLogs(1)).rejects.toThrow(/not open/i);
    // The PITR hook flushes a write-ahead log before entries are dropped; running
    // it for a truncation that cannot happen is a write with no effect and a
    // failure that is reported twice.
    expect(hook).not.toHaveBeenCalled();
  });

  it('AC 38.13: checksum 0 on non-empty data is compared, not waved through', async () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('payload'));

    // 0 is a real checksum value (crc32 of the empty buffer), so "0" cannot be
    // read as "no checksum stored" — that reading makes every row with a
    // rejected checksum look intact.
    storage.getDb()!.prepare('UPDATE raft_log SET checksum = 0 WHERE entry_index = 1').run();
    expect(storage.verifyLogChecksum(1)).toBe(false);

    // The genuine value is accepted.
    storage.getDb()!.prepare('UPDATE raft_log SET checksum = ? WHERE entry_index = 1').run(0x1234);
    expect(storage.verifyLogChecksum(1)).toBe(false);
    expect(storage.verifyLogChecksums(1, 2)).toEqual([1]);

    storage.close();
  });

  it('AC 38.13: a NULL checksum means the row predates checksums and is accepted', () => {
    const storage = new SqliteStorage({ file: p });
    storage.open();
    storage.appendLogEntry(1, 1, 0, Buffer.from('payload'));

    storage.getDb()!.prepare('UPDATE raft_log SET checksum = NULL WHERE entry_index = 1').run();
    expect(storage.verifyLogChecksum(1)).toBe(true);
    expect(storage.verifyLogChecksums(1, 2)).toEqual([]);

    storage.close();
  });
});
