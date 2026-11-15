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
