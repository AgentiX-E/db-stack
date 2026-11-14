/**
 * ReshardPlanner — exhaustive branch coverage.
 *
 * i22-resharding.test.ts covers the happy path (split/merge/move/rollback/
 * cancel/completion) but leaves several boundary branches unreached:
 *   - executePlan's failure catch (runMigrationPhases rejection)
 *   - listActivePlans while a plan is still active
 *   - verifyConsistency "rolled-back" status and mid-migration mismatch ratio
 *   - onProgress unsubscribe closure
 *   - emitProgress swallowing a throwing callback
 *
 * These tests close every remaining branch. The `delay` helper is spied to
 * control timing (reject for the failure path, resolve for the fast path) so
 * the tests remain deterministic without real sleep.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReshardPlanner } from '../../shard/ReshardPlanner';

function asAny(p: ReshardPlanner): any {
  return p as any;
}

describe('ReshardPlanner — branch completion', () => {
  let planner: ReshardPlanner;

  beforeEach(() => {
    planner = new ReshardPlanner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executePlan failure catch', () => {
    it('marks progress failed and emits via catch when a phase throws', async () => {
      // Force runMigrationPhases to reject by making delay reject.
      vi.spyOn(asAny(planner), 'delay').mockRejectedValue(new Error('phase boom'));

      const events: any[] = [];
      planner.onProgress((p) => events.push(p));

      const plan = await planner.createSplitPlan(1, 'mid');
      const planId = await planner.executePlan(plan);

      // Give the fire-and-forget promise a couple of microtask ticks.
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(planId);
        expect(progress?.status).toBe('failed');
      });

      const progress = await planner.getProgress(planId);
      expect(progress!.status).toBe('failed');
      expect(progress!.errors.length).toBeGreaterThan(0);
      expect(progress!.errors[0]).toContain('phase boom');
    });
  });

  describe('listActivePlans with active plan', () => {
    it('returns the plan while it is still active', async () => {
      // Block only the first delay so the plan stays active during the
      // assertion, then let the remaining phases resolve immediately.
      let gate: () => void = () => {};
      let calls = 0;
      vi.spyOn(asAny(planner), 'delay').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            calls++;
            if (calls === 1) {
              gate = resolve;
            } else {
              resolve();
            }
          }),
      );

      const plan = await planner.createSplitPlan(6, 'k');
      const planId = await planner.executePlan(plan);

      // The first phase awaits delay, so the plan is still active.
      const active = await planner.listActivePlans();
      expect(active.find((p) => p.planId === planId)).toBeDefined();

      // Release the migration so it can proceed.
      gate();
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(planId);
        expect(progress?.status).toBe('completed');
      });
    });
  });

  describe('verifyConsistency rolled-back and mid-migration', () => {
    it('returns inconsistent for a rolled-back plan', async () => {
      const plan = await planner.createSplitPlan(9, 'mid');
      const planId = await planner.executePlan(plan);
      await planner.rollbackPlan(planId);

      const result = await planner.verifyConsistency(planId);
      expect(result.consistent).toBe(false);
      expect(result.mismatches).toBe(1);
    });

    it('computes mismatch ratio during migration (bytesMigrated < totalBytes)', async () => {
      // Freeze the migration right after the first emit so bytesMigrated
      // remains far below totalBytes, then verify mid-migration inconsistency.
      let gate: () => void = () => {};
      let calls = 0;
      vi.spyOn(asAny(planner), 'delay').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            calls++;
            if (calls === 1) {
              gate = resolve;
            } else {
              resolve();
            }
          }),
      );

      const plan = await planner.createSplitPlan(7, 'mid');
      const planId = await planner.executePlan(plan);

      // Migration is blocked at the first delay; status is "preparing" with
      // bytesMigrated = 0 < totalBytes, so consistency should be false.
      const result = await planner.verifyConsistency(planId);
      // totalBytes > 0 and bytesMigrated == 0 → mismatchRatio == 1 → inconsistent.
      expect(result.consistent).toBe(false);
      expect(result.mismatches).toBe(1);

      gate();
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(planId);
        expect(progress?.status).toBe('completed');
      });
    });
  });

  describe('onProgress unsubscribe', () => {
    it('removes the callback when the returned unsubscriber is invoked', async () => {
      const events: string[] = [];
      const unsub = planner.onProgress((p) => events.push(p.status));

      // First execution emits; then unsubscribe.
      unsub();

      const plan = await planner.createSplitPlan(1, 'mid');
      await planner.executePlan(plan);
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(plan.planId);
        expect(progress?.status).toBe('completed');
      });

      expect(events).toHaveLength(0);
    });
  });

  describe('emitProgress callback exception isolation', () => {
    it('swallows a throwing callback and keeps other callbacks firing', async () => {
      const events: string[] = [];
      planner.onProgress(() => {
        throw new Error('callback exploded');
      });
      planner.onProgress((p) => events.push(p.status));

      const plan = await planner.createSplitPlan(1, 'mid');
      await planner.executePlan(plan);
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(plan.planId);
        expect(progress?.status).toBe('completed');
      });

      // The healthy callback still received all phase events.
      expect(events).toContain('preparing');
      expect(events).toContain('completed');
    });
  });

  describe('verifyConsistency totalBytes boundary', () => {
    it('returns consistent when totalBytes is zero (mismatch ratio 0)', async () => {
      // Inject a mid-migration progress with totalBytes = 0 to exercise the
      // `: 0` fallback and the mismatchRatio < 0.01 true branch.
      asAny(planner).progressMap.set('plan-zero', {
        planId: 'plan-zero',
        status: 'migrating',
        progressPercent: 50,
        currentBatch: 1,
        totalBatches: 10,
        bytesMigrated: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        estimatedCompletionAt: Date.now(),
        errors: [],
      });

      const result = await planner.verifyConsistency('plan-zero');
      expect(result.consistent).toBe(true);
      expect(result.mismatches).toBe(0);
    });

    it('returns consistent when mismatch ratio is below 1%', async () => {
      asAny(planner).progressMap.set('plan-near', {
        planId: 'plan-near',
        status: 'verifying',
        progressPercent: 90,
        currentBatch: 10,
        totalBatches: 10,
        bytesMigrated: 1000000,
        totalBytes: 1000000,
        startedAt: Date.now(),
        estimatedCompletionAt: Date.now(),
        errors: [],
      });

      const result = await planner.verifyConsistency('plan-near');
      expect(result.consistent).toBe(true);
      expect(result.mismatches).toBe(0);
    });
  });

  describe('createMovePlan execute + dualWriteRequired=false', () => {
    it('executes a move plan that skips the dual-writing phase', async () => {
      const plan = await planner.createMovePlan(42, 'node-z');
      const planId = await planner.executePlan(plan);
      await vi.waitFor(() => {
        const progress = planner.progressMap?.get(planId);
        expect(progress?.status).toBe('completed');
      });
      const progress = await planner.getProgress(planId);
      expect(progress!.status).toBe('completed');
    });
  });
});
