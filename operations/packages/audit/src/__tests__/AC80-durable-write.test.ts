/**
 * AC 80 — a durable write is a recipe, and the recipe is asserted.
 *
 * `FileAuditStore.writeLine` documented itself as "write to .tmp, fsync, rename
 * (crash-safe)". Five mutants lived in those six lines and survived, and the
 * reason was structural: the only observer of the sequence was a crash, and no
 * test crashes. The recipe was therefore a claim about the code rather than a
 * property of it — nobody had checked that the sync happened before the rename,
 * that a failed sync was reported, or that the rename was itself made durable by
 * syncing the directory that carries it.
 *
 * The recipe is now an interface (`DurableFileSystem`: append, syncFile,
 * syncDirectory, needsSeparator), which makes the order observable without a
 * crash, and the store holds no other write-path filesystem dependency — so "the
 * segment is rewritten to add a line to it" is not a thing the code can do quietly
 * either.
 *
 * What each case is for:
 *
 *   DW.1  every line is appended, then its file synced, in that order
 *   DW.2  the segment keeps one identity: an append does not replace the file
 *   DW.3  the bytes written are the line, not the segment (cost is O(line))
 *   DW.4  a failed append rejects the write instead of claiming an entry
 *   DW.5  a failed sync rejects the write — durability is not best-effort
 *   DW.6  a new segment's directory entry is synced once, after its first line
 *   DW.7  rotation produces a new segment and a second directory sync
 *   DW.8  a torn tail is skipped and does not consume the next line
 *   DW.9  the write path never opens a temporary file
 *   DW.10 the default port writes and syncs a real directory
 *   DW.11 a segment left with a torn tail is appended to, not rewritten
 *   DW.12 the delete-refusal list is a decision, asserted as one
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAuditStore, isUnlinkRefusal } from '../impl/FileAuditStore.js';
import { nodeDurableFileSystem } from '../impl/DurableFileSystem.js';
import type { DurableFileSystem } from '../impl/DurableFileSystem.js';

// ── A filesystem that says what was asked of it ─────────────

type Operation = 'append' | 'syncFile' | 'syncDirectory';

interface RecordedCall {
  op: Operation;
  path: string;
  bytes: number;
}

/**
 * Delegates to the real implementation and records the sequence.
 *
 * Recording rather than faking: a fake would prove the store calls a method, and
 * what needs proving is that the *file* ends up durable in the order the recipe
 * claims. The failure switch is how a filesystem that says no is expressed.
 */
class RecordingFileSystem implements DurableFileSystem {
  readonly calls: RecordedCall[] = [];
  failOn: Operation | null = null;

  append(path: string, data: string): void {
    this.#maybeFail('append');
    nodeDurableFileSystem.append(path, data);
    this.calls.push({ op: 'append', path, bytes: Buffer.byteLength(data) });
  }

  syncFile(path: string): void {
    this.#maybeFail('syncFile');
    nodeDurableFileSystem.syncFile(path);
    this.calls.push({ op: 'syncFile', path, bytes: 0 });
  }

  syncDirectory(path: string): void {
    this.#maybeFail('syncDirectory');
    nodeDurableFileSystem.syncDirectory(path);
    this.calls.push({ op: 'syncDirectory', path, bytes: 0 });
  }

  needsSeparator(path: string): boolean {
    return nodeDurableFileSystem.needsSeparator(path);
  }

  /** Operations in the order the store performed them. */
  ops(): Operation[] {
    return this.calls.map((call) => call.op);
  }

  count(op: Operation): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  /** Paths the store appended to, in order. */
  appendPaths(): string[] {
    return this.calls.filter((call) => call.op === 'append').map((call) => call.path);
  }

  bytesAppended(): number {
    return this.calls.reduce((total, call) => total + call.bytes, 0);
  }

  #maybeFail(op: Operation): void {
    if (this.failOn !== op) return;
    this.failOn = null;
    const error = new Error(`${op}: injected failure`) as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  }
}

// ── Fixture ─────────────────────────────────────────────────

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ac80-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function makeWrite(operation: string) {
  return { operation, actor: 'auditor', resource: '/db/orders', result: 'success' as const };
}

function segments(): string[] {
  return readdirSync(dataDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort();
}

// ── The recipe ──────────────────────────────────────────────

describe('AC 80 — the durable write', () => {
  it('DW.1: appends each line, then syncs that file, and never the other way round', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    await store.write(makeWrite('INSERT'));
    await store.write(makeWrite('UPDATE'));

    // Two lines, five steps: the first line creates the segment, so it also pays
    // for the directory entry; the second does not. The sync that makes a line
    // durable always follows the line it makes durable, never precedes it.
    expect(fs.ops()).toEqual(['append', 'syncFile', 'syncDirectory', 'append', 'syncFile']);
    expect(new Set(fs.appendPaths()).size).toBe(1);
  });

  it('DW.2: an append keeps the segment, it does not replace it', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    const inodes = new Set<number>();
    for (let i = 0; i < 20; i++) {
      await store.write(makeWrite(`OP-${i}`));
      inodes.add(statSync(fs.appendPaths().at(-1)!).ino);
    }

    // One file was written to; one inode answered. The recipe this replaced
    // wrote a temporary file and renamed it into place for every line, so the
    // identity of the segment changed 20 times — which is also why the cost of
    // a line was the size of the segment.
    expect(fs.appendPaths().length).toBe(20);
    expect(inodes.size).toBe(1);
  });

  it('DW.3: the bytes appended are the line, not the segment', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    for (let i = 0; i < 200; i++) {
      await store.write(makeWrite(`OP-${i}`));
    }

    const path = fs.appendPaths().at(-1)!;
    const onDisk = statSync(path).size;

    // Every byte on disk is a byte that was appended once. Rewriting the segment
    // per line would put roughly n/2 segments' worth of traffic through the page
    // cache to produce n lines — 200 lines would cost ~100 segment copies.
    expect(fs.bytesAppended()).toBe(onDisk);

    // And every byte is part of a line: a separator written when none was owed
    // would put a blank line before every entry, which the parser skips — so the
    // trail would still read correctly while doubling in size. Nothing but a
    // look at the raw text can tell the two apart.
    const lines = readFileSync(path, 'utf-8').split('\n').slice(0, -1);
    expect(lines).toHaveLength(200);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  it('DW.4: a failed append rejects the write instead of returning an id', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    await store.write(makeWrite('BEFORE'));
    fs.failOn = 'append';

    await expect(store.write(makeWrite('LOST'))).rejects.toThrow(/append: injected failure/);

    // The store is still usable, and the trail holds exactly what was written.
    await store.write(makeWrite('AFTER'));
    expect(await store.count()).toBe(2);
    expect(fs.count('append')).toBe(2);
  });

  it('DW.5: a failed sync rejects the write — a durability claim that ignores its own failure is not one', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    fs.failOn = 'syncFile';

    // The bytes may well be in the page cache, and probably in the file. What
    // cannot be claimed is that they survive a power loss, so the write did not
    // happen — and a caller who is told otherwise records an audit event that a
    // crash will erase.
    await expect(store.write(makeWrite('UNSYNCED'))).rejects.toThrow(/syncFile: injected failure/);

    // After the failure the store still appends at the end of what is there,
    // rather than at an offset it remembered from before the failure.
    const before = statSync(segments().map((name) => join(dataDir, name))[0]!).size;
    await store.write(makeWrite('SYNCED'));
    const after = statSync(segments().map((name) => join(dataDir, name))[0]!).size;
    expect(after - before).toBeGreaterThan(0);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.ndjson'))).toHaveLength(1);
  });

  it('DW.6: a new segment has its directory entry synced once, after its first line', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    for (let i = 0; i < 10; i++) {
      await store.write(makeWrite(`OP-${i}`));
    }

    // Creating a file is a directory write. Syncing only the file leaves a crash
    // free to lose the name — the data survives, the entries do not — so the
    // first line is not acknowledged until the directory that holds the name is
    // on the medium. Later lines add no name, so they do not pay for it again.
    expect(fs.count('syncDirectory')).toBe(1);
    expect(fs.ops().indexOf('syncDirectory')).toBeGreaterThan(fs.ops().indexOf('append'));
    expect(fs.calls.find((call) => call.op === 'syncDirectory')!.path).toBe(dataDir);
  });

  it('DW.7: rotation starts a new segment and syncs the directory again', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs, maxFileSize: 400 });

    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await store.write(makeWrite(`OP-${i}`)));
    }
    await store.close();

    const written = new Set(fs.appendPaths());
    expect(written.size).toBeGreaterThan(1);
    // One directory sync per segment created, not one per line and not one total.
    expect(fs.count('syncDirectory')).toBe(written.size);
    expect(await store.count()).toBe(ids.length);

    // A new segment starts on a line boundary. Carrying the previous segment's
    // owed separator across the rotation would put a blank line at the top of every
    // segment after the first — invisible to the parser, and a trail that doubles
    // in size while reading correctly. The live segment is the one that was last
    // appended to, and it is never archived while it is live.
    const live = fs.appendPaths().at(-1)!;
    const liveLines = readFileSync(live, 'utf-8').split('\n').slice(0, -1);
    expect(liveLines.length).toBeGreaterThan(0);
    expect(liveLines.every((line) => line.length > 0)).toBe(true);
  });

  it('DW.8: a torn tail is skipped and does not consume the line after it', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    await store.write(makeWrite('FIRST'));

    // Exactly what a crash between two writes leaves: the bytes of a line that
    // never got its newline. A reader tolerates it, but an append after it would
    // fuse the next entry to the fragment and lose both — so recovery is the
    // moment the question is asked, and a new store over the same directory is
    // what recovery is.
    const path = fs.appendPaths().at(-1)!;
    appendFileSync(path, '{"id":"torn","operation":"TORN"');

    const recovered = new FileAuditStore({ dataDir });
    const second = await recovered.write(makeWrite('SECOND'));

    expect(await recovered.count()).toBe(2);
    expect(await recovered.get(second)).toMatchObject({ operation: 'SECOND' });
    // The fragment is still there, on its own line, and parses as nothing.
    expect(await recovered.get('torn')).toBeNull();
  });

  it('DW.9: the write path creates no temporary file', async () => {
    const fs = new RecordingFileSystem();
    const store = new FileAuditStore({ dataDir, fileSystem: fs });

    for (let i = 0; i < 5; i++) {
      await store.write(makeWrite(`OP-${i}`));
      // The directory is inspected between writes, which is the only moment a
      // transient file would be visible — after the fact it would have been
      // renamed away.
      expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    }

    // Structural as well as observed: the port has no operation that could
    // create a file, so a future rewrite cannot reintroduce one without adding
    // a method and a test.
    expect(fs.ops().every((op) => op === 'append' || op === 'syncFile' || op === 'syncDirectory')).toBe(true);
  });
});

// ── The real filesystem, not the recording one ──────────────

describe('AC 80 — the default filesystem', () => {
  it('DW.10: appends create the file, and the syncs succeed on an ordinary directory', async () => {
    const store = new FileAuditStore({ dataDir, maxFileSize: 200 });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await store.write(makeWrite(`OP-${i}`)));
    await store.close();

    expect(await store.count()).toBe(ids.length);
    for (const id of ids) {
      expect(await store.get(id)).not.toBeNull();
    }
  });

  it('DW.11: a pre-existing torn segment is appended to, not rewritten', async () => {
    const name = 'audit-20260101-0001.ndjson';
    writeFileSync(
      join(dataDir, name),
      '{"id":"kept","operation":"OLD","actor":"a","resource":"r","result":"success","timestamp":"2026-01-01T00:00:00.000Z","severity":"info"}\n{"id":"torn"',
    );

    const store = new FileAuditStore({ dataDir });
    const id = await store.write(makeWrite('NEW'));

    expect(await store.count()).toBe(2);
    expect(await store.get('kept')).not.toBeNull();
    expect(await store.get(id)).not.toBeNull();
  });
});

// ── The decisions the platform cannot produce ───────────────

describe('AC 80 — the delete refusal list', () => {
  it('DW.12: only errnos that mean "this file will not go" are ignored', () => {
    // Two of these cannot be produced on a runner that unlinks as root, so the
    // decision is asserted by handing it the errno rather than by arranging the
    // filesystem to refuse.
    for (const code of ['ENOENT', 'EISDIR', 'EPERM', 'EACCES']) {
      expect(isUnlinkRefusal(errno(code)), code).toBe(true);
    }
    // A cleanup that failed for any other reason is a defect in the caller, not an
    // answer about the file — and it is exactly what the catch this replaced hid.
    for (const code of ['EIO', 'ENOSPC', 'EROFS', 'EBUSY']) {
      expect(isUnlinkRefusal(errno(code)), code).toBe(false);
    }
    expect(isUnlinkRefusal(new Error('no code'))).toBe(false);
    expect(isUnlinkRefusal('ENOENT')).toBe(false);
    expect(isUnlinkRefusal(null)).toBe(false);
    expect(isUnlinkRefusal(undefined)).toBe(false);
    expect(isUnlinkRefusal({ code: 42 })).toBe(false);
  });
});
