/**
 * FileAuditStore — degradation paths.
 *
 * An audit store is read after the fact, usually on the worst day. The cases
 * here are the ones that decide whether a damaged directory is a *readable*
 * audit trail with holes or an exception nobody can act on:
 *
 *   - a torn last line (the process died mid-write) must not hide the entries
 *     before it
 *   - a corrupt legacy `.json` array must not fail the whole query
 *   - `maxScanLines` must bound the scan even when the bound falls between files
 *   - rotating a segment that was never written must not start a compressor over
 *     a file that does not exist
 *   - a directory that disappears (unmounted, pruned by an operator) must make
 *     the write fail loudly while the readers return empty rather than throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileAuditStore, type FileAuditStoreConfig } from '../impl/FileAuditStore.js';

// Per-process: a fixed path lets a second run on the same machine delete this
// run's segments mid-test.
const TEST_DIR = mkdtempSync(join(tmpdir(), 'audit-degradation-'));

const ENTRY = {
  operation: 'LOGIN',
  actor: 'admin',
  resource: '/api/login',
  result: 'success' as const,
};

function makeConfig(overrides: Partial<FileAuditStoreConfig> = {}): FileAuditStoreConfig {
  return { dataDir: TEST_DIR, maxFileSize: 10 * 1024, maxAgeMs: 3_600_000, ...overrides };
}

/** Drop every segment, keeping the directory itself. */
function clearSegments(): void {
  for (const entry of readdirSync(TEST_DIR)) rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
}

describe('FileAuditStore — degraded directory', () => {
  let store: FileAuditStore | undefined;

  beforeEach(() => {
    clearSegments();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearSegments();
  });

  it('reads the entries before a torn final line', async () => {
    // The shape of a crash: two complete lines, then a third with no newline and
    // no closing brace. A parser that stops at the bad line reports one entry and
    // silently loses the second.
    store = new FileAuditStore(makeConfig());
    const first = await store.write(ENTRY);
    const second = await store.write({ ...ENTRY, actor: 'operator' });

    const segment = join(
      TEST_DIR,
      readdirSync(TEST_DIR).find((f) => f.endsWith('.ndjson'))!,
    );
    writeFileSync(segment, ['{"operation":"LOGIN"', ''].join('\n'), { flag: 'a' });

    const entries = await store.query({});

    expect(entries.map((e) => e.id)).toEqual([first, second]);
  });

  it('skips a corrupt legacy .json array instead of failing the query', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write(ENTRY);
    writeFileSync(join(TEST_DIR, 'audit-legacy.json'), '[{"id":"truncated"', 'utf-8');

    const entries = await store.query({});

    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('admin');
  });

  it('reads a well-formed legacy .json array', async () => {
    store = new FileAuditStore(makeConfig());
    const legacy = [
      { id: 'legacy-1', operation: 'DROP', actor: 'root', resource: '/t', result: 'success', severity: 'warn' },
      { id: 'legacy-2', operation: 'DROP', actor: 'root', resource: '/u', result: 'failure', severity: 'error' },
    ];
    writeFileSync(join(TEST_DIR, 'audit-legacy.json'), JSON.stringify(legacy), 'utf-8');

    const entries = await store.query({ operation: 'DROP' });

    expect(entries.map((e) => e.id)).toEqual(['legacy-1', 'legacy-2']);
  });

  it('spends the scan budget on the newest segments, not the oldest', async () => {
    // `maxScanLines` is a budget. Spent from the oldest segment, a store that grew
    // past it could not return anything written since - the caller asking "what
    // happened today" got last quarter. Each write rotates, so this is three
    // segments of one entry each with a budget of two.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0, maxScanLines: 2 }));
    await store.write({ ...ENTRY, actor: 'first' });
    const second = await store.write({ ...ENTRY, actor: 'second' });
    const third = await store.write({ ...ENTRY, actor: 'third' });
    await store.close();
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0, maxScanLines: 2 }));

    const entries = await store.query({});

    // The newest two, still presented in the order they happened.
    expect(entries.map((e) => e.id)).toEqual([second, third]);
  });

  it('stops scanning at maxScanLines even when the bound falls between files', async () => {
    // Two files, a bound of two: the first fills the budget exactly, so the cut
    // has to happen at the top of the file loop, not only inside it.
    store = new FileAuditStore(makeConfig({ maxScanLines: 2 }));
    await store.write(ENTRY);
    await store.write(ENTRY);
    await store.write(ENTRY);
    await store.close();
    writeFileSync(
      join(TEST_DIR, 'audit-0000-legacy.json'),
      JSON.stringify([{ id: 'legacy-1', operation: 'DROP', actor: 'root', resource: '/t', result: 'success' }]),
      'utf-8',
    );
    store = new FileAuditStore(makeConfig({ maxScanLines: 2 }));

    const entries = await store.query({});

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.id !== undefined)).toBe(true);
  });

  it('does not compress a segment that was never written', async () => {
    // `maxAgeMs: 0` rotates on the very first write, before any file exists. The
    // rotation must skip the compressor rather than start one over a missing file.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));
    await store.write(ENTRY);
    await store.close();

    const files = readdirSync(TEST_DIR);
    expect(files.filter((f) => f.endsWith('.gz'))).toEqual([]);
    expect(await store.count()).toBe(1);
  });

  it('survives a compressor whose source disappeared before it ran', async () => {
    // The rotation captures the segment's identity and schedules the compressor for
    // the check phase. An operator — or an unmount — removing the directory in
    // between leaves the compressor with nothing to read, and its cleanup with
    // nothing to remove. Neither may escape as a rejection: the job's promise is
    // resolved by `finally`, so an unhandled rejection here would fail a process
    // whose writes all succeeded.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));
    await store.write(ENTRY);
    await store.write(ENTRY); // rotates 0001 and schedules its compressor

    // The removal races the compressor's own `open(…, 'wx')`, which runs on a libuv
    // thread and can recreate the directory between this call's `unlink` and its
    // `rmdir` — which is how this case failed on a loaded CI runner with ENOTEMPTY,
    // an error about the *removal* standing in for the case about the compressor.
    // `maxRetries` is the kernel-race retry `fs.rmSync` exists for; the assertion
    // below is unchanged, and it is still about a directory that is gone.
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

    await expect(store.close()).resolves.toBeUndefined();
    store = undefined;
    ensureDir();
  });

  it('keeps the segment when its archive cannot be written', async () => {
    // The archive name is occupied by a directory, so the compression is written
    // to its partial name and the rename that would publish it refuses. Two things
    // must hold afterwards: the segment survives with its entries readable — an
    // audit trail that drops a segment because compressing it failed deletes
    // evidence to save space — and the reader must not let a directory that merely
    // shares the archive's name stand in for it, which would hide the complete
    // segment behind a name that holds nothing. The cleanup that removes the
    // partial must also not be able to fail the job, because nothing above it
    // handles the rejection.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));
    await store.write(ENTRY);
    await store.close();

    const segment = readdirSync(TEST_DIR).find((f) => f.endsWith('.ndjson'))!;
    mkdirSync(join(TEST_DIR, `${segment}.gz`));

    // The next write rotates: the retired segment is handed to the compressor.
    await store.write(ENTRY);
    await store.close();

    expect(existsSync(join(TEST_DIR, segment))).toBe(true);
    // No half-written archive was left behind either.
    expect(readdirSync(TEST_DIR).filter((f) => f.includes('.gz.part'))).toEqual([]);
    expect(await store.count()).toBe(2);
  });

  it('reports a write failure when the directory has been removed', async () => {
    // An operator (or an unmount) takes the directory away while the process runs.
    // The entry must not be silently dropped: the caller has to see the failure.
    store = new FileAuditStore(makeConfig({ maxFileSize: 0 }));
    rmSync(TEST_DIR, { recursive: true, force: true });

    await expect(store.write(ENTRY)).rejects.toThrow(/ENOENT/);

    // The constructor recreates the directory, so the closer below has somewhere
    // to look; `close()` must not throw for a store whose writes all failed.
    await store.close();
    store = undefined;
    ensureDir();
  });

  it('reads nothing, rather than throwing, when the directory has been removed', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write(ENTRY);

    rmSync(TEST_DIR, { recursive: true, force: true });

    expect(await store.query({})).toEqual([]);
    expect(await store.count()).toBe(0);
    expect(await store.get('anything')).toBeNull();

    await store.close();
    store = undefined;
    ensureDir();
  });

  it('prunes nothing when the directory has been removed', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write(ENTRY);
    const future = new Date(Date.now() + 60_000);

    rmSync(TEST_DIR, { recursive: true, force: true });

    expect(await store.pruneOlderThan(future)).toBe(0);

    await store.close();
    store = undefined;
    ensureDir();
  });

  it('prunes archived segments older than the horizon and keeps the active one', async () => {
    // Rotating archives the retired segment as `.gz`, so after two writes the
    // directory holds one archive and one live segment. Pruning past the archive's
    // age must remove exactly the archive.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));
    await store.write(ENTRY);
    await store.write(ENTRY);
    await store.close();

    const archive = readdirSync(TEST_DIR).find((f) => f.endsWith('.ndjson.gz'));
    const active = readdirSync(TEST_DIR).find((f) => f.endsWith('.ndjson'));
    expect(archive).toBeDefined();
    expect(active).toBeDefined();

    const past = new Date(Date.now() - 86_400_000);
    utimesSync(join(TEST_DIR, archive!), past, past);

    const removed = await store.pruneOlderThan(new Date(Date.now() - 3_600_000));

    expect(removed).toBe(1);
    expect(existsSync(join(TEST_DIR, archive!))).toBe(false);
    expect(existsSync(join(TEST_DIR, active!))).toBe(true);
  });

  it('reads entries back after rotation has archived their segment', async () => {
    // The defect this pins: rotation gzips the retired segment, and the reader only
    // opened `.ndjson`. After the first rotation the audit trail was on disk and
    // invisible - `query()` returned only the current segment, `get()` could not
    // find an entry by id, and `count()` under-reported. For an audit store, a
    // trail that disappears when it is rotated is not an audit trail.
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));
    const first = await store.write(ENTRY);
    const second = await store.write({ ...ENTRY, actor: 'operator' });
    await store.close();
    store = new FileAuditStore(makeConfig({ maxAgeMs: 0 }));

    expect(readdirSync(TEST_DIR).some((f) => f.endsWith('.ndjson.gz'))).toBe(true);

    const entries = await store.query({});
    expect(entries.map((e) => e.id)).toEqual([first, second]);
    expect(await store.get(first)).not.toBeNull();
    expect(await store.count()).toBe(2);
  });

  it('counts a segment once while its archive is being written', async () => {
    // Rotation writes the `.gz` and only then removes the original. A query that
    // lands in that window sees both, and reading both reports every entry twice -
    // a duplicate in an audit report is a wrong number, not a cosmetic issue.
    store = new FileAuditStore(makeConfig());
    const id = await store.write(ENTRY);
    await store.close();

    const segment = readdirSync(TEST_DIR).find((f) => f.endsWith('.ndjson'))!;
    const lines = readFileSync(join(TEST_DIR, segment), 'utf-8');
    writeFileSync(join(TEST_DIR, `${segment}.gz`), gzipSync(Buffer.from(lines)));

    // Both files are present, exactly as they are mid-archive.
    expect(readdirSync(TEST_DIR).sort()).toEqual([segment, `${segment}.gz`].sort());

    const entries = await store.query({});
    expect(entries.map((e) => e.id)).toEqual([id]);
    expect(await store.count()).toBe(1);
  });

  it('skips a corrupt archive instead of failing the query', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write(ENTRY);
    writeFileSync(join(TEST_DIR, 'audit-20200101-0001.ndjson.gz'), Buffer.from('not gzip at all'));
    await store.close();

    const entries = await store.query({});

    expect(entries).toHaveLength(1);
    expect(await store.count()).toBe(1);
  });

  it('applies its documented defaults when only a directory is given', async () => {
    // No rotation at 50 MB / 24 h, so three writes stay in one segment and the
    // defaults are what decided that.
    store = new FileAuditStore({ dataDir: TEST_DIR });
    await store.write(ENTRY);
    await store.write(ENTRY);
    await store.write(ENTRY);
    await store.close();

    expect(readdirSync(TEST_DIR).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);
    expect(await store.count()).toBe(3);
  });
});

/** Several cases remove the directory on purpose; give the next one a path. */
function ensureDir(): void {
  mkdirSync(TEST_DIR, { recursive: true });
}
