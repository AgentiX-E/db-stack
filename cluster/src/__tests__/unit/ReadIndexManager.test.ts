/**
 * ReadIndexManager Unit Tests
 *
 * Iteration 1 — Raft Industrial-Grade Enhancements
 * ReadIndex protocol for linearizable reads.
 *
 * Tests the lifecycle of a ReadIndex request:
 *   - Normal: request → onCommitIndex → resolved
 *   - Timeout: request → no ack → rejected with timeout error
 *   - Leader lost: pending reads rejected on leader step-down
 *   - Multiple concurrent reads: all resolved on one onCommitIndex call
 *   - Zero timeout: no timeout (waits forever)
 *
 * Acceptance Criteria:
 *   AC RI.1: Normal flow resolves with commit index
 *   AC RI.2: Timeout rejects with dedicated error message
 *   AC RI.3: Leader lost rejects all pending
 *   AC RI.4: Multiple concurrent reads resolved on single ack
 *   AC RI.5: Zero readTimeoutMs disables timeout
 *   AC RI.6: pendingCount tracks active requests
 *   AC RI.7: onLeaderLost clears pending with no double-resolve
 *   AC RI.8: P50 latency < 300μs (microbenchmark)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ReadIndexManager } from '../../consensus/extensions/ReadIndexManager';

describe('ReadIndexManager', () => {
  let manager: ReadIndexManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  //
  // AC RI.1: Normal flow — request → onCommitIndex → resolved
  //
  it('AC RI.1: resolves with commit index on quorum ack', async () => {
    manager = new ReadIndexManager(5000);

    const promise = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(1);

    manager.onCommitIndex(42);

    await expect(promise).resolves.toBe(42);
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.2: Timeout — request → no ack → rejected with timeout error
  //
  it('AC RI.2: rejects with timeout error when no ack arrives', async () => {
    manager = new ReadIndexManager(1000);

    const promise = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(1);

    // Advance time past timeout
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow('timed out');
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.3: Leader lost — pending reads rejected
  //
  it('AC RI.3: onLeaderLost rejects all pending reads', async () => {
    manager = new ReadIndexManager(5000);

    const promise1 = manager.requestReadIndex();
    const promise2 = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(2);

    manager.onLeaderLost();

    await expect(promise1).rejects.toThrow('leader lost');
    await expect(promise2).rejects.toThrow('leader lost');
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.4: Multiple concurrent reads all resolved on single ack
  //
  it('AC RI.4: multiple concurrent reads resolved on one ack', async () => {
    manager = new ReadIndexManager(5000);

    const promises = [manager.requestReadIndex(), manager.requestReadIndex(), manager.requestReadIndex()];
    expect(manager.pendingCount).toBe(3);

    manager.onCommitIndex(100);

    const results = await Promise.all(promises);
    expect(results).toEqual([100, 100, 100]);
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.5: Zero readTimeoutMs disables timeout (waits forever)
  //
  it('AC RI.5: zero readTimeoutMs disables timeout', async () => {
    manager = new ReadIndexManager(0);

    const promise = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(1);

    // Advance far beyond any reasonable timeout
    vi.advanceTimersByTime(100_000);

    // Still pending (no timeout reject)
    expect(manager.pendingCount).toBe(1);

    // Resolve normally
    manager.onCommitIndex(77);
    await expect(promise).resolves.toBe(77);
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.6: pendingCount tracks active requests
  //
  it('AC RI.6: pendingCount tracks active requests accurately', async () => {
    manager = new ReadIndexManager(5000);

    expect(manager.pendingCount).toBe(0);
    const p1 = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(1);
    const p2 = manager.requestReadIndex();
    expect(manager.pendingCount).toBe(2);

    manager.onCommitIndex(10);
    await expect(p1).resolves.toBe(10);
    await expect(p2).resolves.toBe(10);
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.7: onLeaderLost doesn't cause double-resolve for already-resolved
  //
  it('AC RI.7: onLeaderLost after ack does not double-resolve', async () => {
    manager = new ReadIndexManager(5000);

    const promise = manager.requestReadIndex();
    manager.onCommitIndex(50);
    await expect(promise).resolves.toBe(50);

    // Calling again should be no-op (pending is already empty)
    expect(manager.pendingCount).toBe(0);
    manager.onLeaderLost();
    expect(manager.pendingCount).toBe(0);
  });

  //
  // AC RI.8: P50 latency < 300μs (microbenchmark)
  //
  it('AC RI.8: P50 ReadIndex latency < 300μs', () => {
    manager = new ReadIndexManager(5000);

    const iterations = 1000;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      const promise = manager.requestReadIndex();
      manager.onCommitIndex(i);
      const end = process.hrtime.bigint();
      latencies.push(Number(end - start) / 1000); // convert to μs
      void promise; // we don't need to await for benchmark
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(iterations * 0.5)];
    expect(p50).toBeLessThan(300);
  });

  //
  // AC RI.9: Constructor default timeout is 5000ms
  //
  it('AC RI.9: default timeout is 5000ms', () => {
    manager = new ReadIndexManager();
    expect(manager.timeout).toBe(5000);
  });
});
