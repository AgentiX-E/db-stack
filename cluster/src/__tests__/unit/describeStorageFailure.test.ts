/**
 * describeStorageFailure — the context `better-sqlite3` omits from "disk I/O error".
 *
 * Why this file exists
 * --------------------
 * Two cluster runs on 2026-11-18 failed inside SQLite with `SqliteError: disk I/O
 * error`: once on `pragma journal_mode = WAL` while opening a fresh database, once
 * on a `stat` that could not find a file written one statement earlier. The message
 * carried no path, no errno and no filesystem — and the interesting question ("is the
 * disk full, or is the tmpfs host out of memory?") was not answerable from the
 * process that failed.
 *
 * `describeStorageFailure` answers it from the call site: the file, the directory, the
 * free and total space, and the sentence that names the tmpfs/cgroup mechanism. The
 * original error travels as `cause`, so nothing is lost.
 *
 * Acceptance criteria:
 *   AC 57.1  the message names the file, its directory, and the original reason
 *   AC 57.2  the message reports free and total space for the directory
 *   AC 57.3  a directory that cannot be statted is reported inside the message, not
 *            raised as a second failure
 *   AC 57.4  a non-Error reason is still rendered rather than becoming "undefined"
 *   AC 57.5  byte counts are rendered in units an operator reads
 *   AC 57.6  `SqliteStorage.open()` attaches this context to a driver failure and
 *            keeps the original as `cause`
 *   AC 57.7  an error from a caller's `onOpen` hook is rethrown untouched
 *   AC 57.8  byte counts round by magnitude: whole below ten, one decimal above it
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeStorageFailure, formatBytes } from '../../consensus/storage/describeStorageFailure';
import { SqliteStorage } from '../../consensus/storage/SqliteStorage';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storage-failure-'));
}

describe('describeStorageFailure', () => {
  it('AC 57.1: names the file, its directory, and the original reason', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'raft.db');
      const message = describeStorageFailure(file, new Error('disk I/O error'));

      expect(message).toContain(path.resolve(file));
      expect(message).toContain(dir);
      expect(message).toContain('disk I/O error');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC 57.2: reports free and total space for the directory', () => {
    const dir = tempDir();
    try {
      const message = describeStorageFailure(path.join(dir, 'raft.db'), new Error('disk I/O error'));
      // The numbers belong to the machine; the shape does not.
      expect(message).toMatch(/has \d+(\.\d+)? (B|KB|MB|GB|TB) free of \d+(\.\d+)? (B|KB|MB|GB|TB)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC 57.3: an unreadable directory is reported inside the message', () => {
    const dir = tempDir();
    try {
      const message = describeStorageFailure(path.join(dir, 'gone', 'raft.db'), new Error('disk I/O error'));

      expect(message).toContain('free space unknown');
      expect(message).toContain('disk I/O error');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC 57.4: a non-Error reason is rendered, not turned into undefined', () => {
    const dir = tempDir();
    try {
      expect(describeStorageFailure(path.join(dir, 'raft.db'), 'plain string reason')).toContain('plain string reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC 57.5: byte counts are rendered in readable units', () => {
    const dir = tempDir();
    try {
      const message = describeStorageFailure(path.join(dir, 'raft.db'), new Error('x'));
      // A raw byte count ("8589934592 free") is the failure mode this pins.
      expect(message).not.toMatch(/\d{7,} free/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatBytes', () => {
  it('AC 57.8: rounds by magnitude and never prints a raw byte count', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(8.4 * 1024 ** 3)).toBe('8.4 GB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
    // Past the largest unit the value keeps its unit rather than inventing one.
    expect(formatBytes(2 * 1024 ** 5)).toBe('2048 TB');
  });
});

describe('SqliteStorage.open() failure context', () => {
  it('AC 57.6: a driver failure carries the file, the space and the original as cause', () => {
    const dir = tempDir();
    try {
      // A directory where a database file is expected: `better-sqlite3` answers
      // SQLITE_CANTOPEN, which is exactly the class of message this enriches.
      const storage = new SqliteStorage({ file: dir });
      let thrown: unknown;
      try {
        storage.open();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(dir);
      expect(message).toContain('free of');
      expect((thrown as Error).cause).toBeInstanceOf(Error);
      // The failed open leaves nothing behind (D14).
      expect(storage.isOpen).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC 57.7: an error from the onOpen hook is rethrown untouched', () => {
    const dir = tempDir();
    try {
      const storage = new SqliteStorage({
        file: path.join(dir, 'raft.db'),
        onOpen: () => {
          throw new Error('hook refused this database');
        },
      });

      expect(() => storage.open()).toThrow('hook refused this database');
      expect(storage.isOpen).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
