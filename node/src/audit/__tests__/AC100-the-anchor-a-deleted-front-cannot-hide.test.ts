/**
 * AC 100 — the head of the chain, anchored so a deleted front cannot hide.
 *
 * `AC 93` proved every link that survives. `AC 95` proved what a verification can say
 * about the lines it reads, and named the one thing it deliberately did not say: a
 * pruned trail whose first remaining entry is number 40 is indistinguishable from a
 * trail whose first thirty-nine were deleted, because a chain is a statement about
 * the entries that are *present*.
 *
 * That is the deletion an unkeyed digest cannot report, and it is the one an operator
 * investigating an incident asks about first. The anchor closes it: a store records
 * the last link of every prefix it gives up, and a verification compares the first
 * survivor against that floor.
 *
 * What each case is for:
 *
 *   AN.1  a prune records the floor, and the next process verifies against it
 *   AN.2  the exit criterion: a front deleted by hand is `anchor-gap`, not `ok`
 *   AN.3  a survivor that does not name the recorded digest is `anchor-link`
 *   AN.4  an edited floor is a break — the digest in the record is read, not decorative
 *   AN.5  a trail that never pruned starts at its genesis and needs no record
 *   AN.6  a front deleted from a directory that never pruned is reported, not accused
 *   AN.7  a segment that does not verify is not given up
 *   AN.8  a segment that cannot be read is not given up
 *   AN.9  an anchor that cannot be read blocks the attestation and the prune
 *   AN.10 the floor is per writer, merged, and monotone across processes
 *   AN.11 the retention sweep records what it expires, not only `pruneOlderThan`
 *   AN.12 a malformed anchor is refused row by row, with the reason
 *   AN.13 an anchor is a function of what it holds, not of the order it was built in
 *   AN.14 the anchor is not a segment: no reader counts it, and no pattern matches it
 *   AN.15 every chained writer lands in exactly one of `anchored`, `unanchored`
 *   AN.16 the record is written whole, synced, and renamed into place
 *   AN.17 a publication that cannot reach the medium never renames
 *   AN.18 a platform that cannot sync a directory is tolerated, not fatal
 *   AN.19 a directory failure that is not a platform limitation reaches the caller
 *   AN.20 a publication that fails leaves every segment where it was
 *   AN.21 a removal refused for a reason other than refusal is reported, not thrown
 *   AN.22 a segment of unchained lines is prunable, and records no floor
 *   AN.23 a rotation over a segment that has vanished compresses nothing
 *   AN.24 every call the default port makes fails the way the syscall does
 *   AN.25 a damaged anchor does not block a segment that records nothing
 *   AN.26 a segment with a line that is not JSON is kept, and its neighbours still go
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  FileAuditStore,
  readSegmentFromDisk,
  removeIfPossible,
  segmentPattern,
  type FileAuditStoreConfig,
} from '../impl/FileAuditStore.js';
import { GENESIS_DIGEST, describeVerification, sealEntry, verifyTrail } from '../impl/auditChain.js';
import type { AuditEntry } from '../../core/types.js';
import {
  absorbPrefixes,
  anchorFileName,
  nodeAnchorCalls,
  parseAnchor,
  publishAnchor,
  renderAnchor,
  type AnchorCalls,
} from '../impl/auditAnchor.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac96-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A store whose every line rotates, so a prefix is a file the test can name. */
function open(overrides: Partial<FileAuditStoreConfig> = {}): FileAuditStore {
  // `retentionDays: 0` by default: the automatic sweep would otherwise delete the
  // segments a case is about to prune by hand, and the two paths are asserted
  // separately (AN.11 is the sweep).
  return new FileAuditStore({ dataDir: dir, maxFileSize: 1, retentionDays: 0, writerId: 'w1', ...overrides });
}

/** Write `count` entries, one segment each. */
async function fill(store: FileAuditStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.write({ operation: `op-${i}`, actor: 'alice', resource: '/db', result: 'success' });
  }
}

/** Segment names in the directory, oldest first. */
const segments = (): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz'))
    .sort();

const pathOf = (name: string): string => join(dir, name);
const anchorFile = (): string => join(dir, anchorFileName('audit'));

/** The anchor as a reader sees it: `{ writer: seq }`. */
function floors(): Record<string, number> {
  const parsed = JSON.parse(readFileSync(anchorFile(), 'utf8')) as {
    pruned: Array<{ writer: string; seq: number; hash: string }>;
  };
  return Object.fromEntries(parsed.pruned.map((row) => [row.writer, row.seq]));
}

/** The entries of one segment, whichever name it carries now. */
function entriesOf(name: string): AuditEntry[] {
  const raw = readFileSync(pathOf(name));
  const text = name.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditEntry);
}

/** A chain of `count` entries for one writer, sealed from `from` after `prev`. */
function chainOf(count: number, writer = 'w1', from = 1, prev = 'f'.repeat(64)): AuditEntry[] {
  const out: AuditEntry[] = [];
  let previous = from === 1 ? GENESIS_DIGEST : prev;
  for (let i = 0; i < count; i++) {
    const entry: AuditEntry = {
      id: `${writer}-${from + i}`,
      timestamp: '2026-01-01T00:00:00.000Z',
      operation: 'op',
      actor: 'alice',
      resource: '/db',
      result: 'success',
      severity: 'info',
    };
    entry.chain = sealEntry(entry, writer, from + i, previous);
    out.push(entry);
    previous = entry.chain.hash;
  }
  return out;
}

// ── What a prune records ────────────────────────────────────────

describe('AC 100 — a prune records what it gave up', () => {
  it('AN.1: a prune records the floor, and the next process verifies against it', async () => {
    // Nine writes, nine segments, one entry each: eight are closed and one is live.
    // The prune takes the eight it may take, and the record it leaves is what makes
    // the surviving entry checkable — it is entry nine, and entry nine was chained to
    // entry eight, which no longer exists.
    const first = open();
    await fill(first, 9);
    await first.close();

    expect(await first.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(8);
    expect(segments()).toHaveLength(1);
    expect(floors()).toEqual({ w1: 8 });

    // A new process, reading only the directory: it has never seen the eight entries
    // and does not need to. `anchored` is the number that says so.
    const second = open();
    const result = await second.verify();
    expect(result).toMatchObject({ ok: true, entries: 1, writers: 1, anchored: 1, unanchored: 0 });
    expect(result.heads).toEqual([{ writer: 'w1', seq: 9, hash: entriesOf(segments()[0]!)[0]!.chain!.hash }]);
    expect(describeVerification(result)).toBe('audit trail: 1 entries across 1 chain(s), every link holds');
    await second.close();
  });

  it('AN.2: a front deleted by hand is a gap, not an intact trail', async () => {
    // The exit criterion the roadmap names, and the hole the anchor exists to close.
    // Prune once — the record says eight entries were given up — then let the same
    // writer continue (its chain does not restart: the position is the instance's, and
    // that is why two processes never share a writer id), and delete the next two
    // segments by hand. Every surviving link holds: entry eleven continues entry ten,
    // which continues entry nine. The trail is still wrong, because the record says it
    // should resume at nine and it resumes at eleven.
    const store = open();
    await fill(store, 9);
    // `close()` here waits for the compressions rather than for the store: the same
    // writer has to keep writing after its prefix is pruned, and a prune that raced a
    // compression would be testing the scheduler.
    await store.close();
    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(8);
    await fill(store, 3);
    await store.close();

    const [nine, ten, eleven, twelve] = segments();
    expect(nine).toBeDefined();
    expect(twelve).toBeDefined();

    // Two segments gone from the front, and nothing recorded their removal.
    rmSync(pathOf(nine!));
    rmSync(pathOf(ten!));

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.entries).toBe(2);
    expect(result.firstFailure).toMatchObject({ reason: 'anchor-gap', writer: 'w1', seq: 11 });
    expect(result.unanchored).toBe(1);
    expect(describeVerification(result)).toMatch(/anchor-gap at seq 11/);
    // The entries that did survive are intact: the break is a position, not a digest.
    expect(result.chained).toBe(2);
    expect(entriesOf(eleven!).length).toBe(1);
  });

  it('AN.3: a survivor that does not name the recorded digest is a link break', async () => {
    // Same shape as AN.2, one step sharper: the first survivor is put back at the
    // position the record expects, sealed properly, but chained to a predecessor that
    // is not the entry the record gave up. A gap is a missing entry; this is the wrong
    // entry, and an implementation that only compared sequence numbers would call it
    // intact.
    const store = open();
    await fill(store, 9);
    await store.close();
    await store.pruneOlderThan(new Date(Date.now() + 60_000));
    await fill(store, 3);
    await store.close();

    const [nine, ten, eleven] = segments();
    rmSync(pathOf(nine!));
    rmSync(pathOf(ten!));

    const forged: AuditEntry = {
      id: 'forged',
      timestamp: '2026-01-01T00:00:00.000Z',
      operation: 'op-forged',
      actor: 'mallory',
      resource: '/db',
      result: 'success',
      severity: 'info',
    };
    forged.chain = sealEntry(forged, 'w1', 9, 'f'.repeat(64));
    // The survivors are archives, so the replacement is written in the form a reader
    // expects: a plain line inside a plain file would be `unreadable`, and the case
    // would pass for the wrong reason.
    writeFileSync(pathOf(eleven!), gzipSync(Buffer.from(`${JSON.stringify(forged)}\n`)));

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({ reason: 'anchor-link', writer: 'w1', seq: 9 });
    // It is the *first* failure, not the only one: the entry after it now disagrees
    // about where the sequence went, which is the chain reporting the same event.
    expect(result.failures).toBe(2);
    // And the head is counted as unaccounted for: a broken join is not an accounted one.
    expect(result).toMatchObject({ anchored: 0, unanchored: 1 });
  });

  it('AN.4: an edited floor is a break — the digest in the record is read', async () => {
    // If the anchor's hash were decoration, AN.3 would pass by accident: a check that
    // only trusts `seq` never reads a digest. One character of the recorded hash is
    // enough to prove it is compared, and it is the sharpest available statement that
    // the record is a link and not a count. Five writes, so the survivor is the entry
    // *after* the floor and the join is actually compared.
    const store = open();
    await fill(store, 5);
    await store.close();
    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(4);

    const parsed = JSON.parse(readFileSync(anchorFile(), 'utf8')) as {
      pruned: Array<{ writer: string; seq: number; hash: string }>;
    };
    const row = parsed.pruned[0]!;
    row.hash = `${row.hash.slice(0, 63)}${row.hash.endsWith('0') ? '1' : '0'}`;
    writeFileSync(anchorFile(), `${JSON.stringify(parsed, null, 2)}\n`);

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.firstFailure).toMatchObject({ reason: 'anchor-link', seq: 5 });
  });

  it('AN.5: a trail that never pruned starts at its genesis and needs no record', async () => {
    // The anchor must not turn "no prune has happened" into a finding: a store that
    // has never rotated has nothing to record, and its chain begins where every chain
    // begins.
    const store = open({ maxFileSize: 10 * 1024 * 1024 });
    await fill(store, 3);
    await store.close();

    expect(existsSync(anchorFile())).toBe(false);
    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, anchored: 1, unanchored: 0, entries: 3 });
    expect(describeVerification(result)).not.toMatch(/no record of a prune/);
  });

  it('AN.6: a front deleted from a directory that never pruned is reported, not accused', async () => {
    // The honest limit, asserted so that it is a decision rather than an oversight: a
    // directory that never wrote an anchor cannot distinguish "the first segment was
    // deleted" from "this trail is a legacy trail that starts at 41". It says so in the
    // report — `unanchored` — and it does not claim a break it cannot show. A trail
    // that must resist this needs the external witness the module documents: the daily
    // digest, a WORM bucket, a remote log.
    const store = open();
    await fill(store, 3);
    await store.close();
    rmSync(pathOf(segments()[0]!));

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, anchored: 0, unanchored: 1, failures: 0 });
    expect(result.firstFailure).toBeNull();
    expect(describeVerification(result)).toMatch(/1 of them starting above their first entry with no record/);
  });

  it('AN.7: a segment that does not verify is not given up', async () => {
    // Retention is the one operation that can destroy a break, so it must not: an
    // expired segment whose bytes no longer match its digest is evidence of the thing
    // an auditor is looking for, and a sweep that removed it would leave a trail that
    // verifies and a record that says nothing happened.
    const store = open();
    await fill(store, 2);
    await store.close();

    const [first] = segments();
    const [entry] = entriesOf(first!);
    const broken = { ...entry, actor: 'mallory' };
    // Inside the archive's own form. A plain line written into a `.gz` name would make
    // the segment *unreadable*, which is AN.8's case — and this case would then pass
    // because the store could not read the file rather than because it read it and
    // refused what it saw.
    writeFileSync(pathOf(first!), gzipSync(Buffer.from(`${JSON.stringify(broken)}\n`)));

    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(0);
    expect(existsSync(pathOf(first!))).toBe(true);
    // And nothing was recorded about it: an anchor floor for entries that are still
    // there would be a claim about a deletion that did not happen.
    expect(existsSync(anchorFile())).toBe(false);
  });

  it('AN.8: a segment that cannot be read is not given up', async () => {
    // The same rule for the other failure to observe: a segment whose bytes cannot be
    // recovered cannot be recorded, and an unrecorded removal is exactly the hole the
    // anchor exists to prevent. It stays, and `verify()` says it could not be read.
    const seeding = open();
    await fill(seeding, 3);
    await seeding.close();
    const [oldest, middle] = segments();

    const store = open({
      // The oldest segment's name, matched as a substring so that the archive of it —
      // `….ndjson.gz` — is the same segment to this reader as the plain file.
      segmentReader: (path, compressed) =>
        path.includes(oldest!.replace(/\.gz$/, '')) ? null : readSegmentFromDisk(path, compressed),
    });
    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(1);
    expect(existsSync(pathOf(oldest!))).toBe(true);
    expect(existsSync(pathOf(middle!))).toBe(false);

    const result = await store.verify();
    expect(result).toMatchObject({ ok: false, unreadable: true });
  });

  it('AN.9: an anchor that cannot be read blocks the attestation and the prune', async () => {
    // A verification that cannot read the record of its own deletions has not verified
    // the beginning of anything, and a prune that cannot add to that record would make
    // the hole wider. Both refuse, and the sentence names the file's role rather than
    // its contents.
    const store = open();
    await fill(store, 3);
    await store.close();
    writeFileSync(anchorFile(), 'not an anchor');

    const result = await store.verify();
    expect(result).toMatchObject({ ok: false, anchorUnreadable: true });
    expect(describeVerification(result)).toBe(
      'audit trail: the anchor cannot be read — what this directory pruned is unknown',
    );

    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(0);
    expect(segments()).toHaveLength(3);
  });

  it('AN.10: the floor is per writer, merged, and monotone across processes', async () => {
    // Two writers, one directory, two processes and two prunes. The second prune must
    // not lose what the first recorded for a writer it never saw — a record that only
    // remembers the last process is a record that forgets every deletion before it.
    const first = open({ writerId: 'w1' });
    await fill(first, 4);
    await first.close();
    expect(await first.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(3);
    expect(floors()).toEqual({ w1: 3 });

    const second = open({ writerId: 'w2' });
    await fill(second, 3);
    await second.close();
    // w1's fourth entry was in the segment w2 adopted and rotated; w2's first two are
    // in the segments a second prune may take.
    expect(await second.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(3);
    expect(floors()).toEqual({ w1: 4, w2: 2 });

    const parsed = JSON.parse(readFileSync(anchorFile(), 'utf8')) as { pruned: unknown[] };
    expect(parsed.pruned).toHaveLength(2);

    // Nothing left to take, and the record does not move.
    expect(await second.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(0);
    expect(floors()).toEqual({ w1: 4, w2: 2 });

    const result = await second.verify();
    expect(result).toMatchObject({ ok: true, anchored: 1, unanchored: 0 });
  });

  it('AN.11: the retention sweep records what it expires', async () => {
    // `pruneOlderThan` is the path an operator calls; `sweepExpiredSegments` is the one
    // that runs by itself after a rotation. A record written by only one of them is a
    // record that is absent exactly when nobody was watching.
    //
    // The second store is a second writer — the position of a chain belongs to the
    // instance that sealed it, so a restarted process with the same id would start a
    // second chain at 1, which is a rewind rather than a continuation.
    const seeding = open({ retentionDays: 0 });
    await fill(seeding, 3);
    await seeding.close();
    const [oldest, middle, live] = segments();
    const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(pathOf(oldest!), longAgo, longAgo);
    utimesSync(pathOf(middle!), longAgo, longAgo);

    const store = open({ retentionDays: 1, writerId: 'w2' });
    await fill(store, 1);
    await store.close();

    expect(existsSync(pathOf(oldest!))).toBe(false);
    expect(existsSync(pathOf(middle!))).toBe(false);
    expect(floors()).toEqual({ w1: 2 });

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, anchored: 2, unanchored: 0 });
    expect(result.entries).toBe(2); // w1's third entry, which was live, and w2's first
    // Two names left: the live segment was rotated into an archive by the write that
    // triggered the sweep, and being young it is not a candidate — only the aged pair
    // went.
    expect(segments()).toHaveLength(2);
    expect(existsSync(pathOf(`${live!}.gz`))).toBe(true);
  });
});

// ── The record itself ───────────────────────────────────────────

describe('AC 100 — the record is refused row by row', () => {
  it('AN.12: a malformed anchor names what is wrong with it', () => {
    // Every row is a claim about a chain's position. A reader that skipped the one it
    // could not parse would verify against a floor it only partly knows, and the row it
    // skipped is the one that would have named the missing entries.
    const good = { writer: 'w1', seq: 4, hash: 'a'.repeat(64) };
    const row = (overrides: Record<string, unknown>): string =>
      JSON.stringify({ version: 1, generatedAt: 'now', pruned: [{ ...good, ...overrides }] });

    const cases: Array<[string, RegExp]> = [
      ['', /not JSON/],
      ['[]', /not an object/],
      // `null` and a bare string are the two shapes that reach the object guard by a
      // different door than an array: `typeof null` is `'object'`, and a string is not.
      ['null', /not an object/],
      ['"an anchor"', /not an object/],
      ['{"version":2,"pruned":[]}', /version 2/],
      ['{"version":1}', /no `pruned` array/],
      [JSON.stringify({ version: 1, pruned: [42] }), /a pruned row is not an object/],
      [JSON.stringify({ version: 1, pruned: [null] }), /a pruned row is not an object/],
      [row({ writer: '' }), /no writer/],
      // Not a string at all: the `typeof` half of the guard, which a row of JSON `null`
      // reaches and an empty string does not.
      [row({ writer: 5 }), /no writer/],
      [row({ seq: 0 }), /not a position/],
      [row({ seq: 1.5 }), /not a position/],
      // A number written as a string is the shape a bucket export produces, and it is a
      // position this reader cannot compare.
      [row({ seq: '4' }), /not a position/],
      [row({ hash: 'zz' }), /no digest/],
      [row({ hash: 5 }), /no digest/],
      // A one-element array of 64 hex digits: `RegExp.test` coerces it to that very string,
      // so the reader that skipped the type check would accept an array as a digest.
      [row({ hash: ['a'.repeat(64)] }), /no digest/],
    ];
    for (const [text, expected] of cases) {
      expect(() => parseAnchor(text), text).toThrow(expected);
    }
    expect(parseAnchor(row({})).get('w1')).toEqual(good);
    // The first position is a position: a reader that refused it would refuse every
    // anchor written after a single entry was pruned, which is the smallest anchor there is.
    expect(parseAnchor(row({ seq: 1 })).get('w1')).toEqual({ ...good, seq: 1 });

    // Two rows for one writer are a file written by hand or by two processes, and the
    // higher floor wins whichever order they were appended in: a reader that took the
    // last row would move the floor *backwards* half the time.
    const both = (first: number, second: number): string =>
      JSON.stringify({
        version: 1,
        pruned: [
          { ...good, seq: first },
          { ...good, seq: second, hash: 'b'.repeat(64) },
        ],
      });
    expect(parseAnchor(both(6, 2)).get('w1')).toEqual({ ...good, seq: 6 });
    expect(parseAnchor(both(2, 6)).get('w1')).toEqual({ ...good, seq: 6, hash: 'b'.repeat(64) });
    // And the same position twice: the first row stands, because a floor is not a
    // tie-break and nothing in the file can make one row "more recent" than the other.
    expect(parseAnchor(both(6, 6)).get('w1')).toEqual({ ...good, seq: 6 });
  });

  it('AN.13: an anchor is a function of what it holds, not of the order it was built in', () => {
    // Two directories with the same floors produce the same bytes, which is what makes
    // a diff of two anchors mean something, and what makes the write idempotent under
    // two pruners that recorded the same deletions in a different order.
    const built = new Map<string, { writer: string; seq: number; hash: string }>();
    absorbPrefixes(built, [
      { writer: 'w2', seq: 7, hash: 'b'.repeat(64) },
      { writer: 'w1', seq: 4, hash: 'a'.repeat(64) },
    ]);
    const reversed = new Map<string, { writer: string; seq: number; hash: string }>();
    absorbPrefixes(reversed, [
      { writer: 'w1', seq: 4, hash: 'a'.repeat(64) },
      { writer: 'w2', seq: 7, hash: 'b'.repeat(64) },
    ]);
    const at = '2026-11-22T00:00:00.000Z';
    expect(renderAnchor(built, at)).toBe(renderAnchor(reversed, at));
    expect([...parseAnchor(renderAnchor(built, at)).keys()]).toEqual(['w1', 'w2']);

    // The floor only rises, and a merge that changes nothing says so — that answer is
    // what lets a sweep skip the write.
    expect(absorbPrefixes(built, [{ writer: 'w1', seq: 3, hash: 'c'.repeat(64) }])).toBe(false);
    expect(built.get('w1')!.seq).toBe(4);
    // The same position with a different digest is a record somebody edited, and the
    // floor does not move for it: a prune is not a repair, and a merge that accepted it
    // would let the last process to run decide what the earlier one gave up.
    expect(absorbPrefixes(built, [{ writer: 'w1', seq: 4, hash: 'e'.repeat(64) }])).toBe(false);
    expect(built.get('w1')!.hash).toBe('a'.repeat(64));
    expect(absorbPrefixes(built, [{ writer: 'w1', seq: 9, hash: 'd'.repeat(64) }])).toBe(true);
    expect(built.get('w1')).toEqual({ writer: 'w1', seq: 9, hash: 'd'.repeat(64) });
  });

  it('AN.14: the anchor is not a segment, and no reader counts it as one', async () => {
    // The file lives in the directory the store scans, so the whole design depends on
    // every reader knowing it is not a segment: `query()`, `count()` and `verify()`
    // would each report an extra line, and a prune would eventually delete it or a
    // rotation would archive it.
    const store = open();
    await fill(store, 4);
    await store.close();
    await store.pruneOlderThan(new Date(Date.now() + 60_000));

    expect(existsSync(anchorFile())).toBe(true);
    expect(segmentPattern('audit').test(anchorFileName('audit'))).toBe(false);
    expect(await store.count()).toBe(1);
    expect(await store.query({})).toHaveLength(1);
    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, entries: 1, unchained: 0, failures: 0 });
  });
});

// ── Publishing the record ───────────────────────────────────────

/**
 * A port that does what the real one does, and says so.
 *
 * The three arms these cases reach cannot be produced on a runner that runs as root:
 * a directory that cannot be opened for syncing, a platform that refuses to sync one,
 * and a medium that fails half way through a publication. Handing `publishAnchor` a
 * port is how they become assertions rather than comments.
 */
function port(overrides: Partial<AnchorCalls> = {}): { calls: AnchorCalls; steps: string[] } {
  const steps: string[] = [];
  const base: AnchorCalls = {
    open: (path, flags) => {
      steps.push(`open:${flags}`);
      return nodeAnchorCalls.open(path, flags);
    },
    write: (descriptor, text) => {
      steps.push('write');
      nodeAnchorCalls.write(descriptor, text);
    },
    sync: (descriptor) => {
      steps.push('sync');
      nodeAnchorCalls.sync(descriptor);
    },
    close: (descriptor) => {
      steps.push('close');
      nodeAnchorCalls.close(descriptor);
    },
    rename: (from, to) => {
      steps.push('rename');
      nodeAnchorCalls.rename(from, to);
    },
  };
  return { calls: { ...base, ...overrides }, steps };
}

/** An errno a case can hand to a port. */
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('AC 100 — publishing the record', () => {
  it('AN.16: the anchor is written whole, synced, and renamed into place', () => {
    const target = anchorFile();
    const text = renderAnchor(new Map([['w1', { writer: 'w1', seq: 4, hash: 'a'.repeat(64) }]]), 'now');
    const { calls, steps } = port();
    publishAnchor(target, text, calls);

    // Two syncs and the order: the file's bytes reach the medium, *then* the name does.
    // A rename before the sync publishes a name whose contents are not there yet.
    expect(steps).toEqual(['open:w', 'write', 'sync', 'close', 'rename', 'open:r', 'sync', 'close']);
    expect(readFileSync(target, 'utf8')).toBe(text);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  it('AN.17: a publication that cannot reach the medium never renames', () => {
    // The partial is the reason this is safe: a failure before the rename leaves a name
    // nothing reads, so the old anchor — and the floor it records — is still the one a
    // verification consults.
    const target = anchorFile();
    let syncs = 0;
    const { calls, steps } = port({
      sync: (descriptor) => {
        syncs += 1;
        if (syncs === 1) throw errno('ENOSPC');
        nodeAnchorCalls.sync(descriptor);
      },
    });
    expect(() => publishAnchor(target, '{"version":1,"pruned":[]}\n', calls)).toThrow(/ENOSPC/);
    expect(steps).not.toContain('rename');
    expect(existsSync(target)).toBe(false);
  });

  it('AN.18: a platform that cannot sync a directory is tolerated, not fatal', () => {
    // Windows refuses `fsync` on a directory handle with EPERM, and some filesystems
    // with EINVAL. Neither is a reason for a deployment to be unable to prune; letting
    // them through would make the anchor a Unix-only feature.
    const target = anchorFile();
    const openRefused = port({
      open: (path, flags) => {
        if (flags === 'r') throw errno('EISDIR');
        return nodeAnchorCalls.open(path, flags);
      },
    });
    expect(() => publishAnchor(target, '{"version":1,"pruned":[]}\n', openRefused.calls)).not.toThrow();
    expect(existsSync(target)).toBe(true);

    const syncRefused = (() => {
      let syncs = 0;
      return port({
        sync: (descriptor) => {
          syncs += 1;
          if (syncs === 2) throw errno('EINVAL');
          nodeAnchorCalls.sync(descriptor);
        },
      });
    })();
    expect(() => publishAnchor(target, '{"version":1,"pruned":[]}\n', syncRefused.calls)).not.toThrow();
  });

  it('AN.19: a directory failure that is not a platform limitation reaches the caller', () => {
    // The other side of AN.18: EIO is "not now, and your data is at risk". Swallowing it
    // would let a prune proceed on a record that never landed, which is the hole the
    // record exists to close.
    const target = anchorFile();
    const openFailed = port({
      open: (path, flags) => {
        if (flags === 'r') throw errno('EIO');
        return nodeAnchorCalls.open(path, flags);
      },
    });
    expect(() => publishAnchor(target, '{"version":1,"pruned":[]}\n', openFailed.calls)).toThrow(/EIO/);

    const syncFailed = (() => {
      let syncs = 0;
      return port({
        sync: (descriptor) => {
          syncs += 1;
          if (syncs === 2) throw errno('EIO');
          nodeAnchorCalls.sync(descriptor);
        },
      });
    })();
    expect(() => publishAnchor(target, '{"version":1,"pruned":[]}\n', syncFailed.calls)).toThrow(/EIO/);
  });
});

// ── A record that cannot be written ─────────────────────────────

describe('AC 100 — a prune that cannot record what it gives up removes nothing', () => {
  it('AN.20: a publication that fails leaves every segment where it was', async () => {
    // The order — record, then remove — is only worth something if a failure to record
    // stops the removal. A directory where the anchor's file should be is the smallest
    // way to make the publication fail on every platform: the rename onto it cannot
    // succeed, and the partial it wrote is a name no reader reads.
    const store = open();
    await fill(store, 3);
    await store.close();
    mkdirSync(anchorFile());

    expect(await store.pruneOlderThan(new Date(Date.now() + 60_000))).toBe(0);
    expect(segments()).toHaveLength(3);
    // And the verification is honest about what it knows: the anchor is not a file, so
    // nothing claims a prune happened, and the chain begins at its genesis.
    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, anchored: 1, unanchored: 0, anchorUnreadable: false });
  });

  it('AN.21: a removal that fails for a reason other than refusal is reported, not thrown', async () => {
    // The sweep runs where no caller can receive an error, so its remover answers
    // instead of throwing — and the answer has to be the same one a refusal gives,
    // because the next sweep is the retry in both cases. A failure that is a refusal
    // goes through `removeFile`'s own arms; this asserts the other one.
    const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    expect(
      removeIfPossible('/nonexistent/segment.ndjson', () => {
        throw errno('EIO');
      }),
    ).toBe(false);
    expect(removeIfPossible('/nonexistent/segment.ndjson')).toBe(false);

    const file = pathOf('gone.ndjson');
    writeFileSync(file, 'x');
    expect(removeIfPossible(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe('AC 100 — the default publication port is the syscalls', () => {
  it('AN.24: every call `nodeAnchorCalls` makes fails the way the syscall does', () => {
    // A port that silently succeeds is a port that has moved the durability claim into its
    // own documentation. The only way to tell the default implementation from a no-op
    // without a crash is to hand it a descriptor that cannot work: `-1` is refused by the
    // kernel, and something has to be what refuses it.
    const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    expect(() => nodeAnchorCalls.open(pathOf('not-there'), 'r')).toThrow(errno('ENOENT').code);
    // A descriptor of `-1` is refused before the syscall — Node validates the range — so
    // the assertion is that these three refuse, not which layer refused them.
    const refused = /out of range|EBADF/;
    expect(() => nodeAnchorCalls.write(-1, 'x')).toThrow(refused);
    expect(() => nodeAnchorCalls.sync(-1)).toThrow(refused);
    expect(() => nodeAnchorCalls.close(-1)).toThrow(refused);
    expect(() => nodeAnchorCalls.rename(pathOf('not-there'), pathOf('nowhere'))).toThrow(errno('ENOENT').code);
  });
});

// ── The two shapes a segment can have and still be given up ─────

describe('AC 100 — what a prune may still give up', () => {
  it('AN.22: a segment of unchained lines is prunable, and records no floor', async () => {
    // A trail written before the chain existed is full of lines that carry no link, and
    // refusing to expire them would make retention a function of when the feature
    // shipped. They are prunable — and there is nothing to record, because a chain that
    // never began cannot start at an unexplained number.
    const store = open();
    const legacy = [
      {
        id: 'legacy-1',
        timestamp: '2020-01-01T00:00:00.000Z',
        operation: 'OP',
        actor: 'a',
        resource: 'r',
        result: 'success',
        severity: 'info',
      },
      {
        id: 'legacy-2',
        timestamp: '2020-01-01T00:00:00.000Z',
        operation: 'OP',
        actor: 'a',
        resource: 'r',
        result: 'success',
        severity: 'info',
      },
    ];
    const name = `audit-20200101-0001.ndjson`;
    writeFileSync(pathOf(name), `${legacy.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const old = new Date(0);
    utimesSync(pathOf(name), old, old);

    expect(await store.pruneOlderThan(new Date())).toBe(1);
    expect(existsSync(pathOf(name))).toBe(false);
    // No floors were recorded, so no anchor was written: an anchor with an empty
    // `pruned` array would claim the directory had given something up.
    expect(existsSync(anchorFile())).toBe(false);
  });

  it('AN.25: an anchor that cannot be read does not block a segment that records nothing', async () => {
    // The two rules meet here, and the safe direction is the *other* one from usual. A
    // prune that cannot write the anchor removes nothing, because the deletions would be
    // unrecorded. A segment of unchained lines has nothing to record, so refusing to
    // expire it because of a damaged anchor would make retention wait on a file that says
    // nothing about this segment — and a damaged anchor is an operator's problem, not a
    // reason for the disk to fill.
    const store = open();
    const legacy = [
      {
        id: 'legacy-1',
        timestamp: '2020-01-01T00:00:00.000Z',
        operation: 'OP',
        actor: 'a',
        resource: 'r',
        result: 'success',
        severity: 'info',
      },
    ];
    const name = `audit-20200101-0001.ndjson`;
    writeFileSync(pathOf(name), `${legacy.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const old = new Date(0);
    utimesSync(pathOf(name), old, old);
    writeFileSync(anchorFile(), 'not an anchor');

    expect(await store.pruneOlderThan(new Date())).toBe(1);
    expect(existsSync(pathOf(name))).toBe(false);
    // And the damage is still there to be looked at: a prune does not overwrite a record
    // it could not understand with one it invented.
    expect(readFileSync(anchorFile(), 'utf8')).toBe('not an anchor');
  });

  it('AN.26: a segment with a line that is not JSON is kept, and its neighbours still go', async () => {
    // A line nobody can parse is not an unchained line: it is a line whose content is
    // unknown, and the entries around it inside the same file cannot be checked across
    // the hole. Retention keeps the file and names it through `verify()`; it does not
    // delete the only copy of something it could not read. The sealed segment beside it
    // is untouched by that verdict, which is what keeps one damaged file from stopping
    // retention for the whole directory.
    const store = open();
    const sealed = `audit-20200101-0001.ndjson`;
    writeFileSync(
      pathOf(sealed),
      `${chainOf(2)
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
    );
    const damaged = `audit-20200101-0002.ndjson`;
    writeFileSync(pathOf(damaged), `${JSON.stringify(chainOf(1, 'w1', 3)[0])}\nthis line is not an entry\n`);
    const old = new Date(0);
    utimesSync(pathOf(sealed), old, old);
    utimesSync(pathOf(damaged), old, old);

    expect(await store.pruneOlderThan(new Date())).toBe(1);
    expect(existsSync(pathOf(sealed))).toBe(false);
    expect(existsSync(pathOf(damaged))).toBe(true);
    // The floor of the segment that went is recorded, so the survivor that begins at 3
    // is checked against it rather than reported as a gap.
    expect(floors()).toEqual({ w1: 2 });
  });

  it('AN.23: a rotation over a segment that has vanished compresses nothing', async () => {
    // The file a rotation was about to compress can be gone — an operator pruned it, a
    // cleaner took it, another process rotated first. `fileIdentity` answering `null` is
    // the whole of that rule, and the store has to keep writing rather than treat it as
    // a crash: the entry that triggered the rotation belongs in the *next* segment.
    const store = open();
    await fill(store, 1);
    const [only] = segments();
    rmSync(pathOf(only!));

    await fill(store, 1);
    await store.close();
    const result = await store.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(1);
  });
});

// ── The invariant ───────────────────────────────────────────────

describe('AC 100 — every chain is anchored or unanchored, never neither', () => {
  it('AN.15: `anchored + unanchored === writers`, in every shape a trail can take', () => {
    // Two numbers that are easy to compute separately and impossible to reconcile are
    // two numbers nobody trusts. The pair is asserted as a sum so that a shape nobody
    // thought of — a content break at the first entry, an anchor that covers the head —
    // cannot fall between them.
    const floor = chainOf(1, 'w1', 41)[0]!;
    const anchor = new Map([['w1', { writer: 'w1', seq: 40, hash: floor.chain!.prev }]]);

    const shapes: Array<[string, AuditTrailVerificationShape]> = [
      ['an empty trail', { entries: [] }],
      ['a chain from its genesis', { entries: chainOf(3) }],
      ['a chain above 1 with no record', { entries: chainOf(3, 'w1', 41) }],
      ['a chain above 1 with a matching record', { entries: chainOf(3, 'w1', 41), anchor }],
      [
        'a chain above the record',
        // The floor says 40; the trail resumes at 42, so 41 is missing.
        { entries: chainOf(3, 'w1', 42), anchor },
      ],
      [
        'a chain whose first entry does not hold',
        { entries: [{ ...chainOf(1)[0]!, actor: 'mallory' }, ...chainOf(2, 'w1', 2)] },
      ],
      ['two writers, one anchored', { entries: [...chainOf(2), ...chainOf(2, 'w2', 41)], anchor }],
      // Below the floor: a restored prefix, which the record does not contradict and
      // does not explain either. It is anchored, because a trail that starts earlier than
      // the record says is a trail with more evidence, not less.
      ['a chain that starts below the record', { entries: chainOf(2, 'w1', 30, 'b'.repeat(64)), anchor }],
      [
        'a trail with an unchained line',
        { entries: [...chainOf(2), { ...chainOf(1)[0]!, id: 'planted', chain: undefined }] },
      ],
    ];

    for (const [name, shape] of shapes) {
      const result = verifyTrail(shape.entries, { anchor: shape.anchor });
      expect(result.anchored + result.unanchored, name).toBe(result.writers);
    }
    // A trail that begins *below* the record is a restored prefix: anchored, intact, and
    // not a link break — the entry at its head does not have to name the floor's digest,
    // because it is not the entry after the floor.
    // Its `prev` names something the anchor did not record, and that is *not* a link break:
    // the join is only asked of the entry that follows the floor.
    expect(verifyTrail(chainOf(2, 'w1', 30, 'b'.repeat(64)), { anchor })).toMatchObject({
      ok: true,
      anchored: 1,
      unanchored: 0,
    });

    // And the two that must fail say which: a gap is not a proven break of the digest.
    const gap = verifyTrail(chainOf(3, 'w1', 42), { anchor });
    expect(gap.firstFailure).toMatchObject({ reason: 'anchor-gap', seq: 42 });
    const join = verifyTrail(chainOf(3, 'w1', 41), { anchor });
    expect(join).toMatchObject({ ok: true, anchored: 1, unanchored: 0 });
    // A line with no link does not make the trail intact, and the `anchored` counts do not
    // pretend otherwise: the chain is accounted for, and the trail is still not.
    const planted = verifyTrail([...chainOf(2), { ...chainOf(1)[0]!, id: 'planted', chain: undefined }]);
    expect(planted).toMatchObject({ ok: false, unchained: 1, anchored: 1 });
  });
});

/** The two fields of `verifyTrail`'s options these shapes vary. */
interface AuditTrailVerificationShape {
  entries: AuditEntry[];
  anchor?: Map<string, { writer: string; seq: number; hash: string }>;
}
