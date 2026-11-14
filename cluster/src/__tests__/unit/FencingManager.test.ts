/**
 * FencingManager Unit Tests
 *
 * Iteration 21 — Write-fencing / STONITH protection for partitioned leaders.
 *
 * FencingManager prevents split-brain writes by tracking heartbeat leases.
 * If a leader fails to send heartbeats within leaderLeaseMs, the node
 * fences itself and rejects write operations.
 *
 * Acceptance Criteria:
 *   AC 21.1: getState() returns 'unknown' with no shards
 *   AC 21.2: receiveHeartbeat implicitly registers a shard
 *   AC 21.3: receiveHeartbeat updates term and leaderId
 *   AC 21.4: getShardState returns current state
 *   AC 21.5: receiveHeartbeat with new term recovers fenced shard
 *   AC 21.6: receiveHeartbeat with same term does NOT recover fenced shard
 *   AC 21.7: checkWriteAllowed returns { allowed: true } when unfenced
 *   AC 21.8: checkWriteAllowed returns { allowed: false } when fenced
 *   AC 21.9: getStatus returns correct fencing summary
 *   AC 21.10: fenceNode fences shards for specific nodeId
 *   AC 21.11: removeShard removes a shard from tracking
 *   AC 21.12: onFenceTriggered callback fires on lease expiry
 *   AC 21.13: start() begins periodic lease checks
 *   AC 21.14: stop() clears check timer
 *   AC 21.15: Disabled config passes all writes
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FencingManager } from '../../consensus/fencing/FencingManager';

describe('FencingManager - Unit', () => {
  let fm: FencingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    fm = new FencingManager();
  });

  afterEach(() => {
    fm.stop();
    vi.useRealTimers();
  });

  //
  // AC 21.1: getState() returns 'unknown' with no shards
  //
  it('AC 21.1: getState() returns unknown with no shards', () => {
    expect(fm.getState()).toBe('unknown');
  });

  //
  // AC 21.2: receiveHeartbeat implicitly registers a shard
  //
  it('AC 21.2: receiveHeartbeat implicitly registers a shard', () => {
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.getState()).toBe('unfenced');
    expect(fm.getShardState(0)).toBe('unfenced');
  });

  //
  // AC 21.3: receiveHeartbeat updates term and leaderId
  //
  it('AC 21.3: receiveHeartbeat updates term and leaderId', () => {
    fm.receiveHeartbeat(0, 1, '1');
    fm.receiveHeartbeat(0, 2, '2');
    const status = fm.getStatus();
    const s = status.shards.find((s) => s.shardId === 0)!;
    expect(s.currentTerm).toBe(2);
    expect(s.leaderId).toBe('2');
  });

  //
  // AC 21.4: getShardState returns current state
  //
  it('AC 21.4: getShardState returns current state', () => {
    expect(fm.getShardState(0)).toBe('unknown');
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.getShardState(0)).toBe('unfenced');
  });

  //
  // AC 21.5: New term heartbeat recovers fenced shard
  //
  it('AC 21.5: receiveHeartbeat with new term recovers fenced shard', () => {
    fm.receiveHeartbeat(0, 1, '1');
    // Fence the node
    fm.fenceNode('1');
    expect(fm.getShardState(0)).toBe('fenced');

    // Heartbeat with higher term recovers
    fm.receiveHeartbeat(0, 2, '2');
    expect(fm.getShardState(0)).toBe('unfenced');
  });

  //
  // AC 21.6: Same term heartbeat does NOT recover fenced shard
  //
  it('AC 21.6: Same term heartbeat does NOT recover fenced shard', () => {
    fm.receiveHeartbeat(0, 1, '1');
    fm.fenceNode('1');

    // Same term heartbeat — should be ignored
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.getShardState(0)).toBe('fenced');
  });

  //
  // AC 21.7: checkWriteAllowed returns true when unfenced
  //
  it('AC 21.7: checkWriteAllowed returns allowed when unfenced', () => {
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.checkWriteAllowed(0).allowed).toBe(true);
  });

  //
  // AC 21.8: checkWriteAllowed returns false when fenced
  //
  it('AC 21.8: checkWriteAllowed returns denied when fenced', () => {
    fm.receiveHeartbeat(0, 1, '1');
    fm.fenceNode('1');
    const result = fm.checkWriteAllowed(0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fenced');
  });

  //
  // AC 21.9: getStatus returns summary
  //
  it('AC 21.9: getStatus returns correct summary', () => {
    fm.receiveHeartbeat(0, 1, '1');
    fm.receiveHeartbeat(1, 1, '1');
    const status = fm.getStatus();
    expect(status.shards.length).toBe(2);
    expect(status.globalState).toBe('unfenced');
    expect(typeof status.fenceCount).toBe('number');
  });

  //
  // AC 21.10: fenceNode fences matching shards
  //
  it('AC 21.10: fenceNode fences shards for specific nodeId', () => {
    fm.receiveHeartbeat(0, 1, '1');
    fm.receiveHeartbeat(1, 1, '2'); // Different leader

    fm.fenceNode('1');
    expect(fm.getShardState(0)).toBe('fenced'); // Leader=1, fenced
    expect(fm.getShardState(1)).toBe('unfenced'); // Leader=2, not fenced
  });

  //
  // AC 21.11: removeShard removes tracking
  //
  it('AC 21.11: removeShard removes a shard', () => {
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.getShardState(0)).toBe('unfenced');
    fm.removeShard(0);
    expect(fm.getShardState(0)).toBe('unknown');
  });

  //
  // AC 21.12: onFenceTriggered callback fires on lease expiry via start()
  //
  it('AC 21.12: onFenceTriggered callback fires on lease expiry', () => {
    fm = new FencingManager({ leaderLeaseMs: 1000, checkIntervalMs: 500 });
    fm.receiveHeartbeat(0, 1, '1');
    const callback = vi.fn();
    fm.onFenceTriggered(callback);
    fm.start();

    vi.advanceTimersByTime(1500);
    expect(callback).toHaveBeenCalled();
    expect(callback.mock.calls[0][0]).toContain('missed leader heartbeat');
  });

  //
  // AC 21.13: start() begins periodic checks
  //
  it('AC 21.13: start() begins periodic checks', () => {
    fm = new FencingManager({ leaderLeaseMs: 2000, checkIntervalMs: 1000 });
    fm.receiveHeartbeat(0, 1, '1');
    fm.start();
    expect(fm.getShardState(0)).toBe('unfenced');

    // Advance past lease
    vi.advanceTimersByTime(3000);
    // Should now be fenced (check timer ran)
    expect(fm.getShardState(0)).toBe('fenced');
  });

  //
  // AC 21.14: stop() clears timer
  //
  it('AC 21.14: stop() clears timer', () => {
    fm.start();
    expect(() => fm.stop()).not.toThrow();
  });

  //
  // AC 21.15: Disabled config passes all writes
  //
  it('AC 21.15: Disabled config passes all writes', () => {
    fm = new FencingManager({ enabled: false });
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.checkWriteAllowed(0).allowed).toBe(true);
  });
});

describe('FencingManager - edge cases', () => {
  let fm: FencingManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fm?.stop();
    vi.useRealTimers();
  });

  // AC 21.16: start() is a no-op when fencing is disabled.
  it('AC 21.16: start() is a no-op when disabled', () => {
    fm = new FencingManager({ enabled: false });
    expect(() => fm.start()).not.toThrow();
    // No timer is installed; advancing time must not throw or fence anything.
    vi.advanceTimersByTime(10_000);
    expect(fm.getState()).toBe('unknown');
  });

  // AC 21.17: start() ignores a duplicate start.
  it('AC 21.17: duplicate start() is ignored', () => {
    fm = new FencingManager({ leaderLeaseMs: 1000, checkIntervalMs: 500 });
    fm.receiveHeartbeat(0, 1, '1');
    fm.start();
    fm.start(); // duplicate — must be ignored
    vi.advanceTimersByTime(1500);
    expect(fm.getShardState(0)).toBe('fenced');
  });

  // AC 21.18: getState() reports 'fenced' when any shard is fenced.
  it('AC 21.18: getState() returns fenced when a shard is fenced', () => {
    fm = new FencingManager();
    fm.receiveHeartbeat(0, 1, '1');
    fm.receiveHeartbeat(1, 1, '2');
    fm.fenceNode('1');
    expect(fm.getState()).toBe('fenced');
  });

  // AC 21.19: receiveHeartbeat refreshes a same-term unfenced shard.
  it('AC 21.19: same-term heartbeat refreshes an unfenced shard', () => {
    fm = new FencingManager();
    fm.receiveHeartbeat(0, 1, '1');
    const before = fm.getStatus().shards[0].lastHeartbeatMs;

    vi.advanceTimersByTime(100);
    fm.receiveHeartbeat(0, 1, '1'); // same term, still unfenced → refresh
    const after = fm.getStatus().shards[0].lastHeartbeatMs;

    expect(after).toBeGreaterThan(before);
    expect(fm.getShardState(0)).toBe('unfenced');
  });

  // AC 21.20: checkWriteAllowed accepts a string shardId (parsed to number).
  it('AC 21.20: checkWriteAllowed accepts a string shardId', () => {
    fm = new FencingManager();
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.checkWriteAllowed('0').allowed).toBe(true);

    fm.fenceNode('1');
    expect(fm.checkWriteAllowed('0').allowed).toBe(false);
  });

  // AC 21.21: checkWriteAllowed allows writes for an untracked shard.
  it('AC 21.21: checkWriteAllowed allows unknown (untracked) shards', () => {
    fm = new FencingManager();
    expect(fm.checkWriteAllowed(999).allowed).toBe(true);
  });

  // AC 21.22: block_all action rejects writes even when the shard is unfenced.
  it('AC 21.22: block_all action blocks writes on unfenced shards', () => {
    fm = new FencingManager({ action: 'block_all' });
    fm.receiveHeartbeat(0, 1, '1');
    expect(fm.getShardState(0)).toBe('unfenced');

    const result = fm.checkWriteAllowed(0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('block_all');
  });

  // AC 21.23: fence callback exceptions are swallowed without breaking the loop.
  it('AC 21.23: a throwing fence callback does not break lease checks', () => {
    fm = new FencingManager({ leaderLeaseMs: 1000, checkIntervalMs: 500 });
    fm.receiveHeartbeat(0, 1, '1');
    fm.receiveHeartbeat(1, 1, '2');

    fm.onFenceTriggered(() => { throw new Error('callback-boom'); });
    fm.start();

    vi.advanceTimersByTime(1500);

    // Both shards must have been fenced despite the throwing callback.
    expect(fm.getShardState(0)).toBe('fenced');
    expect(fm.getShardState(1)).toBe('fenced');
  });

  // AC 21.24: panic action invokes panic callbacks on lease breach.
  it('AC 21.24: panic action invokes panic callbacks', () => {
    fm = new FencingManager({
      leaderLeaseMs: 1000,
      checkIntervalMs: 500,
      action: 'panic',
    });
    fm.receiveHeartbeat(0, 1, '1');
    const panicCb = vi.fn();
    fm.onPanic(panicCb);
    fm.start();

    vi.advanceTimersByTime(1500);

    expect(panicCb).toHaveBeenCalled();
    expect(panicCb.mock.calls[0][0]).toContain('missed leader heartbeat');
    expect(fm.getShardState(0)).toBe('fenced');
  });

  // AC 21.25: panic action without a panic callback logs but does not crash.
  it('AC 21.25: panic action with no callback is tolerated', () => {
    fm = new FencingManager({
      leaderLeaseMs: 1000,
      checkIntervalMs: 500,
      action: 'panic',
    });
    fm.receiveHeartbeat(0, 1, '1');
    fm.start();

    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    expect(fm.getShardState(0)).toBe('fenced');
  });

  // AC 21.26: a throwing panic callback is swallowed without breaking the loop.
  it('AC 21.26: a throwing panic callback does not break shutdown', () => {
    fm = new FencingManager({
      leaderLeaseMs: 1000,
      checkIntervalMs: 500,
      action: 'panic',
    });
    fm.receiveHeartbeat(0, 1, '1');
    fm.onPanic(() => { throw new Error('panic-boom'); });
    fm.start();

    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    expect(fm.getShardState(0)).toBe('fenced');
  });

  // AC 21.27: checkAllLeases skips an already-fenced shard (continue branch).
  it('AC 21.27: an already-fenced shard is skipped during lease checks', () => {
    fm = new FencingManager({ leaderLeaseMs: 1000, checkIntervalMs: 500 });
    fm.receiveHeartbeat(0, 1, '1'); // shard 0 — will be pre-fenced
    fm.receiveHeartbeat(1, 1, '2'); // shard 1 — stays unfenced within lease

    // Pre-fence shard 0 so the lease check hits the `continue` branch for it.
    fm.fenceNode('1');
    expect(fm.getShardState(0)).toBe('fenced');

    fm.start();
    vi.advanceTimersByTime(500); // one check cycle

    // Shard 0 remains fenced (skipped), shard 1 may now be fenced if its lease
    // expired; the key assertion is that the pre-fenced shard did not change.
    expect(fm.getShardState(0)).toBe('fenced');
  });
});
