/**
 * I29 — E3 Audit Logging tests.
 *
 * AUD1-AUD4: AuditLogManager (logging, batch, query, statistics)
 * AUD5-AUD8: Chain integrity & retention (hash chain, tamper detection, pruning)
 * AUD9-AUD12: Integration (flush/persistence, export, error resilience, edge cases)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import type { AuditEvent, AuditCategory, AuditSeverity } from '../interfaces/IAuditLogger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ────────────────────────────────────────────────

function makePartial(
  overrides: Partial<Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>> = {},
): Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'> {
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
  return path.join(os.tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
}

// ── AUD1: Core Logging ──────────────────────────────────────

describe('AUD1: Core event logging', () => {
  let logger: AuditLogManager;

  beforeEach(() => {
    logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
  });

  afterEach(() => {
    logger.destroy();
  });

  it('logs a single event with all required fields', async () => {
    const event = await logger.log(makePartial({ action: 'CREATE_TABLE' }));
    expect(event.id).toBeTruthy();
    expect(event.seq).toBe(1);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.category).toBe('data_access');
    expect(event.severity).toBe('info');
    expect(event.action).toBe('CREATE_TABLE');
    expect(event.message).toBe('Query executed');
    expect(event.actor.id).toBe('user-1');
    expect(event.resource.type).toBe('table');
    expect(event.success).toBe(true);
    expect(event.hash).toHaveLength(64);
    expect(event.prevHash).toBeTruthy();
  });

  it('monotonic sequence numbering across events', async () => {
    const e1 = await logger.log(makePartial());
    const e2 = await logger.log(makePartial());
    const e3 = await logger.log(makePartial());

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('chain hashes link consecutive events', async () => {
    const e1 = await logger.log(makePartial());
    const e2 = await logger.log(makePartial());

    expect(e2.prevHash).toBe(e1.hash);
  });

  it('logs failed events with error details', async () => {
    const event = await logger.log(
      makePartial({
        success: false,
        error: { code: 'EACCES', message: 'Permission denied' },
      }),
    );

    expect(event.success).toBe(false);
    expect(event.error?.code).toBe('EACCES');
    expect(event.error?.message).toBe('Permission denied');
  });

  it('supports all audit categories', async () => {
    const categories: AuditCategory[] = [
      'authentication',
      'authorization',
      'data_access',
      'schema_change',
      'configuration',
      'security',
      'connection',
      'query',
      'system',
      'compliance',
    ];

    for (const cat of categories) {
      const event = await logger.log(makePartial({ category: cat, action: `TEST_${cat.toUpperCase()}` }));
      expect(event.category).toBe(cat);
    }

    expect(logger.eventCount).toBe(categories.length);
  });

  it('supports all severity levels', async () => {
    const severities: AuditSeverity[] = ['debug', 'info', 'warning', 'error', 'critical'];

    for (const sev of severities) {
      const event = await logger.log(makePartial({ severity: sev, message: `severity: ${sev}` }));
      expect(event.severity).toBe(sev);
    }
  });

  it('attaches arbitrary metadata', async () => {
    const event = await logger.log(
      makePartial({
        metadata: { queryTimeMs: 42, rowsReturned: 1337, plan: 'SeqScan' },
      }),
    );

    expect(event.metadata?.queryTimeMs).toBe(42);
    expect(event.metadata?.rowsReturned).toBe(1337);
  });
});

// ── AUD2: Batch Logging ─────────────────────────────────────

describe('AUD2: Batch event logging', () => {
  let logger: AuditLogManager;

  beforeEach(() => {
    logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
  });

  afterEach(() => {
    logger.destroy();
  });

  it('logs multiple events atomically with correct sequencing', async () => {
    const partials = [
      makePartial({ action: 'INSERT', actor: { id: 'alice' } }),
      makePartial({ action: 'UPDATE', actor: { id: 'bob' } }),
      makePartial({ action: 'DELETE', actor: { id: 'carol' } }),
    ];

    const events = await logger.logBatch(partials);

    expect(events).toHaveLength(3);
    expect(events[0]!.seq).toBe(1);
    expect(events[1]!.seq).toBe(2);
    expect(events[2]!.seq).toBe(3);
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    expect(events[2]!.prevHash).toBe(events[1]!.hash);
  });

  it('batch and single log interleave correctly', async () => {
    await logger.log(makePartial({ action: 'BEFORE_BATCH' }));
    const batch = await logger.logBatch([makePartial({ action: 'BATCH_A' }), makePartial({ action: 'BATCH_B' })]);
    await logger.log(makePartial({ action: 'AFTER_BATCH' }));

    expect(batch[0]!.seq).toBe(2);
    expect(batch[1]!.seq).toBe(3);
    expect(logger.eventCount).toBe(4);
  });
});

// ── AUD3: Query Engine ──────────────────────────────────────

describe('AUD3: Query engine', () => {
  let logger: AuditLogManager;

  beforeEach(async () => {
    logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    // Seed diverse events
    await logger.log(
      makePartial({
        category: 'authentication',
        severity: 'warning',
        action: 'LOGIN_FAILED',
        actor: { id: 'alice' },
        message: 'Wrong password',
      }),
    );
    await logger.log(
      makePartial({
        category: 'data_access',
        severity: 'info',
        action: 'SELECT',
        actor: { id: 'bob' },
        resource: { type: 'table', id: 'orders' },
        success: true,
      }),
    );
    await logger.log(
      makePartial({
        category: 'schema_change',
        severity: 'critical',
        action: 'DROP_TABLE',
        actor: { id: 'admin' },
        message: 'Dropped users table',
        success: true,
      }),
    );
    await logger.log(
      makePartial({
        category: 'security',
        severity: 'error',
        action: 'ACCESS_DENIED',
        actor: { id: 'eve' },
        resource: { type: 'config', id: 'secrets' },
        success: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient privileges' },
      }),
    );
    await logger.log(
      makePartial({
        category: 'data_access',
        severity: 'info',
        action: 'SELECT',
        actor: { id: 'bob' },
        success: true,
        metadata: { rows: 5000 },
      }),
    );
  });

  afterEach(() => {
    logger.destroy();
  });

  it('filters by category', async () => {
    const results = await logger.query({ categories: ['data_access'] });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.category === 'data_access')).toBe(true);
  });

  it('filters by severity', async () => {
    const results = await logger.query({ severities: ['error', 'critical'] });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.severity === 'error' || e.severity === 'critical')).toBe(true);
  });

  it('filters by actor', async () => {
    const results = await logger.query({ actorIds: ['bob'] });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.actor.id === 'bob')).toBe(true);
  });

  it('filters by success status', async () => {
    const failed = await logger.query({ success: false });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.action).toBe('ACCESS_DENIED');

    const succeeded = await logger.query({ success: true });
    expect(succeeded.length).toBeGreaterThanOrEqual(3);
  });

  it('free-text search', async () => {
    const results = await logger.query({ search: 'password' });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('LOGIN_FAILED');

    const dropResults = await logger.query({ search: 'drop' });
    expect(dropResults).toHaveLength(1);
    expect(dropResults[0]!.action).toBe('DROP_TABLE');
  });

  it('paginates results', async () => {
    const page1 = await logger.query({ limit: 2, offset: 0, sortBy: 'seq' });
    const page2 = await logger.query({ limit: 2, offset: 2, sortBy: 'seq' });
    const page3 = await logger.query({ limit: 2, offset: 4, sortBy: 'seq' });

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page3).toHaveLength(1);
    expect(page1[0]!.seq).toBe(1);
    expect(page2[0]!.seq).toBe(3);
  });

  it('sorts by different fields', async () => {
    const bySeq = await logger.query({ sortBy: 'seq', sortDir: 'desc' });
    expect(bySeq[0]!.seq).toBeGreaterThan(bySeq[bySeq.length - 1]!.seq);

    const bySeverity = await logger.query({
      sortBy: 'severity',
      sortDir: 'asc',
    });
    // severity weights: debug<info<warning<error<critical
    const firstSev = bySeverity[0]!.severity;
    const lastSev = bySeverity[bySeverity.length - 1]!.severity;
    expect(['debug', 'info'].includes(firstSev) || firstSev <= bySeverity[1]!.severity).toBe(true);
  });

  it('empty query returns all events', async () => {
    const results = await logger.query({});
    expect(results).toHaveLength(5);
  });
});

// ── AUD4: Statistics ────────────────────────────────────────

describe('AUD4: Statistics', () => {
  it('provides aggregate statistics', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(
      makePartial({
        category: 'authentication',
        severity: 'warning',
        actor: { id: 'alice' },
      }),
    );
    await logger.log(
      makePartial({
        category: 'data_access',
        severity: 'info',
        actor: { id: 'bob' },
      }),
    );
    await logger.log(
      makePartial({
        category: 'data_access',
        severity: 'error',
        actor: { id: 'alice' },
        success: false,
        error: { code: 'ERR', message: 'fail' },
      }),
    );

    const stats = await logger.getStats();

    expect(stats.totalEvents).toBe(3);
    expect(stats.eventsByCategory['authentication']).toBe(1);
    expect(stats.eventsByCategory['data_access']).toBe(2);
    expect(stats.eventsBySeverity['warning']).toBe(1);
    expect(stats.eventsBySeverity['info']).toBe(1);
    expect(stats.eventsBySeverity['error']).toBe(1);
    expect(stats.eventsByActor['alice']).toBe(2);
    expect(stats.eventsByActor['bob']).toBe(1);
    expect(stats.failedEvents).toBe(1);
    expect(stats.oldestEventAt).toBeTruthy();
    expect(stats.newestEventAt).toBeTruthy();

    logger.destroy();
  });

  it('empty stats are zero-initialized', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
    const stats = await logger.getStats();

    expect(stats.totalEvents).toBe(0);
    expect(stats.failedEvents).toBe(0);
    expect(stats.oldestEventAt).toBeNull();
    expect(stats.newestEventAt).toBeNull();
  });
});

// ── AUD5: Hash Chain Integrity ──────────────────────────────

describe('AUD5: Hash chain integrity', () => {
  it('verifies clean audit chain as valid', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial());
    await logger.log(makePartial());
    await logger.log(makePartial());

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects tampered hash', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    const events = await logger.logBatch([
      makePartial({ action: 'EVENT_A' }),
      makePartial({ action: 'EVENT_B' }),
      makePartial({ action: 'EVENT_C' }),
    ]);

    // Tamper with event B by directly modifying internal state
    // We need to reach into the internal events array
    const internalEvents = (logger as any).events as AuditEvent[];
    // Flip the first nibble rather than hard-coding "0": a hash that already
    // starts with 0 left the value — and the chain — untouched, so the
    // assertion failed roughly once in sixteen runs.
    const original = internalEvents[1]!.hash!;
    const flipped = (original[0] === '0' ? '1' : '0') + original.slice(1);
    internalEvents[1]!.hash = flipped;
    expect(flipped).not.toBe(original);

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
  });

  it('detects broken chain', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.logBatch([makePartial({ action: 'EVENT_A' }), makePartial({ action: 'EVENT_B' })]);

    const internalEvents = (logger as any).events as AuditEvent[];
    // Break the chain: set B's prevHash to something wrong
    internalEvents[1]!.prevHash = '0000000000000000000000000000000000000000000000000000000000000000';

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
  });

  it('empty chain is valid', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(true);
  });
});

// ── AUD6: Tamper Detection ──────────────────────────────────

describe('AUD6: Tamper detection — comprehensive', () => {
  it('detects event insertion (missing from chain)', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ action: 'A' }));
    await logger.log(makePartial({ action: 'B' }));
    await logger.log(makePartial({ action: 'C' }));

    // Simulate insertion by manipulating seq
    const internalEvents = (logger as any).events as AuditEvent[];
    internalEvents[1]!.seq = 99;

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('seq gap'))).toBe(true);
  });

  it('detects modified message content via hash mismatch', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ message: 'Original message' }));

    const internalEvents = (logger as any).events as AuditEvent[];
    internalEvents[0]!.message = 'Tampered message';

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tampered'))).toBe(true);
  });

  it('detects modified actor', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ actor: { id: 'original-user' } }));

    const internalEvents = (logger as any).events as AuditEvent[];
    internalEvents[0]!.actor.id = 'hacked-user';

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
  });
});

// ── AUD7: Retention & Pruning ───────────────────────────────

describe('AUD7: Retention and pruning', () => {
  it('prunes events older than specified age', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
      retention: { minRetain: 0 },
    });

    // Insert events with varying timestamps by accessing internal state
    await logger.logBatch([
      makePartial({ action: 'OLD_1' }),
      makePartial({ action: 'OLD_2' }),
      makePartial({ action: 'NEW_1' }),
    ]);

    // Manually set timestamps to simulate old events
    const internalEvents = (logger as any).events as AuditEvent[];
    const now = Date.now();
    internalEvents[0]!.timestamp = now - 200_000; // 200s ago
    internalEvents[1]!.timestamp = now - 100_000; // 100s ago
    internalEvents[2]!.timestamp = now; // now

    // Prune events older than 150s
    const pruned = await logger.prune(150_000);
    expect(pruned).toBe(1);

    const remaining = await logger.query({});
    expect(remaining.length).toBe(2);
  });

  it('respects minRetain in pruning', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
      retention: { minRetain: 2 },
    });

    await logger.logBatch([makePartial({ action: 'A' }), makePartial({ action: 'B' }), makePartial({ action: 'C' })]);

    const internalEvents = (logger as any).events as AuditEvent[];
    const now = Date.now();
    // All events are very old
    internalEvents[0]!.timestamp = now - 500_000;
    internalEvents[1]!.timestamp = now - 400_000;
    internalEvents[2]!.timestamp = now - 300_000;

    // Prune events older than 1 second
    const pruned = await logger.prune(1_000);
    // Should keep minRetain=2 events
    expect(pruned).toBe(1);
    expect(logger.eventCount).toBe(2);
  });

  it('maxEvents retention trims on flush', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
      retention: { maxEvents: 3, minRetain: 0 },
    });

    for (let i = 0; i < 5; i++) {
      await logger.log(makePartial({ action: `EVENT_${i}` }));
    }

    await logger.flush();
    // Should have trimmed to maxEvents=3
    expect(logger.eventCount).toBe(3);
  });
});

// ── AUD8: Export ────────────────────────────────────────────

describe('AUD8: Export', () => {
  it('exports all events as JSONL', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ action: 'E1' }));
    await logger.log(makePartial({ action: 'E2' }));

    const jsonl = await logger.exportJSONL();
    const lines = jsonl.split('\n').filter(Boolean);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toBeTruthy();
      expect(parsed.hash).toHaveLength(64);
    }
  });

  it('exports filtered events', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ category: 'authentication', action: 'LOGIN' }));
    await logger.log(makePartial({ category: 'data_access', action: 'SELECT' }));
    await logger.log(makePartial({ category: 'security', action: 'GRANT' }));

    const jsonl = await logger.exportJSONL({
      categories: ['authentication', 'security'],
    });
    const lines = jsonl.split('\n').filter(Boolean);

    expect(lines).toHaveLength(2);
    const actions = lines.map((l) => JSON.parse(l).action);
    expect(actions).toContain('LOGIN');
    expect(actions).toContain('GRANT');
  });
});

// ── AUD9: Flush & Persistence ───────────────────────────────

describe('AUD9: Flush and persistence', () => {
  it('flushes buffer to file', async () => {
    const filePath = tmpLogPath();
    const logger = new AuditLogManager({
      logFilePath: filePath,
      autoStart: false,
    });

    await logger.log(makePartial({ action: 'PERSIST_1' }));
    await logger.log(makePartial({ action: 'PERSIST_2' }));

    await logger.flush();

    // File should exist and have content
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    logger.destroy();
    fs.unlinkSync(filePath);
  });

  it('auto-flush fires after buffer threshold', async () => {
    const filePath = tmpLogPath();
    const logger = new AuditLogManager({
      logFilePath: filePath,
      autoStart: false,
    });

    // MAX_BUFFER_SIZE is 100, so log 101 events to trigger auto-flush
    for (let i = 0; i < 101; i++) {
      await logger.log(makePartial({ action: `AUTO_${i}` }));
    }

    // File should have been flushed (at least partial)
    expect(fs.existsSync(filePath)).toBe(true);

    logger.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {}
  });
});

// ── AUD10: Resource Diversity ───────────────────────────────

describe('AUD10: Resource diversity', () => {
  it('logs events against different resource types', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(
      makePartial({
        resource: { type: 'table', id: 'users', path: '/db/sales/users' },
        action: 'ALTER_TABLE',
      }),
    );
    await logger.log(
      makePartial({
        resource: {
          type: 'index',
          id: 'idx_users_email',
          path: '/db/sales/idx_users_email',
        },
        action: 'CREATE_INDEX',
      }),
    );
    await logger.log(
      makePartial({
        resource: { type: 'role', id: 'readonly', path: '/rbac/roles' },
        action: 'GRANT_ROLE',
      }),
    );
    await logger.log(
      makePartial({
        resource: { type: 'connection', id: 'pool-1', path: '/pools' },
        category: 'connection',
        action: 'CONNECT',
      }),
    );

    const byResource = await logger.query({ resourceTypes: ['table'] });
    expect(byResource).toHaveLength(1);
    expect(byResource[0]!.resource.type).toBe('table');
  });
});

// ── AUD11: Error Resilience ─────────────────────────────────

describe('AUD11: Error resilience', () => {
  it('failed operations are logged correctly', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    const event = await logger.log(
      makePartial({
        success: false,
        error: { code: 'ETIMEOUT', message: 'Connection timed out after 30s' },
      }),
    );

    expect(event.success).toBe(false);
    expect(event.error?.code).toBe('ETIMEOUT');
    expect(event.hash).toHaveLength(64); // Hash still computed
  });

  it('high-volume logging (1000 events) maintains chain integrity', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
      retention: { maxEvents: 0, minRetain: 0 }, // No auto-pruning
    });

    const partials = Array.from({ length: 1000 }, (_, i) =>
      makePartial({ action: `HIGH_VOL_${i}`, actor: { id: `user-${i % 10}` } }),
    );

    await logger.logBatch(partials);
    expect(logger.eventCount).toBe(1000);

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('interleaved category and severity queries work', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ category: 'authentication', severity: 'critical' }));
    await logger.log(makePartial({ category: 'authentication', severity: 'debug' }));
    await logger.log(makePartial({ category: 'data_access', severity: 'critical' }));
    await logger.log(makePartial({ category: 'data_access', severity: 'debug' }));

    const authCritical = await logger.query({
      categories: ['authentication'],
      severities: ['critical'],
    });
    expect(authCritical).toHaveLength(1);

    const dataDebug = await logger.query({
      categories: ['data_access'],
      severities: ['debug'],
    });
    expect(dataDebug).toHaveLength(1);
  });
});

// ── AUD12: Edge Cases ───────────────────────────────────────

describe('AUD12: Edge cases', () => {
  it('flush empty buffer is no-op', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
    await logger.flush(); // Should not throw
    expect(logger.eventCount).toBe(0);
  });

  it('export empty events returns empty string', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
    const jsonl = await logger.exportJSONL();
    expect(jsonl).toBe('');
  });

  it('prune with nothing to prune returns 0', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });
    const pruned = await logger.prune(1_000);
    expect(pruned).toBe(0);
  });

  it('multiple flushes are idempotent', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    await logger.log(makePartial({ action: 'IDEM' }));
    await logger.flush();
    await logger.flush(); // Second flush — no-op

    expect(logger.eventCount).toBe(1);
  });

  it('destroy flushes and stops timer', async () => {
    const filePath = tmpLogPath();
    const logger = new AuditLogManager({
      logFilePath: filePath,
      autoStart: true,
    });

    await logger.log(makePartial({ action: 'BEFORE_DESTROY' }));
    logger.destroy();

    // File should be flushed
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);

    // destroy() should be idempotent
    logger.destroy();

    try {
      fs.unlinkSync(filePath);
    } catch {}
  });

  it('custom log file path is respected', async () => {
    const customPath = tmpLogPath();
    const logger = new AuditLogManager({
      logFilePath: customPath,
      autoStart: false,
    });

    await logger.log(makePartial());
    await logger.flush();

    expect(fs.existsSync(customPath)).toBe(true);

    logger.destroy();
    try {
      fs.unlinkSync(customPath);
    } catch {}
  });

  it('metadata survives hash computation consistently', async () => {
    const logger = new AuditLogManager({
      logFilePath: tmpLogPath(),
      autoStart: false,
    });

    const meta = {
      queryTimeMs: 12.5,
      plan: 'IndexScan',
      indexUsed: 'idx_users_email',
    };
    const event = await logger.log(makePartial({ metadata: meta }));

    expect(event.metadata).toEqual(meta);
    // Re-compute hash and verify
    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(true);
  });
});
