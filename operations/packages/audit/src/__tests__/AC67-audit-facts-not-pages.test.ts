/**
 * AC 67 — the audit store's answers are facts, not pages.
 *
 * Every case here is a question a compliance reader asks and gets a *number* back
 * for, which is why each one is asserted against a fact rather than a shape:
 *
 *   AC 67.1–67.4   `count(filter)` counts what the filter selects. Paging is not
 *                  selection, so `limit` and `offset` must not shorten a count —
 *                  the store used to route `count` through `query`, whose default
 *                  page is 100, so any filter with more than a hundred matches
 *                  reported exactly one hundred.
 *   AC 67.5–67.6   `get(id)` and `count()` look up the whole trail. `maxScanLines`
 *                  bounds a page; an id that exists but sits past the budget is
 *                  still an id that exists.
 *   AC 67.7–67.10  the active segment is chosen by name, not by sequence field, and
 *                  never one that already has an archive — appending there writes
 *                  entries every read then ignores.
 *   AC 67.11–67.13 retention is enforced, on closed segments only, and `0` means
 *                  "never expire" rather than "delete everything".
 *   AC 67.14–67.18 prune removes only what it can name and can remove, and says so.
 *   AC 67.19–67.21 reading order and the archive-wins rule, asserted on the pure
 *                  function so the answer does not depend on `readdir` order.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FileAuditStore,
  readableSegmentsNewestFirst,
  newestOpenSegment,
  segmentPattern,
  escapeRegExp,
  fileIdentity,
  unlinkIfUnchanged,
  type FileAuditStoreConfig,
} from '../impl/FileAuditStore.js';
import type { AuditQueryFilter } from '../interfaces/index.js';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'audit-facts-'));

const DAY_MS = 24 * 60 * 60 * 1000;

function makeConfig(overrides: Partial<FileAuditStoreConfig> = {}): FileAuditStoreConfig {
  return { dataDir: TEST_DIR, maxFileSize: 10 * 1024, maxAgeMs: 3_600_000, ...overrides };
}

function clearDir(): void {
  // One case removes the directory on purpose (AC 67.18), so this recreates it
  // rather than assuming the previous test left it in place.
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
    return;
  }
  for (const entry of readdirSync(TEST_DIR)) rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
}

/** Write `count` entries, alternating the actor so a filter has something to select. */
async function seed(store: FileAuditStore, count: number, actor = 'alice'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      await store.write({
        operation: 'LOGIN',
        actor: i % 2 === 0 ? actor : 'bob',
        resource: '/api/login',
        result: 'success',
      }),
    );
  }
  return ids;
}

/** One NDJSON line, as the store writes it. */
function line(id: string, actor = 'alice'): string {
  return `${JSON.stringify({
    id,
    timestamp: '2026-11-16T00:00:00.000Z',
    operation: 'LOGIN',
    actor,
    resource: '/api/login',
    result: 'success',
    severity: 'info',
  })}\n`;
}

function segment(name: string, body: string | Buffer): string {
  const path = join(TEST_DIR, name);
  writeFileSync(path, body);
  return path;
}

describe('AC 67 — count is a fact, not a page', () => {
  let store: FileAuditStore | undefined;

  beforeEach(() => {
    clearDir();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearDir();
  });

  it('AC 67.1: counts every match past the default page size', async () => {
    store = new FileAuditStore(makeConfig());
    await seed(store, 250, 'alice');

    // 250 entries: every even index is alice, so 125 matches. The page is capped at
    // 100 by `query`'s default limit; the count is not a page.
    expect(await store.count({ actor: 'alice' })).toBe(125);
    expect(await store.count({ actor: 'bob' })).toBe(125);
    expect(await store.count({})).toBe(250);
    expect(await store.count()).toBe(250);

    // And the page really is still a page, which is what makes the two different
    // answers correct rather than contradictory.
    expect(await store.query({ actor: 'alice' })).toHaveLength(100);
  });

  it('AC 67.2: an offset does not change a count', async () => {
    store = new FileAuditStore(makeConfig());
    await seed(store, 30, 'alice');

    expect(await store.count({ offset: 25 })).toBe(30);
    expect(await store.count({ offset: 25, limit: 2 })).toBe(30);
    expect(await store.query({ offset: 25 })).toHaveLength(5);
  });

  it('AC 67.3: an explicit limit does not change a count', async () => {
    store = new FileAuditStore(makeConfig());
    await seed(store, 24, 'alice');

    expect(await store.count({ limit: 1 })).toBe(24);
    expect(await store.count({ actor: 'alice', limit: 1 })).toBe(12);
  });

  it('AC 67.4: the filter a count applies is the filter a query applies', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'A', actor: 'x', resource: 'r', result: 'success', severity: 'warning' });
    await store.write({ operation: 'B', actor: 'x', resource: 'r', result: 'denied', severity: 'error' });
    await store.write({ operation: 'A', actor: 'y', resource: 'r', result: 'denied', severity: 'warning' });

    const filters: AuditQueryFilter[] = [
      { operation: 'A' },
      { actor: 'x' },
      { result: 'denied' },
      { severity: 'warning' },
      { operation: 'A', actor: 'x' },
      { operation: 'A', result: 'success' },
    ];
    for (const filter of filters) {
      // Same filter, same answer: a count that selects differently from the page
      // it counts is the shape of a broken audit report.
      expect(await store.count(filter)).toBe((await store.query({ ...filter, limit: 1000 })).length);
    }
  });
});

describe('AC 67 — a lookup is not a page', () => {
  let store: FileAuditStore | undefined;

  beforeEach(() => {
    clearDir();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearDir();
  });

  it('AC 67.5: get() finds an entry beyond the scan budget', async () => {
    store = new FileAuditStore(makeConfig({ maxScanLines: 2 }));
    const ids = await seed(store, 10, 'alice');

    // The oldest id is far outside a two-line budget. Reporting `null` here would
    // make an existing audit entry unverifiable.
    expect(await store.get(ids[0]!)).not.toBeNull();
    expect((await store.get(ids[0]!))!.id).toBe(ids[0]);
    // A page still obeys the budget.
    expect(await store.query({})).toHaveLength(2);
  });

  it('AC 67.6: count() without a filter counts the trail, not the budget', async () => {
    store = new FileAuditStore(makeConfig({ maxScanLines: 3 }));
    await seed(store, 12, 'alice');

    expect(await store.count()).toBe(12);
  });
});

describe('AC 67 — the active segment is chosen by name', () => {
  beforeEach(() => {
    clearDir();
  });

  afterEach(() => {
    clearDir();
  });

  it('AC 67.7: a restart appends to the newest segment, not the highest sequence', async () => {
    // Both segments are open — neither archived. Yesterday closed with three
    // rotations, so its sequence field is 0003; today's first segment is 0001.
    // Comparing sequence fields alone picks yesterday's file, and every entry
    // written afterwards lands in a segment whose name says it is a day older.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const todaySegment = `audit-${today}-0001.ndjson`;
    segment('audit-20261115-0003.ndjson', line('yesterday'));
    segment(todaySegment, line('earlier-today'));

    const store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'TODAY', actor: 'alice', resource: 'r', result: 'success' });

    expect(readFileSync(join(TEST_DIR, todaySegment), 'utf-8')).toContain('TODAY');
    expect(readFileSync(join(TEST_DIR, 'audit-20261115-0003.ndjson'), 'utf-8')).not.toContain('TODAY');
    await store.close();
  });

  it('AC 67.7b: a single open segment is resumed, not abandoned', async () => {
    // A segment that spans midnight is legitimate — `maxAgeMs` rotates on age, not
    // on the calendar — so the newest open segment is resumed even when it was
    // created yesterday. The rule is "newest wins", not "today only".
    segment('audit-20261115-0003.ndjson', line('yesterday'));

    const store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'RESUMED', actor: 'alice', resource: 'r', result: 'success' });

    expect(readdirSync(TEST_DIR)).toEqual(['audit-20261115-0003.ndjson']);
    expect(readFileSync(join(TEST_DIR, 'audit-20261115-0003.ndjson'), 'utf-8')).toContain('RESUMED');
    await store.close();
  });

  it('AC 67.8: a segment that already has an archive is never the active one', async () => {
    // The crash window of a rotation: the archive exists, the plain file has not
    // been unlinked yet. Appending to it would write entries that every read
    // discards, because the archive wins.
    segment('audit-20261115-0001.ndjson.gz', gzipSync(Buffer.from(line('archived'))));
    segment('audit-20261115-0001.ndjson', line('archived'));

    const store = new FileAuditStore(makeConfig({ maxFileSize: 10 * 1024 * 1024 }));
    await store.write({ operation: 'LIVE', actor: 'alice', resource: 'r', result: 'success' });

    expect(await store.count()).toBe(2);
    const entries = await store.query({ limit: 10 });
    expect(entries.map((e) => e.operation)).toEqual(['LOGIN', 'LIVE']);
    await store.close();
  });

  it('AC 67.9: a new segment does not reuse an archived sequence number', async () => {
    segment('audit-20260101-0001.ndjson.gz', gzipSync(Buffer.from(line('a'))));
    segment('audit-20260101-0002.ndjson.gz', gzipSync(Buffer.from(line('b'))));

    const store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'NEW', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    const names = readdirSync(TEST_DIR).sort();
    // Every name is unique and no plain file has an archive of the same segment.
    expect(new Set(names).size).toBe(names.length);
    for (const name of names.filter((f) => f.endsWith('.ndjson'))) {
      expect(names).not.toContain(`${name}.gz`);
    }
    // The new entry is readable, which is the property the collision would break.
    const reopened = new FileAuditStore(makeConfig());
    const found = await reopened.query({ operation: 'NEW' });
    expect(found).toHaveLength(1);
    await reopened.close();
  });

  it('AC 67.10: a prefix with a metacharacter names only its own segments', async () => {
    // `audit.v2` is a name. Interpolated raw into a pattern, the dot matches any
    // character, so `auditXv2-20260101-0001.ndjson` would be treated as a segment
    // of this store — and pruned by it.
    segment('auditXv2-20260101-0001.ndjson', line('foreign'));

    const store = new FileAuditStore(makeConfig({ filePrefix: 'audit.v2', maxFileSize: 10 * 1024 * 1024 }));
    await store.write({ operation: 'MINE', actor: 'alice', resource: 'r', result: 'success' });

    expect(await store.count()).toBe(1);
    expect(await store.query({ operation: 'foreign' })).toHaveLength(0);

    await store.pruneOlderThan(new Date(Date.now() + DAY_MS));
    // The foreign file is not this store's to delete.
    expect(existsSync(join(TEST_DIR, 'auditXv2-20260101-0001.ndjson'))).toBe(true);
    await store.close();
  });

  it('AC 67.11: escapeRegExp quotes every metacharacter, and the pattern is anchored', () => {
    expect(escapeRegExp('a.b*c+d?e(f)g[h]i{j}k|l\\m^$')).toBe(
      'a\\.b\\*c\\+d\\?e\\(f\\)g\\[h\\]i\\{j\\}k\\|l\\\\m\\^\\$',
    );
    // The same pattern matches a real segment name and rejects a lookalike.
    const pattern = segmentPattern('audit.v2');
    expect(pattern.test('audit.v2-20260101-0001.ndjson')).toBe(true);
    expect(pattern.test('audit.v2-20260101-0001.ndjson.gz')).toBe(true);
    expect(pattern.test('auditXv2-20260101-0001.ndjson')).toBe(false);
    expect(pattern.test('audit.v2-20260101-0001.ndjson.tmp')).toBe(false);
  });
});

describe('AC 67 — retention expires segments, not entries', () => {
  let store: FileAuditStore | undefined;

  beforeEach(() => {
    clearDir();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearDir();
  });

  it('AC 67.12: rotation expires a closed segment older than retention', async () => {
    // A ninety-day store that keeps everything is a retention policy nobody
    // enforces. The store is built first, so its live segment is today's name and
    // the fabricated old one is unambiguously a closed segment.
    store = new FileAuditStore(makeConfig({ maxFileSize: 1, retentionDays: 90 }));
    const old = segment('audit-20260101-0001.ndjson', line('old'));
    const oldGz = `${old}.gz`;
    writeFileSync(oldGz, gzipSync(Buffer.from(line('old'))));
    const longAgo = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldGz, longAgo, longAgo);

    // Two writes: the first fills the live segment past `maxFileSize: 1`, the
    // second is what closes it and starts the sweep.
    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    const names = readdirSync(TEST_DIR);
    expect(names.filter((f) => f.includes('20260101'))).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
  });

  it('AC 67.13: a fresh closed segment survives the sweep', async () => {
    store = new FileAuditStore(makeConfig({ maxFileSize: 1, retentionDays: 90 }));
    const recent = segment('audit-20260101-0001.ndjson', line('recent'));

    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    // Inside the window: the sweep is a cutoff, not a clear.
    expect(existsSync(recent)).toBe(true);
  });

  it('AC 67.14: retentionDays 0 disables the sweep instead of deleting everything', async () => {
    store = new FileAuditStore(makeConfig({ maxFileSize: 1, retentionDays: 0 }));
    const old = segment('audit-20260101-0001.ndjson', line('keeper'));
    const longAgo = new Date(Date.now() - 4000 * DAY_MS);
    utimesSync(old, longAgo, longAgo);

    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.write({ operation: 'FRESH', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    // `0` means "no automatic expiry", not "keep nothing": retention that deletes
    // evidence the moment a store is constructed is a footgun, and a caller who
    // wants to prune has `pruneOlderThan` with a date they chose.
    expect(existsSync(old)).toBe(true);
  });
});

describe('AC 67 — prune says what it did', () => {
  let store: FileAuditStore | undefined;

  beforeEach(() => {
    clearDir();
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearDir();
  });

  it('AC 67.15: the boundary is strict — a segment last written at the cutoff stays', async () => {
    store = new FileAuditStore(makeConfig());
    const cutoff = new Date(Date.now() - DAY_MS);
    const atCutoff = segment('audit-20260101-0001.ndjson', line('edge'));
    utimesSync(atCutoff, cutoff, cutoff);
    const before = segment('audit-20260101-0002.ndjson', line('older'));
    const justBefore = new Date(cutoff.getTime() - 1);
    utimesSync(before, justBefore, justBefore);

    // "Older than" is strict: a segment last written exactly at the cutoff is still
    // inside the window, and `<=` would expire it by one millisecond.
    expect(await store.pruneOlderThan(cutoff)).toBe(1);
    expect(existsSync(atCutoff)).toBe(true);
    expect(existsSync(before)).toBe(false);
  });

  it('AC 67.16: one segment that cannot be removed does not abandon the sweep', async () => {
    store = new FileAuditStore(makeConfig());
    // A directory that carries a segment's name: it stats fine and cannot be
    // unlinked. The sweep has to report the ones it did remove and keep going,
    // instead of stopping at the first failure and calling that the total.
    const stubborn = join(TEST_DIR, 'audit-20260101-0002.ndjson');
    mkdirSync(stubborn);
    writeFileSync(join(stubborn, 'keep'), 'x');
    const first = segment('audit-20260101-0001.ndjson', line('gone'));
    const last = segment('audit-20260101-0003.ndjson', line('gone'));
    for (const path of [stubborn, first, last]) utimesSync(path, new Date(0), new Date(0));

    expect(await store.pruneOlderThan(new Date())).toBe(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(last)).toBe(false);
    expect(existsSync(stubborn)).toBe(true);
  });

  it('AC 67.17: prune leaves files this store did not write', async () => {
    store = new FileAuditStore(makeConfig());
    writeFileSync(join(TEST_DIR, 'export-2026.json'), '[]');
    writeFileSync(join(TEST_DIR, 'audit-20260101-0001.ndjson.tmp'), 'partial');
    const mine = segment('audit-20260101-0001.ndjson', line('mine'));
    utimesSync(mine, new Date(0), new Date(0));

    // A prune is a delete, and a delete should not need a directory of its own.
    expect(await store.pruneOlderThan(new Date())).toBe(1);
    expect(existsSync(join(TEST_DIR, 'export-2026.json'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'audit-20260101-0001.ndjson.tmp'))).toBe(true);
  });

  it('AC 67.18: prune reports 0 over a directory it cannot list', async () => {
    store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'LIVE', actor: 'alice', resource: 'r', result: 'success' });
    rmSync(TEST_DIR, { recursive: true, force: true });

    expect(await store.pruneOlderThan(new Date())).toBe(0);
  });
});

describe('AC 67 — reading order is a property of the names', () => {
  it('AC 67.19: newest first, and an archive hides the plain namesake', () => {
    const names = [
      'audit-20260101-0001.ndjson',
      'audit-20260101-0002.ndjson',
      'audit-20260101-0002.ndjson.gz',
      'audit-20260102-0001.ndjson',
    ];

    // Newest first, one name per segment: 0002 is archived, so only its archive is
    // read. Without the sort this order is whatever the filesystem hands back.
    expect(readableSegmentsNewestFirst(names)).toEqual([
      'audit-20260102-0001.ndjson',
      'audit-20260101-0002.ndjson.gz',
      'audit-20260101-0001.ndjson',
    ]);
    // A shuffled input gives the same answer: order is computed, not inherited.
    expect(readableSegmentsNewestFirst([...names].reverse())).toEqual(readableSegmentsNewestFirst(names));
  });

  it('AC 67.20: zero padding is what makes name order chronological', () => {
    const names = ['audit-20260101-0009.ndjson', 'audit-20260101-0010.ndjson', 'audit-20260101-0002.ndjson'];
    expect(readableSegmentsNewestFirst(names)).toEqual([
      'audit-20260101-0010.ndjson',
      'audit-20260101-0009.ndjson',
      'audit-20260101-0002.ndjson',
    ]);
  });

  it('AC 67.21: an input array is not reordered in place', () => {
    const names = ['b.ndjson', 'a.ndjson'];
    readableSegmentsNewestFirst(names);
    expect(names).toEqual(['b.ndjson', 'a.ndjson']);
  });
});

describe('AC 67 — a fresh store is a store', () => {
  afterEach(() => {
    clearDir();
  });

  it('AC 67.22: a data directory that does not exist yet is created', async () => {
    const nested = join(TEST_DIR, 'var', 'log', 'db');
    const store = new FileAuditStore(makeConfig({ dataDir: nested }));

    // A store pointed at a fresh path used to fail on its first write: the
    // directory was created only if it already existed.
    await store.write({ operation: 'FIRST', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    expect(existsSync(nested)).toBe(true);
    expect(await store.count()).toBe(1);
  });

  it('AC 67.23: the severity of an entry defaults to info', async () => {
    const store = new FileAuditStore(makeConfig());
    await store.write({ operation: 'NO_SEVERITY', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    const [entry] = await store.query({});
    expect(entry!.severity).toBe('info');
  });

  it('AC 67.24: sequence numbers advance instead of overwriting', async () => {
    const store = new FileAuditStore(makeConfig({ maxFileSize: 1 }));
    for (let i = 0; i < 3; i++) {
      await store.write({ operation: `OP_${i}`, actor: 'alice', resource: 'r', result: 'success' });
    }
    await store.close();

    // A sequence lookup that returned the same number for every rotation would
    // overwrite the segment it had just closed: three writes, one file, two lost.
    const segments = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz'));
    expect(segments).toHaveLength(3);
    expect(await store.count()).toBe(3);
  });

  it('AC 67.25: rotation happens exactly at the size bound, not one byte later', async () => {
    // Measure the line this test will write, not a different one: the entry's own
    // length is what the bound has to match exactly.
    const probe = new FileAuditStore(makeConfig());
    await probe.write({ operation: 'ONE', actor: 'alice', resource: 'r', result: 'success' });
    await probe.close();
    const [firstSegment] = readdirSync(TEST_DIR);
    const oneLine = readFileSync(join(TEST_DIR, firstSegment!), 'utf-8').length;
    clearDir();

    // The bound is "the segment is full", so a segment that has reached it rotates
    // before the next line: `>` would defer by one entry and let a segment grow past
    // the size the operator configured.
    const store = new FileAuditStore(makeConfig({ maxFileSize: oneLine }));
    await store.write({ operation: 'ONE', actor: 'alice', resource: 'r', result: 'success' });
    await store.write({ operation: 'TWO', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    // The first segment is closed — plain or already archived, both count — and a
    // second one exists, so the bound produced a boundary instead of a longer file.
    const names = readdirSync(TEST_DIR);
    expect(names.filter((f) => f.startsWith(firstSegment!.replace('.ndjson', '')))).toHaveLength(1);
    expect(names.filter((f) => f.includes('-0002'))).toHaveLength(1);
    expect(await store.count()).toBe(2);
  });
});

describe('AC 67 — the store reads its own trail and nothing else', () => {
  let store: FileAuditStore | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
    clearDir();
  });

  it('AC 67.26: own segments and legacy json are read, foreign files are not', async () => {
    segment('audit-20260101-0001.ndjson', line('own'));
    segment('audit-20260101-0002.ndjson.gz', gzipSync(Buffer.from(line('archived'))));
    writeFileSync(
      join(TEST_DIR, 'audit-20260101-legacy.json'),
      JSON.stringify([
        {
          id: 'legacy',
          timestamp: '2026-01-01T00:00:00.000Z',
          operation: 'LEGACY',
          actor: 'alice',
          resource: 'r',
          result: 'success',
          severity: 'info',
        },
      ]),
    );
    // Another store's segment, and this store's half-written temp file.
    segment('other-20260101-0001.ndjson', line('foreign'));
    writeFileSync(join(TEST_DIR, 'audit-20260101-0003.ndjson.tmp'), line('torn'));

    store = new FileAuditStore(makeConfig());

    // Four entries: the open segment, the archive, and the legacy array. The
    // foreign segment and the temp file are somebody else's problem.
    expect(await store.count()).toBe(3);
    const ids = (await store.query({ limit: 10 })).map((e) => e.id).sort();
    expect(ids).toEqual(['archived', 'legacy', 'own']);
  });

  it('AC 67.27: an archive of another store’s name is not this store’s segment', async () => {
    segment('auditXv2-20260101-0001.ndjson.gz', gzipSync(Buffer.from(line('foreign'))));

    store = new FileAuditStore(makeConfig({ filePrefix: 'audit.v2' }));
    await store.write({ operation: 'MINE', actor: 'alice', resource: 'r', result: 'success' });

    expect(await store.count()).toBe(1);
  });
});

describe('AC 67 — the sweep leaves what it does not own', () => {
  afterEach(() => {
    clearDir();
  });

  it('AC 67.28: a foreign file older than retention survives the sweep', async () => {
    const store = new FileAuditStore(makeConfig({ maxFileSize: 1, retentionDays: 90 }));
    const foreign = join(TEST_DIR, 'export-2026.json');
    writeFileSync(foreign, '[]');
    const ancient = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(foreign, ancient, ancient);

    await store.write({ operation: 'ONE', actor: 'alice', resource: 'r', result: 'success' });
    await store.write({ operation: 'TWO', actor: 'alice', resource: 'r', result: 'success' });
    await store.close();

    // The sweep's authority is over names this store could have written. An export
    // in the same directory is not one of them.
    expect(existsSync(foreign)).toBe(true);
  });

  it('AC 67.29: a segment written exactly at the retention cutoff survives', async () => {
    // The clock is frozen so "exactly ninety days old" is a value the test can set
    // on a file and the sweep can compute, rather than two clock reads a
    // millisecond apart.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));
    try {
      const store = new FileAuditStore(makeConfig({ maxFileSize: 1, retentionDays: 90 }));
      const cutoff = new Date(Date.now() - 90 * DAY_MS);
      const atCutoff = segment('audit-20260101-0001.ndjson', line('edge'));
      utimesSync(atCutoff, cutoff, cutoff);
      const before = segment('audit-20260101-0002.ndjson', line('past'));
      const justBefore = new Date(cutoff.getTime() - 1);
      utimesSync(before, justBefore, justBefore);

      await store.write({ operation: 'ONE', actor: 'alice', resource: 'r', result: 'success' });
      await store.write({ operation: 'TWO', actor: 'alice', resource: 'r', result: 'success' });
      await store.close();

      // Retention is "older than", so a segment last written at the cutoff is inside
      // the window by one millisecond — and `>` would keep the one that is not.
      expect(existsSync(atCutoff)).toBe(true);
      expect(existsSync(before)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC 67 — the active segment, asserted on names', () => {
  it('AC 67.30: the newest open name wins, whatever the input order', () => {
    const names = [
      'audit-20261115-0003.ndjson',
      'audit-20261116-0001.ndjson',
      'audit-20261116-0002.ndjson.gz',
      'other-20261117-0001.ndjson',
    ];

    // Newest by name, not by sequence field: sequence 0003 belongs to yesterday and
    // the foreign prefix is not a candidate at all.
    expect(newestOpenSegment(names, 'audit')).toBe('audit-20261116-0001.ndjson');
    expect(newestOpenSegment([...names].reverse(), 'audit')).toBe('audit-20261116-0001.ndjson');
    // Nothing to resume.
    expect(newestOpenSegment(['audit-20261116-0002.ndjson.gz'], 'audit')).toBe('');
  });

  it('AC 67.31: a file whose identity changed is not the file that was compressed', () => {
    const path = segment('audit-20260101-0001.ndjson', line('original'));
    const identity = fileIdentity(path)!;

    // Same path, different content: something replaced the file between the read
    // and the delete, and deleting it would discard entries no one archived.
    writeFileSync(path, line('replaced-with-a-longer-line'));
    expect(unlinkIfUnchanged(path, identity)).toBe(false);
    expect(existsSync(path)).toBe(true);

    // A path that cannot be unlinked reports so instead of throwing.
    const directory = join(TEST_DIR, 'audit-20260101-0002.ndjson');
    mkdirSync(directory);
    expect(unlinkIfUnchanged(directory, fileIdentity(directory)!)).toBe(false);

    // And a missing file is not an error: something else already removed it.
    expect(unlinkIfUnchanged(join(TEST_DIR, 'gone.ndjson'), identity)).toBe(false);
    // Absence is reported as `null`, which the exported contract promises; a
    // caller that compares against `null` would read `undefined` as "exists".
    expect(fileIdentity(join(TEST_DIR, 'gone.ndjson'))).toBeNull();

    // Only an unchanged file is deleted.
    expect(unlinkIfUnchanged(path, fileIdentity(path)!)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
