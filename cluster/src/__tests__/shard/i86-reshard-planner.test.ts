/**
 * I86 — the reshard planner over a real copy.
 *
 * `ReshardPlanner` used to advance by timer: `bytesMigrated` was `batch ×
 * batchSize × 1024`, the byte total was a hundred-megabyte constant invented by
 * `createSplitPlan`, and the five phases were five `await delay(50)` calls.
 * Nothing was copied and no node was involved, so a completed reshard meant the
 * loop had ended.
 *
 * These cases pin the replacement: a move plan copies a shard through the two
 * migration ports, every number is measured against the source, and the plan
 * types the coordinator cannot verify are refused with a reason instead of being
 * simulated.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReshardPlanner } from '../../shard/ReshardPlanner';
import { OnlineShardMigration } from '../../shard/OnlineShardMigration';
import { MemoryShardSink, MemoryShardSource, MemoryStore } from './migration-memory';
import type { IMigrationProgress } from '../../interfaces/shard/IReshardPlanner';

// ── Fixtures ───────────────────────────────────────────────

const TERMINAL = ['completed', 'failed', 'rolled-back'];

/**
 * A planner over an in-memory shard.
 *
 * The store is a real one: `k0..k7` with the versions the source assigned, so a
 * copy that loses, reorders or renumbers an entry is visible in the sink's store
 * rather than in a stub's return value.
 */
function fixture(entries = 8) {
  const store = new MemoryStore();
  for (let i = 0; i < entries; i += 1) store.put(`k${i}`, `v${i}`);
  const source = new MemoryShardSource(store);
  const sink = new MemoryShardSink();
  const migration = new OnlineShardMigration(source, sink);
  const planner = new ReshardPlanner(migration);
  return { store, source, sink, migration, planner };
}

/** Wait until a plan reports a terminal phase, then return that report. */
async function settled(planner: ReshardPlanner, planId: string): Promise<IMigrationProgress> {
  await vi.waitFor(
    async () => {
      const progress = await planner.getProgress(planId);
      expect(TERMINAL).toContain(progress?.status);
    },
    { timeout: 3000, interval: 5 },
  );
  return (await planner.getProgress(planId))!;
}

/** Every distinct phase a plan reported, in order. */
function phases(planner: ReshardPlanner): string[] {
  const seen: string[] = [];
  planner.onProgress((p) => {
    if (seen[seen.length - 1] !== p.status) seen.push(p.status);
  });
  return seen;
}

// ── RP.1–RP.3: what a plan says ────────────────────────────

describe('I86: plans describe a shape and a placement', () => {
  it('RP.1 — a move plan names both nodes and keeps the shard id on both sides', async () => {
    const { planner } = fixture();
    const plan = await planner.createMovePlan(42, 'node-z', 'node-a');

    expect(plan.type).toBe('move');
    expect(plan.sourceShardIds).toEqual([42]);
    expect(plan.targetShardIds).toEqual([42]);
    expect(plan.sourceNode).toBe('node-a');
    expect(plan.targetNode).toBe('node-z');
    expect(plan.dualWriteRequired).toBe(false);
  });

  it('RP.2 — a split plan records the boundary it divides at', async () => {
    const { planner } = fixture();
    const plan = await planner.createSplitPlan(5, 'user:5000');

    // The boundary used to be an argument that reached nothing: the parameter was
    // accepted and dropped, so the plan described two target shards and no reason
    // for the line between them.
    expect(plan.splitKey).toBe('user:5000');
    expect(plan.targetShardIds).toEqual([51, 52]);
  });

  it('RP.3 — a merge plan targets the first of its sources', async () => {
    const { planner } = fixture();
    const plan = await planner.createMergePlan([3, 7]);

    expect(plan.sourceShardIds).toEqual([3, 7]);
    expect(plan.targetShardIds).toEqual([3]);
  });
});

// ── RP.4–RP.8: what a plan cannot do ───────────────────────

describe('I86: refusals before a copy starts', () => {
  it('RP.4 — a split is refused for the reason it cannot be verified', async () => {
    const { planner } = fixture();
    const plan = await planner.createSplitPlan(7, 'user:5');

    await expect(planner.executePlan(plan)).rejects.toThrow(/split plans are not executable/);
    // The message has to be actionable: which shard, which boundary, which two
    // targets — not "unsupported".
    await expect(planner.executePlan(plan)).rejects.toThrow('shard 7 becomes 71 and 72 at key "user:5"');
    await expect(planner.getProgress(plan.planId)).resolves.toBeNull();
    await expect(planner.listActivePlans()).resolves.toEqual([]);
  });

  it('RP.5 — a merge is refused because the target already holds entries', async () => {
    const { planner } = fixture();
    const plan = await planner.createMergePlan([10, 20]);

    await expect(planner.executePlan(plan)).rejects.toThrow(/merge plans are not executable/);
    await expect(planner.executePlan(plan)).rejects.toThrow('a comparison that holds for a move and not for a union');
  });

  it('RP.6 — a move that does not say where the shard lives is refused', async () => {
    const { planner } = fixture();
    const plan = await planner.createMovePlan(9, 'node-b'); // no source node

    await expect(planner.executePlan(plan)).rejects.toThrow(/does not say where shard 9 lives/);
    await expect(planner.executePlan(plan)).rejects.toThrow('createMovePlan(shardId, targetNodeId, sourceNodeId)');
  });

  it('RP.7 — a planner with no coordinator refuses rather than pretending', async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');

    await expect(planner.executePlan(plan)).rejects.toThrow(/constructed without a migration coordinator/);
    await expect(planner.getProgress(plan.planId)).resolves.toBeNull();
  });

  it('RP.8 — a plan already executing cannot be started twice', async () => {
    const { planner } = fixture();
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);

    await expect(planner.executePlan(plan)).rejects.toThrow('already executing');
    await settled(planner, planId);
  });
});

// ── RP.9–RP.13: the copy itself ────────────────────────────

describe('I86: moving a shard', () => {
  it('RP.9 — the target ends with the shard, at the versions the source assigned', async () => {
    const { store, sink, planner } = fixture(8);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);

    const progress = await settled(planner, planId);
    const target = sink.storeFor('node-b');

    expect(progress.status).toBe('completed');
    expect(progress.progressPercent).toBe(100);
    expect(target.size).toBe(8);
    expect(target.ordered()).toEqual(store.ordered());
    // The byte count is the source's, not a batch size multiplied by a constant.
    expect(progress.bytesMigrated).toBe(store.bytes());
    expect(progress.totalBytes).toBe(store.bytes());
    // Completion is the one state the coordinator will not report while the
    // target is short, so it is the one state that answers "consistent".
    await expect(planner.verifyConsistency(planId)).resolves.toEqual({ consistent: true, mismatches: 0 });
  });

  it('RP.10 — the phases are the coordinator’s, in the order it enters them', async () => {
    const { planner } = fixture(4);
    const seen = phases(planner);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    await settled(planner, planId);

    // `dualWriteRequired` is false for a move, so the initial sync reports
    // `migrating` rather than `dual-writing`; `verifying` is the cutover, and it
    // is a phase the copy actually enters rather than a delay before the end.
    expect(seen).toEqual(['preparing', 'migrating', 'verifying', 'completed']);
  });

  it('RP.11 — batches are counted from entries, not from a loop counter', async () => {
    const { planner } = fixture(8);
    const plan = { ...(await planner.createMovePlan(1, 'node-b', 'node-a')), batchSize: 3 };
    const planId = await planner.executePlan(plan);

    const progress = await settled(planner, planId);

    // 8 entries in batches of 3 is 3 batches, and the last of them lands.
    expect(progress.totalBatches).toBe(3);
    expect(progress.currentBatch).toBe(3);
  });

  it('RP.12 — an in-flight move reports what has arrived so far and stays active', async () => {
    const { source, sink, planner } = fixture(8);
    let release: () => void = () => undefined;
    source.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);

    const inFlight = (await planner.getProgress(planId))!;
    expect(inFlight.status).toBe('migrating');
    expect(inFlight.progressPercent).toBeLessThan(100);
    expect((await planner.listActivePlans()).map((p) => p.planId)).toEqual([planId]);
    const consistency = await planner.verifyConsistency(planId);
    expect(consistency.consistent).toBe(false);
    expect(consistency.mismatches).toBeGreaterThanOrEqual(1);

    release();
    const done = await settled(planner, planId);
    expect(done.status).toBe('completed');
    expect(sink.storeFor('node-b').size).toBe(8);
    await expect(planner.listActivePlans()).resolves.toEqual([]);
  });

  it('RP.13 — an empty shard completes with nothing to copy', async () => {
    const { planner } = fixture(0);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);

    const progress = await settled(planner, planId);

    expect(progress.status).toBe('completed');
    expect(progress.progressPercent).toBe(100);
    expect(progress.totalBatches).toBe(0);
    expect(progress.currentBatch).toBe(0);
    expect(progress.bytesMigrated).toBe(0);
  });

  it('RP.14 — the plan’s estimate is replaced by the source’s measurement', async () => {
    const { store, planner } = fixture(8);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const reports: IMigrationProgress[] = [];
    planner.onProgress((p) => reports.push(p));

    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);

    // The first report can only use the estimate — the source has not been asked
    // yet. Everything after it is measured.
    expect(reports[0]!.totalBytes).toBe(plan.estimatedSizeBytes);
    expect(reports[0]!.status).toBe('preparing');
    expect(progress.totalBytes).toBe(store.bytes());
  });
});

// ── RP.15–RP.20: failure, control, isolation ───────────────

describe('I86: what happens when the copy does not land', () => {
  it('RP.15 — a lost entry fails the plan with the conservation error', async () => {
    const { sink, planner } = fixture(4);
    sink.dropKeys.add('k2');

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);

    expect(progress.status).toBe('failed');
    expect(progress.errors[0]).toContain('lost entries');
    expect(progress.errors[0]).toContain('the target holds 3 of the source');
    const consistency = await planner.verifyConsistency(planId);
    expect(consistency.consistent).toBe(false);
    await expect(planner.listActivePlans()).resolves.toEqual([]);
  });

  it('RP.16 — cancelling a move in flight reports it as cancelled', async () => {
    const { source, planner } = fixture(8);
    let release: () => void = () => undefined;
    source.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);

    const cancelling = planner.cancelPlan(planId);
    release();
    await cancelling;

    const progress = await settled(planner, planId);
    expect(progress.status).toBe('failed');
    expect(progress.errors).toContain('cancelled by user');
  });

  it('RP.17 — rollback zeroes the counters and says so', async () => {
    const { planner } = fixture(4);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    await settled(planner, planId);

    await planner.rollbackPlan(planId);

    const progress = (await planner.getProgress(planId))!;
    expect(progress.status).toBe('rolled-back');
    expect(progress.bytesMigrated).toBe(0);
    expect(progress.progressPercent).toBe(0);
  });

  it('RP.18 — cancelling or rolling back a plan that never ran is not an error', async () => {
    const { planner } = fixture();
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');

    await expect(planner.cancelPlan(plan.planId)).resolves.toBeUndefined();
    await expect(planner.rollbackPlan(plan.planId)).resolves.toBeUndefined();
    // Nothing ran, so nothing is recorded: an absent progress is the honest answer.
    await expect(planner.getProgress(plan.planId)).resolves.toBeNull();
  });

  it('RP.18b — a plan nobody has heard of is not consistent, and says nothing else', async () => {
    const { planner } = fixture();
    await expect(planner.verifyConsistency('never-existed')).resolves.toEqual({ consistent: false, mismatches: 1 });
  });

  it('RP.19 — two planners over two shards see only their own plans', async () => {
    const first = fixture(2);
    const second = fixture(3);

    const a = await first.planner.createMovePlan(1, 'node-b', 'node-a');
    const b = await second.planner.createMovePlan(2, 'node-d', 'node-c');
    const aId = await first.planner.executePlan(a);
    const bId = await second.planner.executePlan(b);
    await settled(first.planner, aId);
    await settled(second.planner, bId);

    expect(first.planner.getAllPlans().map((p) => p.planId)).toEqual([aId]);
    expect(second.planner.getAllPlans().map((p) => p.planId)).toEqual([bId]);
    expect(first.sink.storeFor('node-b').size).toBe(2);
    expect(second.sink.storeFor('node-d').size).toBe(3);
  });

  it('RP.20 — a disposed planner stops reporting a copy that is still running', async () => {
    const { source, sink, planner } = fixture(8);
    let release: () => void = () => undefined;
    source.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    planner.dispose();
    release();

    // The copy finishes — the sink has the shard — and the planner, detached from
    // the coordinator, keeps the last report it accepted rather than inventing a
    // completion it did not see.
    await vi.waitFor(() => expect(sink.storeFor('node-b').size).toBe(8), { timeout: 3000, interval: 5 });
    const progress = (await planner.getProgress(planId))!;
    expect(progress.status).toBe('migrating');
  });

  it('RP.21 — a progress callback that throws does not stop the copy', async () => {
    const { sink, planner } = fixture(4);
    const delivered: string[] = [];
    planner.onProgress(() => {
      throw new Error('consumer bug');
    });
    planner.onProgress((p) => delivered.push(p.status));

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);

    // A consumer's bug is not the migration's failure: the shard still arrived,
    // and the consumers that behaved still heard about it.
    expect(progress.status).toBe('completed');
    expect(sink.storeFor('node-b').size).toBe(4);
    expect(delivered).toContain('completed');
  });

  it('RP.22 — an unsubscribed callback stops receiving reports', async () => {
    const { planner } = fixture(2);
    const seen: string[] = [];
    const off = planner.onProgress((p) => seen.push(p.status));
    off();
    off(); // Unsubscribing twice is not an error.

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    await settled(planner, planId);

    expect(seen).toEqual([]);
  });

  it('RP.22b — a listener that throws on the coordinator does not abandon the copy', async () => {
    const { migration, sink, planner } = fixture(3);
    migration.onProgress(() => {
      throw new Error('listener bug');
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);

    // The coordinator swallows a listener's exception for the same reason the
    // planner does: reporting is the caller's, the shard is the caller's data.
    expect(progress.status).toBe('completed');
    expect(sink.storeFor('node-b').size).toBe(3);
  });

  it('RP.23 — reset forgets the plans and the coordinator’s events', async () => {
    const { planner } = fixture(2);
    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    await settled(planner, planId);

    planner.reset();

    await expect(planner.getProgress(planId)).resolves.toBeNull();
    expect(planner.getAllPlans()).toEqual([]);
    await expect(planner.listActivePlans()).resolves.toEqual([]);
  });
});

describe('ReshardPlanner — C-04 progress callback reporting', () => {
  it('a throwing progress callback is reported with its source', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i += 1) store.put(`k${i}`, `v${i}`);
    const migration = new OnlineShardMigration(new MemoryShardSource(store), new MemoryShardSink());
    const reported: unknown[] = [];
    const planner = new ReshardPlanner(migration, (failure) => reported.push(failure));
    planner.onProgress(() => {
      throw new Error('consumer bug');
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);

    expect(progress.status).toBe('completed');
    expect(reported.length).toBeGreaterThan(0);
    expect((reported[0] as { source: string }).source).toBe('ReshardPlanner.progress');
  });
});

describe('ReshardPlanner — C-04 broken reporter isolation', () => {
  it('a reporter that throws cannot interrupt the copy', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i += 1) store.put(`k${i}`, `v${i}`);
    const migration = new OnlineShardMigration(new MemoryShardSource(store), new MemoryShardSink());
    const planner = new ReshardPlanner(migration, () => {
      throw new Error('reporter bug');
    });
    planner.onProgress(() => {
      throw new Error('consumer bug');
    });

    const plan = await planner.createMovePlan(1, 'node-b', 'node-a');
    const planId = await planner.executePlan(plan);
    const progress = await settled(planner, planId);
    expect(progress.status).toBe('completed');
  });
});
