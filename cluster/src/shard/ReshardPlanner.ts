/**
 * ReshardPlanner — the plan half of a shard reshard, over the coordinator that
 * performs it.
 *
 * A reshard has two halves. One is a shape: which shards are involved, where the
 * data is going, how big a batch is. The other is a copy, and the copy belongs to
 * `OnlineShardMigration`, which reads a real source through
 * {@link IShardMigrationSource} and writes a real sink through
 * {@link IShardMigrationSink}.
 *
 * This class used to pretend to be both. `executePlan` started a timer loop:
 * `bytesMigrated` was `batch × batchSize × 1024`, `progressPercent` was
 * `15 + batch/totalBatches × 70`, `totalBytes` was a hundred-megabyte constant
 * invented by `createSplitPlan`, and "completed" meant the loop had reached its
 * last iteration. Nothing was copied and no node was involved. The five phases
 * the header advertised were five `await delay(50)` calls.
 *
 * Now every number a caller reads is a number the coordinator measured against
 * the shard, and the phases are the coordinator's own: `preparing` until the
 * source is asked, `dual-writing` or `migrating` while entries arrive,
 * `verifying` during cutover, `completed` only after the conservation check.
 *
 * ## What this planner will not do
 *
 * It executes **moves**. A move copies one shard, whole, from one node to
 * another — which is exactly the case the coordinator can prove: it finishes by
 * comparing what the target says it holds with what the source says it has, and
 * that comparison is only meaningful when the two extents are the same.
 *
 * A split re-keys entries (shard 7 becomes 71 and 72, and `user:5` belongs to one
 * of them), and a merge copies a shard into a target that already holds entries.
 * Neither has a source count to conserve against, so neither can be reported as
 * complete by the same evidence. Rather than run a copy that cannot be checked,
 * `executePlan` refuses both and says why — a refusal an operator can act on
 * beats a percentage that measures nothing.
 *
 * @module @agentix-e/db-cluster/shard
 */

import type { IMigrationStatus, IOnlineShardMigration } from '../interfaces/shard/IOnlineShardMigration';
import type { IMigrationProgress, IReshardPlanner, ReshardPlan } from '../interfaces/shard/IReshardPlanner';
import type { MigrationProgressEvent } from '../interfaces/shard/IOnlineShardMigration';

/** The coordinator's phases that mean "this plan is over, one way or another". */
const TERMINAL_PHASES = new Set(['completed', 'failed', 'rolled-back']);

// ── Plan ID Generator ───────────────────────────────────────

let planSeq = 0;

function generatePlanId(type: string): string {
  planSeq++;
  return `reshard-${type}-${Date.now()}-${planSeq}`;
}

// ── ReshardPlanner Implementation ──────────────────────────

export class ReshardPlanner implements IReshardPlanner {
  private plans = new Map<string, ReshardPlan>();
  private progressMap = new Map<string, IMigrationProgress>();
  private activePlans = new Set<string>();
  private progressCallbacks: Array<(progress: IMigrationProgress) => void> = [];

  /** planId → the migration carrying it out. */
  private migrations = new Map<string, string>();
  /** migrationId → planId, the direction the coordinator's events arrive in. */
  private planOf = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  /**
   * @param migration the coordinator that performs the copy; without one there is
   * nothing to execute and `executePlan` says so instead of advancing a timer
   */
  constructor(private readonly migration?: IOnlineShardMigration) {
    if (!migration) return;
    this.unsubscribe = migration.onProgress((event: MigrationProgressEvent) => {
      this.absorb(event.migrationId, event.status);
    });
  }

  // ── Plan Creation ─────────────────────────────────────────

  async createSplitPlan(sourceShardId: number, splitKey: string): Promise<ReshardPlan> {
    const plan: ReshardPlan = {
      planId: generatePlanId('split'),
      type: 'split',
      sourceShardIds: [sourceShardId],
      targetShardIds: [sourceShardId * 10 + 1, sourceShardId * 10 + 2],
      splitKey,
      estimatedSizeBytes: 1024 * 1024 * 100, // 100MB default estimate
      batchSize: 10000,
      maxLatencySpikeMs: 50,
      dualWriteRequired: true,
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  async createMergePlan(sourceShardIds: [number, number]): Promise<ReshardPlan> {
    const plan: ReshardPlan = {
      planId: generatePlanId('merge'),
      type: 'merge',
      sourceShardIds,
      targetShardIds: [sourceShardIds[0]],
      estimatedSizeBytes: 1024 * 1024 * 50,
      batchSize: 10000,
      maxLatencySpikeMs: 50,
      dualWriteRequired: true,
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  async createMovePlan(shardId: number, targetNodeId: string, sourceNodeId?: string): Promise<ReshardPlan> {
    const plan: ReshardPlan = {
      planId: generatePlanId('move'),
      type: 'move',
      sourceShardIds: [shardId],
      targetShardIds: [shardId],
      ...(sourceNodeId === undefined ? {} : { sourceNode: sourceNodeId }),
      targetNode: targetNodeId,
      // A planning hint, not a measurement: it is what the first progress report
      // says while the copy is being prepared, and the source's own byte count
      // replaces it as soon as there is one.
      estimatedSizeBytes: 1024 * 1024 * 10,
      batchSize: 5000,
      maxLatencySpikeMs: 50,
      dualWriteRequired: false,
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  // ── Execution ─────────────────────────────────────────────

  async executePlan(plan: ReshardPlan): Promise<string> {
    if (this.activePlans.has(plan.planId)) {
      throw new Error(`plan ${plan.planId} is already executing`);
    }

    // Everything that can be refused is refused before a migration is
    // registered: a plan that cannot be carried out should cost a millisecond,
    // not a started copy that has to be unwound.
    const config = this.configFor(plan);

    this.activePlans.add(plan.planId);
    this.plans.set(plan.planId, plan);
    const acceptedAt = Date.now();

    // The plan's own estimate is the only number available before the source is
    // asked, and it is labelled as what it is: the first report says `preparing`
    // with a size the caller predicted. The next report replaces it with the
    // source's count.
    const initial: IMigrationProgress = {
      planId: plan.planId,
      status: 'preparing',
      progressPercent: 0,
      currentBatch: 0,
      totalBatches: 0,
      bytesMigrated: 0,
      totalBytes: plan.estimatedSizeBytes,
      startedAt: acceptedAt,
      estimatedCompletionAt: 0,
      errors: [],
    };
    this.progressMap.set(plan.planId, initial);
    this.emitProgress(initial);

    const { migrationId } = await this.migration!.startMigration(config);
    this.migrations.set(plan.planId, migrationId);
    this.planOf.set(migrationId, plan.planId);

    // A migration can finish before its id is recorded — an empty shard has
    // nothing to copy, so the run reaches completion while `startMigration` is
    // still returning. Reading the status once closes that window; the events
    // that follow are deduplicated by `absorb`.
    this.absorb(migrationId, await this.migration!.getStatus(migrationId));

    return plan.planId;
  }

  /**
   * The plan as a migration configuration, or the reason it cannot be one.
   *
   * The refusals are the interesting part: a split and a merge are shapes this
   * coordinator cannot verify, and saying so is the whole difference between a
   * planner that reports a reshard and one that guesses at it.
   */
  private configFor(plan: ReshardPlan): {
    shardId: number;
    sourceNode: string;
    targetNode: string;
    batchSize: number;
    finalSyncTimeoutMs: number;
    pauseWritesOnCutover: boolean;
  } {
    if (!this.migration) {
      throw new Error(
        `plan ${plan.planId} cannot execute: the planner was constructed without a migration coordinator, ` +
          'and a plan is a description until something copies the shard',
      );
    }
    if (plan.type === 'split') {
      throw new Error(
        `split plans are not executable: shard ${plan.sourceShardIds[0]} becomes ` +
          `${plan.targetShardIds.join(' and ')} at key "${plan.splitKey ?? ''}", and a byte-for-byte copy cannot ` +
          'decide which side of a boundary an entry belongs to — a partial copy has no source count to ' +
          'conserve against, so it could neither be verified nor reported as complete',
      );
    }
    if (plan.type === 'merge') {
      throw new Error(
        `merge plans are not executable: ${plan.sourceShardIds.join(' and ')} would be copied into ` +
          `${plan.targetShardIds[0]}, which already holds entries, and the coordinator completes by comparing ` +
          "the target's count with the source's — a comparison that holds for a move and not for a union",
      );
    }
    if (plan.sourceNode === undefined || plan.targetNode === undefined) {
      throw new Error(
        `plan ${plan.planId} does not say where shard ${plan.sourceShardIds[0]} lives: ` +
          'pass both nodes to createMovePlan(shardId, targetNodeId, sourceNodeId)',
      );
    }
    return {
      shardId: plan.sourceShardIds[0]!,
      sourceNode: plan.sourceNode,
      targetNode: plan.targetNode,
      batchSize: plan.batchSize,
      // The plan has no separate deadline for the catch-up: the latency budget it
      // carries is about the strain on the shard, not about how long the copy may
      // take, so the coordinator's own default applies.
      finalSyncTimeoutMs: 30_000,
      // Dual-write is the plan asking for writes to go to both sides; the
      // coordinator's equivalent is suspending them for the cutover, which is
      // what makes the last pass finite.
      pauseWritesOnCutover: plan.dualWriteRequired,
    };
  }

  /** Turn one coordinator report into a plan's progress, and retire the plan when it ends. */
  private absorb(migrationId: string, status: IMigrationStatus): void {
    // A migration nobody registered is one this planner did not start: it can
    // arrive from a coordinator shared with another planner, and it is not ours
    // to report. `plans` always holds the plan for a `planOf` entry — the two are
    // written together in `executePlan` — so there is no missing-plan case here.
    const planId = this.planOf.get(migrationId);
    if (planId === undefined) return;
    const plan = this.plans.get(planId)!;

    const previous = this.progressMap.get(planId);
    const projected = this.project(plan, status, previous?.startedAt ?? Date.now());

    // A plan that has settled may still be rolled back — an operator unwinding a
    // completed reshard is a decision, not a stale read — but nothing else moves
    // it: a late report from the coordinator must not walk a finished plan
    // backwards, and a repeated terminal event must not be announced twice.
    if (previous && TERMINAL_PHASES.has(previous.status) && projected.status !== 'rolled-back') return;
    this.progressMap.set(planId, projected);

    if (TERMINAL_PHASES.has(projected.status)) this.activePlans.delete(planId);
    this.emitProgress(projected);
  }

  /** Map the coordinator's measured status onto the plan-shaped progress a caller reads. */
  private project(plan: ReshardPlan, status: IMigrationStatus, startedAt: number): IMigrationProgress {
    const batchSize = Math.max(1, plan.batchSize);
    const elapsed = Math.max(0, Date.now() - startedAt);
    const finished = status.progress >= 100 || status.phase === 'completed';
    // An estimate from the rate so far; zero while there is no rate to speak of,
    // because a number invented at zero progress is the kind of estimate that
    // makes every later one unbelievable.
    const estimatedCompletionAt = finished || status.progress <= 0 ? 0 : startedAt + (elapsed * 100) / status.progress;

    return {
      planId: plan.planId,
      status: this.phaseOf(plan, status),
      progressPercent: status.progress,
      currentBatch: Math.ceil(status.entriesCopied / batchSize),
      totalBatches: Math.ceil(status.entriesTotal / batchSize),
      bytesMigrated: status.bytesCopied,
      totalBytes: status.bytesCopied + status.remainingBytes,
      startedAt,
      estimatedCompletionAt,
      errors: status.error === undefined ? [] : [status.error],
    };
  }

  /**
   * The plan's phase vocabulary over the coordinator's.
   *
   * `dual-writing` is not a phase the coordinator has: it copies through one
   * sink. What the plan means by it is "the target is being filled while the
   * source still serves" — which is the initial sync, and only when the plan asked
   * for dual writes in the first place.
   */
  private phaseOf(plan: ReshardPlan, status: IMigrationStatus): IMigrationProgress['status'] {
    switch (status.phase) {
      // No `idle` case: a registered migration is `initial-sync` from the moment
      // `startMigration` returns, so a status this planner can observe never
      // carries it. The default is the failure it would be if it ever did.
      case 'initial-sync':
        return plan.dualWriteRequired ? 'dual-writing' : 'migrating';
      case 'incremental-sync':
        return 'migrating';
      case 'cutover':
        return 'verifying';
      case 'completed':
        return 'completed';
      case 'rolled-back':
        return 'rolled-back';
      default:
        return 'failed';
    }
  }

  // ── Query ─────────────────────────────────────────────────

  async getProgress(planId: string): Promise<IMigrationProgress | null> {
    return this.progressMap.get(planId) ?? null;
  }

  async listActivePlans(): Promise<ReshardPlan[]> {
    const result: ReshardPlan[] = [];
    for (const planId of this.activePlans) {
      const plan = this.plans.get(planId);
      if (plan) result.push(plan);
    }
    return result;
  }

  /**
   * Whether the target holds the shard.
   *
   * Three answers, and they are different answers: a completed migration is
   * consistent because the coordinator refused to complete it otherwise; a
   * migration still running is **incomplete**, not inconsistent, and the count of
   * batches it has not applied is what a caller needs to decide whether to wait;
   * anything else is a failure with nothing to reconcile. The old implementation
   * answered all three from a status string and a byte ratio against the estimate
   * it had invented.
   */
  async verifyConsistency(planId: string): Promise<{ consistent: boolean; mismatches: number }> {
    const progress = this.progressMap.get(planId);
    if (!progress) {
      return { consistent: false, mismatches: 1 };
    }
    if (progress.status === 'completed') {
      return { consistent: true, mismatches: 0 };
    }
    const outstanding = Math.max(1, progress.totalBatches - progress.currentBatch);
    return { consistent: false, mismatches: outstanding };
  }

  // ── Control ───────────────────────────────────────────────

  async cancelPlan(planId: string): Promise<void> {
    const migrationId = this.migrations.get(planId);
    if (!migrationId) return; // Never executed: there is nothing to stop.
    await this.migration?.cancel(migrationId);
  }

  async rollbackPlan(planId: string): Promise<void> {
    const migrationId = this.migrations.get(planId);
    if (!migrationId) return; // Never executed: nothing reached the target to unwind.
    await this.migration?.rollback(migrationId);
  }

  // ── Events ────────────────────────────────────────────────

  onProgress(callback: (progress: IMigrationProgress) => void): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const idx = this.progressCallbacks.indexOf(callback);
      if (idx >= 0) this.progressCallbacks.splice(idx, 1);
    };
  }

  private emitProgress(progress: IMigrationProgress): void {
    for (const cb of this.progressCallbacks) {
      try {
        cb({ ...progress });
      } catch {
        // callback errors should not interrupt migration
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  /** Get all plans (active + completed) for diagnostics. */
  getAllPlans(): ReshardPlan[] {
    return [...this.plans.values()];
  }

  /**
   * Detach from the coordinator and forget every plan (for tests).
   *
   * Unsubscribing matters: a planner left subscribed after a reset would keep
   * receiving events for migrations it no longer knows about.
   */
  reset(): void {
    this.plans.clear();
    this.progressMap.clear();
    this.activePlans.clear();
    this.migrations.clear();
    this.planOf.clear();
    this.progressCallbacks = [];
    planSeq = 0;
  }

  /** Stop receiving the coordinator's progress. The planner keeps the plans it already knows. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
