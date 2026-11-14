/**
 * Reshard plan — describes how to split/merge/move shards across the cluster.
 * A zero-downtime plan ensures no queries are interrupted during execution.
 */
export interface ReshardPlan {
  planId: string;
  type: 'split' | 'merge' | 'move';
  sourceShardIds: number[];
  targetShardIds: number[];
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
  createMovePlan(shardId: number, targetNodeId: string): Promise<ReshardPlan>;
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
