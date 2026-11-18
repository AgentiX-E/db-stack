/**
 * WatchApi tests — covers watch semantics, prefix matching, concurrency safety and cleanup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../../../consensus/events/EventBus';
import { WatchApi, type WatchEvent } from '../../../consensus/watch/WatchApi';
import type { ProposalCommittedEvent } from '../../../consensus/events/EventBus';

function createCommittedEvent(
  index: number,
  data: string,
  overrides: Partial<ProposalCommittedEvent> = {},
): ProposalCommittedEvent {
  return {
    type: 'proposal.committed',
    timestamp: Date.now(),
    nodeId: 1,
    index,
    term: 1,
    data,
    ...overrides,
  };
}

describe('WatchApi', () => {
  let bus: EventBus;
  let watch: WatchApi;

  beforeEach(() => {
    bus = new EventBus();
    watch = new WatchApi(bus);
  });

  // ── Basic watch ─────────────────────────────────────────────────

  it('exact prefix match: watching a key prefix delivers only matching events', () => {
    const results: WatchEvent[] = [];
    watch.watch('users:', (e) => {
      results.push(e);
    });

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'users:1', value: 'Alice' })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'users:2', value: 'Bob' })));
    bus.emit(createCommittedEvent(3, JSON.stringify({ key: 'orders:1', value: 'widget' })));

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key)).toEqual(['users:1', 'users:2']);
  });

  it('an empty prefix matches every key', () => {
    const results: WatchEvent[] = [];
    watch.watch('', (e) => {
      results.push(e);
    });

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'a', value: '1' })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'b', value: '2' })));
    bus.emit(createCommittedEvent(3, JSON.stringify({ key: 'c', value: '3' })));

    expect(results).toHaveLength(3);
  });

  it('the key is parsed out of non-JSON data', () => {
    const results: WatchEvent[] = [];
    watch.watch('config:', (e) => {
      results.push(e);
    });

    bus.emit(createCommittedEvent(1, 'config:timeout=30s'));
    bus.emit(createCommittedEvent(2, 'config:retries=3'));
    bus.emit(createCommittedEvent(3, 'stats:qps=1000'));

    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe('config:timeout');
  });

  // ── Dispose cleanup ─────────────────────────────────────────────

  it('no events arrive after dispose()', () => {
    const received: WatchEvent[] = [];
    const disposable = watch.watch('test:', (e) => {
      received.push(e);
    });

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'test:1', value: 'a' })));
    disposable.dispose();
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'test:2', value: 'b' })));

    expect(received).toHaveLength(1);
    expect(received[0]!.key).toBe('test:1');
  });

  it('every watch stops after shutdown()', () => {
    const r1: WatchEvent[] = [];
    const r2: WatchEvent[] = [];
    watch.watch('a:', (e) => {
      r1.push(e);
    });
    watch.watch('b:', (e) => {
      r2.push(e);
    });

    expect(watch.activeWatchCount()).toBe(2);

    watch.shutdown();
    expect(watch.activeWatchCount()).toBe(0);

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'a:1', value: 'x' })));
    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });

  it('watch() throws after shutdown', () => {
    watch.shutdown();
    expect(() => watch.watch('a:', vi.fn())).toThrow('WatchApi is shut down');
  });

  // ── Concurrency safety ──────────────────────────────────────────

  it('1000 rapid proposals lose no events', () => {
    const received: WatchEvent[] = [];
    watch.watch('', (e) => {
      received.push(e);
    });

    for (let i = 1; i <= 1000; i++) {
      bus.emit(createCommittedEvent(i, JSON.stringify({ key: `k${i}`, value: `v${i}` })));
    }

    expect(received).toHaveLength(1000);
    // Verify ordering
    expect(received[0]!.index).toBe(1);
    expect(received[999]!.index).toBe(1000);
  });

  it('a throwing handler does not affect other watches', () => {
    const good: WatchEvent[] = [];
    const crashHandler = vi.fn(() => {
      throw new Error('boom');
    });

    watch.watch('crash:', crashHandler);
    watch.watch('good:', (e) => {
      good.push(e);
    });

    expect(() => {
      bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'crash:1', value: 'x' })));
    }).not.toThrow();

    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'good:1', value: 'y' })));
    expect(good).toHaveLength(1);
  });

  // ── Value parsing ──────────────────────────────────────────────

  it('the value is parsed from JSON data', () => {
    const values: string[] = [];
    watch.watch('', (e) => {
      values.push(e.value);
    });

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'k', value: 42 })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'k', value: 'hello' })));
    bus.emit(createCommittedEvent(3, 'raw-data:blob'));

    expect(values).toEqual(['42', 'hello', 'raw-data:blob']);
  });

  // ── activeWatchCount ────────────────────────────────────────────

  it('activeWatchCount reflects the number of active watches', () => {
    expect(watch.activeWatchCount()).toBe(0);

    const d1 = watch.watch('a:', vi.fn());
    expect(watch.activeWatchCount()).toBe(1);

    const d2 = watch.watch('b:', vi.fn());
    expect(watch.activeWatchCount()).toBe(2);

    d1.dispose();
    expect(watch.activeWatchCount()).toBe(1);

    d2.dispose();
    expect(watch.activeWatchCount()).toBe(0);
  });
});
