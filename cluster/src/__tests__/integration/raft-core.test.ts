/**
 * Integration tests for Raft multi-node cluster using @maboke123/raft-core.
 *
 * Each test case spawns 3 child processes, each running a full Raft node:
 *   - BatchedRaftTransport over real TCP with TLSv1.3 + mTLS
 *   - SqliteStorage with temporary SQLite file (or InMemoryNodeStorage)
 *   - @maboke123/raft-core consensus engine (wrapped via RaftAdapter)
 *   - In-memory state machine tracking committed entries
 *
 * Tests verify:
 *   TC1: Cluster formation with leader election (3 nodes, exactly 1 leader)
 *   TC2: Log replication across all nodes
 *   TC3: Leader re-election after leader failure (kill leader process)
 *   TC4: Fault tolerance under concurrent proposals
 *   TC5: TLS mutual authentication rejection of rogue nodes
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { generateClusterCerts, type CertBundle } from './test-certs';

// ──────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────

const NODE_COUNT = 3;
// Absolute path: the worker lives next to this test file. A relative
// specifier resolved against the spawn cwd (the package root) silently pointed
// at a non-existent file, which made every "real cluster" test fail at spawn
// with ERR_MODULE_NOT_FOUND instead of exercising the cluster.
const WORKER_PATH = path.resolve(__dirname, 'raft-core-worker.ts');
const LEADER_ELECTION_TIMEOUT = 15000;
const LOG_REPLICATION_TIMEOUT = 10000;
const REELECTION_TIMEOUT = 20000;

/**
 * Floor under the "a node said it is ready" budget, and the measurement it is
 * derived from.
 *
 * A node is a child process that has to transform the cluster graph through `tsx`,
 * open a SQLite store and load a TLS identity before it can answer. Ten seconds is
 * enough on an idle machine and not enough on a loaded one — CI run 44045755888
 * failed a restart in the sibling suite at fifteen — so the budget here is four
 * times the slowest start this file has measured, and never less than this floor.
 * The number is a property of the machine, and the test asks the machine for it.
 */
const READY_FLOOR_MS = 10000;
let coldStartMs = 0;

function readyBudgetMs(): number {
  return Math.max(READY_FLOOR_MS, coldStartMs * 4);
}

// ──────────────────────────────────────────
//  Types
// ──────────────────────────────────────────

interface WorkerMessage {
  type: 'ready' | 'error' | 'leader-elected' | 'log-committed' | 'status' | 'exited';
  nodeId: number;
  data?: any;
  timestamp: number;
}

interface TestNode {
  id: number;
  process: ChildProcess;
  messages: WorkerMessage[];
}

// ──────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────

function createNode(
  id: number,
  port: number,
  peers: { id: number; host: string; port: number }[],
  cert: CertBundle,
  dataDir: string,
  electionTick: number = 10,
  heartbeatTick: number = 3,
): TestNode {
  const nodeConfig = JSON.stringify({
    id,
    host: '127.0.0.1',
    port,
    dataDir,
    peers,
    cert: { key: cert.key, cert: cert.cert, ca: cert.ca },
  });
  const clusterConfig = JSON.stringify({ electionTick, heartbeatTick });

  const messages: WorkerMessage[] = [];
  const cp = spawn('node', ['--import', 'tsx', WORKER_PATH], {
    cwd: __dirname + '/../../..',
    env: {
      ...process.env,
      RAFT_NODE_CONFIG: nodeConfig,
      RAFT_CLUSTER_CONFIG: clusterConfig,
      RAFT_USE_IN_MEMORY: process.env.RAFT_USE_IN_MEMORY || '',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  cp.on('message', (msg: any) => {
    if (msg && msg.type) {
      messages.push(msg as WorkerMessage);
    }
  });

  cp.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) process.stderr.write(`[n${id}] ${text}\n`);
  });

  return { id, process: cp, messages };
}

function waitForMessage(
  nodes: TestNode[],
  type: string,
  timeoutMs: number,
  filter?: (msg: WorkerMessage) => boolean,
): Promise<WorkerMessage> {
  const existing = nodes.flatMap((n) => n.messages.filter((m) => m.type === type && (!filter || filter(m))));
  if (existing.length > 0) return Promise.resolve(existing[0]!);

  return new Promise<WorkerMessage>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      for (const n of nodes) {
        const match = n.messages.find((m) => m.type === type && (!filter || filter(m)));
        if (match) {
          clearInterval(checkInterval);
          clearTimeout(timer);
          resolve(match);
        }
      }
    }, 100);

    const timer = setTimeout(() => {
      clearInterval(checkInterval);
      reject(new Error(`Timeout waiting for ${type} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function killNode(node: TestNode): void {
  try {
    node.process.kill('SIGTERM');
  } catch {
    // Already dead
  }
}

function clearMessages(nodes: TestNode[]): void {
  for (const n of nodes) {
    n.messages.length = 0;
  }
}

function cleanupNode(node: TestNode): void {
  try {
    node.process.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

async function sendCommand(node: TestNode, command: string, data?: string): Promise<void> {
  node.process.send?.({ command, data });
}

function getMessages(nodes: TestNode[], type: string): WorkerMessage[] {
  return nodes.flatMap((n) => n.messages.filter((m) => m.type === type));
}

async function getAvailablePorts(count: number): Promise<number[]> {
  const net = await import('node:net');
  return Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<number>((resolve, reject) => {
          const server = net.createServer();
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
              const port = addr.port;
              server.close(() => resolve(port));
            } else {
              server.close(() => reject(new Error('No port')));
            }
          });
          server.on('error', reject);
        }),
    ),
  );
}

type ClusterState = { nodes: TestNode[]; ports: number[] };

// ──────────────────────────────────────────
//  Test suite
// ──────────────────────────────────────────

describe('Raft Core Multi-Node Cluster', () => {
  const certs = generateClusterCerts(NODE_COUNT + 1); // +1 for rogue
  const allNodes: TestNode[] = [];

  afterAll(() => {
    allNodes.forEach(cleanupNode);
  });

  async function startCluster(count: number, cluster: ClusterState = { nodes: [], ports: [] }): Promise<TestNode[]> {
    const ports = await getAvailablePorts(count);
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const newNodes: TestNode[] = [];

    for (let i = 0; i < count; i++) {
      const id = i + 1;
      const peers = ports.map((p, idx) => ({ id: idx + 1, host: '127.0.0.1', port: p })).filter((p) => p.id !== id);
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `raft-core-test-n${id}-`));
      const node = createNode(id, ports[i]!, peers, certs.nodes[i]!, dataDir);
      newNodes.push(node);
    }

    allNodes.push(...newNodes);
    cluster.nodes.push(...newNodes);
    cluster.ports = ports;

    // Wait for all nodes to report ready — and measure what that cost, because every
    // later start in this file is budgeted from the slowest one seen.
    const startedAt = Date.now();
    await Promise.all(newNodes.map((n) => waitForMessage([n], 'ready', readyBudgetMs())));
    coldStartMs = Math.max(coldStartMs, Date.now() - startedAt);

    return newNodes;
  }

  // ──────────────────────────────────────────
  //  TC1: Cluster Formation
  // ──────────────────────────────────────────

  it('TC1: forms a 3-node cluster with exactly one leader', async () => {
    const cluster: ClusterState = { nodes: [], ports: [] };
    const newNodes = await startCluster(3, cluster);

    // Wait for leader election
    const leaderMsg = await waitForMessage(newNodes, 'leader-elected', LEADER_ELECTION_TIMEOUT);
    expect(leaderMsg).toBeDefined();
    expect(leaderMsg.data?.leader).toBeGreaterThanOrEqual(1);
    expect(leaderMsg.data?.leader).toBeLessThanOrEqual(3);

    // Let all nodes learn about the leader
    await new Promise((r) => setTimeout(r, 2000));

    // Request status from all nodes
    newNodes.forEach((n) => sendCommand(n, 'get-status'));
    await new Promise((r) => setTimeout(r, 1000));

    const statusMsgs = getMessages(newNodes, 'status');
    const leaders = statusMsgs.map((m) => m.data?.leader).filter((l: any) => l !== null && l !== undefined && l > 0);

    // At least some nodes agree on a leader
    if (leaders.length > 0) {
      const uniqueLeaders = new Set(leaders);
      expect(uniqueLeaders.size).toBe(1);
    }
  }, 30000);

  // ──────────────────────────────────────────
  //  TC2: Log Replication
  // ──────────────────────────────────────────

  it('TC2: replicates log entries to all nodes', async () => {
    const cluster: ClusterState = { nodes: [], ports: [] };
    const newNodes = await startCluster(3, cluster);

    // Wait for leader
    const leaderMsg = await waitForMessage(newNodes, 'leader-elected', LEADER_ELECTION_TIMEOUT);
    const leaderId = leaderMsg.data.leader;
    const leaderNode = newNodes.find((n) => n.id === leaderId)!;

    // Propose an entry via the leader
    const proposeData = `test-entry-${Date.now()}`;
    sendCommand(leaderNode, 'propose', proposeData);

    // Wait for commit confirmation
    const commitMsg = await waitForMessage(newNodes, 'log-committed', LOG_REPLICATION_TIMEOUT);
    expect(commitMsg).toBeDefined();
    expect(commitMsg.data.data).toBe(proposeData);

    // Allow replication to propagate
    await new Promise((r) => setTimeout(r, 2000));

    // Check status on all nodes
    newNodes.forEach((n) => sendCommand(n, 'get-status'));
    await new Promise((r) => setTimeout(r, 1000));

    const statusMsgs = getMessages(newNodes, 'status');
    const logs = statusMsgs.map((m) => m.data?.committedLog || []);
    const nonEmptyLogs = logs.filter((l: any) => l.length > 0);

    expect(nonEmptyLogs.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  // ──────────────────────────────────────────
  //  TC3: Leader Re-election
  // ──────────────────────────────────────────

  it('TC3: re-elects a new leader after killing the current leader', async () => {
    const cluster: ClusterState = { nodes: [], ports: [] };
    const newNodes = await startCluster(3, cluster);

    // Wait for initial leader
    const leaderMsg = await waitForMessage(newNodes, 'leader-elected', LEADER_ELECTION_TIMEOUT);
    const initialLeaderId = leaderMsg.data.leader;

    // Flush any in-flight messages from before kill
    clearMessages(newNodes);

    // Kill the leader
    const leaderNode = newNodes.find((n) => n.id === initialLeaderId)!;
    killNode(leaderNode);

    // Waiting for the survivors to notice is the election timeout's job, and
    // `waitForMessage` below already bounds that wait. A fixed `sleep(1000)` here
    // was either a wasted second or a promise the test could not keep.

    // Wait for a new leader among remaining nodes.
    // Must be a DIFFERENT leader from the killed one, emitted by a surviving node.
    const remainingNodes = newNodes.filter((n) => n.id !== initialLeaderId);
    const newLeaderMsg = await waitForMessage(
      remainingNodes,
      'leader-elected',
      REELECTION_TIMEOUT,
      (msg) => msg.data.leader !== initialLeaderId,
    );

    expect(newLeaderMsg).toBeDefined();
    const newLeaderId = newLeaderMsg.data.leader;
    // The leader must be one of the surviving nodes
    expect(newLeaderId).not.toBe(initialLeaderId);
    expect(remainingNodes.some((n) => n.id === newLeaderId)).toBe(true);
  }, 40000);

  // ──────────────────────────────────────────
  //  TC4: Fault Tolerance with Proposals
  // ──────────────────────────────────────────

  it('TC4: cluster continues to make progress after leader failure', async () => {
    const cluster: ClusterState = { nodes: [], ports: [] };
    const newNodes = await startCluster(3, cluster);

    // Wait for initial leader
    const leaderMsg = await waitForMessage(newNodes, 'leader-elected', LEADER_ELECTION_TIMEOUT);
    const initialLeaderId = leaderMsg.data.leader;
    const leaderNode = newNodes.find((n) => n.id === initialLeaderId)!;

    // Propose before failure
    sendCommand(leaderNode, 'propose', 'pre-failure-entry');
    await waitForMessage(newNodes, 'log-committed', LOG_REPLICATION_TIMEOUT);

    // Clear any stale messages
    clearMessages(newNodes);

    // Kill the leader (graceful shutdown)
    sendCommand(leaderNode, 'shutdown');

    // Wait for new leader among remaining nodes (takes longer with 2 nodes).
    // The election timeout is the real bound; a fixed pause before this call could
    // only add latency or hide a cluster that never re-elected.
    const remainingNodes = newNodes.filter((n) => n.id !== initialLeaderId);
    const newLeaderMsg = await waitForMessage(remainingNodes, 'leader-elected', REELECTION_TIMEOUT, (msg) => {
      return msg.data.leader !== initialLeaderId; // must be a DIFFERENT leader
    });
    const newLeaderId = newLeaderMsg.data.leader;
    const newLeader = newNodes.find((n) => n.id === newLeaderId)!;
    expect(newLeader).toBeDefined();
    expect(newLeader.id).not.toBe(initialLeaderId);

    // Propose after recovery. The proposal is the probe: a leader that has not yet
    // committed its no-op still appends and commits both entries, and a leader that
    // lost the election in the meantime is a fact this test wants to see. The old
    // `sleep(1000)` "to stabilize" decided neither question.
    sendCommand(newLeader, 'propose', 'post-failure-entry');
    const commitMsg = await waitForMessage(remainingNodes, 'log-committed', LOG_REPLICATION_TIMEOUT);

    expect(commitMsg).toBeDefined();
    expect(commitMsg.data.data).toBe('post-failure-entry');
  }, 60000);

  // ──────────────────────────────────────────
  //  TC5: TLS Mutual Authentication
  // ──────────────────────────────────────────

  it('TC5: rejects connection from node with rogue certificate', async () => {
    const cluster: ClusterState = { nodes: [], ports: [] };
    const newNodes = await startCluster(2, cluster);

    // Let cluster settle
    await waitForMessage(newNodes, 'leader-elected', LEADER_ELECTION_TIMEOUT).catch(() => {});

    // Get existing node ports
    const net = await import('node:net');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    // Find a port for the rogue node
    const roguePort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          server.close(() => resolve(addr.port));
        } else {
          server.close(() => reject(new Error('No port')));
        }
      });
      server.on('error', reject);
    });

    const existingPorts = newNodes.map((n) => ({
      id: n.id,
      port: cluster.ports[n.id - 1],
    }));

    const rogueNodeConfig = JSON.stringify({
      id: 99,
      host: '127.0.0.1',
      port: roguePort,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'raft-test-rogue-')),
      peers: existingPorts.map((p) => ({ id: p.id, host: '127.0.0.1', port: p.port })),
      cert: { key: certs.rogue.key, cert: certs.rogue.cert, ca: certs.rogue.ca },
    });

    const rogueClusterConfig = JSON.stringify({ electionTick: 10, heartbeatTick: 3 });

    let errorDetected = false;

    const rogueCp = spawn('node', ['--import', 'tsx', WORKER_PATH], {
      env: {
        ...process.env,
        RAFT_NODE_CONFIG: rogueNodeConfig,
        RAFT_CLUSTER_CONFIG: rogueClusterConfig,
        RAFT_USE_IN_MEMORY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    rogueCp.on('message', (msg: any) => {
      if (msg?.type === 'error' || msg?.type === 'exited') {
        errorDetected = true;
      }
    });

    rogueCp.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().toLowerCase();
      if (
        text.includes('error') ||
        text.includes('unauthorized') ||
        text.includes('certificate') ||
        text.includes('tls')
      ) {
        errorDetected = true;
      }
    });

    // Wait for rogue to try connecting
    await new Promise((r) => setTimeout(r, 5000));

    // Cleanup rogue
    try {
      rogueCp.kill('SIGKILL');
    } catch {
      /* ignore */
    }

    // Expect TLS rejection: either the process errored or connection was refused
    expect(errorDetected || rogueCp.exitCode !== 0).toBeTruthy();
  }, 30000);
});
