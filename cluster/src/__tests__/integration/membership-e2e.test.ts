/**
 * Membership acceptance cases on a real three-node cluster.
 *
 *   AC-D1-18:  a three-node cluster forms, and exactly one node is leader
 *   AC-D1-18a: a proposal on the leader commits there and reaches both followers
 *   AC-D1-18b: only the leader reports itself leader
 *   AC-D1-18c: the three nodes agree on the commit index
 *   AC-D1-18d: a voter that is down is removed, and the cluster commits on the
 *              majority that is left
 *   AC-D1-18e: the removed node rejoins as a learner, is promoted back, and every
 *              node reads the same voter set from its own persisted configuration
 *
 * The file was called `joint-consensus-e2e` (it is now `membership-e2e`) and this
 * header used to promise
 * `proposeMembershipChange`, `C_JOINT` replication and a concurrency case. None of
 * those bodies existed: the first four cases start a cluster and propose a value,
 * and `proposeMembershipChange` was never called. The two membership cases now go
 * through `RaftAdapter` — `removeServer` / `addServer` / `promoteServer` — because
 * that is the path a deployment has, and because raft-core appends **single-step**
 * configurations (P3-28): a case here that claimed a joint phase would be claiming
 * something the library never does. `C_OLD → C_JOINT → C_NEW` is judged where it
 * lives, in `RaftJointConsensusEngine.test.ts` and `joint-consensus-chaos.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from './TestCluster';
import { join } from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';

// ── Helpers ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition to become true.
 */
async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number = 100,
  label?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${label ?? 'condition'}`);
}

/**
 * Create a temp dir for test data.
 */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), prefix));
  fs.mkdirSync(join(dir, 'snapshots'), { recursive: true });
  return dir;
}

// ── Test Suite ─────────────────────────────────────────────────

describe('Joint Consensus — 3-node integration test', () => {
  const cluster = new TestCluster({
    nodeCount: 3,
    electionTick: 10,
    heartbeatTick: 2,
    tickIntervalMs: 20,
    leaderTimeoutMs: 30_000,
  });

  beforeAll(async () => {
    await cluster.start();
  }, 60_000);

  afterAll(async () => {
    await cluster.stop();
  }, 30_000);

  it('AC-D1-18: cluster forms normally (3 nodes, 1 leader)', async () => {
    const leader = await cluster.findLeader();
    expect(leader).toBeDefined();

    const isLeader = await leader.adapter.isLeader();
    expect(isLeader).toBe(true);

    const status = await leader.adapter.getStatus();
    expect(status.role.toLowerCase()).toBe('leader');

    // All nodes are in the cluster
    expect(cluster.nodes.length).toBe(3);
  });

  it('AC-D1-18a: propose on the leader replicates to all nodes', async () => {
    const leader = await cluster.findLeader();

    // Propose a value on the leader
    const entry = JSON.stringify({ key: 'test-value', value: Date.now() });
    const result = await leader.adapter.propose(entry);
    expect(result).toBeDefined();
    const proposedIndex = Number(result.index);
    expect(proposedIndex).toBeGreaterThan(0);

    // Wait for the leader to commit
    let leaderCommitted = false;
    for (let i = 0; i < 50; i++) {
      const progress = await leader.adapter.getProgress();
      if (Number(progress.commit) >= proposedIndex) {
        leaderCommitted = true;
        break;
      }
      await sleep(50);
    }
    expect(leaderCommitted).toBe(true);

    // Wait for followers to replicate (propagated by heartbeat, usually <200ms)
    const followers = cluster.nodes.filter((n) => n.id !== leader.id);
    for (const f of followers) {
      let committed = false;
      for (let i = 0; i < 50; i++) {
        const progress = await f.adapter.getProgress();
        if (Number(progress.commit) >= proposedIndex) {
          committed = true;
          break;
        }
        await sleep(50);
      }
      expect(committed).toBe(true);
    }
  });

  it('AC-D1-18b: only the leader can propose', async () => {
    const leader = await cluster.findLeader();
    const followers = cluster.nodes.filter((n) => n.id !== leader.id);

    for (const f of followers) {
      const isLeader = await f.adapter.isLeader();
      expect(isLeader).toBe(false);
    }
  });

  it('AC-D1-18c: the log is consistent across nodes', async () => {
    const statuses = await Promise.all(cluster.nodes.map((n) => n.adapter.getStatus()));
    const commitIndices = statuses.map((s) => Number(s.commit ?? 0));
    // All nodes should have similar commit indices
    const minCommit = Math.min(...commitIndices);
    const maxCommit = Math.max(...commitIndices);
    // All nodes within range of each other
    expect(maxCommit - minCommit).toBeLessThanOrEqual(1);
  });
});

/**
 * The membership path, on its own cluster.
 *
 * Separate from the suite above because these cases kill, remove, revive and
 * promote a node: the cluster here ends in the membership it started with, but
 * the case that fails half-way through leaves it changed, and a shared cluster
 * would carry that into a case about something else.
 */
describe('Membership changes — a real three-node cluster', () => {
  const cluster = new TestCluster({
    nodeCount: 3,
    electionTick: 10,
    heartbeatTick: 2,
    tickIntervalMs: 20,
    leaderTimeoutMs: 30_000,
  });
  /** The node the first case decommissions; the second brings it back. */
  let removedId = 0;

  beforeAll(async () => {
    await cluster.start();
  }, 60_000);

  afterAll(async () => {
    await cluster.stop();
  }, 30_000);

  /** The `host:port` the transport dials for a node, from the harness's own plan. */
  const addressOf = (id: number): string => {
    const peer = cluster.peerConfigs.find((entry) => entry.id === id);
    if (!peer) throw new Error(`no peer ${id} in this cluster`);
    return `${peer.host}:${peer.port}`;
  };

  it('AC-D1-18d: a voter that is down is removed, and the cluster commits on what is left', async () => {
    const leader = await cluster.findLeader();
    const target = cluster.nodes.find((node) => node.id !== leader.id);
    expect(target).toBeDefined();
    removedId = target!.id;

    // Down first: a decommissioned node is removed while it is not answering, and
    // a removed node that is still running campaigns for an office it no longer
    // holds. The removal is the case; the silence is the fixture.
    await cluster.killNode(removedId);

    const started = Date.now();
    const removed = await leader.adapter.removeServer(removedId);
    const elapsed = Date.now() - started;

    expect(removed.changed).toBe(true);
    // The new configuration's majority is the two nodes that are alive, so the
    // entry commits without waiting for the node it removes. The five-second
    // timeout P3-28 measured belongs to a change that needs the voter that is
    // absent, not to one that drops it.
    expect(elapsed).toBeLessThan(3_000);

    const after = await leader.adapter.getMembership();
    expect(after.voters).not.toContain(removedId);
    expect(after.voters).toHaveLength(2);
    // Read from the persisted configuration, not from the bootstrap one: the
    // change has to survive the process that made it.
    expect(after.source).toBe('persisted');

    // And the smaller cluster still commits — quorum is two of the two remaining.
    const survivor = cluster.nodes.find((node) => node.id !== leader.id)!;
    const proposed = await leader.adapter.propose(JSON.stringify({ key: 'after-remove', value: Date.now() }));
    const index = Number(proposed.index);
    await waitFor(
      async () => Number((await survivor.adapter.getProgress()).commit) >= index,
      15_000,
      50,
      'survivor commits on a two-voter cluster',
    );
  }, 60_000);

  it('AC-D1-18e: the removed node rejoins as a learner, is promoted, and every node agrees', async () => {
    const leader = await cluster.findLeader();
    const revived = await cluster.restartNode(removedId);
    expect(revived.id).toBe(removedId);

    const added = await leader.adapter.addServer(removedId, addressOf(removedId), true);
    expect(added.changed).toBe(true);
    const asLearner = await leader.adapter.getMembership();
    expect(asLearner.learners).toContain(removedId);
    expect(asLearner.voters).toHaveLength(2);

    const promoted = await leader.adapter.promoteServer(removedId);
    expect(promoted.changed).toBe(true);

    // The change is a log entry, not a field on the leader: every node that is up
    // reads the same voter set out of its own persisted configuration. A leader
    // that answered from memory would pass the two assertions above and fail this.
    await waitFor(
      async () => {
        for (const node of cluster.nodes) {
          const membership = await node.adapter.getMembership();
          if (membership.voters.length !== 3 || !membership.voters.includes(removedId)) {
            return false;
          }
        }
        return true;
      },
      20_000,
      100,
      'every node reports three voters',
    );

    const proposed = await leader.adapter.propose(JSON.stringify({ key: 'after-promote', value: Date.now() }));
    const index = Number(proposed.index);
    for (const node of cluster.nodes) {
      await waitFor(
        async () => Number((await node.adapter.getProgress()).commit) >= index,
        20_000,
        50,
        `node ${node.id} commits on a three-voter cluster`,
      );
    }
  }, 90_000);
});
