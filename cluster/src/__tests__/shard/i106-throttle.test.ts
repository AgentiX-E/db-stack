/**
 * I106 — the latency budget is a constraint on the source, not a field on a plan.
 *
 * `ReshardPlan.maxLatencySpikeMs` used to be carried, documented and read by
 * nothing. A copy that hammers an engine's scan path is the failure the budget
 * names, so the coordinator now spaces consecutive scans when a caller supplies
 * one. These cases measure real wall-clock gaps between scans against a real
 * in-memory store — a stub that reported timestamps would measure the stub.
 *
 * @module @agentix-e/db-cluster/__tests__/shard
 */

import { describe, expect, it } from 'vitest';

import { OnlineShardMigration } from '../../shard/OnlineShardMigration';
import { ReshardPlanner } from '../../shard/ReshardPlanner';
import { MemoryShardSink, MemoryShardSource, MemoryStore } from './migration-memory';

function storeOf(entries: number): MemoryStore {
  const store = new MemoryStore();
  for (let i = 0; i < entries; i += 1) store.put(`k${i}`, `v${i}`);
  return store;
}

/** Run a copy and return the wall-clock instants at which scans began. */
async function scanInstants(budget?: number): Promise<number[]> {
  const source = new MemoryShardSource(storeOf(12));
  const at: number[] = [];
  source.onScan = () => {
    at.push(Date.now());
  };
  const migration = new OnlineShardMigration(source, new MemoryShardSink());
  const { migrationId } = await migration.startMigration({
    shardId: 1,
    sourceNode: 'a',
    targetNode: 'b',
    batchSize: 2,
    finalSyncTimeoutMs: 0,
    pauseWritesOnCutover: false,
    ...(budget === undefined ? {} : { maxLatencySpikeMs: budget }),
  });
  await migration.waitForCompletion(migrationId);
  return at;
}

describe('I106: scan throttling', () => {
  it('TB.1 — an unbudgeted copy scans without inserted delays', async () => {
    const at = await scanInstants();
    expect(at.length).toBeGreaterThan(2);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(Math.max(...gaps)).toBeLessThan(20);
  });

  it('TB.2 — a positive budget spaces consecutive scans by at least that much', async () => {
    const budget = 20;
    const at = await scanInstants(budget);
    expect(at.length).toBeGreaterThan(2);
    for (let i = 1; i < at.length; i += 1) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(budget - 5);
    }
  });

  it('TB.3 — a zero budget is honoured as "no constraint"', async () => {
    const at = await scanInstants(0);
    expect(at.length).toBeGreaterThan(2);
    expect(Math.max(...at.slice(1).map((t, i) => t - at[i]!))).toBeLessThan(20);
  });

  it("TB.4 — the plan's budget reaches the coordinator it commissioned", async () => {
    const source = new MemoryShardSource(storeOf(8));
    const at: number[] = [];
    source.onScan = () => {
      at.push(Date.now());
    };
    const planner = new ReshardPlanner(new OnlineShardMigration(source, new MemoryShardSink()));
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    plan.maxLatencySpikeMs = 20;
    await planner.executePlan(plan);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(at.length).toBeGreaterThan(2);
    for (let i = 1; i < at.length; i += 1) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(15);
    }
  });
});
