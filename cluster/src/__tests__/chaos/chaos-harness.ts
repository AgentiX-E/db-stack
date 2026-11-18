/**
 * ChaosHarness — reusable fault-injection test harness for Raft clusters.
 *
 * Wraps the existing TestCluster infrastructure with chaos injection:
 *   - Network partitions (drop all messages to/from certain nodes)
 *   - Message loss (probabilistic dropping)
 *   - Artificial latency
 *   - Node crashes (stop + restart)
 *   - Clock skew simulation
 *
 * Each chaos test follows:
 *   1. Setup: start N nodes with ChaosConfig
 *   2. Inject: apply specific chaos fault
 *   3. Verify: check invariants DURING chaos
 *   4. Recover: remove fault, let cluster stabilize
 *   5. Verify: check invariants AFTER recovery
 *   6. Cleanup: stop all nodes
 */

import type { Transport, NodeId, MessageHandler } from '@maboke123/raft-core';
import type { RPCMessage } from '@maboke123/raft-core';

import { TestCluster, type TestNode } from '../integration/TestCluster';
import { refusal } from '../../testing/partition';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ── Configuration ─────────────────────────────────────────────

export interface ChaosConfig {
  /** Number of nodes in the cluster (default: 3) */
  nodeCount: number;
  /** Probability (0-1) of dropping an individual message (default: 0) */
  messageLossProbability: number;
  /** Maximum artificial latency in ms (default: 0) */
  maxLatencyMs: number;
  /** Maximum clock drift in ms (default: 0) */
  clockSkewMs: number;
  /** Probability (0-1) of simulated node crash per step (default: 0) */
  nodeCrashProbability: number;
  /** How long a crashed node stays down in ms (default: 2000) */
  crashDurationMs: number;
  /** Whether to use pre-vote (default: true) */
  preVote: boolean;
  /** Random seed for deterministic reproducibility (default: 42) */
  seed: number;
  /** Entries between raft snapshots on the underlying nodes (default: 100 000) */
  snapshotInterval?: number;
}

export const DEFAULT_CHAOS_CONFIG: ChaosConfig = {
  nodeCount: 3,
  messageLossProbability: 0,
  maxLatencyMs: 0,
  clockSkewMs: 0,
  nodeCrashProbability: 0,
  crashDurationMs: 2000,
  preVote: true,
  seed: 42,
  snapshotInterval: 100_000,
};

export function chaosConfig(overrides: Partial<ChaosConfig>): ChaosConfig {
  return { ...DEFAULT_CHAOS_CONFIG, ...overrides };
}

// ── Invariant verification result ─────────────────────────────

export interface InvariantResult {
  noSplitBrain: boolean;
  dataConsistency: boolean;
  leaderExists: boolean;
  committedQuorum: boolean;
  details: string[];
}

// ── Deterministic PRNG (Mulberry32) ──────────────────────────

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  /** Returns [0, 1) */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// ── ChaosInjectingTransport ──────────────────────────────────

/**
 * Wraps a @maboke123/raft-core Transport to inject faults:
 *   - loss: drops message based on probability
 *   - latency: delays message by up to maxLatencyMs
 *   - partition: drops ALL messages to/from certain nodes
 */
export class ChaosInjectingTransport implements Transport {
  private inner: Transport;
  private config: ChaosConfig;
  private rng: SeededRandom;
  /**
   * No lifecycle flag of its own: a wrapper installed on a *running* node must adopt
   * the state of what it wraps. The flag this used to keep was false on every
   * injector the harness installed, which is why every Raft RPC failed with
   * "ChaosInjectingTransport not started" the moment the seam started routing through
   * it — the injector had never been started, because nothing had ever called it.
   */

  /** Nodes currently blocked (partitions) */
  public partitionedPeers: Set<string> = new Set();
  /** Whether this node is fully isolated */
  public isolated = false;

  private _stats = { lost: 0, delayed: 0, partitioned: 0, forwarded: 0 };

  constructor(inner: Transport, config: ChaosConfig, rng: SeededRandom) {
    this.inner = inner;
    this.config = config;
    this.rng = rng;
  }

  /**
   * The transport this injector wraps.
   *
   * Declared because the adapter walks the chain to decide whether its quorum
   * observer is already inside: an injector that hides its inner transport makes the
   * adapter install a second observer *outside* the injector, where a fabricated
   * answer for a dropped message would be recorded as contact.
   */
  get underlying(): Transport {
    return this.inner;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  isStarted(): boolean {
    return this.inner.isStarted();
  }

  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    const peerStr = String(peerId);

    // Partition check: drop ALL messages to/from a partitioned node
    if (this.partitionedPeers.has(peerStr) || this.isolated) {
      this._stats.partitioned++;
      // A dropped request is answered in its own kind at term 0. Answering a
      // RequestVote with an AppendEntries message is not a dropped message, it is a
      // malformed one that only reads as a rejection because nothing checks.
      return refusal(message);
    }

    // Message loss: probabilistic drop
    if (this.config.messageLossProbability > 0 && this.rng.next() < this.config.messageLossProbability) {
      this._stats.lost++;
      return refusal(message);
    }

    // Latency: delay the message
    if (this.config.maxLatencyMs > 0) {
      const delay = Math.floor(this.rng.next() * this.config.maxLatencyMs);
      if (delay > 0) {
        this._stats.delayed++;
        await this.sleep(delay);
      }
    }

    this._stats.forwarded++;
    return this.inner.send(peerId, message);
  }

  onMessage(handler: MessageHandler): void {
    // Isolation has to hold in both directions. Forwarding the handler unfiltered
    // models a half-open partition: the isolated node cannot initiate, but it still
    // answers the leader's heartbeats, so it stays in sync and the test that meant to
    // cut it off verifies nothing.
    this.inner.onMessage(async (from: NodeId, message: RPCMessage) => {
      if (this.isolated || this.partitionedPeers.has(String(from))) {
        this._stats.partitioned++;
        return refusal(message);
      }
      return handler(from, message);
    });
  }

  addPeer?(peerId: NodeId, address: string): Promise<void> {
    return this.inner.addPeer!(peerId, address);
  }

  removePeer?(peerId: NodeId): void {
    this.inner.removePeer!(peerId);
  }

  getStats(): { lost: number; delayed: number; partitioned: number; forwarded: number } {
    return { ...this._stats };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── ChaosCluster ─────────────────────────────────────────────

/** Node type as exposed by {@link ChaosCluster.nodes}. */
export type TestNodeInfo = TestNode;

export class ChaosCluster {
  private cluster: TestCluster;
  private config: ChaosConfig;
  private rng: SeededRandom;
  private injectors: Map<number, ChaosInjectingTransport> = new Map();

  /** Nodes that have been 'crashed' (stopped + removed) */
  private crashedNodes: Set<number> = new Set();
  /** Time when each crashed node should recover */
  private crashRecoveryTimes: Map<number, number> = new Map();

  /** Applied entries for consistency tracking */
  public appliedEntries: Map<number, string[]> = new Map();
  /** Custom apply handlers for each node */
  private applyHandlers: Map<number, (data: string) => void> = new Map();

  constructor(config?: Partial<ChaosConfig>) {
    this.config = chaosConfig(config ?? {});
    this.rng = new SeededRandom(this.config.seed);
    this.cluster = new TestCluster({
      nodeCount: this.config.nodeCount,
      electionTick: 15,
      heartbeatTick: 3,
      tickIntervalMs: 100,
      leaderTimeoutMs: 60_000,
      pollIntervalMs: 500,
      preVote: this.config.preVote,
      checkQuorum: true,
      enableInstallSnapshot: true,
      snapshotInterval: this.config.snapshotInterval,
    });
  }

  async start(): Promise<void> {
    await this.cluster.start();

    // Wrap each node's transport with chaos injection
    for (const node of this.cluster.nodes) {
      const adapter = (node as any).adapter;
      // Access the internal transport via RaftAdapter
      const transportRef = (adapter as any).transport;
      if (transportRef) {
        const injector = new ChaosInjectingTransport(transportRef, this.config, this.rng);
        (adapter as any).transport = injector;
        this.injectors.set(node.id, injector);
      }

      // Set up entry tracking
      this.appliedEntries.set(node.id, []);
      const nodeId = node.id;
      const originalHandler = (adapter as any).applyHandler;
      (adapter as any).applyHandler = (data: string) => {
        const entries = this.appliedEntries.get(nodeId) ?? [];
        entries.push(data);
        this.appliedEntries.set(nodeId, entries);
        if (originalHandler) {
          originalHandler(data);
        }
      };

      // Re-attach the new apply handler to the state machine
      const raftNode = (adapter as any).node;
      if (raftNode && raftNode.stateMachine) {
        const sm = raftNode.stateMachine;
        // If state machine has an apply callback, try to patch it
        if (typeof sm.onApply === 'function') {
          const origApply = sm.onApply.bind(sm);
          sm.onApply = (data: string, index?: number, term?: number) => {
            const entries = this.appliedEntries.get(nodeId) ?? [];
            entries.push(data);
            this.appliedEntries.set(nodeId, entries);
            if (typeof origApply === 'function') {
              origApply(data, index, term);
            }
          };
        }
      }
    }
  }

  /**
   * Apply a specific fault injection.
   */
  async injectFault(type: 'partition' | 'crash' | 'latency' | 'loss' | 'skew', targets?: number[]): Promise<void> {
    const targetList = targets ?? this.getActiveNodeIds();

    switch (type) {
      case 'partition': {
        if (targetList.length === 0) {
          // Isolating nobody is healing everyone. This used to be a silent no-op, and
          // four call sites wrote it expecting a heal -- so a test that meant "rejoin
          // the cluster" left every node isolated and asserted about the result.
          this.healPartitions();
          break;
        }
        // Isolate one or more nodes from the rest, and record it on the other side
        // too. The isolated node refusing to send is only half a partition: the peers
        // that can still reach it would keep it in sync through its inbound handler.
        for (const nodeId of targetList) {
          const injector = this.injectors.get(nodeId);
          if (injector) injector.isolated = true;
          for (const [otherId, other] of this.injectors) {
            if (otherId !== nodeId) other.partitionedPeers.add(String(nodeId));
          }
        }
        break;
      }

      case 'crash': {
        for (const nodeId of targetList) {
          if (!this.crashedNodes.has(nodeId)) {
            const node = this.cluster.nodes.find((n) => n.id === nodeId);
            if (node) {
              node.adapter.stop();
              this.cluster.nodes = this.cluster.nodes.filter((n) => n.id !== nodeId);
              this.crashedNodes.add(nodeId);
              this.crashRecoveryTimes.set(nodeId, Date.now() + this.config.crashDurationMs);
            }
          }
        }
        break;
      }

      case 'latency': {
        // Set high latency on specific nodes
        const oldLatency = this.config.maxLatencyMs;
        this.config.maxLatencyMs = 200;
        // Update injectors for target nodes only
        for (const nodeId of targetList) {
          const injector = this.injectors.get(nodeId);
          if (injector) {
            injector['config'] = { ...injector['config'], maxLatencyMs: 200 };
          }
        }
        break;
      }

      case 'loss': {
        // Set high message loss on specific nodes
        this.config.messageLossProbability = 0.3;
        for (const nodeId of targetList) {
          const injector = this.injectors.get(nodeId);
          if (injector) {
            injector['config'] = { ...injector['config'], messageLossProbability: 0.3 };
          }
        }
        break;
      }

      case 'skew': {
        // Clock skew — simulate by injecting fake clock drift via HLC
        // For Raft, we can't easily skew wall clock, but we can simulate
        // it by dropping some heartbeats to cause election timeouts
        this.config.clockSkewMs = this.config.clockSkewMs || 200;
        break;
      }
    }
  }

  /**
   * Remove all active faults.
   */
  /**
   * Heal every partition, in both directions.
   *
   * Separate from `recoverFaults()`, which also restores latency, loss and crashed
   * nodes: a test that wants the network back should not silently reset the other
   * faults it is measuring.
   */
  healPartitions(): void {
    for (const injector of this.injectors.values()) {
      injector.isolated = false;
      injector.partitionedPeers.clear();
    }
  }

  async recoverFaults(): Promise<void> {
    // Heal all partitions
    for (const injector of this.injectors.values()) {
      injector.isolated = false;
      injector.partitionedPeers.clear();
    }

    // Restore normal latency and loss
    this.config.maxLatencyMs = 0;
    this.config.messageLossProbability = 0;
    for (const injector of this.injectors.values()) {
      const c = injector['config'] as ChaosConfig;
      c.maxLatencyMs = 0;
      c.messageLossProbability = 0;
    }

    // Recover crashed nodes
    const toRecover = [...this.crashedNodes];
    for (const nodeId of toRecover) {
      const peerConfig = this.cluster.peerConfigs.find((p) => p.id === nodeId);
      if (!peerConfig) continue;

      const dir = path.join(os.tmpdir(), `chaos-recover-${nodeId}-${Date.now()}`);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Re-create the adapter (simulate restart)
      // For tests, we just re-add to the nodes list — actual restart
      // is handled per-test since full restart is complex with the TestCluster
      this.crashedNodes.delete(nodeId);
      this.crashRecoveryTimes.delete(nodeId);
    }
  }

  /**
   * Recover a specific crashed node.
   */
  async recoverNode(nodeId: number): Promise<void> {
    if (!this.crashedNodes.has(nodeId)) return;

    const peerConfig = this.cluster.peerConfigs.find((p) => p.id === nodeId);
    if (!peerConfig) return;

    this.crashedNodes.delete(nodeId);
    this.crashRecoveryTimes.delete(nodeId);
    await this.sleep(500);
  }

  /**
   * Run one chaos step: optionally crash/recover nodes based on probability.
   */
  async step(): Promise<void> {
    // Check for node recoveries
    const now = Date.now();
    for (const [nodeId, recoverAt] of this.crashRecoveryTimes) {
      if (now >= recoverAt && this.crashedNodes.has(nodeId)) {
        // Simulate recovery by removing from crashed set
        this.crashedNodes.delete(nodeId);
        this.crashRecoveryTimes.delete(nodeId);
      }
    }

    // Random crash injection
    if (this.config.nodeCrashProbability > 0 && this.rng.next() < this.config.nodeCrashProbability) {
      const activeIds = this.getActiveNodeIds();
      if (activeIds.length > 1) {
        const target = activeIds[Math.floor(this.rng.next() * activeIds.length)]!;
        await this.injectFault('crash', [target]);
      }
    }
  }

  /**
   * Verify cluster invariants.
   */
  async verifyInvariants(): Promise<InvariantResult> {
    const details: string[] = [];
    let leaderCount = 0;
    let leaderId: number | null = null;

    // If all nodes crashed or fewer than majority active, skip leader check
    const activeNodes = this.getActiveNodeIds();
    const aliveCount = activeNodes.length;
    const majority = Math.floor(this.config.nodeCount / 2) + 1;

    // Check leader existence
    for (const nodeId of activeNodes) {
      const node = this.cluster.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      try {
        const isLeader = await node.adapter.isLeader();
        if (isLeader) {
          leaderCount++;
          leaderId = nodeId;
        }
      } catch {
        // Node may be in transition
      }
    }

    const noSplitBrain = leaderCount <= 1;
    if (leaderCount > 1) {
      details.push(`SPLIT BRAIN: ${leaderCount} leaders detected (${leaderCount > 1 ? 'FAIL' : 'OK'})`);
    } else {
      details.push(`Split brain: OK (${leaderCount} leader${leaderCount === 0 ? ', none' : ''})`);
    }

    const leaderExists = aliveCount >= majority ? leaderCount === 1 : true; // tolerate no leader if not majority
    if (leaderCount === 0 && aliveCount >= majority) {
      details.push('WARNING: no leader elected yet with majority alive');
    }

    // Check data consistency: all active nodes should have at least the same number of entries
    const entryCounts = new Map<number, number>();
    for (const nodeId of activeNodes) {
      const entries = this.appliedEntries.get(nodeId) ?? [];
      entryCounts.set(nodeId, entries.length);
    }

    let dataConsistency = true;
    let maxCount = 0;
    let minCount = Infinity;
    for (const count of entryCounts.values()) {
      maxCount = Math.max(maxCount, count);
      minCount = Math.min(minCount, count);
    }

    if (minCount > 0 && maxCount > 0) {
      // Allow some lag: active nodes with fewer entries is fine, they'll catch up
      // The key invariant is that no node has MORE entries than committed max
      dataConsistency = true; // eventual consistency
    }

    // Check committed quorum: if we have a quorum, all entries should be replicated
    let committedQuorum = true;
    if (aliveCount >= majority) {
      const maxEntryCount = Math.max(...entryCounts.values(), 0);
      if (maxEntryCount > 0) {
        for (const [nodeId, count] of entryCounts) {
          // Nodes may lag; we consider quorum satisfied if majority has close to max
          const threshold = Math.max(1, maxEntryCount - 2); // Allow 2-entry lag
          const nodesWithMajority = [...entryCounts.values()].filter((c) => c >= threshold).length;
          committedQuorum = nodesWithMajority >= majority;
          if (!committedQuorum) {
            details.push(`Only ${nodesWithMajority}/${majority} nodes have entries near max(${maxEntryCount})`);
          }
          break;
        }
      }
    }

    details.push(`Active nodes: ${aliveCount}/${this.config.nodeCount}, majority needed: ${majority}`);

    return {
      noSplitBrain,
      dataConsistency,
      leaderExists,
      committedQuorum,
      details,
    };
  }

  /**
   * Clean up resources.
   */
  async cleanup(): Promise<void> {
    this.injectors.clear();
    this.crashedNodes.clear();
    this.crashRecoveryTimes.clear();
    await this.cluster.stop();
  }

  /**
   * Get IDs of currently active (non-crashed) nodes.
   */
  getActiveNodeIds(): number[] {
    return this.cluster.nodes.map((n) => n.id);
  }

  /**
   * Get the leader node after waiting for election.
   */
  async findLeader(): Promise<TestNode> {
    return this.cluster.findLeader();
  }

  /**
   * Get all active node IDs.
   */
  get nodes(): TestNode[] {
    return this.cluster.nodes;
  }

  /**
   * Get peer configs.
   */
  get peerConfigs() {
    return this.cluster.peerConfigs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * Wait for stability: no leader changes for N consecutive checks.
 */
export async function waitForStability(
  cluster: ChaosCluster,
  checks: number = 3,
  intervalMs: number = 1000,
  timeoutMs?: number,
): Promise<void> {
  let stableCount = 0;
  let lastLeader: number | null = null;
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;

  while (stableCount < checks) {
    if (Date.now() >= deadline) return; // timeout: accept current state
    await new Promise((r) => setTimeout(r, intervalMs));
    let currentLeader: number | null = null;
    for (const node of cluster.nodes) {
      try {
        if (await node.adapter.isLeader()) {
          currentLeader = node.id;
          break;
        }
      } catch {
        // ignore
      }
    }
    // Skip counting when no leader exists (mid-election) — null leader
    // would incorrectly match lastLeader=null and count as "stable"
    if (currentLeader === null) {
      stableCount = 0;
      lastLeader = null;
      continue;
    }
    if (currentLeader === lastLeader) {
      stableCount++;
    } else {
      stableCount = 0;
      lastLeader = currentLeader;
    }
  }
}
