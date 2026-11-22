/**
 * OutboxStore — the retry budget is time, not attempts.
 *
 * The store used to dead-letter an entry after `maxRetries` failures, default 3.
 * The pipeline retries the head of the queue once per pump cycle, and the default
 * cycle is 20 ms, so the default budget was sixty milliseconds: an acceptance run
 * held a peer down for a second and came back to nine changes in the dead-letter
 * queue. A count does not know how much time it represents — fifty attempts at a
 * 500 ms interval is half a minute, fifty at 20 ms is a second — so the budget is
 * now a window measured from the first failure, and the retries inside it back
 * off instead of hammering.
 *
 *   RB.1   a failure inside the window keeps the entry pending and schedules the retry
 *   RB.2   the window is measured from the first failure, not from creation
 *   RB.3   failures that span the window dead-letter the entry, with its reason
 *   RB.4   an explicit `maxRetries` is still a hard cap
 *   RB.5   the backoff doubles from `retryBackoffMs` up to `retryBackoffMaxMs`
 *   RB.6   `retryBackoffMs: 0` retries on the next tick
 *   RB.7   `retryWindowMs: 0` dead-letters on the first failure
 *   RB.8   a revived entry gets a fresh budget
 *   RB.9   a revived entry that fails once is not dead-lettered again at once
 *   RB.10  a delivered entry never grows a retry schedule
 *   RB.11  an entry written before the field existed is budgeted from its next failure
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxStore, type OutboxStoreConfig } from './OutboxStore';
import type { OutboxEntry, OutboxEntryInput } from '../interfaces/outbox/OutboxEntry';
import { makeHLC } from '../hlc/HLC';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');

let dir: string;
let store: OutboxStore | undefined;
let clock = T0;

/** Move the store's clock, which is the wall clock and therefore `Date.now`. */
function at(offsetMs: number): void {
  clock = T0 + offsetMs;
}

afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-retry-'));
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

function open(config: Partial<OutboxStoreConfig> = {}): OutboxStore {
  store = new OutboxStore({ dataDir: dir, ...config });
  return store;
}

function entry(msgId: string): OutboxEntryInput {
  return {
    msgId,
    targetPeerIds: ['dc-b'],
    payload: new TextEncoder().encode('{}'),
    timestamp: makeHLC(1n, 0, 'n1'),
    type: 'cdc_event',
  };
}

/** The stored record, as the pump would read it back. */
function stored(id: string): OutboxEntry {
  return store!['mainDb'].get(id) as OutboxEntry;
}

describe('OutboxStore — the retry budget', () => {
  it('RB.1: a failure inside the window keeps the entry pending and schedules its retry', async () => {
    const s = open({ retryWindowMs: 60_000 });
    const added = await s.add(entry('0/1:1'));

    at(10);
    expect(s.markFailed(added.id, 'connection refused')).toBe(false);

    const record = stored(added.id);
    expect(record.status).toBe('pending');
    expect(record.attemptCount).toBe(1);
    expect(record.lastError).toBe('connection refused');
    expect(record.firstFailedAt, 'the window is anchored at the first failure').toBe(T0 + 10);
    // 50 ms after the first failure, growing from there.
    expect(record.nextAttemptAt).toBe(T0 + 10 + 50);
    expect(await s.getPendingCount()).toBe(1);
    expect(s.getDeadLetterStats().count).toBe(0);
  });

  it('RB.2: the window is measured from the first failure, not from creation', async () => {
    // An entry that waited a minute behind a busy peer has not spent that minute
    // failing. Anchoring the window at `createdAt` would dead-letter a change on
    // its very first refused send after a backlog.
    const s = open({ retryWindowMs: 60_000 });
    const added = await s.add(entry('0/2:1'));

    at(120_000);
    expect(s.markFailed(added.id, 'peer away')).toBe(false);
    expect(s.getDeadLetterStats().count).toBe(0);
    expect(stored(added.id).firstFailedAt).toBe(T0 + 120_000);
  });

  it('RB.3: failures that span the window dead-letter the entry, with its reason', async () => {
    const s = open({ retryWindowMs: 1_000 });
    const added = await s.add(entry('0/3:1'));

    at(0);
    expect(s.markFailed(added.id, 'first refusal')).toBe(false);
    at(999);
    expect(s.markFailed(added.id, 'still away')).toBe(false);

    at(1_000);
    expect(s.markFailed(added.id, 'gave up')).toBe(true);

    const dead = s.getDeadLetterEntries();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(added.id);
    expect(dead[0]!.lastError).toBe('gave up');
    expect(dead[0]!.attemptCount).toBe(3);
    expect(dead[0]!.deadAt).toBe(T0 + 1_000);
    expect(await s.getPendingCount()).toBe(0);
  });

  it('RB.4: an explicit maxRetries is still a hard cap', async () => {
    // A caller who wants three strikes on a fast link can still ask for them. The
    // default stopped being a count, not the option.
    const s = open({ maxRetries: 3, retryWindowMs: 60_000 });
    const added = await s.add(entry('0/4:1'));

    expect(s.markFailed(added.id, 'a')).toBe(false);
    expect(s.markFailed(added.id, 'b')).toBe(false);
    expect(s.markFailed(added.id, 'c')).toBe(true);
    expect(s.getDeadLetterStats().count).toBe(1);
  });

  it('RB.5: the backoff doubles from retryBackoffMs up to retryBackoffMaxMs', async () => {
    const s = open({ retryBackoffMs: 50, retryBackoffMaxMs: 200, retryWindowMs: 60_000 });
    const added = await s.add(entry('0/5:1'));

    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      at(attempt * 1_000);
      s.markFailed(added.id, `attempt ${attempt}`);
      const scheduled = stored(added.id).nextAttemptAt!;
      waits.push(scheduled - (T0 + attempt * 1_000));
    }

    // 50, 100, 200, then the ceiling.
    expect(waits).toEqual([50, 100, 200, 200, 200]);
  });

  it('RB.6: retryBackoffMs 0 retries on the next tick', async () => {
    const s = open({ retryBackoffMs: 0 });
    const added = await s.add(entry('0/6:1'));

    at(5);
    s.markFailed(added.id, 'x');
    expect(stored(added.id).nextAttemptAt).toBe(T0 + 5);
  });

  it('RB.7: retryWindowMs 0 dead-letters on the first failure', async () => {
    const s = open({ retryWindowMs: 0 });
    const added = await s.add(entry('0/7:1'));
    expect(s.markFailed(added.id, 'no budget at all')).toBe(true);
    expect(s.getDeadLetterStats().count).toBe(1);
  });

  it('RB.8: a revived entry gets a fresh budget', async () => {
    const s = open({ retryWindowMs: 1_000 });
    const added = await s.add(entry('0/8:1'));
    s.markFailed(added.id, 'a');
    at(2_000);
    s.markFailed(added.id, 'b');
    expect(s.getDeadLetterStats().count).toBe(1);

    const dead = s.getDeadLetterEntries()[0]!;
    expect(s.retryDeadLetter(dead.id)).toBe(true);

    const revived = stored(`entry:${Number(dead.id.slice('entry:'.length)) + 1}`);
    expect(revived.firstFailedAt).toBeNull();
    expect(revived.nextAttemptAt).toBeNull();
    expect(revived.attemptCount).toBe(0);
  });

  it('RB.9: a revived entry that fails once is not dead-lettered again at once', async () => {
    // Carrying `firstFailedAt` across the revival would spend the whole window on
    // the revived entry's first failure, so the one recovery path an operator has
    // would immediately undo itself.
    const s = open({ retryWindowMs: 1_000 });
    const added = await s.add(entry('0/9:1'));
    s.markFailed(added.id, 'a');
    at(5_000);
    s.markFailed(added.id, 'b');

    const dead = s.getDeadLetterEntries()[0]!;
    s.retryDeadLetter(dead.id);

    at(5_100);
    expect(s.markFailed(dead.id, 'still away')).toBe(false);
    expect(s.getDeadLetterStats().count).toBe(0);
  });

  it('RB.10: a delivered entry never grows a retry schedule', async () => {
    const s = open();
    const added = await s.add(entry('0/10:1'));
    await s.markDelivered(added.id);

    expect(stored(added.id).nextAttemptAt).toBeNull();
    expect(stored(added.id).firstFailedAt).toBeNull();
  });

  it('RB.11: an entry written before the fields existed is budgeted from its next failure', async () => {
    // The store has entries on disk from before this iteration. Reading one back
    // must not produce `now - undefined`.
    const s = open({ retryWindowMs: 1_000 });
    const added = await s.add(entry('0/11:1'));
    s['mainDb'].putSync(
      added.id,
      Object.assign(stored(added.id), {
        firstFailedAt: undefined,
        nextAttemptAt: undefined,
      }),
    );

    at(3_000);
    expect(s.markFailed(added.id, 'first failure after the upgrade')).toBe(false);
    expect(stored(added.id).firstFailedAt).toBe(T0 + 3_000);
  });
});
