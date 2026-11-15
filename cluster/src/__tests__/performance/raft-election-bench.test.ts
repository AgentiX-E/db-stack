/**
 * Raft election benchmark — real clusters, real elections, real numbers.
 *
 * What this file used to be
 * -------------------------
 * Five "acceptance criteria" that measured nothing: election latency was
 * `800 + Math.random() * 2000`, "no split-brain across trials" asserted a `Map`
 * the test itself had just filled, "log index progression is monotonic" asserted
 * that `[1, 2, …, 10]` is sorted, and "term progression across restarts" asserted
 * that `[1, 2, 2, 3, 3, 4, 5, 5, 5, 6]` is non-decreasing. None of them started a
 * node. A suite like that cannot fail and cannot regress, and its presence made
 * the repository look like it measured election behaviour.
 *
 * What it is now
 * --------------
 * Every trial starts a real 3-node cluster — real ports, real mutual TLS, real
 * on-disk Raft state, three `RaftAdapter` instances — and every number printed is
 * a value the cluster produced. Elections are timed from `start()` to the moment a
 * node reports itself leader, and reported as the median of the trials plus the
 * tail, using the shared instrument (`summarise`) rather than hand-rolled sorting
 * that silently drops samples.
 *
 * Acceptance criteria:
 *   AC 29.1  a 3-node election completes, and the median of the trials is bounded
 *   AC 29.2  every trial has exactly one leader and every node names it
 *   AC 29.3  committed indices increase strictly, and both followers apply them
 *   AC 29.4  the leader survives ten heartbeat intervals without an election
 *   AC 29.5  a restarted follower's term never goes backwards
 */

import { describe, it, expect } from 'vitest';
import { TestCluster } from '../integration/TestCluster';
import { summarise, describeLatency } from '../../testing/latency';

/** Elections are short; a fast poll keeps the measurement resolution below the event. */
const POLL_INTERVAL_MS = 25;
/** Five real clusters: enough to see a median, few enough to run on every push. */
const TRIALS = 5;
const BENCH_TIMEOUT = 180_000;

function newCluster(): TestCluster {
  return new TestCluster({
    nodeCount: 3,
    electionTick: 15,
    heartbeatTick: 3,
    tickIntervalMs: 50,
    leaderTimeoutMs: 20_000,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

describe('Raft Election Benchmark', () => {
  it(
    'AC 29.1: 3-node election time across real trials',
    async () => {
      const samples: number[] = [];
      for (let trial = 0; trial < TRIALS; trial++) {
        const cluster = newCluster();
        try {
          const start = process.hrtime.bigint();
          await cluster.start();
          await cluster.findLeader();
          samples.push(Number(process.hrtime.bigint() - start));
        } finally {
          await cluster.stop();
        }
      }

      const summary = summarise(samples);
      process.stdout.write(`\n  [AC 29.1] ${describeLatency('election', summary)} (${TRIALS} real clusters)\n`);

      // A cold cluster includes the start-up of three TLS listeners and a full
      // election; on a runner this is ~1 s. The bound is a regression bar, not an
      // expectation.
      expect(summary.n).toBe(TRIALS);
      expect(summary.p50).toBeLessThan(10_000 * 1e6);
      expect(summary.max).toBeLessThan(20_000 * 1e6);
    },
    BENCH_TIMEOUT,
  );

  it(
    'AC 29.2: exactly one leader per term, agreed by every node',
    async () => {
      const cluster = newCluster();
      try {
        await cluster.start();
        const leader = await cluster.findLeader();

        // Exactly one node claims leadership...
        const claims = await Promise.all(
          cluster.nodes.map(async (node) => ((await node.adapter.isLeader()) ? node.id : 0)),
        );
        expect(claims.filter((id) => id !== 0)).toEqual([leader.id]);

        // ...and every node, including the two followers, names it.
        const named = await Promise.all(cluster.nodes.map((node) => node.adapter.getLeader()));
        expect(named).toEqual([leader.id, leader.id, leader.id]);

        // One term, agreed by all three: two leader ids in one term would be the
        // split brain this criterion exists to rule out.
        const terms = await Promise.all(cluster.nodes.map((node) => node.adapter.getTerm()));
        expect(new Set(terms).size).toBe(1);

        process.stdout.write(
          `\n  [AC 29.2] leader=${leader.id} term=${terms[0]} across ${cluster.nodes.length} nodes\n`,
        );
      } finally {
        await cluster.stop();
      }
    },
    BENCH_TIMEOUT,
  );

  it(
    'AC 29.3: committed indices increase strictly and reach both followers',
    async () => {
      const cluster = newCluster();
      try {
        await cluster.start();
        const leader = await cluster.findLeader();

        const indices: number[] = [];
        for (let i = 0; i < 20; i++) {
          const { index } = await leader.adapter.proposeAndWait(`election-bench-${i}`);
          indices.push(Number(index));
        }

        // Strictly increasing: Raft assigns one index per entry, and a repeat means
        // two entries share a position.
        for (let i = 1; i < indices.length; i++) {
          expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
        }

        // Both followers apply the last index, so "committed" is not just the
        // leader's opinion.
        const last = indices[indices.length - 1]!;
        for (const node of cluster.remainingNodes(leader.id)) {
          await expect
            .poll(async () => node.adapter.getAppliedIndex(), { timeout: 20_000, interval: 50 })
            .toBeGreaterThanOrEqual(last);
        }

        process.stdout.write(`\n  [AC 29.3] indices ${indices[0]}..${last}, both followers applied\n`);
      } finally {
        await cluster.stop();
      }
    },
    BENCH_TIMEOUT,
  );

  it(
    'AC 29.4: the leader survives ten heartbeat intervals without a new election',
    async () => {
      const cluster = newCluster();
      try {
        await cluster.start();
        const leader = await cluster.findLeader();
        const termBefore = await leader.adapter.getTerm();

        // heartbeatTick 3 × tickIntervalMs 50 = 150 ms per heartbeat, so ten of them
        // is 1.5 s — twice a follower's 750 ms election timeout, which is the point:
        // a leader that had gone quiet would have been replaced inside this window.
        const tenHeartbeatsMs = 3 * 50 * 10;
        await new Promise((resolve) => setTimeout(resolve, tenHeartbeatsMs));

        expect(await leader.adapter.isLeader()).toBe(true);
        expect(await leader.adapter.getTerm()).toBe(termBefore);
        const named = await Promise.all(cluster.nodes.map((node) => node.adapter.getLeader()));
        expect(named).toEqual([leader.id, leader.id, leader.id]);

        process.stdout.write(`\n  [AC 29.4] leader=${leader.id} term=${termBefore} stable for ${tenHeartbeatsMs}ms\n`);
      } finally {
        await cluster.stop();
      }
    },
    BENCH_TIMEOUT,
  );

  it(
    'AC 29.5: a restarted follower never reports a lower term',
    async () => {
      const cluster = newCluster();
      try {
        await cluster.start();
        const leader = await cluster.findLeader();
        const follower = cluster.remainingNodes(leader.id)[0]!;
        const termBefore = await follower.adapter.getTerm();

        await cluster.killNode(follower.id);
        // A term only advances on an election; proposing on the surviving quorum
        // ensures the restart happens against a live cluster rather than a frozen one.
        await leader.adapter.proposeAndWait('after-kill');

        const revived = await cluster.restartNode(follower.id);
        const termAfter = await revived.adapter.getTerm();

        expect(termAfter).toBeGreaterThanOrEqual(termBefore);
        expect(termAfter).toBeGreaterThanOrEqual(await leader.adapter.getTerm());

        process.stdout.write(`\n  [AC 29.5] follower ${follower.id}: term ${termBefore} → ${termAfter}\n`);
      } finally {
        await cluster.stop();
      }
    },
    BENCH_TIMEOUT,
  );
});
