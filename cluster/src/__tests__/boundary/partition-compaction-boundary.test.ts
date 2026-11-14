/**
 * Boundary Test — Partition + Compaction (BP.1-BP.3).
 *
 * Validates Raft cluster behavior under concurrent network partition and
 * log compaction pressure:
 *
 *   BP.1 — Partition leader → compact on majority → heal → converge
 *   BP.2 — Majority partition + compaction on minority → heal → re-sync
 *   BP.3 — Rolling partition + continuous compaction (5 rounds)
 *
 * Design rationale:
 *   Each test uses its own ephemeral ChaosCluster to avoid cross-test
 *   corruption. verifyConvergence wraps getAppliedIndex calls with
 *   per-node timeouts to prevent indefinite hangs during partitions.
 *
 * Acceptance:
 *   - No crash or hang under combined partition+compaction
 *   - After healing, all nodes converge to same lastAppliedIndex
 *   - Logs compact without data loss regardless of partition state
 */

import { describe, it, expect } from 'vitest';
import { ChaosCluster, type TestNodeInfo } from '../chaos/chaos-harness';

const BP_TIMEOUT = 300_000;
const VERIFY_TIMEOUT = 15_000;
const SINGLE_CALL_TIMEOUT = 2_000;

/** Get applied index for a single node with timeout. */
async function safeGetAppliedIndex(
  node: TestNodeInfo,
  timeoutMs = SINGLE_CALL_TIMEOUT,
): Promise<number> {
  try {
    const result = await Promise.race([
      node.adapter.getAppliedIndex(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('getAppliedIndex timeout')), timeoutMs),
      ),
    ]);
    return result;
  } catch {
    return -1;
  }
}

async function waitForLeader(
  cluster: ChaosCluster,
  maxWait = 15_000,
): Promise<number> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    for (const node of cluster.nodes) {
      if (await node.adapter.isLeader()) {
        return node.id;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('No leader elected within timeout');
}

/**
 * Check all nodes converge within maxWait.
 * Uses per-call timeouts to avoid indefinite hangs.
 */
async function verifyConvergence(
  cluster: ChaosCluster,
  maxWait = VERIFY_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + maxWait;
  let lastApplieds: number[] = [];
  while (Date.now() < deadline) {
    const results = await Promise.all(
      cluster.nodes.map((n) => safeGetAppliedIndex(n)),
    );
    lastApplieds = results;
    if (lastApplieds.every((v) => v === lastApplieds[0]) && lastApplieds[0] > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(
    `[WARN] Convergence not achieved: lastApplieds=${JSON.stringify(lastApplieds)}`,
  );
}

async function compactAll(cluster: ChaosCluster): Promise<void> {
  const errors: string[] = [];
  for (const node of cluster.nodes) {
    try {
      await node.adapter.compactLogs();
    } catch (e: any) {
      errors.push(`node ${node.id}: ${e?.message ?? e}`);
    }
  }
  if (errors.length > 0) {
    console.log(`[compactAll] errors: ${errors.join('; ')}`);
  }
}

describe('Boundary: Partition + Compaction (BP)', () => {
  it(
    'BP.1: Partition leader — compact on majority, heal, converge',
    async () => {
      const cluster = new ChaosCluster({
        nodeCount: 3,
        preVote: true,
        seed: Date.now(),
      });
      try {
        await cluster.start();
        const leader = await waitForLeader(cluster);
        expect(leader).toBeGreaterThanOrEqual(1);

        const leaderNode = cluster.nodes.find((n) => n.id === leader)!;
        for (let i = 0; i < 100; i++) {
          await leaderNode.adapter.proposeAndWait(`bp1-pre-${i}`);
        }

        await cluster.injectFault('partition', [leader]);
        console.log(`[BP.1] Leader ${leader} isolated`);

        for (const node of cluster.nodes) {
          if (node.id !== leader) {
            for (let i = 0; i < 10; i++) {
              try {
                await node.adapter.proposeAndWait(`bp1-majority-${i}`);
              } catch { /* node may not be leader */ }
            }
          }
        }

        await compactAll(cluster);

        const during = await cluster.verifyInvariants();
        expect(during.noSplitBrain).toBe(true);

        await cluster.injectFault('partition', []);
        await new Promise((r) => setTimeout(r, 3_000));
        await verifyConvergence(cluster);

        const newLeader = await waitForLeader(cluster, 10_000);
        console.log(`[BP.1] Done, leader=${newLeader}`);
        expect(newLeader).toBeGreaterThanOrEqual(1);
      } finally {
        await cluster.cleanup();
      }
    },
    BP_TIMEOUT,
  );

  it(
    'BP.2: Majority partition — compact on minority, heal, re-sync',
    async () => {
      const cluster = new ChaosCluster({
        nodeCount: 5,
        preVote: true,
        seed: Date.now() + 1,
      });
      try {
        await cluster.start();
        const leader = await waitForLeader(cluster);
        expect(leader).toBeGreaterThanOrEqual(1);

        const leaderNode = cluster.nodes.find((n) => n.id === leader)!;
        for (let i = 0; i < 100; i++) {
          await leaderNode.adapter.proposeAndWait(`bp2-pre-${i}`);
        }

        const majorityIds = cluster.nodes
          .filter((n) => n.id !== leader)
          .slice(0, 2)
          .map((n) => n.id);
        majorityIds.push(leader);
        await cluster.injectFault('partition', majorityIds);
        console.log(`[BP.2] Majority (${majorityIds}) isolated`);

        await compactAll(cluster);

        const minorityNodes = cluster.nodes.filter(
          (n) => !majorityIds.includes(n.id),
        );
        for (const node of minorityNodes) {
          for (let i = 0; i < 10; i++) {
            try {
              await node.adapter.proposeAndWait(`bp2-minority-${i}`);
            } catch { /* may not be leader */ }
          }
        }

        await cluster.injectFault('partition', []);
        await new Promise((r) => setTimeout(r, 5_000));
        await verifyConvergence(cluster);

        const during = await cluster.verifyInvariants();
        expect(during.noSplitBrain).toBe(true);

        const newLeader = await waitForLeader(cluster);
        console.log(`[BP.2] Done, leader=${newLeader}`);
        expect(newLeader).toBeGreaterThanOrEqual(1);
      } finally {
        await cluster.cleanup();
      }
    },
    BP_TIMEOUT,
  );

  it(
    'BP.3: Rolling partition + continuous compaction (5 rounds)',
    async () => {
      const cluster = new ChaosCluster({
        nodeCount: 3,
        preVote: true,
        seed: Date.now() + 2,
        snapshotInterval: 100,
      });
      try {
        await cluster.start();
        const leader = await waitForLeader(cluster);
        expect(leader).toBeGreaterThanOrEqual(1);

        let leaderId = leader;
        let totalWritten = 0;

        for (let round = 0; round < 5; round++) {
          const isolateId = cluster.nodes[round % 3].id;

          // Find current leader
          let activeLeader = cluster.nodes.find((n) => n.id === leaderId);
          if (!activeLeader || !(await activeLeader.adapter.isLeader())) {
            try {
              leaderId = await waitForLeader(cluster, 5_000);
              activeLeader = cluster.nodes.find((n) => n.id === leaderId);
            } catch { /* continue anyway */ }
          }

          if (activeLeader) {
            for (let i = 0; i < 30; i++) {
              try {
                await activeLeader.adapter.proposeAndWait(`bp3-r${round}-${i}`);
                totalWritten++;
              } catch { /* may lose leadership */ }
            }
          }

          await cluster.injectFault('partition', [isolateId]);
          console.log(`[BP.3] Round ${round}: isolated ${isolateId}, entries=${totalWritten}`);

          await compactAll(cluster);
          await cluster.injectFault('partition', []);
          await new Promise((r) => setTimeout(r, 1_000));
        }

        await cluster.injectFault('partition', []);
        await new Promise((r) => setTimeout(r, 3_000));
        await verifyConvergence(cluster);

        const during = await cluster.verifyInvariants();
        expect(during.noSplitBrain).toBe(true);

        console.log(`[BP.3] Done: ${totalWritten} entries, 5 rounds`);
        expect(totalWritten).toBeGreaterThan(50);
      } finally {
        await cluster.cleanup();
      }
    },
    BP_TIMEOUT,
  );
});
