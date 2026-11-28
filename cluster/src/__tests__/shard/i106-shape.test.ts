/**
 * I106 — split and merge become operations with a proof, not refusals.
 *
 * A move conserves a count because source and target have the same extent. A
 * split re-keys entries into two shards and a merge writes into a target that
 * already holds entries, so neither can be proved by the move's comparison.
 * The cases here use a real in-memory store behind the source and sink ports:
 * the proof reads what the target actually holds, and a refused key makes the
 * conservation check fail for a real reason.
 *
 * @module @agentix-e/db-cluster/__tests__/shard
 */

import { describe, expect, it } from 'vitest';

import type { IShardMigrationSink } from '../../interfaces/shard/IShardMigrationSink';
import type {
  IShardMigrationSource,
  ShardScanEntry,
  ShardVolumeStats,
} from '../../interfaces/shard/IShardMigrationSource';
import { ReshardPlanner } from '../../shard/ReshardPlanner';
import { ReshardShapeExecutor } from '../../shard/ReshardShapeExecutor';
import { MemoryStore } from './migration-memory';

/** A target that keeps one real store per node and shard, as an engine would. */
class ShardSink implements IShardMigrationSink {
  readonly stores = new Map<string, MemoryStore>();
  readonly dropped = new Set<string>();

  store(targetNode: string, shardId: number): MemoryStore {
    const key = `${targetNode}:${shardId}`;
    let store = this.stores.get(key);
    if (store === undefined) {
      store = new MemoryStore();
      this.stores.set(key, store);
    }
    return store;
  }

  async applyEntry(
    targetNode: string,
    shardId: number,
    entry: { key: string; value: string; version: number },
  ): Promise<void> {
    if (this.dropped.has(entry.key)) return;
    this.store(targetNode, shardId).put(entry.key, entry.value, entry.version);
  }

  async stats(targetNode: string, shardId: number): Promise<ShardVolumeStats> {
    const store = this.store(targetNode, shardId);
    return { entries: store.size, bytes: store.bytes() };
  }

  has(targetNode: string, shardId: number, key: string): boolean {
    return this.store(targetNode, shardId).get(key) !== undefined;
  }
}

/** A source with one real store per shard, so a merge reads two disjoint sets. */
class ShardSource implements IShardMigrationSource {
  readonly stores = new Map<number, MemoryStore>();

  constructor(shards: ReadonlyArray<readonly [number, readonly string[]]>) {
    for (const [shardId, keys] of shards) {
      const store = new MemoryStore();
      for (const key of keys) store.put(key, `value:${key}`);
      this.stores.set(shardId, store);
    }
  }

  private store(shardId: number): MemoryStore {
    let store = this.stores.get(shardId);
    if (store === undefined) {
      store = new MemoryStore();
      this.stores.set(shardId, store);
    }
    return store;
  }

  async stats(shardId: number): Promise<ShardVolumeStats> {
    const store = this.store(shardId);
    return { entries: store.size, bytes: store.bytes() };
  }

  async scanEntries(shardId: number, afterVersion: number, limit: number): Promise<ShardScanEntry[]> {
    return this.store(shardId)
      .ordered()
      .filter((entry) => entry.version > afterVersion)
      .slice(0, limit)
      .map((entry) => ({
        key: entry.key,
        bytes: Buffer.byteLength(entry.key) + Buffer.byteLength(entry.value),
        version: entry.version,
      }));
  }

  async readEntry(shardId: number, key: string): Promise<{ key: string; value: string; version: number } | undefined> {
    const entry = this.store(shardId).get(key);
    return entry === undefined ? undefined : { key, value: entry.value, version: entry.version };
  }

  async currentVersion(shardId: number): Promise<number> {
    return this.store(shardId).version;
  }
}

function sourceOf(keys: readonly string[], shardId: number): ShardSource {
  return new ShardSource([[shardId, keys]]);
}

/** Route a key by its numeric suffix, the rule an engine would supply. */
function route(key: string, _boundary: string, targets: readonly number[]): number {
  const suffix = Number(key.slice(1));
  return suffix % 2 === 0 ? targets[0]! : targets[1]!;
}

describe('I106: executable split', () => {
  it('SP.1 — a split re-keys entries into two shards and proves the total', async () => {
    const keyList = ['k1', 'k2', 'k3', 'k4'];
    const executor = new ReshardShapeExecutor(sourceOf(keyList, 7), new ShardSink(), { route });
    const outcome = await executor.execute({
      planId: 'p1',
      type: 'split',
      sourceShardIds: [7],
      targetShardIds: [71, 72],
      splitKey: 'user:5',
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    });

    expect(outcome).toMatchObject({
      entriesCopied: 4,
      sourceEntries: 4,
      targetEntries: 4,
      consistent: true,
      mismatches: 0,
    });
  });

  it('SP.2 — a lost entry is a failed conservation check, not a completed split', async () => {
    const sink = new ShardSink();
    sink.dropped.add('k3');
    const executor = new ReshardShapeExecutor(sourceOf(['k1', 'k2', 'k3', 'k4'], 7), sink, { route });
    const outcome = await executor.execute({
      planId: 'p2',
      type: 'split',
      sourceShardIds: [7],
      targetShardIds: [71, 72],
      splitKey: 'user:5',
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 4,
    });

    expect(outcome.consistent).toBe(false);
    expect(outcome.mismatches).toBe(1);
  });

  it('SP.3 — a split with no boundary is refused by name', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), { route });
    await expect(
      executor.execute({
        planId: 'p3',
        type: 'split',
        sourceShardIds: [7],
        targetShardIds: [71, 72],
        sourceNode: 'node-a',
        targetNode: 'node-b',
        batchSize: 2,
      }),
    ).rejects.toThrow(/names no boundary/);
  });

  it('SP.4 — a route outside the target shards is refused', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), {
      route: () => 99,
    });
    await expect(
      executor.execute({
        planId: 'p4',
        type: 'split',
        sourceShardIds: [7],
        targetShardIds: [71, 72],
        splitKey: 'user:5',
        sourceNode: 'node-a',
        targetNode: 'node-b',
        batchSize: 2,
      }),
    ).rejects.toThrow(/route returned shard 99/);
  });
});

describe('I106: executable merge', () => {
  it("MG.1 — a merge proves the union as a delta over the target's baseline", async () => {
    const sink = new ShardSink();
    const preexisting = sink.store('node-b', 3);
    preexisting.put('old', 'kept', 1);

    const executor = new ReshardShapeExecutor(sourceOf(['a1', 'a2'], 10), sink, {
      route,
      hasEntry: async (targetNode, shardId, key) => sink.has(targetNode, shardId, key),
    });
    const outcome = await executor.execute({
      planId: 'm1',
      type: 'merge',
      sourceShardIds: [10, 20],
      targetShardIds: [3],
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    });

    expect(outcome).toMatchObject({
      entriesCopied: 2,
      sourceEntries: 3,
      targetEntries: 3,
      consistent: true,
      mismatches: 0,
    });
    expect(preexisting.get('old')?.value).toBe('kept');
  });

  it('MG.2 — a merge without a way to tell new keys from existing ones is refused', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['a1'], 10), new ShardSink(), { route });
    await expect(
      executor.execute({
        planId: 'm2',
        type: 'merge',
        sourceShardIds: [10, 20],
        targetShardIds: [3],
        sourceNode: 'node-a',
        targetNode: 'node-b',
        batchSize: 2,
      }),
    ).rejects.toThrow(/needs a hasEntry callback/);
  });

  it('MG.3 — a lost entry makes the merge inconsistent', async () => {
    const sink = new ShardSink();
    sink.dropped.add('a2');
    const executor = new ReshardShapeExecutor(sourceOf(['a1', 'a2'], 10), sink, {
      route,
      hasEntry: async (targetNode, shardId, key) => sink.has(targetNode, shardId, key),
    });
    const outcome = await executor.execute({
      planId: 'm3',
      type: 'merge',
      sourceShardIds: [10, 20],
      targetShardIds: [3],
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    });
    expect(outcome.consistent).toBe(false);
    expect(outcome.mismatches).toBe(1);
  });
});

describe('I106: shape inputs that cannot be guessed', () => {
  it('IN.1 — a non-positive batch size is refused before any read', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), { route });
    await expect(
      executor.execute({
        planId: 'bad-batch',
        type: 'split',
        sourceShardIds: [7],
        targetShardIds: [71, 72],
        splitKey: 'user:5',
        sourceNode: 'node-a',
        targetNode: 'node-b',
        batchSize: 0,
      }),
    ).rejects.toThrow(/needs a positive batchSize/);
  });

  it('IN.2 — a split needs exactly two targets and one source', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), { route });
    const base = {
      planId: 'bad-shape',
      type: 'split' as const,
      splitKey: 'user:5',
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    };
    await expect(executor.execute({ ...base, sourceShardIds: [7], targetShardIds: [71] })).rejects.toThrow(
      /names 1 targets; a split needs two/,
    );
    await expect(executor.execute({ ...base, sourceShardIds: [], targetShardIds: [71, 72] })).rejects.toThrow(
      /names no source shard/,
    );
  });

  it('IN.3 — a merge needs a target and at least one source', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), {
      route,
      hasEntry: async () => false,
    });
    const base = {
      planId: 'bad-merge',
      type: 'merge' as const,
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    };
    await expect(executor.execute({ ...base, sourceShardIds: [7], targetShardIds: [] })).rejects.toThrow(
      /names no target shard/,
    );
    await expect(executor.execute({ ...base, sourceShardIds: [], targetShardIds: [3] })).rejects.toThrow(
      /names no source shards/,
    );
  });

  it('IN.4 — an empty shard and a deleted entry both finish the scan without a guess', async () => {
    const empty = new ReshardShapeExecutor(new ShardSource([[7, []]]), new ShardSink(), { route });
    const emptyOutcome = await empty.execute({
      planId: 'empty',
      type: 'split',
      sourceShardIds: [7],
      targetShardIds: [71, 72],
      splitKey: 'user:5',
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    });
    expect(emptyOutcome).toMatchObject({ entriesCopied: 0, consistent: true, mismatches: 0 });

    const deleted = new ShardSource([[7, ['k1']]]);
    deleted.stores.get(7)!.delete('k1');
    const executor = new ReshardShapeExecutor(deleted, new ShardSink(), { route });
    const outcome = await executor.execute({
      planId: 'deleted',
      type: 'split',
      sourceShardIds: [7],
      targetShardIds: [71, 72],
      splitKey: 'user:5',
      sourceNode: 'node-a',
      targetNode: 'node-b',
      batchSize: 2,
    });
    expect(outcome).toMatchObject({ entriesCopied: 0, consistent: true });
  });
});

describe('I106: the planner executes what it can prove', () => {
  it('PL.1 — a planner with a shape executor completes a split with measured progress', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1', 'k2'], 7), new ShardSink(), { route });
    const planner = new ReshardPlanner(undefined, undefined, executor);
    const plan = await planner.createSplitPlan(7, 'user:5');
    plan.sourceNode = 'node-a';
    plan.targetNode = 'node-b';
    await planner.executePlan(plan);

    const progress = await planner.getProgress(plan.planId);
    expect(progress?.status).toBe('completed');
    expect(progress?.bytesMigrated).toBeGreaterThan(0);
    await expect(planner.verifyConsistency(plan.planId)).resolves.toEqual({ consistent: true, mismatches: 0 });
  });

  it('PL.2 — a planner without a shape executor still refuses by name', async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(7, 'user:5');
    await expect(planner.executePlan(plan)).rejects.toThrow(/split plans are not executable/);
  });

  it('PL.3 — a lost entry makes the plan fail and names the mismatch', async () => {
    const sink = new ShardSink();
    sink.dropped.add('k2');
    const executor = new ReshardShapeExecutor(sourceOf(['k1', 'k2'], 7), sink, { route });
    const planner = new ReshardPlanner(undefined, undefined, executor);
    const plan = await planner.createSplitPlan(7, 'user:5');
    plan.sourceNode = 'node-a';
    plan.targetNode = 'node-b';
    await planner.executePlan(plan);

    const progress = await planner.getProgress(plan.planId);
    expect(progress?.status).toBe('failed');
    expect(progress?.errors[0]).toMatch(/conservation mismatch: 1 entry/);
    await expect(planner.verifyConsistency(plan.planId)).resolves.toEqual({ consistent: false, mismatches: 1 });
  });

  it('PL.4 — an unplaced or unlabeled shape is refused before an executor runs', async () => {
    const executor = new ReshardShapeExecutor(sourceOf(['k1'], 7), new ShardSink(), { route });
    const planner = new ReshardPlanner(undefined, undefined, executor);
    const unplaced = await planner.createSplitPlan(7, 'user:5');
    await expect(planner.executePlan(unplaced)).rejects.toThrow(/does not say where shard 7 lives/);

    const unlabeled = await planner.createSplitPlan(7, 'user:5');
    unlabeled.sourceNode = 'node-a';
    unlabeled.targetNode = 'node-b';
    unlabeled.splitKey = undefined;
    await expect(planner.executePlan(unlabeled)).rejects.toThrow(/names no boundary/);

    const noRefusalReason = await planner.createSplitPlan(8, 'user:9');
    await expect(new ReshardPlanner().executePlan(noRefusalReason)).rejects.toThrow(/at key "user:9"/);
  });
});
