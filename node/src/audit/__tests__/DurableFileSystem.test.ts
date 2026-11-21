/**
 * The default `DurableFileSystem`: the POSIX recipe the store runs in production.
 *
 * The store's own tests use a recording implementation whose failure switch is
 * how "a filesystem that says no" is expressed. That leaves the default
 * implementation itself — the one every deployment actually runs — covered only
 * by the happy path of other tests. These cases assert what it does with the
 * states it will meet: a file that does not exist, a file that ends mid-line, a
 * directory that is not there, and the errno values that mean "this platform
 * cannot sync a directory" as opposed to "the sync failed".
 *
 * @module @agentix-e/db-node/audit/__tests__
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNodeDurableFileSystem,
  isDirectorySyncUnsupported,
  nodeDurableFileSystem,
  nodeFileCalls,
} from '../impl/DurableFileSystem.js';
import type { NodeFileCalls } from '../impl/DurableFileSystem.js';

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dfs-'));
  file = join(dir, 'segment.ndjson');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isDirectorySyncUnsupported', () => {
  it('DF.1: only the errnos that mean "not here" are tolerated', () => {
    // "Not here": the platform does not open directories for reading, or the
    // filesystem refuses to sync one. These are limitations, and a write is still
    // worth acknowledging on such a system.
    for (const code of ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']) {
      expect(isDirectorySyncUnsupported(errnoError(code)), code).toBe(true);
    }
    // "Not now": the medium failed. Tolerating these is how a durability claim
    // becomes a comment, so they must reach the caller.
    for (const code of ['EIO', 'ENOSPC', 'ENOENT', 'EACCES', 'EROFS']) {
      expect(isDirectorySyncUnsupported(errnoError(code)), code).toBe(false);
    }
  });

  it('DF.2: something that is not an errno is not a tolerated errno', () => {
    expect(isDirectorySyncUnsupported(new Error('no code'))).toBe(false);
    expect(isDirectorySyncUnsupported('EISDIR')).toBe(false);
    expect(isDirectorySyncUnsupported(null)).toBe(false);
    expect(isDirectorySyncUnsupported(undefined)).toBe(false);
    expect(isDirectorySyncUnsupported({ code: 42 })).toBe(false);
  });
});

describe('append', () => {
  it('DF.3: creates the file, then adds to it without truncating', () => {
    nodeDurableFileSystem.append(file, 'first\n');
    nodeDurableFileSystem.append(file, 'second\n');
    expect(readFileSync(file, 'utf-8')).toBe('first\nsecond\n');
  });

  it('DF.4: a failed append throws (a missing directory is not a place to write)', () => {
    expect(() => nodeDurableFileSystem.append(join(dir, 'absent', 'x.ndjson'), 'line\n')).toThrow(/ENOENT/);
  });
});

describe('syncFile', () => {
  it('DF.5: syncs a file that is there', () => {
    writeFileSync(file, 'content\n');
    expect(() => nodeDurableFileSystem.syncFile(file)).not.toThrow();
  });

  it('DF.6: throws when the file is gone, rather than reporting a sync it did not do', () => {
    // The distinction matters: a best-effort sync that answers "fine" for a file
    // that does not exist is how a write path reports durability it never had.
    expect(() => nodeDurableFileSystem.syncFile(join(dir, 'missing.ndjson'))).toThrow(/ENOENT/);
  });
});

describe('syncDirectory', () => {
  it('DF.7: syncs a real directory', () => {
    writeFileSync(file, 'content\n');
    expect(() => nodeDurableFileSystem.syncDirectory(dir)).not.toThrow();
  });

  it('DF.8: a directory that is not there is a failure, not a limitation', () => {
    expect(() => nodeDurableFileSystem.syncDirectory(join(dir, 'absent'))).toThrow(/ENOENT/);
  });
});

describe('needsSeparator', () => {
  it('DF.9: only a file that ends mid-line owes a separator', () => {
    expect(nodeDurableFileSystem.needsSeparator(file), 'absent').toBe(false);

    writeFileSync(file, '');
    expect(nodeDurableFileSystem.needsSeparator(file), 'empty').toBe(false);

    writeFileSync(file, 'complete line\n');
    expect(nodeDurableFileSystem.needsSeparator(file), 'clean tail').toBe(false);

    writeFileSync(file, 'complete line\n{"id":"tor');
    expect(nodeDurableFileSystem.needsSeparator(file), 'torn tail').toBe(true);
  });

  it('DF.10: a file that cannot be opened has no tail to continue', () => {
    expect(nodeDurableFileSystem.needsSeparator(join(dir, 'absent.ndjson'))).toBe(false);
  });
});

// ── The branches this platform cannot reach ─────────────────

describe('createNodeDurableFileSystem over supplied syscalls', () => {
  /** A set of syscalls that records what was asked and answers as told. */
  function scripted(overrides: Partial<NodeFileCalls>): { calls: NodeFileCalls; log: string[] } {
    const log: string[] = [];
    const calls: NodeFileCalls = {
      appendFileSync: ((..._args: unknown[]) => {
        log.push('append');
      }) as unknown as NodeFileCalls['appendFileSync'],
      openSync: ((path: string) => {
        log.push(`open:${path}`);
        return 7;
      }) as unknown as NodeFileCalls['openSync'],
      fsyncSync: ((fd: number) => {
        log.push(`fsync:${fd}`);
      }) as unknown as NodeFileCalls['fsyncSync'],
      closeSync: ((fd: number) => {
        log.push(`close:${fd}`);
      }) as unknown as NodeFileCalls['closeSync'],
      fstatSync: (() => ({ size: 4 })) as unknown as NodeFileCalls['fstatSync'],
      readSync: (() => 1) as unknown as NodeFileCalls['readSync'],
      ...overrides,
    };
    return { calls, log };
  }

  it('DF.11: a directory the platform will not open is a limitation, not a failure', () => {
    for (const code of ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']) {
      const { calls, log } = scripted({
        openSync: (() => {
          throw errnoError(code);
        }) as unknown as NodeFileCalls['openSync'],
      });
      // The write is acknowledged on such a platform. What it cannot claim is the
      // durability of the name, which the platform does not offer.
      expect(() => createNodeDurableFileSystem(calls).syncDirectory(dir), code).not.toThrow();
      expect(log).toEqual([]);
    }
  });

  it('DF.12: a directory that cannot be opened for any other reason is a failure', () => {
    const { calls } = scripted({
      openSync: (() => {
        throw errnoError('EIO');
      }) as unknown as NodeFileCalls['openSync'],
    });
    expect(() => createNodeDurableFileSystem(calls).syncDirectory(dir)).toThrow(/EIO/);
  });

  it('DF.13: a directory fsync that the platform refuses is tolerated, and the fd is still closed', () => {
    let synced = 0;
    const { calls, log } = scripted({
      fsyncSync: (() => {
        synced++;
        throw errnoError('EINVAL');
      }) as unknown as NodeFileCalls['fsyncSync'],
    });
    expect(() => createNodeDurableFileSystem(calls).syncDirectory(dir)).not.toThrow();
    expect(synced).toBe(1);
    expect(log).toEqual([`open:${dir}`, 'close:7']);
  });

  it('DF.14: a directory fsync that fails for any other reason propagates, with the fd closed', () => {
    let synced = 0;
    const { calls, log } = scripted({
      fsyncSync: (() => {
        synced++;
        throw errnoError('ENOSPC');
      }) as unknown as NodeFileCalls['fsyncSync'],
    });
    expect(() => createNodeDurableFileSystem(calls).syncDirectory(dir)).toThrow(/ENOSPC/);
    // A leaked descriptor per failed write is how a store under pressure runs out
    // of them, which is a second failure caused by the first.
    expect(synced).toBe(1);
    expect(log).toEqual([`open:${dir}`, 'close:7']);
  });

  it('DF.15: a file sync that fails still closes the descriptor', () => {
    let synced = 0;
    const { calls, log } = scripted({
      fsyncSync: (() => {
        synced++;
        throw errnoError('EIO');
      }) as unknown as NodeFileCalls['fsyncSync'],
    });
    expect(() => createNodeDurableFileSystem(calls).syncFile(file)).toThrow(/EIO/);
    expect(synced).toBe(1);
    expect(log).toEqual([`open:${file}`, 'close:7']);
  });

  it('DF.16: a read that returns nothing is not a torn tail', () => {
    const { calls } = scripted({ readSync: (() => 0) as unknown as NodeFileCalls['readSync'] });
    // Guessing "torn" here would put a blank line at the head of every segment on
    // a medium whose reads do not return what was asked for.
    expect(createNodeDurableFileSystem(calls).needsSeparator(file)).toBe(false);
  });

  it('DF.17: append is delegated verbatim, with the encoding that keeps lines byte-exact', () => {
    const seen: unknown[][] = [];
    const { calls } = scripted({
      appendFileSync: ((...args: unknown[]) => {
        seen.push(args);
      }) as unknown as NodeFileCalls['appendFileSync'],
    });
    createNodeDurableFileSystem(calls).append(file, 'line\n');
    expect(seen).toEqual([[file, 'line\n', 'utf-8']]);
  });
});

// ── Descriptors ─────────────────────────────────────────────

describe('descriptor ownership', () => {
  const PROC_FD = '/proc/self/fd';
  const hasProc = existsSync(PROC_FD);

  it.skipIf(!hasProc)('DF.18: needsSeparator closes what it opens, every time', () => {
    // A helper asked once per segment that leaks one descriptor per call is a
    // store that dies after a few thousand rotations, on the day it has the most
    // segments. The only observable is the descriptor table.
    writeFileSync(file, 'line\n');
    const before = readdirSync(PROC_FD).length;
    for (let i = 0; i < 200; i++) {
      expect(nodeDurableFileSystem.needsSeparator(file)).toBe(false);
    }
    // One or two either way: the reading itself opens the directory.
    expect(readdirSync(PROC_FD).length - before).toBeLessThan(3);
  });

  it.skipIf(!hasProc)('DF.19: a failed sync still gives the descriptor back', () => {
    writeFileSync(file, 'line\n');
    const before = readdirSync(PROC_FD).length;
    for (let i = 0; i < 50; i++) {
      expect(() => nodeDurableFileSystem.syncFile(join(dir, 'absent.ndjson'))).toThrow(/ENOENT/);
    }
    expect(readdirSync(PROC_FD).length - before).toBeLessThan(3);
  });
});

describe('the empty-file answer', () => {
  it('DF.20: an empty file is answered from its size, without reading it', () => {
    // `fstat` already said there is nothing there. Reading at position -1 (what an
    // omitted guard would do) asks the descriptor for its current offset, which
    // happens to return nothing as well — so the guard is invisible to a test that
    // only checks the answer. It is visible to one that counts the reads.
    writeFileSync(file, '');
    let reads = 0;
    const calls: NodeFileCalls = {
      ...nodeFileCalls,
      fstatSync: (() => ({ size: 0 })) as unknown as NodeFileCalls['fstatSync'],
      readSync: ((..._args: unknown[]) => {
        reads++;
        return 1;
      }) as unknown as NodeFileCalls['readSync'],
    };
    expect(createNodeDurableFileSystem(calls).needsSeparator(file)).toBe(false);
    expect(reads).toBe(0);
  });
});
