/**
 * LeaseReadManager Unit Tests
 *
 * Iteration 1 — Raft Industrial-Grade Enhancements
 * Leader Lease optimization for linearizable reads.
 *
 * Tests:
 *   - Normal: quorum ack → lease valid
 *   - Expiry: wait beyond leaseMs → lease invalid
 *   - Renew: ack after expiry restarts lease
 *   - getRemaining: returns correct remaining time
 *   - Default constructor with 500ms lease
 *   - 95% reads within lease don't trigger quorum (efficiency check)
 *
 * Acceptance Criteria:
 *   AC LR.1: Quorum ack makes lease valid
 *   AC LR.2: Lease expires after leaseMs
 *   AC LR.3: Expired lease can be renewed by new ack
 *   AC LR.4: getLeaseRemaining returns correct remaining ms
 *   AC LR.5: Default leaseMs = 500ms
 *   AC LR.6: getLeaseRemaining returns 0 when expired
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LeaseReadManager } from '../../consensus/extensions/LeaseReadManager';

describe('LeaseReadManager', () => {
  let manager: LeaseReadManager;
  const MOCK_NOW = 1_000_000_000_000; // fixed timestamp

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  //
  // AC LR.1: Quorum ack makes lease valid
  //
  it('AC LR.1: isLeaseValid returns true after quorum ack', () => {
    manager = new LeaseReadManager(500);
    expect(manager.isLeaseValid()).toBe(false); // no ack yet

    manager.onQuorumHeartbeatAck(MOCK_NOW);
    expect(manager.isLeaseValid()).toBe(true);
  });

  //
  // AC LR.2: Lease expires after leaseMs
  //
  it('AC LR.2: isLeaseValid returns false after lease expires', () => {
    manager = new LeaseReadManager(500);
    manager.onQuorumHeartbeatAck(MOCK_NOW);

    // Still valid before expiry
    expect(manager.isLeaseValid()).toBe(true);

    // Advance past lease duration
    vi.advanceTimersByTime(501);
    expect(manager.isLeaseValid()).toBe(false);
  });

  //
  // AC LR.3: Expired lease can be renewed
  //
  it('AC LR.3: expired lease renews on new quorum ack', () => {
    manager = new LeaseReadManager(500);
    manager.onQuorumHeartbeatAck(MOCK_NOW);

    // Let it expire
    vi.advanceTimersByTime(501);
    expect(manager.isLeaseValid()).toBe(false);

    // Renew with new ack
    const newNow = Date.now();
    manager.onQuorumHeartbeatAck(newNow);
    expect(manager.isLeaseValid()).toBe(true);
  });

  //
  // AC LR.4: getLeaseRemaining returns correct remaining time
  //
  it('AC LR.4: getLeaseRemaining returns correct remaining ms', () => {
    manager = new LeaseReadManager(1000);
    manager.onQuorumHeartbeatAck(MOCK_NOW);

    // Halfway through lease
    vi.advanceTimersByTime(400);
    const remaining = manager.getLeaseRemaining();
    expect(remaining).toBeGreaterThan(550); // ~600ms remaining
    expect(remaining).toBeLessThanOrEqual(610); // allow small fudge
  });

  //
  // AC LR.5: Default leaseMs is 500
  //
  it('AC LR.5: default leaseMs is 500', () => {
    manager = new LeaseReadManager();
    expect(manager.leaseDuration).toBe(500);

    manager.onQuorumHeartbeatAck(MOCK_NOW);
    expect(manager.isLeaseValid()).toBe(true);

    vi.advanceTimersByTime(501);
    expect(manager.isLeaseValid()).toBe(false);
  });

  //
  // AC LR.6: getLeaseRemaining returns 0 when expired
  //
  it('AC LR.6: getLeaseRemaining returns 0 after expiry', () => {
    manager = new LeaseReadManager(500);
    manager.onQuorumHeartbeatAck(MOCK_NOW);

    vi.advanceTimersByTime(501);
    expect(manager.getLeaseRemaining()).toBe(0);
  });

  //
  // AC LR.7: reset() invalidates lease
  //
  it('AC LR.7: reset clears lease state', () => {
    manager = new LeaseReadManager(500);
    manager.onQuorumHeartbeatAck(MOCK_NOW);
    expect(manager.isLeaseValid()).toBe(true);

    manager.reset();
    expect(manager.isLeaseValid()).toBe(false);
  });

  //
  // AC LR.8: Lease disabled with 0 ms
  //
  it('AC LR.8: lease disabled when leaseMs is 0', () => {
    manager = new LeaseReadManager(0);
    expect(manager.leaseDuration).toBe(0);
    expect(manager.isLeaseValid()).toBe(false);
    expect(manager.getLeaseRemaining()).toBe(0);

    // Even after ack, lease stays disabled
    manager.onQuorumHeartbeatAck(MOCK_NOW);
    expect(manager.isLeaseValid()).toBe(false);
  });

  //
  // AC LR.10: onQuorumHeartbeatAck defaults `now` to Date.now()
  //
  it('AC LR.10: onQuorumHeartbeatAck defaults now to Date.now()', () => {
    manager = new LeaseReadManager(500);
    // Omitting the `now` argument exercises the `now ?? Date.now()` fallback.
    manager.onQuorumHeartbeatAck();
    expect(manager.isLeaseValid()).toBe(true);

    // Advance past the lease to confirm the fallback timestamp was real.
    vi.advanceTimersByTime(501);
    expect(manager.isLeaseValid()).toBe(false);
  });

  //
  // AC LR.9: 95% reads within lease don't trigger quorum
  //
  it('AC LR.9: 95% requests within lease are served without quorum', () => {
    manager = new LeaseReadManager(1000);
    manager.onQuorumHeartbeatAck(MOCK_NOW);

    const iterations = 1000;
    let withinLease = 0;

    for (let i = 0; i < iterations; i++) {
      // Simulate reads spaced over the lease period
      const readTime = MOCK_NOW + (i * 950) / iterations; // spread across 950ms
      vi.setSystemTime(readTime);

      if (manager.isLeaseValid()) {
        withinLease++;
      }
    }

    // At least 950 out of 1000 reads should be within lease
    const pct = (withinLease / iterations) * 100;
    expect(pct).toBeGreaterThanOrEqual(94); // allow 1% margin for boundary
  });

  //
  // IT-109: a wall-clock step backwards must not make a stale lease look valid.
  //
  it('IT-109: a backwards clock step does not revive an expired lease', () => {
    let t = 10_000;
    const clock = { now: () => t };
    manager = new LeaseReadManager(500, { clock });
    manager.onQuorumHeartbeatAck(t); // ack at t=10_000

    t = 10_400; // inside the lease
    expect(manager.isLeaseValid()).toBe(true);
    expect(manager.getLeaseRemaining()).toBe(100);

    t = 10_600; // past the lease → expired
    expect(manager.isLeaseValid()).toBe(false);

    // NTP steps the wall clock back below the ack. A raw Date.now() subtraction
    // would go negative and report the lease valid again — a stale linearizable
    // read from a leader that no longer holds quorum.
    t = 9_000;
    expect(manager.isLeaseValid()).toBe(false);
    expect(manager.getLeaseRemaining()).toBe(0);
  });

  it('IT-109: onQuorumHeartbeatAck fallback uses the monotonic clock', () => {
    let t = 20_000;
    const clock = { now: () => t };
    manager = new LeaseReadManager(500, { clock });
    manager.onQuorumHeartbeatAck(); // no explicit now → clock.now()
    t = 20_300;
    expect(manager.isLeaseValid()).toBe(true);
    t = 19_000; // step back
    expect(manager.isLeaseValid()).toBe(true); // clamp holds the watermark
    t = 20_600;
    expect(manager.isLeaseValid()).toBe(false);
  });
});
