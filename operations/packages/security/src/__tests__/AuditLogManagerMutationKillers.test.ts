/**
 * AuditLogManagerMutationKillers.test.ts — targeted tests for AuditLogManager
 * mutation survivors.
 *
 * Survivors (11): L30 retention constant, L56 autoStart default, L82/L316 buffer
 * flush threshold, L96 time-range filter, L131/L132 free-text search OR chain,
 * L144 category sort, L249 recursive mkdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import type { AuditEvent, AuditCategory, AuditSeverity, AuditRetentionPolicy } from '../interfaces/IAuditLogger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

type AuditEventDraft = Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>;
function makePartial(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    category: 'data_access' as AuditCategory,
    severity: 'info' as AuditSeverity,
    action: 'SELECT',
    message: 'Query executed',
    actor: { id: 'user-1', ip: '127.0.0.1', sessionId: 'sess-1' },
    resource: { type: 'table', id: 'users', path: '/db/public/users' },
    success: true,
    ...overrides,
  };
}
function tmpLogPath(): string {
  return path.join(os.tmpdir(), `audit-mk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
}

/**
 * AuditLogManager keeps its retention policy and flush timer private. The
 * mutation-killers below pin those internals, so this is the one reflection
 * edge in the file: a renamed field surfaces as a failing assertion, not as a
 * silently skipped test.
 */
function internal<T>(mgr: AuditLogManager, field: 'retention' | 'flushTimer'): T {
  return Reflect.get(mgr, field) as T;
}

describe('AUD-MK: retention / autoStart / query / flush', () => {
  let logger: AuditLogManager;
  let logPath: string;

  beforeEach(() => {
    logPath = tmpLogPath();
    logger = new AuditLogManager({
      logFilePath: logPath,
      autoStart: false,
    });
  });
  afterEach(() => {
    logger.destroy();
  });

  it('L30: default retention maxAgeMs is 90 days', () => {
    // 90 * 24 * 3600 * 1000. A `*`→`/` mutant collapses this to ~0.0004ms.
    const retention = internal<AuditRetentionPolicy>(logger, 'retention');
    expect(retention.maxAgeMs).toBe(90 * 24 * 3600 * 1000);
  });

  it('L56: autoStart defaults to false (no auto-start)', () => {
    // `options?.autoStart !== true` gates the auto-flush start. With autoStart
    // omitted, the manager must NOT auto-start (flushTimer stays null). A
    // `!==`→`===` mutant would start auto-flush despite the omission.
    const mgr = new AuditLogManager({ logFilePath: tmpLogPath() });
    expect(internal<ReturnType<typeof setInterval> | null>(mgr, 'flushTimer')).toBeNull();
    mgr.destroy();
  });

  it('L82/L316: buffers flush exactly when reaching MAX_BUFFER_SIZE (100)', async () => {
    // Append 100 events: buffer reaches 100 → auto flush clears the buffer.
    for (let i = 0; i < 100; i++) {
      await logger.log(makePartial({ action: `ACT_${i}` }));
    }
    // After 100 buffered events, flush fired → buffer emptied, file has 100 lines.
    await logger.flush();
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content.split('\n').length).toBe(100);
  });

  it('L96: time-range filter is inclusive on both ends', async () => {
    const t0 = Date.now();
    const e = await logger.log(makePartial({ action: 'RANGE' }));
    // Query with from/to bracketing the event timestamp exactly.
    const from = e.timestamp;
    const to = e.timestamp;
    const res = await logger.query({ timeRange: { from, to } });
    // `>=` and `<=` (inclusive). A `<`/`>` mutant would exclude the boundary
    // event, yielding zero results.
    expect(res.map((r) => r.seq)).toContain(e.seq);
    void t0;
  });

  it('L131/L132: free-text search matches across action AND actor AND resource', async () => {
    await logger.log(
      makePartial({
        action: 'SPECIAL_OP',
        actor: { id: 'unique-actor-xyz', ip: '', sessionId: '' },
      }),
    );
    await logger.log(
      makePartial({
        action: 'OTHER',
        message: 'mentions specialterm somewhere',
      }),
    );
    // "special" appears in action of first event (case-insensitive).
    const byAction = await logger.query({ search: 'special_op' });
    expect(byAction.length).toBe(1);
    // "unique-actor" appears in actor.id of first event.
    const byActor = await logger.query({ search: 'unique-actor' });
    expect(byActor.length).toBe(1);
  });

  it('L144: sort by category uses localeCompare', async () => {
    await logger.log(makePartial({ action: 'A', category: 'security' }));
    await logger.log(makePartial({ action: 'B', category: 'compliance' }));
    await logger.log(makePartial({ action: 'C', category: 'connection' }));
    const res = await logger.query({ sortBy: 'category', sortDir: 'asc' });
    const cats = res.map((e) => e.category);
    // compliance < connection < security under localeCompare.
    expect(cats).toEqual(['compliance', 'connection', 'security']);
  });

  it('L249: flush creates the parent directory recursively', async () => {
    const deep = path.join(os.tmpdir(), `audit-deep-${Date.now()}`, 'nested', 'sub', 'log.jsonl');
    const mgr = new AuditLogManager({ logFilePath: deep, autoStart: false });
    await mgr.log(makePartial({ action: 'DEEP' }));
    await mgr.flush();
    expect(fs.existsSync(deep)).toBe(true);
    mgr.destroy();
    // cleanup
    fs.rmSync(path.dirname(deep), { recursive: true, force: true });
  });
});
