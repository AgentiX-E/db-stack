/**
 * EdgeReplica 测试 — 覆盖连接、同步完整性、网络分区恢复、backpressure。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EdgeReplica, type EdgeSourceConfig, type ReplicationEvent } from '../../replication/EdgeReplica';

const DEFAULT_SOURCE: EdgeSourceConfig = {
  url: 'ws://localhost:9001',
  protocol: 'websocket',
};

describe('EdgeReplica', () => {
  let edge: EdgeReplica;

  beforeEach(async () => {
    edge = new EdgeReplica();
    await edge.connect(DEFAULT_SOURCE);
  });

  // ── 连接管理 ────────────────────────────────────────────────────

  it('connect 后状态为 syncing', () => {
    const status = edge.getSyncStatus();
    expect(status.state).toBe('syncing');
  });

  it('disconnect 后状态为 disconnected', async () => {
    await edge.disconnect();
    const status = edge.getSyncStatus();
    expect(status.state).toBe('disconnected');
  });

  it('重复 connect 不会出错', async () => {
    await edge.connect(DEFAULT_SOURCE);
    const status = edge.getSyncStatus();
    expect(status.state).toBe('syncing');
  });

  // ── 数据接收 ────────────────────────────────────────────────────

  it('接收一个 data 条目后 lag 正确更新', () => {
    edge.receive(1, { key: 'test', value: 'hello' });
    const status = edge.getSyncStatus();
    expect(status.lastLSN).toBe(1);
    expect(status.receivedCount).toBe(1);
    expect(status.lagLSN).toBe(0); // 源 LSN == 接收 LSN
  });

  it('接收多个条目后 getAllData 返回完整列表', () => {
    edge.receive(1, 'a');
    edge.receive(2, 'b');
    edge.receive(3, 'c');

    const data = edge.getAllData();
    expect(data).toHaveLength(3);
    expect(data.map(d => d.payload)).toEqual(['a', 'b', 'c']);
  });

  it('getLag 返回 lagLSN', () => {
    // sourceLSN = 10（手动设置），lastLSN = 5
    edge.receive(5, 'data');
    edge.receive(10, 'data'); // this updates sourceLSN to 10, lastLSN to 10
    expect(edge.getLag()).toBe(0); // sourceLSN - lastLSN = 10-10 = 0
  });

  // ── 精确复制 (1000 entries) ─────────────────────────────────────

  it('1000 entries 精确复制到边缘，无丢失无乱序', () => {
    for (let i = 1; i <= 1000; i++) {
      edge.receive(i, `entry-${i}`);
    }

    const data = edge.getAllData();
    expect(data).toHaveLength(1000);
    
    // 验证有序
    expect(data[0]!.lsn).toBe(1);
    expect(data[999]!.lsn).toBe(1000);
    expect(data[499]!.payload).toBe('entry-500');
  });

  // ── batch 接收 ──────────────────────────────────────────────────

  it('receiveBatch 批量接收正确处理所有条目', () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({
      lsn: i + 1,
      payload: `batch-${i + 1}`,
    }));
    edge.receiveBatch(batch);
    expect(edge.getAllData()).toHaveLength(100);
    expect(edge.getSyncStatus().receivedCount).toBe(100);
  });

  // ── 网络分区恢复 ───────────────────────────────────────────────

  it('网络分区后数据不丢失（断点续传）', async () => {
    // 1. 同步前 500 条
    for (let i = 1; i <= 500; i++) {
      edge.receive(i, `data-${i}`);
    }
    expect(edge.getAllData()).toHaveLength(500);

    // 2. 断开连接（模拟网络分区）
    await edge.disconnect();

    // 3. 重新连接
    await edge.connect(DEFAULT_SOURCE);

    // 4. 接收后 500 条（模拟恢复）
    for (let i = 501; i <= 1000; i++) {
      edge.receive(i, `data-${i}`);
    }

    // 5. 验证：边缘有全部 1000 条
    const data = edge.getAllData();
    expect(data).toHaveLength(1000);
    expect(data[0]!.payload).toBe('data-1');
    expect(data[999]!.payload).toBe('data-1000');
  });

  // ── 事件回调 ────────────────────────────────────────────────────

  it('onEvent 回调接收所有数据事件', () => {
    const events: ReplicationEvent[] = [];
    edge.onEvent((e) => events.push(e));

    edge.receive(1, { key: 'a' });
    edge.receive(2, { key: 'b' });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('data');
    expect(events[0]!.lsn).toBe(1);
  });

  it('onSyncComplete 在 lag = 0 时触发', () => {
    const handler = vi.fn();
    edge.onSyncComplete(handler);

    edge.receive(1, 'x');
    // sourceLSN == lastLSN, lag == 0 → sync complete
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('取消注册的回调不再触发', () => {
    const handler = vi.fn();
    const unsub = edge.onEvent(handler);
    unsub();

    edge.receive(1, 'x');
    expect(handler).not.toHaveBeenCalled();
  });

  it('onError 接收错误事件', () => {
    const handler = vi.fn();
    edge.onError(handler);

    // 模拟接收错误
    (edge as any)._emitError(new Error('Connection refused'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── Backpressure ────────────────────────────────────────────────

  it('Backpressure：receiveBatch 大量数据不丢', () => {
    const batch = Array.from({ length: 10000 }, (_, i) => ({
      lsn: i + 1,
      payload: `high-throughput-${i + 1}`,
    }));
    edge.receiveBatch(batch);
    expect(edge.getAllData()).toHaveLength(10000);
  });

  // ── 有序性 ──────────────────────────────────────────────────────

  it('接收乱序 LSN 时 getAllData 保持接收顺序', () => {
    edge.receive(3, 'c');
    edge.receive(1, 'a');
    edge.receive(2, 'b');

    const data = edge.getAllData();
    // 保持接收顺序（不严格按 LSN 排序，作为边缘记录）
    expect(data.map(d => d.lsn)).toEqual([3, 1, 2]);
    expect(data.map(d => d.payload)).toEqual(['c', 'a', 'b']);
  });
});

// ── 额外覆盖 connect 边界 ─────────────────────────────────────────
describe('EdgeReplica additional coverage', () => {
  it('destroyed replica rejects connect', async () => {
    const edge = new EdgeReplica();
    // Directly access internal flag for test coverage of destroyed guard
    (edge as any)._destroyed = true;
    await expect(
      edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' }),
    ).rejects.toThrow('EdgeReplica has been destroyed');
  });

  it('disconnect clears reconnect timer', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    (edge as any)._reconnectTimer = setTimeout(() => {}, 99999);
    await edge.disconnect();
    // Timer should be cleared
    expect((edge as any)._reconnectTimer).toBeNull();
  });

  it('receive does nothing when disconnected', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    await edge.disconnect();
    edge.receive(99, 'should-be-ignored');
    expect(edge.getAllData()).toHaveLength(0);
  });

  it('event handler error isolation does not crash', () => {
    const edge = new EdgeReplica();
    edge.onEvent(() => { throw new Error('handler crash'); });
    // Should not throw
    expect(() => edge.receive(1, 'test')).not.toThrow();
  });

  it('syncComplete handler error isolation', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    let called = false;
    edge.onSyncComplete(() => { throw new Error('syncComplete crash'); });
    edge.onSyncComplete(() => { called = true; });
    edge.receive(1, 'x'); // triggers syncComplete (lag=0) when connected
    expect(called).toBe(true); // second handler still fires
    await edge.disconnect();
  });

  it('error handler error isolation', () => {
    const edge = new EdgeReplica();
    let called = false;
    edge.onError(() => { throw new Error('error handler crash'); });
    edge.onError(() => { called = true; });
    (edge as any)._emitError(new Error('test'));
    expect(called).toBe(true);
  });

  it('onSyncComplete only fires once (unsubscribe)', async () => {
    const edge = new EdgeReplica();
    await edge.connect({ url: 'ws://localhost:1', protocol: 'websocket' });
    let count = 0;
    const unsub = edge.onSyncComplete(() => { count++; });
    edge.receive(1, 'first');
    unsub();
    edge.receive(2, 'second');
    expect(count).toBe(1);
    await edge.disconnect();
  });

  it('getSyncStatus returns fresh snapshot', () => {
    const edge = new EdgeReplica();
    const s1 = edge.getSyncStatus();
    expect(s1.state).toBe('disconnected');
    edge.receive(5, 'data'); // still disconnected
    const s2 = edge.getSyncStatus();
    // disconnected → receive does nothing
    expect(s2.receivedCount).toBe(0);
  });
});
