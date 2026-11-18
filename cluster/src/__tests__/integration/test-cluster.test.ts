/**
 * TestCluster — the published lifecycle contract.
 *
 * Downstream packages (`@agentix-e/db-federation`, for one) drive a real
 * in-process Raft cluster through this harness. What they rely on is asserted
 * here: nothing works before `start()`, a started cluster exposes its ports,
 * storage dirs and peers, leader discovery honours an exclusion, and a killed
 * node leaves the cluster instead of leaving a stale entry behind.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import { TestCluster } from '../../testing/TestCluster';
import { getFreePorts } from '../../testing/test-utils';

const NODE_COUNT = 3;

describe('TestCluster before start', () => {
  it('rejects leader discovery and node kills until start() has run', async () => {
    const cluster = new TestCluster();

    await expect(cluster.findLeader()).rejects.toThrow(/TestCluster not started/);
    await expect(cluster.waitForNewLeader(1)).rejects.toThrow(/TestCluster not started/);
    await expect(cluster.killNode(1)).rejects.toThrow(/TestCluster not started/);
  });

  it('has no remaining nodes to report', () => {
    expect(new TestCluster().remainingNodes(1)).toEqual([]);
  });
});

describe('TestCluster lifecycle', () => {
  const cluster = new TestCluster({ nodeCount: NODE_COUNT, leaderTimeoutMs: 5000, pollIntervalMs: 100 });

  beforeAll(async () => {
    await cluster.start();
  }, 60_000);

  afterAll(async () => {
    await cluster.stop();
  });

  it('starts every node with its own port and storage directory', async () => {
    const leader = await cluster.findLeader();

    expect(cluster.nodes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(cluster.peerConfigs).toHaveLength(NODE_COUNT);
    expect(cluster.dataDirs).toHaveLength(NODE_COUNT);
    expect(new Set(cluster.dataDirs).size).toBe(NODE_COUNT);
    for (const dir of cluster.dataDirs) expect(fs.statSync(dir).isDirectory()).toBe(true);

    expect(leader.port).toBe(cluster.peerConfigs[leader.id - 1]!.port);
    expect(leader.dir).toBe(cluster.dataDirs[leader.id - 1]);
    expect(await leader.adapter.isLeader()).toBe(true);
  });

  it('waits until every node names the same leader, and reports what it cost', async () => {
    const leader = await cluster.findLeader();

    // `findLeader()` resolves the moment a candidate marks *itself* leader, which
    // raft-core does before it appends the no-op entry and before it sends a single
    // heartbeat — so a single read across the three nodes is a race, and the one
    // `AC 29.2` lost on CI 44225232372 (`[ null, 2, null ]`). This is the contract
    // that replaces that read.
    const agreed = await cluster.awaitLeaderAgreement();

    expect(agreed.leaderId).toBe(leader.id);
    expect(agreed.attempts).toBeGreaterThanOrEqual(1);
    expect(agreed.elapsedMs).toBeGreaterThanOrEqual(0);
    // Agreement is about the group, so it is checked from every node, twice: once
    // through what the helper reported and once through what the nodes say.
    expect(await Promise.all(cluster.nodes.map((node) => node.adapter.getLeader()))).toEqual([
      agreed.leaderId,
      agreed.leaderId,
      agreed.leaderId,
    ]);
    expect(await leader.adapter.getTerm()).toBe(agreed.term);

    // A caller that supplies its own budget gets the same answer, with its own
    // timing rather than the harness defaults.
    const bounded = await cluster.awaitLeaderAgreement({ timeoutMs: 10_000, intervalMs: 25 });
    expect(bounded.leaderId).toBe(agreed.leaderId);
    expect(bounded.term).toBe(agreed.term);
  }, 60_000);

  it('reports the nodes left after excluding one', async () => {
    const leader = await cluster.findLeader();

    expect(cluster.remainingNodes(leader.id).map((n) => n.id)).toEqual([1, 2, 3].filter((id) => id !== leader.id));
  });

  it('does not hand back the excluded leader while it still leads', async () => {
    const leader = await cluster.findLeader();

    await expect(cluster.waitForNewLeader(leader.id)).rejects.toThrow(
      new RegExp(`No new leader after excluding ${leader.id}`),
    );
  });

  it('reports the commands a node has applied, and refuses an unknown node', async () => {
    const leader = await cluster.findLeader();
    const before = cluster.stateOf(leader.id);

    await leader.adapter.proposeAndWait('state-of-probe');

    // Applying is asynchronous by nature: the entry is committed before the
    // state machine has run it, so the accessor is polled rather than assumed.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !cluster.stateOf(leader.id).includes('state-of-probe')) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const after = cluster.stateOf(leader.id);
    expect(after).toContain('state-of-probe');
    expect(after.length).toBeGreaterThan(before.length);
    // A copy, so a caller cannot mutate the node's state through the accessor.
    after.push('mutated');
    expect(cluster.stateOf(leader.id)).not.toContain('mutated');

    expect(() => cluster.stateOf(99)).toThrow(/Node 99 is not running/);
  }, 60_000);

  it('rejects a kill for an id the cluster does not know', async () => {
    await expect(cluster.killNode(99)).rejects.toThrow(/Node 99 not found/);
  });

  it('drops a killed node and elects a replacement', async () => {
    const leader = await cluster.findLeader();

    await cluster.killNode(leader.id);

    expect(cluster.nodes.map((n) => n.id)).not.toContain(leader.id);
    expect(cluster.remainingNodes(leader.id)).toHaveLength(NODE_COUNT - 1);

    const successor = await cluster.waitForNewLeader(leader.id);
    expect(successor.id).not.toBe(leader.id);
    expect(await successor.adapter.isLeader()).toBe(true);
  });

  it('refuses to report the state of a node that has been killed', async () => {
    const leader = await cluster.findLeader();
    const victim = cluster.remainingNodes(leader.id)[0]!;
    await cluster.killNode(victim.id);

    expect(() => cluster.stateOf(victim.id)).toThrow(new RegExp(`Node ${victim.id} is not running`));
  }, 60_000);

  it('stops the remaining nodes and forgets the cluster', async () => {
    await cluster.stop();

    expect(cluster.nodes).toEqual([]);
    expect(cluster.dataDirs).toEqual([]);
    await expect(cluster.findLeader()).rejects.toThrow(/TestCluster not started/);
  });
});

describe('TestCluster port allocation', () => {
  /** A port another socket is holding, which is what a lost race looks like. */
  async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    return { port, release: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('retries with a fresh allocation when a port is taken between probe and bind', async () => {
    // getFreePorts closes its probe socket before returning, so the number it
    // hands out is a guess. On a busy runner two suites can be given the same
    // one; the loser used to die on EADDRINUSE inside a TLS server nobody
    // awaited, or come up a node short and time out waiting for a leader.
    const blocked = await occupyPort();
    let allocations = 0;

    const cluster = new TestCluster({
      nodeCount: 3,
      leaderTimeoutMs: 15_000,
      pollIntervalMs: 100,
      portAllocator: async (count) => {
        allocations++;
        if (allocations === 1) return [blocked.port, ...(await getFreePorts(count - 1))];
        return getFreePorts(count);
      },
    });

    try {
      await cluster.start();
      expect(allocations).toBe(2);
      expect((await cluster.findLeader()).id).toBeGreaterThan(0);
      expect(cluster.nodes.map((node) => node.port)).not.toContain(blocked.port);
    } finally {
      await cluster.stop();
      await blocked.release();
    }
  }, 120_000);

  it('does not retry a failure that is not a lost port race', async () => {
    let allocations = 0;
    const cluster = new TestCluster({
      nodeCount: 3,
      portAllocator: async () => {
        allocations++;
        throw Object.assign(new Error('allocator unavailable'), { code: 'EACCES' });
      },
    });

    await expect(cluster.start()).rejects.toThrow(/allocator unavailable/);
    expect(allocations).toBe(1);
  }, 60_000);
});

describe('TestCluster restart', () => {
  it('fails a restart whose node cannot reach its peers, naming both lists', async () => {
    // A node whose transport is listening but whose peers never re-dial it is the
    // worst kind of failure to debug: it is up, it accepts no traffic, and the
    // symptom shows up as an unrelated convergence timeout. The restart refuses
    // to call that success.
    const cluster = new TestCluster({ nodeCount: 3, leaderTimeoutMs: 20_000, pollIntervalMs: 100 });
    await cluster.start();

    try {
      await cluster.killNode(1);
      await cluster.killNode(3);
      // Node 2 itself has to be down for a restart; its peers are what it cannot
      // reach when it comes back.
      await cluster.killNode(2);

      await expect(cluster.restartNode(2, { connectivityTimeoutMs: 1500 })).rejects.toThrow(
        /Node 2 restarted but is connected to .* instead of \[1,3\]/,
      );
    } finally {
      await cluster.stop();
    }
  }, 120_000);
});
