/**
 * SessionManager 测试 — 覆盖 CRUD、TTL、过期回调、并发安全。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager, type SessionConfig } from '../../../consensus/session/SessionManager';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager({ ttlMs: 5000 });
  });

  afterEach(() => {
    sm.shutdown();
  });

  // ── CRUD ─────────────────────────────────────────────────────────

  it('create 返回正确的 session entry', () => {
    const entry = sm.create('s1', { role: 'admin' });
    expect(entry.id).toBe('s1');
    expect(entry.metadata).toEqual({ role: 'admin' });
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.expiresAt).toBe(entry.createdAt + 5000);
  });

  it('get 返回已创建的 session', () => {
    sm.create('s1');
    const entry = sm.get('s1');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('s1');
  });

  it('get 返回 null 对于不存在的 session', () => {
    expect(sm.get('nonexistent')).toBeNull();
  });

  it('delete 删除 session 并返回它', () => {
    sm.create('s1');
    const deleted = sm.delete('s1');
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe('s1');
    expect(sm.get('s1')).toBeNull();
  });

  it('重复创建同一 id 应抛出', () => {
    sm.create('s1');
    expect(() => sm.create('s1')).toThrow('Session \'s1\' already exists');
  });

  it('activeCount 准确反映活跃数量', () => {
    expect(sm.activeCount()).toBe(0);
    sm.create('s1');
    sm.create('s2');
    sm.create('s3');
    expect(sm.activeCount()).toBe(3);
    sm.delete('s1');
    expect(sm.activeCount()).toBe(2);
  });

  // ── TTL 过期 ────────────────────────────────────────────────────

  it('过期 session get 返回 null', async () => {
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.create('s1');
    await new Promise(r => setTimeout(r, 20));
    expect(shortSm.get('s1')).toBeNull();
    shortSm.shutdown();
  });

  it('extend 延长过期时间', async () => {
    const shortSm = new SessionManager({ ttlMs: 100 });
    shortSm.create('s1');
    await new Promise(r => setTimeout(r, 50));
    expect(shortSm.extend('s1')).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    // 总共 110ms，但 extend 过了，所以未过期
    expect(shortSm.get('s1')).not.toBeNull();
    shortSm.shutdown();
  });

  it('extend 对不存在的 session 返回 false', () => {
    expect(sm.extend('nonexistent')).toBe(false);
  });

  // ── cleanup ────────────────────────────────────────────────────

  it('cleanup 清除过期 session 并返回清理数量', async () => {
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.create('s1');
    shortSm.create('s2');
    shortSm.create('s3');

    await new Promise(r => setTimeout(r, 20));

    const cleaned = shortSm.cleanup();
    expect(cleaned).toBe(3);
    expect(shortSm.activeCount()).toBe(0);
    shortSm.shutdown();
  });

  it('cleanup 对未过期 session 不操作', () => {
    sm.create('s1');
    const cleaned = sm.cleanup();
    expect(cleaned).toBe(0);
    expect(sm.activeCount()).toBe(1);
  });

  // ── 过期回调 ────────────────────────────────────────────────────

  it('过期回调 exactly-once 触发', async () => {
    const handler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.onExpiry(handler);

    shortSm.create('s1');
    await new Promise(r => setTimeout(r, 20));

    // cleanup 触发过期
    shortSm.cleanup();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));

    // 再次 cleanup 不重复触发
    shortSm.cleanup();
    expect(handler).toHaveBeenCalledTimes(1);

    shortSm.shutdown();
  });

  it('过期回调异常不影响其他处理器', async () => {
    const crashHandler = vi.fn(() => { throw new Error('handler crashed'); });
    const normalHandler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });

    shortSm.onExpiry(crashHandler);
    shortSm.onExpiry(normalHandler);

    shortSm.create('s1');
    await new Promise(r => setTimeout(r, 20));

    expect(() => shortSm.cleanup()).not.toThrow();
    expect(crashHandler).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);

    shortSm.shutdown();
  });

  it('取消注册的回调不再触发', async () => {
    const handler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });
    const unsub = shortSm.onExpiry(handler);
    unsub();

    shortSm.create('s1');
    await new Promise(r => setTimeout(r, 20));
    shortSm.cleanup();
    expect(handler).not.toHaveBeenCalled();

    shortSm.shutdown();
  });

  // ── 滑动过期 ────────────────────────────────────────────────────

  it('滑动过期：每次访问重置 TTL', async () => {
    const shortSm = new SessionManager({ ttlMs: 50, slidingExpiry: true });
    shortSm.create('s1');

    // 访问多次，每次延长 TTL
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      expect(shortSm.get('s1')).not.toBeNull();
    }

    expect(shortSm.get('s1')!.lastAccessAt).toBeGreaterThan(0);
    shortSm.shutdown();
  });

  // ── 并发容量 ────────────────────────────────────────────────────

  it('maxSessions 限制会话数量', () => {
    const cappedSm = new SessionManager({ ttlMs: 5000, maxSessions: 2 });
    cappedSm.create('s1');
    cappedSm.create('s2');
    expect(() => cappedSm.create('s3')).toThrow('Max sessions (2) reached');
    cappedSm.shutdown();
  });

  it('maxSessions 在清理过期后允许创建', async () => {
    const cappedSm = new SessionManager({ ttlMs: 10, maxSessions: 2 });
    cappedSm.create('s1');
    cappedSm.create('s2');

    await new Promise(r => setTimeout(r, 20));

    // 清理后创建新 session
    cappedSm.cleanup();
    expect(() => cappedSm.create('s3')).not.toThrow();
    cappedSm.shutdown();
  });

  // ── 10000 会话性能 ─────────────────────────────────────────────

  it('10000 并发 sessions 创建和查询', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      sm.create(`session-${i}`, { index: i });
    }
    const createTime = performance.now() - start;

    const startGet = performance.now();
    for (let i = 0; i < 10000; i++) {
      const entry = sm.get(`session-${i}`);
      expect(entry).not.toBeNull();
    }
    const getTime = performance.now() - startGet;

    // O(n) 性能应通过（10000 次操作 < 1s）
    expect(createTime).toBeLessThan(1000);
    expect(getTime).toBeLessThan(1000);
  });

  // ── shutdown ────────────────────────────────────────────────────

  it('shutdown 后所有操作返回 null 或抛出', () => {
    sm.create('s1');
    sm.shutdown();
    expect(sm.get('s1')).toBeNull();
    expect(sm.delete('s1')).toBeNull();
    expect(sm.extend('s1')).toBe(false);
    expect(() => sm.create('s2')).toThrow('SessionManager is shut down');
    expect(sm.activeCount()).toBe(0);
    expect(sm.cleanup()).toBe(0);
  });
});
