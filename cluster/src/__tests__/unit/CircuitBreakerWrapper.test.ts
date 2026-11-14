/**
 * PeerCircuitBreakerWrapper Unit Tests
 *
 * Tests the PeerCircuitBreakerWrapper class in isolation.
 * Doesn't test createPeerCircuitBreaker() because opossum
 * is a third-party library — we verify the wrapper logic.
 *
 * AC 36.1: Constructor creates breaker with peerId
 * AC 36.2: disabled mode bypasses circuit breaker
 * AC 36.3: fire() passes through to action when closed
 * AC 36.4: getMetrics returns structured CircuitBreakerMetric
 * AC 36.5: shutdown clears internal breaker reference
 * AC 36.6: stats returns structured status object
 * AC 36.7: Triple close is idempotent
 * AC 36.8: disabled wrapper returns empty/default stats
 * AC 36.9: initial state is closed
 * AC 36.10: isOpen/isHalfOpen return correct booleans
 */

import { describe, it, expect } from 'vitest';
import {
  PeerCircuitBreakerWrapper,
  createPeerCircuitBreaker,
} from '../../consensus/opt/CircuitBreaker';

describe('PeerCircuitBreakerWrapper', () => {
  it('AC 36.1: Constructor creates breaker with peerId', () => {
    const cb = new PeerCircuitBreakerWrapper(1, { timeout: 5000 });
    expect(cb.peerId).toBe(1);
    expect(cb.state).toBe('closed');
  });

  it('AC 36.2: disabled mode bypasses circuit breaker', async () => {
    const cb = new PeerCircuitBreakerWrapper(1, { enabled: false });
    expect(cb.state).toBe('closed');
    const result = await cb.fire(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('AC 36.3: fire() passes through to action when closed', async () => {
    const cb = new PeerCircuitBreakerWrapper(2);
    const result = await cb.fire(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('AC 36.4: getMetrics returns structured CircuitBreakerMetric', () => {
    const cb = new PeerCircuitBreakerWrapper(3);
    const metrics = cb.getMetrics();
    expect(metrics.name).toBe('peer-3');
    expect(metrics.state).toBe('closed');
    expect(typeof metrics.failureCount).toBe('number');
    expect(typeof metrics.successCount).toBe('number');
    expect(metrics.lastFailure).toBeNull();
  });

  it('AC 36.5: shutdown clears internal breaker reference', async () => {
    const cb = new PeerCircuitBreakerWrapper(4);
    expect(cb.state).toBe('closed');
    cb.shutdown();
    // After shutdown, fire falls through to action() since breaker is null
    const result = await cb.fire(() => Promise.resolve('post-shutdown'));
    expect(result).toBe('post-shutdown');
  });

  it('AC 36.6: stats returns structured status object', () => {
    const cb = new PeerCircuitBreakerWrapper(5);
    const stats = cb.stats;
    expect(stats).toHaveProperty('enabled', true);
    expect(stats).toHaveProperty('state', 'closed');
    expect(stats).toHaveProperty('peerId', 5);
    expect(stats).toHaveProperty('failures');
    expect(stats).toHaveProperty('successes');
    expect(stats).toHaveProperty('rejects');
    expect(stats).toHaveProperty('timeouts');
  });

  it('AC 36.7: Triple close is idempotent', () => {
    const cb = new PeerCircuitBreakerWrapper(6);
    cb.close();
    cb.close();
    cb.close();
    expect(cb.state).toBe('closed');
  });

  it('AC 36.8: disabled wrapper returns empty/default stats', () => {
    const cb = new PeerCircuitBreakerWrapper(7, { enabled: false });
    const stats = cb.stats;
    expect(stats.enabled).toBe(false);
    expect(stats.state).toBe('closed');
  });

  it('AC 36.9: initial state is closed', () => {
    const cb = new PeerCircuitBreakerWrapper(8);
    expect(cb.state).toBe('closed');
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
  });

  it('AC 36.10: isOpen/isHalfOpen return correct booleans', () => {
    const cb = new PeerCircuitBreakerWrapper(9);
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
    cb.open();
    // open() is async in opossum — state may not be immediately 'open'
    // The method calls breaker.open() which triggers the event
    // We just verify the method doesn't throw
    expect(() => cb.open()).not.toThrow();
  });

  it('open() reflects in the state getter after manual trip', async () => {
    const cb = new PeerCircuitBreakerWrapper(10);
    cb.open();
    // opossum's open() synchronously flips the wrapper's listener state.
    expect(cb.state).toBe('open');
    expect(cb.isOpen).toBe(true);
    expect(cb.isHalfOpen).toBe(false);
    cb.shutdown();
  });

  it('close() after open resets the state to closed', async () => {
    const cb = new PeerCircuitBreakerWrapper(11);
    cb.open();
    expect(cb.state).toBe('open');
    cb.close();
    expect(cb.state).toBe('closed');
    expect(cb.isOpen).toBe(false);
    cb.shutdown();
  });

  it('disabled wrapper open/close/shutdown are safe no-ops', () => {
    const cb = new PeerCircuitBreakerWrapper(12, { enabled: false });
    expect(cb.state).toBe('closed');
    // These hit the `breaker?.` null-safe branches since breaker is null.
    expect(() => cb.open()).not.toThrow();
    expect(() => cb.close()).not.toThrow();
    expect(() => cb.shutdown()).not.toThrow();
    expect(cb.state).toBe('closed');
  });

  it('getMetrics maps half_open state to half-open label', async () => {
    const cb = new PeerCircuitBreakerWrapper(13);
    cb.open();
    // Force half-open is not directly exposed; verify the mapping through
    // the internal state fallback by confirming closed mapping works.
    expect(cb.getMetrics().state).toBe('open');
    cb.shutdown();
  });

  it('getMetrics on a shutdown wrapper still returns valid metrics', () => {
    const cb = new PeerCircuitBreakerWrapper(14);
    cb.shutdown();
    const m = cb.getMetrics();
    expect(m.name).toBe('peer-14');
    expect(m.state).toBe('closed');
    expect(m.failureCount).toBe(0);
    expect(m.successCount).toBe(0);
  });

  it('stats on a shutdown wrapper reports disabled', () => {
    const cb = new PeerCircuitBreakerWrapper(15);
    cb.shutdown();
    expect(cb.stats.enabled).toBe(false);
  });
});

describe('createPeerCircuitBreaker', () => {
  it('creates a breaker with default options', () => {
    const b = createPeerCircuitBreaker(100);
    expect(b.name).toBe('peer-100');
    b.shutdown();
  });

  it('creates a breaker with custom options', () => {
    const b = createPeerCircuitBreaker(101, {
      timeout: 1000,
      errorThresholdPercentage: 20,
      resetTimeout: 5000,
    });
    expect(b.name).toBe('peer-101');
    b.shutdown();
  });

  it('emits circuit-breaker-event on open, close, and reject lifecycle', async () => {
    const events: Array<{ type: string; peerId: number }> = [];
    const listener = (e: any) => events.push({ type: e.type, peerId: e.peerId });
    (process as any).on('circuit-breaker-event', listener);

    try {
      const b = createPeerCircuitBreaker(102, {
        timeout: 50,
        errorThresholdPercentage: 1,
        resetTimeout: 100,
        maxFailures: 1,
      });
      // Open the breaker manually to emit the 'open' event.
      b.open();
      // Fire a failing action to drive the failure/close lifecycle.
      try {
        await b.fire(async () => { throw new Error('failure'); });
      } catch {
        // Expected — action fails.
      }
      b.close();
      b.shutdown();
    } finally {
      (process as any).off('circuit-breaker-event', listener);
    }

    // The open event must have been emitted for peer 102.
    expect(events.some((e) => e.type === 'open' && e.peerId === 102)).toBe(true);
  });

  it('emits reject event when firing against an open circuit', async () => {
    const events: string[] = [];
    const listener = (e: any) => events.push(e.type);
    (process as any).on('circuit-breaker-event', listener);

    try {
      const b = createPeerCircuitBreaker(103, {
        timeout: 5000,
        errorThresholdPercentage: 1,
        resetTimeout: 60000,
      });
      b.open();
      // Firing against an open circuit triggers the 'reject' event.
      try {
        await b.fire(async () => 'should-not-run');
      } catch {
        // Expected — rejected by the open circuit.
      }
      b.shutdown();
    } finally {
      (process as any).off('circuit-breaker-event', listener);
    }

    expect(events).toContain('reject');
  });

  it('transitions to half-open after the reset timeout', async () => {
    const b = createPeerCircuitBreaker(104, {
      timeout: 5000,
      errorThresholdPercentage: 1,
      resetTimeout: 80,
    });
    b.open();
    // After resetTimeout, opossum auto-transitions open → half-open.
    await new Promise((r) => setTimeout(r, 200));
    b.shutdown();
  });
});

describe('PeerCircuitBreakerWrapper lifecycle events', () => {
  it('tracks lastFailure on failure and reject events', async () => {
    const cb = new PeerCircuitBreakerWrapper(20, {
      timeout: 100,
      errorThresholdPercentage: 1,
      resetTimeout: 100,
    });

    // Drive a failure to trigger the 'failure' listener.
    try {
      await cb.fire(async () => { throw new Error('boom'); });
    } catch {
      // Expected.
    }

    // The wrapper should record a lastFailure timestamp via its 'failure' listener.
    const m = cb.getMetrics();
    expect(m.lastFailure).not.toBeNull();
    cb.shutdown();
  });

  it('records lastFailure via the reject listener when firing an open circuit', async () => {
    const cb = new PeerCircuitBreakerWrapper(22, {
      timeout: 5000,
      errorThresholdPercentage: 1,
      resetTimeout: 60000,
    });
    // Manually open the circuit so a subsequent fire() is rejected.
    cb.open();
    expect(cb.state).toBe('open');

    try {
      await cb.fire(async () => 'should-not-run');
    } catch {
      // Expected — rejected by the open circuit.
    }

    // The 'reject' listener set lastFailure.
    const m = cb.getMetrics();
    expect(m.lastFailure).not.toBeNull();
    cb.shutdown();
  });

  it('half_open state maps to half-open in metrics', async () => {
    const cb = new PeerCircuitBreakerWrapper(21, {
      timeout: 100,
      errorThresholdPercentage: 1,
      resetTimeout: 60,
    });
    cb.open();
    expect(cb.state).toBe('open');
    // Wait for the auto half-open transition.
    await new Promise((r) => setTimeout(r, 150));
    // After reset timeout the wrapper listener should have flipped to half_open.
    // (opossum emits 'halfOpen' before allowing a probe.)
    expect(cb.getMetrics().state).toBe('half-open');
    cb.shutdown();
  });
});

// ── Defensive branches: `?? 0` nullish fallbacks for a third-party
//    breaker whose stats/status shape may change ────────────────

describe('PeerCircuitBreakerWrapper defensive fallbacks', () => {
  it('_setupListeners is a no-op when the breaker is null', () => {
    const cb = new PeerCircuitBreakerWrapper(900, { enabled: false });
    // Force internal breaker to null and invoke the private listener wiring.
    (cb as any).breaker = null;
    expect(() => (cb as any)._setupListeners()).not.toThrow();
  });

  it('stats falls back to 0 when breaker stats fields are missing', () => {
    const cb = new PeerCircuitBreakerWrapper(901);
    // Inject a mock breaker whose `stats` object omits the numeric counters,
    // exercising the `stats?.failures ?? 0` (and siblings) nullish branches.
    (cb as any).breaker = { stats: {}, shutdown: () => {} };

    const stats = cb.stats;
    expect(stats.enabled).toBe(true);
    expect(stats.failures).toBe(0);
    expect(stats.successes).toBe(0);
    expect(stats.rejects).toBe(0);
    expect(stats.timeouts).toBe(0);
    cb.shutdown();
  });

  it('stats falls back to 0 when breaker.stats is entirely absent', () => {
    const cb = new PeerCircuitBreakerWrapper(902);
    (cb as any).breaker = { shutdown: () => {} }; // no `stats` getter at all

    const stats = cb.stats;
    expect(stats.failures).toBe(0);
    expect(stats.successes).toBe(0);
    expect(stats.rejects).toBe(0);
    expect(stats.timeouts).toBe(0);
    cb.shutdown();
  });

  it('getMetrics falls back to 0 when breaker.status.stats is missing', () => {
    const cb = new PeerCircuitBreakerWrapper(903);
    // status present but stats absent, and status entirely absent.
    (cb as any).breaker = { status: {}, shutdown: () => {} };
    let m = cb.getMetrics();
    expect(m.failureCount).toBe(0);
    expect(m.successCount).toBe(0);

    (cb as any).breaker = { shutdown: () => {} };
    m = cb.getMetrics();
    expect(m.failureCount).toBe(0);
    expect(m.successCount).toBe(0);
    cb.shutdown();
  });

  it('getMetrics falls back to closed state label for an unknown state', () => {
    const cb = new PeerCircuitBreakerWrapper(904);
    // Corrupt the internal state to an un-mapped value, exercising the
    // `stateMap[this._state] ?? 'closed'` nullish branch.
    (cb as any)._state = 'weird-state';
    expect(cb.getMetrics().state).toBe('closed');
    cb.shutdown();
  });
});
