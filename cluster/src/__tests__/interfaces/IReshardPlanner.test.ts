import { describe, it, expect, vi } from 'vitest';
import { IReshardPlanner, ReshardPlan, IMigrationProgress } from '../../interfaces/shard/IReshardPlanner';

describe('IReshardPlanner', () => {
  it('should define the interface contract with all methods', () => {
    const methods: (keyof IReshardPlanner)[] = [
      'createSplitPlan',
      'createMergePlan',
      'createMovePlan',
      'executePlan',
      'getProgress',
      'cancelPlan',
      'rollbackPlan',
      'listActivePlans',
      'verifyConsistency',
      'onProgress',
    ];
    expect(methods.length).toBe(10);
  });

  it('mock reshard planner should implement interface', async () => {
    const plan: ReshardPlan = {
      planId: 'plan-1',
      type: 'split',
      sourceShardIds: [0],
      targetShardIds: [1, 2],
      estimatedSizeBytes: 1_000_000_000,
      batchSize: 1000,
      maxLatencySpikeMs: 100,
      dualWriteRequired: true,
    };

    const progress: IMigrationProgress = {
      planId: 'plan-1',
      status: 'migrating',
      progressPercent: 50,
      currentBatch: 5,
      totalBatches: 10,
      bytesMigrated: 500_000_000,
      totalBytes: 1_000_000_000,
      startedAt: Date.now(),
      estimatedCompletionAt: Date.now() + 60000,
      errors: [],
    };

    const mock: IReshardPlanner = {
      createSplitPlan: vi.fn().mockResolvedValue(plan),
      createMergePlan: vi.fn().mockResolvedValue({ ...plan, planId: 'plan-2', type: 'merge' }),
      createMovePlan: vi.fn().mockResolvedValue({ ...plan, planId: 'plan-3', type: 'move' }),
      executePlan: vi.fn().mockResolvedValue('plan-1'),
      getProgress: vi.fn().mockResolvedValue(progress),
      cancelPlan: vi.fn().mockResolvedValue(undefined),
      rollbackPlan: vi.fn().mockResolvedValue(undefined),
      listActivePlans: vi.fn().mockResolvedValue([plan]),
      verifyConsistency: vi.fn().mockResolvedValue({ consistent: true, mismatches: 0 }),
      onProgress: vi.fn().mockReturnValue(() => {}),
    };

    // Verify createSplitPlan
    const splitPlan = await mock.createSplitPlan(0, 'user_id');
    expect(splitPlan.type).toBe('split');
    expect(splitPlan.planId).toBe('plan-1');
    expect(splitPlan.estimatedSizeBytes).toBe(1_000_000_000);

    // Verify executePlan
    const planId = await mock.executePlan(plan);
    expect(planId).toBe('plan-1');

    // Verify getProgress
    const prog = await mock.getProgress('plan-1');
    expect(prog).not.toBeNull();
    expect(prog!.status).toBe('migrating');
    expect(prog!.progressPercent).toBe(50);

    // Verify cancelPlan
    await expect(mock.cancelPlan('plan-1')).resolves.toBeUndefined();

    // Verify rollbackPlan
    await expect(mock.rollbackPlan('plan-1')).resolves.toBeUndefined();

    // Verify listActivePlans
    const plans = await mock.listActivePlans();
    expect(plans).toHaveLength(1);

    // Verify verifyConsistency
    const result = await mock.verifyConsistency('plan-1');
    expect(result.consistent).toBe(true);
    expect(result.mismatches).toBe(0);

    // Verify onProgress
    const unsubscribe = mock.onProgress(vi.fn());
    expect(typeof unsubscribe).toBe('function');
  });
});
