/**
 * TopologyManager — DC-level membership and partition assignment.
 *
 * Manages:
 *   1. DC membership: which nodes belong to which datacenters
 *   2. Node routing table: how to reach a node (address, port, transport type)
 *   3. Partition-to-region assignments (for shard routing)
 *   4. Topology-aware backoff: intra-DC=3s, cross-DC=60s, edge=300s
 *
 * Based on graphvec-db MultiRegionTopology, simplified for federation use:
 *   - No latency table in the core (optional)
 *   - Event-driven: fires connect/disconnect/change callbacks
 *   - Immutable state after construction (mutations via replaceAll)
 */

import type { TopologyType, ReplicationTarget } from "../interfaces/replication/IMultiLeaderReplication";

export interface TopologyConfig {
  /** Node ID of the local node */
  nodeId: string;
  /** DC of the local node */
  dc: string;
  /** All peers in the federation */
  peers: ReplicationTarget[];
  /** Partition to region assignments (optional): partitionId → dc */
  partitionRegions?: Record<string, string>;
}

export interface TopologyChangeEvent {
  type: "peer-added" | "peer-removed" | "peer-changed";
  peer: ReplicationTarget;
}

export class TopologyManager {
  private readonly localNodeId: string;
  private readonly localDc: string;
  private peers: ReplicationTarget[];
  private readonly partitionRegions: Map<string, string>;
  private readonly listeners: Map<string, Array<(event: TopologyChangeEvent) => void>> = new Map();

  constructor(config: TopologyConfig) {
    this.localNodeId = config.nodeId;
    this.localDc = config.dc;
    this.peers = [...config.peers];
    this.partitionRegions = new Map(Object.entries(config.partitionRegions ?? {}));
  }

  // ── Accessors ──────────────────────────────────

  /** Get the local node ID */
  getLocalNodeId(): string {
    return this.localNodeId;
  }

  /** Get the local DC name */
  getLocalDc(): string {
    return this.localDc;
  }

  /** Get all peers (excluding self) */
  getAllPeers(): ReplicationTarget[] {
    return this.peers.filter((p) => p.nodeId !== this.localNodeId);
  }

  /** Get a specific peer by nodeId */
  getPeer(nodeId: string): ReplicationTarget | undefined {
    return this.peers.find((p) => p.nodeId === nodeId);
  }

  /** Get all peers in a specific DC */
  getPeersInDc(dc: string): ReplicationTarget[] {
    return this.peers.filter((p) => p.dc === dc && p.nodeId !== this.localNodeId);
  }

  /** Get all peers NOT in the local DC (cross-DC targets) */
  getCrossDcPeers(): ReplicationTarget[] {
    return this.peers.filter((p) => p.dc !== this.localDc);
  }

  /** Get all peers in the local DC */
  getIntraDcPeers(): ReplicationTarget[] {
    return this.getPeersInDc(this.localDc);
  }

  /** Get all peers with edge topology */
  getEdgePeers(): ReplicationTarget[] {
    return this.peers.filter((p) => p.topology === "edge");
  }

  /** Get the topology type for a peer */
  getTopologyType(nodeId: string): TopologyType | undefined {
    const peer = this.getPeer(nodeId);
    return peer?.topology;
  }

  /** Get the backoff duration (ms) for a peer based on topology */
  getBackoffMs(nodeId: string): number {
    const peer = this.getPeer(nodeId);
    if (!peer) return 60_000; // default: cross-DC
    return peer.maxBackoffSeconds * 1000;
  }

  /** Check if a peer is in the same DC as local */
  isIntraDc(nodeId: string): boolean {
    const peer = this.getPeer(nodeId);
    return peer !== undefined && peer.dc === this.localDc;
  }

  /** Check if local node is a peer (self check) */
  isSelf(nodeId: string): boolean {
    return nodeId === this.localNodeId;
  }

  /** Get partition region assignment */
  getPartitionRegion(partitionId: string): string | undefined {
    return this.partitionRegions.get(partitionId);
  }

  // ── Mutations ──────────────────────────────────

  /**
   * Replace all peers atomically.
   * Fires peer-added, peer-removed, and peer-changed events.
   */
  replaceAll(newPeers: ReplicationTarget[]): void {
    const oldPeers = new Map(this.peers.map((p) => [p.nodeId, p]));
    const newPeersMap = new Map(newPeers.map((p) => [p.nodeId, p]));

    // Detect removals
    for (const [id, peer] of oldPeers) {
      if (!newPeersMap.has(id) && id !== this.localNodeId) {
        this.emit("peer-removed", peer);
      }
    }

    // Detect additions and changes
    for (const peer of newPeers) {
      if (peer.nodeId === this.localNodeId) continue;
      const existing = oldPeers.get(peer.nodeId);
      if (!existing) {
        this.emit("peer-added", peer);
      } else if (!shallowEqual(existing, peer)) {
        this.emit("peer-changed", peer);
      }
    }

    this.peers = [...newPeers];
  }

  // ── Events ─────────────────────────────────────

  on(event: "change", callback: (event: TopologyChangeEvent) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
    return () => {
      const arr = this.listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  private emit(type: TopologyChangeEvent["type"], peer: ReplicationTarget): void {
    const event: TopologyChangeEvent = { type, peer };
    const listeners = this.listeners.get("change");
    if (listeners) {
      for (const cb of listeners) {
        cb(event);
      }
    }
  }
}

/** Shallow equality check for ReplicationTarget objects */
function shallowEqual(a: ReplicationTarget, b: ReplicationTarget): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.dc === b.dc &&
    a.address === b.address &&
    a.topology === b.topology &&
    a.maxBackoffSeconds === b.maxBackoffSeconds
  );
}
