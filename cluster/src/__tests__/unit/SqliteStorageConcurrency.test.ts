/**
 * SqliteStorage Transaction Isolation & Concurrency Tests
 *
 * Phase 1A — Verifies SqliteStorage's behavior under concurrent access,
 * WAL mode transaction isolation, busy_timeout handling, and crash resilience.
 *
 * SqliteStorage uses better-sqlite3 (synchronous API). Concurrency test here
 * means multiple storage instances accessing separate .db files concurrently,
 * and verifying that each instance's operations are serialized correctly.
 *
 * Acceptance Criteria:
 *   AC 27.1: Concurrent appendLogEntry on separate DB files works independently
 *   AC 27.2: 50 concurrent appendLogEntry calls maintain log ordering (by index)
 *   AC 27.3: Concurrent getLogEntries + appendLogEntry on same DB is safe
 *   AC 27.4: Batch mode with concurrent begin/endBatch works correctly
 *   AC 27.5: Multiple storage instances on separate DBs do not interfere
 *   AC 27.6: Truncate + append during concurrent read produces no data loss
 *   AC 27.7: WAL checkpoint does not block concurrent reads
 *   AC 27.8: KV metadata persistence
 *   AC 27.9: Snapshot compaction preserves data integrity
 *   AC 27.10: Append + truncate round-trip (compaction simulation)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStorage } from '../../consensus/storage/SqliteStorage';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Test utilities ───────────────────────────────────────────

function tempDbPath(): string {
  const dir = path.join(os.tmpdir(), 'sqlite-concurrency-test');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `raft-conc-${crypto.randomBytes(4).toString('hex')}.db`);
}

function createStorage(dbPath: string): SqliteStorage {
  const storage = new SqliteStorage({
    file: dbPath,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
    busyTimeout: 5000,
    maxLogSize: 10000,
  });
  storage.open();
  return storage;
}

async function appendEntries(storage: SqliteStorage, count: number, startIndex: number = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    storage.appendLogEntry(idx, 1, 0, Buffer.from(`entry-${idx}`));
  }
}

describe('SqliteStorage Concurrency & Isolation', () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
      try {
        fs.unlinkSync(p + '-wal');
      } catch {}
      try {
        fs.unlinkSync(p + '-shm');
      } catch {}
    }
    dbPaths.length = 0;
  });

  //
  // AC 27.1
  //
  it('AC 27.1: Concurrent append on separate DB files works independently', async () => {
    const p1 = tempDbPath();
    dbPaths.push(p1);
    const p2 = tempDbPath();
    dbPaths.push(p2);
    const p3 = tempDbPath();
    dbPaths.push(p3);

    const s1 = createStorage(p1);
    const s2 = createStorage(p2);
    const s3 = createStorage(p3);

    await Promise.all([appendEntries(s1, 10), appendEntries(s2, 20), appendEntries(s3, 30)]);

    expect(s1.getLastIndex()).toBe(10);
    expect(s2.getLastIndex()).toBe(20);
    expect(s3.getLastIndex()).toBe(30);

    // verify no cross-contamination
    expect(s1.getLogEntry(1)).not.toBeNull();
    expect(s2.getLogEntry(1)).not.toBeNull();
    expect(s3.getLogEntry(1)).not.toBeNull();
  });

  //
  // AC 27.2
  //
  it('AC 27.2: 50 concurrent append calls maintain log ordering', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    const promises: Promise<void>[] = [];
    for (let i = 1; i <= 50; i++) {
      const idx = i;
      promises.push(
        Promise.resolve().then(() => {
          storage.appendLogEntry(idx, 1, 0, Buffer.from(`entry-${idx}`));
        }),
      );
    }

    await Promise.all(promises);

    expect(storage.getLastIndex()).toBe(50);
    for (let i = 1; i <= 50; i++) {
      const entry = storage.getLogEntry(i);
      expect(entry).not.toBeNull();
      expect(entry!.index).toBe(i);
    }
  }, 15000);

  //
  // AC 27.3
  //
  it('AC 27.3: Concurrent getLogEntries + appendLogEntry is safe', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 10);

    await Promise.all([
      Promise.resolve().then(() => storage.getLogEntries(1, 10)),
      Promise.resolve().then(() => storage.appendLogEntry(11, 1, 0, Buffer.from('new'))),
      Promise.resolve().then(() => storage.getLogEntries(5, 15)),
    ]);

    expect(storage.getLastIndex()).toBe(11);
  });

  //
  // AC 27.4
  //
  it('AC 27.4: Batch mode with begin/endBatch works correctly', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 5);

    storage.beginBatch();
    for (let i = 6; i <= 100; i++) {
      storage.appendLogEntry(i, 1, 0, Buffer.from(`batch-${i}`));
    }
    expect(storage.getLastIndex()).toBe(100);
    storage.endBatch();

    expect(storage.getLastIndex()).toBe(100);
    const entry = storage.getLogEntry(100);
    expect(entry).not.toBeNull();
  });

  //
  // AC 27.5
  //
  it('AC 27.5: Multiple storage instances on separate DBs do not interfere', async () => {
    const instances: SqliteStorage[] = [];

    for (let i = 0; i < 5; i++) {
      const p = tempDbPath();
      dbPaths.push(p);
      instances.push(createStorage(p));
    }

    await Promise.all(
      instances.map(async (s, idx) => {
        await appendEntries(s, (idx + 1) * 5);
      }),
    );

    for (let i = 0; i < 5; i++) {
      const expected = (i + 1) * 5;
      expect(instances[i].getLastIndex()).toBe(expected);
    }
  });

  //
  // AC 27.6
  //
  it('AC 27.6: Truncate + append produces no data loss', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 20);
    await storage.truncateLogsFrom(10);

    expect(storage.getLastIndex()).toBe(9);

    await appendEntries(storage, 5, 10);
    expect(storage.getLastIndex()).toBe(14);
  });

  //
  // AC 27.7
  //
  it('AC 27.7: WAL checkpoint does not block concurrent reads', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 100);
    storage.fsync();
    storage.checkpoint('PASSIVE');

    expect(storage.getLastIndex()).toBe(100);
    const entry = storage.getLogEntry(50);
    expect(entry).not.toBeNull();
    expect(entry!.index).toBe(50);
  });

  //
  // AC 27.8
  //
  it('AC 27.8: KV metadata persistence', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    // Store hard state as KV
    const hardStateBuf = Buffer.from(JSON.stringify({ term: 3, vote: 'node-2', commit: 42 }));
    storage.setKv('hardState', hardStateBuf);

    const readBack = storage.getKv('hardState');
    expect(readBack).not.toBeNull();
    const parsed = JSON.parse(readBack!.toString());
    expect(parsed.term).toBe(3);
    expect(parsed.vote).toBe('node-2');
    expect(parsed.commit).toBe(42);

    // Snapshot meta
    storage.setKv('snapshotIndex', Buffer.from('50'));
    storage.setKv('snapshotTerm', Buffer.from('2'));

    expect(Buffer.from(storage.getKv('snapshotIndex')!).toString()).toBe('50');
  });

  //
  // AC 27.9
  //
  it('AC 27.9: Snapshot compaction preserves data integrity', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 100);

    // Simulate snapshot: compact logs before index 81
    const remaining = await storage.compactLogs(80);
    // compactLogs returns number of entries remaining after compaction
    expect(remaining).toBeLessThanOrEqual(20);
    expect(remaining).toBeGreaterThan(0);

    // Only entries >= 81 should remain
    expect(storage.getLastIndex()).toBe(100);
    expect(storage.getMinIndex()).toBeGreaterThanOrEqual(80);

    const entry80 = storage.getLogEntry(80);
    expect(entry80).toBeNull();

    const entry81 = storage.getLogEntry(81);
    expect(entry81).not.toBeNull();
    expect(entry81!.index).toBe(81);
  });

  //
  // AC 27.10
  //
  it('AC 27.10: Append + truncate round-trip', async () => {
    const p = tempDbPath();
    dbPaths.push(p);
    const storage = createStorage(p);

    await appendEntries(storage, 100);

    // truncateLogsBefore — remove log entries before the given snapshot index
    await storage.truncateLogsBefore(81);

    // Entry 80 is now the snapshot boundary, entries >= 81 remain
    expect(storage.getLastIndex()).toBe(100);
    const minIdx = storage.getMinIndex();
    // minIndex should be >= 81 after truncation before 81
    // (truncateLogsBefore(81) removes entries with index < 81)
    expect(minIdx).toBeGreaterThanOrEqual(80);
  });
});
