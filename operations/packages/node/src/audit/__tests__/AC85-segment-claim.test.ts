/**
 * AC 85 — a segment name is claimed before it is written to.
 *
 * A segment name is chosen by reading the directory and taking the next sequence
 * number. Two processes can reach that decision at the same moment, in the same
 * millisecond, from the same scan — and then both append into one file. The
 * interleaving itself is harmless (`O_APPEND` is positioned by the kernel); what is
 * not harmless is the step after it. Whoever rotates first compresses *that* segment
 * and unlinks it while the other is still writing, the other's next append recreates
 * the name, and the reader — which prefers an archive over the plain file of the same
 * name, so that a scan between the rename and the unlink cannot double-count — stops
 * seeing everything written after the archive was taken. On the disk, invisible to
 * `get()`, `query()` and `count()`.
 *
 * What each case is for:
 *
 *   SC.1  a free name is taken, a taken name is refused, and refusing is an answer
 *   SC.2  a claim that failed for another reason is thrown, not reported as taken
 *   SC.3  a refusal makes the store look again, and the name it refused stays empty
 *   SC.4  a directory where nothing can be claimed says so, and names the directory
 *   SC.5  two stores that start together get different segments — the defect, in one
 *         process, deterministically
 *   SC.6  constructing a store names nothing: an idle store leaves no empty segment
 *   SC.7  a segment an earlier run left open is continued, not claimed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimSegment, FileAuditStore, isAlreadyExists } from '../impl/FileAuditStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac85-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** The real claim, as the store uses it, for tests that inject something around it. */
const realClaim = (path: string): void => closeSync(openSync(path, 'wx'));

const entry = (operation: string) => ({ operation, actor: 'user', resource: '/db', result: 'success' as const });

describe('AC 85 — one name, one writer', () => {
  it('SC.1: a free name is taken, a taken name is refused, and refusing is an answer', () => {
    const path = join(dir, 'audit-20261117-0001.ndjson');

    expect(claimSegment(path)).toBe(true);
    // The file exists and is empty. Empty matters: the claim is the store's promise
    // that nothing else will write here, not that something already has.
    expect(statSync(path).size).toBe(0);

    expect(claimSegment(path)).toBe(false);
    // And it refused without touching what was there.
    expect(statSync(path).size).toBe(0);

    // The distinction the whole gate rests on: EEXIST is an answer, everything else
    // is a failure, and the four shapes a failure can arrive in are all asked.
    expect(isAlreadyExists(errno('EEXIST'))).toBe(true);
    expect(isAlreadyExists(errno('EIO'))).toBe(false);
    expect(isAlreadyExists(null)).toBe(false);
    expect(isAlreadyExists('EEXIST')).toBe(false);
  });

  it('SC.2: a claim that failed for another reason is thrown, not reported as taken', () => {
    // The failure mode this excludes: a `catch` that treats one errno as "somebody
    // else has it" would retry eight times and then accuse its peers of a disk error.
    expect(() =>
      claimSegment(join(dir, 'x.ndjson'), () => {
        throw errno('ENOSPC');
      }),
    ).toThrow(/ENOSPC/);

    // A claim that throws something without a code is a failure too, not a name
    // collision with an unexplained cause.
    expect(() =>
      claimSegment(join(dir, 'y.ndjson'), () => {
        throw new Error('no errno at all');
      }),
    ).toThrow(/no errno at all/);
  });

  it('SC.3: a refusal makes the store look again, and never writes into the file that won', async () => {
    // A lost race leaves the winner's file behind — that is what `EEXIST` *means* —
    // so the refusal is simulated by creating the file and then failing the claim.
    // The loser must move on, and the assertion that matters is not that it picked a
    // different number but that it wrote nothing into `…-0001`.
    //
    // The names below carry a date, and the store takes that date from the clock.
    // Asserting on it without freezing the clock made this case pass until the first
    // UTC midnight after the name was typed and fail forever after — which is what
    // happened on 2026-11-18. Only `Date` is faked: the store flushes through
    // `setImmediate`, and faking that would hold the flush open.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    let refusals = 0;
    try {
      const store = new FileAuditStore({
        dataDir: dir,
        claim: (path) => {
          if (refusals === 0) {
            refusals += 1;
            realClaim(path);
            throw errno('EEXIST');
          }
          realClaim(path);
        },
      });

      await store.write(entry('AFTER_A_REFUSAL'));
      await store.close();

      expect(refusals).toBe(1);
      expect(await store.count()).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    const segments = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .sort();
    expect(segments).toEqual(['audit-20261117-0001.ndjson', 'audit-20261117-0002.ndjson']);
    // The name that beat it is still empty, because somebody else owns it.
    expect(statSync(join(dir, 'audit-20261117-0001.ndjson')).size).toBe(0);
    expect(statSync(join(dir, 'audit-20261117-0002.ndjson')).size).toBeGreaterThan(0);
  });

  it('SC.4: a directory where nothing can be claimed says so, and names the directory', async () => {
    const store = new FileAuditStore({
      dataDir: dir,
      claim: () => {
        throw errno('EEXIST');
      },
    });

    // Eight refusals are not a transient collision, they are a directory that more
    // processes are writing than it can serve — and the message has to say where.
    await expect(store.write(entry('NEVER'))).rejects.toThrow(new RegExp(`could not claim a segment name in .*ac85-`));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('SC.5: two stores that start together get different segments', async () => {
    // Both constructed before either writes, so each has the same empty directory to
    // look at and each would pick `…-0001`. This is the whole defect in one process,
    // with no timing to arrange: before the claim, the second store's line went into
    // the first store's file, and the first store's rotation archived it.
    const first = new FileAuditStore({ dataDir: dir, maxFileSize: 1 });
    const second = new FileAuditStore({ dataDir: dir, maxFileSize: 1 });

    for (let i = 0; i < 4; i++) {
      await first.write(entry(`FIRST_${i}`));
      await second.write(entry(`SECOND_${i}`));
    }
    await first.close();
    await second.close();

    // Eight writes and a rotation per write: eight logical segments, none shared.
    const logical = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz'))
      .map((f) => f.replace(/\.gz$/, ''));
    expect(logical).toHaveLength(8);
    expect(new Set(logical).size).toBe(8);

    // The point of disjoint names: nothing was written into a file the other store had
    // already rotated away from, so a third store that knows nothing about either
    // reads all eight entries.
    const reader = new FileAuditStore({ dataDir: dir });
    expect(await reader.count()).toBe(8);
    expect(await reader.count({ operation: 'FIRST_3' })).toBe(1);
    expect(await reader.count({ operation: 'SECOND_3' })).toBe(1);
  });

  it('SC.6: constructing a store names nothing, so an idle store leaves no empty segment', () => {
    // The previous shape named the segment in the constructor, which meant an empty
    // file in a directory nobody had written to — and, worse, a name chosen before it
    // was needed, so it could already be stale by the time it was created.
    const store = new FileAuditStore({ dataDir: dir });
    void store;
    expect(readdirSync(dir)).toEqual([]);
  });

  it('SC.7: a segment an earlier run left open is continued, not claimed', async () => {
    // A killed process leaves a segment ending mid-trail. The store that comes after
    // it appends to that file, and does not try to claim it: a name that already
    // exists cannot be claimed, and a restart that started a new segment would put a
    // second file between two lines that belong together.
    const leftover = join(dir, 'audit-20260101-0007.ndjson');
    writeFileSync(leftover, JSON.stringify({ id: 'left', fragment: true }) + '\n');

    const store = new FileAuditStore({ dataDir: dir });
    await store.write(entry('CONTINUED'));
    await store.close();

    expect(readdirSync(dir).filter((f) => f.endsWith('.ndjson'))).toEqual(['audit-20260101-0007.ndjson']);
    expect(await store.count()).toBe(2);
  });
});
