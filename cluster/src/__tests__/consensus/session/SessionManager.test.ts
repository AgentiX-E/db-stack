/**
 * SessionManager tests — covers CRUD, TTL, expiry callbacks and concurrency safety.
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

  it('create returns the correct session entry', () => {
    const entry = sm.create('s1', { role: 'admin' });
    expect(entry.id).toBe('s1');
    expect(entry.metadata).toEqual({ role: 'admin' });
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.expiresAt).toBe(entry.createdAt + 5000);
  });

  it('get returns an existing session', () => {
    sm.create('s1');
    const entry = sm.get('s1');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('s1');
  });

  it('get returns null for a missing session', () => {
    expect(sm.get('nonexistent')).toBeNull();
  });

  it('delete removes the session and returns it', () => {
    sm.create('s1');
    const deleted = sm.delete('s1');
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe('s1');
    expect(sm.get('s1')).toBeNull();
  });

  it('creating the same id twice throws', () => {
    sm.create('s1');
    expect(() => sm.create('s1')).toThrow("Session 's1' already exists");
  });

  it('activeCount reflects the live session count', () => {
    expect(sm.activeCount()).toBe(0);
    sm.create('s1');
    sm.create('s2');
    sm.create('s3');
    expect(sm.activeCount()).toBe(3);
    sm.delete('s1');
    expect(sm.activeCount()).toBe(2);
  });

  // ── TTL expiry ──────────────────────────────────────────────────

  it('get returns null for an expired session', async () => {
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.create('s1');
    await new Promise((r) => setTimeout(r, 20));
    expect(shortSm.get('s1')).toBeNull();
    shortSm.shutdown();
  });

  it('extend pushes the expiry out', async () => {
    const shortSm = new SessionManager({ ttlMs: 100 });
    shortSm.create('s1');
    await new Promise((r) => setTimeout(r, 50));
    expect(shortSm.extend('s1')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // 110ms in total, but extend was used, so the session has not expired
    expect(shortSm.get('s1')).not.toBeNull();
    shortSm.shutdown();
  });

  it('extend returns false for a missing session', () => {
    expect(sm.extend('nonexistent')).toBe(false);
  });

  // ── cleanup ────────────────────────────────────────────────────

  it('cleanup removes expired sessions and returns how many', async () => {
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.create('s1');
    shortSm.create('s2');
    shortSm.create('s3');

    await new Promise((r) => setTimeout(r, 20));

    const cleaned = shortSm.cleanup();
    expect(cleaned).toBe(3);
    expect(shortSm.activeCount()).toBe(0);
    shortSm.shutdown();
  });

  it('cleanup leaves unexpired sessions alone', () => {
    sm.create('s1');
    const cleaned = sm.cleanup();
    expect(cleaned).toBe(0);
    expect(sm.activeCount()).toBe(1);
  });

  // ── Expiry callbacks ────────────────────────────────────────────

  it('an expiry callback fires exactly once', async () => {
    const handler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });
    shortSm.onExpiry(handler);

    shortSm.create('s1');
    await new Promise((r) => setTimeout(r, 20));

    // cleanup triggers expiry
    shortSm.cleanup();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));

    // a second cleanup does not fire again
    shortSm.cleanup();
    expect(handler).toHaveBeenCalledTimes(1);

    shortSm.shutdown();
  });

  it('a throwing expiry callback does not affect the others', async () => {
    const crashHandler = vi.fn(() => {
      throw new Error('handler crashed');
    });
    const normalHandler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });

    shortSm.onExpiry(crashHandler);
    shortSm.onExpiry(normalHandler);

    shortSm.create('s1');
    await new Promise((r) => setTimeout(r, 20));

    expect(() => shortSm.cleanup()).not.toThrow();
    expect(crashHandler).toHaveBeenCalledTimes(1);
    expect(normalHandler).toHaveBeenCalledTimes(1);

    shortSm.shutdown();
  });

  it('an unregistered callback no longer fires', async () => {
    const handler = vi.fn();
    const shortSm = new SessionManager({ ttlMs: 10 });
    const unsub = shortSm.onExpiry(handler);
    unsub();

    shortSm.create('s1');
    await new Promise((r) => setTimeout(r, 20));
    shortSm.cleanup();
    expect(handler).not.toHaveBeenCalled();

    shortSm.shutdown();
  });

  // ── Sliding expiry ──────────────────────────────────────────────

  it('sliding expiry: every access resets the TTL', async () => {
    const shortSm = new SessionManager({ ttlMs: 50, slidingExpiry: true });
    shortSm.create('s1');

    // Access repeatedly; each access extends the TTL
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 10));
      expect(shortSm.get('s1')).not.toBeNull();
    }

    expect(shortSm.get('s1')!.lastAccessAt).toBeGreaterThan(0);
    shortSm.shutdown();
  });

  // ── Concurrent capacity ─────────────────────────────────────────

  it('maxSessions caps the session count', () => {
    const cappedSm = new SessionManager({ ttlMs: 5000, maxSessions: 2 });
    cappedSm.create('s1');
    cappedSm.create('s2');
    expect(() => cappedSm.create('s3')).toThrow('Max sessions (2) reached');
    cappedSm.shutdown();
  });

  it('maxSessions allows creation again once expired sessions are cleaned up', async () => {
    const cappedSm = new SessionManager({ ttlMs: 10, maxSessions: 2 });
    cappedSm.create('s1');
    cappedSm.create('s2');

    await new Promise((r) => setTimeout(r, 20));

    // Create a new session after cleanup
    cappedSm.cleanup();
    expect(() => cappedSm.create('s3')).not.toThrow();
    cappedSm.shutdown();
  });

  // ── 10000-session performance ──────────────────────────────────

  it('10000 concurrent sessions are created and read', () => {
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

    // O(n) performance should pass (10000 operations < 1s)
    expect(createTime).toBeLessThan(1000);
    expect(getTime).toBeLessThan(1000);
  });

  // ── shutdown ────────────────────────────────────────────────────

  it('after shutdown every operation returns null or throws', () => {
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
