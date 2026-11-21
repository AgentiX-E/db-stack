/**
 * AC 84 — the failure arms no runner can reach, written as functions.
 *
 * Five call sites needed "the names in this directory, or nothing", "is this a file",
 * "when was it written", "remove it if you can". Each carried its own `try`/`catch`,
 * and each `catch` was a branch nobody could execute: `readdir` on the store's own
 * directory fails when it has been unmounted, `unlink` fails when the medium is
 * read-only, and a runner that deletes as root can produce neither. A branch that
 * cannot be run is a branch nobody has checked — the same structure that let five
 * mutants survive in the write path before it became a port.
 *
 * So the answers are functions with names, and the ones that cannot be produced by
 * the file system are handed their failure directly: an errno, or an injected
 * `unlink`/`remove` that refuses. That is not a mock of the thing under test — the
 * decision *is* the thing under test, and this is the only way to ask it a question.
 *
 * What each case is for:
 *
 *   UA.1  listing a directory answers names, or `null` when it cannot look
 *   UA.2  only a file is a file: a directory and a missing path are not
 *   UA.3  a missing path has no mtime, and a written one has
 *   UA.4  removing reports whether it went
 *   UA.5  a removal that is refused is not a failure, and one that fails is not a refusal
 *   UA.6  the same distinction for the identity-checked unlink
 *   UA.7  the abandoned-archive sweep removes its own garbage and nothing else
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fileIdentity,
  isRegularFile,
  listDirectory,
  mtimeOf,
  removeFile,
  sweepAbandonedArchives,
  unlinkIfUnchanged,
} from '../impl/FileAuditStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac84-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('AC 84 — failure arms as functions', () => {
  it('UA.1: listing a directory answers names, or null when it cannot look', () => {
    writeFileSync(join(dir, 'a'), '');
    writeFileSync(join(dir, 'b'), '');

    expect(listDirectory(dir)?.sort()).toEqual(['a', 'b']);
    // Gone, unmounted, a file where a directory was expected — all the same answer
    // to a caller that has to keep working: there is nothing to be had from it.
    expect(listDirectory(join(dir, 'missing'))).toBeNull();
    expect(listDirectory(join(dir, 'a'))).toBeNull();
  });

  it('UA.2: only a file is a file — a directory and a missing path are not', () => {
    writeFileSync(join(dir, 'segment.ndjson'), 'x');
    mkdirSync(join(dir, 'segment.ndjson.gz'));

    expect(isRegularFile(join(dir, 'segment.ndjson'))).toBe(true);
    // The case that mattered: a directory sharing an archive's name must not stand in
    // for it, or the complete segment beside it goes unread.
    expect(isRegularFile(join(dir, 'segment.ndjson.gz'))).toBe(false);
    // And the race the guard exists for: the name was in the listing a moment ago.
    expect(isRegularFile(join(dir, 'retired.ndjson.gz'))).toBe(false);
  });

  it('UA.3: a missing path has no mtime, and a written one has', () => {
    const path = join(dir, 'segment.ndjson');
    writeFileSync(path, 'x');

    expect(mtimeOf(path)).toBeTypeOf('number');
    expect(mtimeOf(join(dir, 'missing.ndjson'))).toBeNull();
  });

  it('UA.4: removing reports whether it went', () => {
    const path = join(dir, 'gone.ndjson');
    writeFileSync(path, 'x');

    expect(removeFile(path)).toBe(true);
    // A second removal has nothing to do and says so, rather than throwing at a
    // sweep that is already running.
    expect(removeFile(path)).toBe(false);
    expect(listDirectory(dir)).toEqual([]);
  });

  it('UA.5: a refused removal is not a failure, and a failing one is not a refusal', () => {
    // Every refusal, handed over directly: a runner that deletes as root can produce
    // none of them, and each one must be "leave it for the next sweep".
    for (const code of ['ENOENT', 'EISDIR', 'EPERM', 'EACCES']) {
      expect(
        removeFile(join(dir, 'x'), () => {
          throw errno(code);
        }),
      ).toBe(false);
    }

    // Anything else is a removal that did not happen for a reason the caller has to
    // see: reporting it as "nothing to delete" is how evidence sits past its
    // retention while the report says it expired.
    expect(() =>
      removeFile(join(dir, 'x'), () => {
        throw errno('EIO');
      }),
    ).toThrow(/EIO/);
    expect(() =>
      removeFile(join(dir, 'x'), () => {
        throw new Error('not an errno');
      }),
    ).toThrow(/not an errno/);
  });

  it('UA.6: the same distinction for the identity-checked unlink', () => {
    const path = join(dir, 'segment.ndjson');
    writeFileSync(path, 'x');
    const identity = fileIdentity(path)!;

    // A refusal: something else got there first, or this process may not delete it.
    expect(
      unlinkIfUnchanged(path, identity, () => {
        throw errno('EPERM');
      }),
    ).toBe(false);
    // A failure: it must reach the caller, because a cleanup that cannot tell the two
    // apart is a cleanup that hides an I/O error behind "already gone".
    expect(() =>
      unlinkIfUnchanged(path, identity, () => {
        throw errno('EIO');
      }),
    ).toThrow(/EIO/);

    // And the ordinary answer, with the real syscall: the file goes once.
    expect(unlinkIfUnchanged(path, identity)).toBe(true);
    expect(unlinkIfUnchanged(path, identity)).toBe(false);
    // A namesake that is not the file that was read is left alone.
    writeFileSync(path, 'x');
    expect(unlinkIfUnchanged(path, { ...identity, size: identity.size + 1 })).toBe(false);
    expect(listDirectory(dir)).toEqual(['segment.ndjson']);
  });

  it('UA.7: the abandoned-archive sweep touches its own garbage and nothing else', () => {
    writeFileSync(join(dir, 'audit-20260101-0001.ndjson'), 'entry\n');
    writeFileSync(join(dir, 'audit-20260101-0001.ndjson.gz.part'), 'half an archive');
    // Another store's partial: not this store's to remove.
    writeFileSync(join(dir, 'billing-20260101-0001.ndjson.gz.part'), 'half an archive');
    // A directory that carries a partial's name is not a partial, and a sweep is not
    // allowed to remove a tree because of a name.
    const stubborn = join(dir, 'audit-20260101-0002.ndjson.gz.part');
    mkdirSync(stubborn);
    writeFileSync(join(stubborn, 'keep'), 'x');

    expect(sweepAbandonedArchives(dir, 'audit')).toBe(1);
    expect(listDirectory(dir)?.sort()).toEqual([
      'audit-20260101-0001.ndjson',
      'audit-20260101-0002.ndjson.gz.part',
      'billing-20260101-0001.ndjson.gz.part',
    ]);

    // A directory that is gone has nothing to sweep, which is the answer an operator
    // who removed it between two rotations needs rather than an exception.
    expect(sweepAbandonedArchives(join(dir, 'missing'), 'audit')).toBe(0);
  });
});
