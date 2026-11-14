import type { IRateLimiter, RateLimitConfig } from '../interfaces/index.js';

interface WindowEntry {
  count: number;
  windowStart: number;
}

export class InMemoryRateLimiter implements IRateLimiter {
  private _windows: Map<string, WindowEntry> = new Map();

  check(
    key: string,
    config?: RateLimitConfig,
  ): { allowed: boolean; remaining: number; resetMs: number } {
    const cfg = config ?? { maxRequests: 10, windowMs: 60000 };
    const now = Date.now();
    const entry = this._windows.get(key);

    if (!entry || now - entry.windowStart >= cfg.windowMs) {
      // Window expired or new: reset
      this._windows.set(key, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: cfg.maxRequests - 1,
        resetMs: cfg.windowMs,
      };
    }

    if (entry.count >= cfg.maxRequests) {
      const elapsed = now - entry.windowStart;
      const resetMs = Math.max(0, cfg.windowMs - elapsed);
      return { allowed: false, remaining: 0, resetMs };
    }

    entry.count++;
    const elapsed = now - entry.windowStart;
    const resetMs = Math.max(0, cfg.windowMs - elapsed);
    return {
      allowed: true,
      remaining: cfg.maxRequests - entry.count,
      resetMs,
    };
  }

  reset(key: string): void {
    this._windows.delete(key);
  }
}
