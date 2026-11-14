/**
 * Shard module index — Production-grade sharding infrastructure.
 *
 * Exports:
 *   - ShardStrategy: Hash, Range, and ConsistentHashing strategies
 *   - ShardManager: Full shard lifecycle manager
 *   - ReshardPlanner: Zero-downtime split/merge/move planner
 *   - OnlineShardMigration: Hot migration coordinator
 */

export { HashShardStrategy, RangeShardStrategy, ConsistentHashStrategy } from "./ShardStrategy";
export type { RangeShardBoundary } from "./ShardStrategy";
export { ShardManager } from "./ShardManager";
export { ReshardPlanner } from "./ReshardPlanner";
export { OnlineShardMigration } from "./OnlineShardMigration";
