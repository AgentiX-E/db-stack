/**
 * Idempotent write coordinator — a retry of the same msgId returns the first
 * attempt's result instead of becoming a second write.
 *
 * The defect this pins: msgId was carried through the log and deduplicated at
 * the receiver as "drop the duplicate", but the client retry got no answer at
 * all — and an in-flight retry could execute twice before the first committed.
 * The window comes from P3-83's derivation (`deriveRetention().dedupMs`), injected
 * as a number so this package never imports federation. Everything here is
 * engine-agnostic: the caller supplies the write as a callback.
 *
 * TDD: every assertion is written before the implementation exists.
 */

import { describe, it, expect, vi } from 'vitest';
import { IdempotencyTable, IdempotentWriteCoordinator, type IdempotencyRecord } from './Idempotency';

describe('IdempotencyTable — bounded, expiring result memory', () => {
  it('returns undefined for an unseen id', () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    expect(table.get('m1')).toBeUndefined();
  });

  it('stores and retrieves a completed result', () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    table.put('m1', 'result-A', 1);
    expect(table.get('m1')).toEqual({ msgId: 'm1', result: 'result-A', position: 1, recordedAt: 0 });
  });

  it('reports has() without extending the window', () => {
    const table = new IdempotencyTable<string>({ windowMs: 100, now: () => 0 });
    table.put('m1', 'a', 1);
    expect(table.has('m1')).toBe(true);
    expect(table.has('missing')).toBe(false);
  });

  it('expires an entry once the window has elapsed', () => {
    let now = 0;
    const table = new IdempotencyTable<string>({ windowMs: 100, now: () => now });
    table.put('m1', 'a', 1);
    now = 99;
    expect(table.get('m1')?.result).toBe('a');
    now = 100;
    expect(table.get('m1')).toBeUndefined();
  });

  it('removes an expired entry so size reflects live memory', () => {
    let now = 0;
    const table = new IdempotencyTable<string>({ windowMs: 100, now: () => now });
    table.put('m1', 'a', 1);
    expect(table.size).toBe(1);
    now = 100;
    table.get('m1');
    expect(table.size).toBe(0);
  });

  it('treats Infinity as an unbounded window', () => {
    let now = 0;
    const table = new IdempotencyTable<string>({ windowMs: Number.POSITIVE_INFINITY, now: () => now });
    table.put('m1', 'a', 1);
    now = Number.MAX_SAFE_INTEGER;
    expect(table.get('m1')?.result).toBe('a');
  });

  it('treats a zero window as immediately expired', () => {
    const table = new IdempotencyTable<string>({ windowMs: 0, now: () => 5 });
    table.put('m1', 'a', 1);
    expect(table.get('m1')).toBeUndefined();
  });

  it('evicts the oldest entry at capacity (FIFO) and reports it', () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, maxEntries: 2, now: () => 0 });
    table.put('a', '1', 1);
    table.put('b', '2', 2);
    table.put('c', '3', 3);
    expect(table.has('a')).toBe(false);
    expect(table.get('b')?.result).toBe('2');
    expect(table.get('c')?.result).toBe('3');
    expect(table.stats().evicted).toBe(1);
  });

  it('overwriting a live id refreshes its recordedAt and result', () => {
    let now = 0;
    const table = new IdempotencyTable<string>({ windowMs: 100, now: () => now });
    table.put('m1', 'old', 1);
    now = 50;
    table.put('m1', 'new', 2);
    now = 120;
    expect(table.get('m1')?.result).toBe('new');
  });

  it('delete removes an id and is a no-op when absent', () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    table.put('m1', 'a', 1);
    expect(table.delete('m1')).toBe(true);
    expect(table.delete('m1')).toBe(false);
    expect(table.get('m1')).toBeUndefined();
  });

  it('sweep removes all expired entries at once', () => {
    let now = 0;
    const table = new IdempotencyTable<string>({ windowMs: 10, now: () => now });
    table.put('a', '1', 1);
    table.put('b', '2', 2);
    now = 10;
    const removed = table.sweep();
    expect(removed).toBe(2);
    expect(table.size).toBe(0);
  });

  it('refuses a negative window, a NaN window, or a bad capacity', () => {
    expect(() => new IdempotencyTable({ windowMs: -1, now: () => 0 })).toThrow(/windowMs/);
    expect(() => new IdempotencyTable({ windowMs: Number.NaN, now: () => 0 })).toThrow(/windowMs/);
    expect(() => new IdempotencyTable({ windowMs: 10, maxEntries: 0, now: () => 0 })).toThrow(/maxEntries/);
    expect(() => new IdempotencyTable({ windowMs: 10, maxEntries: 1.5, now: () => 0 })).toThrow(/maxEntries/);
  });

  it('uses the real clock when none is injected', () => {
    const table = new IdempotencyTable<string>({ windowMs: 100_000 });
    table.put('m1', 'a', 1);
    expect(table.get('m1')?.result).toBe('a');
  });

  it('rejects an empty msgId', () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    expect(() => table.put('  ', 'a', 1)).toThrow(/msgId/);
  });
});

describe('IdempotentWriteCoordinator — replay, in-flight dedup, failure isolation', () => {
  it('executes a new msgId once and marks it as a fresh write', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    const write = vi.fn().mockResolvedValue('committed');
    const outcome = await coordinator.execute('m1', write, 42);
    expect(outcome).toEqual({ msgId: 'm1', result: 'committed', replayed: false, attempts: 1, position: 42 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('replays the first result for a retry of the same msgId without executing again', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    const write = vi.fn().mockResolvedValue('committed');
    await coordinator.execute('m1', write, 42);
    const retry = await coordinator.execute('m1', write, 99);
    expect(retry.result).toBe('committed');
    expect(retry.replayed).toBe(true);
    expect(retry.attempts).toBe(0);
    expect(retry.position).toBe(42);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('shares one execution across concurrent callers of the same msgId', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const write = vi.fn().mockReturnValue(gate);
    const first = coordinator.execute('m1', write, 1);
    const second = coordinator.execute('m1', write, 1);
    release('committed');
    const [a, b] = await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(a.result).toBe('committed');
    expect(b.result).toBe('committed');
    expect([a.replayed, b.replayed].filter(Boolean).length).toBe(1);
  });

  it('does not cache a failed execution — a retry runs again', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    const write = vi.fn().mockRejectedValueOnce(new Error('leader lost')).mockResolvedValue('committed');
    await expect(coordinator.execute('m1', write, 1)).rejects.toThrow('leader lost');
    const retry = await coordinator.execute('m1', write, 2);
    expect(retry.result).toBe('committed');
    expect(retry.replayed).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports and clears in-flight work', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = coordinator.execute('m1', () => gate, 1);
    expect(coordinator.inFlight()).toBe(1);
    release('ok');
    await pending;
    expect(coordinator.inFlight()).toBe(0);
  });

  it('isolates different msgIds', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    const write = vi.fn(async (id: string) => `value-${id}`);
    const a = await coordinator.execute('m1', () => write('m1'), 1);
    const b = await coordinator.execute('m2', () => write('m2'), 2);
    expect(a.result).toBe('value-m1');
    expect(b.result).toBe('value-m2');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty msgId', async () => {
    const table = new IdempotencyTable<string>({ windowMs: 1000, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    await expect(coordinator.execute('  ', async () => 'x', 1)).rejects.toThrow(/msgId/);
  });

  it("keeps the caller position when a shared execution's record has already expired", async () => {
    // With a zero window the completed record is gone by the time the second
    // in-flight caller reads it back; it must still report a position rather
    // than undefined, so the fallback to the caller's own position is real.
    const table = new IdempotencyTable<string>({ windowMs: 0, now: () => 0 });
    const coordinator = new IdempotentWriteCoordinator<string>({ table });
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const write = vi.fn().mockReturnValue(gate);
    const first = coordinator.execute('m1', write, 7);
    const second = coordinator.execute('m1', write, 7);
    release('ok');
    const [a, b] = await Promise.all([first, second]);
    expect(a.result).toBe('ok');
    expect(b.result).toBe('ok');
    expect(b.position).toBe(7);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
