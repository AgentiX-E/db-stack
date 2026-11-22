/**
 * The survivors of `FileAuditStore.ts`'s fourth mutation run, read one by one.
 *
 * The run that iteration 64 left behind measured the file at 93.94 % with **38** mutants
 * surviving and 7 the suite never reached — the lowest score of the sixteen files under
 * mutation, in the one file whose whole purpose is to make tampering provable. `AC 89`
 * had argued ten survivors from iteration 36; the file has grown a chain, group commit,
 * archive publication and a repair table since, and nothing recounted the rest.
 *
 * Reading them was worth more than the score, as it has been every time: the report
 * pointed at the body of `verify()` — seventeen lines where *every* arm's replacement
 * produced a report no assertion looked at. `AC 95` is the result. Of the forty-five the
 * iteration-64 report carried for this file — thirty-eight survivors and seven lines no
 * test had executed — twenty-four are closed, twenty-two of them by a case. The
 * twenty-one remaining are the residue, each with the property that makes the mutant
 * invisible: sixteen asserted by a case here, five argued below.
 *
 * Killed by `AC 95` (see that file for the case behind each):
 *
 *   `newestOpenSegment`: `names.includes(name + '.gz')` → `false`, and the template → `''`
 *   `unlinkIfUnchanged`: the identity comparison → `false` (two arms, two cases)
 *   `verify()`: `tornTail` initial → `true`, `unterminated` → `true`, the `&&`/`||` of
 *       `!endsWithNewline && last`, `last` → `true`, the trim guard → `false`, the parsed
 *       line → any text, the unparsable position (empty object, empty template, `i - 1`),
 *       the legacy export's `catch` and its `where`, `unreadable` for a missing directory,
 *       and the `flush()` that starts it
 *   `readSegment`: the `?? ''` and the `catch`'s `return ''` — the two mutants this
 *       iteration *deleted* rather than excused, because the collapse of `null` into `''`
 *       was a false attestation: a trail whose only segment could not be decoded
 *       verified as `ok: true, entries: 0`
 *
 * Argued as equivalent — the twenty-one that remain, each named with the property that
 * makes two different programs produce one behaviour:
 *
 *   SA.1  the canary in a `?? []` fallback is filtered by the prefix test — `sweepAbandonedArchives`
 *   SA.2  a directory that does not exist yet starts at 0001 — the `?? []` in `getNextSequence`
 *   SA.3  rotating before the first claim is a no-op, because there is no file — two mutants
 *   SA.4  `plain-missing` never reaches the sweep: a pair needs a plain name to exist
 *   SA.5  in the live path the two verdicts that reach `promote` as `none` are `no-twin`,
 *         which the guard above excludes, and an unreadable plain file, which a runner
 *         running as the owner cannot produce
 *   SA.6  the trailing empty string is skipped, so popping it changes nothing — three mutants
 *         (`endsWith` → `startsWith`, the `if`, and the `pop` itself)
 *   SA.7  a flush of an empty queue is a no-op, so a second schedule costs a turn — two
 *         mutants — and the empty-batch guard it would then take is the same no-op
 *   SA.8  `synced` starts at a value no path can equal
 *   SA.9  a batch's highest generation is at least one, so `-1` and `+1` compare alike
 *   SA.10 any text that is not NDJSON contributes no entries — two mutants, the `.json`
 *         branch and the segment branch
 *
 * Five more are argued rather than exercised, and they are the five the maturity table
 * already carries for this file:
 *
 *   `name > newest` → `>=` — `readdir` cannot return one name twice, so the two
 *   comparisons select the same name. The duplicate case in `SR.1` is the closest an
 *   assertion can come, and both arms answer it the same way.
 *   `this.activeFilePath = ''` in `rotate` and in `releaseActiveFile` → any text — the name
 *   is re-derived by the claim the next append makes before it uses one, and no public
 *   method can run between the assignment and that claim.
 *   `if (!fileIdentity(oldPath)) return` in `rotate` → `false` — the compression it would
 *   then schedule reads an identity that is gone and refuses, its rejection is caught, and
 *   the sweep in its `finally` is by age. The only difference is a wasted job.
 *   `'at-rest'` → `''` in the sweep's call to `repairFor` — the function asks
 *   `when === 'live'`, so every value that is not the word `live` takes the at-rest path;
 *   the parameter is two names for the reader, not a discriminant at runtime.
 *
 * Iteration 66 added `pruneSegments` — the prune that reads a segment and records its
 * floor before unlinking it — and read its survivors the same way. Nine of that method's
 * mutants were closed rather than argued: two guards were deleted because nothing they
 * skipped could be observed (`candidates.length === 0`, and `prunable.length === 0`
 * followed by a loop over an empty list), `AN.25` kills the pair that let a damaged
 * anchor block a segment which records nothing, `AN.26` kills the `{}` that dropped the
 * unparsable positions and the arrow that returned `undefined`, and the position string
 * itself moved into `unparsableAt`, which `AC 95` already asserts — one function for the
 * reader that prints a position and the prune that only counts it. The file measures
 * **97.23 %** (765 killed, 6 timeout, 22 survived, **0 uncovered**), and one survivor is
 * new:
 *
 *   SA.11 a canary in `prunable` is removed by a `remove` that refuses a path it cannot
 *         find, so the count and the directory are the same either way
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileAuditStore, repairFor, shadowedPairs, sweepAbandonedArchives } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';
import type { TwinVerdict } from '../impl/FileAuditStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AC 95 — the survivors, and why no case exists', () => {
  it('SA.1: the canary in a fallback list is filtered by the prefix, so no fallback can be seen', () => {
    // `const names = listDirectory(directory) ?? []` → `?? ['Stryker was here']` survives
    // `sweepAbandonedArchives`, and the reason is the first line of the loop: a name that
    // does not begin with `<prefix>-` is not this store's. The canary is one of those, so
    // every fallback value behaves like the empty list — which is what the fallback means.
    expect(sweepAbandonedArchives(join(dir, 'never-created'), 'audit')).toBe(0);
    // And the same for a directory that does exist and holds a name of another store.
    writeFileSync(join(dir, 'other-20260101-0001.ndjson.gz.part'), 'x');
    writeFileSync(join(dir, 'audit-20260101-0001.ndjson.gz.part'), 'x');
    expect(sweepAbandonedArchives(dir, 'audit')).toBe(1);
    expect(readdirSync(dir)).toEqual(['other-20260101-0001.ndjson.gz.part']);
  });

  it('SA.2: a directory that does not exist yet starts at 0001', async () => {
    // The `?? []` in `getNextSequence` answers "no names to avoid", and the fallback's
    // content cannot be observed for the reason `SA.1` gives: an entry has to match the
    // segment pattern to change the number, and the canary does not. What the fallback
    // *protects* is the first number in a directory that has just been created — the
    // store makes it, lists it, and names `-0001`.
    const store = new FileAuditStore({ dataDir: join(dir, 'not-there-yet') });
    await store.write({ operation: 'FIRST', actor: 'a', resource: 'r', result: 'success' });
    await store.close();

    const segments = readdirSync(join(dir, 'not-there-yet')).filter((f) => f.endsWith('.ndjson'));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(/-0001\.ndjson$/);
  });

  it('SA.3: rotating before the first claim is a no-op, because there is no file to rotate', async () => {
    // `if (!this.activeSegmentClaimed) return false` → `false`, and its `return false` →
    // `true`. Both reach `rotate()` on an unclaimed store, whose first statement reads the
    // identity of a path that is `''`: absent, so it returns before scheduling anything.
    // The state `rotate()` would then clear is the state it is already in.
    const store = new FileAuditStore({ dataDir: dir, maxAgeMs: 1, maxFileSize: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Every condition `shouldRotate` could consult is true here: unclaimed, over the age,
    // and the size is zero against a one-byte budget. The first line still opens one
    // segment, and it holds that line.
    await store.write({ operation: 'FIRST', actor: 'a', resource: 'r', result: 'success' });
    await store.close();
    expect(readdirSync(dir).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });

  it('SA.4: an archive with no name beside it is not a pair, so `plain-missing` never reaches the sweep', () => {
    // `else if (repair === 'promote')` → `else if (true)` in the construction sweep. The
    // branch is only wrong for a `none` verdict, and at rest `none` comes from exactly two
    // verdicts: `plain-unreadable`, which needs a file this process can see but not read,
    // and `plain-missing` — which `shadowedPairs` makes unreachable by construction: it
    // yields a name only if that name is *in the listing*, so the plain file exists.
    expect(shadowedPairs(['audit-20260101-0001.ndjson.gz'], 'audit')).toEqual([]);
    expect(shadowedPairs(['audit-20260101-0001.ndjson', 'audit-20260101-0001.ndjson.gz'], 'audit')).toEqual([
      'audit-20260101-0001.ndjson',
    ]);
    // The pair the sweep does see, with the plain file present, is exactly the pair whose
    // verdict it can act on.
    expect(repairFor('plain-missing', 'at-rest')).toBe('none');
  });

  it('SA.5: in the live path the only verdict that reaches `promote` as `none` is an unreadable one', () => {
    // `if (repair === 'promote')` → `if (true)` in the live path. Enumerating the table is
    // the proof: with an archive present (the guard above the call), the verdicts that do
    // not already have a branch of their own are `none` and `promote`, and the only
    // verdict mapping to `none` while writing is a plain file whose bytes could not be
    // read — a file that exists, is not a directory, and is refused by `readFileSync`,
    // which no process running as the owner can produce on a runner.
    const live = (
      [
        'no-twin',
        'plain-missing',
        'plain-unreadable',
        'archive-unreadable',
        'same',
        'plain-extra',
        'archive-extra',
        'disjoint',
      ] as TwinVerdict[]
    ).map((verdict) => [verdict, repairFor(verdict, 'live')] as const);
    // `no-twin` and an unreadable plain file are the two; the first cannot reach the
    // call, because the guard above it asks whether the archive is there at all — and
    // `SR.3` asserts that guard is a read the store does not make.
    expect(live.filter(([, repair]) => repair === 'none').map(([verdict]) => verdict)).toEqual([
      'no-twin',
      'plain-unreadable',
    ]);
    // `promote` itself is reachable, and is the branch that must stay guarded.
    expect(live.filter(([, repair]) => repair === 'promote').map(([verdict]) => verdict)).toEqual(['disjoint']);
  });

  it('SA.6: the trailing empty string is skipped, so popping it changes nothing', () => {
    // `lines.pop()` → `;`, `if (endsWithNewline)` → `true` / `false`, and
    // `content.endsWith('\n')` → `startsWith`. All four are the same edit in effect: the
    // final newline of a segment produces one trailing `''`, and the loop's trim guard
    // skips it whether or not it was popped. The only line whose position is consulted is
    // the last one, and `unterminated` asks about it only when the content does *not* end
    // with a newline — in which case there is no trailing `''` to pop. `VR.1` and `VR.3`
    // are the two shapes, and both are asserted there.
    const content = '{"id":"a"}\n{"id":"b"}\n';
    const popped = content.split('\n');
    popped.pop();
    const unpopped = content.split('\n');
    expect(popped.filter((line) => line.trim() !== '')).toEqual(unpopped.filter((line) => line.trim() !== ''));
    expect(unpopped.at(-1)).toBe('');
  });

  it('SA.7: a flush of an empty queue is a no-op, so a second schedule costs a turn and nothing else', async () => {
    // `if (this.flushScheduled) return` → `false`, and `this.flushScheduled = true` →
    // `false`. Both let a second `setImmediate` be scheduled for the same turn; the second
    // callback finds `pendingCommits` empty and returns. Measured: a store that has
    // closed twice syncs nothing the second time.
    let syncs = 0;
    const counting: DurableFileSystem = {
      append: (path, data) => nodeDurableFileSystem.append(path, data),
      syncFile: (path) => {
        syncs += 1;
        nodeDurableFileSystem.syncFile(path);
      },
      syncDirectory: (path) => nodeDurableFileSystem.syncDirectory(path),
      needsSeparator: (path) => nodeDurableFileSystem.needsSeparator(path),
    };

    const store = new FileAuditStore({ dataDir: dir, fileSystem: counting });
    await store.write({ operation: 'FIRST', actor: 'a', resource: 'r', result: 'success' });
    await store.close();
    const after = syncs;
    await store.close();
    expect(syncs).toBe(after);
  });

  it('SA.8: `synced` starts at a value no path can equal, so the first commit always syncs', () => {
    // `let synced = ''` → any string. The variable exists to skip a second `syncFile` for
    // consecutive lines in one segment; its initial value only has to *differ* from the
    // first commit's path, and every candidate does — a path is absolute, and no absolute
    // path is the empty string or a sentence.
    const candidates = ['', 'Stryker was here!'];
    for (const start of candidates) expect(start).not.toBe(join(dir, 'audit-20260101-0001.ndjson'));
  });

  it('SA.9: a batch cannot hold generation zero, so `-1` and `+1` answer the same question', async () => {
    // `let highest = -1` → `+1`. The value is compared with `durableDirectoryGeneration`,
    // which starts at `-1` and is raised to the highest generation synced. A commit's
    // generation is read *after* the claim that opens its segment, and the claim
    // increments it — so every generation is at least one, and `max(-1, g)` and
    // `max(1, g)` are both `g`.
    let directorySyncs = 0;
    const counting: DurableFileSystem = {
      append: (path, data) => nodeDurableFileSystem.append(path, data),
      syncFile: (path) => nodeDurableFileSystem.syncFile(path),
      syncDirectory: (path) => {
        directorySyncs += 1;
        nodeDurableFileSystem.syncDirectory(path);
      },
      needsSeparator: (path) => nodeDurableFileSystem.needsSeparator(path),
    };

    const store = new FileAuditStore({ dataDir: dir, fileSystem: counting, maxFileSize: 1 });
    // Three segments in one turn: one directory sync covers all of them.
    await Promise.all([
      store.write({ operation: 'A', actor: 'a', resource: 'r', result: 'success' }),
      store.write({ operation: 'B', actor: 'a', resource: 'r', result: 'success' }),
      store.write({ operation: 'C', actor: 'a', resource: 'r', result: 'success' }),
    ]);
    await store.close();
    expect(directorySyncs).toBe(1);
  });

  it('SA.10: any text that is not NDJSON contributes no entries', async () => {
    // `?? ''` in `scanEntries` → any text. The text reaches `JSON.parse` one line at a
    // time and the `catch` skips what it rejects; only a line that parses would differ,
    // and no replacement a mutator generates is a JSON entry. The substitution happens
    // only when the read returned `null`, which `verify()` sees before the `??` — so the
    // report names the segment whether the substitute is `''` or a sentence.
    const store = new FileAuditStore({ dataDir: dir, segmentReader: () => null });
    await store.write({ operation: 'FIRST', actor: 'a', resource: 'r', result: 'success' });
    await store.close();

    expect(await store.count()).toBe(0);
    expect(await store.query({})).toEqual([]);
    // The store did not mistake the text for an entry, and the verification names the
    // segment rather than counting it as empty.
    expect(await store.verify()).toMatchObject({ ok: false, entries: 0, unreadable: true });
  });
});
