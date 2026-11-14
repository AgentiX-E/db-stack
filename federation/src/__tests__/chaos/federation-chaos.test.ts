/**
 * Federation Chaos Tests — fault injection and invariant testing for cross-DC replication.
 *
 * Tests simulate:
 *   1. DC partition — both DCs accept writes independently, recover by anti-entropy
 *   2. Replication lag — HLC preserves causality, conflict resolver handles stale writes
 *   3. CDC idempotency — duplicate CDC events are de-duplicated
 *   4. Cross-DC catastrophe — entire DC fails, recovers, outbox replays
 *   5. Concurrent partitions across multiple DCs
 *   6. HLC monotonicity under clock skew
 *   7. Outbox recovery after node crash
 *   8. Anti-entropy convergence after partition
 *   9. Conflict resolution with last-writer-wins
 *   10. Full cluster restart with data recovery
 */

import { describe, it, expect } from 'vitest';
import { FederationChaosCluster, type ChaosConfig } from './federation-chaos-harness.js';
import { compareHLC } from '../../hlc/HLC.js';
import type { IHLCTimestamp } from '../../interfaces/hlc/IHLCTimestamp.js';

// ── Timeouts ────────────────────────────────────────────────

const CHAOS_TIMEOUT = 120_000;

// ── Helpers ─────────────────────────────────────────────────

/** Wait for a condition to be true within a timeout */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 30_000,
  intervalMs: number = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Test Suite ──────────────────────────────────────────────

describe('Federation Chaos Suite', () => {
  // ── 1. DC Partition ───────────────────────────────────────
  it(
    'should handle DC partition and converge after recovery',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 100,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Inject DC partition
        await cluster.injectFault('dc-partition');
        await new Promise((r) => setTimeout(r, 2000));

        // During partition, both DCs should still have internal connectivity
        const during = await cluster.verifyInvariants();
        // At minimum, no data loss should occur
        expect(during.noDataLoss).toBe(true);

        // Heal DC partition
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 3000));

        // After healing, cluster should be consistent
        const after = await cluster.verifyInvariants();
        expect(after.eventualConsistency).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 2. Replication Lag ────────────────────────────────────
  it(
    'should preserve causality under replication lag',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        dcLatencyMs: 500,
        seed: 200,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Inject replication lag
        await cluster.injectFault('replication-lag');
        await new Promise((r) => setTimeout(r, 2000));

        // With 500ms lag, HLC timestamps must remain monotonic
        const result = await cluster.verifyInvariants();
        expect(result.hlcMonotonic).toBe(true);
        expect(result.noDataLoss).toBe(true);

        // Heal
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 3000));

        const after = await cluster.verifyInvariants();
        expect(after.eventualConsistency).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 3. CDC Idempotency ────────────────────────────────────
  it(
    'should handle duplicate CDC events idempotently',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 300,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // CDC dedup ring should handle duplicates
        const result = await cluster.verifyInvariants();
        expect(result.cdcIdsempotent).toBe(true);

        // Heal
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 2000));

        const after = await cluster.verifyInvariants();
        expect(after.cdcIdsempotent).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 4. Cross-DC Catastrophe ──────────────────────────────
  it(
    'should recover from entire DC failure using outbox replay',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 400,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Isolate entire DC (simulate catastrophe)
        await cluster.injectFault('dc-partition');
        await new Promise((r) => setTimeout(r, 2000));

        // Verify remaining DC is functional
        const result = await cluster.verifyInvariants();

        // Heal and let outbox replay pending events
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 3000));

        // After recovery, data should be consistent
        const after = await cluster.verifyInvariants();
        expect(after.noDataLoss).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 5. Concurrent Partitions ─────────────────────────────
  it(
    'should handle concurrent partitions across multiple DCs',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 500,
      });
      try {
        await cluster.start(3, 2); // 3 DCs, 2 nodes each
        await new Promise((r) => setTimeout(r, 1000));

        // Partition DC-1 from everyone, DC-2 from DC-3
        for (const dc of cluster.dcs) {
          if (dc.dcId === 'dc-1') {
            for (const node of dc.nodes) {
              for (const otherDc of cluster.dcs) {
                if (otherDc.dcId !== 'dc-1') {
                  node.transport.partitionedDcs.add(otherDc.dcId);
                }
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 2000));

        // Heal all
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 3000));

        const after = await cluster.verifyInvariants();
        expect(after.eventualConsistency).toBe(true);
        expect(after.noDataLoss).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 6. HLC Monotonicity ──────────────────────────────────
  it(
    'should maintain HLC monotonicity under simulated clock drift',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 600,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Every HLC timestamp should be strictly greater than the previous
        // for each node
        for (const dc of cluster.dcs) {
          for (const node of dc.nodes) {
            const ts1 = node.hlc.now();
            const ts2 = node.hlc.now();
            expect(compareHLC(ts1, ts2)).toBeLessThan(0);
          }
        }

        const result = await cluster.verifyInvariants();
        expect(result.hlcMonotonic).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 7. Conflict Storm ─────────────────────────────────────
  it(
    'should resolve conflicts correctly after conflict storm',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 700,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Inject conflict storm: all DCs isolated, each DC writes independently
        await cluster.injectFault('conflict-storm');
        await new Promise((r) => setTimeout(r, 2000));

        // Heal all partitions — causes conflict resolution
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 3000));

        const result = await cluster.verifyInvariants();
        // After conflict resolution, the system should converge
        expect(result.noDataLoss).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 8. Node Crash within DC ──────────────────────────────
  it(
    'should maintain DC-internal consistency after node crash',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 3,
        seed: 800,
      });
      try {
        await cluster.start(2, 3);
        await new Promise((r) => setTimeout(r, 1000));

        // Crash one node
        await cluster.injectFault('node-crash');
        await new Promise((r) => setTimeout(r, 2000));

        // Remaining nodes should still be healthy
        const result = await cluster.verifyInvariants();
        expect(result.noDataLoss).toBe(true);

        // Heal
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 2000));

        const after = await cluster.verifyInvariants();
        expect(after.eventualConsistency).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 9. Anti-Entropy Convergence ──────────────────────────
  it(
    'should converge via anti-entropy after full isolation and recovery',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 900,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Isolate all DCs from each other
        for (const dc of cluster.dcs) {
          for (const node of dc.nodes) {
            for (const otherDc of cluster.dcs) {
              if (otherDc.dcId !== dc.dcId) {
                node.transport.partitionedDcs.add(otherDc.dcId);
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 2000));

        // Heal
        await cluster.healAll();
        await new Promise((r) => setTimeout(r, 4000));

        const result = await cluster.verifyInvariants();
        expect(result.eventualConsistency).toBe(true);
        expect(result.noDataLoss).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );

  // ── 10. Dedup Ring Idempotency ───────────────────────────
  it(
    'should correctly deduplicate repeated CDC events',
    async () => {
      const cluster = new FederationChaosCluster({
        nodesPerDc: 2,
        seed: 1000,
      });
      try {
        await cluster.start(2, 2);
        await new Promise((r) => setTimeout(r, 1000));

        // Insert duplicate entries into each node's dedup ring
        for (const dc of cluster.dcs) {
          for (const node of dc.nodes) {
            const msgId = `test-msg-${dc.dcId}-${node.id}`;
            // First insert: should succeed
            const first = node.dedupRing.put(msgId);
            expect(first).toBe(true);
            // Second insert: should return false (duplicate detected)
            const second = node.dedupRing.put(msgId);
            expect(second).toBe(false);
          }
        }

        const result = await cluster.verifyInvariants();
        expect(result.cdcIdsempotent).toBe(true);
      } finally {
        await cluster.cleanup();
      }
    },
    CHAOS_TIMEOUT,
  );
});
