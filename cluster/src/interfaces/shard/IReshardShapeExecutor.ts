/**
 * The shape half of a reshard: a split or a merge, with a proof of its own.
 *
 * A move can be verified by comparing one source shard with one target shard.
 * A split re-keys entries into two targets and a merge writes into a target
 * that already holds entries, so neither has a byte-for-byte extent to compare.
 * This port exists because those two operations need a different conservation
 * rule, and pretending they are moves is how a planner ends up reporting a
 * percentage for a copy nobody can check.
 *
 * Both rules are expressed over the same engine-agnostic source and sink ports
 * a move uses. The caller supplies the two facts an engine alone knows: which
 * target shard a key belongs to after a split, and whether the merge target
 * already holds a key. No store, socket or database type appears in the port.
 *
 * @module @agentix-e/db-cluster/interfaces/shard
 */

/** The shape a coordinator can carry out and prove. */
export interface ReshardShapeRequest {
  planId: string;
  type: 'split' | 'merge';
  sourceShardIds: readonly number[];
  targetShardIds: readonly number[];
  /** The boundary a split divides at; required for a split. */
  splitKey?: string;
  sourceNode: string;
  targetNode: string;
  batchSize: number;
}

/** What the target was measured to hold when the shape finished. */
export interface ReshardShapeOutcome {
  /** Entries the coordinator applied, counting a repeated write each time. */
  entriesCopied: number;
  /** Bytes the source reported for the entries it read. */
  bytesCopied: number;
  /** Entries the proof expects on the target after the operation. */
  sourceEntries: number;
  /** Entries the target actually reported holding. */
  targetEntries: number;
  /** Whether targetEntries equalled sourceEntries. */
  consistent: boolean;
  /** |sourceEntries - targetEntries|, never negative. */
  mismatches: number;
}

/** A coordinator for the two shapes a move's conservation check cannot prove. */
export interface IReshardShapeExecutor {
  execute(request: ReshardShapeRequest): Promise<ReshardShapeOutcome>;
}
