/**
 * OutboxStore — the windows it runs with, and the ones it refuses.
 *
 * The store is where the retry budget is spent and where the entry TTL is
 * enforced, so it is the last place a containment can be checked before entries
 * start moving. The check is in the constructor and it runs before the data
 * directory exists: a store that would prune an entry mid-budget must not leave
 * an empty LMDB file behind for an operator to wonder about.
 *
 *   OT.1  a retry budget longer than the peer's memory of the message id is refused
 *   OT.2  the refusal happens before the data directory is created
 *   OT.3  an entry TTL shorter than the retry budget is legal, and is not a containment
 *   OT.4  `getRetention()` reports the windows the store actually uses
 *   OT.5  an unspecified window comes from the package defaults, not from a
 *         second set of numbers in the store
 *   OT.6  the derived budget is the one the retry path obeys
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxStore, type OutboxStoreConfig } from './OutboxStore';
import { DEFAULT_RETENTION, RetentionViolation } from './retention';

const MINUTE = 60_000;
const T0 = Date.parse('2026-04-01T00:00:00.000Z');

let root: string;
let store: OutboxStore | undefined;
let clock = T0;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outbox-retention-'));
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

function open(config: Partial<OutboxStoreConfig> = {}): OutboxStore {
  store = new OutboxStore({ dataDir: join(root, 'data'), ...config });
  return store;
}

describe('OutboxStore — retention containment', () => {
  it('OT.1: a retry budget the peer cannot cover is refused', () => {
    expect(() => open({ retryWindowMs: 10 * MINUTE, dedupMs: 5 * MINUTE })).toThrow(RetentionViolation);
  });

  it('OT.2: the refusal happens before the data directory exists', () => {
    const dataDir = join(root, 'never-created');
    expect(() => new OutboxStore({ dataDir, retryWindowMs: 10 * MINUTE, dedupMs: 5 * MINUTE })).toThrow(
      /dedup-covers-retry/,
    );
    expect(existsSync(dataDir)).toBe(false);
  });

  it('OT.3: an entry TTL shorter than the retry budget is a housekeeping cycle, not a loss', () => {
    // `ttlMs` prunes delivered markers and the dead-letter queue; a pending
    // entry is never pruned by it. The combination is legal, and the store runs
    // with both numbers as given.
    const s = open({ retryWindowMs: 10 * MINUTE, ttlMs: 5 * MINUTE, dedupMs: 10 * MINUTE });
    expect(s.getRetention().entryTtlMs).toBe(5 * MINUTE);
    expect(s.getRetention().retryWindowMs).toBe(10 * MINUTE);
  });

  it('OT.4: getRetention() reports the windows the store uses', () => {
    const s = open({
      retryWindowMs: 2 * MINUTE,
      retryBackoffMaxMs: 500,
      deadLetterTtlMs: 3 * MINUTE,
      ttlMs: 4 * MINUTE,
      dedupMs: 6 * MINUTE,
    });
    expect(s.getRetention()).toEqual({
      dedupMs: 6 * MINUTE,
      ackTimeoutMs: 0,
      retryWindowMs: 2 * MINUTE,
      retryBackoffMaxMs: 500,
      deadLetterTtlMs: 3 * MINUTE,
      entryTtlMs: 4 * MINUTE,
      deliveryIndexMs: 4 * MINUTE,
    });
  });

  it('OT.5: unspecified windows are the package defaults', () => {
    const s = open();
    const windows = s.getRetention();
    expect(windows.retryWindowMs).toBe(DEFAULT_RETENTION.retryWindowMs);
    expect(windows.dedupMs).toBe(DEFAULT_RETENTION.dedupMs);
    expect(windows.deadLetterTtlMs).toBe(DEFAULT_RETENTION.deadLetterTtlMs);
    expect(windows.entryTtlMs).toBe(DEFAULT_RETENTION.entryTtlMs);
  });

  it('OT.6: the reported budget is the one markFailed obeys', () => {
    const s = open({ retryWindowMs: 3 * MINUTE, dedupMs: 4 * MINUTE });
    expect(s.getRetention().retryWindowMs).toBe(3 * MINUTE);

    const entry = s.addBatch([
      {
        targetPeerIds: ['peer-b'],
        payload: new Uint8Array([1]),
        timestamp: { wallTime: BigInt(T0), logical: 0, nodeId: 'node-a' } as never,
        type: 'replicate',
      },
    ])[0]!;
    // First failure starts the budget.
    expect(s.markFailed(entry.id, 'boom')).toBe(false);
    // A failure inside the budget keeps the entry pending.
    clock = T0 + 2 * MINUTE;
    expect(s.markFailed(entry.id, 'boom')).toBe(false);
    // Past the budget it is parked.
    clock = T0 + 3 * MINUTE + 1;
    expect(s.markFailed(entry.id, 'boom')).toBe(true);
  });
});
