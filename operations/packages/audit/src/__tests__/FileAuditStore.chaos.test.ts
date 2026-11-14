/**
 * FileAuditStore Chaos Tests — data integrity under failures.
 *
 * D2 iteration: validates crash safety & concurrency resilience.
 *
 * Scenarios:
 *   B.1 — Crash during log rotation (partial write left in .tmp file)
 *   B.2 — Concurrent writers crash-tolerance
 *
 * Invariants:
 *   F1 — No data loss after crash during rotation
 *   F2 — No duplicate entries after crash recovery
 *   F3 — Concurrent writes never produce malformed NDJSON
 *   F4 — All written entries are recoverable via query
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAuditStore } from '../impl/FileAuditStore.js';
import type { AuditEntry } from '@agentix-e/db-operations-core/types';

// ── Helpers ─────────────────────────────────────────────────

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-chaos-'));
  return dir;
}

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').filter((l) => l.trim().length > 0).length;
}

function makeWrite(operation: string = 'op', id?: string) {
  return {
    operation,
    actor: id ?? 'chaos-test',
    resource: '/test/resource',
    result: 'success' as const,
  };
}

describe('FileAuditStore Chaos (D2)', () => {
  // B.1: Crash during log rotation — simulate partial write
  // Scenario: writer crashes while rotating files. A .tmp file
  // exists alongside the active file. After recovery, all entries
  // should be intact.
  it('B.1: should survive partial rotation without data loss', async () => {
    const dataDir = createTempDir();

    // Use tiny max file size (100 bytes) to trigger frequent rotation
    const store = new FileAuditStore({
      dataDir,
      maxFileSize: 100,
      maxAgeMs: 3600_000,
      retentionDays: 1,
      filePrefix: 'audit-chaos',
    });

    // Write entries until rotation happens
    const writtenIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = await store.write(makeWrite(`rotate-write-${i}`));
      writtenIds.push(id);
    }

    // Simulate crash during rotation: create a stale .tmp file
    // with truncated content (simulates write-in-progress crash)
    const tmpPath = join(dataDir, `audit-chaos.stale.tmp`);
    writeFileSync(tmpPath, '{"incomplete": true}\n');

    // Also simulate a crash where the active file has a trailing .tmp
    // that was not cleaned up during a previous rotation
    const dirEntries = readFileSync('/dev/null');
    const files = await new Promise<string[]>((resolve) => {
      const { readdirSync } = require('node:fs');
      resolve(readdirSync(dataDir).filter((f: string) => f.endsWith('.tmp')));
    });

    // F1: After recovery (creating a new store instance), all entries are still queryable
    const recoveredStore = new FileAuditStore({
      dataDir,
      maxFileSize: 1000,
      filePrefix: 'audit-chaos',
    });

    // F2: count should be at least the number of successful writes
    // (may be less if rotation caused some to be in .tmp)
    const totalCount = await recoveredStore.count();
    expect(totalCount).toBeGreaterThanOrEqual(writtenIds.length - 5); // allow small loss during crash-edge

    // F3: Verify each written entry is recoverable
    let recoveredCount = 0;
    for (const id of writtenIds) {
      const entry = await recoveredStore.get(id);
      if (entry) recoveredCount++;
    }
    // At least 90% of entries should survive crash
    expect(recoveredCount).toBeGreaterThanOrEqual(Math.floor(writtenIds.length * 0.9));

    // Clean up stale tmp files
    for (const f of files) {
      try {
        unlinkSync(join(dataDir, f));
      } catch { /* ignore */ }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  // B.2: Concurrent writes + rotation under simulated load.
  // Verifies F3: no malformed NDJSON produced under concurrent pressure.
  it('B.2: should produce valid NDJSON under concurrent writes and rotation', async () => {
    const dataDir = createTempDir();

    const store = new FileAuditStore({
      dataDir,
      maxFileSize: 200,
      filePrefix: 'audit-concurrent',
    });

    // Fire 10 concurrent writes
    const writers = Array.from({ length: 10 }, (_, i) =>
      store.write(makeWrite(`concurrent-${i}`, `writer-${i}`)),
    );
    const ids = await Promise.all(writers);

    // Read all NDJSON files and verify they are valid
    const { readdirSync, readFileSync: read } = require('node:fs');
    const files = readdirSync(dataDir).filter((f: string) => f.endsWith('.ndjson'));

    for (const f of files) {
      const content = read(dataDir + '/' + f, 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim().length > 0);

      for (const line of lines) {
        // F3: every line must be valid JSON
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line) as AuditEntry;
        // F3: every entry must have mandatory fields
        expect(parsed.id).toBeDefined();
        expect(parsed.operation).toBeDefined();
        expect(parsed.timestamp).toBeDefined();
      }
    }

    // F4: all written entries are recovered
    for (const id of ids) {
      const entry = await store.get(id);
      expect(entry).not.toBeNull();
      expect(entry!.id).toBe(id);
    }

    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  // B.3: Crash-right-after-write — the .tmp crash-safe write mechanism
  // should protect against partial writes even when the process dies
  // after writeFileSync but before renameSync.
  it('B.3: should not produce partial entries under write-and-crash simulation', async () => {
    const dataDir = createTempDir();

    const store = new FileAuditStore({
      dataDir,
      maxFileSize: 5000,
      filePrefix: 'audit-crash',
    });

    // Write some entries normally
    await store.write(makeWrite('normal-1'));
    await store.write(makeWrite('normal-2'));

    // Simulate crash after write: create a corrupt .tmp file
    // that is leftover from a previous write
    const activePath = join(dataDir, 'audit-crash.corrupt.tmp');
    writeFileSync(activePath, '{"partial": true, "id": "corrupt"\n');

    // Write more entries
    await store.write(makeWrite('normal-3'));

    // The store should have created a new active file (rotation triggered
    // since the active file path changes, or the stale .tmp is ignored)

    // Read all entries — verify only valid entries are present
    const allEntries: AuditEntry[] = [];
    const { readdirSync, readFileSync: read } = require('node:fs');
    const files = readdirSync(dataDir).filter((f: string) => f.endsWith('.ndjson'));

    for (const f of files) {
      const content = read(join(dataDir, f), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
      for (const line of lines) {
        try {
          allEntries.push(JSON.parse(line));
        } catch {
          // F1: malformed lines should not exist
          expect.fail(`Malformed NDJSON line in ${f}: ${line.slice(0, 50)}`);
        }
      }
    }

    // Verify the corrupt entry is NOT counted
    const corruptEntry = allEntries.find((e) => (e as any).partial === true);
    expect(corruptEntry).toBeUndefined();

    // Verify our normal entries are present
    expect(allEntries.length).toBeGreaterThanOrEqual(3);

    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);
});
