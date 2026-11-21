/**
 * FileAuditStore Chaos Tests — integrity under failure and under pressure.
 *
 * Scenarios:
 *   B.1 — many rotations in flight, then recovery by a second store
 *   B.2 — concurrent writers under a size bound small enough to rotate
 *
 * Invariants:
 *   F1 — no acknowledged entry is lost, and none is counted twice
 *   F2 — a stray file this store did not write contributes no entries
 *   F3 — every line in every segment parses
 *   F4 — every written entry is recoverable by id
 *
 * The bounds here used to be apologetic — "allow small loss during crash-edge",
 * "at least 90% of entries should survive" — which asserted the opposite of what
 * the file is named after: that a lossy store is acceptable. A crash between two
 * acknowledged writes loses nothing, because `write()` returns only after the line
 * is on the medium, so the counts are exact now. Where a crash does leave
 * something behind — a fragment without its newline — `AC80` (DW.8) and `AC81`
 * (OS.2, OS.3) assert what happens to it, out of process, which is the only place
 * a crash can be observed.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAuditStore } from '../impl/FileAuditStore.js';
import type { AuditEntry } from '../../core/types.js';

// ── Helpers ─────────────────────────────────────────────────

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-chaos-'));
}

function makeWrite(operation: string, id?: string) {
  return {
    operation,
    actor: id ?? 'chaos-test',
    resource: '/test/resource',
    result: 'success' as const,
  };
}

describe('FileAuditStore Chaos (D2)', () => {
  it('B.1: rotations in flight, then a second store recovers every entry', async () => {
    const dataDir = createTempDir();

    // 100 bytes per segment: every write but the last rotates, so several
    // compressions are in flight when the test stops writing.
    const store = new FileAuditStore({
      dataDir,
      maxFileSize: 100,
      maxAgeMs: 3600_000,
      retentionDays: 1,
      filePrefix: 'audit-chaos',
    });

    const writtenIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      writtenIds.push(await store.write(makeWrite(`rotate-write-${i}`)));
    }

    // A stale temporary file is what an *older* version of this store left behind
    // when it died mid-rename. It is not one of this store's segments, and reading
    // it would put an invented entry into a compliance report.
    writeFileSync(join(dataDir, 'audit-chaos.stale.tmp'), '{"incomplete": true}\n');

    // Shutdown is awaitable, so the recovery below cannot race a compressor.
    await store.close();

    const recovered = new FileAuditStore({ dataDir, maxFileSize: 1000, filePrefix: 'audit-chaos' });

    expect(await recovered.count()).toBe(writtenIds.length);
    for (const id of writtenIds) {
      expect(await recovered.get(id), `${id} was lost across rotation`).not.toBeNull();
    }
    // F2: the stray file contributed nothing.
    expect(await recovered.count({ operation: 'incomplete' })).toBe(0);

    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('B.2: concurrent writes under continuous rotation produce only valid lines', async () => {
    const dataDir = createTempDir();

    const store = new FileAuditStore({ dataDir, maxFileSize: 200, filePrefix: 'audit-concurrent' });

    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.write(makeWrite(`concurrent-${i}`, `writer-${i}`))),
    );
    await store.close();

    for (const name of readdirSync(dataDir).filter((f) => f.endsWith('.ndjson'))) {
      const content = readFileSync(join(dataDir, name), 'utf-8');
      for (const line of content.split('\n').filter((l) => l.trim().length > 0)) {
        // F3: every line parses, with the fields an audit entry has.
        const parsed = JSON.parse(line) as AuditEntry;
        expect(parsed.id).toBeDefined();
        expect(parsed.operation).toBeDefined();
        expect(parsed.timestamp).toBeDefined();
      }
    }

    // F4: all written entries are recovered, and exactly once.
    expect(await store.count()).toBe(ids.length);
    for (const id of ids) {
      expect(await store.get(id)).toMatchObject({ id });
    }
    expect(new Set(ids).size).toBe(ids.length);

    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);
});
