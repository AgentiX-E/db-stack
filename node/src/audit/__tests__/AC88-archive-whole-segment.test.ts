/**
 * AC 88 — an archive is published only if it is the whole segment.
 *
 * `AC83` established that an archive appears complete or not at all: it is compressed
 * to `<archive>.part`, renamed, and the plain segment unlinked in one synchronous
 * block. That closes the *crash* window. It does not close the *concurrent writer*
 * window, because the rule it enforces is about the archive being complete, not about
 * the segment having stopped growing.
 *
 * A second process appending to a segment while it is compressed produces an archive
 * of a prefix. The reader prefers an archive over the plain file of the same name —
 * correctly, since between the rename and the unlink both hold the same entries — so a
 * published prefix hides everything appended after it: complete lines, on the disk,
 * unreachable through `get()`, `query()` or `count()`.
 *
 * So the segment has to be the same segment, and the same length, at the moment the
 * archive is published. The three answers are three cases, and the barrier makes the
 * middle one observable:
 *
 *   WS.1  a segment that grew, was replaced, or is gone: which of those may be published
 *   WS.2  a compression that outlives an append publishes nothing and loses nothing
 *   WS.3  the ordinary case still publishes — the guard must not stop the feature
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveSegment, isWholeSegment } from '../impl/FileAuditStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ac88-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AC 88 — a segment has to stop growing before it can be archived', () => {
  it('WS.1: gone is publishable, grown is not, a namesake is not', () => {
    const before = { ino: 41, size: 300 };

    // Gone: the archive holds every byte that was in the file, so it is now the only
    // copy of those entries. Refusing to publish would delete them.
    expect(isWholeSegment(null, before)).toBe(true);
    // The same file, the same length: the ordinary case.
    expect(isWholeSegment({ ino: 41, size: 300 }, before)).toBe(true);

    // Grew while gzip ran: the archive is a prefix, and a prefix hides the rest.
    expect(isWholeSegment({ ino: 41, size: 301 }, before)).toBe(false);
    expect(isWholeSegment({ ino: 41, size: 10_000 }, before)).toBe(false);
    // A different file at the same path: the name was reused, and what was compressed
    // is not what the archive would be read as.
    expect(isWholeSegment({ ino: 42, size: 300 }, before)).toBe(false);
  });

  it('WS.2: a compression that outlives an append publishes nothing and loses nothing', async () => {
    const source = join(dir, 'audit-20260101-0001.ndjson');
    const archive = `${source}.gz`;
    writeFileSync(source, '{"id":"one"}\n{"id":"two"}\n');

    // The barrier: the appender arrives between the start of the compression and the
    // moment the archive would be published — the window a second process produces for
    // free and a single-process test has to hold open.
    const compress = async (from: string, to: string): Promise<void> => {
      writeFileSync(to, 'compressed-so-far');
      writeFileSync(from, readFileSync(from, 'utf-8') + '{"id":"three"}\n');
    };
    await archiveSegment(source, archive, compress);

    // No archive, because it does not hold the whole segment — and no partial left
    // behind either: a `.part` is invisible to readers but it is still a file nobody
    // will ever finish writing.
    expect(existsSync(archive)).toBe(false);
    expect(readdirSync(dir)).toEqual(['audit-20260101-0001.ndjson']);

    // And the entries are all there: three lines, readable, in the plain segment. This
    // is the whole point — the alternative is an archive with two of them, which is a
    // reader that answers `null` for an entry the store is holding.
    expect(readFileSync(source, 'utf-8')).toBe('{"id":"one"}\n{"id":"two"}\n{"id":"three"}\n');
  });

  it('WS.3: the ordinary case still publishes', async () => {
    const source = join(dir, 'audit-20260101-0002.ndjson');
    const archive = `${source}.gz`;
    writeFileSync(source, '{"id":"only"}\n');

    await archiveSegment(source, archive);

    // The guard on the growing case must not have turned the feature off: a segment
    // that did not grow is archived and unlinked, so exactly one name is left.
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readdirSync(dir)).toEqual(['audit-20260101-0002.ndjson.gz']);
  });

  it('WS.3b: a segment that vanished mid-compression is still published', async () => {
    const source = join(dir, 'audit-20260101-0003.ndjson');
    const archive = `${source}.gz`;
    writeFileSync(source, '{"id":"gone"}\n');

    // Removed by an operator, an expiry sweep of another process, or a `prune` between
    // the rotation and the compression finishing. The archive is the only copy of that
    // entry now, so it must be published — "the file is gone" and "the file changed"
    // are different answers and only one of them is a reason not to publish.
    const compress = async (from: string, to: string): Promise<void> => {
      writeFileSync(to, 'compressed-before-the-removal');
      rmSync(from);
    };
    await archiveSegment(source, archive, compress);

    expect(existsSync(archive)).toBe(true);
    expect(readdirSync(dir)).toEqual(['audit-20260101-0003.ndjson.gz']);
  });
});
