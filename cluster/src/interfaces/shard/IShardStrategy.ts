import { OperationResult } from '../types';

/**
 * Strategy for determining how keys map to shards
 * and how shards are distributed across nodes.
 */
export interface IShardStrategy {
  /**
   * Unique name for this strategy (e.g., 'hash', 'range', 'consistent-hashing').
   */
  readonly name: string;

  /**
   * Determine the shard ID for a given key.
   */
  getShardForKey(key: string, totalShards: number): Promise<OperationResult<string>>;

  /**
   * Compute the optimal shard-to-node assignments given the current state.
   * Returns a map of shardId → nodeIds.
   */
  computeAssignments(
    shardIds: string[],
    nodeIds: string[],
    currentDistribution: Record<string, string[]>,
    replicationFactor?: number,
  ): Promise<OperationResult<Record<string, string[]>>>;

  /**
   * Rebalance calculation: returns the desired distribution after adding a node.
   */
  onNodeAdded(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>>;

  /**
   * Rebalance calculation: returns the desired distribution after removing a node.
   */
  onNodeRemoved(
    nodeId: string,
    currentDistribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<Record<string, string[]>>>;

  /**
   * Validate that a distribution meets the strategy's constraints.
   */
  validateDistribution(
    distribution: Record<string, string[]>,
    replicationFactor: number,
  ): Promise<OperationResult<boolean>>;
}
