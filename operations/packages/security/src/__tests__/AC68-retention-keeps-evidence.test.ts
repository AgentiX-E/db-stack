/**
 * I30 — AC 68: retention an auditor can still trust.
 *
 * The audit trail has two jobs that pull in opposite directions: keep the window
 * bounded, and be able to prove nobody touched it. Until this suite existed only
 * the first job was real — retention deleted a *prefix* of a hash chain, so the
 * very act of applying a retention policy made `verifyIntegrity()` report
 * `seq gap at index 0` and `chain broken`, i.e. the manager accused itself of
 * tampering the first time it wrote a second page. An operator reading that
 * result has no way to tell "we pruned" from "someone deleted evidence".
 *
 * The cases below pin the resolution: a removal is *recorded* (`truncated`), the
 * retained chain starts from the hash of the newest removed event, and a hole
 * punched behind the manager's back is still a hole. They also pin the parts of
 * the retention policy that were configuration and nothing else — `maxAgeMs` was
 * stored, defaulted, asserted and read by no branch — and the aliasing bug that
 * let a caller change history after the fact by holding on to its own draft.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLogManager } from '../impl/AuditLogManager.js';
import type { AuditEvent, AuditRetentionPolicy } from '../interfaces/IAuditLogger.js';

// ── Fixtures ───────────────────────────────────────────────

type Draft = Omit<AuditEvent, 'id' | 'seq' | 'timestamp' | 'hash' | 'prevHash'>;

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    category: 'data_access',
    severity: 'info',
    action: 'SELECT',
    message: 'Query executed',
    actor: { id: 'user-1', ip: '127.0.0.1' },
    resource: { type: 'table', id: 'users' },
    success: true,
    ...overrides,
  };
}

let tmpDir = '';
let seq = 0;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac68-retention-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const open: AuditLogManager[] = [];

interface Harness {
  manager: AuditLogManager;
  file: string;
}

function make(options: { retention?: AuditRetentionPolicy; autoStart?: boolean } = {}): Harness {
  seq += 1;
  const file = path.join(tmpDir, `audit-${seq}.jsonl`);
  const manager = new AuditLogManager({ logFilePath: file, autoStart: false, ...options });
  open.push(manager);
  return { manager, file };
}

afterEach(() => {
  for (const manager of open.splice(0)) manager.destroy();
  vi.useRealTimers();
});

/**
 * Retention is a decision about the private event log, and the only way to give
 * a managed event an age is to set one. This is the single reflection edge in
 * the file; renaming the field fails here loudly instead of verifying nothing.
 */
function eventsOf(manager: AuditLogManager): AuditEvent[] {
  return Reflect.get(manager, 'events') as AuditEvent[];
}

/**
 * Retention is a decision about time, so the clock is the fixture.
 *
 * The timestamps cannot simply be written onto stored events: `timestamp` is part
 * of the hash, so editing it would break the very chain the case is about. The
 * clock is moved instead, which means every event carries a timestamp the manager
 * itself assigned and every hash stays valid.
 */
const CLOCK_BASE = 1_700_000_000_000;

function startClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK_BASE));
}

function setClock(offsetMs: number): void {
  vi.setSystemTime(new Date(CLOCK_BASE + offsetMs));
}

async function logMany(manager: AuditLogManager, count: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(await manager.log(draft({ action: `EVENT_${i}`, message: `event ${i}` })));
  }
  return events;
}

/**
 * Log one event per offset, each written at that offset from the base clock, and
 * leave the clock at the base — so `prune(n)` inside the case means "n ms before
 * the moment these events were written against".
 */
async function logAged(manager: AuditLogManager, offsetsMs: number[]): Promise<AuditEvent[]> {
  startClock();
  const events: AuditEvent[] = [];
  for (let i = 0; i < offsetsMs.length; i += 1) {
    setClock(offsetsMs[i]!);
    events.push(await manager.log(draft({ action: `EVENT_${i}`, message: `event ${i}` })));
  }
  setClock(0);
  return events;
}

async function seqsOf(manager: AuditLogManager): Promise<number[]> {
  const events = await manager.query({ sortBy: 'seq' });
  return events.map((event) => event.seq);
}

// ── AC 68.1 — an untouched chain is whole ──────────────────

describe('AC 68 — a chain that has never been pruned reports no truncation', () => {
  it('68.1 verifies a fresh chain with truncated === null', async () => {
    const { manager } = make();
    await logMany(manager, 3);

    const result = await manager.verifyIntegrity();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.truncated).toBeNull();
  });
});

// ── AC 68.2–68.4 — retention records what it removes ───────

describe('AC 68 — a pruned chain stays verifiable and says what it lost', () => {
  it('68.2 reports the removal instead of reporting tampering', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    const events = await logAged(manager, [-5_000, -4_000, -3_000, -2_000, -1_000]);

    const removed = await manager.prune(3_500);

    expect(removed).toBe(2);
    const result = await manager.verifyIntegrity();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.truncated).toEqual({
      removedEvents: 2,
      lastRemovedSeq: 2,
      lastRemovedHash: events[1]!.hash,
      at: expect.any(Number) as number,
    });
  });

  it('68.3 continues the retained chain from the hash of the newest removed event', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    const events = await logAged(manager, [-5_000, -4_000, -3_000, -2_000, -1_000]);
    await manager.prune(3_500);

    const remaining = await manager.query({ sortBy: 'seq' });

    expect(remaining.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(remaining[0]!.prevHash).toBe(events[1]!.hash);
  });

  it('68.4 accumulates across removals and reports the newest removed event', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    const events = await logAged(manager, [-5_000, -4_000, -3_000, -2_000, -1_000]);

    expect(await manager.prune(4_500)).toBe(1);
    // The second window reaches two further events: -4000 and -3000 are both
    // older than 2500 ms before the clock the trail was written against.
    expect(await manager.prune(2_500)).toBe(2);

    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.truncated).toMatchObject({ removedEvents: 3, lastRemovedSeq: 3 });
    expect(result.truncated!.lastRemovedHash).toBe(events[2]!.hash);
    expect(await seqsOf(manager)).toEqual([4, 5]);
  });

  it('68.5 anchors the ceiling applied by flush, not just explicit pruning', async () => {
    const { manager } = make({ retention: { maxEvents: 3, minRetain: 0 } });
    await logMany(manager, 5);

    await manager.flush();

    expect(manager.eventCount).toBe(3);
    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.truncated).toMatchObject({ removedEvents: 2, lastRemovedSeq: 2 });
    expect(await seqsOf(manager)).toEqual([3, 4, 5]);
  });
});

// ── AC 68.6–68.8 — maxAgeMs is a rule, not a field ─────────

describe('AC 68 — the age limit in the retention policy actually prunes', () => {
  it('68.6 removes events older than maxAgeMs when the buffer is flushed', async () => {
    const { manager } = make({ retention: { maxAgeMs: 5_000, minRetain: 0 } });
    await logAged(manager, [-9_000, -6_000, 0]);

    await manager.flush();

    expect(manager.eventCount).toBe(1);
    expect(await seqsOf(manager)).toEqual([3]);
    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.truncated).toMatchObject({ removedEvents: 2, lastRemovedSeq: 2 });
  });

  it('68.7 treats maxAgeMs of zero as no age limit', async () => {
    const { manager } = make({ retention: { maxAgeMs: 0, minRetain: 0 } });
    await logAged(manager, [-9_000, -6_000, -3_000]);

    await manager.flush();

    expect(manager.eventCount).toBe(3);
    expect((await manager.verifyIntegrity()).truncated).toBeNull();
  });

  it('68.8 keeps minRetain events even when every event is ancient', async () => {
    const { manager } = make({ retention: { maxAgeMs: 1, minRetain: 2 } });
    await logAged(manager, [-4_000, -3_000, -2_000, -1_000]);

    await manager.flush();

    expect(manager.eventCount).toBe(2);
    expect(await seqsOf(manager)).toEqual([3, 4]);
    expect((await manager.verifyIntegrity()).valid).toBe(true);
  });
});

// ── AC 68.9–68.11 — retention removes a prefix, never a hole

describe('AC 68 — retention never removes an event it cannot chain past', () => {
  it('68.9 stops at the first event that is not older than the cutoff', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    // Event 2 sits inside the window although event 1 is older than the cutoff:
    // removing "every eligible event" would punch a hole between 1 and 3.
    await logAged(manager, [-5_000, 0, -4_000, -3_000]);

    const removed = await manager.prune(4_500);

    expect(removed).toBe(1);
    expect(await seqsOf(manager)).toEqual([2, 3, 4]);
    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.truncated).toMatchObject({ removedEvents: 1, lastRemovedSeq: 1 });
  });

  it('68.10 removes nothing when the newest event is the only one out of the window', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    await logAged(manager, [0, -9_000, -8_000]);

    expect(await manager.prune(1_000)).toBe(0);
    expect(await seqsOf(manager)).toEqual([1, 2, 3]);
    expect((await manager.verifyIntegrity()).truncated).toBeNull();
  });

  it('68.11 still reports a hole punched behind the manager’s back after a prune', async () => {
    const { manager } = make({ retention: { minRetain: 0 } });
    await logAged(manager, [-4_000, -3_000, -2_000, -1_000]);
    await manager.prune(3_500);

    eventsOf(manager).shift();

    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('seq gap at index 0'))).toBe(true);
  });
});

// ── AC 68.12 — evidence on disk is not rewritten ───────────

describe('AC 68 — retention is a memory window, never a rewrite of the file', () => {
  it('68.12 keeps every flushed event in the file while the window shrinks', async () => {
    const { manager, file } = make({ retention: { maxEvents: 2, minRetain: 0 } });
    await logMany(manager, 4);
    await manager.flush();
    await logMany(manager, 2);
    await manager.flush();

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(manager.eventCount).toBe(2);
  });
});

// ── AC 68.13–68.14 — the record owns its own content ───────

describe('AC 68 — a caller cannot change history by holding its draft', () => {
  it('68.13 leaves the stored event untouched when the draft is mutated afterwards', async () => {
    const { manager } = make();
    const partial = draft({ action: 'ORIGINAL', actor: { id: 'original-user' } });

    await manager.log(partial);

    partial.action = 'REWRITTEN';
    partial.actor.id = 'attacker';

    const result = await manager.verifyIntegrity();
    expect(result.valid).toBe(true);
    const [stored] = await manager.query({});
    expect(stored!.action).toBe('ORIGINAL');
    expect(stored!.actor.id).toBe('original-user');
  });

  it('68.14 chains a batch in call order and returns the events it stored', async () => {
    const { manager } = make();

    const returned = await manager.logBatch([
      draft({ action: 'FIRST' }),
      draft({ action: 'SECOND' }),
      draft({ action: 'THIRD' }),
    ]);
    const stored = await manager.query({ sortBy: 'seq' });

    expect(returned.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stored).toEqual(returned);
    expect(stored[1]!.prevHash).toBe(stored[0]!.hash);
    expect((await manager.verifyIntegrity()).valid).toBe(true);
  });
});

// ── AC 68.15 — negative pagination is not "everything" ─────

describe('AC 68 — pagination arguments that cannot mean what they say', () => {
  it('68.15 reads a negative limit as no results and a negative offset as zero', async () => {
    const { manager } = make();
    await logMany(manager, 3);

    expect(await manager.query({ limit: -1 })).toEqual([]);
    expect(await manager.query({ limit: 0 })).toEqual([]);
    const fromZero = await manager.query({ offset: -2, limit: 2 });
    expect(fromZero.map((event) => event.seq)).toEqual([1, 2]);
  });
});

// ── AC 68.16–68.17 — the timer does not hold the process ───

describe('AC 68 — lifecycle of the auto-flush timer', () => {
  it('68.16 flushes what is buffered when destroyed', async () => {
    const { manager, file } = make();
    await logMany(manager, 2);

    manager.destroy();

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('68.17 arms the interval without keeping the process alive', () => {
    const { manager } = make({ autoStart: true });

    const timer = Reflect.get(manager, 'flushTimer') as { hasRef: () => boolean } | null;

    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
  });

  it('68.18 arms the interval at most once no matter how often it starts', async () => {
    vi.useFakeTimers();
    try {
      const { manager, file } = make({ autoStart: true });
      const armed = Reflect.get(manager, 'flushTimer') as object;
      const startAutoFlush = Reflect.get(manager, '_startAutoFlush') as () => void;
      startAutoFlush.call(manager);
      // Still the same interval: a second arm would replace the reference and leave
      // the first one running with nothing pointing at it.
      expect(Reflect.get(manager, 'flushTimer')).toBe(armed);
      await manager.log(draft({ action: 'ONCE' }));

      await vi.advanceTimersByTimeAsync(10_000);

      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).action).toBe('ONCE');
    } finally {
      vi.useRealTimers();
    }
  });
});
