/**
 * FederationChaosAdapter — Bridges db-federation's PartitioningTransport
 * to the db-operations ChaosEngineV2 via IChaosTransport contract.
 *
 * Each federation node uses a PartitioningTransport that supports DC-level
 * and peer-level partitioning, message loss, and latency injection.
 * This adapter exposes those capabilities as IChaosTransport.
 *
 * Transport ID convention: "federation:<dcId>:<nodeId>" (e.g. "federation:dc-1:node-1")
 * Wildcard: "federation:*" → all federation nodes
 * DC wildcard: "federation:dc:dc-1" → all nodes in dc-1
 *
 * Invariants:
 *   FCHAOS1 — Adapter never throws on healAll; always safe
 *   FCHAOS2 — DC-level partition maps to partitionedDcs correctly
 *   FCHAOS3 — Zero new dependencies beyond PartitioningTransport ref
 */

import type {
  IChaosTransport,
  ChaosTransportStats,
  ChaosFaultV2,
} from "@agentix-e/db-operations-chaosengine";

// ── Internal interface for PartitioningTransport ─────────────

export interface IPartitioningTransport {
  dcId: string;
  partitionedDcs: Set<string>;
  partitionedPeers: Set<string>;
  isolated: boolean;
  inner: {
    destroy(): void;
    getStats?(): { messagesSent?: number; messagesLost?: number; avgLatencyMs?: number };
    getConnectedPeers?(): { peerId: string }[];
  };
}

// ── Adapter ─────────────────────────────────────────────────

export class FederationChaosAdapter implements IChaosTransport {
  public readonly transportId: string;
  private readonly transport: IPartitioningTransport;
  private readonly nodeId: string;
  private readonly dcId: string;
  private messageLossRate = 0;
  private currentLatencyMs = 0;
  private _stopped = false;

  /**
   * @param nodeId — e.g. "dc-1/node-1"
   * @param transport — the PartitioningTransport wrapping this node
   */
  constructor(nodeId: string, transport: IPartitioningTransport) {
    // nodeId format: "dc-1/node-1" → transportId: "federation:dc-1:node-1"
    this.transportId = `federation:${nodeId.replace("/", ":")}`;
    this.transport = transport;
    this.nodeId = nodeId;
    this.dcId = transport.dcId;
  }

  // ── Partition ──────────────────────────────────────────

  isolate(peerTransportIds: string[]): void {
    for (const peerId of peerTransportIds) {
      const parsed = this.parseTransportId(peerId);
      if (!parsed) continue;

      if (parsed.type === "dc") {
        // Isolate from an entire DC
        this.transport.partitionedDcs.add(parsed.dcId!);
      } else if (parsed.type === "node") {
        // Isolate from a specific peer
        const peerName = `${parsed.dcId}/node-${parsed.nodeIndex}`;
        this.transport.partitionedPeers.add(peerName);
      }
    }
  }

  heal(peerTransportIds: string[]): void {
    for (const peerId of peerTransportIds) {
      const parsed = this.parseTransportId(peerId);
      if (!parsed) continue;

      if (parsed.type === "dc") {
        this.transport.partitionedDcs.delete(parsed.dcId!);
      } else if (parsed.type === "node") {
        const peerName = `${parsed.dcId}/node-${parsed.nodeIndex}`;
        this.transport.partitionedPeers.delete(peerName);
      }
    }
  }

  healAll(): void {
    this.transport.partitionedDcs.clear();
    this.transport.partitionedPeers.clear();
    this.transport.isolated = false;
    this.messageLossRate = 0;
    this.currentLatencyMs = 0;
    this._stopped = false;
    // Reset latency + loss config
    const cfg = (this.transport as any).config ?? {};
    cfg.dcLatencyMs = 0;
    cfg.dcMessageLossProbability = 0;
    (this.transport as any).config = cfg;
  }

  // ── Message Loss ───────────────────────────────────────

  setMessageLoss(rate: number): void {
    this.messageLossRate = Math.max(0, Math.min(1, rate));
    const cfg = (this.transport as any).config ?? {};
    cfg.dcMessageLossProbability = this.messageLossRate;
    (this.transport as any).config = cfg;
  }

  // ── Latency Injection ──────────────────────────────────

  setLatency(ms: number): void {
    this.currentLatencyMs = Math.max(0, ms);
    const cfg = (this.transport as any).config ?? {};
    cfg.dcLatencyMs = this.currentLatencyMs;
    (this.transport as any).config = cfg;
  }

  // ── Lifecycle ──────────────────────────────────────────

  async stop(): Promise<void> {
    this._stopped = true;
    this.transport.isolated = true;
    try {
      this.transport.inner.destroy();
    } catch { /* best-effort */ }
  }

  async start(): Promise<void> {
    this._stopped = false;
    this.transport.isolated = false;
    // PartitioningTransport has no explicit start — it's always active
  }

  // ── Stats ──────────────────────────────────────────────

  getStats(): ChaosTransportStats {
    const innerStats = this.transport.inner.getStats?.() ?? {};
    const connectedPeers = this.transport.inner.getConnectedPeers?.() ?? [];

    return {
      messagesSent: innerStats.messagesSent ?? 0,
      messagesLost: innerStats.messagesLost ?? 0,
      messagesDelayed: 0, // PartitioningTransport handles delay internally
      partitioned:
        this.transport.partitionedDcs.size + this.transport.partitionedPeers.size,
      avgLatencyMs: this.currentLatencyMs,
      connectedPeers: this.transport.isolated || this._stopped
        ? 0
        : connectedPeers.length,
      totalPeers: connectedPeers.length + 1, // +1 for self
    };
  }

  isHealthy(): boolean {
    return !this._stopped
      && !this.transport.isolated
      && this.transport.partitionedDcs.size === 0
      && this.transport.partitionedPeers.size === 0
      && this.messageLossRate === 0
      && this.currentLatencyMs === 0;
  }

  // ── Parsing ────────────────────────────────────────────
  // federation:<dcId>:<nodeId>
  // federation:dc:<dcId>         — all nodes in a DC
  // federation:*                 — all nodes

  private parseTransportId(
    id: string,
  ): { type: "node"; dcId: string; nodeIndex: number } | { type: "dc"; dcId: string; nodeIndex?: never } | null {
    if (!id.startsWith("federation:")) return null;
    const rest = id.slice("federation:".length);

    // Wildcard
    if (rest === "*") {
      // Return a DC-type match for the adapter's own DC — the engine handles fan-out
      return { type: "dc", dcId: this.dcId };
    }

    // DC-level: "dc:<dcId>"
    const dcMatch = rest.match(/^dc:(.+)$/);
    if (dcMatch) {
      return { type: "dc", dcId: dcMatch[1]! };
    }

    // Node-level: "<dcId>:<nodeIndex>" (e.g. "dc-1:1")
    const nodeMatch = rest.match(/^(.+):(\d+)$/);
    if (nodeMatch) {
      return { type: "node", dcId: nodeMatch[1]!, nodeIndex: parseInt(nodeMatch[2]!, 10) };
    }

    return null;
  }
}

// ── Federation Scenario Builder ─────────────────────────────

export class FederationChaosScenarios {
  /** Partition entire DC from all others */
  static dcPartition(
    dcId: string,
    durationMs = 0,
    desc?: string,
  ): ChaosFaultV2 {
    return {
      type: "network-partition",
      targets: [`federation:dc:${dcId}`],
      durationMs,
      config: { dcId, partitionType: "dc" },
      description: desc ?? `Partition DC ${dcId}`,
    };
  }

  /** Crash (isolate) a specific node */
  static crashNode(
    dcId: string,
    nodeIdx: number,
    durationMs = 0,
    desc?: string,
  ): ChaosFaultV2 {
    return {
      type: "node-crash",
      targets: [`federation:${dcId}:${nodeIdx}`],
      durationMs,
      config: { dcId, nodeIdx, partitionType: "node" },
      description: desc ?? `Crash ${dcId}/node-${nodeIdx}`,
    };
  }

  /** High latency between DCs */
  static replicationLag(latencyMs = 500, durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "latency-injection",
      targets: ["federation:*"],
      durationMs,
      config: { latencyMs },
      description: desc ?? `Replication lag ${latencyMs}ms`,
    };
  }

  /** Message loss across DC links */
  static messageLoss(lossRate = 0.3, durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "message-loss",
      targets: ["federation:*"],
      durationMs,
      config: { lossRate },
      description: desc ?? `${(lossRate * 100).toFixed(0)}% message loss`,
    };
  }

  /** Conflict storm: partition all DCs, allow independent writes */
  static conflictStorm(durationMs = 0, desc?: string): ChaosFaultV2 {
    return {
      type: "network-partition",
      targets: ["federation:*"],
      durationMs,
      config: { partitionType: "full-mesh", allDcs: true },
      description: desc ?? "Conflict storm: partition all DCs",
    };
  }

  /** Cascading failure across nodes in a DC */
  static cascadingFailure(
    dcId: string,
    nodeIndices: number[],
    staggerMs = 1000,
    durationMs = 0,
    desc?: string,
  ): ChaosFaultV2 {
    return {
      type: "cascading-failure",
      targets: nodeIndices.map((n) => `federation:${dcId}:${n}`),
      durationMs,
      config: { staggerMs, dcId, nodeIndices },
      description: desc ?? `Cascading failure in ${dcId}`,
    };
  }

  /** All federation nodes wildcard */
  static allNodes(): string[] {
    return ["federation:*"];
  }

  /** All nodes in a specific DC */
  static allNodesInDc(dcId: string): string[] {
    return [`federation:dc:${dcId}`];
  }
}
