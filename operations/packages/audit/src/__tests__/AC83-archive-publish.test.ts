/**
 * AC 83 — an archive is published when it is complete, and not before.
 *
 * Compression used to write straight to `<segment>.ndjson.gz`, and the reader prefers
 * an archive over the plain segment of the same name — which it must, because between
 * the archive and the unlink both hold the same entries and a scan that read both
 * would report every one of them twice, a duplicate in a compliance statement. Put
 * those two together and the store hid its own data: for the whole duration of a
 * compression — about a second on a fifty-megabyte segment — the archive existed and
 * was incomplete, the plain segment was complete and was suppressed by it, and
 * `get(id)` answered `null` for an entry sitting on the disk.
 *
 * The recipe is now three steps and the same rule as the write path: nothing is
 * published before it is complete. Compress into `<archive>.part` — a name no reader
 * believes in — then `rename` (atomic within a directory) and unlink the plain
 * segment in the same synchronous block, so the two never coexist inside one process.
 *
 * What each case is for:
 *
 *   AP.1  while a compression runs, the archive does not exist and the entries are readable
 *   AP.2  when it finishes, the archive is complete, the partial is gone, the plain is retired
 *   AP.3  a failed compression removes its partial and keeps the plain segment
 *   AP.4  a compression whose source has gone publishes nothing and does not throw
 *   AP.5  a partial left by a dead process is swept at construction and never read
 *   AP.6  a partial name is not a segment, by every rule that decides what one is
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileAuditStore,
  PARTIAL_ARCHIVE_SUFFIX,
  archiveSegment,
  gzipFile,
  newestOpenSegment,
  segmentPattern,
} from '../impl/FileAuditStore.js';
import type { CompressFile } from '../impl/FileAuditStore.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ac83-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const SEGMENT = 'audit-20260101-0001.ndjson';

function line(id: string, operation: string): string {
  return `${JSON.stringify({
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    operation,
    actor: 'auditor',
    resource: '/db/orders',
    result: 'success',
    severity: 'info',
  })}\n`;
}

/** A compression that can be held open, so the window it creates can be observed. */
function gatedCompression(): { compress: CompressFile; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    started: hasStarted,
    release,
    compress: async (source, destination) => {
      // A partial archive in progress: a few bytes that decompress to nothing.
      writeFileSync(destination, 'partial');
      started();
      await gate;
      await gzipFile(source, destination);
    },
  };
}

describe('AC 83 — publishing an archive', () => {
  it('AP.1: while a compression runs, the archive is absent and the entries are readable', async () => {
    const source = join(dataDir, SEGMENT);
    writeFileSync(source, line('e1', 'INSERT'));

    // The reader is built first, and it adopts the plain segment. It must keep
    // finding the entry for as long as the compression runs — this is the whole
    // point: the plain segment is complete, and nothing is allowed to suppress it.
    const store = new FileAuditStore({ dataDir });
    expect(await store.get('e1')).not.toBeNull();

    const gate = gatedCompression();
    const running = archiveSegment(source, `${source}.gz`, gate.compress);
    await gate.started;

    // The archive name does not exist, so no reader can prefer it; what exists is a
    // partial, under a name the segment rules reject.
    expect(existsSync(`${source}.gz`)).toBe(false);
    expect(existsSync(`${source}.gz${PARTIAL_ARCHIVE_SUFFIX}`)).toBe(true);
    expect(await store.get('e1')).toMatchObject({ operation: 'INSERT' });
    expect(await store.count()).toBe(1);

    gate.release();
    await running;
  });

  it('AP.2: when it finishes, the archive is complete, the partial is gone, the plain is retired', async () => {
    const source = join(dataDir, SEGMENT);
    writeFileSync(source, line('e1', 'INSERT'));

    const gate = gatedCompression();
    const running = archiveSegment(source, `${source}.gz`, gate.compress);
    await gate.started;
    gate.release();
    await running;

    expect(existsSync(`${source}.gz`)).toBe(true);
    expect(existsSync(`${source}.gz${PARTIAL_ARCHIVE_SUFFIX}`)).toBe(false);
    // Retired in the same synchronous block as the rename, so a scan in this process
    // can never see both names and count the entry twice.
    expect(existsSync(source)).toBe(false);

    const store = new FileAuditStore({ dataDir });
    expect(await store.count()).toBe(1);
    expect(await store.get('e1')).toMatchObject({ operation: 'INSERT' });
  });

  it('AP.3: a failed compression removes its partial and keeps the plain segment', async () => {
    const source = join(dataDir, SEGMENT);
    writeFileSync(source, line('e1', 'INSERT'));

    // The archive path is occupied by a directory, so the rename that publishes it
    // refuses — the failure arrives after the compression itself succeeded, which is
    // the case where a naive implementation has already written an archive.
    rmSync(`${source}.gz`, { force: true, recursive: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(`${source}.gz`);

    await expect(archiveSegment(source, `${source}.gz`)).rejects.toThrow();

    expect(existsSync(source)).toBe(true);
    expect(existsSync(`${source}.gz${PARTIAL_ARCHIVE_SUFFIX}`)).toBe(false);

    // An archive that is not there is a cost; an archive that is there and empty is a
    // lost entry. The store reads the plain segment, so the entry survives.
    const store = new FileAuditStore({ dataDir });
    expect(await store.get('e1')).toMatchObject({ operation: 'INSERT' });
  });

  it('AP.4: a compression whose source has gone publishes nothing and does not throw', async () => {
    const source = join(dataDir, SEGMENT);

    // No source at all: an operator or an unmount took it between the rotation and
    // the check phase that runs the compressor. Nothing to compress, nothing to
    // publish, and no rejection — the rotation's own bookkeeping is not a failure.
    await expect(archiveSegment(source, `${source}.gz`)).resolves.toBeUndefined();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('AP.4b: a cleanup that fails does not replace the failure that caused it', async () => {
    const source = join(dataDir, SEGMENT);
    writeFileSync(source, line('e1', 'INSERT'));

    // Two failures at once: the compression fails, and so does the removal of its
    // partial — which a runner that deletes as root cannot arrange, so the removal is
    // handed over. What must reach the caller is the compression, because that is the
    // one that explains why the archive is missing; a cleanup error surfacing instead
    // would describe the bookkeeping and hide the cause.
    const compressionFailed = new Error('compression failed');
    await expect(
      archiveSegment(
        source,
        `${source}.gz`,
        () => Promise.reject(compressionFailed),
        () => {
          throw new Error('cleanup failed');
        },
      ),
    ).rejects.toBe(compressionFailed);
  });

  it('AP.5: a partial left by a dead process is swept at construction and never read', async () => {
    const source = join(dataDir, SEGMENT);
    writeFileSync(source, line('e1', 'INSERT'));
    // What a process killed mid-compression leaves: a partial with no archive and a
    // plain segment still in place. Nothing reads it, and nothing would ever remove
    // it, so a deployment would grow by one file per crash for its whole life.
    const partial = join(dataDir, `${SEGMENT}.gz${PARTIAL_ARCHIVE_SUFFIX}`);
    writeFileSync(partial, 'half an archive');

    const store = new FileAuditStore({ dataDir });

    expect(existsSync(partial)).toBe(false);
    expect(await store.count()).toBe(1);
    expect(await store.get('e1')).toMatchObject({ operation: 'INSERT' });
  });

  it('AP.6: a partial name is not a segment, by every rule that decides what one is', () => {
    const partial = `${SEGMENT}.gz${PARTIAL_ARCHIVE_SUFFIX}`;

    // Three rules decide what the store reads, writes and deletes. A partial that any
    // of them accepted would be read as an archive (returning nothing), adopted as the
    // active segment (and appended to), or kept past its retention.
    expect(segmentPattern('audit').test(partial)).toBe(false);
    // Adoption is the one that would corrupt: a store that opened a partial as its
    // active segment would append real entries to a file that is about to be renamed
    // or deleted.
    expect(newestOpenSegment([SEGMENT, partial], 'audit')).toBe(SEGMENT);
    // The reader's own filter is a suffix test, and a partial fails it by
    // construction — which is why a half-written archive cannot be mistaken for one.
    expect(partial.endsWith('.ndjson.gz')).toBe(false);
  });
});
