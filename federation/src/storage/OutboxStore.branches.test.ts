/**
 * OutboxStore — branch-completion tests.
 *
 * Targets methods and decision branches the AC 40.x suite leaves implicit:
 *   - addBatch (empty batch, multi-entry batch, transaction consistency)
 *   - fetchAndFlush (atomic fetch + markDelivered, incl. stale-index branches)
 *   - fetchOldestPending limit scan cap (`limit !== undefined && scanned >= limit`)
 *   - markDelivered fallback O(n) scan (entry present but missing msgId index)
 *   - markFailed fallback scan (missing msgId index)
 *   - getDeadLetterStats
 *   - retryDeadLetter / isDelivered / isCapacityExceeded edge paths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OutboxStore, type OutboxStoreConfig } from './OutboxStore';
import type { OutboxEntryInput } from '../interfaces/outbox/OutboxEntry';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC } from '../hlc/HLC';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function createTestStore(config?: Partial<OutboxStoreConfig>): OutboxStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-branch-'));
  return new OutboxStore({
    dataDir: tmpDir,
    ttlMs: 60_000,
    maxRetries: 3,
    deadLetterTtlMs: 60_000,
    mapSize: 16 * 1024 * 1024,
    ...config,
  });
}

function makeEntry(payload: string, msgId?: string): OutboxEntryInput {
  return {
    msgId,
    targetPeerIds: ['peer-b'],
    payload: new TextEncoder().encode(payload),
    timestamp: new HLC('test-node').now(),
    type: 'test',
  };
}

describe('OutboxStore — addBatch', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-batch-'));
    store = createTestStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns an empty array for an empty batch', () => {
    expect(store.addBatch([])).toEqual([]);
  });

  it('persists a multi-entry batch atomically with assigned IDs', async () => {
    const out = store.addBatch([makeEntry('a'), makeEntry('b'), makeEntry('c')]);
    expect(out).toHaveLength(3);
    expect(out[0]!.id).toMatch(/^entry:\d+$/);
    expect(out.map((e) => new TextDecoder().decode(e.payload))).toEqual(['a', 'b', 'c']);

    expect(await store.getPendingCount()).toBe(3);
  });
});

describe('OutboxStore — fetchAndFlush', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-flush-'));
    store = createTestStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('atomically fetches and flushes pending entries', async () => {
    await store.add(makeEntry('a'));
    await store.add(makeEntry('b'));
    await store.add(makeEntry('c'));

    const flushed = store.fetchAndFlush(2);
    expect(flushed).toHaveLength(2);
    for (const e of flushed) {
      expect(e.status).toBe('delivered');
      expect(store.isDelivered(e.id)).toBe(true);
    }

    // Remaining count
    expect(await store.getPendingCount()).toBe(1);
  });
});

describe('OutboxStore — fetchOldestPending limit scan', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-limit-'));
    store = createTestStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('caps the scan at `limit` even when count is larger', async () => {
    await store.add(makeEntry('a'));
    await store.add(makeEntry('b'));
    await store.add(makeEntry('c'));

    // limit=1 caps the scan; count=10 is never reached
    const out = await store.fetchOldestPending(10, 1);
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe('OutboxStore — markDelivered / markFailed fallback scan', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-fallback-'));
    store = createTestStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('markDelivered falls back to O(n) scan when msgId index is missing', async () => {
    const entry = await store.add(makeEntry('scan-deliver'));
    // Remove the msgId→seq reverse index to force the fallback scan path
    store['msgIdToSeqDb'].removeSync(entry.id);

    await store.markDelivered(entry.id);
    expect(store.isDelivered(entry.id)).toBe(true);
  });

  it('markFailed falls back to O(n) scan when msgId index is missing', async () => {
    const entry = await store.add(makeEntry('scan-fail'));
    store['msgIdToSeqDb'].removeSync(entry.id);

    const result = store.markFailed(entry.id, 'boom');
    expect(result).toBe(false); // attempt 1 < maxRetries, still pending
  });
});

describe('OutboxStore — dead letter stats & edge paths', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-dlstats-'));
    store = createTestStore({ dataDir, maxRetries: 1 });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('getDeadLetterStats reports the DLQ count', async () => {
    expect(store.getDeadLetterStats()).toEqual({ count: 0 });

    const e1 = await store.add(makeEntry('dl-1'));
    const e2 = await store.add(makeEntry('dl-2'));
    store.markFailed(e1.id, 'x'); // maxRetries=1 → moves to DL immediately
    store.markFailed(e2.id, 'x');

    expect(store.getDeadLetterStats()).toEqual({ count: 2 });
  });

  it('isDelivered returns false for unknown entry', () => {
    expect(store.isDelivered('entry:ghost')).toBe(false);
  });
});

describe('OutboxStore — nullish defaults', () => {
  it('has no attempt cap and a one-minute window when the config omits both', () => {
    // The default used to be `maxRetries: 3`, and three attempts on a pump that
    // retries the head once per 20 ms cycle is sixty milliseconds of outage
    // before changes start moving to the dead-letter queue. An acceptance run
    // lost nine changes to exactly that. A count cannot know how much time it
    // represents, so the default is no count at all and a window instead.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-nullish-'));
    const s = new OutboxStore({ dataDir: tmp });
    expect(s['maxRetries']).toBeNull();
    expect(s.getRetention().retryWindowMs).toBe(60_000);
    expect(s['retryBackoffMs']).toBe(50);
    expect(s.getRetention().retryBackoffMaxMs).toBe(2_000);
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('add() assigns createdAt when the entry omits it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-nullish2-'));
    const s = createTestStore({ dataDir: tmp });
    const partial = makeEntry('no-created-at');
    delete partial.createdAt;

    const e = await s.add(partial);
    expect(e.createdAt).toBeGreaterThan(0);
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('addBatch assigns createdAt when a partial omits it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-nullish3-'));
    const s = createTestStore({ dataDir: tmp });
    const partial = makeEntry('batch-no-created-at');
    delete partial.createdAt;

    const out = s.addBatch([partial]);
    expect(out[0]!.createdAt).toBeGreaterThan(0);
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('OutboxStore — markFailed missing main entry + housekeeping dead-letter sweep', () => {
  let store: OutboxStore;
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-hk2-'));
    store = createTestStore({ dataDir, maxRetries: 1, deadLetterTtlMs: 0 });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('markFailed returns false when seq exists but main entry is missing', async () => {
    const e = await store.add(makeEntry('will-vanish'));
    // Corrupt: remove main entry but keep msgId→seq index
    store['mainDb'].removeSync(e.id);
    // msgIdToSeqDb still has e.id → seq lookup succeeds, main get() returns undefined
    expect(store.markFailed(e.id, 'x')).toBe(false);
  });

  it('housekeeping sweeps dead-letter entries past deadLetterTtlMs', async () => {
    const e = await store.add(makeEntry('dl-expire'));
    store.markFailed(e.id, 'x'); // → dead letter (maxRetries=1)

    expect(store.getDeadLetterEntries()).toHaveLength(1);

    // deadLetterTtlMs=0 → dlCutoff = now, so a deadAt strictly in the past is
    // swept. Rewrite the stored dead letter entry with an explicitly older
    // timestamp: relying on wall-clock movement between markFailed() and
    // housekeeping() made this pass only on slow storage.
    const deadKey = `dlq:${e.id}`;
    const dead = store['deadLetterDb'].get(deadKey);
    expect(dead).toBeDefined();
    store['deadLetterDb'].putSync(deadKey, {
      ...dead!,
      deadAt: Date.now() - 10_000,
    });

    store.housekeeping();
    expect(store.getDeadLetterEntries()).toHaveLength(0);
  });
});

describe('OutboxStore — isCapacityExceeded', () => {
  let store: OutboxStore;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cap-'));
    store = createTestStore({ dataDir, mapSize: 16 * 1024 * 1024 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Replace the environment's stats (the object the store actually reads) for
   * one assertion, or make the read throw.
   */
  function stubRootStats(stats: Record<string, number> | 'throw'): void {
    const original = store['root'].getStats;
    const stub =
      stats === 'throw'
        ? () => {
            throw new Error('stats unavailable');
          }
        : () => stats;
    store['root'].getStats = stub as unknown as typeof original;
  }

  it('reports capacity exceeded once 80% of the map is in use', () => {
    stubRootStats({ pageSize: 1000, lastPageNumber: 900, mapSize: 1_000_000 });

    expect(store.isCapacityExceeded()).toBe(true);
  });

  it('returns false when getStats throws (defensive catch)', () => {
    stubRootStats('throw');

    expect(store.isCapacityExceeded()).toBe(false);
  });

  it('guards against incomplete getStats shaping (pageSize/lastPageNumber/mapSize fallbacks)', () => {
    // A partial stats object must not turn into NaN: the 4096 / 0 / configured
    // map-size fallbacks keep the utilisation calculation at zero.
    stubRootStats({});

    expect(store.isCapacityExceeded()).toBe(false);
  });

  it('uses the configured map size when the environment does not report one', () => {
    stubRootStats({ pageSize: 1024, lastPageNumber: 14_000 });

    // 14_000 * 1024 = 14.3 MB of the configured 16 MB map → 85% → exceeded.
    expect(store.isCapacityExceeded()).toBe(true);
  });
});

describe('OutboxStore — dead letter and the msgId reverse index', () => {
  let store: OutboxStore;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-dlmsgid-'));
    store = createTestStore({ dataDir, maxRetries: 1 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('drops the msgId index on dead-lettering and reindexes the revived entry', async () => {
    const msgId = 'msg-needs-ack';
    const entry = await store.add(makeEntry('dead-lettered', msgId));

    // maxRetries=1: the first failure moves the entry out of the queue.
    expect(store.markFailed(msgId, 'peer unreachable')).toBe(true);

    const dead = store.getDeadLetterEntries();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(entry.id);
    expect(dead[0]!.msgId).toBe(msgId);
    expect(dead[0]!.status).toBe('failed');
    expect(dead[0]!.lastError).toBe('peer unreachable');

    // The message id no longer resolves to a live entry.
    expect(store.markFailed(msgId)).toBe(false);

    expect(store.retryDeadLetter(entry.id)).toBe(true);
    const [revived] = await store.fetchOldestPending(1);
    expect(revived!.id).not.toBe(entry.id);
    expect(revived!.msgId).toBe(msgId);
    expect(revived!.attemptCount).toBe(0);

    // An ACK by message id still finds the revived entry.
    await store.markDelivered(msgId);
    expect(store.isDelivered(msgId)).toBe(true);
    expect(await store.getPendingCount()).toBe(0);
  });
});

describe('OutboxStore — _markFailed attemptCount nullish', () => {
  it('increments attemptCount from 0 when the field is absent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-attempt-'));
    const s = createTestStore({ dataDir: tmp, maxRetries: 3 });
    const e = await s.add(makeEntry('no-attempt'));
    const seq = s['msgIdToSeqDb'].get(e.id);
    expect(seq).toBeDefined();

    // Null out attemptCount to exercise `?? 0`. The record was written by an
    // older build that did not persist the field.
    const stored = s['mainDb'].get(`entry:${seq}`);
    expect(stored).toBeDefined();
    s['mainDb'].putSync(`entry:${seq}`, Object.assign(stored!, { attemptCount: undefined }));

    const result = s.markFailed(e.id, 'x');
    expect(result).toBe(false); // attempt 1 < maxRetries
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
