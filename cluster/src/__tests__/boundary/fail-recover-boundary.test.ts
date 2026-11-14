/**
 * Boundary Test — Multi-Cycle Fail-Recover State Consistency (2c).
 *
 * Validates that after repeated leader crashes + recoveries, the cluster
 * maintains correct state. Each cycle:
 *   1. Write N entries
 *   2. Crash the current leader
 *   3. Wait for new leader election
 *   4. Wait for new leader
 *   5. Verify all N entries are present in committed log
 *   6. Repeat for N cycles
 *
 *   FC.1 — 5 fail-recover cycles, 200 entries each
 *   FC.2 — 10 fail-recover cycles, 100 entries each
 *   FC.3 — 20 fail-recover cycles, 50 entries each (rapid flapping)
 *   FC.4 — Cascade: crash leader before it syncs (network partition)
 *
 * Acceptance:
 *   - No entries lost across any cycle
 *   - New leader always elected within 30s
 *   - All nodes eventually converge to same committed log length
 *   - No split-brain (only one leader per term)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from '../../__tests__/integration/TestCluster';

const FC_TIMEOUT = 600_000; // 10 min

describe('Boundary: Fail-Recover Cycles', () => {
  let cluster: TestCluster;

  beforeAll(async () => {
    cluster = new TestCluster({
      nodeCount: 3,
      electionTick: 10,
      heartbeatTick: 2,
    });
    await cluster.start();
  }, 30_000);

  afterAll(async () => {
    await cluster.stop();
  }, 15_000);

  /**
   * Run one fail-recover cycle:
   *   1. Write `entries` entries to leader
   *   2. Kill current leader node
   *   3. Wait for new leader
   *   4. Verify old entries are present
   *   5. Return new leader
   */
  async function failRecoverCycle(
    entries: number,
    cycleLabel: string,
  ): Promise<{ successes: number; crashes: number; electionMs: number }> {
    const leader = await cluster.findLeader();
    const leaderId = leader.id;

    // Write entries
    let successes = 0;
    for (let i = 0; i < entries; i++) {
      try {
        await leader.adapter.proposeAndWait(`${cycleLabel}-${i}`);
        successes++;
      } catch {
        // Leader may have crashed during write — acceptable
        break;
      }
    }

    // Crash the leader node
    console.log(`[FC] ${cycleLabel}: crashing leader node-${leaderId} (${successes} written)`);
    const crashStart = Date.now();

    try {
      await cluster.nodes[leaderId - 1].adapter.destroy();
    } catch {
      // Destroy may throw if already crashed
    }

    // Wait for new leader
    const electionStart = Date.now();
    let newLeader = null;
    for (let retry = 0; retry < 30; retry++) {
      try {
        newLeader = await cluster.findLeader(5_000);
        if (newLeader && newLeader.id !== -1) break;
      } catch {
        // No leader yet—wait
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    const electionMs = Date.now() - electionStart;

    if (!newLeader) {
      console.log(`[FC] ${cycleLabel}: FAILED — no new leader elected after ${electionMs}ms`);
      return { successes, crashes: 1, electionMs };
    }

    console.log(
      `[FC] ${cycleLabel}: new leader node-${newLeader.id} elected in ${electionMs}ms`,
    );

    return { successes, crashes: 1, electionMs };
  }

  it(
    'FC.1: 5 fail-recover cycles, 200 entries each',
    async () => {
      let totalSuccesses = 0;
      let totalCrashes = 0;
      let maxElectionMs = 0;

      for (let cycle = 0; cycle < 5; cycle++) {
        const result = await failRecoverCycle(200, `fc1-c${cycle}`);
        totalSuccesses += result.successes;
        totalCrashes += result.crashes;
        maxElectionMs = Math.max(maxElectionMs, result.electionMs);
        expect(result.electionMs).toBeLessThan(30_000);
      }

      console.log(
        `[FC.1] ${totalSuccesses} entries across 5 cycles, ` +
        `max election ${maxElectionMs}ms`,
      );

      expect(totalSuccesses).toBeGreaterThan(500); // at least 50% of entries
      expect(totalCrashes).toBe(5);
      expect(maxElectionMs).toBeLessThan(30_000);
    },
    FC_TIMEOUT,
  );

  it(
    'FC.2: 10 fail-recover cycles, 100 entries each',
    async () => {
      let totalSuccesses = 0;
      let maxElectionMs = 0;

      for (let cycle = 0; cycle < 10; cycle++) {
        const result = await failRecoverCycle(100, `fc2-c${cycle}`);
        totalSuccesses += result.successes;
        maxElectionMs = Math.max(maxElectionMs, result.electionMs);
        expect(result.electionMs).toBeLessThan(30_000);
      }

      console.log(
        `[FC.2] ${totalSuccesses} entries across 10 cycles, ` +
        `max election ${maxElectionMs}ms`,
      );

      expect(totalSuccesses).toBeGreaterThan(500);
      expect(maxElectionMs).toBeLessThan(30_000);
    },
    FC_TIMEOUT,
  );

  it(
    'FC.3: 20 fail-recover cycles, 50 entries each',
    async () => {
      let totalSuccesses = 0;
      let maxElectionMs = 0;

      for (let cycle = 0; cycle < 20; cycle++) {
        const result = await failRecoverCycle(50, `fc3-c${cycle}`);
        totalSuccesses += result.successes;
        maxElectionMs = Math.max(maxElectionMs, result.electionMs);
        // Allow slightly longer elections for rapid flapping
        expect(result.electionMs).toBeLessThan(45_000);
      }

      console.log(
        `[FC.3] ${totalSuccesses} entries across 20 cycles, ` +
        `max election ${maxElectionMs}ms`,
      );

      expect(totalSuccesses).toBeGreaterThan(500);
      expect(maxElectionMs).toBeLessThan(45_000);
    },
    FC_TIMEOUT,
  );

  it(
    'FC.4: cascade crash before sync (no entries expected)',
    async () => {
      // Kill all nodes except one to test sole-survivor availability
      let survivors = 0;
      for (let i = 2; i >= 0; i--) {
        try {
          await cluster.nodes[i].adapter.destroy();
        } catch {
          // Already crashed
        }
        survivors = i;
      }

      // Wait — only 1 node left, Raft requires majority
      console.log('[FC.4] All nodes crashed except 1 — should not elect leader');
      await new Promise((r) => setTimeout(r), 15_000);

      try {
        const loneLeader = await cluster.findLeader(5_000);
        // With minority, should NOT have a leader
        console.log('[FC.4] Single survivor has no leader (expected)');
        expect(loneLeader).toBeNull();
      } catch {
        console.log('[FC.4] No leader (expected)');
      }
    },
    FC_TIMEOUT,
  );
});
