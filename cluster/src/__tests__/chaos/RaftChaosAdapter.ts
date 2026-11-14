/**
 * RaftChaosAdapter — Bridges db-cluster's ChaosInjectingTransport to
 * the db-operations ChaosEngineV2 via the IChaosTransport contract.
 *
 * Each Raft node's network layer is wrapped by a ChaosInjectingTransport
 * (defined in chaos-harness.ts). This adapter exposes that transport
 * as an IChaosTransport so ChaosEngineV2 can inject faults without
 * knowing about Raft or @maboke123/raft-core internals.
 *
 * Naming convention:
 *   transportId = "raft:<nodeId>"  →  ChaosEngine targets via ["raft:1", "raft:3"]
 *
 * Invariants:
 *   RCHAOS1 — Adapter never throws on healAll; always safe to call
 *   RCHAOS2 — Stats accurately reflect ChaosInjectingTransport state
 *   RCHAOS3 — Zero new dependencies on Raft internals beyond transport ref
 */

import type { IChaosTransport, ChaosTransportStats, ChaosFaultV2 } from "@agentix-e/db-operations-chaosengine";

// ── Internal interface (what we receive from the harness) ────

export interface IChaosInjectingTransport {
  partitionedPeers: Set<string>;
  isolated: boolean;
  inner: { start(): Promise<void>; stop(): Promise<void>; isStarted(): boolean };
  getStats(): { lost: number; delayed: number; partitioned: number; forwarded: number };
  start?(): Promise<void>;
  stop?(): Promise<void>;
  isStarted?(): boolean;
}

// ── RaftChaosAdapter ────────────────────────────────────────

export class RaftChaosAdapter implements IChaosTransport {
  public readonly transportId: string;
  private readonly injector: IChaosInjectingTransport;
  private messageLossRate = 0;
  private currentLatencyMs = 0;
  private _stopped = false;

  constructor(nodeId: number, injector: IChaosInjectingTransport) {
    this.transportId = `raft:${nodeId}`;
    this.injector = injector;
  }

  isolate(peerTransportIds: string[]): void {
    for (const peerId of peerTransportIds) {
      const nodeId = this.parseNodeId(peerId);
      if (nodeId !== null) {
        this.injector.partitionedPeers.add(String(nodeId));
      }
    }
  }

  heal(peerTransportIds: string[]): void {
    for (const peerId of peerTransportIds) {
      const nodeId = this.parseNodeId(peerId);
      if (nodeId !== null) {
        this.injector.partitionedPeers.delete(String(nodeId));
      }
    }
  }

  healAll(): void {
    this.injector.isolated = false;
    this.injector.partitionedPeers.clear();
    this.messageLossRate = 0;
    this.currentLatencyMs = 0;
    this._stopped = false;
  }

  setMessageLoss(rate: number): void {
    this.messageLossRate = Math.max(0, Math.min(1, rate));
    const cfg = (this.injector as any).config;
    if (cfg) cfg.messageLossProbability = this.messageLossRate;
  }

  setLatency(ms: number): void {
    this.currentLatencyMs = Math.max(0, ms);
    const cfg = (this.injector as any).config;
    if (cfg) cfg.maxLatencyMs = this.currentLatencyMs;
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this.injector.isolated = true;
    try {
      if (this.injector.stop) await this.injector.stop();
      else await this.injector.inner.stop();
    } catch { /* best-effort */ }
  }

  async start(): Promise<void> {
    this._stopped = false;
    this.injector.isolated = false;
    try {
      if (this.injector.start) await this.injector.start();
      else await this.injector.inner.start();
    } catch { /* already started */ }
  }

  getStats(): ChaosTransportStats {
    const raw = this.injector.getStats();
    return {
      messagesSent: raw.forwarded,
      messagesLost: raw.lost,
      messagesDelayed: raw.delayed,
      partitioned: raw.partitioned,
      avgLatencyMs: this.currentLatencyMs,
      connectedPeers: this.injector.isolated ? 0 : 1,
      totalPeers: 1,
    };
  }

  isHealthy(): boolean {
    return !this._stopped
      && !this.injector.isolated
      && this.injector.partitionedPeers.size === 0
      && this.messageLossRate === 0
      && this.currentLatencyMs === 0;
  }

  private parseNodeId(transportId: string): number | null {
    const m = transportId.match(/^raft:(\d+)$/);
    return m ? parseInt(m[1]!, 10) : null;
  }
}

// ── Scenario Builders ───────────────────────────────────────

export class RaftChaosScenarios {
  static partition(targets: number[], durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "network-partition",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { raftNodes: targets },
      description: desc ?? `Partition nodes ${targets.join(", ")}`,
    };
  }

  static crash(targets: number[], durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "node-crash",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { raftNodes: targets },
      description: desc ?? `Crash nodes ${targets.join(", ")}`,
    };
  }

  static messageLoss(targets: number[], lossRate = 0.3, durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "message-loss",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { lossRate },
      description: desc ?? `${(lossRate * 100).toFixed(0)}% message loss on ${targets.join(", ")}`,
    };
  }

  static latency(targets: number[], latencyMs = 200, durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "latency-injection",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { latencyMs },
      description: desc ?? `${latencyMs}ms latency on ${targets.join(", ")}`,
    };
  }

  static leadershipFlap(targets: number[], durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "leadership-flap",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { raftNodes: targets },
      description: desc ?? `Leadership flap on ${targets.join(", ")}`,
    };
  }

  static cascadingFailure(targets: number[], staggerMs = 1000, durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "cascading-failure",
      targets: targets.map((n) => `raft:${n}`),
      durationMs,
      config: { staggerMs },
      description: desc ?? `Cascading failure ${targets.join(" → ")}`,
    };
  }

  static allNodes(): string[] {
    return ["raft:*"];
  }
}
