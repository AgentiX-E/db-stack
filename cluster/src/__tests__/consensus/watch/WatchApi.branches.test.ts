/**
 * WatchApi — branch completion tests.
 *
 * WatchApi.test.ts covers the main watch/prefix-match/dispose/shutdown paths but
 * leaves several boundary branches unreached:
 *   - options.timeoutMs (auto-cleanup timer + clearTimeout)
 *   - parseKeyFromData: JSON with a non-string key, JSON without a key
 *   - parseKeyFromData fallback: non-JSON data without '=' (empty → null)
 *   - parseValueFromData: JSON without a value field (fallback to raw data)
 *   - proposal.committed with an unparseable key (key === null early return)
 *   - _cleanup when the entry is already gone (idempotent dispose)
 *   - _cleanup swallowing a throwing dispose()
 *
 * These are exercised through the public EventBus/watch surface via crafted
 * proposal.committed events and watch option combinations.
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

describe('WatchApi — branch completion', () => {
  let bus: EventBus;
  let watch: WatchApi;

  beforeEach(() => {
    bus = new EventBus();
    watch = new WatchApi(bus);
  });

  describe('parseKeyFromData edge cases', () => {
    it('ignores a JSON payload whose key is not a string', () => {
      const results: WatchEvent[] = [];
      watch.watch('', (e) => results.push(e));

      // key: 42 (number) → parseKeyFromData returns null → not dispatched.
      bus.emit(createCommittedEvent(1, JSON.stringify({ key: 42, value: 'x' })));

      expect(results).toHaveLength(0);
    });

    it('ignores a JSON payload without a key field', () => {
      const results: WatchEvent[] = [];
      watch.watch('', (e) => results.push(e));

      // No "key" field → parseKeyFromData returns null (JSON branch).
      bus.emit(createCommittedEvent(1, JSON.stringify({ value: 'x' })));

      expect(results).toHaveLength(0);
    });

    it('returns null for empty non-JSON data', () => {
      const results: WatchEvent[] = [];
      watch.watch('', (e) => results.push(e));

      // Non-JSON, no '=' → rawKey is '' → null → not dispatched.
      bus.emit(createCommittedEvent(1, ''));

      expect(results).toHaveLength(0);
    });
  });

  describe('parseValueFromData fallback', () => {
    it('falls back to raw data when JSON has no value field', () => {
      const values: string[] = [];
      watch.watch('', (e) => values.push(e.value));

      // JSON with key but no value → parseValueFromData returns the raw data.
      bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'k' })));

      expect(values).toEqual([JSON.stringify({ key: 'k' })]);
    });
  });

  describe('timeout auto-cleanup', () => {
    it('removes the watch after the timeout elapses', async () => {
      vi.useFakeTimers();

      const received: WatchEvent[] = [];
      watch.watch('t:', (e) => received.push(e), { timeoutMs: 1000 });

      expect(watch.activeWatchCount()).toBe(1);

      vi.advanceTimersByTime(999);
      expect(watch.activeWatchCount()).toBe(1);

      vi.advanceTimersByTime(1);
      expect(watch.activeWatchCount()).toBe(0);

      vi.useRealTimers();
    });

    it('does not schedule a timeout when timeoutMs is 0', () => {
      const received: WatchEvent[] = [];
      watch.watch('t:', (e) => received.push(e), { timeoutMs: 0 });

      expect(watch.activeWatchCount()).toBe(1);
      // No timer scheduled so the watch remains active after any wait.
    });
  });

  describe('_cleanup idempotency and exception isolation', () => {
    it('is idempotent when disposed more than once', () => {
      const received: WatchEvent[] = [];
      const d = watch.watch('x:', (e) => received.push(e));

      d.dispose();
      // Second dispose hits _cleanup with the entry already gone (early return).
      d.dispose();

      expect(watch.activeWatchCount()).toBe(0);
      bus.emit(createCommittedEvent(1, JSON.stringify({ key: 'x:1', value: 'a' })));
      expect(received).toHaveLength(0);
    });

    it('swallows a throwing dispose() without breaking cleanup', () => {
      // Register a watch, then corrupt one of its disposables to throw on
      // dispose. Cleanup must still proceed (swallow) and remove the watch.
      const received: WatchEvent[] = [];
      const d = watch.watch('y:', (e) => received.push(e));

      // Reach into the internal watches map and replace one disposable.
      const internal = (watch as any)._watches;
      const entry = [...internal.values()][0];
      entry.disposables.push({
        dispose: () => {
          throw new Error('dispose exploded');
        },
      });

      d.dispose();
      expect(watch.activeWatchCount()).toBe(0);
    });
  });
});
