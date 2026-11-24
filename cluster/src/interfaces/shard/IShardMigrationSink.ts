/**
 * The write side of a shard migration.
 *
 * The counterpart to {@link IShardMigrationSource}: the node that will own the
 * shard receives entries through it. Two methods, because a migration needs to
 * write and then check what it wrote — and the check is the whole point. A
 * coordinator that reports "migrated" from its own counter reports what it sent,
 * not what arrived, and the difference between those two is exactly the data
 * loss a migration is supposed to make impossible.
 *
 * @module @agentix-e/db-cluster/interfaces/shard
 */

import type { ShardVolumeStats } from './IShardMigrationSource';

/** The node that will own a migrated shard. */
export interface IShardMigrationSink {
  /**
   * Apply one entry on the target node.
   *
   * Called at least once per entry, in ascending version order. An implementation
   * that receives the same `(key, version)` twice must apply it once — a retried
   * batch is not a second write.
   */
  applyEntry(
    targetNode: string,
    shardId: number,
    entry: { key: string; value: string; version: number },
  ): Promise<void>;
  /**
   * What the target holds for the shard right now.
   *
   * Read twice: once by the conservation check before the migration completes,
   * and by a caller that wants to reconcile after a failure. A sink that cannot
   * count reports the count it is sure of rather than an estimate — a wrong count
   * here turns the conservation check into a formality.
   */
  stats(targetNode: string, shardId: number): Promise<ShardVolumeStats>;
}
