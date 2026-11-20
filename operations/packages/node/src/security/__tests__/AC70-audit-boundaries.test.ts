/**
 * I30 — AC 70: the assertions the two audit modules were missing.
 *
 * AC 68 and AC 69 pinned the behaviour iteration 30 changed. This suite exists for
 * the other half of the measurement: the mutants that survived in code nobody had
 * asserted. Each case below was written against a specific survivor, and most of
 * them are *boundaries* — the comparison that decides whether an event is inside
 * the retention window, whether an import is accepted, whether a chain is called
 * broken. A guard is only a rule if its edge is tested: `timestamp < cutoff` and
 * `timestamp <= cutoff` differ for exactly one millisecond, and that millisecond is
 * the difference between "retention kept what it promised" and "retention deleted
 * an event it said it would keep".
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import { RotationAuditor } from '../impl/RotationAuditor.js';
import type { AuditEvent, AuditRetentionPolicy } from '../interfaces/IAuditLogger.js';
import type { RotationEvent } from '../interfaces/IKeyRotationManager.js';

// ── Fixtures ───────────────────────────────────────────────

type Draft = Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>;

function draft(overrides: Partial<Draft> = {}): Draft {
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

let tmpDir = '';
let fileSeq = 0;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac70-audit-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const open: AuditLogManager[] = [];

function make(options: { retention?: AuditRetentionPolicy } = {}): AuditLogManager {
  fileSeq += 1;
  const manager = new AuditLogManager({
    logFilePath: path.join(tmpDir, `audit-${fileSeq}.jsonl`),
    autoStart: false,
    ...options,
  });
  open.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of open.splice(0)) manager.destroy();
  vi.useRealTimers();
});

function eventsOf(manager: AuditLogManager): AuditEvent[] {
  return Reflect.get(manager, 'events') as AuditEvent[];
}

const CLOCK_BASE = 1_700_000_000_000;

function startClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK_BASE));
}

function setClock(offsetMs: number): void {
  vi.setSystemTime(new Date(CLOCK_BASE + offsetMs));
}

/** Log one event per offset, each written at that offset, then return to the base. */
async function logAged(manager: AuditLogManager, offsetsMs: number[]): Promise<AuditEvent[]> {
  startClock();
  const events: AuditEvent[] = [];
  for (let i = 0; i < offsetsMs.length; i += 1) {
    setClock(offsetsMs[i]!);
    events.push(await manager.log(draft({ action: `EVENT_${i}` })));
  }
  setClock(0);
  return events;
}

async function seqsOf(
  manager: AuditLogManager,
  query: Parameters<AuditLogManager['query']>[0] = {},
): Promise<number[]> {
  return (await manager.query(query)).map((event) => event.seq);
}

// ── AC 70.1–70.6 — the query engine removes what it says it removes

describe('AC 70 — every filter has to exclude something', () => {
  it('70.1 returns only the events inside the time range, at both ends', async () => {
    const manager = make();
    const events = await logAged(manager, [-3_000, -2_000, -1_000, 0]);
    const from = events[1]!.timestamp;
    const to = events[2]!.timestamp;

    const inRange = await manager.query({ timeRange: { from, to } });

    expect(inRange.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('70.2 excludes an event outside either end of the range', async () => {
    const manager = make();
    const events = await logAged(manager, [-3_000, -2_000, -1_000, 0]);

    // A window that falls between two events, and one that ends before the first.
    const between = await manager.query({
      timeRange: { from: events[1]!.timestamp + 1, to: events[2]!.timestamp - 1 },
    });
    const beforeFirst = await manager.query({
      timeRange: { from: events[0]!.timestamp - 10, to: events[0]!.timestamp - 1 },
    });

    expect(between).toEqual([]);
    expect(beforeFirst).toEqual([]);
  });

  it('70.3 treats an empty filter list as no filter, for all five list filters', async () => {
    const manager = make();
    await manager.log(draft({ action: 'ONE' }));
    await manager.log(draft({ action: 'TWO' }));

    const results = await manager.query({
      categories: [],
      severities: [],
      actorIds: [],
      resourceTypes: [],
      search: '',
    });

    expect(results).toHaveLength(2);
  });

  it('70.4 matches each list filter against its own field', async () => {
    const manager = make();
    await manager.log(draft({ category: 'authentication', severity: 'critical', action: 'LOGIN' }));
    await manager.log(draft({ category: 'schema_change', severity: 'debug', action: 'ALTER' }));

    expect((await manager.query({ categories: ['schema_change'] })).map((e) => e.action)).toEqual(['ALTER']);
    expect((await manager.query({ severities: ['critical'] })).map((e) => e.action)).toEqual(['LOGIN']);
  });

  it('70.5 matches a free-text term in any of the four searchable fields, case-insensitively', async () => {
    const manager = make();
    await manager.log(draft({ action: 'A', message: 'nothing here', resource: { type: 'table', id: 'Orders' } }));
    await manager.log(draft({ action: 'B', message: 'nothing here', resource: { type: 'table', id: 'users' } }));

    const byResourceId = await manager.query({ search: 'orders' });

    expect(byResourceId.map((event) => event.action)).toEqual(['A']);
  });

  it('70.6 counts failures for the statistics, not successes', async () => {
    const manager = make();
    await manager.log(draft({ action: 'OK' }));
    await manager.log(draft({ action: 'FAILED', success: false, error: { code: 'E', message: 'no' } }));
    await manager.log(draft({ action: 'FAILED_AGAIN', success: false, error: { code: 'E', message: 'no' } }));

    const stats = await manager.getStats();

    expect(stats.failedEvents).toBe(2);
    expect(stats.totalEvents).toBe(3);
  });
});

// ── AC 70.7–70.9 — sorting is decided by the field, not by insertion order

describe('AC 70 — each sort field orders by its own value', () => {
  it('70.7 sorts by sequence even when the timestamps run backwards', async () => {
    const manager = make();
    // A clock that went backwards: seq order and timestamp order now disagree.
    await logAged(manager, [-1_000, -2_000, -3_000]);

    const bySeq = await seqsOf(manager, { sortBy: 'seq' });
    const byTime = await seqsOf(manager, { sortBy: 'timestamp' });

    expect(bySeq).toEqual([1, 2, 3]);
    expect(byTime).toEqual([3, 2, 1]);
  });

  it('70.8 ranks all five severities from debug to critical', async () => {
    const manager = make();
    const severities = ['critical', 'error', 'warning', 'info', 'debug'] as const;
    for (const severity of severities) await manager.log(draft({ severity }));

    const ascending = await manager.query({ sortBy: 'severity' });
    const descending = await manager.query({ sortBy: 'severity', sortDir: 'desc' });

    expect(ascending.map((event) => event.severity)).toEqual(['debug', 'info', 'warning', 'error', 'critical']);
    expect(descending.map((event) => event.severity)).toEqual(['critical', 'error', 'warning', 'info', 'debug']);
  });

  it('70.9 sorts by category name in both directions', async () => {
    const manager = make();
    for (const category of ['system', 'authentication', 'query'] as const) await manager.log(draft({ category }));

    const ascending = await manager.query({ sortBy: 'category' });
    const descending = await manager.query({ sortBy: 'category', sortDir: 'desc' });

    expect(ascending.map((event) => event.category)).toEqual(['authentication', 'query', 'system']);
    expect(descending.map((event) => event.category)).toEqual(['system', 'query', 'authentication']);
  });
});

// ── AC 70.10–70.13 — retention boundaries, to the millisecond

describe('AC 70 — retention keeps an event that sits exactly on the cutoff', () => {
  it('70.10 does not prune an event whose timestamp equals the cutoff', async () => {
    const manager = make({ retention: { minRetain: 0 } });
    await logAged(manager, [-1_000, 0]);

    expect(await manager.prune(1_000)).toBe(0);
    // One millisecond narrower and the same event is out of the window.
    expect(await manager.prune(999)).toBe(1);
    expect(await seqsOf(manager)).toEqual([2]);
  });

  it('70.11 does not age out an event whose timestamp equals the age limit', async () => {
    const manager = make({ retention: { maxAgeMs: 1_000, minRetain: 0 } });
    await logAged(manager, [-2_000, -1_000, 0]);

    await manager.flush();

    expect(await seqsOf(manager)).toEqual([2, 3]);
  });

  it('70.12 applies the ceiling only when the window is over it', async () => {
    const manager = make({ retention: { maxEvents: 3, minRetain: 0 } });
    await logAged(manager, [-1_000, -900, -800]);

    await manager.flush();

    expect(manager.eventCount).toBe(3);
    expect((await manager.verifyIntegrity()).truncated).toBeNull();
  });

  it('70.13 lets the age rule drop more than the ceiling would', async () => {
    const manager = make({ retention: { maxAgeMs: 3_500, maxEvents: 5, minRetain: 0 } });
    // Six events outside the age window and four inside it: the age rule removes
    // six, leaving four — fewer than the ceiling of five, so the ceiling has no say.
    await logAged(manager, [-9_000, -8_000, -7_000, -6_000, -5_000, -4_000, -3_000, -2_000, -1_000, 0]);

    await manager.flush();

    expect(manager.eventCount).toBe(4);
    expect(await seqsOf(manager)).toEqual([7, 8, 9, 10]);
    expect((await manager.verifyIntegrity()).truncated).toMatchObject({ removedEvents: 6, lastRemovedSeq: 6 });
  });
});

// ── AC 70.14–70.17 — damage is reported where it happened

describe('AC 70 — a damaged record costs one finding, not a cascade', () => {
  it('70.14 names the sequence gap in the retention-anchored chain', async () => {
    const manager = make({ retention: { minRetain: 0 } });
    await logAged(manager, [-3_000, -2_000, -1_000]);
    await manager.prune(2_500);

    eventsOf(manager).shift();

    const result = await manager.verifyIntegrity();
    // Two findings, both true: the entry that is gone is a gap, and the survivor's
    // prevHash points at it.
    expect(result.errors).toEqual([
      'seq gap at index 0: expected 2, got 3',
      'chain broken at seq 3: prevHash mismatch',
    ]);
  });

  it('70.15 reports a tampered message once and keeps the rest of the chain verifiable', async () => {
    const manager = make();
    await manager.log(draft({ action: 'FIRST' }));
    await manager.log(draft({ action: 'SECOND' }));
    await manager.log(draft({ action: 'THIRD' }));

    eventsOf(manager)[1]!.message = 'rewritten';

    const result = await manager.verifyIntegrity();
    expect(result.errors).toEqual(['hash mismatch at seq 2: event may be tampered']);
    expect(result.truncated).toBeNull();
  });

  it('70.16 anchors at nothing when the removed event has no stored hash', async () => {
    const manager = make({ retention: { minRetain: 0 } });
    await logAged(manager, [-2_000, -1_000, 0]);
    delete eventsOf(manager)[0]!.hash;

    expect(await manager.prune(1_500)).toBe(1);

    const result = await manager.verifyIntegrity();
    // The removed event cannot anchor the chain, so the first survivor's prevHash
    // has nothing to match. The break is reported where it is, not silently healed.
    expect(result.truncated!.lastRemovedHash).toBe('');
    expect(result.errors).toContain('chain broken at seq 2: prevHash mismatch');
  });

  it('70.17 chains a new event onto an empty parent when the predecessor lost its hash', async () => {
    const manager = make();
    await manager.log(draft({ action: 'FIRST' }));
    delete eventsOf(manager)[0]!.hash;

    const second = await manager.log(draft({ action: 'SECOND' }));

    expect(second.prevHash).toBe('');
  });
});

// ── AC 70.18–70.19 — the buffer threshold and the timer

describe('AC 70 — the auto-flush threshold is the hundredth event', () => {
  it('70.18 flushes as soon as the buffer holds a full page', async () => {
    fileSeq += 1;
    const file = path.join(tmpDir, `threshold-${fileSeq}.jsonl`);
    const manager = new AuditLogManager({ logFilePath: file, autoStart: false });
    open.push(manager);

    for (let i = 0; i < 100; i += 1) await manager.log(draft({ action: `E${i}` }));

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(100);
  });

  it('70.32 leaves no interval behind after destroy', async () => {
    vi.useFakeTimers();
    fileSeq += 1;
    const file = path.join(tmpDir, `orphan-${fileSeq}.jsonl`);
    const manager = new AuditLogManager({ logFilePath: file, autoStart: true });
    open.push(manager);

    await manager.log(draft({ action: 'BEFORE_DESTROY' }));
    manager.destroy();
    // Anything logged after `destroy()` must stay in the buffer: the interval that
    // would have written it is gone. A second `_startAutoFlush` call or a skipped
    // `clearInterval` leaves an orphan interval that writes this event ten seconds
    // later, and nothing else about the manager would ever show it.
    await manager.log(draft({ action: 'AFTER_DESTROY' }));

    await vi.advanceTimersByTimeAsync(30_000);

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).action).toBe('BEFORE_DESTROY');
  });

  it('70.19 clears the timer reference when destroyed', () => {
    const manager = make();
    const startAutoFlush = Reflect.get(manager, '_startAutoFlush') as () => void;
    startAutoFlush.call(manager);

    manager.destroy();

    expect(Reflect.get(manager, 'flushTimer')).toBeNull();
  });
});

// ── AC 70.20–70.26 — the auditor names the contradiction it found

describe('AC 70 — a refused rotation says exactly what contradicted', () => {
  let counter = 0;

  function event(overrides: Partial<RotationEvent> = {}): RotationEvent {
    counter += 1;
    const startedAt = 1_000 * counter;
    const success = overrides.success ?? true;
    return {
      id: `evt-${counter}`,
      policyId: 'policy-a',
      fromVersion: 1,
      toVersion: 2,
      trigger: { kind: 'manual' },
      startedAt,
      completedAt: success ? startedAt + 100 : null,
      success,
      error: success ? null : 'kms unavailable',
      reEncryptedCount: 0,
      reEncryption: 'not-requested',
      retiredVersion: null,
      ...overrides,
    };
  }

  function entriesOf(auditor: RotationAuditor): unknown[] {
    return Reflect.get(auditor, 'entries') as unknown[];
  }

  it('70.20 names the error a successful rotation carries', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(event({ success: true, error: 'boom' }))).toThrow(
      'rotation event evt-1 contradicts itself: success with error "boom"',
    );
  });

  it('70.21 names a failure with no reason', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(event({ success: false, toVersion: 1, error: null }))).toThrow(
      'contradicts itself: failure with no error',
    );
  });

  it('70.22 names a success with no completion time', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(event({ success: true, completedAt: null }))).toThrow(
      'contradicts itself: success with no completion time',
    );
  });

  it('70.23 names a success that moved no version', () => {
    const auditor = new RotationAuditor();

    expect(() => auditor.record(event({ fromVersion: 7, toVersion: 7 }))).toThrow(
      'contradicts itself: success from v7 to v7',
    );
  });

  it('70.24 calls a sequence gap a broken chain even when every hash still matches', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());
    auditor.record(event());

    (entriesOf(auditor)[1] as { seq: number }).seq = 99;

    const result = auditor.verify();
    expect(result.chainBroken).toBe(true);
    expect(result.errors.join(' ')).toMatch(/seq gap at index 1: expected 2, got 99/);
  });

  it('70.25 fails PCI-DSS only when the span is longer than a year, not equal to it', () => {
    const year = 365 * 24 * 3600 * 1000;
    const auditor = new RotationAuditor();
    auditor.record(event({ startedAt: 0, completedAt: 0 }));
    auditor.record(event({ startedAt: 0, completedAt: year }));

    expect(auditor.generateReport('PCI-DSS')).toMatchObject({ pass: true, findings: [] });
  });

  it('70.26 makes no SOC2 finding when nothing failed', () => {
    const auditor = new RotationAuditor();
    auditor.record(event());

    expect(auditor.generateReport('SOC2').findings).toEqual([]);
  });
});

// ── AC 70.27–70.30 — import boundaries

describe('AC 70 — import checks each line for one specific reason', () => {
  function exported(): { auditor: RotationAuditor; lines: string[] } {
    const auditor = new RotationAuditor();
    auditor.record({
      id: 'evt-a',
      policyId: 'policy-a',
      fromVersion: 1,
      toVersion: 2,
      trigger: { kind: 'manual' },
      startedAt: 1_000,
      completedAt: 1_100,
      success: true,
      error: null,
      reEncryptedCount: 0,
      reEncryption: 'not-requested',
      retiredVersion: null,
    });
    return { auditor, lines: auditor.exportJSONL().split('\n') };
  }

  it('70.27 skips blank lines instead of failing on them', () => {
    const { lines } = exported();
    const target = new RotationAuditor();

    expect(target.importJSONL(`${lines[0]!}\n\n  \n`)).toBe(1);
    expect(target.verify().valid).toBe(true);
  });

  it('70.28 names the sequence number it expected', () => {
    const { lines } = exported();
    const first = JSON.parse(lines[0]!) as { seq: number };
    first.seq = 5;
    const target = new RotationAuditor();

    expect(() => target.importJSONL(JSON.stringify(first))).toThrow(
      'audit import rejected at line 1: expected seq 1, got 5',
    );
  });

  it('70.29 names the contradiction in an imported event', () => {
    const { lines } = exported();
    const first = JSON.parse(lines[0]!) as { event: RotationEvent };
    first.event.error = { code: 'x', message: 'y' } as unknown as null;
    const target = new RotationAuditor();

    expect(() => target.importJSONL(JSON.stringify(first))).toThrow(/line 1: event contradicts itself/);
  });

  it('70.30 names the line it rejected for not chaining', () => {
    const { auditor } = exported();
    auditor.record({
      id: 'evt-b',
      policyId: 'policy-a',
      fromVersion: 2,
      toVersion: 3,
      trigger: { kind: 'manual' },
      startedAt: 2_000,
      completedAt: 2_100,
      success: true,
      error: null,
      reEncryptedCount: 0,
      reEncryption: 'not-requested',
      retiredVersion: null,
    });
    const lines = auditor.exportJSONL().split('\n');
    const second = JSON.parse(lines[1]!) as { prevHash: string };
    second.prevHash = 'b'.repeat(64);
    const target = new RotationAuditor();

    expect(() => target.importJSONL(`${lines[0]!}\n${JSON.stringify(second)}`)).toThrow(
      'audit import rejected at line 2: prevHash does not chain onto seq 1',
    );
  });
});

// ── AC 70.31 — the interval is computed from the sorted completions

describe('AC 70 — the average interval does not depend on insertion order', () => {
  it('70.31 averages the extremes of three completions given out of order', () => {
    const auditor = new RotationAuditor();
    const completion = (completedAt: number): RotationEvent => ({
      id: `evt-${completedAt}`,
      policyId: 'policy-a',
      fromVersion: 1,
      toVersion: 2,
      trigger: { kind: 'time', maxAgeMs: 1_000 },
      startedAt: completedAt - 100,
      completedAt,
      success: true,
      error: null,
      reEncryptedCount: 0,
      reEncryption: 'not-requested',
      retiredVersion: null,
    });

    auditor.record(completion(9_000));
    auditor.record(completion(1_000));
    auditor.record(completion(5_000));

    const report = auditor.generateReport('SOC2');

    expect(report.averageIntervalMs).toBe(4_000);
    expect(report.oldestActiveKeyCreatedAt).toBe(1_000);
  });
});
