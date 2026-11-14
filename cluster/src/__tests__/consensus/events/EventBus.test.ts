/**
 * EventBus 测试 — 覆盖所有 EventBus 行为和 Disposable 模式。
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

  // ── 基础发布/订阅 ────────────────────────────────────────────────

  it('同步订阅者应立即接收到发布的事件', () => {
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

  it('多个订阅者都接收到同一事件', () => {
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

  it('不相关的事件类型不应触发订阅者', () => {
    const handler = vi.fn();
    bus.on('leader.elected', handler);

    bus.emit({ type: 'proposal.committed', timestamp: 0, nodeId: 1, index: 1, term: 1, data: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Disposable 模式 ──────────────────────────────────────────────

  it('dispose() 后订阅者不再接收事件', () => {
    const handler = vi.fn();
    const disposable = bus.on('leader.elected', handler);

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    disposable.dispose();
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 2, leaderId: 2 });
    expect(handler).toHaveBeenCalledTimes(1); // no additional call
  });

  it('多次 dispose() 是幂等的（无副作用）', () => {
    const handler = vi.fn();
    const disposable = bus.on('leader.elected', handler);

    disposable.dispose();
    disposable.dispose();
    disposable.dispose();

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('所有订阅者 dispose 后事件类型被清理（零泄漏）', () => {
    const d1 = bus.on('leader.elected', vi.fn());
    const d2 = bus.on('leader.elected', vi.fn());

    expect(bus.subscriberCount('leader.elected')).toBe(2);

    d1.dispose();
    expect(bus.subscriberCount('leader.elected')).toBe(1);

    d2.dispose();
    expect(bus.subscriberCount('leader.elected')).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
  });

  // ── once 订阅 ────────────────────────────────────────────────────

  it('once 订阅在触发一次后自动取消', () => {
    const handler = vi.fn();
    bus.once('leader.elected', handler);

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 2, leaderId: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('once 订阅的 dispose 应在触发前有效', () => {
    const handler = vi.fn();
    const disposable = bus.once('leader.elected', handler);
    disposable.dispose();

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── 错误隔离 ────────────────────────────────────────────────────

  it('一个订阅者崩溃不影响其他订阅者', () => {
    const crashHandler = vi.fn(() => { throw new Error('boom'); });
    const normalHandler = vi.fn();

    bus.on('proposal.committed', crashHandler);
    bus.on('proposal.committed', normalHandler);

    expect(() => {
      bus.emit({ type: 'proposal.committed', timestamp: 0, nodeId: 1, index: 1, term: 1, data: 'test' });
    }).not.toThrow();

    expect(crashHandler).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);
  });

  // ── 递归防护 ────────────────────────────────────────────────────

  it('emit 中再次 emit 同一类型应被阻止（防死循环）', () => {
    const handler = vi.fn(() => {
      bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 99, leaderId: 99 });
    });

    bus.on('leader.elected', handler);
    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });

    expect(handler).toHaveBeenCalledTimes(1); // 递归 emit 被阻止
  });

  // ── 并发安全 ────────────────────────────────────────────────────

  it('1000 次快速发布不丢事件', () => {
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

  it('reset() 清空所有订阅', () => {
    bus.on('leader.elected', vi.fn());
    bus.on('proposal.committed', vi.fn());
    bus.on('role.changed', vi.fn());

    expect(bus.subscriberCount()).toBe(3);

    bus.reset();
    expect(bus.subscriberCount()).toBe(0);
  });

  // ── 异步订阅 ────────────────────────────────────────────────────

  it('异步订阅通过 setImmediate 延迟处理', async () => {
    let processed = false;
    bus.onAsync('leader.elected', async () => {
      await new Promise(r => setTimeout(r, 5));
      processed = true;
    });

    bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    // 异步处理器尚未执行
    expect(processed).toBe(false);

    // 等待微任务 + setImmediate 完成
    await new Promise(r => setTimeout(r, 20));
    expect(processed).toBe(true);
  });

  // ── Async handler exception isolation (swallowed inside setImmediate) ──

  it('a synchronously-throwing async subscriber is swallowed inside setImmediate', async () => {
    // `onAsync` marks the handler as async (deferred via setImmediate), but a
    // synchronous throw inside the callback exercises the try/catch that
    // swallows async-handler exceptions.
    const crashAsync = vi.fn(() => { throw new Error('async-boom'); });
    const normalHandler = vi.fn();

    bus.onAsync('leader.elected', crashAsync);
    bus.on('leader.elected', normalHandler);

    expect(() => {
      bus.emit({ type: 'leader.elected', timestamp: 0, nodeId: 1, term: 1, leaderId: 1 });
    }).not.toThrow();

    // Wait for the setImmediate-delayed async handler to run and throw.
    await new Promise(r => setTimeout(r, 20));

    expect(crashAsync).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);
  });
});
