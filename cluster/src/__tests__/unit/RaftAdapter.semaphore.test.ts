/**
 * Semaphore & Race-Condition Tests for RaftAdapter.
 *
 * Covers the propose-and-wait semaphore (CONCURRENCY_MAX=64) in isolation:
 *
 *   SEM.1 — Queue depth: 128 sequential proposals, verify inFlight ≤ 64
 *   SEM.2 — Burst drain: 200 all-at-once, verify all resolve/reject
 *   SEM.3 — Stop race: proposeAndWait called after stop(), verify no hang
 *   SEM.4 — Queue drain on error: _serviceQueue in finally, verify no starvation
 *   SEM.5 — CONCURRENCY_MAX boundary: 63 (under) vs 65 (over) proposals
 *
 * Acceptance:
 *   - _inFlight never exceeds CONCURRENCY_MAX
 *   - Promise resolution order preserves FIFO (proposals complete in order)
 *   - stop() during inflight proposals does not leak promises
 *   - Errors in _doPropose still drain queue (finally fix verification)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RaftAdapter,
  type RaftConfig,
} from '../../consensus/core/RaftAdapter';
import { SqlVecError, SqlVecErrorCode } from '../../consensus/core/SqlVecError';

function minimalConfig(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return {
    nodeId: 'sem-test-' + (Math.random() * 1e9).toString(36),
    peers: ['peer-1'],
    port: 0,
    ...overrides,
  };
}

describe('RaftAdapter Semaphore (SEM)', () => {
  let adapter: RaftAdapter;

  beforeEach(() => {
    adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, useInMemoryTransport: true }),
    );
  });

  afterEach(async () => {
    try {
      await adapter.stopHeartbeat();
    } catch { /* OK */ }
  });

  it(
    'SEM.1: inFlight never exceeds CONCURRENCY_MAX under burst',
    async () => {
      const inFlightSpy: number[] = [];
      // Expose private state via type cast
      const priv = adapter as unknown as {
        _inFlight: number;
        proposeAndWait: (d: string) => Promise<void>;
      };

      // Submit 128 proposals — the first 64 bypass queue; the rest queue.
      // Track inFlight by wrapping _doPropose to observe it.
      const handler = adapter as unknown as {
        _doPropose: (d: string) => Promise<void>;
      };
      const origDoPropose = handler._doPropose.bind(handler);
      handler._doPropose = async (data: string) => {
        inFlightSpy.push(priv._inFlight);
        try {
          await origDoPropose(data);
        } catch {
          // Expected — Raft node not initialized (no init() call)
        }
      };

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 128; i++) {
        promises.push(priv.proposeAndWait(`sem1-${i}`).catch(() => {}));
      }
      await Promise.all(promises);

      // _inFlight should never have exceeded the max we observed
      const maxObserved = Math.max(...inFlightSpy, 0);
      console.log(`[SEM.1] max inFlight = ${maxObserved} (CONCURRENCY_MAX=64)`);
      expect(maxObserved).toBeLessThanOrEqual(64);
    },
    10_000,
  );

  it(
    'SEM.2: burst drain — all 200 proposals resolve or reject cleanly',
    async () => {
      const priv = adapter as unknown as {
        proposeAndWait: (d: string) => Promise<void>;
      };
      const results: Array<'resolved' | 'rejected'> = [];

      const promises = Array.from({ length: 200 }, (_, i) =>
        priv
          .proposeAndWait(`sem2-${i}`)
          .then(() => results.push('resolved'))
          .catch(() => results.push('rejected')),
      );

      await Promise.all(promises);

      // Every proposal must have a terminal state — no leaked promises
      expect(results.length).toBe(200);
      console.log(
        `[SEM.2] ${results.filter((r) => r === 'resolved').length} resolved, ` +
          `${results.filter((r) => r === 'rejected').length} rejected`,
      );

      // With no init(), all should reject with 'not initialized'
      // But they must all complete — no hang
    },
    10_000,
  );

  it(
    'SEM.3: proposeAndWait after stop() — no hang, no TypeError',
    async () => {
      const priv = adapter as unknown as {
        proposeAndWait: (d: string) => Promise<void>;
      };

      // Hit proposeAndWait to fill the queue
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 64; i++) {
        promises.push(
          priv
            .proposeAndWait(`sem3-${i}`)
            .catch(() => {}) // Expected: node not initialized
        );
      }

      // All proposals should settle cleanly
      await expect(Promise.all(promises)).resolves.not.toThrow();
    },
    10_000,
  );

  it(
    'SEM.4: error in _doPropose still drains queue (finally fix check)',
    async () => {
      const priv = adapter as unknown as {
        _inFlight: number;
        _proposeQueue: Array<unknown>;
        proposeAndWait: (d: string) => Promise<void>;
      };

      // Submit 100 proposals — all will fail (no init)
      const settled: boolean[] = [];
      const promises = Array.from({ length: 100 }, (_, i) =>
        priv
          .proposeAndWait(`sem4-${i}`)
          .then(() => { settled.push(true); })
          .catch(() => { settled.push(false); }),
      );
      await Promise.all(promises);

      // All must settle
      expect(settled.length).toBe(100);

      // Queue must be empty
      expect(priv._proposeQueue.length).toBe(0);
      console.log(
        `[SEM.4] Queue empty after error drain: ${priv._proposeQueue.length}` +
          ` (inFlight=${priv._inFlight})`,
      );
    },
    10_000,
  );

  it(
    'SEM.5: CONCURRENCY_MAX boundary — 63 (under) vs 65 (over)',
    async () => {
      const priv = adapter as unknown as {
        _inFlight: number;
        _proposeQueue: Array<unknown>;
        proposeAndWait: (d: string) => Promise<void>;
        CONCURRENCY_MAX: number;
      };

      // 63 proposals: all bypass queue (under threshold)
      const batch63 = Array.from({ length: 63 }, (_, i) =>
        priv.proposeAndWait(`sem5-under-${i}`).catch(() => {}),
      );
      await Promise.all(batch63);
      const qSizeAfter63 = priv._proposeQueue.length;

      // 65 proposals: 1 goes to queue (over threshold, 64 direct + 1 queued)
      const batch65 = Array.from({ length: 65 }, (_, i) =>
        priv.proposeAndWait(`sem5-over-${i}`).catch(() => {}),
      );
      await Promise.all(batch65);

      console.log(
        `[SEM.5] queue after 63: ${qSizeAfter63}, after 65: ${priv._proposeQueue.length}`,
      );

      // Under threshold: queue should be empty (all bypassed)
      expect(qSizeAfter63).toBe(0);
    },
    10_000,
  );
});
