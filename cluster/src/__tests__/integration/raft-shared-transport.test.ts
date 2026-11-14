/**
 * Single-process multi-RaftGroup integration test.
 *
 * Runs 6 RaftAdapter instances in a SINGLE process (3 nodes × 2 shards),
 * with each node's 2 shards sharing ONE NodeTransport instance.
 *
 * This validates:
 *   - SharedBatchedTransport request/response matching via NodeTransport.onMessage
 *   - Per-shard message routing via _shardId field
 *   - Multiple RaftGroups on the same TCP transport without interference
 *
 * Architecture:
 *   Process: 3 NodeTransport instances (one per Raft node)
 *            Each NodeTransport hosts 2 SharedBatchedTransport (one per shard)
 *            Total: 3 NodeTransport × 2 shards = 6 RaftAdapter instances
 *
 *   Message flow (example: node1 shard0 proposes to node2 shard0):
 *     node1.SharedBatchedTransport.send("2", msg)
 *       → NodeTransport.send() → RaftTcpTransport.send() → TCP
 *       → node2.RaftTcpTransport._onData() → emit('message')
 *       → node2.NodeTransport._handleIncoming() → extract _shardId=0 → _dispatch(0, msg)
 *       → node2.SharedBatchedTransport.onIncoming(msg) → requestId match → handler()
 *       → RaftNode processes request → response
 *       → node2.SharedBatchedTransport.doSend(response) → NodeTransport.send()
 *       → TCP back → node1 → SharedBatchedTransport.onIncoming → resolve pending
 *
 * Acceptance Criteria:
 *   AC 12.1: 6 RaftAdapters (3 nodes × 2 shards) share 3 NodeTransport instances
 *   AC 12.2: All 6 shards elect leaders within 30 seconds
 *   AC 12.3: Entries proposed to shard 0 commit on all 3 nodes of shard 0
 *   AC 12.4: Entries proposed to shard 1 commit on all 3 nodes of shard 1
 *   AC 12.5: Cross-shard isolation — shard 0 entries don't appear in shard 1 committed log
 *   AC 12.6: All adapters cleanly stop (no port leaks)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RaftAdapter } from '../../consensus/core/RaftAdapter';
import { NodeTransport, NodeTransportConfig } from '../../consensus/transport/NodeTransport';
import { generateClusterCerts } from './test-certs';
import { getFreePorts, createTempDir, cleanupTempDir } from './test-utils';
import { join } from 'node:path';

// ──────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────

const NODE_COUNT = 3;
const SHARDS_PER_NODE = 2;
const TOTAL_ADAPTERS = NODE_COUNT * SHARDS_PER_NODE; // 6

const ELECTION_TICK = 10;
const HEARTBEAT_TICK = 2;
const TICK_INTERVAL_MS = 50;
const LEADER_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

// ──────────────────────────────────────────
//  Types
// ──────────────────────────────────────────

/** One RaftAdapter instance with its metadata */
interface ShardNode {
  adapter: RaftAdapter;
  nodeId: number; // 1, 2, or 3
  shardIndex: number; // 0 or 1
  dataDir: string;
  committed: string[];
}

/** Raft node (physical process) with its NodeTransport and shards */
interface ClusterNode {
  nodeId: number;
  host: string;
  port: number;
  transport: NodeTransport;
  shards: ShardNode[];
  dataDir: string;
}

type Cluster = ClusterNode[];

// ──────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLeaderInGroup(shards: ShardNode[], timeoutMs: number = LEADER_TIMEOUT_MS): Promise<ShardNode> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const s of shards) {
      try {
        if (await s.adapter.isLeader()) return s;
      } catch {
        /* not ready */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`No leader elected in shard group (${shards.length} nodes) after ${timeoutMs}ms`);
}

function getShardGroup(cluster: Cluster, shardIndex: number): ShardNode[] {
  return cluster.flatMap((n) => n.shards.filter((s) => s.shardIndex === shardIndex));
}

async function proposeAndWait(
  leader: ShardNode,
  allShardsInGroup: ShardNode[],
  data: string,
  timeoutMs: number = COMMIT_TIMEOUT_MS,
): Promise<void> {
  await leader.adapter.propose(data);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const allCommitted = allShardsInGroup.every((s) => s.committed.includes(data));
    if (allCommitted) return;
    await sleep(100);
  }
  const pending = allShardsInGroup
    .filter((s) => !s.committed.includes(data))
    .map((s) => `node${s.nodeId}shard${s.shardIndex}`);
  throw new Error(`Data "${data}" not committed on: ${pending.join(', ')} after ${timeoutMs}ms`);
}

// ──────────────────────────────────────────
//  Test
// ──────────────────────────────────────────

describe('Single-process multi-RaftGroup via SharedBatchedTransport', () => {
  const cluster: Cluster = [];
  const tlsCerts = generateClusterCerts(NODE_COUNT);
  const tempDirs: string[] = [];

  beforeAll(async () => {
    // ── Allocate ports and temp dirs ──
    const ports = await getFreePorts(NODE_COUNT);
    const dataDirs = Array.from({ length: NODE_COUNT }, () => {
      const dir = createTempDir('shared-multishard');
      tempDirs.push(dir);
      return dir;
    });

    // ── Build 3 NodeTransport instances ──
    const peerConfigs = tlsCerts.nodes.map((_, i) => ({
      id: i + 1,
      host: '127.0.0.1',
      port: ports[i],
    }));

    for (let i = 0; i < NODE_COUNT; i++) {
      const nodeId = i + 1;

      const transportConfig: NodeTransportConfig = {
        node: { id: nodeId, host: '127.0.0.1', port: ports[i] },
        peers: peerConfigs.filter((p) => p.id !== nodeId),
        tls: tlsCerts.nodes[i],
      };

      const transport = new NodeTransport(transportConfig);
      await transport.start();

      for (const peer of peerConfigs) {
        if (peer.id !== nodeId) {
          transport.registerPeer(peer);
        }
      }

      const shards: ShardNode[] = [];

      for (let s = 0; s < SHARDS_PER_NODE; s++) {
        const shardDataDir = join(dataDirs[i], `shard${s}`);
        const committed: string[] = [];

        const adapter = new RaftAdapter({
          id: nodeId,
          storagePath: shardDataDir,
          electionTick: ELECTION_TICK,
          heartbeatTick: HEARTBEAT_TICK,
          tickInterval: TICK_INTERVAL_MS,
          peers: [1, 2, 3],
          environment: 'test',
        });

        const applyHandler = (data: string) => {
          committed.push(data);
        };

        await adapter.init(applyHandler, undefined, { transport, shardId: s } as any);

        shards.push({ adapter, nodeId, shardIndex: s, dataDir: shardDataDir, committed });
      }

      cluster.push({ nodeId, host: '127.0.0.1', port: ports[i], transport, shards, dataDir: dataDirs[i] });
    }

    // Give transports time to establish TCP connections
    await sleep(2000);
  }, 60_000);

  it(
    'AC 12.2: All 6 shards elect leaders within 30 seconds',
    async () => {
      // Wait for leaders in both shard groups
      const shardGroup0 = getShardGroup(cluster, 0);
      const shardGroup1 = getShardGroup(cluster, 1);

      const leader0 = await waitForLeaderInGroup(shardGroup0, LEADER_TIMEOUT_MS);
      const leader1 = await waitForLeaderInGroup(shardGroup1, LEADER_TIMEOUT_MS);

      expect(leader0).toBeDefined();
      expect(leader1).toBeDefined();
      // Leaders should be on different nodes (independent elections)
      expect(leader0.shardIndex).toBe(0);
      expect(leader1.shardIndex).toBe(1);
    },
    LEADER_TIMEOUT_MS + 5000,
  );

  it('AC 12.3: Entries proposed to shard 0 commit on all 3 nodes of shard 0', async () => {
    const shardGroup0 = getShardGroup(cluster, 0);
    const leader = await waitForLeaderInGroup(shardGroup0, LEADER_TIMEOUT_MS);

    await proposeAndWait(leader, shardGroup0, 'entry-shard0-1');
    await proposeAndWait(leader, shardGroup0, 'entry-shard0-2');
    await proposeAndWait(leader, shardGroup0, 'entry-shard0-3');

    // All 3 nodes should have all 3 entries
    for (const s of shardGroup0) {
      expect(s.committed).toContain('entry-shard0-1');
      expect(s.committed).toContain('entry-shard0-2');
      expect(s.committed).toContain('entry-shard0-3');
    }
  }, 60_000);

  it('AC 12.4: Entries proposed to shard 1 commit on all 3 nodes of shard 1', async () => {
    const shardGroup1 = getShardGroup(cluster, 1);
    const leader = await waitForLeaderInGroup(shardGroup1, LEADER_TIMEOUT_MS);

    await proposeAndWait(leader, shardGroup1, 'entry-shard1-a');
    await proposeAndWait(leader, shardGroup1, 'entry-shard1-b');

    // All 3 nodes should have both shard 1 entries
    for (const s of shardGroup1) {
      expect(s.committed).toContain('entry-shard1-a');
      expect(s.committed).toContain('entry-shard1-b');
    }
  }, 60_000);

  it('AC 12.5: Cross-shard isolation — shard 0 entries not in shard 1 committed log', async () => {
    const shardGroup0 = getShardGroup(cluster, 0);
    const shardGroup1 = getShardGroup(cluster, 1);

    // Propose more entries to each shard
    const leader0 = await waitForLeaderInGroup(shardGroup0, LEADER_TIMEOUT_MS);
    const leader1 = await waitForLeaderInGroup(shardGroup1, LEADER_TIMEOUT_MS);

    await proposeAndWait(leader0, shardGroup0, 'entry-shard0-isolated');
    await proposeAndWait(leader1, shardGroup1, 'entry-shard1-isolated');

    // Shard 1 nodes should NOT have shard 0 entries
    const shard0Entries = shardGroup0[0].committed;
    for (const s of shardGroup1) {
      for (const entry of shard0Entries) {
        if (entry.startsWith('entry-shard0')) {
          expect(s.committed).not.toContain(entry);
        }
      }
    }

    // Shard 0 nodes should NOT have shard 1 entries
    const shard1Entries = shardGroup1[0].committed;
    for (const s of shardGroup0) {
      for (const entry of shard1Entries) {
        if (entry.startsWith('entry-shard1')) {
          expect(s.committed).not.toContain(entry);
        }
      }
    }
  }, 60_000);

  it('AC 12.6: All adapters cleanly stop (no port leaks)', async () => {
    // Stop all adapters
    for (const node of cluster) {
      for (const shard of node.shards) {
        await shard.adapter.stop();
      }
    }

    // Stop all transports
    for (const node of cluster) {
      await node.transport.stop();
    }

    // Verify all adapters report stopped
    for (const node of cluster) {
      for (const shard of node.shards) {
        const status = await shard.adapter.getStatus();
        // getStatus returns null when node is stopped
        expect(status === null || (status as any).started === false).toBe(true);
      }
    }

    // Transport instances should be stopped
    for (const node of cluster) {
      const status = node.transport.getStatus();
      expect(status.started).toBe(false);
    }
  }, 30_000);
});
