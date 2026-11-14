/**
 * SessionManager — branch completion tests.
 *
 * SessionManager.test.ts covers lifecycle, get/extend/delete happy paths,
 * maxSessions, sliding expiry, and expiry callbacks, but leaves a few branches
 * unreached:
 *   - constructor cleanup timer (cleanupIntervalMs > 0 → setInterval + unref)
 *   - delete for a non-existent session (returns null)
 *   - shutdown clearing an active cleanup timer
 *   - _expireOne exactly-once guard (a session expired via get, then re-visited
 *     by cleanup, hits the already-tracked-id early return)
 *
 * These are exercised via the public API and fake timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../../../consensus/session/SessionManager';

describe('SessionManager — branch completion', () => {
  describe('cleanup interval timer', () => {
    it('schedules an interval when cleanupIntervalMs > 0 and clears it on shutdown', async () => {
      vi.useFakeTimers();

      const expirySpy = vi.fn();
      const sm = new SessionManager({
        ttlMs: 100,
        cleanupIntervalMs: 50,
      });
      sm.onExpiry(expirySpy);
      sm.create('t1');

      // Advance past ttl but before next cleanup tick is needed:
      // the interval calls cleanup() every 50ms.
      vi.advanceTimersByTime(150);
      expect(expirySpy).toHaveBeenCalledTimes(1);

      // shutdown clears the interval (no further ticks fire).
      sm.shutdown();

      vi.useRealTimers();
    });

    it('skips the interval timer when cleanupIntervalMs is 0', () => {
      const sm = new SessionManager({ ttlMs: 5000, cleanupIntervalMs: 0 });
      // No timer is scheduled; shutdown still works without clearInterval.
      expect(() => sm.shutdown()).not.toThrow();
    });
  });

  describe('delete non-existent session', () => {
    it('returns null when the session does not exist', () => {
      const sm = new SessionManager({ ttlMs: 5000 });
      expect(sm.delete('ghost')).toBeNull();
      sm.shutdown();
    });
  });

  describe('_expireOne exactly-once guard', () => {
    it('does not re-fire expiry when a session is expired via get then cleanup', async () => {
      vi.useFakeTimers();

      const expirySpy = vi.fn();
      const sm = new SessionManager({ ttlMs: 10 });
      sm.onExpiry(expirySpy);
      sm.create('s1');

      // Advance past expiry, then get() marks it expired (calls _expireOne)
      // but does NOT remove it from the map.
      vi.advanceTimersByTime(20);
      expect(sm.get('s1')).toBeNull();
      expect(expirySpy).toHaveBeenCalledTimes(1);

      // cleanup() then re-visits the same entry and calls _expireOne again;
      // the already-tracked-id guard prevents a second callback invocation.
      const cleaned = sm.cleanup();
      expect(cleaned).toBe(1);
      expect(expirySpy).toHaveBeenCalledTimes(1);

      sm.shutdown();
      vi.useRealTimers();
    });
  });
});
