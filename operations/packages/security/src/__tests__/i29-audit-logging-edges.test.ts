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
  it('writes to audit.jsonl in the working directory and retains 90 days', async () => {
    // Two rules, and P3-5 was the cost of learning the second one.
    //
    // `destroy()` flushes, so a default-path manager writes `audit.jsonl` into
    // whatever directory the process is in — under the mutation run that was this
    // repository (161 entries from one worker, and a dirty working tree for every
    // gate that followed). `process.chdir()` is not available in a worker, so the
    // test does not move the working directory either: it reads the default off a
    // manager it never destroys, and then proves that this exact path is the one a
    // flush writes to — on a second manager that is destroyed and cleaned up.
    const manager = new AuditLogManager();
    const derived = path.join(process.cwd(), 'audit.jsonl');

    expect(Reflect.get(manager, 'logFilePath')).toBe(derived);
    expect(retentionOf(manager)).toEqual({
      maxEvents: 1_000_000,
      maxAgeMs: 90 * 24 * 3600 * 1000,
      minRetain: 1_000,
    });

    const writer = new AuditLogManager({ logFilePath: derived });
    try {
      await writer.log(makePartial({ action: 'DEFAULT_PATH' }));
      writer.destroy();

      const lines = fs.readFileSync(derived, 'utf-8').trim().split('\n');
      expect(JSON.parse(lines[0]!).action).toBe('DEFAULT_PATH');
    } finally {
      writer.destroy();
      if (fs.existsSync(derived)) fs.unlinkSync(derived);
    }
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
