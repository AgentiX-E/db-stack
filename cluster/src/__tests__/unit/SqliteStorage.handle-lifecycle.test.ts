/**
 * SqliteStorage handle lifecycle — the middleware must never leak a native
 * database handle, and must survive being opened, closed, and opened again.
 *
 * Why this suite exists
 * ---------------------
 * A leaked better-sqlite3 handle does not fail a test. It fails the *process*:
 * the wrapper is finalised on a torn-down environment and better-sqlite3 aborts
 * with `terminate called after throwing an instance of 'Napi::Error'` (exit
 * 134). That is exactly what happened when the whole performance suite ran
 * together and every file passed on its own — the crash carried no stack, no
 * test name, and no count. Counting open handles turns an unreproducible abort
 * into an assertion.
 *
 * Acceptance criteria:
 *   AC 42.1  open() is idempotent: a second call reuses the live handle
 *   AC 42.2  close() is idempotent and never drives the handle count negative
 *   AC 42.3  open() after close() reopens the same file and keeps its data
 *   AC 42.4  onOpen fires once per real open, not once per open() call
 *   AC 42.5  after close(), the not-open guard fires instead of a TypeError
 *   AC 42.6  interleaved open/close across instances nets to zero
 *   AC 42.7  a failed init releases what it opened, and can be retried
 *   AC 42.8  a started cluster holds one handle per node and none after stop
 *   AC 42.9  init() on a live adapter is refused and leaks nothing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteStorage, openSqliteHandleCount } from '../../consensus/storage/SqliteStorage';
import { RaftAdapter } from '../../consensus/core/RaftAdapter';
import { TestCluster } from '../../testing/TestCluster';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-handle-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SqliteStorage handle lifecycle', () => {
  it('AC 42.1: open() is idempotent and reuses the live handle', () => {
    const s = new SqliteStorage({ file: path.join(dir, 'a.db') });

    expect(openSqliteHandleCount()).toBe(0);
    s.open();
    expect(openSqliteHandleCount()).toBe(1);
    expect(s.isOpen).toBe(true);

    const handle = s.getDb();
    s.open();
    s.open();

    // The regression: a second open() built a second Database and dropped the
    // first on the floor. Nothing observable changed except a handle nobody
    // would ever close.
    expect(openSqliteHandleCount()).toBe(1);
    expect(s.getDb()).toBe(handle);

    s.close();
    expect(openSqliteHandleCount()).toBe(0);
  });

  it('AC 42.2: close() is idempotent and never drives the count negative', () => {
    const s = new SqliteStorage({ file: path.join(dir, 'b.db') });
    s.open();
    s.close();
    expect(openSqliteHandleCount()).toBe(0);

    s.close();
    s.close();
    expect(openSqliteHandleCount()).toBe(0);
  });

  it('AC 42.3: open() after close() reopens the file and keeps its data', () => {
    const file = path.join(dir, 'c.db');
    const s = new SqliteStorage({ file });
    s.open();
    s.setKv('hardState', Buffer.from('{"term":7}', 'utf8'));
    s.close();
    expect(openSqliteHandleCount()).toBe(0);

    s.open();
    expect(openSqliteHandleCount()).toBe(1);
    expect(s.getKv('hardState')?.toString('utf8')).toBe('{"term":7}');
    s.close();
    expect(openSqliteHandleCount()).toBe(0);
  });

  it('AC 42.4: onOpen fires once per real open, not once per call', () => {
    let calls = 0;
    const s = new SqliteStorage({
      file: path.join(dir, 'd.db'),
      onOpen: () => {
        calls += 1;
      },
    });

    s.open();
    s.open();
    expect(calls).toBe(1);

    s.close();
    s.open();
    expect(calls).toBe(2);

    s.close();
  });

  it('AC 42.5: after close() the not-open guard fires, not a TypeError', () => {
    const s = new SqliteStorage({ file: path.join(dir, 'e.db') });
    s.open();
    s.close();

    expect(s.isOpen).toBe(false);
    expect(s.getDb()).toBeNull();
    // Reads that have a harmless answer stay tolerant; everything that would
    // dereference the handle says "Database not open", which is the contract
    // the rest of the class already states.
    expect(s.getLastIndex()).toBe(0);
    expect(() => s.stats()).toThrow(/not (open|initialized)/i);
    expect(() => s.pragma('journal_mode')).toThrow(/not open/i);
  });

  it('AC 42.6: interleaved open/close across instances nets to zero', () => {
    const start = openSqliteHandleCount();
    const a = new SqliteStorage({ file: path.join(dir, 'f1.db') });
    const b = new SqliteStorage({ file: path.join(dir, 'f2.db') });
    const c = new SqliteStorage({ file: path.join(dir, 'f3.db') });

    a.open();
    b.open();
    c.open();
    expect(openSqliteHandleCount()).toBe(start + 3);

    b.close();
    a.close();
    expect(openSqliteHandleCount()).toBe(start + 1);

    c.close();
    expect(openSqliteHandleCount()).toBe(start);
  });
});

describe('RaftAdapter storage ownership', () => {
  it('AC 42.7: a failed init releases the storage it opened, and can be retried', async () => {
    const before = openSqliteHandleCount();
    const adapter = new RaftAdapter({
      id: 1,
      peers: [2],
      electionTick: 15,
      heartbeatTick: 3,
      storagePath: path.join(dir, 'raft.db'),
      environment: 'development',
    });

    // No transport config, so the build fails after the storage is open. The
    // caller gets a rejected promise and no handle on anything that was built —
    // which is why init has to clean up after itself.
    await expect(adapter.init(() => {}, undefined)).rejects.toThrow();
    expect(openSqliteHandleCount()).toBe(before);

    // A retry is allowed: a failed init left nothing behind to conflict with.
    await expect(adapter.init(() => {}, undefined)).rejects.toThrow();
    expect(openSqliteHandleCount()).toBe(before);

    await adapter.stop();
    expect(openSqliteHandleCount()).toBe(before);
  });

  it('AC 42.8: a started cluster holds one handle per node and none after stop', async () => {
    const before = openSqliteHandleCount();
    const cluster = new TestCluster({ nodeCount: 3 });
    await cluster.start();
    expect(openSqliteHandleCount()).toBe(before + 3);

    await cluster.stop();
    expect(openSqliteHandleCount()).toBe(before);
  });

  it('AC 42.9: init() on a live adapter is refused and leaks nothing', async () => {
    const before = openSqliteHandleCount();
    const cluster = new TestCluster({ nodeCount: 3 });
    await cluster.start();

    // The regression this guards: re-initialising built a second SqliteStorage
    // over the first, so the node kept running on storage nobody could close.
    await expect(cluster.nodes[0]!.adapter.init(() => {}, undefined)).rejects.toThrow(/already initialized/i);
    expect(openSqliteHandleCount()).toBe(before + 3);

    await cluster.stop();
    expect(openSqliteHandleCount()).toBe(before);
  });
});
