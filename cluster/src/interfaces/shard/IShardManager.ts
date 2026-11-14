import { IShardStrategy } from './IShardStrategy';
import { OperationResult } from '../types';

/**
 * Manages shard assignments across the cluster.
 * Creates, rebalances, and tracks shard-to-node mappings.
 */
export interface IShardManager {
  /**
   * Initialize the shard manager with a strategy.
   */
  initialize(strategy: IShardStrategy): Promise<OperationResult>;

  /**
   * Get the shard strategy in use.
   */
  getStrategy(): IShardStrategy;

  /**
   * Get all shard IDs managed by this instance.
   */
  listShards(): Promise<OperationResult<string[]>>;

  /**
   * Get the set of nodes responsible for a given shard.
   */
  getShardNodes(shardId: string): Promise<OperationResult<string[]>>;

  /**
   * Determine which shard a key belongs to.
   */
  getShardForKey(key: string): Promise<OperationResult<string>>;

  /**
   * Assign a shard to specific nodes (manual override).
   */
  assignShard(shardId: string, nodeIds: string[]): Promise<OperationResult>;

  /**
   * Remove a shard assignment.
   */
  removeShard(shardId: string): Promise<OperationResult>;

  /**
   * Rebalance shards across the available nodes using the configured strategy.
   */
  rebalance(nodeIds: string[]): Promise<OperationResult>;

  /**
   * Add a node to the cluster, redistributing shards if needed.
   */
  addNode(nodeId: string): Promise<OperationResult>;

  /**
   * Remove a node from the cluster, migrating its shards.
   */
  removeNode(nodeId: string): Promise<OperationResult>;

  /**
   * Get the current shard distribution map.
   */
  getDistribution(): Promise<OperationResult<Record<string, string[]>>>;

  /**
   * Event: fires when shard assignments change.
   */
  onShardAssigned(callback: (shardId: string, nodeIds: string[]) => void): void;

  /**
   * Event: fires when a shard is removed.
   */
  onShardRemoved(callback: (shardId: string) => void): void;
}
