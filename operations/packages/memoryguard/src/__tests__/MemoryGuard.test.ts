import { describe, it, expect, vi } from 'vitest';
import { InMemoryMemoryGuard } from '../impl/InMemoryMemoryGuard.js';

describe('InMemoryMemoryGuard', () => {
  it('returns stats with all required fields', () => {
    const guard = new InMemoryMemoryGuard();
    const stats = guard.getStats();
    expect(stats).toHaveProperty('heapUsed');
    expect(stats).toHaveProperty('heapTotal');
    expect(stats).toHaveProperty('external');
    expect(stats).toHaveProperty('rss');
    expect(stats).toHaveProperty('threshold');
  });

  it('threshold defaults to 0.9', () => {
    const guard = new InMemoryMemoryGuard();
    expect(guard.getStats().threshold).toBe(0.9);
  });

  it('configure updates threshold', () => {
    const guard = new InMemoryMemoryGuard();
    guard.configure(0.5);
    expect(guard.getStats().threshold).toBe(0.5);
  });

  it('isHealthy returns true when below threshold', () => {
    const guard = new InMemoryMemoryGuard();
    expect(guard.isHealthy()).toBe(true);
  });

  it('protect invokes function when healthy', async () => {
    const guard = new InMemoryMemoryGuard();
    const result = await guard.protect(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('protect returns null when unhealthy', async () => {
    const guard = new InMemoryMemoryGuard();
    guard.configure(0); // threshold 0 means always unhealthy
    const result = await guard.protect(() => Promise.resolve(42));
    expect(result).toBeNull();
  });

  it('protect rejects if function throws', async () => {
    const guard = new InMemoryMemoryGuard();
    await expect(guard.protect(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
  });

  it('getStats has positive heapUsed', () => {
    const guard = new InMemoryMemoryGuard();
    const stats = guard.getStats();
    expect(stats.heapUsed).toBeGreaterThan(0);
  });

  it('getStats has positive rss', () => {
    const guard = new InMemoryMemoryGuard();
    const stats = guard.getStats();
    expect(stats.rss).toBeGreaterThan(0);
  });

  it('protect works with zero threshold to block all calls', async () => {
    const guard = new InMemoryMemoryGuard();
    guard.configure(0);
    const fn = () => Promise.resolve('should not run');
    const result = await guard.protect(fn);
    expect(result).toBeNull();
  });

  it('multiple configure calls work', () => {
    const guard = new InMemoryMemoryGuard();
    guard.configure(0.3);
    expect(guard.getStats().threshold).toBe(0.3);
    guard.configure(0.8);
    expect(guard.getStats().threshold).toBe(0.8);
  });

  it('protect returns function result for async functions', async () => {
    const guard = new InMemoryMemoryGuard();
    const result = await guard.protect(async () => 'async-result');
    expect(result).toBe('async-result');
  });
});

describe('InMemoryMemoryGuard zero-heapTotal division guard', () => {
  it('treats a zero heapTotal as ratio 0 (healthy) instead of dividing by zero', () => {
    const guard = new InMemoryMemoryGuard();
    // Mock memoryUsage so heapTotal === 0. The `> 0` guard must fall through to
    // ratio 0 (healthy) rather than compute heapUsed/0 === Infinity (unhealthy).
    // The mutant `>` → `<=` would take the division path and report unhealthy.
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 1024,
      heapTotal: 0,
      external: 0,
      rss: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
    expect(guard.isHealthy()).toBe(true);
    vi.restoreAllMocks();
  });
});
