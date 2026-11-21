/**
 * AC 95 — every answer `verify()` gives, and the two readings it must not confuse.
 *
 * `AC 93` proved the chain: a line edited on disk is refused, a line removed is a
 * sequence gap, a line planted is unchained. What it never asserted is the report
 * *around* that verdict — `tornTail` was only ever observed as `true`, so the field
 * could have been hard-wired for all the suite knew, and a damaged line in the middle
 * of a segment was never produced, so the position in `unparsable` was unread.
 *
 * The mutation run over `FileAuditStore.ts` said the same thing in its own language:
 * thirty-eight mutants survived in one file, and the densest cluster of them was the
 * body of `verify()` — a block of seventeen lines where every arm's replacement
 * produced a report the suite never looked at.
 *
 * What each case is for:
 *
 *   VR.1  an intact trail says so in every field, not just `ok`
 *   VR.2  a whitespace-only line is not a damaged line
 *   VR.3  a valid last line without its newline is a torn tail, not a break
 *   VR.4  an unparsable tail fragment is a torn tail, not an unparsable line
 *   VR.5  a damaged line in the middle is named by its position
 *   VR.6  a legacy export that is not JSON is reported, not dropped
 *   VR.7  a directory that is gone is unreadable, never intact
 *   VR.8  an archive whose bytes cannot be recovered is unreadable
 *   VR.9  verification settles what it read
 *   RD.1  a reader that returns nothing is an empty segment to a read, a gap to a verification
 *   RD.2  a reader that throws is contained, and is still a gap
 *   SR.1  the newest open segment is the newest one without an archive
 *   SR.2  a store whose newest segment was archived does not continue it
 *   UI.1  identity: another file of the same size is not this file
 *   UI.2  identity: this file grown is not this file
 *   SW.1  an archive with no segment beside it is left alone
 *
 * One thing deliberately not asserted, because the trail cannot: the *head*. Retention
 * deletes closed segments by age, so a pruned trail whose first remaining entry is
 * number 40 is exactly what a trail whose first thirty-nine were deleted looks like —
 * and `verifyTrail` skips a writer's first link for that reason. Anchoring the head is
 * what the daily digest in `AC 93`'s `JsonAuditExporter` is for, not what a scan of
 * the surviving files can do.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  FileAuditStore,
  fileIdentity,
  newestOpenSegment,
  readSegmentFromDisk,
  unlinkIfUnchanged,
} from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';
import type { WriteAuditEntryOptions } from '../interfaces/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac95-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (overrides: Partial<WriteAuditEntryOptions> = {}): WriteAuditEntryOptions => ({
  operation: 'rotate-key',
  actor: 'alice',
  resource: '/db',
  result: 'success',
  ...overrides,
});

/** The one segment a fresh store writes into. */
const onlySegment = (): string => join(dir, readdirSync(dir).filter((f) => f.endsWith('.ndjson'))[0]!);

/** Write `n` entries, then close, so nothing is left against the disk. */
async function trail(n: number): Promise<FileAuditStore> {
  const store = new FileAuditStore({ dataDir: dir, writerId: 'w1' });
  for (let i = 0; i < n; i++) await store.write(write({ details: { i } }));
  await store.close();
  return store;
}

// ── What the report says ────────────────────────────────────────

describe('AC 95 — an intact trail is intact in every field', () => {
  it('VR.1: an intact trail says so in every field, not just `ok`', async () => {
    // `ST.1` asked `ok` and nothing else, which is one bit of a nine-field report.
    // Every arm of the loop that builds the other eight could have been replaced and
    // `ok` would still have been `true`: `tornTail` hard-wired to `true` is the
    // clearest of them, because a trail that always claims damage is as wrong as one
    // that never reports it — and the suite could not tell which it had.
    const store = await trail(3);
    const result = await store.verify();

    expect(result).toMatchObject({
      ok: true,
      entries: 3,
      chained: 3,
      unchained: 0,
      failures: 0,
      writers: 1,
      tornTail: false,
      unreadable: false,
    });
    expect(result.reported).toEqual([]);
    expect(result.firstFailure).toBeNull();
  });

  it('VR.2: a whitespace-only line is not a damaged line', async () => {
    // A file can hold one for reasons that are not damage: a tool that appended
    // `\n` before its record, a truncation that left spaces. The reader skips it
    // (`line.trim() === ''`), and the distinction between that and `line === ''` is
    // exactly one character — the kind a mutant removes and no assertion notices
    // unless a line made of spaces exists.
    const store = await trail(2);
    const segment = onlySegment();
    const lines = readFileSync(segment, 'utf8').trimEnd().split('\n');
    writeFileSync(segment, `${lines[0]!}\n \t \n${lines[1]!}\n`);

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, entries: 2, failures: 0, tornTail: false });
  });

  it('VR.3: a valid last line without its newline is a torn tail, not a break', async () => {
    // The store writes `line\n` in one call, so a file that ends mid-record is a
    // process that died inside `append`. The bytes that did land are a whole entry
    // and must be read: reporting it as unparsable would lose an entry that is
    // demonstrably there, and reporting nothing at all would hide that the segment
    // was cut.
    const store = await trail(2);
    const segment = onlySegment();
    writeFileSync(segment, readFileSync(segment, 'utf8').trimEnd());

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, entries: 2, failures: 0, tornTail: true });
    expect(result.reported).toEqual([]);
  });

  it('VR.4: an unparsable tail fragment is a torn tail, not an unparsable line', async () => {
    // The same crash one byte earlier: the fragment is not JSON, it is the prefix of
    // a record. Calling it unparsable would accuse the file of damage it does not
    // have — the entry it was writing was never acknowledged — and would put a
    // position in `unparsable` for a line nobody promised.
    const store = await trail(2);
    appendFileSync(onlySegment(), '{"id":"half');

    const result = await store.verify();
    expect(result).toMatchObject({ ok: true, entries: 2, failures: 0, tornTail: true });
    expect(result.reported).toEqual([]);
  });

  it('VR.5: a damaged line in the middle is named by its position', async () => {
    // Somewhere other than the tail, a line that is not JSON is a line that was
    // rewritten or truncated by somebody else, and the report has to say *where* —
    // `file:line`, one-based, the way an editor counts. Without a case in the middle
    // the whole `unparsable.push` was unread: its object could have been empty, its
    // template could have been `''`, and its arithmetic could have been off by one.
    const store = await trail(2);
    const segment = onlySegment();
    const lines = readFileSync(segment, 'utf8').trimEnd().split('\n');
    lines[0] = '{"id":';
    // No trailing newline, so the *last* line is the torn one and the damaged line is
    // not it. Both facts are reported at once, and they are different facts: "line 1
    // is not JSON" and "the file was cut after line 2". A reader that decided
    // `unterminated` from anything but the position would report one as the other.
    writeFileSync(segment, lines.join('\n'));

    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.failures).toBe(1);
    expect(result.tornTail).toBe(true);
    expect(result.firstFailure).toMatchObject({
      reason: 'unparsable',
      where: `${basename(segment)}:1`,
    });
  });

  it('VR.6: a legacy export that is not JSON is reported, not dropped', async () => {
    // The single-array `.json` format predates segments, and `verify()` reads it so
    // that an old directory still answers. A file of that name that cannot be parsed
    // is the one thing an audit report must not swallow: it is evidence of the shape
    // the exporter used to write, and it is now unreadable.
    writeFileSync(join(dir, 'audit.json'), '[{"id":"e1"');

    const store = new FileAuditStore({ dataDir: dir });
    const result = await store.verify();
    expect(result).toMatchObject({ ok: false, entries: 0, failures: 1, unreadable: false });
    expect(result.firstFailure).toMatchObject({ reason: 'unparsable', where: 'audit.json' });
  });

  it('VR.7: a directory that is gone is unreadable, never intact', async () => {
    // An unmounted volume is the ordinary way this happens, and it is the reason
    // `listReadableFiles` answers `null` rather than throwing: the person asking is
    // already investigating an incident. What must not happen is the other reading —
    // "no files, therefore no problems" — because an empty answer to "is my evidence
    // intact" is the one answer that cannot be checked later.
    const store = new FileAuditStore({ dataDir: dir });
    await store.write(write());
    await store.close();
    rmSync(dir, { recursive: true, force: true });

    const result = await store.verify();
    expect(result).toMatchObject({ ok: false, unreadable: true, entries: 0, failures: 0 });
  });

  it('VR.8: an archive whose bytes cannot be recovered is unreadable', async () => {
    // A truncated or bit-rotted `.gz` is not a segment with no entries. Folding the
    // two together made `verify()` answer `ok: true, entries: 0` for a trail whose
    // only segment could not be read — the false attestation this case exists to
    // make impossible. The read path still serves what it can (`query()` answers
    // with the other segments); the verification is where the gap is named.
    const name = 'audit-20260101-0001.ndjson.gz';
    writeFileSync(join(dir, name), Buffer.from('this is not a gzip stream'));

    const store = new FileAuditStore({ dataDir: dir });
    const result = await store.verify();
    expect(result).toMatchObject({ ok: false, unreadable: true, entries: 0 });
    // And a read of the same directory is empty rather than an exception.
    expect(await store.query({})).toEqual([]);
  });

  it('VR.10: a sweep is not stopped by a reader that throws', async () => {
    // The construction sweep compares a segment with its archive, and it does so through
    // the store's reader — the same port `verify()` uses, so a deployment that wraps the
    // reader is not quietly given a second one here. A reader that fails during that
    // comparison has produced nothing, which is `plain-unreadable`: the verdict whose
    // repair is `none`. Deleting evidence to make a sweep finish is not a repair, and a
    // store that refuses to open because it could not read a file would take the whole
    // audit down with the file.
    writeFileSync(join(dir, 'audit-20260101-0001.ndjson'), '{"id":"kept"}\n');
    writeFileSync(join(dir, 'audit-20260101-0001.ndjson.gz'), gzipSync('{"id":"kept"}\n'));

    const store = new FileAuditStore({
      dataDir: dir,
      segmentReader: () => {
        throw new Error('EIO');
      },
    });
    await store.close();

    expect(readdirSync(dir).sort()).toEqual(['audit-20260101-0001.ndjson', 'audit-20260101-0001.ndjson.gz']);
    expect(await store.verify()).toMatchObject({ ok: false, unreadable: true });
  });

  it('VR.11: a reader that fails during an append does not refuse the append', async () => {
    // Appending to a segment that has an archive beside it compares the two views before
    // acknowledging, and that comparison is made through the store's reader. If the reader
    // fails, the answer has to be "do nothing": the alternative verdict is `release`, which
    // refuses a line whose bytes are already in the file and whose position in the writer's
    // chain is already spent — the one failure a caller cannot retry, because the retry
    // would be sealed against a predecessor the file holds.
    //
    // The archive appears *after* the store has opened its segment, which is the shape
    // that matters: a compressor running in another process publishes it between two
    // appends. That is the case `release` exists for, and the case in which a comparison
    // that cannot be made must not be mistaken for one.
    let fail = false;
    const store = new FileAuditStore({
      dataDir: dir,
      segmentReader: (path, compressed) => {
        if (fail) throw new Error('EIO');
        return readSegmentFromDisk(path, compressed);
      },
    });
    await store.write(write({ operation: 'BEFORE' }));
    const active = join(dir, readdirSync(dir).filter((f) => f.endsWith('.ndjson'))[0]!);
    writeFileSync(`${active}.gz`, gzipSync(readFileSync(active)));

    fail = true;
    await expect(store.write(write({ operation: 'AFTER' }))).resolves.toBeTypeOf('string');
    await store.close();
    expect(readFileSync(active, 'utf8')).toContain('AFTER');
  });

  it('VR.12: a store constructed over a shadowed name does not continue it', async () => {
    // The construction-time twin of VR.11, and the reason `plain-missing` and
    // `plain-unreadable` both mean "do nothing" at rest: a name an archive shadows is not a
    // name a reader reads, so a store that adopted it would acknowledge lines into a file
    // nobody reads.
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, '{"id":"before"}\n');
    writeFileSync(`${plain}.gz`, gzipSync('{"id":"before"}\n'));

    const store = new FileAuditStore({ dataDir: dir });
    await expect(store.write(write({ operation: 'AFTER' }))).resolves.toBeTypeOf('string');
    await store.close();

    const written = readdirSync(dir).filter(
      (f) => f.endsWith('.ndjson') && readFileSync(join(dir, f), 'utf8').includes('AFTER'),
    );
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe('audit-20260101-0001.ndjson');
  });

  it('VR.9: verification flushes before it reads', async () => {
    // `verify()` flushes first, and the flush is not about the text — the bytes are
    // in the file as soon as `append` returns. It is about the *acknowledgement*: a
    // line whose sync fails must have been rejected rather than left queued behind a
    // report that says the trail is intact. The scheduled flush runs at the end of
    // the turn, so without the call inside `verify()` the assertion below finds no
    // sync at all — the report is issued, and the line it counts is still pending.
    let syncs = 0;
    class RefusingSync implements DurableFileSystem {
      private refused = false;

      append(path: string, data: string): void {
        nodeDurableFileSystem.append(path, data);
      }

      syncFile(path: string): void {
        syncs += 1;
        if (!this.refused) {
          this.refused = true;
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        nodeDurableFileSystem.syncFile(path);
      }

      syncDirectory(path: string): void {
        nodeDurableFileSystem.syncDirectory(path);
      }

      needsSeparator(path: string): boolean {
        return nodeDurableFileSystem.needsSeparator(path);
      }
    }

    const store = new FileAuditStore({ dataDir: dir, fileSystem: new RefusingSync() });
    const settled: string[] = [];
    const pending = store.write(write()).then(
      () => settled.push('resolved'),
      () => settled.push('rejected'),
    );

    // `verify()` has no `await` of its own before it returns, so a scheduled flush
    // cannot have run here: the one sync counted is the one the call made.
    await store.verify();
    expect(syncs).toBe(1);
    await pending;
    expect(settled).toEqual(['rejected']);

    // And a second verification of the same, now quiet, store pays none: the flush
    // is a queue drain, not a policy of syncing on every read.
    await store.verify();
    expect(syncs).toBe(1);
  });
});

// ── The reader port ─────────────────────────────────────────────

describe('AC 95 — a reader that produced nothing, and a reader that failed', () => {
  it('RD.1: a reader that returns nothing is an empty segment to a read, a gap to a verification', async () => {
    // The port's vocabulary is `string | null`, and the store now keeps the two
    // apart instead of collapsing them at the door.
    // A legacy single-array export is read through the same port, and a read of it
    // that produces nothing is an export with no entries — not an exception in the
    // middle of a report somebody is trying to produce.
    writeFileSync(join(dir, 'audit.json'), '[{"id":"e1"}]');
    const store = new FileAuditStore({ dataDir: dir, segmentReader: () => null });
    await store.write(write());
    await store.close();

    expect(await store.count()).toBe(0);
    expect(await store.get('anything')).toBeNull();
    expect(await store.verify()).toMatchObject({ ok: false, unreadable: true });
  });

  it('RD.2: a reader that throws is contained, and is still a gap', async () => {
    // A remote port whose connection dropped throws. The containment belongs to the
    // store, not to the port, so that every port inherits it — and a reader that
    // throws has produced nothing, which is the same fact as a reader that returned
    // nothing, not a crash of the audit.
    const store = new FileAuditStore({
      dataDir: dir,
      segmentReader: () => {
        throw new Error('EIO: the medium went away');
      },
    });
    await store.write(write());
    await store.close();

    expect(await store.query({})).toEqual([]);
    expect(await store.verify()).toMatchObject({ ok: false, unreadable: true });
  });
});

// ── Which segment a store continues ─────────────────────────────

describe('AC 95 — the name a store continues', () => {
  it('SR.1: the newest open segment is the newest one without an archive', () => {
    // A name with an archive beside it is closed: reads prefer the archive, so
    // anything appended to the plain file after it was archived is written and never
    // read. Ordering alone is not enough — the newest name can be the closed one.
    // Nothing to continue: the only segment left is closed.
    expect(newestOpenSegment(['audit-20260101-0002.ndjson', 'audit-20260101-0002.ndjson.gz'], 'audit')).toBe('');
    // And a closed name does not win by being newer.
    expect(
      newestOpenSegment(
        ['audit-20260101-0001.ndjson', 'audit-20260101-0002.ndjson', 'audit-20260101-0002.ndjson.gz'],
        'audit',
      ),
    ).toBe('audit-20260101-0001.ndjson');
    expect(
      newestOpenSegment(
        ['audit-20260101-0001.ndjson', 'audit-20260101-0001.ndjson.gz', 'audit-20260101-0002.ndjson'],
        'audit',
      ),
    ).toBe('audit-20260101-0002.ndjson');
    // A partial is not a name to avoid either: it is not a segment at all.
    expect(newestOpenSegment(['audit-20260101-0001.ndjson.part'], 'audit')).toBe('');
  });

  it('SR.3: an append with no archive beside it reads nothing', async () => {
    // One `stat` per append is the cost the live path promises: the comparison of the
    // segment with an archive only happens when an archive exists. `relateTwin` would
    // answer `no-twin` for one that is not there, so the guard cannot be detected in
    // what the store *says* — it is detected in what it *reads*, which is why the
    // reader is a port. Without the guard every append reads the whole active
    // segment: on a 50 000-line segment, 50 000 rewrites of nothing.
    const reads: string[] = [];
    const store = new FileAuditStore({
      dataDir: dir,
      segmentReader: (path, compressed) => {
        reads.push(`${path}|${String(compressed)}`);
        return readSegmentFromDisk(path, compressed);
      },
    });
    for (let i = 0; i < 3; i++) await store.write(write({ details: { i } }));
    await store.close();

    expect(reads).toEqual([]);
  });

  it('SR.2: a store whose newest segment was archived does not continue it', async () => {
    // The same rule through the store, because that is where it has consequences: a
    // line acknowledged into a name an archive shadows is written and never read, so
    // `count()` would stay at the number it had before and the entry would be gone
    // from every report that is not a `cat` of the directory.
    await trail(1);
    const segment = onlySegment();
    // The window between publishing an archive and unlinking the plain segment: both
    // hold the same entries, and the archived name must not be continued.
    writeFileSync(`${segment}.gz`, gzipSync(readFileSync(segment)));

    const second = new FileAuditStore({ dataDir: dir });
    await second.write(write({ operation: 'SECOND' }));
    await second.close();

    expect(await second.count()).toBe(2);
    expect(await second.verify()).toMatchObject({ ok: true, entries: 2 });
    const written = readdirSync(dir).filter(
      (f) => f.endsWith('.ndjson') && readFileSync(join(dir, f), 'utf8').includes('SECOND'),
    );
    expect(written).toHaveLength(1);
    expect(existsSync(join(dir, `${written[0]!}.gz`))).toBe(false);
  });
});

// ── Identity, and what a cleanup may remove ─────────────────────

describe('AC 95 — a cleanup deletes only the file it read', () => {
  it('UI.1: another file of the same size is not this file', () => {
    // Rotation reuses names. A compressor that outlives its directory finds *a* file
    // at its old path — the next test's, or the next day's. A size comparison alone
    // answers "unchanged" for a file that happens to be the same length, which is
    // exactly what a segment of same-sized entries is.
    const path = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(path, 'aaaa');
    const identity = fileIdentity(path)!;

    const replacement = join(dir, 'replacement');
    writeFileSync(replacement, 'bbbb');
    renameSync(replacement, path);

    expect(fileIdentity(path)!.size).toBe(identity.size);
    expect(unlinkIfUnchanged(path, identity)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('bbbb');
  });

  it('UI.2: this file grown is not this file', () => {
    // The other arm: the same inode, longer than what was read. Publishing an
    // archive of a prefix over a segment that has since grown makes every line after
    // the prefix invisible, so the file is left alone and the next rotation tries
    // again.
    const path = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(path, 'aaaa');
    const identity = fileIdentity(path)!;
    appendFileSync(path, 'b');

    expect(fileIdentity(path)!.ino).toBe(identity.ino);
    expect(unlinkIfUnchanged(path, identity)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('aaaab');
  });
});

// ── The construction sweep ──────────────────────────────────────

describe('AC 95 — the sweep at rest', () => {
  it('SW.1: an archive with no segment beside it is left alone', async () => {
    // What a rotation that was interrupted between the rename and the unlink leaves
    // when the plain file was removed by something else — a prune, an operator, a
    // copy that lost it. The archive is the only copy of those entries, so the sweep
    // must not touch it, and a store constructed over it must not throw: this is the
    // directory an operator opens to recover.
    const name = 'audit-20260101-0001.ndjson.gz';
    const entry = JSON.stringify({ id: 'kept', operation: 'KEPT' });
    writeFileSync(join(dir, name), gzipSync(Buffer.from(`${entry}\n`)));

    const store = new FileAuditStore({ dataDir: dir });
    await store.close();

    expect(readdirSync(dir)).toEqual([name]);
    // And the entries in it are still readable, which is the point of keeping it.
    expect(await store.count()).toBe(1);
  });
});
