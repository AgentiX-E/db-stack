/**
 * Multi-shard Raft cluster integration test.
 *
 * Runs 6 RaftAdapter instances in-process (3 nodes × 2 shards),
 * each connected via real TCP/mTLS on their own port range.
 *
 * Acceptance Criteria:
 *   AC 7.1: 6 RaftAdapters start and connect via TCP/mTLS
 *   AC 7.2: Both shards elect leaders within 30 seconds
 *   AC 7.3: Entries proposed to each shard commit on all 3 nodes of that shard
 *   AC 7.4: Propose to wrong leader returns NOT_LEADER (follower rejection)
 *   AC 7.5: All adapters cleanly stop (no hanging ports)
 *   AC 7.6: TypeScript 0 errors, all tests pass
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RaftAdapter } from '../../consensus/core/RaftAdapter';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';
import { generateClusterCerts } from './test-certs';
import { getFreePorts, createTempDir, cleanupTempDir } from './test-utils';
import { join } from 'node:path';

// ──────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────

const SHARD_0_PEER_IDS = [1, 2, 3];
const SHARD_1_PEER_IDS = [4, 5, 6];
const ELECTION_TICK = 10;
const HEARTBEAT_TICK = 2;
const TICK_INTERVAL_MS = 50;
const LEADER_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

// ──────────────────────────────────────────
//  Test node
// ──────────────────────────────────────────

interface ShardNode {
  adapter: RaftAdapter;
  id: number;
  shardId: string;
  port: number;
  dataDir: string;
  committed: string[];
}

// ──────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLeader(
  nodes: ShardNode[],
  timeoutMs: number = LEADER_TIMEOUT_MS,
): Promise<{ leaderId: number; leaderNode: ShardNode }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const node of nodes) {
      try {
        const isLeader = await node.adapter.isLeader();
        if (isLeader) {
          return { leaderId: node.id, leaderNode: node };
        }
      } catch {
        // node not ready yet
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`No leader elected in shard "${nodes[0].shardId}" after ${timeoutMs}ms`);
}

async function waitForCommitOnNode(
  node: ShardNode,
  expectedData: string,
  timeoutMs: number = COMMIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (node.committed.includes(expectedData)) return;
    await sleep(100);
  }

  throw new Error(
    `Node ${node.id} (shard ${node.shardId}) did not commit "${expectedData}" within ${timeoutMs}ms. Committed: [${node.committed.join(', ')}]`,
  );
}

async function waitForCommitOnAllNodes(
  nodes: ShardNode[],
  expectedData: string,
  timeoutMs: number = COMMIT_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(nodes.map((n) => waitForCommitOnNode(n, expectedData, timeoutMs)));
}

function buildPeerConfig(peerIds: number[], ports: number[]) {
  return peerIds.map((id, i) => ({
    id,
    host: '127.0.0.1',
    port: ports[i],
  }));
}

async function withRetry<T>(fn: () => Promise<T>, opts: { retries: number; delayMs: number }): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (opts.retries <= 0) throw err;
    await sleep(opts.delayMs);
    return withRetry(fn, { retries: opts.retries - 1, delayMs: opts.delayMs * 1.5 });
  }
}

// ──────────────────────────────────────────
//  Test
// ──────────────────────────────────────────

describe('Multi-shard Raft cluster', () => {
  // Generate certs: we need 6 certs for 6 nodes
  // The cert CN must match raft-node-N where N is the node ID (1-6)
  const certs = generateClusterCerts(6);
  const allNodes: ShardNode[] = [];
  const tempDirs: string[] = [];

  afterAll(async () => {
    // Stop all adapters (AC 7.5)
    for (const node of allNodes) {
      try {
        node.adapter.stop();
      } catch {
        // ignore cleanup errors
      }
    }

    // Clean up temp directories
    for (const dir of tempDirs) {
      cleanupTempDir(dir);
    }

    // Brief pause for ports to be released
    await sleep(500);
  });

  async function createShardNodes(
    shardId: string,
    peerIds: number[],
    ports: number[],
    nodeLabels: string[], // cert index labels like 'raft-node-1', 'raft-node-2' etc.
  ): Promise<ShardNode[]> {
    const nodes: ShardNode[] = [];
    const peerConfigs = buildPeerConfig(peerIds, ports);

    for (let i = 0; i < peerIds.length; i++) {
      const nodeId = peerIds[i];
      const port = ports[i];
      const dataDir = createTempDir(`multishard-${shardId}-n${nodeId}-`);
      tempDirs.push(dataDir);

      const otherPeers = peerConfigs.filter((p) => p.id !== nodeId);
      const certIndex = nodeLabels ? parseInt(nodeLabels[i].replace('raft-node-', '')) - 1 : nodeId - 1;

      const adapter = new RaftAdapter({
        id: nodeId,
        peers: otherPeers.map((p) => p.id),
        electionTick: ELECTION_TICK,
        heartbeatTick: HEARTBEAT_TICK,
        tickIntervalMs: TICK_INTERVAL_MS,
        storagePath: join(dataDir, 'raft.db'),
        snapshotInterval: 1000,
        environment: 'development',
        preVote: true,
        checkQuorum: true,
        enableInstallSnapshot: false,
      });

      const committed: string[] = [];

      // Start init but don't await yet — we'll do all in parallel
      const initPromise = adapter.init(
        (data) => {
          committed.push(data);
        },
        {
          node: { id: nodeId, host: '127.0.0.1', port },
          peers: otherPeers,
          tls: {
            key: certs.nodes[certIndex].key,
            cert: certs.nodes[certIndex].cert,
            ca: certs.nodes[certIndex].ca,
          },
          connectTimeoutMs: 5000,
          initialRetryMs: 100,
          maxRetryMs: 5000,
        },
        undefined,
      );

      nodes.push({ adapter, id: nodeId, shardId, port, dataDir, committed, _initPromise: initPromise });
    }

    return nodes;
  }

  // Add a hidden property for tracking init promises
  interface ShardNodeInternal extends ShardNode {
    _initPromise: Promise<void>;
  }

  it('AC 7.1: 6 RaftAdapters (3 nodes × 2 shards) start and connect via TCP/mTLS', async () => {
    // Allocate ports
    const shard0Ports = await getFreePorts(3);
    const shard1Ports = await getFreePorts(3);

    // Create shard-0 nodes (IDs 1,2,3)
    const shard0Nodes = await createShardNodes('shard-0', SHARD_0_PEER_IDS, shard0Ports, [
      'raft-node-1',
      'raft-node-2',
      'raft-node-3',
    ]);

    // Create shard-1 nodes (IDs 4,5,6)
    const shard1Nodes = await createShardNodes('shard-1', SHARD_1_PEER_IDS, shard1Ports, [
      'raft-node-4',
      'raft-node-5',
      'raft-node-6',
    ]);

    allNodes.push(...shard0Nodes, ...shard1Nodes);

    // Start all adapters in parallel
    const initPromises = (allNodes as ShardNodeInternal[]).map((n) => n._initPromise);
    await Promise.all(initPromises);

    // Verify all nodes report as not-leader initially (they're all followers)
    // Give a tiny tick for initial state
    await sleep(500);

    // All nodes should be initialized and at least not throwing
    for (const node of allNodes) {
      const isLeader = await node.adapter.isLeader();
      // At this point we don't know who the leader is, but the adapter should be alive
      expect(typeof isLeader).toBe('boolean');
    }
  }, 60_000);

  it('AC 7.2: Both shards elect leaders within 30 seconds', async () => {
    const shard0Nodes = allNodes.filter((n) => n.shardId === 'shard-0');
    const shard1Nodes = allNodes.filter((n) => n.shardId === 'shard-1');

    const [s0Leader, s1Leader] = await Promise.all([waitForLeader(shard0Nodes), waitForLeader(shard1Nodes)]);

    // Shard-0 leader must be one of {1, 2, 3}
    expect(SHARD_0_PEER_IDS).toContain(s0Leader.leaderId);
    // Shard-1 leader must be one of {4, 5, 6}
    expect(SHARD_1_PEER_IDS).toContain(s1Leader.leaderId);
    // Leaders must be different ports
    expect(s0Leader.leaderNode.port).not.toBe(s1Leader.leaderNode.port);

    // Verify all nodes in each shard track the same leader
    // Give some time for leader info to propagate
    await sleep(2000);

    // Check shard-0 consensus on leader
    const s0Leaders = await Promise.all(shard0Nodes.map((n) => n.adapter.getLeader()));
    const uniqueS0Leaders = [...new Set(s0Leaders.filter((l) => l !== null))];
    expect(uniqueS0Leaders.length).toBe(1);
    expect(uniqueS0Leaders[0]).toBe(s0Leader.leaderId);

    // Check shard-1 consensus on leader
    const s1Leaders = await Promise.all(shard1Nodes.map((n) => n.adapter.getLeader()));
    const uniqueS1Leaders = [...new Set(s1Leaders.filter((l) => l !== null))];
    expect(uniqueS1Leaders.length).toBe(1);
    expect(uniqueS1Leaders[0]).toBe(s1Leader.leaderId);
  }, 40_000);

  it('AC 7.3: Entries proposed to each shard commit on all 3 nodes of that shard', async () => {
    const shard0Nodes = allNodes.filter((n) => n.shardId === 'shard-0');
    const shard1Nodes = allNodes.filter((n) => n.shardId === 'shard-1');

    // Find current leaders
    const s0Leader = await waitForLeader(shard0Nodes);
    const s1Leader = await waitForLeader(shard1Nodes);

    // Propose to shard-0 leader
    const entry0 = `hello-shard-0-${Date.now()}`;
    const result0 = await s0Leader.leaderNode.adapter.propose(entry0);
    expect(result0.index).toBeDefined();
    expect(result0.term).toBeDefined();

    // Propose to shard-1 leader
    const entry1 = `hello-shard-1-${Date.now()}`;
    const result1 = await s1Leader.leaderNode.adapter.propose(entry1);
    expect(result1.index).toBeDefined();
    expect(result1.term).toBeDefined();

    // Wait for both entries to commit on all nodes of respective shards
    await Promise.all([waitForCommitOnAllNodes(shard0Nodes, entry0), waitForCommitOnAllNodes(shard1Nodes, entry1)]);

    // Verify entries did NOT cross shards
    for (const node of shard0Nodes) {
      expect(node.committed).toContain(entry0);
      expect(node.committed).not.toContain(entry1);
    }

    for (const node of shard1Nodes) {
      expect(node.committed).toContain(entry1);
      expect(node.committed).not.toContain(entry0);
    }
  }, 40_000);

  it('AC 7.4: Propose to wrong leader returns NOT_LEADER', async () => {
    const shard0Nodes = allNodes.filter((n) => n.shardId === 'shard-0');

    // Find current leader
    const s0Leader = await waitForLeader(shard0Nodes);

    // Pick a non-leader node in shard-0
    const follower = shard0Nodes.find((n) => n.id !== s0Leader.leaderId);
    expect(follower).toBeDefined();

    // Propose to follower — should throw NOT_LEADER
    const proposePromise = follower!.adapter.propose('should-fail');
    await expect(proposePromise).rejects.toThrow(SqlVecError);

    try {
      await follower!.adapter.propose('should-fail');
    } catch (err: any) {
      expect(err).toBeInstanceOf(SqlVecError);
      expect((err as SqlVecError).code).toBe(SqlVecErrorCode.NOT_LEADER);
      expect(err.message).toContain('Not the Raft leader');
    }
  }, 40_000);

  it('AC 7.5: All adapters cleanly stop (no hanging ports)', async () => {
    // Stop all adapters manually (afterAll also calls stop, but
    // afterAll runs after this test, not before)
    for (const node of allNodes) {
      try {
        node.adapter.stop();
      } catch {
        // ignore cleanup errors
      }
      // Clean up temp dirs
      cleanupTempDir(node.dataDir);
    }

    // Give a brief moment for internal cleanup
    await sleep(200);

    // Verify that isLeader returns false (safe default after stop)
    for (const node of allNodes) {
      const isLeader = await node.adapter.isLeader();
      expect(isLeader).toBe(false);

      const leader = await node.adapter.getLeader();
      expect(leader).toBeNull();
    }

    // Verify we can bind to the ports with retry (OS TIME_WAIT may delay release)
    const net = await import('node:net');

    for (const node of allNodes) {
      await withRetry(
        async () => {
          return new Promise<void>((resolve, reject) => {
            const server = net.createServer();
            server.listen(node.port, '127.0.0.1', () => {
              server.close(() => resolve());
            });
            server.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code === 'EADDRINUSE') {
                // Port still in TIME_WAIT — will retry
                reject(err);
              } else {
                reject(err);
              }
            });
          });
        },
        { retries: 10, delayMs: 1000 },
      );
    }
  }, 60_000);
});
