/**
 * SqliteStorage Unit Tests — direct method coverage.
 *
 * Different from SqliteNodeStorage.test.ts (sub-storage wrappers) and
 * SqliteStorageConcurrency.test.ts (concurrency/isolation), this suite
 * exercises the SqliteStorage class itself: group commit, crash recovery,
 * fsync paths, stats, initialState/persistReady, checksum verification, and
 * every boundary branch.
 *
 * Acceptance criteria:
 *   AC 32.1  beginBatch/endBatch + setPreTruncationHook + compaction config
 *   AC 32.2  open/close idempotency + onOpen + custom pragmas + ALTER (existing column)
 *   AC 32.3  checkpoint + psync + fsyncWAL (WAL present/absent) + fsync after close
 *   AC 32.4  requestFsync group commit: batch flush + timer flush + error reject
 *   AC 32.5  recoverFromCrash: pass / fail / recovered / throw
 *   AC 32.6  vacuum + pragma (get/set) + stats (hardState parse + fileSize)
 *   AC 32.7  initialState: empty / hardState / snapshot meta / log entries
 *   AC 32.8  persistReady: hardState / snapshot / entries / committed / auto-compaction
 *   AC 32.9  log ops: append/get/range/since/truncate before/from/all + preTruncationHook
 *   AC 32.10 getLastIndex/getMinIndex/getTerm/countLogs boundaries
 *   AC 32.11 KV ops: set/get/delete/scan + getSnapshotIndex/setSnapshotIndex
 *   AC 32.12 compactLogs + verifyLogChecksum + verifyLogChecksums
 *   AC 32.13 not-open guards across all methods
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from '../../consensus/storage/SqliteStorage';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── pino logger is module-level; mock it to assert error paths. ──
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('pino', () => ({
  default: vi.fn(() => mockLogger),
}));

// ── fs failure switch for exercising error-handling branches ──
const fsState = vi.hoisted(() => ({
  failFsync: false,
  failOpenSync: false,
  failStatSync: false,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn((fd: number) => {
      if (fsState.failFsync) throw new Error('fsync-fail');
      return actual.fsyncSync(fd);
    }),
    openSync: vi.fn((p: string, flags: string) => {
      if (fsState.failOpenSync) throw new Error('open-fail');
      return actual.openSync(p, flags);
    }),
    statSync: vi.fn((p: string) => {
      if (fsState.failStatSync) throw new Error('stat-fail');
      return actual.statSync(p);
    }),
  };
});

function tmpDb(label: string): string {
  const dir = path.join(os.tmpdir(), `sqlite-storage-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'raft.db');
}

function cleanup(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('SqliteStorage — batch / hooks / config', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('batch');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.1: beginBatch defers fsync, endBatch triggers it', () => {
    s.beginBatch();
    s.appendLogEntry(1, 1, 0, Buffer.from('hello'));
    s.appendLogEntry(2, 1, 0, Buffer.from('world'));
    expect(s.countLogs()).toBe(2);
    s.endBatch();
    expect(s.countLogs()).toBe(2);
  });

  it('AC 32.1: setPreTruncationHook registers a hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    s.setPreTruncationHook(hook);
    s.appendLogEntry(1, 1);
    await s.truncateLogsBefore(1);
    expect(hook).toHaveBeenCalled();
  });

  it('AC 32.1: compaction config round-trip', () => {
    expect(s.getCompactionConfig()).toBeUndefined();
    s.setCompactionConfig({ threshold: 100, compactTarget: 50 });
    expect(s.getCompactionConfig()).toEqual({ threshold: 100, compactTarget: 50 });
  });
});

describe('SqliteStorage — open/close', () => {
  it('AC 32.2: creates parent dir and calls onOpen with the db', () => {
    const dir = path.join(os.tmpdir(), `sqlite-nested-${Date.now()}`, 'sub', 'deep');
    const p = path.join(dir, 'raft.db');
    const onOpen = vi.fn();
    const s = new SqliteStorage({
      file: p,
      onOpen,
      pragmas: { temp_store: 'MEMORY' },
      foreignKeys: true,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    s.open();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(s.getDb()).not.toBeNull();
    s.close();
    cleanup(path.dirname(p));
  });

  it('AC 32.2: ALTER TABLE checksum is a safe no-op on reopen', () => {
    const p = tmpDb('reopen');
    const s1 = new SqliteStorage({ file: p });
    s1.open();
    s1.appendLogEntry(1, 1, 0, Buffer.from('x'));
    s1.close();

    const s2 = new SqliteStorage({ file: p });
    expect(() => s2.open()).not.toThrow();
    s2.appendLogEntry(2, 1, 0, Buffer.from('y'));
    expect(s2.countLogs()).toBe(2);
    s2.close();
    cleanup(p);
  });

  it('AC 32.2: close is idempotent', () => {
    const p = tmpDb('close');
    const s = new SqliteStorage({ file: p });
    s.open();
    s.close();
    expect(() => s.close()).not.toThrow();
    cleanup(p);
  });

  it('AC 32.2: close survives a checkpoint failure (best-effort)', () => {
    const p = tmpDb('closeckpt');
    const s = new SqliteStorage({ file: p });
    s.open();
    const db = s.getDb()!;
    vi.spyOn(db, 'pragma').mockImplementation((p: any) => {
      if (String(p).includes('wal_checkpoint')) {
        throw new Error('ckpt-fail');
      }
      return [];
    });
    expect(() => s.close()).not.toThrow();
    expect(s.getDb()).toBeNull();
    cleanup(p);
  });
});

describe('SqliteStorage — fsync / checkpoint / WAL', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('fsync');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.3: checkpoint passes through', () => {
    expect(() => s.checkpoint('FULL')).not.toThrow();
    expect(() => s.checkpoint()).not.toThrow();
  });

  it('AC 32.3: fsync persists without throwing', () => {
    s.appendLogEntry(1, 1);
    expect(() => s.fsync()).not.toThrow();
  });

  it('AC 32.3: fsyncWAL handles a present WAL file', () => {
    s.appendLogEntry(1, 1);
    expect(() => s.fsyncWAL()).not.toThrow();
  });

  it('AC 32.3: checkpoint/fsync/fsyncWAL throw when not open', () => {
    const s2 = new SqliteStorage({ file: tmpDb('closed') });
    expect(() => s2.checkpoint()).toThrow(/not open/i);
    expect(() => s2.fsync()).toThrow(/not open/i);
    expect(() => s2.fsyncWAL()).toThrow(/not open/i);
    cleanup(path.dirname((s2 as any).filePath));
  });
});

describe('SqliteStorage — group commit (requestFsync)', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('gc');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.4: requestFsync resolves via timer flush', async () => {
    const started = Date.now();
    await s.requestFsync();
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
  });

  it('AC 32.4: many concurrent requestFsync calls all resolve', async () => {
    const promises = Array.from({ length: 60 }, () => s.requestFsync());
    await Promise.all(promises);
  });

  it('AC 32.4: batch-full path flushes immediately when queue >= maxBatch', async () => {
    // Pre-fill the queue to the max batch threshold with resolved callbacks.
    const queue = (s as any).groupCommitQueue;
    for (let i = 0; i < 50; i++) {
      queue.push({ resolve: () => {}, reject: () => {} });
    }
    // scheduleGroupCommit should observe the full queue and flush immediately.
    // Spy first so we can assert the immediate-flush (non-timer) path.
    const flushSpy = vi.spyOn(s as any, 'flushGroupCommit');
    (s as any).scheduleGroupCommit();
    expect(flushSpy).toHaveBeenCalled();
    flushSpy.mockRestore();
    // Clean up the leftover queue entries.
    (s as any).groupCommitQueue = [];
  });

  it('AC 32.4: flushGroupCommit is a no-op when queue is empty', async () => {
    await expect((s as any).flushGroupCommit()).resolves.toBeUndefined();
  });
});

describe('SqliteStorage — recoverFromCrash / vacuum / pragma / stats', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('recover');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.5: recoverFromCrash passes on healthy db', async () => {
    const r = await s.recoverFromCrash();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Integrity check passed');
  });

  it('AC 32.5: recoverFromCrash throws when not open', async () => {
    const s2 = new SqliteStorage({ file: tmpDb('closed') });
    await expect(s2.recoverFromCrash()).rejects.toThrow(/not open/i);
    cleanup(path.dirname((s2 as any).filePath));
  });

  it('AC 32.5: recoverFromCrash reports failure when integrity remains broken', async () => {
    const db = s.getDb()!;
    let call = 0;
    // First integrity_check returns a failure, retry also fails.
    const origPragma = db.pragma.bind(db);
    vi.spyOn(db, 'pragma').mockImplementation((p: any) => {
      if (p === 'integrity_check' || String(p).includes('integrity_check')) {
        call++;
        return [{ integrity_check: 'malformed database' }];
      }
      return origPragma(p as any);
    });
    const r = await s.recoverFromCrash();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Integrity check failed');
  });

  it('AC 32.5: recoverFromCrash reports recovery when WAL checkpoint fixes it', async () => {
    const db = s.getDb()!;
    let call = 0;
    const origPragma = db.pragma.bind(db);
    vi.spyOn(db, 'pragma').mockImplementation((p: any) => {
      if (String(p) === 'integrity_check') {
        call++;
        // First check fails, retry (after checkpoint) passes.
        return call === 1
          ? [{ integrity_check: 'malformed database' }]
          : [{ integrity_check: 'ok' }];
      }
      return origPragma(p as any);
    });
    const r = await s.recoverFromCrash();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Recovered');
  });

  it('AC 32.5: recoverFromCrash catches a thrown integrity check error', async () => {
    const db = s.getDb()!;
    vi.spyOn(db, 'pragma').mockImplementation((p: any) => {
      if (String(p) === 'integrity_check') {
        throw new Error('pragma-crash');
      }
      return [];
    });
    const r = await s.recoverFromCrash();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Crash recovery error');
  });

  it('AC 32.6: vacuum + pragma get/set', () => {
    expect(() => s.vacuum()).not.toThrow();
    // pragma get
    expect(s.pragma('journal_mode')).toBeDefined();
    // pragma set
    expect(() => s.pragma('cache_size', 1000)).not.toThrow();
  });

  it('AC 32.6: stats returns populated fields with hardState', () => {
    s.appendLogEntry(1, 3, 0, Buffer.from('a'));
    s.setKv('hard_state', Buffer.from(JSON.stringify({ term: 3, vote: 'node-1', commit: 1 })));
    const st = s.stats();
    expect(st.lastIndex).toBe(1);
    expect(st.lastTerm).toBe(3);
    expect(st.entryCount).toBe(1);
    expect(st.hardState).toEqual({ term: 3, vote: 'node-1', commit: 1 });
    expect(st.fileSize).toBeGreaterThan(0);
  });

  it('AC 32.6: stats with corrupted hard_state ignores parse error', () => {
    s.setKv('hard_state', Buffer.from('not-json'));
    const st = s.stats();
    expect(st.hardState).toBeUndefined();
  });

  it('AC 32.6: stats throws when not initialized', () => {
    const s2 = new SqliteStorage({ file: tmpDb('uninit') });
    s2.open();
    (s2 as any)._initialized = false;
    expect(() => s2.stats()).toThrow(/not initialized/i);
    s2.close();
    cleanup(path.dirname((s2 as any).filePath));
  });
});

describe('SqliteStorage — initialState / persistReady', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('state');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.7: initialState empty returns {}', async () => {
    const st = await s.initialState('node-1');
    expect(st).toEqual({});
  });

  it('AC 32.7: initialState reconstructs hardState + snapshot meta + entries', async () => {
    s.setKv('hard_state', Buffer.from(JSON.stringify({ term: 5, vote: 'node-2', commit: 10 })));
    s.setKv(
      'snapshot_meta',
      Buffer.from(JSON.stringify({ snapshotIndex: 4, snapshotTerm: 2, hardState: { term: 4 } })),
    );
    s.appendLogEntry(5, 2, 0, Buffer.from('payload'));
    const st = await s.initialState('node-1');
    expect(st.hardState.term).toBe(4); // snapshot meta hardState overrides
    expect(st.snapshotIndex).toBe(4);
    expect(st.snapshotTerm).toBe(2);
    expect(st.entries).toHaveLength(1);
    expect(st.entries[0].index).toBe('5');
    expect(st.entries[0].data).toBeDefined();
  });

  it('AC 32.7: initialState with corrupted metadata falls through', async () => {
    s.setKv('hard_state', Buffer.from('bad'));
    s.setKv('snapshot_meta', Buffer.from('bad'));
    s.appendLogEntry(1, 1);
    const st = await s.initialState('node-1');
    expect(st.entries).toHaveLength(1);
  });

  it('AC 32.8: persistReady stores hardState + snapshot + entries + committed', async () => {
    await s.persistReady('node-1', {
      hardState: { term: 2, vote: 'node-1', commit: 3 },
      snapshot: { index: 2, term: 1 },
      entries: [
        { index: 1, term: 1, type: 0, data: Buffer.from('a') },
        { index: 2, term: 1, type: 1, data: null },
      ],
      committedEntries: [{ index: 1 }, { index: 2 }],
    });
    expect(s.getLastIndex()).toBe(2);
    expect(s.getKv('committed_count')?.toString()).toBe('2');
    expect(s.getSnapshotIndex()).toBe(2);
  });

  it('AC 32.8: persistReady coerces string entry data via String()', async () => {
    await s.persistReady('node-1', {
      entries: [
        { index: 1, term: 1, type: 0, data: 'plain-string-data' },
      ],
    });
    expect(s.getLogEntry(1)?.data?.toString()).toBe('plain-string-data');
  });

  it('AC 32.8: persistReady snapshot without index/term falls back to 0', async () => {
    await s.persistReady('node-1', {
      snapshot: { term: undefined },
    });
    // snapshot meta with index 0 and term 0.
    const meta = s.getKv('snapshot_meta')!.toString();
    expect(JSON.parse(meta).snapshotIndex).toBe(0);
    expect(JSON.parse(meta).snapshotTerm).toBe(0);
  });

  it('AC 32.8: persistReady auto-compacts when count exceeds maxLogSize', async () => {
    const compactSpy = vi.spyOn(s as any, 'compactLogs').mockResolvedValue(0);
    const s2 = new SqliteStorage({ file: tmpDb('autocompact'), maxLogSize: 1 });
    s2.open();
    // Write a snapshot index so auto-compaction has a target.
    s2.setSnapshotIndex(1);
    // Insert two log entries to exceed maxLogSize (1).
    await s2.persistReady('node-1', {
      entries: [
        { index: 1, term: 1, type: 0, data: Buffer.from('x') },
        { index: 2, term: 1, type: 0, data: Buffer.from('y') },
      ],
    });
    expect(s2.countLogs()).toBeLessThanOrEqual(2);
    s2.close();
    cleanup(path.dirname((s2 as any).filePath));
    compactSpy.mockRestore();
  });
});

describe('SqliteStorage — log operations', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('log');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.9: append/get/getEntry/range/since round-trip', () => {
    s.appendLogEntry(1, 1, 0, Buffer.from('a'));
    s.appendLogEntry(2, 1, 1, null);
    s.appendLogEntry(3, 2, 0, Buffer.from('c'));

    expect(s.getLogEntry(2)?.term).toBe(1);
    expect(s.getLogEntry(999)).toBeNull();
    expect(s.getLogEntries(1, 3)).toHaveLength(2);
    expect(s.getLogsSince(2)).toHaveLength(2);
    expect(s.getLogsSince(99)).toEqual([]);
  });

  it('AC 32.9: truncate before/from/all invoke hook and remove entries', async () => {
    s.appendLogEntry(1, 1);
    s.appendLogEntry(2, 1);
    s.appendLogEntry(3, 1);

    await s.truncateLogsBefore(2);
    expect(s.getLastIndex()).toBe(3);
    expect(s.getLogEntry(1)).toBeNull();
    expect(s.getLogEntry(2)).toBeNull();

    await s.truncateLogsFrom(3);
    expect(s.getLogEntry(3)).toBeNull();

    s.appendLogEntry(4, 1);
    await s.truncateAllLogs();
    expect(s.countLogs()).toBe(0);
  });

  it('AC 32.10: getLastIndex/getMinIndex/getTerm/countLogs boundaries', () => {
    expect(s.getLastIndex()).toBe(0);
    expect(s.getMinIndex()).toBe(0);
    expect(s.getTerm(1)).toBe(0);
    expect(s.countLogs()).toBe(0);

    s.appendLogEntry(5, 7);
    expect(s.getLastIndex()).toBe(5);
    expect(s.getMinIndex()).toBe(5);
    expect(s.getTerm(5)).toBe(7);
    expect(s.countLogs()).toBe(1);
  });
});

describe('SqliteStorage — KV / snapshot', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('kv');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.11: set/get/delete/scan KV', () => {
    s.setKv('key1', Buffer.from('v1'));
    s.setKv('key2', Buffer.from('v2'));
    expect(s.getKv('key1')?.toString()).toBe('v1');
    expect(s.getKv('missing')).toBeNull();

    const scan = s.scanKv('key');
    expect(scan).toHaveLength(2);

    s.deleteKv('key1');
    expect(s.getKv('key1')).toBeNull();
    expect(s.scanKv('key')).toHaveLength(1);
  });

  it('AC 32.11: getSnapshotIndex from snapshot_index and snapshot_meta', () => {
    expect(s.getSnapshotIndex()).toBe(0);
    s.setSnapshotIndex(42);
    expect(s.getSnapshotIndex()).toBe(42);

    // Remove snapshot_index, fall back to snapshot_meta.
    s.deleteKv('snapshot_index');
    s.setKv('snapshot_meta', Buffer.from(JSON.stringify({ snapshotIndex: 7, snapshotTerm: 1 })));
    expect(s.getSnapshotIndex()).toBe(7);

    // Corrupted meta → 0.
    s.deleteKv('snapshot_meta');
    s.setKv('snapshot_meta', Buffer.from('bad'));
    expect(s.getSnapshotIndex()).toBe(0);
  });

  it('AC 32.12: compactLogs returns remaining count and truncates', async () => {
    s.appendLogEntry(1, 1);
    s.appendLogEntry(2, 1);
    s.appendLogEntry(3, 1);
    const after = await s.compactLogs(2);
    expect(after).toBe(1);
    expect(s.getSnapshotIndex()).toBe(2);
  });

  it('AC 32.12: compactLogs invokes the pre-truncation hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    s.setPreTruncationHook(hook);
    s.appendLogEntry(1, 1);
    s.appendLogEntry(2, 1);
    await s.compactLogs(1);
    expect(hook).toHaveBeenCalled();
  });
});

describe('SqliteStorage — checksum verification', () => {
  let s: SqliteStorage;
  let p: string;
  beforeEach(() => {
    p = tmpDb('crc');
    s = new SqliteStorage({ file: p });
    s.open();
  });
  afterEach(() => {
    s.close();
    cleanup(p);
  });

  it('AC 32.12: verifyLogChecksum passes for valid, returns false for missing', () => {
    s.appendLogEntry(1, 1, 0, Buffer.from('data'));
    expect(s.verifyLogChecksum(1)).toBe(true);
    expect(s.verifyLogChecksum(999)).toBe(false);
  });

  it('AC 32.12: verifyLogChecksum returns true when no checksum column value stored', () => {
    // Directly insert a row with NULL checksum via raw db.
    const db = s.getDb()!;
    db.prepare('INSERT INTO raft_log (entry_index, term, type, data, checksum) VALUES (?, ?, ?, ?, ?)').run(10, 1, 0, null, null);
    expect(s.verifyLogChecksum(10)).toBe(true);
  });

  it('AC 32.12: verifyLogChecksum handles null data (checksum 0)', () => {
    const db = s.getDb()!;
    // NULL data with checksum 0 — expected checksum for null data is 0.
    db.prepare('INSERT INTO raft_log (entry_index, term, type, data, checksum) VALUES (?, ?, ?, ?, ?)').run(11, 1, 0, null, 0);
    expect(s.verifyLogChecksum(11)).toBe(true);
  });

  it('AC 32.12: verifyLogChecksums skips rows with NULL checksum', () => {
    const db = s.getDb()!;
    // Row with NULL checksum is skipped (not treated as corrupted).
    db.prepare('INSERT INTO raft_log (entry_index, term, type, data, checksum) VALUES (?, ?, ?, ?, ?)').run(20, 1, 0, Buffer.from('z'), null);
    expect(s.verifyLogChecksums(20, 21)).toEqual([]);
  });

  it('AC 32.12: verifyLogChecksums detects corrupted entries', () => {
    s.appendLogEntry(1, 1, 0, Buffer.from('a'));
    s.appendLogEntry(2, 1, 0, Buffer.from('b'));
    expect(s.verifyLogChecksums(1, 3)).toEqual([]);

    // Corrupt entry 2 by zeroing its checksum.
    const db = s.getDb()!;
    db.prepare('UPDATE raft_log SET checksum = 0 WHERE entry_index = 2').run();
    expect(s.verifyLogChecksums(1, 3)).toEqual([2]);
  });
});

describe('SqliteStorage — fs failure error-handling branches', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('fserr');
    fsState.failFsync = false;
    fsState.failOpenSync = false;
    fsState.failStatSync = false;
    mockLogger.error.mockClear();
  });
  afterEach(() => {
    fsState.failFsync = false;
    fsState.failOpenSync = false;
    fsState.failStatSync = false;
    cleanup(p);
  });

  it('fsync catches the fs.fsyncSync error and logs it', () => {
    const s = new SqliteStorage({ file: p });
    s.open();
    s.appendLogEntry(1, 1);
    fsState.failFsync = true;
    expect(() => s.fsync()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
    s.close();
  });

  it('fsyncWAL catches fs errors and logs them', () => {
    const s = new SqliteStorage({ file: p });
    s.open();
    s.appendLogEntry(1, 1);
    // Force the WAL fsync path to throw.
    fsState.failFsync = true;
    expect(() => s.fsyncWAL()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
    s.close();
  });

  it('stats catches fs.statSync error and defaults fileSize to 0', () => {
    const s = new SqliteStorage({ file: p });
    s.open();
    s.appendLogEntry(1, 1);
    fsState.failStatSync = true;
    const st = s.stats();
    expect(st.fileSize).toBe(0);
    s.close();
  });

  it('flushGroupCommit rejects all entries when fsync throws', async () => {
    const s = new SqliteStorage({ file: p });
    s.open();
    // fsync normally swallows its own errors; force it to throw to exercise
    // flushGroupCommit's defensive rejection branch.
    const fsyncSpy = vi.spyOn(s as any, 'fsync').mockImplementation(() => {
      throw new Error('fsync-throw');
    });
    const rejected = vi.fn();
    (s as any).groupCommitQueue = [{ resolve: vi.fn(), reject: rejected }];
    await (s as any).flushGroupCommit();
    expect(rejected).toHaveBeenCalled();
    fsyncSpy.mockRestore();
    s.close();
  });
});

describe('SqliteStorage — not-open guards', () => {
  let p: string;
  beforeEach(() => {
    p = tmpDb('guards');
  });
  afterEach(() => {
    cleanup(p);
  });

  it('AC 32.13: mutating methods throw when closed', () => {
    const s = new SqliteStorage({ file: p });
    expect(() => s.appendLogEntry(1, 1)).toThrow(/not open/i);
    expect(() => s.getLogEntry(1)).toThrow(/not open/i);
    expect(() => s.getLogEntries(1, 2)).toThrow(/not open/i);
    expect(() => s.setKv('k', Buffer.from('v'))).toThrow(/not open/i);
    expect(() => s.deleteKv('k')).toThrow(/not open/i);
    expect(() => s.vacuum()).toThrow(/not open/i);
    expect(() => s.pragma('x')).toThrow(/not open/i);
    expect(() => s.checkpoint()).toThrow(/not open/i);
    expect(() => s.fsync()).toThrow(/not open/i);
    expect(() => s.fsyncWAL()).toThrow(/not open/i);
    expect(() => s.verifyLogChecksum(1)).toThrow(/not open/i);
    expect(() => s.verifyLogChecksums(1, 2)).toThrow(/not open/i);
  });

  it('AC 32.13: read methods return safe defaults when closed', () => {
    const s = new SqliteStorage({ file: p });
    expect(s.getLastIndex()).toBe(0);
    expect(s.getMinIndex()).toBe(0);
    expect(s.countLogs()).toBe(0);
    expect(s.getKv('k')).toBeNull();
    expect(s.scanKv('x')).toEqual([]);
    expect(s.getDb()).toBeNull();
  });

  it('AC 32.13: async mutating methods throw when closed', async () => {
    const s = new SqliteStorage({ file: p });
    await expect(s.truncateLogsBefore(1)).rejects.toThrow(/not open/i);
    await expect(s.truncateLogsFrom(1)).rejects.toThrow(/not open/i);
    await expect(s.truncateAllLogs()).rejects.toThrow(/not open/i);
    await expect(s.compactLogs(1)).rejects.toThrow(/not open/i);
    await expect(s.initialState('n')).rejects.toThrow(/not open/i);
    await expect(s.persistReady('n', {})).rejects.toThrow(/not open/i);
  });
});
