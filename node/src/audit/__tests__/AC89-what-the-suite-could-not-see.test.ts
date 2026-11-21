/**
 * AC 89 — the ten survivors of the mutation run, each given the observation it lacked.
 *
 * Iteration 36 measured `FileAuditStore.ts` at 95.13 % and left twenty-six mutants
 * undetected. Every one of them was then applied **exactly as the report printed it** and
 * the audit suite was run: all twenty-six stayed green. That is the honest reading of a
 * survivor — the instrument did not miss a failure, the suite did not make the
 * distinction — so each survivor now owes either an assertion that fails the moment the
 * edit is real, or an argument that no assertion can exist.
 *
 * Ten of the twenty-six are the first kind, and they are grouped here by what they have
 * in common: each is a *boundary the suite never touched*. A guard whose only observable
 * shape is `undefined`; a retention window given as `2` and never as anything but the
 * default or `0`; a claim observed only after the append that followed it; a separator
 * owed by a segment this store did *not* name; the eighth attempt and the sentence that
 * explains it; a name already durable when its data was not; and the date a prune cannot
 * read.
 *
 * What each case is for:
 *
 *   SV.1  a non-errno cannot be an errno, `undefined` included
 *   SV.2  `retentionDays` is the number it was given, not the default
 *   SV.3  the name is claimed before the first byte is appended
 *   SV.4  an adopted segment is not given a separator it did not owe
 *   SV.5  eight refusals, and a message that says what eight means
 *   SV.6  a failed sync rejects even when the name was already durable
 *   SV.7  a prune keeps what it cannot date
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_RETENTION_DAYS, FileAuditStore, isAlreadyExists } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac89-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (operation: string) => ({ operation, actor: 'user', resource: '/db', result: 'success' as const });

const segments = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.ndjson'));

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Delegates to the real filesystem and refuses one named call, the way a disk does. */
class FailingFileSystem implements DurableFileSystem {
  failOn: 'syncFile' | 'syncDirectory' | null = null;

  append(path: string, data: string): void {
    nodeDurableFileSystem.append(path, data);
  }

  syncFile(path: string): void {
    if (this.failOn === 'syncFile') {
      this.failOn = null;
      throw errno('EIO');
    }
    nodeDurableFileSystem.syncFile(path);
  }

  syncDirectory(path: string): void {
    if (this.failOn === 'syncDirectory') {
      this.failOn = null;
      throw errno('EIO');
    }
    nodeDurableFileSystem.syncDirectory(path);
  }

  needsSeparator(path: string): boolean {
    return nodeDurableFileSystem.needsSeparator(path);
  }
}

// ── The guards ──────────────────────────────────────────────

describe('AC 89 — what the suite could not see', () => {
  it('SV.1: a non-errno cannot be an errno, `undefined` included', () => {
    // `SC.1` asks this predicate about `null`, a string and a real errno. `undefined` is
    // the fourth shape, and it is the only one where the `typeof` guard changes the
    // answer: `null` is caught by the second disjunct, a string or a number answers
    // `undefined` and therefore `false`, and only `undefined` throws when the property
    // is read off it. Without the guard, a caller that caught nothing in particular
    // would be handed a `TypeError` from a predicate whose whole job is to answer.
    expect(isAlreadyExists(undefined)).toBe(false);
    expect(isAlreadyExists(null)).toBe(false);
    expect(isAlreadyExists('EEXIST')).toBe(false);
    expect(isAlreadyExists(errno('EEXIST'))).toBe(true);
  });

  // ── The configuration ─────────────────────────────────────

  it('SV.2: retentionDays is the number it was given, not the default', async () => {
    // Two days, and a segment five days old: the sweep has to take it. The suite asked
    // this question twice before — with `0` (disables) and with `90` (the default) — so a
    // store that replaced every positive value with the default answered both correctly
    // and kept the old segment in between. The window is a number, not a flag.
    const store = new FileAuditStore({ dataDir: dir, retentionDays: 2, maxFileSize: 1 });
    await store.write(entry('LIVE'));

    const old = join(dir, 'audit-20200101-0009.ndjson');
    writeFileSync(old, JSON.stringify({ id: 'old', operation: 'ANCIENT' }) + '\n');
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(old, fiveDaysAgo, fiveDaysAgo);

    // The rotation is what makes the sweep run, and `close()` is what makes it finished.
    await store.write(entry('ROTATES'));
    await store.close();

    expect(readdirSync(dir).filter((name) => name.startsWith('audit-20200101'))).toEqual([]);
    // And the file the store may still append to is untouched, whatever its age.
    expect(await store.count()).toBe(2);

    // The default is the other half of the same statement: a store given nothing keeps
    // ninety days, which is long enough that the same five-day-old segment survives.
    const second = new FileAuditStore({ dataDir: dir, maxFileSize: 1 });
    const kept = join(dir, 'audit-20200101-0008.ndjson');
    writeFileSync(kept, JSON.stringify({ id: 'kept', operation: 'RECENT' }) + '\n');
    utimesSync(kept, fiveDaysAgo, fiveDaysAgo);
    await second.write(entry('ROTATES_AGAIN'));
    await second.close();
    expect(DEFAULT_RETENTION_DAYS).toBeGreaterThan(5);
    expect(statSync(kept).size).toBeGreaterThan(0);
  });

  it('SV.3: the name is claimed before the first byte is appended', async () => {
    // The claim is the store's answer to "is this number mine", and it has to be given
    // *before* the append for the answer to mean anything. `SC.5` starts two stores
    // together and gets two segments, but each had already appended by the time the other
    // looked: the file was there because of the write, not because of the claim, so a
    // store that claimed nothing still passed. Here the second store looks *inside* the
    // first store's append — after the claim, before the bytes — which is the one moment
    // that distinguishes the two.
    let second: FileAuditStore | null = null;
    let secondWrite: Promise<string> | null = null;
    let interlaced = false;

    const opening: DurableFileSystem = {
      append(path, data) {
        if (!interlaced && second) {
          interlaced = true;
          secondWrite = second.write(entry('SECOND'));
        }
        nodeDurableFileSystem.append(path, data);
      },
      syncFile: (path) => nodeDurableFileSystem.syncFile(path),
      syncDirectory: (path) => nodeDurableFileSystem.syncDirectory(path),
      needsSeparator: (path) => nodeDurableFileSystem.needsSeparator(path),
    };

    const first = new FileAuditStore({ dataDir: dir, fileSystem: opening });
    second = new FileAuditStore({ dataDir: dir });

    await first.write(entry('FIRST'));
    await secondWrite;
    await first.close();
    await second.close();

    expect(interlaced).toBe(true);
    // Two names, one writer each. Without the claim the interlaced store reads a
    // directory that does not yet hold the first store's name, takes the same number, and
    // the two lines land in one file that each store believes it owns.
    expect(segments()).toHaveLength(2);
    const reader = new FileAuditStore({ dataDir: dir });
    expect(await reader.count()).toBe(2);
    expect(await reader.count({ operation: 'FIRST' })).toBe(1);
    expect(await reader.count({ operation: 'SECOND' })).toBe(1);
  });

  // ── The bytes ─────────────────────────────────────────────

  it('SV.4: an adopted segment is not given a separator it did not owe', async () => {
    // A separator is owed by a segment that ends *mid-line* — the signature of a run that
    // died between two writes. `DW.8` asserts the owed case and `DW.3` asserts that a
    // store's own segment gets none, which leaves the third answer unasked: a segment
    // this store adopted, which ends cleanly and therefore owes nothing. Writing the
    // separator anyway puts a blank line in the middle of a trail; the parser skips it, so
    // every assertion that reads entries back agrees, and only the bytes disagree.
    const writer = new FileAuditStore({ dataDir: dir });
    await writer.write(entry('FIRST'));
    await writer.close();

    const only = join(dir, segments()[0]!);
    const before = readFileSync(only, 'utf-8');
    expect(before.endsWith('\n')).toBe(true);

    const adopter = new FileAuditStore({ dataDir: dir });
    await adopter.write(entry('SECOND'));
    await adopter.close();

    const after = readFileSync(only, 'utf-8');
    // The same file, continued — no new name was created, which is what "adopted" means.
    expect(segments()).toHaveLength(1);
    expect(after.startsWith(before)).toBe(true);
    // And continued on the next byte, not after a blank line.
    expect(after.slice(before.length).startsWith('\n')).toBe(false);
    expect(after.split('\n')).toHaveLength(3);
    expect(await adopter.count()).toBe(2);
  });

  // ── The bound ─────────────────────────────────────────────

  it('SV.5: eight refusals, and a message that says what eight means', async () => {
    // `SC.4` asserts that the store fails and names the directory. It does not count the
    // attempts, and it does not read the second half of the message — so a loop that ran
    // nine times, or a message that stopped explaining why eight is the bound, both passed.
    // The number is a statement about the deployment: eight names taken in one millisecond
    // is not a race, it is a directory too many writers share.
    const attempts: string[] = [];
    const store = new FileAuditStore({
      dataDir: dir,
      claim: (path) => {
        attempts.push(path);
        throw errno('EEXIST');
      },
    });

    const error = await store.write(entry('NEVER')).catch((thrown: unknown) => thrown as Error);

    expect(attempts).toHaveLength(8);
    expect(readdirSync(dir)).toEqual([]);
    expect((error as Error).message).toMatch(/could not claim a segment name in .*ac89-/);
    expect((error as Error).message).toMatch(/after 8 attempts/);
    expect((error as Error).message).toMatch(/8 segments were created by other writers in the same millisecond/);
  });

  // ── The acknowledgement ───────────────────────────────────

  it('SV.6: a failed sync rejects even when the name was already durable', async () => {
    // `GC.5` fails the *second* sync of a batch, where the generation test rejects the
    // leftovers on its own. The first sync of a batch is the case that needs the count of
    // covered commits: nothing has been synced, and a commit whose segment name reached
    // the medium in an earlier flush passes the generation test while its bytes have not
    // been flushed at all. Acknowledging it is the one lie this path exists to avoid.
    const fs = new FailingFileSystem();
    const store = new FileAuditStore({ dataDir: dir, fileSystem: fs });

    await store.write(entry('WARM'));
    // Same segment, so the name is durable — the generation test cannot tell this line
    // from the warm one. Only "nothing in this batch was synced" can.
    fs.failOn = 'syncFile';
    await expect(store.write(entry('UNSYNCED'))).rejects.toThrow(/EIO/);

    // The distinction is the whole point: the line is on the disk either way, and what a
    // caller is told is whether it would survive a power cut.
    expect(await store.count({ operation: 'UNSYNCED' })).toBe(1);
  });

  // ── The prune ─────────────────────────────────────────────

  it('SV.7: a prune keeps what it cannot date', async () => {
    // A name that passes the pattern and cannot be `stat`ed: the entry is there and its
    // age is not. Deleting it would turn one failed observation into a permanent loss of
    // evidence, which is the same rule `EX.1` states for the retention sweep — a failed
    // read is not a verdict about age.
    const store = new FileAuditStore({ dataDir: dir });
    await store.write(entry('LIVE'));
    await store.close();

    const undatable = join(dir, 'audit-20200101-0002.ndjson');
    symlinkSync(join(dir, 'not-there'), undatable);

    const future = new Date(Date.now() + 60_000);
    expect(await store.pruneOlderThan(future)).toBe(0);
    expect(readdirSync(dir)).toContain('audit-20200101-0002.ndjson');
  });
});
