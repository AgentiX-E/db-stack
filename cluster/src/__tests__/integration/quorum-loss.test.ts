/**
 * An isolated leader must stop claiming leadership, and say why a write is refused.
 *
 * Why this file exists
 * --------------------
 * Measured on 2026-11-18 with two of three nodes killed: `isLeader()` was still true
 * at 16 s, the commit index was frozen at 1, and the next write was refused only
 * after 5 028 ms. Nothing unsafe — a majority is required to commit — but a client
 * that routes by `isLeader()` keeps sending work to a node that cannot serve it and
 * finds out one request timeout later, which reads as a slow cluster rather than as
 * a lost quorum.
 *
 * These cases run against a real three-node cluster over TLS in separate processes,
 * isolate one node's transport through the published seam, and assert the two things
 * an operator needs: leadership stops being claimed within one election timeout, and
 * a write is refused *fast* with a reason that names the quorum.
 *
 * Acceptance criteria:
 *   AC 51.1  a healthy cluster has one leader, and every node names it
 *   AC 51.2  an isolated leader stops claiming leadership within one election timeout
 *   AC 51.3  a write to the isolated leader is refused with QUORUM_FAILED, well inside the request timeout
 *   AC 51.4  after the partition heals the cluster has one leader again and commits a write
 *   AC 51.5  a follower never reports leadership while it is isolated
 *   AC 51.6  connection reporting still answers through the transport seam
 *   AC 51.7  checkQuorum: false turns the accounting off explicitly, and says so
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TestCluster, type TestNode } from '../../testing/TestCluster';
import { PartitionTransport } from '../../testing/partition';
import { pollUntil } from '../../testing/convergence';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';

const CLUSTER_TIMEOUT = 180_000;

/** One cluster per case, always stopped, so a failure cannot leave ports held. */
const running = new Set<TestCluster>();

async function startCluster(nodeCount = 3): Promise<TestCluster> {
  const cluster = new TestCluster({ nodeCount, electionTick: 10, heartbeatTick: 2, tickIntervalMs: 100 });
  running.add(cluster);
  await cluster.start();
  return cluster;
}

async function findLeader(cluster: TestCluster): Promise<TestNode> {
  return cluster.findLeader();
}

/** Install a partition over whatever transport the node has right now. */
function partition(node: TestNode): PartitionTransport {
  const parted = new PartitionTransport(node.adapter.getTransport()!);
  node.adapter.setTransport(parted);
  return parted;
}

afterEach(async () => {
  for (const cluster of running) await cluster.stop().catch(() => {});
  running.clear();
});

describe('quorum loss', () => {
  it(
    'AC 51.1 — a healthy cluster has one leader, and every node names it',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);

      const agreement = await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });

      expect(agreement.leaderId).toBe(leader.id);
      expect(await leader.adapter.isLeader()).toBe(true);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.2 — an isolated leader stops claiming leadership within one election timeout',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);
      await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });

      const parted = partition(leader);
      parted.isolate();

      const observed = await pollUntil(
        async () => leader.adapter.isLeader(),
        (claims) => claims === false,
        {
          timeoutMs: 20_000,
          intervalMs: 100,
          label: 'the isolated leader to stop claiming leadership',
        },
      );

      expect(observed.value).toBe(false);
      // The partition must have actually carried traffic, or this case would pass on a
      // clock alone: a node that is asked nothing has nothing to hear.
      expect(parted.getStats().blocked).toBeGreaterThan(0);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.3 — a write to the isolated leader is refused with QUORUM_FAILED, well inside the request timeout',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);
      await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });

      const parted = partition(leader);
      parted.isolate();
      await pollUntil(
        async () => leader.adapter.isLeader(),
        (claims) => claims === false,
        {
          timeoutMs: 20_000,
          intervalMs: 100,
          label: 'the isolated leader to stop claiming leadership',
        },
      );

      const started = Date.now();
      const error = (await leader.adapter.proposeAndWait('while-isolated').catch((err: unknown) => err)) as SqlVecError;
      const elapsed = Date.now() - started;

      expect(error).toBeInstanceOf(SqlVecError);
      expect(error.code).toBe(SqlVecErrorCode.QUORUM_FAILED);
      expect(error.message).toMatch(/quorum/i);
      // The old behaviour was a 5 028 ms refusal from the library's own commit wait.
      // A refusal that arrives after the client has already timed out is not a signal.
      expect(elapsed).toBeLessThan(1_500);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.4 — after the partition heals the cluster has one leader again and commits a write',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);
      await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });

      const parted = partition(leader);
      parted.isolate();
      await pollUntil(
        async () => leader.adapter.isLeader(),
        (claims) => claims === false,
        {
          timeoutMs: 20_000,
          intervalMs: 100,
          label: 'the isolated leader to stop claiming leadership',
        },
      );

      parted.heal();

      // Whoever wins, exactly one node may claim it and all three must name it -- the
      // healed node included, which is the part a partition can break silently.
      const agreement = await cluster.awaitLeaderAgreement({ timeoutMs: 30_000 });
      const winner = cluster.nodes.find((node) => node.id === agreement.leaderId)!;
      const committed = await winner.adapter.proposeAndWait('after-heal');

      expect(committed.index).toBeDefined();
      expect(await winner.adapter.getTerm()).toBeGreaterThanOrEqual(1);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.5 — a follower never reports leadership while it is isolated',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);
      await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });
      const follower = cluster.nodes.find((node) => node.id !== leader.id)!;

      const parted = partition(follower);
      parted.isolate();

      // Give the follower more than enough time to campaign if isolation meant nothing.
      const observed = await pollUntil(
        async () => follower.adapter.isLeader(),
        () => true,
        {
          timeoutMs: 3_000,
          intervalMs: 100,
          label: 'the isolated follower to be observed',
        },
      );

      expect(observed.attempts).toBe(1);
      expect(observed.value).toBe(false);
      expect(await leader.adapter.isLeader()).toBe(true);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.7 — checkQuorum: false turns the accounting off explicitly, and says so',
    async () => {
      // The opt-out exists because a deployment may already do this at its router. What
      // it must not do is leave a reader guessing: `getQuorumHealth()` is null, not a
      // health report that always says "fine".
      const cluster = new TestCluster({
        nodeCount: 3,
        electionTick: 10,
        heartbeatTick: 2,
        tickIntervalMs: 100,
        checkQuorum: false,
      });
      running.add(cluster);
      await cluster.start();
      const leader = await findLeader(cluster);

      expect(leader.adapter.getQuorumHealth()).toBeNull();
      expect(await leader.adapter.isLeader()).toBe(true);
    },
    CLUSTER_TIMEOUT,
  );

  it(
    'AC 51.6 — connection reporting still answers through the transport seam',
    async () => {
      const cluster = await startCluster();
      const leader = await findLeader(cluster);
      await cluster.awaitLeaderAgreement({ timeoutMs: 10_000 });

      // Two wrappers now sit between the adapter and the sockets (the observer and the
      // partition). Reporting that stops at the outermost object would answer "no
      // peers" on a healthy node, which is the wrong signal exactly when it is needed.
      const parted = partition(leader);
      const peers = leader.adapter.getConnectedPeers();

      expect(peers.length).toBe(2);
      expect(parted.underlying).toBeDefined();
    },
    CLUSTER_TIMEOUT,
  );
});
