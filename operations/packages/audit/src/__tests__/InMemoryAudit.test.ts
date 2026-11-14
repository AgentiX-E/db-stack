/**
 * InMemoryAudit.test — Acceptance tests for InMemoryAuditStore + JsonAuditExporter.
 *
 * Covers all 15 acceptance criteria (A1–A15).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryAuditStore } from '../impl/InMemoryAuditStore.js';
import { JsonAuditExporter } from '../impl/JsonAuditExporter.js';
import type { AuditEntry, AuditSeverity } from '@agentix-e/db-operations-core/types';

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════

/**
 * Create a simple audit entry for the given operation.
 */
function makeEntry(
  store: InMemoryAuditStore,
  overrides: {
    operation?: string;
    actor?: string;
    resource?: string;
    result?: 'success' | 'failure' | 'denied';
    severity?: AuditSeverity;
    details?: Record<string, unknown>;
    traceId?: string;
    timestamp?: string; // not passed through write; used for manual entry
  } = {},
): Promise<string> {
  return store.write({
    operation: overrides.operation ?? 'test.op',
    actor: overrides.actor ?? 'tester',
    resource: overrides.resource ?? 'test:resource',
    result: overrides.result ?? 'success',
    severity: overrides.severity,
    details: overrides.details,
    traceId: overrides.traceId,
  });
}

// ══════════════════════════════════════════════════════════════════
//  Tests — InMemoryAuditStore
// ══════════════════════════════════════════════════════════════════

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    store = new InMemoryAuditStore();
  });

  // ── A1: write returns non-empty string ID ──────────────────────
  it('A1: write returns non-empty string ID', async () => {
    const id = await makeEntry(store);
    expect(id).toBeTypeOf('string');
    expect(id.length).toBeGreaterThan(0);
  });

  // ── A2: get returns matching entry by ID ───────────────────────
  it('A2: get returns matching entry by ID', async () => {
    const id = await makeEntry(store, { operation: 'get.test', actor: 'alice' });
    const entry = await store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.operation).toBe('get.test');
    expect(entry!.actor).toBe('alice');
  });

  // ── A3: get with unknown ID returns null ───────────────────────
  it('A3: get with unknown ID returns null', async () => {
    const entry = await store.get('non-existent-id-12345');
    expect(entry).toBeNull();
  });

  // ── A4: query without filter returns all entries ───────────────
  it('A4: query without filter returns all entries', async () => {
    await makeEntry(store, { operation: 'a' });
    await makeEntry(store, { operation: 'b' });
    await makeEntry(store, { operation: 'c' });
    const all = await store.query({});
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.operation).sort()).toEqual(['a', 'b', 'c']);
  });

  // ── A5: query filters by operation ─────────────────────────────
  it('A5: query filters by operation', async () => {
    await makeEntry(store, { operation: 'create' });
    await makeEntry(store, { operation: 'delete' });
    await makeEntry(store, { operation: 'create' });

    const creates = await store.query({ operation: 'create' });
    expect(creates).toHaveLength(2);
    creates.forEach((e) => expect(e.operation).toBe('create'));
  });

  // ── A6: query filters by actor ─────────────────────────────────
  it('A6: query filters by actor', async () => {
    await makeEntry(store, { actor: 'alice', operation: 'x' });
    await makeEntry(store, { actor: 'bob', operation: 'y' });
    await makeEntry(store, { actor: 'alice', operation: 'z' });

    const aliceEntries = await store.query({ actor: 'alice' });
    expect(aliceEntries).toHaveLength(2);
    aliceEntries.forEach((e) => expect(e.actor).toBe('alice'));
  });

  // ── A7: query respects limit ──────────────────────────────────
  it('A7: query respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await makeEntry(store, { operation: `op-${i}` });
    }
    const limited = await store.query({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  // ── A8: query respects offset ──────────────────────────────────
  it('A8: query respects offset', async () => {
    for (let i = 0; i < 10; i++) {
      await makeEntry(store, { operation: `op-${i}` });
    }
    const all = await store.query({});
    const offset5 = await store.query({ offset: 5 });
    expect(offset5).toHaveLength(5); // 10 - 5
    expect(offset5[0].operation).toBe(all[5].operation);
  });

  // ── A12: query filters by severity ─────────────────────────────
  it('A12: query filters by severity', async () => {
    await makeEntry(store, { operation: 'info', severity: 'info' });
    await makeEntry(store, { operation: 'warn', severity: 'warning' });
    await makeEntry(store, { operation: 'err', severity: 'error' });
    await makeEntry(store, { operation: 'crit', severity: 'critical' });

    const warnings = await store.query({ severity: 'warning' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');

    const errors = await store.query({ severity: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('error');
  });

  // ── A13: query filters by startTime/endTime range ──────────────
  it('A13: query filters by startTime/endTime range', async () => {
    // Create entries and note their timestamps
    const id1 = await makeEntry(store, { operation: 'early' });
    await sleep(10);
    const id2 = await makeEntry(store, { operation: 'mid' });
    await sleep(10);
    const id3 = await makeEntry(store, { operation: 'late' });

    const entry1 = (await store.get(id1))!;
    const entry2 = (await store.get(id2))!;
    const entry3 = (await store.get(id3))!;

    // Only mid entry (inclusive range around id2)
    const startTime = new Date(entry2.timestamp);
    const endTime = new Date(entry2.timestamp);

    const range = await store.query({ startTime, endTime });
    expect(range.length).toBeGreaterThanOrEqual(1);
    // Should include at least id2
    expect(range.some((e) => e.id === id2)).toBe(true);

    // Verify early is excluded if we start after it
    const afterEarly = await store.query({
      startTime: new Date(new Date(entry1.timestamp).getTime() + 1),
    });
    expect(afterEarly.some((e) => e.id === id1)).toBe(false);
  });

  // ── A13b: endTime excludes entries strictly after the bound ────
  it('A13b: endTime excludes entries strictly after the bound', async () => {
    const id1 = await makeEntry(store, { operation: 'early' });
    await sleep(10);
    const id2 = await makeEntry(store, { operation: 'late' });

    const entry1 = (await store.get(id1))!;

    // endTime = entry1.timestamp → entry2 (later) must be excluded,
    // exercising the `entry.timestamp > filter.endTime → return false` branch.
    const beforeLate = await store.query({
      endTime: new Date(entry1.timestamp),
    });
    expect(beforeLate.some((e) => e.id === id2)).toBe(false);
    expect(beforeLate.some((e) => e.id === id1)).toBe(true);
  });

  // ── A14: count with filter matches filtered count ──────────────
  it('A14: count with filter matches filtered count', async () => {
    await makeEntry(store, { operation: 'create' });
    await makeEntry(store, { operation: 'delete' });
    await makeEntry(store, { operation: 'create' });

    const total = await store.count();
    expect(total).toBe(3);

    const createCount = await store.count({ operation: 'create' });
    expect(createCount).toBe(2);

    const deleteCount = await store.count({ operation: 'delete' });
    expect(deleteCount).toBe(1);
  });

  // ── A15: write creates entry with correct timestamp ────────────
  it('A15: write creates entry with correct timestamp', async () => {
    const before = new Date();
    await sleep(1);
    const id = await makeEntry(store, { operation: 'timed' });
    await sleep(1);
    const after = new Date();

    const entry = (await store.get(id))!;
    const ts = new Date(entry.timestamp);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
  });

  // ── A9: pruneOlderThan removes old entries (count decreases) ──
  it('A9: pruneOlderThan removes old entries', async () => {
    await makeEntry(store, { operation: 'old1' });
    await sleep(50);
    const cutoff = new Date();
    await sleep(10);
    await makeEntry(store, { operation: 'new1' });
    await makeEntry(store, { operation: 'new2' });

    const removed = await store.pruneOlderThan(cutoff);
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await store.count();
    expect(remaining).toBe(2); // new1 + new2
  });

  // ── A9b: pruneOlderThan returns the exact number removed ──────
  it('A9b: pruneOlderThan returns the exact count of removed entries', async () => {
    await makeEntry(store, { operation: 'old1' });
    await makeEntry(store, { operation: 'old2' });
    await sleep(50);
    const cutoff = new Date();
    await sleep(10);
    await makeEntry(store, { operation: 'new1' });

    // Exactly 2 old entries removed; `before - keep.length` == 2.
    const removed = await store.pruneOlderThan(cutoff);
    expect(removed).toBe(2);
    expect(await store.count()).toBe(1);
  });

  // ── query filters by result ────────────────────────────────────
  it('query filters by result', async () => {
    await makeEntry(store, { operation: 'ok', result: 'success' });
    await makeEntry(store, { operation: 'fail', result: 'failure' });
    await makeEntry(store, { operation: 'deny', result: 'denied' });

    const failures = await store.query({ result: 'failure' });
    expect(failures).toHaveLength(1);
    expect(failures[0].result).toBe('failure');

    const denied = await store.query({ result: 'denied' });
    expect(denied).toHaveLength(1);
    expect(denied[0].result).toBe('denied');
  });

  // ── write stores details and traceId ───────────────────────────
  it('write stores details and traceId', async () => {
    const id = await makeEntry(store, {
      operation: 'with-details',
      details: { key: 'value', nested: { a: 1 } },
      traceId: 'trace-abc-123',
    });

    const entry = (await store.get(id))!;
    expect(entry.details).toEqual({ key: 'value', nested: { a: 1 } });
    expect(entry.traceId).toBe('trace-abc-123');
  });

  // ── default severity is info ───────────────────────────────────
  it('default severity is info', async () => {
    const id = await makeEntry(store, { operation: 'default-sev' });
    const entry = (await store.get(id))!;
    expect(entry.severity).toBe('info');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Tests — JsonAuditExporter
// ══════════════════════════════════════════════════════════════════

describe('JsonAuditExporter', () => {
  let store: InMemoryAuditStore;
  let exporter: JsonAuditExporter;
  let tmpDir: string;

  beforeEach(() => {
    store = new InMemoryAuditStore();
    exporter = new JsonAuditExporter(store);
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-export-'));
  });

  afterEach(() => {
    // Clean up temp files
    try {
      const files = [join(tmpDir, 'export.json'), join(tmpDir, 'filtered.json')];
      for (const f of files) {
        if (existsSync(f)) unlinkSync(f);
      }
    } catch {
      // ignore cleanup errors
    }
  });

  // ── A10: exporter.exportToFile creates file ────────────────────
  it('A10: exportToFile creates file', async () => {
    await makeEntry(store, { operation: 'export-me' });
    await makeEntry(store, { operation: 'export-me-too' });

    const outPath = join(tmpDir, 'export.json');
    const count = await exporter.exportToFile(outPath, { format: 'json-array' });

    expect(count).toBe(2);
    expect(existsSync(outPath)).toBe(true);
  });

  // ── A11: exporter.exportToString returns valid JSON array ──────
  it('A11: exportToString returns valid JSON array', async () => {
    await makeEntry(store, { operation: 'str1', actor: 'x' });
    await makeEntry(store, { operation: 'str2', actor: 'y' });

    const jsonStr = await exporter.exportToString({ format: 'json-array' });
    const parsed: AuditEntry[] = JSON.parse(jsonStr);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].operation).toBe('str1');
    expect(parsed[1].operation).toBe('str2');
  });

  // ── exportToFile returns 0 if no entries ───────────────────────
  it('exportToFile returns 0 when store is empty', async () => {
    const outPath = join(tmpDir, 'empty.json');
    const count = await exporter.exportToFile(outPath, { format: 'json-array' });
    expect(count).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content).toEqual([]);
  });

  // ── exportToString with filter ─────────────────────────────────
  it('exportToString respects filter', async () => {
    await makeEntry(store, { operation: 'keep', actor: 'alice' });
    await makeEntry(store, { operation: 'skip', actor: 'bob' });

    const jsonStr = await exporter.exportToString({
      format: 'json-array',
      filter: { actor: 'alice' },
    });
    const parsed: AuditEntry[] = JSON.parse(jsonStr);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].actor).toBe('alice');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Utility
// ══════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
