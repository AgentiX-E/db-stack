/**
 * I29 — audit log lifecycle and tamper-response edges.
 *
 * Covers the defaults a deployment gets when it configures nothing, the
 * auto-flush timer actually persisting events, severity ordering in the query
 * engine, and verification of an event whose stored hash has disappeared.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import type { AuditEvent, AuditRetentionPolicy } from '../interfaces/IAuditLogger.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

type AuditEventDraft = Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>;

function makePartial(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    category: 'data_access',
    severity: 'info',
    action: 'SELECT',
    message: 'Query executed',
    actor: { id: 'user-1' },
    resource: { type: 'table', id: 'users' },
    success: true,
    ...overrides,
  };
}

function tmpLogPath(): string {
  return path.join(os.tmpdir(), `audit-edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
}

function retentionOf(manager: AuditLogManager): Required<AuditRetentionPolicy> {
  return Reflect.get(manager, 'retention') as Required<AuditRetentionPolicy>;
}

function eventsOf(manager: AuditLogManager): AuditEvent[] {
  return Reflect.get(manager, 'events') as AuditEvent[];
}

const openManagers: AuditLogManager[] = [];

function makeManager(options: ConstructorParameters<typeof AuditLogManager>[0] = {}): AuditLogManager {
  const manager = new AuditLogManager({ autoStart: false, logFilePath: tmpLogPath(), ...options });
  openManagers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of openManagers.splice(0)) {
    const logFilePath = Reflect.get(manager, 'logFilePath') as string;
    manager.destroy();
    if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
  }
});

describe('AuditLogManager — defaults a deployment gets with no configuration', () => {
  it('writes to audit.jsonl in the working directory and retains 90 days', () => {
    const manager = new AuditLogManager();

    expect(Reflect.get(manager, 'logFilePath')).toBe(path.join(process.cwd(), 'audit.jsonl'));
    expect(retentionOf(manager)).toEqual({
      maxEvents: 1_000_000,
      maxAgeMs: 90 * 24 * 3600 * 1000,
      minRetain: 1_000,
    });

    manager.destroy();
  });

  it('does not create the log file merely by being constructed', () => {
    const logFilePath = tmpLogPath();
    const manager = new AuditLogManager({ logFilePath });

    expect(fs.existsSync(logFilePath)).toBe(false);
    manager.destroy();
  });
});

describe('AuditLogManager — auto-flush timer', () => {
  it('persists a logged event when the 10s flush interval fires', async () => {
    vi.useFakeTimers();
    const logFilePath = tmpLogPath();
    try {
      const manager = new AuditLogManager({ logFilePath, autoStart: true });
      await manager.log(makePartial({ action: 'TIMED_FLUSH' }));

      expect(fs.existsSync(logFilePath)).toBe(false);

      vi.advanceTimersByTime(10_000);

      const lines = fs.readFileSync(logFilePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).action).toBe('TIMED_FLUSH');

      manager.destroy();
    } finally {
      vi.useRealTimers();
      if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
    }
  });
});

describe('AuditLogManager — severity ordering', () => {
  it('orders debug below critical when sorting by severity', async () => {
    const manager = makeManager();
    await manager.log(makePartial({ severity: 'debug', action: 'DEBUG_ONE' }));
    await manager.log(makePartial({ severity: 'critical', action: 'CRITICAL_ONE' }));

    const ascending = await manager.query({ sortBy: 'severity', sortDir: 'asc' });
    const descending = await manager.query({ sortBy: 'severity', sortDir: 'desc' });

    expect(ascending.map((e) => e.severity)).toEqual(['debug', 'critical']);
    expect(descending.map((e) => e.severity)).toEqual(['critical', 'debug']);
  });
});

describe('AuditLogManager — verification of a damaged record', () => {
  it('reports an event whose stored hash has been removed', async () => {
    const manager = makeManager();
    await manager.log(makePartial({ action: 'FIRST' }));
    await manager.log(makePartial({ action: 'SECOND' }));

    delete eventsOf(manager)[0]!.hash;

    const result = await manager.verifyIntegrity();

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hash mismatch at seq 1'))).toBe(true);
  });

  it('keeps the chain verifiable when only the final event is damaged', async () => {
    const manager = makeManager();
    await manager.log(makePartial({ action: 'ONLY' }));

    eventsOf(manager).at(-1)!.hash = 'f'.repeat(64);

    const result = await manager.verifyIntegrity();

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
});

describe('AuditLogManager — retention limits', () => {
  it('keeps every event when maxEvents is zero (unlimited)', async () => {
    const manager = makeManager({ retention: { maxEvents: 0, minRetain: 0 } });
    for (let i = 0; i < 5; i++) await manager.log(makePartial({ action: `EVENT_${i}` }));

    await manager.flush();

    expect(manager.eventCount).toBe(5);
  });

  it('never trims below minRetain when maxEvents is smaller than minRetain', async () => {
    const manager = makeManager({ retention: { maxEvents: 1, minRetain: 4 } });
    for (let i = 0; i < 6; i++) await manager.log(makePartial({ action: `EVENT_${i}` }));

    await manager.flush();

    expect(manager.eventCount).toBe(4);
  });
});
