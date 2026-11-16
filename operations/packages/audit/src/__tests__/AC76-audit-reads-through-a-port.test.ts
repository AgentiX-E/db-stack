/**
 * AC76 — An audit read goes through a port, and a damaged segment is an empty one.
 *
 * P2-21 said two `FileAuditStore` mutants survived "for want of a filesystem fault
 * during a scan rather than of an assertion". Tried, they turned out to be a
 * different thing than a missing test: `readSegment()` returned `null` for a file
 * it could not read, and both call sites answered the sentinel with `continue`.
 * Mutating either `continue` away changed no observable behaviour, because
 *
 *   - the `.json` branch fell through to `JSON.parse(null)`, which yields `null`,
 *     and `for (const e of null)` threw into the surrounding `catch` — same skip;
 *   - the segment branch ran `''` through `split('\n')`, produced one line that no
 *     parser accepts, and the same `catch` skipped it.
 *
 * So the sentinel was a second way of saying "an unreadable segment contributes no
 * entries", and the parser was already saying it. Two places expressing one fact is
 * how a mutant survives: no run can tell which of the two is doing the work.
 *
 * The sentinel is gone. `readSegment()` returns the segment's text, `''` when it
 * has none, and both branches simply parse what they were given. That removes the
 * two mutants instead of writing a test that pretends to kill them.
 *
 * What is left is the property the survivors were standing in front of, and it is
 * a real one: a scan must not read a segment it has no budget left to use, because
 * the documented promise is that `maxScanLines` keeps a grep-shaped read cheap.
 * That promise is about *reads*, so it can only be asserted at a read seam — which
 * is the other half of this iteration: `segmentReader` is an I/O port, the same
 * shape as every other engine seam in this repository. The default reads the local
 * filesystem; a deployment that keeps segments on object storage, or that must
 * account for the I/O it performs, plugs its own in.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { FileAuditStore, readSegmentFromDisk } from '../impl/FileAuditStore.js';
import type { AuditEntry } from '@agentix-e/db-operations-core/types';

// ── Helpers ─────────────────────────────────────────────────

interface ReadCall {
  path: string;
  compressed: boolean;
}

/** The reader the store documents as its default, written out where a test can wrap it. */
function diskReader(path: string, compressed: boolean): string | null {
  try {
    const raw = readFileSync(path);
    return compressed ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
  } catch {
    return null;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-seam-'));
}

const write = (operation: string) => ({
  operation,
  actor: 'seam-test',
  resource: '/db/orders',
  result: 'success' as const,
});

/**
 * A store whose segments are small enough to rotate, with every read recorded.
 *
 * The reader delegates to disk unless `decide` answers for a path.
 */
function storeWithSeam(
  dir: string,
  decide: (path: string, compressed: boolean, index: number) => string | null | undefined,
  config: { maxScanLines?: number } = {},
): { store: FileAuditStore; calls: ReadCall[] } {
  const calls: ReadCall[] = [];
  const store = new FileAuditStore({
    dataDir: dir,
    maxFileSize: 220,
    retentionDays: 0,
    ...(config.maxScanLines === undefined ? {} : { maxScanLines: config.maxScanLines }),
    segmentReader: (path, compressed) => {
      calls.push({ path, compressed });
      const decision = decide(path, compressed, calls.length - 1);
      return decision === undefined ? diskReader(path, compressed) : decision;
    },
  });
  return { store, calls };
}

/** Write `count` entries into small segments, then wait for background work. */
async function seed(store: FileAuditStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await store.write(write(`op-${i}`));
  await store.close();
}

function newestSegmentName(dir: string): string {
  return segmentNames(dir).sort().at(-1) ?? '';
}

function segmentNames(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('audit-') && (f.endsWith('.ndjson') || f.endsWith('.ndjson.gz')));
}

// ── 76.1–76.5: damage is scoped to the file ────────────────

describe('AC76.1–76.5: one damaged segment does not hide the others', () => {
  it('76.1 the seam is what the scan reads through', async () => {
    const dir = tempDir();
    try {
      const { store, calls } = storeWithSeam(dir, () => undefined);
      await seed(store, 3);
      await store.write(write('after'));

      const found = await store.query({});
      expect(found.length).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.2 an unreadable segment contributes nothing and blocks nothing', async () => {
    const dir = tempDir();
    try {
      // The newest segment — the live one — is the one that cannot be read, so
      // every scan meets the damage rather than only the first one.
      const { store } = storeWithSeam(dir, (path) => (path.endsWith(newestSegmentName(dir)) ? null : undefined));
      await seed(store, 12);

      const total = await store.count();
      const viaDisk = segmentNames(dir).length;
      expect(viaDisk).toBeGreaterThan(1); // the fixture really did rotate

      // One segment was blanked: fewer entries, but no throw and no loss beyond it.
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThan(12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.3 a reader that throws is treated as a segment with no text', async () => {
    const dir = tempDir();
    try {
      // The port returns text or null. A reader that throws is a broken reader, not
      // a broken store: the scan reports the entries it could read.
      const store = new FileAuditStore({
        dataDir: dir,
        maxFileSize: 220,
        retentionDays: 0,
        segmentReader: (path, compressed) => {
          if (path.includes('-0002')) throw new Error('EIO: device not ready');
          return diskReader(path, compressed);
        },
      });
      await seed(store, 12);
      const total = await store.count();
      expect(total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.4 an empty segment is an empty segment, not a skip', async () => {
    const dir = tempDir();
    try {
      const { store } = storeWithSeam(dir, (path) => (path.endsWith(newestSegmentName(dir)) ? '' : undefined));
      await seed(store, 6);

      const total = await store.count();
      const retained = await store.query({ limit: 1000 });
      expect(total).toBe(retained.length);
      expect(total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.5 a damaged segment does not make an id lookup lie about the rest', async () => {
    const dir = tempDir();
    try {
      const { store } = storeWithSeam(dir, (path) => (path.endsWith(newestSegmentName(dir)) ? null : undefined));
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(await store.write(write(`op-${i}`)));
      await store.close();

      const read = await store.get(ids[0]!);
      const lost = await store.get(ids[ids.length - 1]!);

      // The oldest entry survives in an intact segment; the one written into the
      // blanked segment is honestly reported missing rather than invented.
      expect(read?.id).toBe(ids[0]);
      expect(lost).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 76.6–76.10: the budget bounds reads, not just results ──

describe('AC76.6–76.10: a capped scan stops reading', () => {
  it('76.6 a page-sized budget reads one segment', async () => {
    const dir = tempDir();
    try {
      const { store, calls } = storeWithSeam(dir, () => undefined, { maxScanLines: 1 });
      await seed(store, 12);
      calls.length = 0;

      const page = await store.query({ limit: 1 });

      expect(page).toHaveLength(1);
      // The promise `maxScanLines` makes: a cheap page does not pay for the trail.
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.7 the budget counts entries, so a bigger one reads more segments', async () => {
    const dir = tempDir();
    try {
      const { store, calls } = storeWithSeam(dir, () => undefined, { maxScanLines: 1_000 });
      await seed(store, 12);
      calls.length = 0;

      const all = await store.query({ limit: 1_000 });

      expect(all).toHaveLength(12);
      expect(calls.length).toBe(segmentNames(dir).length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.8 an unbounded lookup reads every segment', async () => {
    const dir = tempDir();
    try {
      const { store, calls } = storeWithSeam(dir, () => undefined, { maxScanLines: 1 });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(await store.write(write(`op-${i}`)));
      await store.close();
      calls.length = 0;

      await store.get(ids[0]!);

      expect(calls.length).toBe(segmentNames(dir).length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.9 the reader is told which segments are archived', async () => {
    const dir = tempDir();
    try {
      const { store, calls } = storeWithSeam(dir, () => undefined, { maxScanLines: 1_000 });
      await seed(store, 12);
      calls.length = 0;

      await store.count();

      expect(calls.some((call) => call.compressed)).toBe(true);
      expect(calls.some((call) => !call.compressed)).toBe(true);
      // The flag is derived from the name, not guessed.
      for (const call of calls) expect(call.compressed).toBe(call.path.endsWith('.gz'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.10 the legacy single-array export is read through the same port', async () => {
    const dir = tempDir();
    try {
      const entry: AuditEntry = {
        id: 'legacy-1',
        timestamp: new Date().toISOString(),
        operation: 'legacy-op',
        actor: 'seam-test',
        resource: '/db/orders',
        result: 'success',
        severity: 'info',
      } as AuditEntry;
      writeFileSync(join(dir, 'audit-legacy.json'), JSON.stringify([entry]), 'utf-8');

      const { store, calls } = storeWithSeam(dir, () => undefined);

      const found = await store.query({ operation: 'legacy-op' });

      expect(found.map((e) => e.id)).toEqual(['legacy-1']);
      expect(calls.map((c) => c.path.endsWith('audit-legacy.json'))).toContain(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('76.11 the default port answers null for a segment that is not there', () => {
    // The port's contract is `string | null`, and the store turns `null` into an
    // empty segment. A default that answered `undefined` instead would reach the
    // same place through `?? ''` — which is why the distinction has to be asserted
    // at the port, where a caller can see it, rather than inferred from a query.
    const dir = tempDir();
    try {
      expect(readSegmentFromDisk(join(dir, 'absent.ndjson'), false)).toBeNull();
      expect(readSegmentFromDisk(join(dir, 'absent.ndjson.gz'), true)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
