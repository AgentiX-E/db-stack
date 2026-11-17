/**
 * AC 90 — a name and its archive are two views of one segment.
 *
 * `AC88` made an archive whole before it is published, which closes the case of a
 * segment that grows *while* it is compressed. It does not close the case of a segment
 * that grows *after* it was archived, and that case is reachable through the feature
 * that makes a restart a continuation:
 *
 *   1. store A writes lines into `X.ndjson`;
 *   2. store B starts, and *adopts* `X.ndjson` rather than naming a new segment —
 *      which is the whole point of adoption;
 *   3. A rotates, compresses `X.ndjson`, publishes `X.ndjson.gz` and unlinks the
 *      plain file;
 *   4. B's next append recreates `X.ndjson`, now holding only the lines written
 *      after the unlink.
 *
 * Every reader prefers an archive over the plain file of the same name — correctly,
 * because between the rename and the unlink both hold the same entries — so the lines
 * from step 4 are complete, on the disk, and invisible to `get()`, `query()` and
 * `count()`. That is the one failure this module exists to be incapable of.
 *
 * Prevention would need a lease, and a lease needs an answer to "is that writer
 * alive?", which a file cannot give across hosts: a pid is meaningless on another
 * machine and racy on a shared mount. So the repair is decided by the only evidence
 * that survives a crash — the bytes. A name and its archive are compared, and exactly
 * one of them is found to carry something the other does not:
 *
 *   SH.1  the eight relations, including the two that are about readability
 *   SH.2  at rest, a segment longer than its archive: the archive goes, nothing is lost
 *   SH.3  at rest, a segment contained in its archive: the segment goes, it held nothing
 *   SH.4  at rest, neither contains the other: the segment moves to a name of its own
 *   SH.5  at rest, identical bytes: one copy goes, the entry is read once
 *   SH.6  a damaged archive does not hide a readable segment
 *   SH.7  live, the adopted segment was archived under us: the next write moves on
 *   SH.8  live, a stale archive of an older life: the segment moves, both stay readable
 *   SH.9  live, a directory wearing an archive's name: the writer is not stopped
 *   SH.10 two live stores on one directory: the adopting store's lines survive
 *   SH.11 the moved segment is named like a segment and is the one adopted next
 *   SH.12 the repair is idempotent: a second store finds nothing to do
 *   SH.13 a directory that is gone has nothing to repair
 *   SH.14 a line written after a repair is durable, not merely readable
 *   SH.15 live, the file vanishes between the append and the check: the line is not
 *         acknowledged, and the retry lands in a segment this store holds
 *   SH.16 live, an archive longer than the file: the same refusal, for the same reason
 *   SH.17 live, an archive shorter than the file: the archive goes, the file stays
 *   SH.18 live, an archive identical to the file: the archive goes
 *   SH.19 live, an archive that cannot be read: the archive goes
 *   SH.20 which names have an archive beside them, asserted on a listing
 *   SH.21 what each relation is repaired with, in both places
 *
 * What this cannot show: that the *lease-free* decision is always right for a writer
 * that is still alive but stalled between reading an archive and writing its own file.
 * The window is documented in `docs/user-guide/operations.md`, and what closes it for
 * an acknowledged entry is `resolveShadowedSegment`, which runs between the append and
 * the acknowledgement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileAuditStore,
  archiveSegment,
  readView,
  relateTwin,
  repairFor,
  segmentPattern,
  shadowedPairs,
} from '../impl/FileAuditStore.js';
import type { SegmentView, TwinRepair, TwinVerdict } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac90-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One NDJSON line for `id`, in the shape the store writes. */
function line(id: string): string {
  return (
    JSON.stringify({
      id,
      timestamp: '2026-01-01T00:00:00.000Z',
      operation: 'write',
      actor: 'alice',
      resource: 'orders',
      result: 'success',
      severity: 'info',
    }) + '\n'
  );
}

/** Gzip `text` into `<path>.gz`, the way rotation publishes an archive. */
function writeArchive(path: string, text: string): void {
  writeFileSync(`${path}.gz`, gzipSync(Buffer.from(text, 'utf-8')));
}

/** The view of a name that exists and says `text`. */
function view(exists: boolean, text: string | null): SegmentView {
  return { exists, text };
}

/** The only plain segment name in `dir`. */
function plainNames(): string[] {
  return readdirSync(dir).filter((n) => n.endsWith('.ndjson'));
}

/** A store whose writes carry an id this suite can look up again. */
async function writeOne(store: FileAuditStore, actor = 'alice'): Promise<string> {
  return store.write({ operation: 'write', actor, resource: 'orders', result: 'success' });
}

describe('AC 90 — a segment name and its archive', () => {
  it('SH.1: the eight relations, two of which are about readability', () => {
    // Only one of the two names exists.
    expect(relateTwin(view(false, null), view(false, null))).toBe('no-twin');
    expect(relateTwin(view(true, line('a')), view(false, null))).toBe('no-twin');

    // The archive is there and the segment is not: an abandoned rotation, not a twin.
    expect(relateTwin(view(false, null), view(true, line('a')))).toBe('plain-missing');

    // A name that exists and yields no text is not an empty name: the reader prefers
    // it and gets nothing, which is the state worth repairing.
    expect(relateTwin(view(true, null), view(true, line('a')))).toBe('plain-unreadable');
    expect(relateTwin(view(true, line('a')), view(true, null))).toBe('archive-unreadable');

    // Two copies of the same bytes.
    expect(relateTwin(view(true, line('a')), view(true, line('a')))).toBe('same');

    // One contains the other, whichever side it is on.
    expect(relateTwin(view(true, line('a') + line('b')), view(true, line('a')))).toBe('plain-extra');
    expect(relateTwin(view(true, line('a')), view(true, line('a') + line('b')))).toBe('archive-extra');

    // Neither: both carry unique entries.
    expect(relateTwin(view(true, line('a')), view(true, line('b')))).toBe('disjoint');

    // The view is where "exists" comes from, and a name that is not a regular file has
    // no text by definition — the shape has to say so before anything reads it.
    expect(readView(join(dir, 'audit-20260101-0009.ndjson'), false)).toEqual({
      exists: false,
      text: null,
    });
  });

  it('SH.2: a segment longer than its archive makes the archive go', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('a') + line('b'));
    writeArchive(plain, line('a'));

    const store = new FileAuditStore({ dataDir: dir });

    // The archive hid `b` from every reader while holding nothing `b`'s file does not.
    expect(existsSync(`${plain}.gz`)).toBe(false);
    expect(await store.get('b')).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('SH.3: a segment contained in its archive held nothing of its own', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('a'));
    writeArchive(plain, line('a') + line('b'));

    const store = new FileAuditStore({ dataDir: dir });

    // A prefix of the archive is a copy, not a segment: keeping it would either
    // double-count its entry or shadow it again on the next rotation.
    expect(existsSync(plain)).toBe(false);
    expect(await store.get('b')).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('SH.4: neither view contains the other, so the segment moves', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('mine'));
    writeArchive(plain, line('theirs'));

    const store = new FileAuditStore({ dataDir: dir });

    // Both entries are readable, and neither twice: the plain file kept its bytes and
    // lost only the name an archive had already claimed.
    expect(await store.get('mine')).not.toBeNull();
    expect(await store.get('theirs')).not.toBeNull();
    expect(await store.count()).toBe(2);
    expect(existsSync(`${plain}.gz`)).toBe(true);
    expect(plainNames()).not.toContain('audit-20260101-0001.ndjson');
  });

  it('SH.5: identical bytes leave one copy and one entry', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('a'));
    writeArchive(plain, line('a'));

    const store = new FileAuditStore({ dataDir: dir });

    // Preferring the archive over an identical plain file is not wrong, it is just
    // two names for one thing — and a rotate later would publish the archive twice.
    expect(existsSync(plain)).toBe(false);
    expect(await store.count()).toBe(1);
  });

  it('SH.6: a damaged archive does not hide a readable segment', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('a') + line('b'));
    writeFileSync(`${plain}.gz`, Buffer.from('this is not gzip', 'utf-8'));

    const store = new FileAuditStore({ dataDir: dir });

    // The name existed, so every reader preferred it, and it yielded nothing — so the
    // segment beside it was unreachable for as long as the damage lasted.
    expect(existsSync(`${plain}.gz`)).toBe(false);
    expect(await store.count()).toBe(2);
  });

  it('SH.7: the segment we adopted is archived under us, and the next write moves on', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    const first = await writeOne(store);

    const name = plainNames()[0]!;
    const plain = join(dir, name);
    // Another process finished its rotation: the archive is published, the plain file
    // is unlinked. This store is still holding the name.
    await archiveSegment(plain, `${plain}.gz`);

    const second = await writeOne(store);

    // The write that would have recreated the archived name went to a new segment
    // instead, so both entries are where a reader looks.
    expect(await store.get(first)).not.toBeNull();
    expect(await store.get(second)).not.toBeNull();
    expect(await store.count()).toBe(2);
    expect(existsSync(plain)).toBe(false);
  });

  it('SH.8: a stale archive of an older life does not take the segment with it', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    const mine = await writeOne(store);

    const name = plainNames()[0]!;
    const plain = join(dir, name);
    // A namesake appears after adoption — a restored backup, a reused directory. It
    // holds entries this file has never seen, and this file holds entries it has not.
    writeArchive(plain, line('theirs'));

    const alsoMine = await writeOne(store);

    expect(await store.get('theirs')).not.toBeNull();
    expect(await store.get(mine)).not.toBeNull();
    expect(await store.get(alsoMine)).not.toBeNull();
    expect(await store.count()).toBe(3);
    // The file kept its bytes and moved; the archive kept the name.
    expect(existsSync(`${plain}.gz`)).toBe(true);

    // And the store keeps writing *there*: a promotion that left the segment unclaimed
    // would name a second segment and leak one per event.
    await writeOne(store);
    expect(plainNames()).toHaveLength(1);
  });

  it('SH.9: a directory wearing the archive name does not stop the writer', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    const first = await writeOne(store);

    const name = plainNames()[0]!;
    mkdirSync(join(dir, `${name}.gz`));

    const second = await writeOne(store);

    // A directory holds no entries, so it relates to the segment as no twin at all —
    // and a repair that tried to read it would have failed the write instead.
    expect(await store.get(first)).not.toBeNull();
    expect(await store.get(second)).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('SH.10: two live stores on one directory lose nothing to a rotation', async () => {
    // The scenario from the header, end to end: a rotating writer and a second store
    // that adopts its segment.
    const rotating = new FileAuditStore({ dataDir: dir, maxFileSize: 1 });
    const a = await writeOne(rotating, 'alice');
    const adopting = new FileAuditStore({ dataDir: dir });
    const b = await writeOne(adopting, 'bob');

    // Rotating on its next line archives the segment both stores are appending to.
    const c = await writeOne(rotating, 'alice');
    await rotating.close();

    // The adopting store's next line cannot go into the archived name.
    const d = await writeOne(adopting, 'bob');

    for (const id of [a, b, c, d]) {
      expect(await adopting.get(id), `entry ${id} is readable`).not.toBeNull();
    }
    expect(await adopting.count()).toBe(4);
  });

  it('SH.11: the moved segment is named like a segment and is the one adopted next', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('mine'));
    writeArchive(plain, line('theirs'));

    const first = new FileAuditStore({ dataDir: dir });
    const promoted = plainNames()[0]!;

    // Named the way every other segment is named, and newer than the archive it was
    // moved away from — so a scan visits it first, which is right: its entries are the
    // ones written after the archive was taken.
    expect(segmentPattern('audit').test(promoted)).toBe(true);
    expect(promoted > 'audit-20260101-0001.ndjson').toBe(true);

    // The next store adopts it rather than naming a third segment: a repair that left
    // the data in a file nobody continues would leak one segment per start.
    const adopted = await writeOne(new FileAuditStore({ dataDir: dir }), 'bob');
    expect(plainNames()).toHaveLength(1);
    expect(await first.get(adopted)).not.toBeNull();
  });

  it('SH.12: the repair is idempotent', async () => {
    const plain = join(dir, 'audit-20260101-0001.ndjson');
    writeFileSync(plain, line('mine'));
    writeArchive(plain, line('theirs'));

    new FileAuditStore({ dataDir: dir });
    const afterFirst = readdirSync(dir).sort();

    // A second store finds nothing left to relate: the twin is gone, not merely
    // hidden, so the repair cannot oscillate between two names on every start.
    new FileAuditStore({ dataDir: dir });
    expect(readdirSync(dir).sort()).toEqual(afterFirst);
  });

  it('SH.13: a directory that is gone has nothing to repair', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    rmSync(dir, { recursive: true, force: true });

    // Retention, an unmount or an operator can remove the tree between two rotations.
    // The sweep reads a directory it cannot list and reports nothing, rather than
    // failing the append that asked for it.
    expect(() => (store as unknown as { sweepShadowedSegments(): void }).sweepShadowedSegments()).not.toThrow();
  });

  it('SH.14: a line written after a repair pays for its new name', async () => {
    const syncs: string[] = [];
    const store = new FileAuditStore({
      dataDir: dir,
      fileSystem: {
        ...nodeDurableFileSystem,
        syncDirectory: (path: string) => {
          syncs.push(path);
          nodeDurableFileSystem.syncDirectory(path);
        },
      },
    });
    const first = await writeOne(store);

    const plain = join(dir, plainNames()[0]!);
    await archiveSegment(plain, `${plain}.gz`);

    // The append that moved to a new segment has to pay for the *name* of that
    // segment, exactly like a claimed one: the bytes were synced, but the directory
    // entry that leads to them was not, so a power cut would leave them unreachable.
    const beforeRepair = syncs.length;
    const second = await writeOne(store);
    expect(syncs.length).toBe(beforeRepair + 1);
    await store.close();

    const afterRestart = new FileAuditStore({ dataDir: dir });
    expect(await afterRestart.get(first)).not.toBeNull();
    expect(await afterRestart.get(second)).not.toBeNull();
    expect(await afterRestart.count()).toBe(2);
  });

  /**
   * A store whose `append` runs an action afterwards, which is how the four states
   * that only another process can produce become reachable: the write path is
   * synchronous from the append to the check, so no second store in this process can
   * land in between.
   */
  function storeWithInterleaving(afterAppend: (path: string) => void): FileAuditStore {
    return new FileAuditStore({
      dataDir: dir,
      fileSystem: {
        ...nodeDurableFileSystem,
        append: (path: string, data: string) => {
          nodeDurableFileSystem.append(path, data);
          afterAppend(path);
        },
      },
    });
  }

  it('SH.15: a file that vanishes between the append and the check is a rejected write', async () => {
    let interleave = false;
    const store = storeWithInterleaving((path) => {
      if (!interleave) return;
      // The other process's rotation, completing after our bytes are in the file and
      // before our own check runs: compress, publish, unlink.
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
      unlinkSync(path);
    });

    const first = await writeOne(store);
    interleave = true;
    const failure = await writeOne(store).then(
      () => null,
      (error: Error) => error,
    );
    // The refusal names what happened and what to do about it, because the caller's next
    // move is a decision only it can make.
    expect(failure?.message).toMatch(/was archived while this store was appending to it/);
    expect(failure?.message).toMatch(/retry it/);

    // Whether the archiving process captured those bytes depends on when its identity
    // check ran, so the line is neither acknowledged nor written again — and the retry
    // names a segment this store holds.
    interleave = false;
    const retried = await writeOne(store);
    expect(await store.get(first)).not.toBeNull();
    expect(await store.get(retried)).not.toBeNull();
  });

  it('SH.16: an archive longer than the file is refused rather than guessed about', async () => {
    let interleave = false;
    const store = storeWithInterleaving((path) => {
      if (!interleave) return;
      // A namesake from an older life: its archive is longer than what we just wrote,
      // and it is the file that is contained in it — not the other way round.
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path) + line('ghost')));
    });

    const first = await writeOne(store);
    interleave = true;
    const failure = await writeOne(store).then(
      () => null,
      (error: Error) => error,
    );
    // The refusal names what happened and what to do about it, because the caller's next
    // move is a decision only it can make.
    expect(failure?.message).toMatch(/was archived while this store was appending to it/);
    expect(failure?.message).toMatch(/retry it/);

    // `ghost` is readable because the archive survived the refusal: the store does not
    // delete a view it has not proved redundant.
    interleave = false;
    const retried = await writeOne(store);
    expect(await store.get('ghost')).not.toBeNull();
    expect(await store.get(first)).not.toBeNull();
    expect(await store.get(retried)).not.toBeNull();

    // The refused line stays where it was, and the retry does not adopt it: a store that
    // kept appending to the refused name would move the file with that line inside it,
    // and an entry nobody was told about would appear in a report. Here the archive did
    // capture the line — which is exactly why the store cannot acknowledge it: the
    // capture depends on when the other process's identity check ran, and this store
    // cannot see that.
    expect(await store.count()).toBe(4);
  });

  it('SH.17: an archive shorter than the file is a prefix and goes', async () => {
    const store = new FileAuditStore({ dataDir: dir });
    const first = await writeOne(store);
    const second = await writeOne(store);

    const plain = join(dir, plainNames()[0]!);
    const text = readFileSync(plain, 'utf-8');
    // A stale archive of the first line only: the file has grown since it was taken.
    writeArchive(plain, text.slice(0, text.indexOf('\n') + 1));

    const third = await writeOne(store);

    // The archive hid nothing the file does not hold, so it is the archive that goes —
    // and the file keeps its name, because renaming it would leave the stale archive
    // as the name of a segment it no longer describes.
    expect(existsSync(`${plain}.gz`)).toBe(false);
    for (const id of [first, second, third]) expect(await store.get(id)).not.toBeNull();
    expect(await store.count()).toBe(3);
  });

  it('SH.18: an archive identical to the file goes', async () => {
    let snapshot = false;
    const store = storeWithInterleaving((path) => {
      if (snapshot) writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
    });

    await writeOne(store);
    snapshot = true;
    const second = await writeOne(store);

    // Two names for the same bytes: keeping the archive would hide the file, and
    // dropping the file would leave the writer appending to a name it no longer has.
    const plain = join(dir, plainNames()[0]!);
    expect(existsSync(`${plain}.gz`)).toBe(false);
    expect(await store.get(second)).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('SH.19: an archive that cannot be read goes, and the file keeps its name', async () => {
    let damage = false;
    const store = storeWithInterleaving((path) => {
      if (damage) writeFileSync(`${path}.gz`, Buffer.from('this is not gzip', 'utf-8'));
    });

    await writeOne(store);
    damage = true;
    const second = await writeOne(store);

    // The name was there, so every reader preferred it and got nothing: a damaged
    // archive beside a readable segment is a segment nobody can query.
    const plain = join(dir, plainNames()[0]!);
    expect(existsSync(`${plain}.gz`)).toBe(false);
    expect(await store.get(second)).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('SH.20: a name is paired with an archive only when both are this store’s names', () => {
    const names = [
      // A pair.
      'audit-20260101-0001.ndjson',
      'audit-20260101-0001.ndjson.gz',
      // A segment with no archive: nothing to relate.
      'audit-20260101-0002.ndjson',
      // An archive with no segment: an abandoned rotation.
      'audit-20260101-0003.ndjson.gz',
      // Another store's pair: its names are not this store's to rename.
      'billing-20260101-0001.ndjson',
      'billing-20260101-0001.ndjson.gz',
      // An archive that has an archive of its own: the inner name is not a segment.
      'audit-20260101-0004.ndjson.gz',
      'audit-20260101-0004.ndjson.gz.gz',
      // A half-written archive: not a segment either.
      'audit-20260101-0005.ndjson.gz.part',
    ];

    expect(shadowedPairs(names, 'audit')).toEqual(['audit-20260101-0001.ndjson']);
  });

  it('SH.21: what each relation is repaired with, in both places', () => {
    // The two contexts differ in exactly three cells, and each difference is a decision:
    // a file that is a copy of its archive is deleted at rest and the archive is deleted
    // while writing; a file contained in its archive is deleted at rest and its *name*
    // is abandoned while writing; a file that is gone is nothing at rest and a refusal
    // while writing.
    const table: Array<[TwinVerdict, TwinRepair, TwinRepair]> = [
      ['no-twin', 'none', 'none'],
      ['plain-missing', 'none', 'release'],
      ['plain-unreadable', 'none', 'none'],
      ['archive-unreadable', 'remove-archive', 'remove-archive'],
      ['same', 'remove-plain', 'remove-archive'],
      ['plain-extra', 'remove-archive', 'remove-archive'],
      ['archive-extra', 'remove-plain', 'release'],
      ['disjoint', 'promote', 'promote'],
    ];

    for (const [verdict, atRest, live] of table) {
      expect(repairFor(verdict, 'at-rest'), `${verdict} at rest`).toBe(atRest);
      expect(repairFor(verdict, 'live'), `${verdict} live`).toBe(live);
    }
  });
});
