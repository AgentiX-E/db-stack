/**
 * ReshardShapeExecutor — split and merge over the migration ports.
 *
 * The coordinator copies entries in version order and asks the target what it
 * holds at the end. The difference from a move is the conservation rule:
 *
 * - a split writes each entry to one of two shards, so the proof sums both
 *   target shards and compares that total with the source;
 * - a merge writes into a shard that already has entries, so the proof counts
 *   the keys that were not there before and compares `baseline + new` with the
 *   target's final count. A destructive overwrite of an existing key is not a
 *   new entry and is not counted as one.
 *
 * The two facts that need an engine's knowledge — the target shard for a key,
 * and whether a key already exists — are callbacks supplied by the composition
 * root. The coordinator itself names no database, shard map or storage format.
 *
 * @module @agentix-e/db-cluster/shard
 */

import type {
  IReshardShapeExecutor,
  ReshardShapeOutcome,
  ReshardShapeRequest,
} from '../interfaces/shard/IReshardShapeExecutor';
import type { IShardMigrationSink } from '../interfaces/shard/IShardMigrationSink';
import type { IShardMigrationSource, ShardScanEntry } from '../interfaces/shard/IShardMigrationSource';

/** The facts only an engine can supply, injected as plain callbacks. */
export interface ReshardShapeOptions {
  /** Which target shard owns a key under the split boundary. */
  route: (key: string, splitKey: string, targets: readonly number[]) => number;
  /**
   * Whether the merge target already holds a key. Without it a union cannot be
   * distinguished from a copy, so a merge is refused rather than guessed.
   */
  hasEntry?: (targetNode: string, shardId: number, key: string) => Promise<boolean>;
}

/** Read one shard to its version watermark, returning the entries still present. */
async function readShard(
  source: IShardMigrationSource,
  shardId: number,
  batchSize: number,
): Promise<{ entries: Array<{ key: string; value: string; version: number }>; bytes: number }> {
  const entries: Array<{ key: string; value: string; version: number }> = [];
  let bytes = 0;
  let watermark = 0;
  const snapshotVersion = await source.currentVersion(shardId);
  for (;;) {
    if (watermark >= snapshotVersion) break;
    const page: ShardScanEntry[] = await source.scanEntries(shardId, watermark, batchSize);
    if (page.length === 0) break;
    for (const scanned of page) {
      const entry = await source.readEntry(shardId, scanned.key);
      if (entry === undefined) continue;
      entries.push(entry);
      bytes += scanned.bytes;
    }
    watermark = page[page.length - 1]!.version;
  }
  return { entries, bytes };
}

/** An outcome that names the difference instead of hiding it in a boolean. */
function outcome(
  entriesCopied: number,
  bytesCopied: number,
  sourceEntries: number,
  targetEntries: number,
): ReshardShapeOutcome {
  return {
    entriesCopied,
    bytesCopied,
    sourceEntries,
    targetEntries,
    consistent: sourceEntries === targetEntries,
    mismatches: Math.abs(sourceEntries - targetEntries),
  };
}

export class ReshardShapeExecutor implements IReshardShapeExecutor {
  constructor(
    private readonly source: IShardMigrationSource,
    private readonly sink: IShardMigrationSink,
    private readonly options: ReshardShapeOptions,
  ) {}

  async execute(request: ReshardShapeRequest): Promise<ReshardShapeOutcome> {
    if (!Number.isInteger(request.batchSize) || request.batchSize <= 0) {
      throw new Error(`shape ${request.planId} needs a positive batchSize, got ${String(request.batchSize)}`);
    }
    return request.type === 'split' ? this.split(request) : this.merge(request);
  }

  private async split(request: ReshardShapeRequest): Promise<ReshardShapeOutcome> {
    if (request.splitKey === undefined) {
      throw new Error(`split request ${request.planId} names no boundary, so no key can be routed`);
    }
    if (request.targetShardIds.length !== 2) {
      throw new Error(
        `split request ${request.planId} names ${request.targetShardIds.length} targets; a split needs two`,
      );
    }
    const boundary = request.splitKey;
    const targets = request.targetShardIds;
    const sourceShard = request.sourceShardIds[0];
    if (sourceShard === undefined) {
      throw new Error(`split request ${request.planId} names no source shard`);
    }

    const read = await readShard(this.source, sourceShard, request.batchSize);
    let applied = 0;
    for (const entry of read.entries) {
      const targetShard = this.options.route(entry.key, boundary, targets);
      if (!targets.includes(targetShard)) {
        throw new Error(
          `route returned shard ${targetShard} for key ${entry.key}, outside split targets ${targets.join(' and ')}`,
        );
      }
      await this.sink.applyEntry(request.targetNode, targetShard, entry);
      applied += 1;
    }
    const sourceStats = await this.source.stats(sourceShard);
    const targetStats = await Promise.all(targets.map((shardId) => this.sink.stats(request.targetNode, shardId)));
    const targetEntries = targetStats.reduce((sum, stats) => sum + stats.entries, 0);
    return outcome(applied, read.bytes, sourceStats.entries, targetEntries);
  }

  private async merge(request: ReshardShapeRequest): Promise<ReshardShapeOutcome> {
    if (this.options.hasEntry === undefined) {
      throw new Error(`merge request ${request.planId} needs a hasEntry callback: a union cannot be checked as a copy`);
    }
    const hasEntry = this.options.hasEntry;
    const targetShard = request.targetShardIds[0];
    if (targetShard === undefined) {
      throw new Error(`merge request ${request.planId} names no target shard`);
    }
    if (request.sourceShardIds.length === 0) {
      throw new Error(`merge request ${request.planId} names no source shards`);
    }

    const before = await this.sink.stats(request.targetNode, targetShard);
    let applied = 0;
    let newKeys = 0;
    let bytes = 0;
    for (const sourceShard of request.sourceShardIds) {
      const read = await readShard(this.source, sourceShard, request.batchSize);
      bytes += read.bytes;
      for (const entry of read.entries) {
        const present = await hasEntry(request.targetNode, targetShard, entry.key);
        if (!present) newKeys += 1;
        await this.sink.applyEntry(request.targetNode, targetShard, entry);
        applied += 1;
      }
    }
    const after = await this.sink.stats(request.targetNode, targetShard);
    return outcome(applied, bytes, before.entries + newKeys, after.entries);
  }
}
