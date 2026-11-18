/**
 * EventBus tests — covers every EventBus behavior and the Disposable pattern.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EventBus,
  type LeaderElectedEvent,
  type ProposalCommittedEvent,
  type RoleChangedEvent,
} from '../../../consensus/events/EventBus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ── Basic publish/subscribe ──────────────────────────────────────

  it('a synchronous subscriber receives an emitted event immediately', () => {
    const handler = vi.fn();
    bus.on('leader.elected', handler);

    const event: LeaderElectedEvent = {
      type: 'leader.elected',
      timestamp: Date.now(),
      nodeId: 1,
      term: 5,
      leaderId: 1,
    };

    bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('every subscriber receives the same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();

    bus.on('leader.elected', h1);
    bus.on('leader.elected', h2);
    bus.on('leader.elected', h3);

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('an unrelated event type does not trigger the subscriber', () => {
    const handler = vi.fn();
    bus.on('leader.elected', handler);

    bus.emit({ type: 'proposal.committed', timestamp: 0, nodeId: 1, index: 1, term: 1, data: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Disposable pattern ───────────────────────────────────────────

  it('no events reach the subscriber after dispose()', () => {
    const handler = vi.fn();
    const disposable = bus.on('leader.elected', handler);

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    disposable.dispose();
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 2, leaderId: 2 });
    expect(handler).toHaveBeenCalledTimes(1); // no additional call
  });

  it('repeated dispose() is idempotent (no side effects)', () => {
    const handler = vi.fn();
    const disposable = bus.on('leader.elected', handler);

    disposable.dispose();
    disposable.dispose();
    disposable.dispose();

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('the event type is cleaned up once every subscriber disposes (zero leak)', () => {
    const d1 = bus.on('leader.elected', vi.fn());
    const d2 = bus.on('leader.elected', vi.fn());

    expect(bus.subscriberCount('leader.elected')).toBe(2);

    d1.dispose();
    expect(bus.subscriberCount('leader.elected')).toBe(1);

    d2.dispose();
    expect(bus.subscriberCount('leader.elected')).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
  });

  // ── once subscription ────────────────────────────────────────────

  it('a once subscription cancels itself after one delivery', () => {
    const handler = vi.fn();
    bus.once('leader.elected', handler);

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 2, leaderId: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispose on a once subscription works before it fires', () => {
    const handler = vi.fn();
    const disposable = bus.once('leader.elected', handler);
    disposable.dispose();

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Error isolation ─────────────────────────────────────────────

  it('one crashing subscriber does not affect the others', () => {
    const crashHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const normalHandler = vi.fn();

    bus.on('proposal.committed', crashHandler);
    bus.on('proposal.committed', normalHandler);

    expect(() => {
      bus.emit({ type: 'proposal.committed', timestamp: 0, nodeId: 1, index: 1, term: 1, data: 'test' });
    }).not.toThrow();

    expect(crashHandler).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);
  });

  // ── Recursion guard ─────────────────────────────────────────────

  it('re-emitting the same type inside emit is blocked (prevents an infinite loop)', () => {
    const handler = vi.fn(() => {
      bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 99, leaderId: 99 });
    });

    bus.on('leader.elected', handler);
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });

    expect(handler).toHaveBeenCalledTimes(1); // the recursive emit was blocked
  });

  // ── Concurrency safety ──────────────────────────────────────────

  it('1000 rapid emits lose no events', () => {
    const received: number[] = [];
    bus.on('proposal.committed', (e) => {
      received.push((e as ProposalCommittedEvent).index);
    });

    for (let i = 1; i <= 1000; i++) {
      bus.emit({ type: 'proposal.committed', timestamp: 0, nodeId: 1, index: i, term: 1, data: `entry-${i}` });
    }

    expect(received.length).toBe(1000);
    expect(received[0]).toBe(1);
    expect(received[999]).toBe(1000);
  });

  // ── reset ────────────────────────────────────────────────────────

  it('reset() clears every subscription', () => {
    bus.on('leader.elected', vi.fn());
    bus.on('proposal.committed', vi.fn());
    bus.on('role.changed', vi.fn());

    expect(bus.subscriberCount()).toBe(3);

    bus.reset();
    expect(bus.subscriberCount()).toBe(0);
  });

  // ── Async subscription ──────────────────────────────────────────

  it('an async subscription is deferred through setImmediate', async () => {
    let processed = false;
    bus.onAsync('leader.elected', async () => {
      await new Promise((r) => setTimeout(r, 5));
      processed = true;
    });

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    // the async handler has not run yet
    expect(processed).toBe(false);

    // Wait for the microtask plus setImmediate to complete
    await new Promise((r) => setTimeout(r, 20));
    expect(processed).toBe(true);
  });

  // ── Async handler exception isolation (swallowed inside setImmediate) ──

  it('a synchronously-throwing async subscriber is swallowed inside setImmediate', async () => {
    // `onAsync` marks the handler as async (deferred via setImmediate), but a
    // synchronous throw inside the callback exercises the try/catch that
    // swallows async-handler exceptions.
    const crashAsync = vi.fn(() => {
      throw new Error('async-boom');
    });
    const normalHandler = vi.fn();

    bus.onAsync('leader.elected', crashAsync);
    bus.on('leader.elected', normalHandler);

    expect(() => {
      bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    }).not.toThrow();

    // Wait for the setImmediate-delayed async handler to run and throw.
    await new Promise((r) => setTimeout(r, 20));

    expect(crashAsync).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);
  });
});
