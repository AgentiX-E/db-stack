/**
 * TestCluster — In-process 3-node mTLS Raft cluster for integration & performance tests.
 *
 * Eliminates duplicated cluster setup in raft-stress, raft-chaos, raft-throughput-bench.
 *
 * Usage:
 *   const cluster = new TestCluster(nodeCount);
 *   await cluster.start();
 *   const leader = await cluster.findLeader();
 *   await cluster.stop();
 */

import { RaftAdapter } from '../consensus/core/RaftAdapter';
import { generateClusterCerts, type TestClusterCerts, type CertBundle } from './test-certs';
import { getFreePorts, createTempDir, cleanupTempDir, isPortFree } from './test-utils';
import { join } from 'node:path';
import * as fs from 'node:fs';

// ── Config ────────────────────────────────────────────────────────

export interface TestClusterOptions {
  nodeCount?: number; // default: 3
  electionTick?: number; // default: 15
  heartbeatTick?: number; // default: 3
  tickIntervalMs?: number; // default: 50
  leaderTimeoutMs?: number; // default: 30_000
  pollIntervalMs?: number; // default: 200
  /**
   * Entries between snapshots. Left unset by default so raft-core keeps its own
   * threshold: the harness used to carry a 100 000 default written when this option
   * only drove the group-level metadata loop, and forwarding that number to the
   * library switches snapshotting off for the whole run — which makes the
   * high-concurrency suites grow a 10 000-entry log and slow down by an order of
   * magnitude. Tests that want snapshots pass a small value.
   */
  snapshotInterval?: number;
  preVote?: boolean; // default: true
  checkQuorum?: boolean; // default: true
  enableInstallSnapshot?: boolean; // default: false
  /**
   * How the cluster picks its ports. Defaults to `getFreePorts`, which asks the OS
   * and cannot reserve what it is given — a test can inject an allocator that
   * returns a port another socket already holds to exercise the retry below.
   */
  portAllocator?: (count: number) => Promise<number[]>;
}

// ── Public types ──────────────────────────────────────────────────

export interface TestNode {
  adapter: RaftAdapter;
  port: number;
  id: number;
  dir: string;
  /**
   * Everything this node's state machine has applied, in order.
   *
   * A real cluster of this middleware runs a database engine behind the Raft
   * log; the harness keeps the smallest thing that behaves like one, because a
   * node with *no* application state takes 0-byte snapshots and every snapshot
   * test then passes without transferring a byte — which is how a snapshot
   * encoding defect survived a green suite. See `createAdapter` for the
   * serializer.
   */
  applied: string[];
}

// ── Defaults ──────────────────────────────────────────────────────

type ResolvedOptions = Required<Omit<TestClusterOptions, 'snapshotInterval' | 'portAllocator'>> &
  Pick<TestClusterOptions, 'snapshotInterval' | 'portAllocator'>;

const DEFAULTS: ResolvedOptions = {
  nodeCount: 3,
  electionTick: 15,
  heartbeatTick: 3,
  tickIntervalMs: 50,
  leaderTimeoutMs: 30_000,
  pollIntervalMs: 200,
  preVote: true,
  checkQuorum: true,
  enableInstallSnapshot: false,
};

/**
 * Attempts allowed when the OS hands back a port that is taken between the probe
 * and the bind. `getFreePorts` closes its probe socket before returning, so the
 * window is real: on a busy runner two workers can be handed the same number.
 * Retrying with a fresh allocation turns that into a slow start rather than a
 * five-minute timeout in whichever suite lost the race.
 */
const MAX_START_ATTEMPTS = 3;

/**
 * Whether a start failure is a lost port race rather than a real defect.
 *
 * Walks the cause chain: `RaftAdapter.init` reports every failure as a
 * `SqlVecError`, and the code that says EADDRINUSE lives on the error it wraps.
 */
function isAddressInUse(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === 'EADDRINUSE') return true;
    if (/EADDRINUSE/.test(String((current as { message?: unknown }).message ?? ''))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ── Cluster class ─────────────────────────────────────────────────

export class TestCluster {
  private opts: ResolvedOptions;
  private certs!: TestClusterCerts;
  private ports: number[] = [];
  private baseDir: string = '';
  /**
   * Temporary directories created for each node's Raft persistent storage.
   * Exposed for LTS tests to monitor store file growth.
   */
  public dataDirs: string[] = [];

  /** Currently active nodes. Empty until start() resolves. */
  public nodes: TestNode[] = [];
  /** Peer configurations (all nodes, for init()). */
  public peerConfigs: { id: number; host: string; port: number }[] = [];

  private _started = false;

  constructor(opts: TestClusterOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the cluster: allocate ports, generate certs, create + init
   * all RaftAdapters. Resolves once all nodes are initialized.
   *
   * `getFreePorts` cannot hold the ports it hands out, so a busy machine can give
   * the same number to two suites. That used to surface as `EADDRINUSE` thrown
   * from a TLS server nobody awaited — an uncaught exception that failed the whole
   * run — or, worse, as a cluster that came up one node short and then timed out
   * waiting for a leader. A lost race is retried with a fresh allocation.
   */
  async start(): Promise<void> {
    await this.ensureClean();
    this.certs = generateClusterCerts(this.opts.nodeCount);

    const allocate = this.opts.portAllocator ?? getFreePorts;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      try {
        await this.startAttempt(allocate);
        return;
      } catch (err) {
        lastError = err;
        // A node that did bind is still listening; its port is not the one that
        // collided, so the whole attempt is torn down before the next one.
        await this.stop();
        if (!isAddressInUse(err)) break;
      }
    }

    throw lastError;
  }

  /** One start attempt: allocate, create, init. Assigns `nodes` before init so a failure can be cleaned up. */
  private async startAttempt(allocate: (count: number) => Promise<number[]>): Promise<void> {
    this.ports = await allocate(this.opts.nodeCount);
    this.baseDir = createTempDir('test-cluster');
    this.dataDirs = Array.from({ length: this.opts.nodeCount }, (_, i) => {
      const d = join(this.baseDir, `node-${i + 1}`);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      return d;
    });
    this.peerConfigs = Array.from({ length: this.opts.nodeCount }, (_, i) => ({
      id: i + 1,
      host: '127.0.0.1',
      port: this.portAt(i),
    }));

    const instances: TestNode[] = [];
    for (let i = 0; i < this.opts.nodeCount; i++) {
      instances.push(this.createAdapter(i + 1));
    }

    this.nodes = instances;

    for (const inst of instances) {
      await this.initAdapter(inst);
    }

    this._started = true;
  }

  /**
   * Build (but do not start) node `id`'s adapter against its own data directory.
   *
   * Split from `initAdapter` so a restart reuses exactly the same construction:
   * a node that comes back with a different snapshot interval or election
   * configuration is not the node that went down, and the difference would be
   * invisible in a test that only checks that it caught up.
   */
  private createAdapter(id: number): TestNode {
    const i = id - 1;
    const nodePeers = this.peerConfigs.filter((p) => p.id !== id);
    const adapter = new RaftAdapter({
      id,
      peers: nodePeers.map((p) => p.id),
      electionTick: this.opts.electionTick,
      heartbeatTick: this.opts.heartbeatTick,
      tickIntervalMs: this.opts.tickIntervalMs,
      storagePath: join(this.dataDirAt(i), 'raft.db'),
      snapshotInterval: this.opts.snapshotInterval,
      environment: 'development',
      preVote: this.opts.preVote,
      checkQuorum: this.opts.checkQuorum,
      enableInstallSnapshot: this.opts.enableInstallSnapshot,
    });
    return { adapter, port: this.portAt(i), id, dir: this.dataDirAt(i), applied: [] };
  }

  /** Start one node's adapter and wait until it is listening. */
  private async initAdapter(node: TestNode): Promise<void> {
    const nodePeers = this.peerConfigs.filter((p) => p.id !== node.id);
    // Snapshot hooks have to exist before `init`: raft-core restores the
    // persisted snapshot while starting, so a handler registered afterwards
    // would miss the restore and leave the node blank behind a current
    // `lastApplied`. The serializer is deliberately trivial — the harness is not
    // a database, it only has to make the bytes non-empty and verifiable.
    node.adapter.setApplicationSnapshotHandlers({
      takeSnapshot: () => Buffer.from(JSON.stringify(node.applied), 'utf8'),
      installSnapshot: (data: Buffer) => {
        node.applied = JSON.parse(data.toString('utf8')) as string[];
      },
    });
    await node.adapter.init(
      (data: string) => {
        node.applied.push(data);
      },
      {
        node: { id: node.id, host: '127.0.0.1', port: node.port },
        peers: nodePeers,
        tls: {
          cert: this.certAt(node.id).cert,
          key: this.certAt(node.id).key,
          ca: this.certs.caPem,
        },
        connectTimeoutMs: 5000,
        initialRetryMs: 100,
        maxRetryMs: 5000,
      },
    );
  }

  /**
   * Stop all nodes and clean up temp dirs.
   */
  async stop(): Promise<void> {
    // Awaited: see `RaftAdapter.stop`. A node that is still shutting down holds
    // its port and its storage, so the next `start()` in the same test would race
    // its own previous incarnation.
    for (const n of this.nodes) {
      await n.adapter.stop();
    }
    this.nodes = [];
    for (const dir of this.dataDirs) {
      cleanupTempDir(dir);
    }
    this.dataDirs = [];
    this.ports = [];
    this._started = false;
  }

  // ── Leader queries ─────────────────────────────────────────

  /**
   * Wait for a leader to be elected. Throws if timeout reached.
   */
  async findLeader(): Promise<TestNode> {
    this.requireStarted();
    const deadline = Date.now() + this.opts.leaderTimeoutMs;
    while (Date.now() < deadline) {
      for (const n of this.nodes) {
        if (await n.adapter.isLeader()) return n;
      }
      await this.sleep(this.opts.pollIntervalMs);
    }
    throw new Error(`No leader elected within ${this.opts.leaderTimeoutMs}ms`);
  }

  /**
   * Wait for a new leader to emerge, excluding the given node id.
   */
  async waitForNewLeader(excludeId: number): Promise<TestNode> {
    this.requireStarted();
    const deadline = Date.now() + this.opts.leaderTimeoutMs;
    while (Date.now() < deadline) {
      for (const n of this.nodes) {
        if (n.id === excludeId) continue;
        if (await n.adapter.isLeader()) return n;
      }
      await this.sleep(this.opts.pollIntervalMs);
    }
    throw new Error(`No new leader after excluding ${excludeId}`);
  }

  /**
   * Kill a specific node (stop adapter + remove from active list).
   */
  async killNode(id: number): Promise<void> {
    this.requireStarted();
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node ${id} not found`);
    await node.adapter.stop();
    this.nodes = this.nodes.filter((n) => n.id !== id);
    // The socket is closed by now, but the OS releases the port asynchronously;
    // a restart that binds before that happens fails with EADDRINUSE and the node
    // comes up deaf, which reads as "the follower never caught up" in a test.
    await this.waitForPortRelease(node.port);
  }

  /** Poll until `port` can be bound again (or the deadline passes). */
  private async waitForPortRelease(port: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isPortFree(port)) return;
      await this.sleep(50);
    }
  }

  /**
   * Bring a killed node back, on its own port and its own data directory.
   *
   * This is the half of a fault injection that a kill-only harness cannot do, and
   * it is the half where snapshots matter: a follower that was down while the
   * leader compacted its log can only recover by *installing* a snapshot, not by
   * replaying entries. Before `restartNode` the harness could produce that
   * situation but never observe the recovery, so the transfer path was only
   * exercised by the multi-process acceptance suite.
   *
   * The node keeps the id, port and certificate it had, which means the peers
   * still address it the same way and the leader has to re-establish replication
   * with a node that is behind — exactly what a restart looks like in production.
   *
   * @param id Node to bring back; it must not be running.
   * @param options.connectivityTimeoutMs How long to wait for it to reach every
   *        peer (default 20 s). Shortening it is how the "came up deaf" failure
   *        is tested without spending the default budget.
   */
  async restartNode(id: number, options: { connectivityTimeoutMs?: number } = {}): Promise<TestNode> {
    this.requireStarted();
    if (this.nodes.some((n) => n.id === id)) {
      throw new Error(`Node ${id} is still running; kill it before restarting it`);
    }
    const node = this.createAdapter(id);
    await this.initAdapter(node);
    this.nodes = [...this.nodes, node];
    await this.waitForConnectivity(node, options.connectivityTimeoutMs);
    return node;
  }

  /**
   * Wait until a revived node holds a connection to every peer.
   *
   * A node whose transport is up but whose peers have not re-dialled it looks
   * exactly like a node that is up: it accepts no traffic, applies nothing, and
   * the symptom is a convergence timeout in whatever the test was measuring. The
   * wait turns that into a failure at the restart, where it belongs.
   */
  private async waitForConnectivity(node: TestNode, timeoutMs = 20_000): Promise<void> {
    const expected = this.peerConfigs.filter((p) => p.id !== node.id).map((p) => p.id);
    const deadline = Date.now() + timeoutMs;
    let connected: number[] = [];
    while (Date.now() < deadline) {
      connected = node.adapter.getConnectedPeers();
      if (expected.every((id) => connected.includes(id))) return;
      await this.sleep(100);
    }
    throw new Error(
      `Node ${node.id} restarted but is connected to ${JSON.stringify(connected)} instead of ${JSON.stringify(expected)} ` +
        `after ${timeoutMs}ms`,
    );
  }

  /**
   * Return remaining nodes (excluding a given id).
   */
  remainingNodes(excludeId: number): TestNode[] {
    return this.nodes.filter((n) => n.id !== excludeId);
  }

  /**
   * The commands the node with `id` has applied, in order.
   *
   * This is the harness's stand-in for an engine's visible state: two nodes that
   * agree on Raft's `lastApplied` but disagree here have diverged, which an index
   * comparison alone cannot detect — the exact false "caught up" that a 0-byte
   * snapshot produced.
   */
  stateOf(id: number): string[] {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node ${id} is not running`);
    return [...node.applied];
  }

  // ── Helpers ────────────────────────────────────────────────

  private async ensureClean(): Promise<void> {
    await this.stop();
    await this.sleep(500);
  }

  private requireStarted(): void {
    if (!this._started) {
      throw new Error('TestCluster not started — call start() first');
    }
  }

  /**
   * Port allocated for the i-th node. The array is sized from `nodeCount` in
   * start(), so every index used here is in range.
   */
  private portAt(i: number): number {
    return this.ports[i]!;
  }

  /** Temporary storage directory for the i-th node, allocated alongside the ports. */
  private dataDirAt(i: number): string {
    return this.dataDirs[i]!;
  }

  /** TLS material for node `id` (1-based), generated for exactly `nodeCount` nodes. */
  private certAt(id: number): CertBundle {
    return this.certs.nodes[id - 1]!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
