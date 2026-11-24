/**
 * CDCManager (core) — branch-complete tests.
 *
 * Covers the change stream owned by FederationManager: lifecycle, capture with
 * backpressure, the buffer-warning threshold, and flush delivery to handlers.
 *
 * The delivery *conservation* properties (a flush delivers the whole buffer,
 * a handler failure re-queues rather than discards) live in
 * `CDCManager.conservation.test.ts`; this file keeps the lifecycle and the
 * thresholds, and stopped asserting that an overflow was dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CDCManager, type CDCEvent } from './CDCManager';
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
    mgr = new CDCManager({ nodeId: 'local' });
  });

  afterEach(async () => {
    await mgr.stop();
  });

  it('isStarted tracks start/stop', async () => {
    expect(mgr.isStarted()).toBe(false);
    await mgr.start();
    expect(mgr.isStarted()).toBe(true);
    await mgr.stop();
    expect(mgr.isStarted()).toBe(false);
  });

  it('start() is idempotent', async () => {
    await mgr.start();
    await mgr.start();
    await mgr.capture(makeEvent('a'));
    expect(mgr.getBufferSize()).toBe(1);
  });

  it('reports buffer size and backpressure state', async () => {
    await mgr.start();
    expect(mgr.getBufferSize()).toBe(0);
    expect(mgr.isBackpressured()).toBe(false);

    await mgr.capture(makeEvent('a'));
    expect(mgr.getBufferSize()).toBe(1);
    expect(mgr.isBackpressured()).toBe(false);
  });

  it('reports delivery stats with the handler count', async () => {
    await mgr.start();
    expect(mgr.getDeliveryStats()).toMatchObject({ captured: 0, delivered: 0, handlers: 0 });
    mgr.onEvent(async () => {});
    expect(mgr.getDeliveryStats().handlers).toBe(1);
  });
});

describe('CDCManager (core) — capture & backpressure', () => {
  it('captures events into the buffer', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    await mgr.start();
    await mgr.capture(makeEvent('a'));
    await mgr.capture(makeEvent('b'));
    expect(mgr.getBufferSize()).toBe(2);
    await mgr.stop();
  });

  it('throws when capturing before start', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    await expect(mgr.capture(makeEvent('x'))).rejects.toThrow('CDCManager not started');
  });

  it('signals backpressure at capacity and drains instead of dropping (MA3)', async () => {
    const mgr = new CDCManager({ nodeId: 'local', maxBufferSize: 2 });
    const bpEvents: unknown[] = [];
    const delivered: string[] = [];
    mgr.onBackpressure((info) => bpEvents.push(info));
    mgr.onEvent(async (e) => {
      delivered.push(e.key);
    });

    await mgr.start();
    await mgr.capture(makeEvent('a'));
    await mgr.capture(makeEvent('b')); // now at capacity
    await mgr.capture(makeEvent('c')); // ≥ maxBufferSize → drain, then buffer c

    expect(bpEvents).toHaveLength(1);
    expect(delivered).toEqual(['a', 'b']);
    expect(mgr.getBufferSize()).toBe(1);
    expect(mgr.getDeliveryStats()).toMatchObject({ captured: 3, delivered: 2 });
    await mgr.stop();
    expect(delivered).toEqual(['a', 'b', 'c']);
  });

  it('emits buffer-warning when buffer reaches 80% threshold', async () => {
    const mgr = new CDCManager({ nodeId: 'local', maxBufferSize: 5 });
    const warnings: unknown[] = [];
    mgr['emitter'].on('buffer-warning', (info: unknown) => warnings.push(info));

    await mgr.start();
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
    const mgr = new CDCManager({ nodeId: 'local' });
    const received: string[] = [];
    mgr.onEvent(async (e) => {
      received.push(e.key);
    });

    await mgr.start();
    await mgr.capture(makeEvent('a'));

    await mgr.stop(); // flushBuffer runs on stop
    expect(received).toEqual(['a']);
  });

  it('onEvent unsubscribes cleanly', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const received: string[] = [];
    const unsub = mgr.onEvent(async (e) => {
      received.push(e.key);
    });
    unsub();

    await mgr.start();
    await mgr.capture(makeEvent('a'));
    await mgr.stop();
    expect(received).toEqual([]);
  });

  it('flush continues past a handler that throws', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const received: string[] = [];
    mgr.onEvent(async () => {
      throw new Error('handler boom');
    });
    mgr.onEvent(async (e) => {
      received.push(e.key);
    });

    await mgr.start();
    await mgr.capture(makeEvent('a'));
    await mgr.stop(); // first handler throws, second still runs

    expect(received).toEqual(['a']);
  });

  it('a flush with no handler retires the batch and says so', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const flushed: number[] = [];
    mgr['emitter'].on('flushed', (n: number) => flushed.push(n));

    await mgr.start();
    await mgr.capture(makeEvent('a'));
    await mgr.flushBuffer();

    expect(flushed).toEqual([1]);
    expect(mgr.getDeliveryStats()).toMatchObject({ captured: 1, delivered: 1, handlers: 0 });
    await mgr.stop();
  });
});
