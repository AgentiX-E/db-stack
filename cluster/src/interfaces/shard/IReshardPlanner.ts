/**
 * Reshard plan — describes how to split/merge/move shards across the cluster.
 * A zero-downtime plan ensures no queries are interrupted during execution.
 */
export interface ReshardPlan {
  planId: string;
  type: 'split' | 'merge' | 'move';
  sourceShardIds: number[];
  targetShardIds: number[];
  /** The boundary a split divides at. Recorded, because a plan that drops it describes less than it decided. */
  splitKey?: string;
  /**
   * The node that holds the shard now, and the node that will hold it.
   *
   * Required to execute and optional on the type: a plan is a description until
   * someone places it, and a planner that guessed at placement would copy from
   * whichever node it happened to ask.
   */
  sourceNode?: string;
  targetNode?: string;
  /** Estimated data volume to move (bytes) */
  estimatedSizeBytes: number;
  /** Batch size for incremental migration */
  batchSize: number;
  /** Max allowable latency spike during migration (ms) */
  maxLatencySpikeMs: number;
  /** Whether dual-write is needed during migration */
  dualWriteRequired: boolean;
}

export interface IMigrationProgress {
  planId: string;
  status: 'pending' | 'preparing' | 'dual-writing' | 'migrating' | 'verifying' | 'completed' | 'rolled-back' | 'failed';
  progressPercent: number;
  currentBatch: number;
  totalBatches: number;
  bytesMigrated: number;
  totalBytes: number;
  startedAt: number;
  estimatedCompletionAt: number;
  errors: string[];
}

export interface IReshardPlanner {
  createSplitPlan(sourceShardId: number, splitKey: string): Promise<ReshardPlan>;
  createMergePlan(sourceShardIds: [number, number]): Promise<ReshardPlan>;
  /**
   * A plan that moves one shard to another node.
   *
   * `sourceNodeId` is optional here and required to execute: the node holding the
   * shard is a fact about the cluster, and a planner asked only for a destination
   * has no business assuming where the data is.
   */
  createMovePlan(shardId: number, targetNodeId: string, sourceNodeId?: string): Promise<ReshardPlan>;
  executePlan(plan: ReshardPlan): Promise<string>; // returns planId
  getProgress(planId: string): Promise<IMigrationProgress | null>;
  cancelPlan(planId: string): Promise<void>;
  rollbackPlan(planId: string): Promise<void>;
  listActivePlans(): Promise<ReshardPlan[]>;
  /** Verify data consistency between source and target after migration */
  verifyConsistency(planId: string): Promise<{ consistent: boolean; mismatches: number }>;
  /** Event: fires when migration progress changes */
  onProgress(callback: (progress: IMigrationProgress) => void): () => void;
}
