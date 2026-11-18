/**
 * Raft Transport Stress & Resilience Integration Tests
 *
 * Tests BatchedRaftTransport under stress conditions using a real 3-node
 * TCP/mTLS cluster. Each node runs as a child process with full Raft stack.
 *
 * These are heavy tests — they spawn processes, open real TCP ports, and
 * run sequential proposals. Timeouts are generous to accommodate actual
 * network and process startup delays.
 *
 * Modules:
 *   AC 8.11 — 1000 sequential propose + commit on 3-node cluster
 *   AC 8.12 — 100 concurrent proposals to leader
 *   AC 8.13 — Connection drop and reconnect (kill server port, restart)
 *   AC 8.14 — Log catch-up (start 2 nodes, propose 100, add 3rd)
 *   AC 8.15 — Partition scenario (isolate one node, heal, catch up)
 *   AC 8.16 — requestId collision under high PID counter
 *   AC 8.17 — a follower restarted on empty storage is back-filled from the leader
 *   AC 8.21 — a fourth node joins as a learner, is promoted, and then carries quorum
 *   AC 8.22 — a node nobody can reach is refused, and the cluster is unchanged
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { generateClusterCerts, type CertBundle, type TestClusterCerts } from './test-certs';
import { awaitAgreement, pollUntil } from '../../testing/convergence';

// ──────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────

const NODE_COUNT = 3;
// Absolute path — see raft-core.test.ts: a relative specifier resolves
// against the spawn cwd (package root) and never matched the real worker file.
const WORKER_PATH = path.resolve(__dirname, 'raft-core-worker.ts');
const LEADER_ELECTION_TIMEOUT = 20000;
const LOG_REPLICATION_TIMEOUT = 30000;
const STRESS_TIMEOUT = 120000;

/**
 * The floor under the "a node said it is ready" budget.
 *
 * A node is a real child process: `node --import tsx` has to transform the cluster
 * graph, open a SQLite store and load a TLS identity before it can answer. On a
 * development machine that is one to two seconds; on a two-core runner sharing the
 * box with four other vitest files it was measured well past fifteen — CI run
 * 44045755888 failed `AC 8.13` with `Timeout waiting for "ready" from node 1
 * (15000ms)`, and the node had printed only its first `DEP0123` line by then, so it
 * was starting, slowly, exactly as designed.
 *
 * A fixed number for that is the same mistake as the memory bounds that were
 * replaced in P3-6: it encodes an assumption about the machine and reports the
 * machine's health as the product's. The budget is therefore *derived* — from the
 * cold start this file has just measured for its own nodes — with this value as the
 * floor, so a machine that has never started a node still gets a usable number.
 */
const READY_FLOOR_MS = 15000;

// ──────────────────────────────────────────
//  Types
// ──────────────────────────────────────────

interface WorkerMessage {
  type: 'ready' | 'error' | 'leader-elected' | 'log-committed' | 'status' | 'exited' | 'info';
  nodeId: number;
  data?: any;
  timestamp: number;
}

interface TestNode {
  id: number;
  process: ChildProcess;
  messages: WorkerMessage[];
  port: number;
  dataDir: string;
}

interface PeerInfo {
  id: number;
  host: string;
  port: number;
}

// ──────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `raft-stress-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function createNode(
  id: number,
  port: number,
  peers: PeerInfo[],
  cert: CertBundle,
  dataDir: string,
  electionTick: number = 10,
  heartbeatTick: number = 3,
  customEnv?: Record<string, string>,
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
    cwd: path.resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      RAFT_NODE_CONFIG: nodeConfig,
      RAFT_CLUSTER_CONFIG: clusterConfig,
      ...customEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  cp.on('message', (msg: any) => {
    if (msg && msg.type) messages.push(msg as WorkerMessage);
  });

  // A child whose IPC channel closes while a message is in flight emits 'error' on
  // the ChildProcess, and an 'error' with no listener is thrown at process level:
  // vitest reported `ERR_IPC_CHANNEL_CLOSED` as an unhandled error attributed to
  // whichever test was running. Shutting a node down is expected to race with its own
  // channel closing, so the event is absorbed here and the exit is observed instead.
  cp.on('error', () => {});

  cp.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[node-${id}] ${d}`);
  });

  // pino writes to stdout, and this harness used to leave that pipe unread: the
  // diagnostics that would explain a failure were written into a pipe nobody
  // drained, which is why every investigation here started by patching this line in
  // temporarily. Off by default — a stress run emits a line per applied entry — and
  // switched on with RAFT_TEST_LOG=1 when something needs explaining.
  if (process.env.RAFT_TEST_LOG === '1') {
    cp.stdout?.on('data', (d: Buffer) => process.stdout.write(`[node-${id}:out] ${d}`));
  }

  return { id, process: cp, messages, port, dataDir };
}

async function waitForMessage(node: TestNode, type: string, timeoutMs: number = 15000): Promise<WorkerMessage> {
  const existing = node.messages.find((m) => m.type === type);
  if (existing) return existing;

  return new Promise((resolve, reject) => {
    // One listener per call, and it is removed on *both* exits. It used to be
    // removed only on the timeout, so every wait that succeeded left a listener on
    // the child process — a file with eleven of them logged
    // `MaxListenersExceededWarning: 11 message listeners added to [ChildProcess]`,
    // which is a leaked reference per wait and a handler running for messages
    // nobody is waiting for any more.
    const timer = setTimeout(() => {
      node.process.removeListener('message', handler);
      // What the node *did* say, and whether it is still alive: "timeout waiting
      // for ready" cannot be acted on, and the difference between a node that is
      // starting slowly and one that has exited is the whole question.
      const seen = [...new Set(node.messages.map((m) => m.type))];
      const state =
        node.process.exitCode !== null
          ? `exited with ${node.process.exitCode}`
          : node.process.killed
            ? 'killed'
            : 'still running';
      reject(
        new Error(
          `Timeout waiting for "${type}" from node ${node.id} (${timeoutMs}ms): ` +
            `process ${state}, messages seen [${seen.join(', ') || 'none'}]`,
        ),
      );
    }, timeoutMs);

    const handler = (msg: any) => {
      if (msg && msg.type === type) {
        clearTimeout(timer);
        node.process.removeListener('message', handler);
        resolve(msg as WorkerMessage);
      }
    };
    node.process.on('message', handler);
  });
}

async function waitForLeaderElection(nodes: TestNode[], timeoutMs: number = LEADER_ELECTION_TIMEOUT): Promise<number> {
  const promises = nodes.map((n) => waitForMessage(n, 'leader-elected', timeoutMs));
  // The first announcement is one node's answer, not the cluster's: every other
  // node learns the leader on the next heartbeat, and callers read those views
  // immediately afterwards. This used to be `sleep(500)` — a guess that happened
  // to be long enough on an idle machine.
  const result = await Promise.race(promises);
  await awaitLeaderAgreement(nodes, timeoutMs);
  return result.nodeId;
}

/** Poll the leader until its applied log reaches `target` (or time out). */
async function waitForLogLength(node: TestNode, target: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const stats = await getStatus(node);
    last = Number((stats as any).logLength ?? 0);
    if (last >= target) return last;
    await sleep(250);
  }
  return last;
}

/**
 * Every live node's view of who leads, required to agree within `timeoutMs`.
 *
 * `startCluster` returns as soon as the cluster has *a* leader; whether the other
 * nodes already know is a separate fact, and six tests in this file used to buy it
 * with `sleep(1000)`. A fixed pause is a guess in both directions — too short when
 * the runner is loaded, wasted time when the cluster is already quiet — and it
 * cannot tell "not yet" from "never". The agreement read can.
 */
async function awaitLeaderAgreement(nodeList: TestNode[], timeoutMs = LEADER_ELECTION_TIMEOUT): Promise<TestNode> {
  const live = nodeList.filter((n) => n.process.connected && !n.process.killed);
  if (live.length === 0) throw new Error('no live node to read a leader from');
  const { value } = await awaitAgreement(
    live.map((n) => async () => Number(((await getStatus(n)) as any)?.leader ?? 0)),
    {
      timeoutMs,
      label: `nodes ${live.map((n) => n.id).join(',')} naming one leader`,
      require: (leaderId) => leaderId > 0,
    },
  );
  const leader = live.find((n) => n.id === value[0]);
  if (!leader) throw new Error(`leader ${value[0]} is not a live node`);
  return leader;
}

/**
 * The leader's per-peer replication view, as the worker reports it.
 *
 * `{next, match}` is the only place a follower that is not being sent anything is
 * visible: from the follower's own side it looks like a healthy node waiting.
 */
async function peerProgress(node: TestNode): Promise<Record<string, { next: number; match: number }>> {
  const status = (await getStatus(node)) as any;
  return status?.peers ?? {};
}

/** What one node believes the committed configuration is, as the worker reports it. */
async function membershipOf(node: TestNode): Promise<{ voters: number[]; learners: number[]; source: string }> {
  const status = (await getStatus(node)) as any;
  return status?.membership ?? { voters: [], learners: [], source: 'unknown' };
}

/**
 * Ask a node to change the cluster's membership, and read its answer.
 *
 * The answer is a result, not an exception: "not the leader", "no quorum" and "the
 * address does not answer" are three different facts, and a caller that only sees
 * `false` cannot tell which of them it has to act on.
 */
async function membershipCommand(
  node: TestNode,
  command: 'add-server' | 'promote-server' | 'remove-server',
  data: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ changed: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.process.removeListener('message', handler);
      reject(new Error(`membership ${command} timed out on node ${node.id} (${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (msg: any) => {
      if (msg?.type === 'membership' && msg.data?.command === command) {
        clearTimeout(timer);
        node.process.removeListener('message', handler);
        resolve({ changed: Boolean(msg.data.changed), reason: msg.data.reason });
      }
    };

    node.process.on('message', handler);
    try {
      node.process.send?.({ command, data });
    } catch (err) {
      clearTimeout(timer);
      node.process.removeListener('message', handler);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Poll one node's applied log until it reaches `target`.
 *
 * Unlike {@link waitForLogLength} this fails instead of returning the last value it
 * saw: it is used to assert that a node which was restarted or freshly added has
 * caught up, and "still at 7 of 100" is a failure worth naming, with the count.
 */
async function awaitApplied(
  node: TestNode,
  target: number,
  timeoutMs: number = LOG_REPLICATION_TIMEOUT,
): Promise<number> {
  const { value } = await pollUntil(
    async () => Number(((await getStatus(node)) as any).logLength ?? 0),
    (length) => length >= target,
    { timeoutMs, label: `node ${node.id} applied log length >= ${target}` },
  );
  return value;
}

async function proposeToLeader(
  leaderNode: TestNode,
  data: string,
  nodeList: TestNode[] = [],
  redirectDepth: number = 0,
): Promise<{ index: number }> {
  return new Promise((resolve, reject) => {
    if (!leaderNode.process.connected || leaderNode.process.killed) {
      reject(new Error(`Node ${leaderNode.id} process disconnected`));
      return;
    }

    const timer = setTimeout(() => {
      try {
        leaderNode.process.removeListener('message', handler);
      } catch {
        /* ignore */
      }
      reject(new Error(`Propose timeout on node ${leaderNode.id}`));
    }, 30000);

    const handler = (msg: any) => {
      // Success: log committed
      if (msg && msg.type === 'log-committed') {
        clearTimeout(timer);
        try {
          leaderNode.process.removeListener('message', handler);
        } catch {
          /* ignore */
        }
        resolve({ index: msg.data?.index ?? 0 });
        return;
      }

      // Error from propose on follower — auto-redirect to current leader
      if (msg && msg.type === 'error' && msg.data?.command === 'propose' && msg.data?.currentLeader) {
        clearTimeout(timer);
        try {
          leaderNode.process.removeListener('message', handler);
        } catch {
          /* ignore */
        }

        // Limit redirect depth to prevent infinite loops during rapid leader changes
        if (redirectDepth >= 5) {
          reject(
            new Error(
              `Propose redirect exceeded max depth (5) on node ${leaderNode.id}, leader=${msg.data.currentLeader}`,
            ),
          );
          return;
        }

        const actualLeaderId = msg.data.currentLeader;
        const actualLeader = nodeList.find((n) => n.id === actualLeaderId);
        if (actualLeader && actualLeader.id !== leaderNode.id) {
          proposeToLeader(actualLeader, data, nodeList, redirectDepth + 1)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error(`Follower rejected, leader ${actualLeaderId} not found`));
        }
      }
    };

    leaderNode.process.on('message', handler);
    try {
      leaderNode.process.send?.({ command: 'propose', data });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

function getStatus(node: TestNode): Promise<any> {
  return new Promise((resolve) => {
    if (!node.process.connected || node.process.killed || node.process.exitCode !== null) {
      resolve({ logLength: 0, isLeader: false, leader: null, term: 0 });
      return;
    }
    const timer = setTimeout(() => resolve({ logLength: 0, isLeader: false, leader: null, term: 0 }), 10000);
    const handler = (msg: any) => {
      if (msg && msg.type === 'status') {
        clearTimeout(timer);
        try {
          node.process.removeListener('message', handler);
        } catch {
          /* ignore */
        }
        resolve(msg.data);
      }
    };
    try {
      node.process.on('message', handler);
      node.process.send?.({ command: 'get-status' });
    } catch {
      clearTimeout(timer);
      resolve({ logLength: 0 });
    }
  });
}

async function gracefulShutdown(node: TestNode): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        node.process.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 5000);
    node.process.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    // A node whose channel is already closed has nothing to receive the command; the
    // kill below is the whole shutdown.
    if (node.process.connected) {
      try {
        node.process.send?.({ command: 'shutdown' });
      } catch {
        /* ignore */
      }
    }
    // If process is already dead, resolve immediately
    setTimeout(() => {
      try {
        node.process.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 100);
  });
}

async function stopNodes(nodes: TestNode[]): Promise<void> {
  await Promise.all(nodes.map((n) => gracefulShutdown(n).catch(() => {})));
  await sleep(500);
}

// ──────────────────────────────────────────
//  Suite
// ──────────────────────────────────────────

describe('Raft Transport Stress & Resilience', () => {
  let certs: CertBundle[];
  let nodes: TestNode[] = [];
  let ports: number[] = [];

  /** The slowest cold start this file has measured, in milliseconds. */
  let coldStartMs = 0;

  /**
   * How long a node gets to say it is ready, on this machine, under this load.
   *
   * Four times the coldest start the file has seen, and never less than the floor:
   * a restart pays the same cost as a first start, and the measurement comes from
   * the nodes the same file just started, so a loaded runner raises its own budget
   * instead of failing and calling the product slow.
   */
  function readyBudgetMs(): number {
    return Math.max(READY_FLOOR_MS, coldStartMs * 4);
  }

  /** Discover the current leader node in the cluster */
  async function findLeader(): Promise<TestNode> {
    // Check each candidate; any node can tell us who the leader is
    for (const n of nodes) {
      if (n.process.killed || !n.process.connected) continue;
      const status = await getStatus(n);
      const leaderId = (status as any)?.leader;
      if (leaderId) {
        const leader = nodes.find((c) => c.id === leaderId);
        if (leader) return leader;
      }
    }
    throw new Error('No leader found');
  }

  /** Propose sequentially with leader re-discovery on failure */
  async function proposeInBatches(count: number, batchSize: number = 50): Promise<number> {
    let committed = 0;
    for (let i = 0; i < count; i += batchSize) {
      const leader = await findLeader();
      const remaining = Math.min(batchSize, count - i);
      for (let j = 0; j < remaining; j++) {
        await proposeToLeader(leader, `batch-entry-${i + j}`, nodes);
        committed++;
      }
    }
    return committed;
  }

  beforeAll(async () => {
    // One identity more than the cluster has: `AC 8.21` starts a fourth process to
    // join an existing three-node cluster, and mTLS verifies the peer id against the
    // certificate's SAN, so it needs a certificate of its own.
    const clusterCerts = generateClusterCerts(NODE_COUNT + 1);
    certs = clusterCerts.nodes;
  });

  afterAll(async () => {
    // Aggressive cleanup
    for (const node of nodes) {
      try {
        node.process.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    // Clean up data dirs
    for (const node of nodes) {
      cleanupTempDir(node.dataDir);
    }
    await sleep(200);
  });

  async function startCluster(
    count: number = NODE_COUNT,
    customEnv?: Record<string, string>,
    electionTick: number = 10,
    heartbeatTick: number = 3,
  ): Promise<number> {
    // Clean up previous
    await stopNodes(nodes);
    for (const n of nodes) cleanupTempDir(n.dataDir);
    nodes = [];

    ports = await Promise.all(Array.from({ length: count }, () => getFreePort()));

    const allPeerList: PeerInfo[] = [];
    for (let i = 0; i < count; i++) {
      allPeerList.push({ id: i + 1, host: '127.0.0.1', port: ports[i]! });
    }

    for (let i = 0; i < count; i++) {
      const id = i + 1;
      // Only pass OTHER nodes as peers (not self)
      const peers = allPeerList.filter((p) => p.id !== id);
      const dataDir = createTempDir(`node-${id}`);
      const node = createNode(id, ports[i]!, peers, certs[i]!, dataDir, electionTick, heartbeatTick, customEnv);
      nodes.push(node);
    }

    // Wait for all nodes to be ready — and, while waiting, measure what it cost:
    // every later restart in this file is budgeted from this number.
    const startedAt = Date.now();
    await Promise.all(nodes.map((n) => waitForMessage(n, 'ready', readyBudgetMs())));
    coldStartMs = Math.max(coldStartMs, Date.now() - startedAt);

    // Wait for leader election
    return await waitForLeaderElection(nodes, LEADER_ELECTION_TIMEOUT);
  }

  // ── AC 8.11: 1000 sequential proposals ──────────────────────────────

  it(
    'AC 8.11 — 1000 sequential propose + commit on 3-node cluster',
    async () => {
      await startCluster(3);

      // Propose 1000 entries in small concurrent batches
      // Small batch size avoids IPC message queue saturation on the worker process
      let committed = 0;
      const batchSize = 20;
      const perProposeTimeoutMs = 25000;

      for (let i = 0; i < 1000; i += batchSize) {
        const leader = await findLeader();
        const batchPromises: Promise<boolean>[] = [];
        const remaining = Math.min(batchSize, 1000 - i);
        for (let j = 0; j < remaining; j++) {
          batchPromises.push(
            proposeToLeader(leader, `batch-entry-${i + j}`, nodes)
              .then(() => true)
              .catch(() => false),
          );
        }
        // Wait for all propose attempts with individual timeouts.
        // Each proposeToLeader has its own 30s timeout; we use
        // per-propose granularity instead of per-batch to avoid
        // a single slow propose dropping the entire batch.
        const results = await Promise.all(batchPromises);
        const batchCommits = results.filter((r) => r).length;
        committed += batchCommits;
      }
      expect(committed).toBeGreaterThanOrEqual(950);

      // Cross-check: the leader's applied log must eventually reflect every
      // accepted proposal. Poll instead of sleeping a fixed amount: the worker's
      // status snapshot lags the commit stream by however long the remaining
      // entries take to commit+apply, which is load dependent.
      const finalLeader = await findLeader();
      const expectedMin = Math.max(Math.floor(committed * 0.5), 500);
      const converged = await waitForLogLength(finalLeader, expectedMin, 60_000);
      expect(converged).toBeGreaterThanOrEqual(expectedMin);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.12: 100 concurrent proposals ───────────────────────────────

  it(
    'AC 8.12 — 100 concurrent proposals to leader',
    async () => {
      await startCluster(3);

      const leader = await findLeader();

      // Send 100 proposals concurrently
      const promises: Promise<{ index: number }>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(proposeToLeader(leader, `concurrent-${i}`, nodes));
      }

      await Promise.all(promises);

      // Verify every proposal is committed and applied. `proposeToLeader`
      // resolves on the first `log-committed` broadcast, so it is not a
      // per-entry acknowledgement; convergence must be observed.
      const finalLeader = await findLeader();
      const logLength = await waitForLogLength(finalLeader, 100, 60_000);
      expect(logLength).toBeGreaterThanOrEqual(100);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.13: Connection drop and reconnect ──────────────────────────

  it(
    'AC 8.13 — connection drop and reconnect',
    async () => {
      await startCluster(3);

      const leader = await findLeader();

      // Propose some entries first (batch 1: 10 entries)
      await proposeToLeader(leader, 'pre-drop-1', nodes);
      await proposeToLeader(leader, 'pre-drop-2', nodes);
      await proposeToLeader(leader, 'pre-drop-3', nodes);

      // Get a non-leader node to kill
      const follower = nodes.find((n) => n.id !== leader.id)!;
      const followerPort = follower.port;

      // Kill the follower. Its storage stays on disk: a process that dies comes back
      // with its log, which is what this test is about.
      await gracefulShutdown(follower);

      // Majority should still function — propose more entries. What used to be
      // `sleep(1500)` is the surviving pair agreeing on who leads: with two of three
      // alive there is nothing to re-elect, but neither survivor may still be naming
      // the node that just went away.
      const currentLeader = await awaitLeaderAgreement(nodes);
      await proposeToLeader(currentLeader, 'post-drop-1', nodes);
      await proposeToLeader(currentLeader, 'post-drop-2', nodes);

      // Restart the killed node with same port
      const peerList: PeerInfo[] = [];
      for (const n of nodes) {
        if (n.id !== follower.id) {
          peerList.push({ id: n.id, host: '127.0.0.1', port: n.port });
        }
      }

      const newNode = createNode(follower.id, followerPort, peerList, certs[follower.id - 1]!, follower.dataDir);
      const idx = nodes.findIndex((n) => n.id === follower.id);
      nodes[idx] = newNode;

      // Wait for it to come online
      await waitForMessage(newNode, 'ready', readyBudgetMs());

      // The restarted node has to replay the log before it can be called caught up.
      // This was `sleep(2000)` + `sleep(5000)` followed by an assertion on a
      // *different* node: a restart that replayed nothing still passed, because the
      // survivor it checked had every entry all along.
      const caughtUp = await awaitApplied(newNode, 5);
      expect(caughtUp).toBeGreaterThanOrEqual(5);

      // The surviving pair kept every entry while the third node was gone.
      const survivors = nodes.filter((n) => n.id !== newNode.id);
      const survivorLengths = await Promise.all(
        survivors.map(async (n) => Number(((await getStatus(n)) as any).logLength ?? 0)),
      );
      for (const length of survivorLengths) expect(length).toBeGreaterThanOrEqual(5);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.14: Log catch-up ─────────────────────────────────────────

  it(
    'AC 8.14 — a follower that missed 100 entries catches up while the cluster keeps writing',
    async () => {
      await startCluster(3);

      const leader = await findLeader();
      for (let i = 0; i < 5; i++) await proposeToLeader(leader, `pre-catchup-${i}`, nodes);

      // Take a follower down and keep writing to the surviving pair. The restarted
      // node then has to replay what it missed *and* keep up with what arrives after
      // it rejoins — the shape a rolling restart produces in production.
      //
      // This replaces "start 2 nodes, propose 100, add a 3rd": that test spawned a
      // third process which was never added to the configuration, so nothing ever
      // replicated to it. Its 5 s sleep was followed by an assertion on the two nodes
      // that already held all 100 entries, and the property in its name was never
      // checked — a joiner that received nothing passed. Adding a node is a
      // membership change, which this harness cannot drive (P3-25).
      const follower = nodes.find((n) => n.id !== leader.id)!;
      const followerPort = follower.port;
      await gracefulShutdown(follower);

      const currentLeader = await awaitLeaderAgreement(nodes);
      for (let i = 0; i < 100; i++) await proposeToLeader(currentLeader, `catchup-${i}`, nodes);

      const peerList: PeerInfo[] = nodes
        .filter((n) => n.id !== follower.id)
        .map((n) => ({ id: n.id, host: '127.0.0.1', port: n.port }));
      const revived = createNode(follower.id, followerPort, peerList, certs[follower.id - 1]!, follower.dataDir);
      const idx = nodes.findIndex((n) => n.id === follower.id);
      nodes[idx] = revived;

      await waitForMessage(revived, 'ready', readyBudgetMs());

      // 5 proposals before the kill plus 100 after it, plus the entries the cluster
      // already had. The exact overlap is the leader's business; the floor is not.
      const caughtUp = await awaitApplied(revived, 103);
      expect(caughtUp).toBeGreaterThanOrEqual(103);

      // The pair that stayed up committed everything on its own.
      const leaderNow = await findLeader();
      const applied = await awaitApplied(leaderNow, 103);
      expect(applied).toBeGreaterThanOrEqual(103);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.15: Partition scenario ────────────────────────────────────

  it(
    'AC 8.15 — partition scenario (isolate, majority continues, heal, catch up)',
    async () => {
      await startCluster(3, undefined, 12, 4);

      const leader = await findLeader();

      // Propose 10 entries before partition
      for (let i = 0; i < 10; i++) {
        await proposeToLeader(leader, `pre-partition-${i}`, nodes);
      }

      // Isolate one node (a non-leader)
      const toIsolate = nodes.find((n) => n.id !== leader.id)!;
      await gracefulShutdown(toIsolate).catch(() => {});
      // Storage is left alone: the node comes back as itself, with its log.

      // Majority (leader + 1 other) continues — propose 10 more. The bound is the
      // survivors naming one leader without the node that just left; the old
      // `sleep(2000)` was a fixed guess at how long that takes.
      const leaderAfter = await awaitLeaderAgreement(nodes);
      for (let i = 0; i < 10; i++) {
        await proposeToLeader(leaderAfter, `post-partition-${i}`, nodes);
      }

      // Heal: restart the isolated node (rejoining existing cluster)
      const portNew = await getFreePort();
      const survivingPeers = nodes
        .filter((n) => n.id !== toIsolate.id)
        .map((n) => ({ id: n.id, host: '127.0.0.1', port: n.port }));

      const healedNode = createNode(toIsolate.id, portNew, survivingPeers, certs[toIsolate.id - 1]!, toIsolate.dataDir);
      const idx = nodes.findIndex((n) => n.id === toIsolate.id);
      nodes[idx] = healedNode;

      await waitForMessage(healedNode, 'ready', readyBudgetMs());

      // "Heal, catch up" is two claims and the test only made the first one: after a
      // 5 s sleep it checked the nodes that never left. The rejoined node is the one
      // that has to replay the 10 entries it missed while it was down.
      const healed = await awaitApplied(healedNode, 20);
      expect(healed).toBeGreaterThanOrEqual(20);

      // The nodes that stayed hold all 20 entries.
      const survivingAfter = nodes.filter((n) => n.id !== toIsolate.id);
      const survivedStatuses = await Promise.all(survivingAfter.map((n) => getStatus(n)));
      for (const s of survivedStatuses) {
        expect((s as any).logLength).toBeGreaterThanOrEqual(20);
      }
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.16: requestId collision under high PID counter ────────────

  it(
    'AC 8.16 — requestId collision under high counter from same PID',
    async () => {
      await startCluster(3);

      const leader = await findLeader();

      // Send 10 proposals, verifying correct requestId → response matching
      const count = 10;
      const promises: Promise<{ index: number }>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(proposeToLeader(leader, `collision-test-${i}`, nodes));
      }
      await Promise.all(promises);

      // Verify all committed on the leader. `proposeToLeader` resolves on the first
      // `log-committed` broadcast, not per entry, so a fixed 500 ms was the only
      // thing standing between "sent" and "applied" — and it is not a guarantee.
      const leaderNew = await findLeader();
      const applied = await awaitApplied(leaderNew, count);
      expect(applied).toBeGreaterThanOrEqual(count);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.17: a follower that lost its storage ──────────────────────

  it(
    'AC 8.17 — a follower restarted on empty storage is back-filled from the leader',
    async () => {
      await startCluster(3);

      const leader = await findLeader();
      for (let i = 0; i < 5; i++) await proposeToLeader(leader, `pre-wipe-${i}`, nodes);

      // The follower dies and its disk goes with it: same id, same port, no log at
      // all. That is a replaced disk rather than a restart, which `AC 8.13` covers,
      // and it is the case a leader's in-memory `matchIndex` cannot describe.
      const follower = nodes.find((n) => n.id !== leader.id)!;
      const followerPort = follower.port;
      await gracefulShutdown(follower);
      cleanupTempDir(follower.dataDir);

      // One entry the lost follower never saw, so the leader has something to send.
      const currentLeader = await awaitLeaderAgreement(nodes);
      await proposeToLeader(currentLeader, 'post-wipe', nodes);

      const peerList: PeerInfo[] = nodes
        .filter((n) => n.id !== follower.id)
        .map((n) => ({ id: n.id, host: '127.0.0.1', port: n.port }));
      const wipeDir = createTempDir(`node-${follower.id}-wiped`);
      const revived = createNode(follower.id, followerPort, peerList, certs[follower.id - 1]!, wipeDir);
      const idx = nodes.findIndex((n) => n.id === follower.id);
      nodes[idx] = revived;

      await waitForMessage(revived, 'ready', readyBudgetMs());

      // The leader still believes this peer holds the entries it acknowledged before
      // the disk was lost. Every rejection used to be clamped back to `matchIndex + 1`
      // by @maboke123/raft-core's LeaderState, so `{next: 5, match: 4}` was pinned for
      // 596 polls while the node applied nothing — see the patch in
      // `patches/@maboke123__raft-core@0.2.1.patch`. The back-fill is the assertion.
      const applied = await awaitApplied(revived, 6);
      expect(applied).toBeGreaterThanOrEqual(6);

      // And the leader has learned where the follower actually is. This view lags
      // the one above: an entry is applied on the revived node before the next
      // AppendEntries response carries its match index back, so a single read here
      // measures the scheduler rather than the protocol — it returned 0 on CI run
      // 44367992093 while `applied` had already reached 6. Wait for the leader's
      // own report instead of assuming it has caught up with what we just saw.
      const progress = await pollUntil(
        () => peerProgress(currentLeader),
        (reported) => (reported[follower.id]?.match ?? 0) >= 6,
        {
          timeoutMs: LOG_REPLICATION_TIMEOUT,
          label: `leader ${currentLeader.id} reports match >= 6 for node ${follower.id}`,
        },
      );
      expect(progress.value[follower.id]?.match).toBeGreaterThanOrEqual(6);
    },
    STRESS_TIMEOUT,
  );
  // ── AC 8.21: a node joins, is promoted, and then carries quorum ────

  it(
    'AC 8.21 — a fourth node joins as a learner, is promoted, and then carries quorum',
    async () => {
      await startCluster(3);

      const leader = await findLeader();
      for (let i = 0; i < 5; i++) await proposeToLeader(leader, `pre-join-${i}`, nodes);

      // A node addresses a cluster by being given its peers; it *becomes* a member
      // only when the leader appends a configuration that names it. This process is
      // started the way an operator starts one — own TLS identity, own disk, peers of
      // the cluster it wants to join — and is a stranger until the next step.
      const joinerPort = await getFreePort();
      const joinerPeers: PeerInfo[] = nodes.map((n) => ({ id: n.id, host: '127.0.0.1', port: n.port }));
      const joiner = createNode(4, joinerPort, joinerPeers, certs[3]!, createTempDir('node-4'));
      // Registered with the file's node list immediately, so a failure below still
      // kills the process in `afterAll` instead of leaving a child dialling a cluster
      // that is gone.
      nodes.push(joiner);
      await waitForMessage(joiner, 'ready', readyBudgetMs());

      expect(await membershipOf(leader)).toMatchObject({ voters: [1, 2, 3], learners: [] });

      const added = await membershipCommand(leader, 'add-server', {
        nodeId: 4,
        address: `127.0.0.1:${joinerPort}`,
        asLearner: true,
      });
      expect(added).toEqual({ changed: true, reason: undefined });

      // The claim "a node joined" is about every node's own view, not the leader's.
      // A configuration entry that reached nobody but the leader would still leave it
      // reporting a member, which is how this stayed invisible before.
      const agreed = await awaitAgreement(
        nodes.map((n) => async () => JSON.stringify(await membershipOf(n))),
        {
          timeoutMs: LOG_REPLICATION_TIMEOUT,
          label: 'every node naming the joined learner',
          require: (reported) => JSON.parse(reported).learners.includes(4),
        },
      );
      expect(JSON.parse(agreed.value[0]!)).toMatchObject({ voters: [1, 2, 3], learners: [4] });

      // And the newcomer holds the log that existed before it was a member: a
      // configuration is a promise that the member has the data, not that it will.
      const backfilled = await awaitApplied(joiner, 5);
      expect(backfilled).toBeGreaterThanOrEqual(5);

      const promoted = await membershipCommand(leader, 'promote-server', { nodeId: 4 });
      expect(promoted).toEqual({ changed: true, reason: undefined });

      await awaitAgreement(
        nodes.map((n) => async () => JSON.stringify(await membershipOf(n))),
        {
          timeoutMs: LOG_REPLICATION_TIMEOUT,
          label: 'every node naming the promoted voter',
          require: (reported) => {
            const membership = JSON.parse(reported);
            return membership.voters.includes(4) && membership.learners.length === 0;
          },
        },
      );

      // A voter is a voter only if a majority needs it. With four voters one of them
      // is killed, so three acknowledgements are required and the newcomer is one of
      // them: these proposals cannot commit unless it really counts.
      const casualty = nodes.find((n) => n.id !== leader.id && n.id !== 4)!;
      await gracefulShutdown(casualty);
      const survivors = () => nodes.filter((n) => n.id !== casualty.id);
      await awaitLeaderAgreement(survivors());

      const before = Number(((await getStatus(joiner)) as any).logLength ?? 0);
      for (let i = 0; i < 3; i++) await proposeToLeader(leader, `post-promotion-${i}`, nodes);

      const { value: carried } = await pollUntil(
        async () => Number(((await getStatus(joiner)) as any).logLength ?? 0),
        (length) => length >= before + 3,
        { timeoutMs: LOG_REPLICATION_TIMEOUT, label: `node 4 applying 3 entries as a voter (from ${before})` },
      );
      expect(carried).toBeGreaterThanOrEqual(before + 3);

      // Removing the dead member is a configuration change too, and it must commit
      // with the voters that are left.
      const removed = await membershipCommand(leader, 'remove-server', { nodeId: casualty.id });
      expect(removed).toEqual({ changed: true, reason: undefined });

      const { value: withoutCasualty } = await pollUntil(
        async () => JSON.stringify(await membershipOf(leader)),
        (reported) => !JSON.parse(reported).voters.includes(casualty.id),
        { timeoutMs: LOG_REPLICATION_TIMEOUT, label: `the leader forgetting node ${casualty.id}` },
      );
      expect(JSON.parse(withoutCasualty).voters).toEqual([1, 2, 3, 4].filter((id) => id !== casualty.id));

      // Three voters again, so two acknowledgements suffice — and the cluster serves.
      await proposeToLeader(leader, 'post-removal', nodes);
    },
    STRESS_TIMEOUT,
  );

  // ── AC 8.22: a member nobody can reach ─────────────────────────────

  it(
    'AC 8.22 — a node nobody can reach is refused, and the cluster is unchanged',
    async () => {
      await startCluster(3);

      const leader = await findLeader();
      for (let i = 0; i < 3; i++) await proposeToLeader(leader, `pre-refusal-${i}`, nodes);

      // A port the kernel just handed out and nothing is listening on: the address is
      // syntactically perfect and nobody answers. That is the case a transport which
      // silently accepts `addPeer` turns into a member the cluster can never send to.
      const unreachablePort = await getFreePort();
      const before = await membershipOf(leader);

      const refused = await membershipCommand(leader, 'add-server', {
        nodeId: 9,
        address: `127.0.0.1:${unreachablePort}`,
        asLearner: true,
      });

      expect(refused).toEqual({ changed: false, reason: 'unreachable' });
      expect(await membershipOf(leader)).toEqual(before);

      // Nothing half-applied is left behind: the leader still commits, and the
      // address it refused is not dialled for the rest of the run.
      await proposeToLeader(leader, 'after-refusal', nodes);
      const applied = await awaitApplied(leader, 4);
      expect(applied).toBeGreaterThanOrEqual(4);
    },
    STRESS_TIMEOUT,
  );
});
