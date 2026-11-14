/**
 * ShardManager — Full-featured shard lifecycle manager.
 *
 * Manages shard assignments, rebalancing after node add/remove,
 * and distributes shards across the cluster using any IShardStrategy.
 *
 * Key properties:
 *   - Event-driven: onShardAssigned / onShardRemoved callbacks
 *   - Strategy-agnostic: works with hash, range, or consistent-hashing
 *   - Replication-aware: tracks primary + replica assignments
 *   - Reentrant: safe for concurrent rebalance calls via internal lock
 */

import { EventEmitter } from "events";
import { IShardManager } from "../interfaces/shard/IShardManager";
import { IShardStrategy } from "../interfaces/shard/IShardStrategy";
import { OperationResult } from "../interfaces/types";

// ── Internal Types ──────────────────────────────────────────

interface ShardEntry {
  shardId: string;
  nodeIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface ShardAssignedCallback {
  (shardId: string, nodeIds: string[]): void;
}

interface ShardRemovedCallback {
  (shardId: string): void;
}

// ── ShardManager Implementation ─────────────────────────────

export class ShardManager implements IShardManager {
  private strategy!: IShardStrategy;
  private shards = new Map<string, ShardEntry>();
  private onAssignedCallbacks: ShardAssignedCallback[] = [];
  private onRemovedCallbacks: ShardRemovedCallback[] = [];
  private initialized = false;
  private rebalancing = false;

  // ── Lifecycle ─────────────────────────────────────────────

  async initialize(strategy: IShardStrategy): Promise<OperationResult> {
    if (this.initialized) {
      return { success: false, error: "ShardManager already initialized" };
    }
    this.strategy = strategy;
    this.initialized = true;
    return { success: true };
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.strategy) {
      throw new Error("ShardManager not initialized. Call initialize() first.");
    }
  }

  getStrategy(): IShardStrategy {
    this.ensureInitialized();
    return this.strategy;
  }

  // ── Query ─────────────────────────────────────────────────

  async listShards(): Promise<OperationResult<string[]>> {
    this.ensureInitialized();
    return { success: true, data: [...this.shards.keys()].sort() };
  }

  async getShardNodes(shardId: string): Promise<OperationResult<string[]>> {
    this.ensureInitialized();
    const entry = this.shards.get(shardId);
    if (!entry) {
      return { success: false, error: `shard ${shardId} not found` };
    }
    return { success: true, data: [...entry.nodeIds] };
  }

  async getShardForKey(key: string): Promise<OperationResult<string>> {
    this.ensureInitialized();
    // Delegate to strategy for mapping — uses a default total of existing shards
    const totalShards = this.shards.size || 1;
    return this.strategy.getShardForKey(key, totalShards);
  }

  async getDistribution(): Promise<OperationResult<Record<string, string[]>>> {
    this.ensureInitialized();
    const dist: Record<string, string[]> = {};
    for (const [shardId, entry] of this.shards) {
      dist[shardId] = [...entry.nodeIds];
    }
    return { success: true, data: dist };
  }

  // ── Mutation ──────────────────────────────────────────────

  async assignShard(
    shardId: string,
    nodeIds: string[],
  ): Promise<OperationResult> {
    this.ensureInitialized();
    if (nodeIds.length === 0) {
      return { success: false, error: "must assign at least one node" };
    }

    const existing = this.shards.get(shardId);
    const now = Date.now();

    if (existing) {
      existing.nodeIds = [...nodeIds];
      existing.updatedAt = now;
    } else {
      this.shards.set(shardId, {
        shardId,
        nodeIds: [...nodeIds],
        createdAt: now,
        updatedAt: now,
      });
    }

    // Fire assignment event
    for (const cb of this.onAssignedCallbacks) {
      cb(shardId, [...nodeIds]);
    }

    return { success: true };
  }

  async removeShard(shardId: string): Promise<OperationResult> {
    this.ensureInitialized();
    if (!this.shards.has(shardId)) {
      return { success: false, error: `shard ${shardId} not found` };
    }
    this.shards.delete(shardId);

    for (const cb of this.onRemovedCallbacks) {
      cb(shardId);
    }
    return { success: true };
  }

  // ── Rebalance ─────────────────────────────────────────────

  async rebalance(nodeIds: string[]): Promise<OperationResult> {
    this.ensureInitialized();

    if (this.rebalancing) {
      return { success: false, error: "rebalance already in progress" };
    }
    this.rebalancing = true;

    try {
      const shardIds = [...this.shards.keys()];
      if (shardIds.length === 0) {
        return { success: true };
      }

      const currentDist: Record<string, string[]> = {};
      for (const [id, entry] of this.shards) {
        currentDist[id] = entry.nodeIds;
      }

      const result = await this.strategy.computeAssignments(
        shardIds,
        nodeIds,
        currentDist,
      );

      if (!result.success || !result.data) {
        return { success: false, error: result.error ?? "strategy failed" };
      }

      // Apply new distribution
      for (const [shardId, newNodeIds] of Object.entries(result.data)) {
        const entry = this.shards.get(shardId);
        if (entry) {
          entry.nodeIds = [...newNodeIds];
          entry.updatedAt = Date.now();
        }
      }

      return { success: true };
    } finally {
      this.rebalancing = false;
    }
  }

  async addNode(nodeId: string): Promise<OperationResult> {
    this.ensureInitialized();

    const currentDist: Record<string, string[]> = {};
    for (const [id, entry] of this.shards) {
      currentDist[id] = entry.nodeIds;
    }

    const result = await this.strategy.onNodeAdded(nodeId, currentDist, 3);
    if (!result.success || !result.data) {
      return { success: false, error: result.error ?? "addNode failed" };
    }

    for (const [shardId, newNodeIds] of Object.entries(result.data)) {
      const entry = this.shards.get(shardId);
      if (entry) {
        entry.nodeIds = [...newNodeIds];
        entry.updatedAt = Date.now();
      }
    }

    return { success: true };
  }

  async removeNode(nodeId: string): Promise<OperationResult> {
    this.ensureInitialized();

    const currentDist: Record<string, string[]> = {};
    for (const [id, entry] of this.shards) {
      currentDist[id] = entry.nodeIds;
    }

    const result = await this.strategy.onNodeRemoved(nodeId, currentDist, 3);
    if (!result.success || !result.data) {
      return { success: false, error: result.error ?? "removeNode failed" };
    }

    for (const [shardId, newNodeIds] of Object.entries(result.data)) {
      const entry = this.shards.get(shardId);
      if (entry) {
        entry.nodeIds = [...newNodeIds];
        entry.updatedAt = Date.now();
      }
    }

    return { success: true };
  }

  // ── Events ────────────────────────────────────────────────

  onShardAssigned(callback: ShardAssignedCallback): void {
    this.onAssignedCallbacks.push(callback);
  }

  onShardRemoved(callback: ShardRemovedCallback): void {
    this.onRemovedCallbacks.push(callback);
  }

  // ── Diagnostics ───────────────────────────────────────────

  /** Get the total number of shards managed. */
  getShardCount(): number {
    return this.shards.size;
  }

  /** Check if a shard exists. */
  hasShard(shardId: string): boolean {
    return this.shards.has(shardId);
  }

  /** Get creation timestamp for a shard. */
  getShardAge(shardId: string): number | null {
    const entry = this.shards.get(shardId);
    return entry ? Date.now() - entry.createdAt : null;
  }
}
