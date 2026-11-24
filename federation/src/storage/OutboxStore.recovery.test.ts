/**
 * OutboxStore — recovery from the dead letter queue.
 *
 * The dead letter queue is where an entry goes when its retry budget is spent.
 * It used to be a graveyard: `retryDeadLetter(id)` revived one entry and had no
 * production caller, `housekeeping()` deleted dead letters and was also called
 * only from tests, and nothing in the package ever asked the store how much
 * each target still owed. `retryFailed()` on the replication engine returned a
 * hard `0` with a comment promising a future iteration would iterate the queue.
 *
 * These tests pin the three properties that make the queue recoverable: a bulk
 * revive that reports a count, a retry window that can be disabled, and a
 * per-target backlog that includes the age of the oldest entry — which is the
 * only honest way to measure replication lag.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutboxStore, type OutboxStoreConfig } from './OutboxStore';
import type { OutboxEntryInput } from '../interfaces/outbox/OutboxEntry';
import { HLC } from '../hlc/HLC';

const dirs: string[] = [];
const stores: OutboxStore[] = [];

function makeStore(config: Partial<OutboxStoreConfig> = {}): OutboxStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-recovery-'));
  dirs.push(dataDir);
  const store = new OutboxStore({ dataDir, mapSize: 8 * 1024 * 1024, ...config });
  stores.push(store);
  return store;
}

/** A real HLC timestamp — the store serialises it, so a literal will not do. */
function makeHlc(): OutboxEntryInput['timestamp'] {
  return new HLC('n1').now();
}

function input(targets: string[], createdAt?: number): OutboxEntryInput {
  return {
    msgId: `msg-${Math.random().toString(36).slice(2)}`,
    targetPeerIds: targets,
    payload: new TextEncoder().encode('{}'),
    timestamp: makeHlc(),
    type: 'replicate',
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('OutboxStore — a dead letter is a queue entry, not a tombstone', () => {
  it('revives every dead letter and reports how many', async () => {
    const store = makeStore({ retryWindowMs: 0 });
    for (let i = 0; i < 3; i++) store.markFailed((await store.add(input(['peer-b']))).id, 'link down');

    expect(store.getDeadLetterStats().count).toBe(3);
    expect(await store.getPendingCount()).toBe(0);

    expect(store.retryDeadLetters()).toBe(3);

    expect(store.getDeadLetterStats().count).toBe(0);
    expect(await store.getPendingCount()).toBe(3);
  });

  it('gives a revived entry a fresh budget, or the revive is useless', async () => {
    const store = makeStore({ retryWindowMs: 0 });
    const dead = await store.add(input(['peer-b']));
    store.markFailed(dead.id, 'link down');

    store.retryDeadLetters();
    const revived = (await store.fetchOldestPending(1))[0]!;

    expect(revived.attemptCount).toBe(0);
    expect(revived.firstFailedAt).toBeNull();
    expect(revived.lastError).toBeNull();
    expect(revived.status).toBe('pending');
  });

  it('revives only the named target when given one', async () => {
    const store = makeStore({ retryWindowMs: 0 });
    store.markFailed((await store.add(input(['peer-a']))).id, 'a down');
    store.markFailed((await store.add(input(['peer-b']))).id, 'b down');

    expect(store.retryDeadLetters('peer-b')).toBe(1);

    const pending = await store.fetchOldestPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.targetPeerIds).toEqual(['peer-b']);
  });

  it('returns 0 when nothing is dead, rather than throwing', async () => {
    const store = makeStore();
    await store.add(input(['peer-b']));
    expect(store.retryDeadLetters()).toBe(0);
    expect(store.retryDeadLetters('peer-z')).toBe(0);
  });
});

describe('OutboxStore — the retry window can be disabled', () => {
  it('Infinity never dead-letters, however long the failure lasts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = makeStore({ retryWindowMs: Infinity, dedupMs: Infinity });
    const entry = await store.add(input(['peer-b']));

    store.markFailed(entry.id, 'link down');
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z')); // a day later
    expect(store.markFailed(entry.id, 'link down')).toBe(false);

    expect(store.getDeadLetterStats().count).toBe(0);
    expect(await store.getPendingCount()).toBe(1);
  });

  it('a finite window still dead-letters, so the test above is not vacuous', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = makeStore({ retryWindowMs: 60_000 });
    const entry = await store.add(input(['peer-b']));

    store.markFailed(entry.id, 'link down');
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z')); // past the window
    expect(store.markFailed(entry.id, 'link down')).toBe(true);
    expect(store.getDeadLetterStats().count).toBe(1);
  });
});

describe('OutboxStore — per-target backlog carries the age of its oldest entry', () => {
  it('reports count and oldest creation time per target', async () => {
    const store = makeStore();
    await store.add(input(['peer-b'], 1_000));
    await store.add(input(['peer-b'], 2_000));
    await store.add(input(['peer-c'], 3_000));
    await store.add(input(['peer-b', 'peer-c'], 500));

    const stats = store.getPendingStats();

    expect(stats['peer-b']).toEqual({ count: 3, oldestCreatedAt: 500 });
    expect(stats['peer-c']).toEqual({ count: 2, oldestCreatedAt: 500 });
  });

  it('reports nothing for a store with an empty queue', () => {
    expect(makeStore().getPendingStats()).toEqual({});
  });

  it('an entry that was delivered stops being owed', async () => {
    const store = makeStore();
    const entry = await store.add(input(['peer-b']));
    await store.markDelivered(entry.id);
    expect(store.getPendingStats()).toEqual({});
  });
});

describe('OutboxStore — housekeeping reports what it removed', () => {
  it('returns the counts it deleted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = makeStore({ ttlMs: 1_000, deadLetterTtlMs: 1_000, retryWindowMs: 0 });

    const delivered = await store.add(input(['peer-b']));
    await store.markDelivered(delivered.id);
    const dead = await store.add(input(['peer-b']));
    store.markFailed(dead.id, 'link down');

    vi.setSystemTime(new Date('2026-01-01T00:10:00Z'));
    expect(store.housekeeping()).toEqual({ delivered: 1, deadLettered: 1 });
    expect(store.housekeeping()).toEqual({ delivered: 0, deadLettered: 0 });
  });
});
