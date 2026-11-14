/**
 * WatchApi 测试 — 覆盖 Watch 语义、前缀匹配、并发安全、清理。
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

  // ── 基础 Watch ──────────────────────────────────────────────────

  it('精确前缀匹配：watch key prefix 时只收到匹配的事件', () => {
    const results: WatchEvent[] = [];
    watch.watch('users:', (e) => results.push(e));

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'users:1', value: 'Alice' })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'users:2', value: 'Bob' })));
    bus.emit(createCommittedEvent(3, JSON.stringify({ key: 'orders:1', value: 'widget' })));

    expect(results).toHaveLength(2);
    expect(results.map(r => r.key)).toEqual(['users:1', 'users:2']);
  });

  it('空字符串前缀匹配所有 key', () => {
    const results: WatchEvent[] = [];
    watch.watch('', (e) => results.push(e));

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'a', value: '1' })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'b', value: '2' })));
    bus.emit(createCommittedEvent(3, JSON.stringify({ key: 'c', value: '3' })));

    expect(results).toHaveLength(3);
  });

  it('非 JSON data 时从 data 中解析 key', () => {
    const results: WatchEvent[] = [];
    watch.watch('config:', (e) => results.push(e));

    bus.emit(createCommittedEvent(1, 'config:timeout=30s'));
    bus.emit(createCommittedEvent(2, 'config:retries=3'));
    bus.emit(createCommittedEvent(3, 'stats:qps=1000'));

    expect(results).toHaveLength(2);
    expect(results[0]!.key).toBe('config:timeout');
  });

  // ── Dispose 清理 ────────────────────────────────────────────────

  it('dispose() 后不再接收事件', () => {
    const received: WatchEvent[] = [];
    const disposable = watch.watch('test:', (e) => received.push(e));

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'test:1', value: 'a' })));
    disposable.dispose();
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'test:2', value: 'b' })));

    expect(received).toHaveLength(1);
    expect(received[0]!.key).toBe('test:1');
  });

  it('shutdown() 后所有 watch 失效', () => {
    const r1: WatchEvent[] = [];
    const r2: WatchEvent[] = [];
    watch.watch('a:', (e) => r1.push(e));
    watch.watch('b:', (e) => r2.push(e));

    expect(watch.activeWatchCount()).toBe(2);

    watch.shutdown();
    expect(watch.activeWatchCount()).toBe(0);

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'a:1', value: 'x' })));
    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });

  it('shutdown 后 watch() 应抛出', () => {
    watch.shutdown();
    expect(() => watch.watch('a:', vi.fn())).toThrow('WatchApi is shut down');
  });

  // ── 并发安全 ────────────────────────────────────────────────────

  it('1000 个快速 proposals 不丢失事件', () => {
    const received: WatchEvent[] = [];
    watch.watch('', (e) => received.push(e));

    for (let i = 1; i <= 1000; i++) {
      bus.emit(createCommittedEvent(i, JSON.stringify({ key: `k${i}`, value: `v${i}` })));
    }

    expect(received).toHaveLength(1000);
    // 验证有序
    expect(received[0]!.index).toBe(1);
    expect(received[999]!.index).toBe(1000);
  });

  it('handler 异常不影响其他 watch', () => {
    const good: WatchEvent[] = [];
    const crashHandler = vi.fn(() => { throw new Error('boom'); });

    watch.watch('crash:', crashHandler);
    watch.watch('good:', (e) => good.push(e));

    expect(() => {
      bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'crash:1', value: 'x' })));
    }).not.toThrow();

    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'good:1', value: 'y' })));
    expect(good).toHaveLength(1);
  });

  // ── 值解析 ─────────────────────────────────────────────────────

  it('正确解析 JSON data 的 value', () => {
    const values: string[] = [];
    watch.watch('', (e) => values.push(e.value));

    bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'k', value: 42 })));
    bus.emit(createCommittedEvent(2, JSON.stringify({ key: 'k', value: 'hello' })));
    bus.emit(createCommittedEvent(3, 'raw-data:blob'));

    expect(values).toEqual(['42', 'hello', 'raw-data:blob']);
  });

  // ── activeWatchCount ────────────────────────────────────────────

  it('activeWatchCount 正确反映活跃 watch 数量', () => {
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
