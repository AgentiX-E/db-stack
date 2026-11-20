/**
 * OutboxStore — the order the queue is in.
 *
 * `fetchOldestPending` documented itself as FIFO and was not: the pending index
 * was keyed `pending:entry:<seq>`, LMDB iterates keys lexicographically, and a
 * backlog of ten or more came back as 1, 10, 11, …, 19, 2, 20. The
 * cross-datacenter acceptance run reported the consequence before this suite
 * existed: the peer applied `0/0000000A` before `0/00000002`.
 *
 *   AC 99.1  twenty-five pending entries come back in the order they were added
 *   AC 99.2  delivering the head leaves the queue contiguous and correctly sized
 *   AC 99.3  an entry moved to the dead letter leaves no pending key behind
 *   AC 99.4  a revived dead-letter entry takes its place at the end of the queue
 *   AC 99.5  `limit` caps the scan without changing the order it returns
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxStore } from './OutboxStore';
import { HLC } from '../hlc/HLC';

const stores: OutboxStore[] = [];
const dirs: string[] = [];

function makeStore(config: Record<string, unknown> = {}): OutboxStore {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-fifo-'));
  dirs.push(dir);
  const store = new OutboxStore({
    dataDir: dir,
    ttlMs: 600_000,
    maxRetries: 3,
    deadLetterTtlMs: 600_000,
    mapSize: 16 * 1024 * 1024,
    ...config,
  } as never);
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()!.close();
    } catch {
      // A store that failed to open has nothing to close.
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let counter = 0;
function entry(store: OutboxStore, label: string) {
  counter += 1;
  return store.add({
    msgId: `msg-${label}`,
    targetPeerIds: ['peer-1'],
    payload: new TextEncoder().encode(JSON.stringify({ label })),
    timestamp: new HLC('fifo').now(),
    type: 'cdc_event',
  });
}

describe('OutboxStore — FIFO order', () => {
  it('AC 99.1: twenty-five pending entries come back in the order they were added', async () => {
    const store = makeStore();
    const added = [];
    for (let i = 0; i < 25; i++) added.push(await entry(store, `e${i}`));

    const fetched = await store.fetchOldestPending(25);
    expect(fetched.map((item) => item.msgId)).toEqual(added.map((item) => item.msgId));

    // The specific failure that was invisible: the eleventh addition must not
    // sort before the second.
    const first = await store.fetchOldestPending(11);
    expect(first[1]!.msgId).toBe('msg-e1');
    expect(first[10]!.msgId).toBe('msg-e10');
  });

  it('AC 99.2: delivering the head leaves the queue contiguous and correctly sized', async () => {
    const store = makeStore();
    const added = [];
    for (let i = 0; i < 12; i++) added.push(await entry(store, `d${i}`));
    expect(await store.getPendingCount()).toBe(12);

    await store.markDelivered(added[0]!.id);
    expect(await store.getPendingCount()).toBe(11);

    const rest = await store.fetchOldestPending(11);
    expect(rest.map((item) => item.msgId)).toEqual(added.slice(1).map((item) => item.msgId));

    // Delivering by message id, which is the name the transport uses.
    await store.markDelivered('msg-d5');
    const remaining = await store.fetchOldestPending(20);
    expect(remaining.map((item) => item.msgId)).not.toContain('msg-d5');
    expect(await store.getPendingCount()).toBe(10);
  });

  it('AC 99.3: an entry moved to the dead letter leaves no pending key behind', async () => {
    const store = makeStore({ maxRetries: 1 });
    const first = await entry(store, 'x0');
    await entry(store, 'x1');

    expect(store.markFailed(first.id, 'the peer refused')).toBe(true);
    expect(await store.getPendingCount()).toBe(1);
    expect(store.getDeadLetterStats().count).toBe(1);

    const pending = await store.fetchOldestPending(10);
    expect(pending.map((item) => item.msgId)).toEqual(['msg-x1']);
  });

  it('AC 99.4: a revived dead-letter entry takes its place at the end of the queue', async () => {
    const store = makeStore({ maxRetries: 1 });
    const first = await entry(store, 'r0');
    await entry(store, 'r1');
    store.markFailed(first.id, 'refused');

    const [dead] = store.getDeadLetterEntries();
    expect(store.retryDeadLetter(dead!.id)).toBe(true);

    const pending = await store.fetchOldestPending(10);
    expect(pending.map((item) => item.msgId)).toEqual(['msg-r1', 'msg-r0']);
  });

  it('AC 99.5: limit caps the scan without changing the order it returns', async () => {
    const store = makeStore();
    for (let i = 0; i < 15; i++) await entry(store, `l${i}`);

    const capped = await store.fetchOldestPending(10, 3);
    expect(capped).toHaveLength(3);
    expect(capped.map((item) => item.msgId)).toEqual(['msg-l0', 'msg-l1', 'msg-l2']);
  });
});
