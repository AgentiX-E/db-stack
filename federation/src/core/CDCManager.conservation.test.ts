/**
 * CDCManager — delivery conservation.
 *
 * The manager sits on the write hot path: `FederationManager.replicate()`
 * captures every locally committed change. `flushBuffer()` used to `splice(0)`
 * the whole buffer and then hand `events[0]` to each handler, so every batch
 * destroyed all but its first event, and `flushed` reported `events.length` —
 * a count of events that were never delivered. A thirty-key burst delivered
 * one key and reported thirty.
 *
 * The assertions here are on sets and order, not on counters the manager keeps
 * about itself: the counters exist for operators, and a counter that agrees
 * with a discarded event is exactly what this file is here to prevent.
 */

import { describe, expect, it } from 'vitest';
import { CDCManager, type CDCEvent } from './CDCManager';
import { HLC } from '../hlc/HLC';

const hlc = new HLC('local');

function event(key: string): CDCEvent {
  const ts = hlc.now();
  return {
    eventId: `evt-${key}`,
    key,
    value: `v-${key}`,
    type: 'insert',
    sourceNodeId: 'local',
    sourceDc: 'dc-east',
    hlcTimestamp: { wallTime: Number(ts.wallTime), logical: ts.logical, nodeId: ts.nodeId },
    appliedAt: Date.now(),
  };
}

describe('CDCManager — a flush delivers the whole buffer', () => {
  it('delivers every captured event, in capture order', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const seen: string[] = [];
    mgr.onEvent(async (e) => {
      seen.push(e.key);
    });

    await mgr.start();
    for (const key of ['e0', 'e1', 'e2', 'e3', 'e4']) await mgr.capture(event(key));
    await mgr.stop();

    expect(seen).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('reports the number of events it actually delivered', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const flushed: number[] = [];
    mgr['emitter'].on('flushed', (n: number) => flushed.push(n));
    let delivered = 0;
    mgr.onEvent(async () => {
      delivered++;
    });

    await mgr.start();
    for (let i = 0; i < 5; i++) await mgr.capture(event(`k${i}`));
    await mgr.stop();

    expect(delivered).toBe(5);
    expect(flushed).toEqual([5]);
    expect(mgr.getDeliveryStats()).toMatchObject({ captured: 5, delivered: 5, requeued: 0 });
  });

  it('delivers the whole buffer to each of several handlers', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const a: string[] = [];
    const b: string[] = [];
    mgr.onEvent(async (e) => {
      a.push(e.key);
    });
    mgr.onEvent(async (e) => {
      b.push(e.key);
    });

    await mgr.start();
    for (const key of ['x', 'y', 'z']) await mgr.capture(event(key));
    await mgr.stop();

    expect(a).toEqual(['x', 'y', 'z']);
    expect(b).toEqual(['x', 'y', 'z']);
  });
});

describe('CDCManager — a full buffer is a reason to drain, not to discard', () => {
  it('captures past maxBufferSize by draining first', async () => {
    const mgr = new CDCManager({ nodeId: 'local', maxBufferSize: 3 });
    const seen: string[] = [];
    mgr.onEvent(async (e) => {
      seen.push(e.key);
    });

    await mgr.start();
    for (let i = 0; i < 5; i++) await mgr.capture(event(`k${i}`));
    await mgr.stop();

    expect(seen).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(mgr.getDeliveryStats().captured).toBe(5);
  });

  it('signals backpressure instead of staying silent', async () => {
    const mgr = new CDCManager({ nodeId: 'local', maxBufferSize: 1 });
    const signals: unknown[] = [];
    mgr.onBackpressure((info) => signals.push(info));

    await mgr.start();
    await mgr.capture(event('a'));
    await mgr.capture(event('b'));
    await mgr.stop();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ maxBufferSize: 1 });
  });
});

describe('CDCManager — a failing handler does not lose events', () => {
  it('re-queues the events a handler refused and delivers them later', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    let failNext = true;
    const seen: string[] = [];
    mgr.onEvent(async (e) => {
      if (failNext) throw new Error('downstream unavailable');
      seen.push(e.key);
    });

    await mgr.start();
    await mgr.capture(event('k0'));
    await mgr.capture(event('k1'));
    await mgr.flushBuffer(); // handler refuses both
    expect(seen).toEqual([]);
    expect(mgr.getDeliveryStats()).toMatchObject({ delivered: 0, requeued: 2, deliveryFailures: 1 });
    expect(mgr.isBackpressured()).toBe(true);

    failNext = false;
    await mgr.flushBuffer(); // the re-queued events come back, in order
    expect(seen).toEqual(['k0', 'k1']);
    expect(mgr.getDeliveryStats()).toMatchObject({ delivered: 2, requeued: 2 });

    await mgr.stop();
  });

  it('keeps one handler failing from starving the others of the tail', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const healthy: string[] = [];
    mgr.onEvent(async (e) => {
      if (e.key === 'k1') throw new Error('only k1 fails');
      healthy.push(e.key);
    });

    await mgr.start();
    for (const key of ['k0', 'k1', 'k2']) await mgr.capture(event(key));
    await mgr.flushBuffer();

    // k0 was accepted, k1 was refused, so k1 and everything after it is still
    // owed to that handler — and `flushed` must not claim k2 was delivered.
    expect(healthy).toEqual(['k0']);
    expect(mgr.getDeliveryStats()).toMatchObject({ delivered: 1, requeued: 2 });
    expect(mgr.getBufferSize()).toBe(2);

    await mgr.stop();
  });

  it('counts each refused event rather than each failed flush', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    mgr.onEvent(async () => {
      throw new Error('always');
    });

    await mgr.start();
    await mgr.capture(event('k0'));
    await mgr.capture(event('k1'));
    await mgr.flushBuffer();
    await mgr.flushBuffer();

    const stats = mgr.getDeliveryStats();
    expect(stats.deliveryFailures).toBe(2);
    expect(stats.captured).toBe(stats.delivered + stats.bufferSize);

    await mgr.stop();
  });
});

describe('CDCManager — serialised drains', () => {
  it('two overlapping flushes deliver each event once', async () => {
    const mgr = new CDCManager({ nodeId: 'local' });
    const seen: string[] = [];
    mgr.onEvent(async (e) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(e.key);
    });

    await mgr.start();
    for (const key of ['a', 'b', 'c']) await mgr.capture(event(key));
    await Promise.all([mgr.flushBuffer(), mgr.flushBuffer(), mgr.flushBuffer()]);
    await mgr.stop();

    expect(seen).toEqual(['a', 'b', 'c']);
  });
});
