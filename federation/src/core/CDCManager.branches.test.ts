/**
 * CDCManager (core) — branch-complete tests.
 *
 * Covers the in-memory CDC manager owned by FederationManager: lifecycle,
 * event capture with backpressure, buffer-warning threshold, flush delivery to
 * handlers, and the PG-compatible publication/subscription surface that the
 * engine-driven variant leaves untested for this class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CDCManager, type CDCEvent, type CDCTarget } from './CDCManager';
import { CDCEngine } from '../replication/CDCEngine';
import { HLC } from '../hlc/HLC';

const hlc = new HLC('local');

function makeEvent(key = 'k1'): CDCEvent {
  const ts = hlc.now();
  return {
    eventId: `evt-${key}`,
    key,
    value: 'v',
    type: 'insert',
    sourceNodeId: 'local',
    sourceDc: 'dc-east',
    hlcTimestamp: {
      wallTime: Number(ts.wallTime),
      logical: ts.logical,
      nodeId: ts.nodeId,
    },
    appliedAt: Date.now(),
  };
}

describe('CDCManager (core) — lifecycle & getters', () => {
  let mgr: CDCManager;

  beforeEach(() => {
    mgr = new CDCManager({ nodeId: 'local', hlc });
  });

  afterEach(async () => {
    await mgr.stop();
  });

  it('isStarted tracks start/stop', async () => {
    expect(mgr.isStarted()).toBe(false);
    await mgr.start([]);
    expect(mgr.isStarted()).toBe(true);
    await mgr.stop();
    expect(mgr.isStarted()).toBe(false);
  });

  it('start() is idempotent', async () => {
    await mgr.start([{ nodeId: 't1', dc: 'dc-west' }]);
    const count = mgr.getEngineCount();
    await mgr.start([{ nodeId: 't2', dc: 'dc-east' }]); // should early-return
    expect(mgr.getEngineCount()).toBe(count);
  });

  it('creates one engine per target (MA1)', async () => {
    await mgr.start([
      { nodeId: 't1', dc: 'dc-west' },
      { nodeId: 't2', dc: 'dc-east' },
    ]);
    expect(mgr.getEngineCount()).toBe(2);
  });

  it('reports buffer size and backpressure state', async () => {
    await mgr.start([]);
    expect(mgr.getBufferSize()).toBe(0);
    expect(mgr.isBackpressured()).toBe(false);

    await mgr.capture(makeEvent('a'));
    expect(mgr.getBufferSize()).toBe(1);
    expect(mgr.isBackpressured()).toBe(false);
  });
});

describe('CDCManager (core) — capture & backpressure', () => {
  it('captures events into the buffer', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc });
    await mgr.start([]);
    await mgr.capture(makeEvent('a'));
    await mgr.capture(makeEvent('b'));
    expect(mgr.getBufferSize()).toBe(2);
    await mgr.stop();
  });

  it('throws when capturing before start', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc });
    await expect(mgr.capture(makeEvent('x'))).rejects.toThrow('CDCManager not started');
  });

  it('applies backpressure when buffer is full (MA3)', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc, maxBufferSize: 2 });
    const bpEvents: unknown[] = [];
    mgr.onBackpressure((info) => bpEvents.push(info));

    await mgr.start([]);
    await mgr.capture(makeEvent('a'));
    await mgr.capture(makeEvent('b')); // now at capacity
    await mgr.capture(makeEvent('c')); // ≥ maxBufferSize → backpressure, not buffered

    expect(mgr.getBufferSize()).toBe(2); // c was dropped
    expect(mgr.isBackpressured()).toBe(true);
    expect(bpEvents).toHaveLength(1);
    await mgr.stop();
  });

  it('emits buffer-warning when buffer reaches 80% threshold', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc, maxBufferSize: 5 });
    const warnings: unknown[] = [];
    mgr.onBackpressure(() => {});
    // buffer-warning is emitted via emitter; subscribe directly
    mgr['emitter'].on('buffer-warning', (info: unknown) => warnings.push(info));

    await mgr.start([]);
    // fill to 4 = 80% of 5 → warning threshold (>= 4)
    for (let i = 0; i < 4; i++) {
      await mgr.capture(makeEvent(`k${i}`));
    }
    expect(warnings.length).toBeGreaterThan(0);
    await mgr.stop();
  });
});

describe('CDCManager (core) — event handlers & flush', () => {
  it('onEvent registers a handler and flush delivers events to it', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc });
    const received: string[] = [];
    mgr.onEvent(async (e) => {
      received.push(e.key);
    });

    await mgr.start([]);
    await mgr.capture(makeEvent('a'));

    await mgr.stop(); // flushBuffer runs on stop
    // flush delivers events[0] to each handler (one at a time)
    expect(received).toContain('a');
  });

  it('onEvent unsubscribes cleanly', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc });
    const received: string[] = [];
    const unsub = mgr.onEvent(async (e) => {
      received.push(e.key);
    });
    unsub();

    await mgr.start([]);
    await mgr.capture(makeEvent('a'));
    await mgr.stop();
    expect(received).toEqual([]);
  });

  it('flush continues past a handler that throws', async () => {
    const mgr = new CDCManager({ nodeId: 'local', hlc });
    const received: string[] = [];
    mgr.onEvent(async () => {
      throw new Error('handler boom');
    });
    mgr.onEvent(async (e) => {
      received.push(e.key);
    });

    await mgr.start([]);
    await mgr.capture(makeEvent('a'));
    await mgr.stop(); // first handler throws, second still runs

    expect(received).toContain('a');
  });
});

describe('CDCManager (core) — PG-compatible surface', () => {
  let mgr: CDCManager;
  beforeEach(async () => {
    mgr = new CDCManager({ nodeId: 'local', hlc });
    await mgr.start([]);
  });
  afterEach(async () => {
    await mgr.stop();
  });

  it('createPublication returns a publication object', async () => {
    const pub = await mgr.createPublication('pub-1', ['users']);
    expect(pub.publicationId).toBe('pub-1');
    expect(pub.tables).toEqual(['users']);
    expect(pub.createdAt).toBeGreaterThan(0);
  });

  it('dropPublication is a no-op that resolves', async () => {
    await expect(mgr.dropPublication('pub-1')).resolves.toBeUndefined();
  });

  it('createSubscription returns a subscription object', async () => {
    const sub = await mgr.createSubscription('sub-1', 'pub-1', 'postgres://x');
    expect(sub.subscriptionId).toBe('sub-1');
    expect(sub.operations).toEqual(['insert', 'update', 'delete']);
    expect(sub.createdAt).toBeGreaterThan(0);
  });

  it('dropSubscription is a no-op that resolves', async () => {
    await expect(mgr.dropSubscription('sub-1')).resolves.toBeUndefined();
  });

  it('getSubscriptions returns empty array', async () => {
    expect(await mgr.getSubscriptions()).toEqual([]);
  });

  it('getPublications returns empty array', async () => {
    expect(await mgr.getPublications()).toEqual([]);
  });

  it('onSlotInvalid registers and unregisters', async () => {
    const cb = vi.fn();
    const unsub = mgr.onSlotInvalid(cb);
    mgr['emitter'].emit('slot-invalid', 'sub-1');
    expect(cb).toHaveBeenCalledWith('sub-1');
    unsub();
    mgr['emitter'].emit('slot-invalid', 'sub-2');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stop() survives an engine whose stop() throws (best-effort)', async () => {
    // Inject a failing engine to prove one engine's shutdown failure does not
    // abort the manager's graceful stop (MA5 best-effort semantics).
    const failing = new CDCEngine({ nodeId: 'local', hlc });
    vi.spyOn(failing, 'stop').mockRejectedValueOnce(new Error('stop boom'));
    mgr['engines'].push(failing);
    await expect(mgr.stop()).resolves.toBeUndefined();
    expect(mgr.getEngineCount()).toBe(0); // engines cleared after stop
  });
});
