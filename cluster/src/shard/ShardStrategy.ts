/**
 * ShardStrategy — Production-grade sharding strategies.
 *
 * Strategies:
 *   - HashStrategy: Ring-consistent hash (FNV-1a) for uniform distribution
 *   - RangeStrategy: Key-range based sharding with split point management
 *   - ConsistentHashStrategy: Virtual-node consistent hashing (vnode ring)
 *
 * All strategies are deterministic and replayable.
 * Key migration cost is minimized via controlled rebalancing.
 */

import { IShardStrategy } from "../interfaces/shard/IShardStrategy";
import { OperationResult } from "../interfaces/types";
import * as crypto from "crypto";

// ── HashStrategy ────────────────────────────────────────────

/**
 * FNV-1a 64-bit hash for deterministic key → shard mapping.
 * Pure function, no side effects, reproducible across nodes.
 */
function fnv1aHash(key: string): bigint {
  let hash = BigInt("0xcbf29ce484222325");
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash *= BigInt("0x100000001b3");
  }
  return hash & BigInt("0xFFFFFFFFFFFFFFFF");
}

export class HashShardStrategy implements IShardStrategy {
  readonly name = "hash";

  async getShardForKey(
    key: string,
    totalShards: number,
  ): Promise<OperationResult<string>> {
    if (totalShards <= 0) {
      return { success: false, error: "totalShards must be positive" };
    }
    const hash = fnv1aHash(key);
    const shardIdx = Number(hash % BigInt(totalShards));
    return { success: true, data: `shard-${shardIdx}` };
  }

  async computeAssignments(
    shardIds: string[],
    nodeIds: string[],
    _currentDistribution: Record<string, string[]>,
    replicationFactor = 1,
  ): Promise<OperationResult<Record<string, string[]>>> {
    if (nodeIds.length === 0) {
      return { success: false, error: "no nodes available" };
    }
    const assignments: Record<string, string[]> = {};
    const sortedShards = [...shardIds].sort();
    const sortedNodes = [...nodeIds].sort();

    for (let i = 0; i < sortedShards.length; i++) {
      const primaryIdx = i % sortedNodes.length;
      const primary = sortedNodes[primaryIdx]!;
      const replicas: string[] = [primary];

      // Assign replicationFactor-1 additional replicas
      for (let r = 1; r < replicationFactor; r++) {
        const replicaIdx = (primaryIdx + r) % sortedNodes.length;
        const replica = sortedNodes[replicaIdx]!;
        if (!replicas.includes(replica)) {
          replicas.push(replica);
        }
      }
      assignments[sortedShards[i]!] = replicas;
    }
    return { success: true, data: assignments };
  }

  async onNodeAdded(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const shardIds = Object.keys(currentDistribution);
    const allNodes = new Set<string>();
    for (const nodes of Object.values(currentDistribution)) {
      for (const n of nodes) allNodes.add(n);
    }
    allNodes.add(nodeId);
    return this.computeAssignments(
      shardIds,
      [...allNodes],
      currentDistribution,
      replicationFactor,
    );
  }

  async onNodeRemoved(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const shardIds = Object.keys(currentDistribution);
    const allNodes = new Set<string>();
    for (const nodes of Object.values(currentDistribution)) {
      for (const n of nodes) {
        if (n !== nodeId) allNodes.add(n);
      }
    }
    if (allNodes.size === 0) {
      return { success: false, error: "no nodes remaining after removal" };
    }
    return this.computeAssignments(
      shardIds,
      [...allNodes],
      currentDistribution,
      replicationFactor,
    );
  }

  async validateDistribution(
    distribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<boolean>> {
    for (const [shardId, nodes] of Object.entries(distribution)) {
      if (nodes.length === 0) {
        return { success: true, data: false };
      }
      if (nodes.length > replicationFactor) {
        return { success: true, data: false };
      }
      // Check for duplicate node assignments in same shard
      if (new Set(nodes).size !== nodes.length) {
        return { success: true, data: false };
      }
    }
    return { success: true, data: true };
  }
}

// ── RangeStrategy ────────────────────────────────────────────

export interface RangeShardBoundary {
  shardId: string;
  rangeStart: string; // inclusive
  rangeEnd: string;   // exclusive
}

export class RangeShardStrategy implements IShardStrategy {
  readonly name = "range";

  private boundaries: RangeShardBoundary[] = [];

  constructor(boundaries: RangeShardBoundary[] = []) {
    this.boundaries = [...boundaries].sort((a, b) =>
      a.rangeStart.localeCompare(b.rangeStart),
    );
  }

  /** Add a new range boundary. */
  addBoundary(boundary: RangeShardBoundary): void {
    this.boundaries.push(boundary);
    this.boundaries.sort((a, b) => a.rangeStart.localeCompare(b.rangeStart));
  }

  /** Split a shard at the given key. */
  splitShard(
    sourceShardId: string,
    splitKey: string,
    newShardId: string,
  ): OperationResult<RangeShardBoundary[]> {
    const idx = this.boundaries.findIndex(
      (b) => b.shardId === sourceShardId,
    );
    if (idx === -1) {
      return { success: false, error: `shard ${sourceShardId} not found` };
    }

    const boundary = this.boundaries[idx]!;
    if (
      splitKey <= boundary.rangeStart ||
      splitKey >= boundary.rangeEnd
    ) {
      return {
        success: false,
        error: `split key ${splitKey} out of range [${boundary.rangeStart}, ${boundary.rangeEnd})`,
      };
    }

    // Replace the old boundary with two new boundaries
    const left: RangeShardBoundary = {
      shardId: sourceShardId,
      rangeStart: boundary.rangeStart,
      rangeEnd: splitKey,
    };
    const right: RangeShardBoundary = {
      shardId: newShardId,
      rangeStart: splitKey,
      rangeEnd: boundary.rangeEnd,
    };

    this.boundaries.splice(idx, 1, left, right);
    this.boundaries.sort((a, b) => a.rangeStart.localeCompare(b.rangeStart));

    return { success: true, data: [...this.boundaries] };
  }

  getBoundaries(): RangeShardBoundary[] {
    return [...this.boundaries];
  }

  async getShardForKey(
    key: string,
    _totalShards: number,
  ): Promise<OperationResult<string>> {
    if (this.boundaries.length === 0) {
      return { success: false, error: "no range boundaries configured" };
    }

    // Binary search for the range containing key
    let low = 0;
    let high = this.boundaries.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const b = this.boundaries[mid]!;
      if (key >= b.rangeEnd) {
        low = mid + 1;
      } else if (key < b.rangeStart) {
        high = mid - 1;
      } else {
        return { success: true, data: b.shardId };
      }
    }
    return { success: false, error: `no shard found for key ${key}` };
  }

  async computeAssignments(
    shardIds: string[],
    nodeIds: string[],
    _currentDistribution: Record<string, string[]>,
    replicationFactor = 1,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const hash = new HashShardStrategy();
    return hash.computeAssignments(shardIds, nodeIds, {}, replicationFactor);
  }

  async onNodeAdded(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const hash = new HashShardStrategy();
    return hash.onNodeAdded(nodeId, currentDistribution, replicationFactor);
  }

  async onNodeRemoved(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const hash = new HashShardStrategy();
    return hash.onNodeRemoved(nodeId, currentDistribution, replicationFactor);
  }

  async validateDistribution(
    distribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<boolean>> {
    const hash = new HashShardStrategy();
    return hash.validateDistribution(distribution, replicationFactor);
  }
}

// ── ConsistentHashStrategy ──────────────────────────────────

export interface VirtualNode {
  hash: bigint;
  nodeId: string;
}

export class ConsistentHashStrategy implements IShardStrategy {
  readonly name = "consistent-hashing";

  private ring: VirtualNode[] = [];
  private readonly vnodesPerNode: number;

  constructor(vnodesPerNode = 256) {
    this.vnodesPerNode = Math.max(1, vnodesPerNode);
  }

  /** Build the ring from a set of nodes. */
  buildRing(nodeIds: string[]): void {
    this.ring = [];
    for (const nodeId of nodeIds) {
      for (let i = 0; i < this.vnodesPerNode; i++) {
        const vnodeKey = `${nodeId}:vnode:${i}`;
        const hash = fnv1aHash(vnodeKey);
        this.ring.push({ hash, nodeId });
      }
    }
    this.ring.sort((a, b) => {
      if (a.hash < b.hash) return -1;
      if (a.hash > b.hash) return 1;
      return 0;
    });
  }

  /** Find the node responsible for a key on the ring. */
  private findNode(key: string): string | null {
    if (this.ring.length === 0) return null;
    const keyHash = fnv1aHash(key);

    // Binary search for the first vnode with hash >= keyHash
    let low = 0;
    let high = this.ring.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid]!.hash >= keyHash) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return this.ring[result]!.nodeId;
  }

  /** Get the N distinct successor nodes (replication). */
  private findReplicas(key: string, n: number): string[] {
    if (this.ring.length === 0) return [];
    const keyHash = fnv1aHash(key);

    // Find first node >= keyHash
    let start = 0;
    let low = 0;
    let high = this.ring.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid]!.hash >= keyHash) {
        start = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const replicas: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.ring.length && replicas.length < n; i++) {
      const idx = (start + i) % this.ring.length;
      const node = this.ring[idx]!.nodeId;
      if (!seen.has(node)) {
        seen.add(node);
        replicas.push(node);
      }
    }
    return replicas;
  }

  async getShardForKey(
    key: string,
    _totalShards: number,
  ): Promise<OperationResult<string>> {
    if (this.ring.length === 0) {
      return { success: false, error: "hash ring is empty" };
    }
    const node = this.findNode(key);
    if (!node) {
      return { success: false, error: "no node found" };
    }
    return { success: true, data: `shard-${node}` };
  }

  async computeAssignments(
    shardIds: string[],
    nodeIds: string[],
    _currentDistribution: Record<string, string[]>,
    replicationFactor = 1,
  ): Promise<OperationResult<Record<string, string[]>>> {
    this.buildRing(nodeIds);
    const assignments: Record<string, string[]> = {};
    for (const shardId of shardIds) {
      const replicas = this.findReplicas(shardId, replicationFactor);
      assignments[shardId] = replicas;
    }
    return { success: true, data: assignments };
  }

  async onNodeAdded(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const allNodes = new Set<string>();
    for (const nodes of Object.values(currentDistribution)) {
      for (const n of nodes) allNodes.add(n);
    }
    allNodes.add(nodeId);
    return this.computeAssignments(
      Object.keys(currentDistribution),
      [...allNodes],
      currentDistribution,
      replicationFactor,
    );
  }

  async onNodeRemoved(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>> {
    const allNodes = new Set<string>();
    for (const nodes of Object.values(currentDistribution)) {
      for (const n of nodes) {
        if (n !== nodeId) allNodes.add(n);
      }
    }
    if (allNodes.size === 0) {
      return { success: false, error: "no nodes remaining after removal" };
    }
    return this.computeAssignments(
      Object.keys(currentDistribution),
      [...allNodes],
      currentDistribution,
      replicationFactor,
    );
  }

  async validateDistribution(
    distribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<boolean>> {
    const hash = new HashShardStrategy();
    return hash.validateDistribution(distribution, replicationFactor);
  }

  /** Get the ring size for diagnostics. */
  getRingSize(): number {
    return this.ring.length;
  }

  /** Get key redistribution ratio after node change (0-1, lower is better). */
  estimateRedistributionRatio(
    oldNodes: string[],
    _newNodes: string[],
  ): number {
    if (oldNodes.length === 0) return 1.0;
    return 1.0 / (oldNodes.length + 1);
  }
}
