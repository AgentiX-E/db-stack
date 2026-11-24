/**
 * D2 Rolling Upgrade Orchestrator — production-grade zero-downtime upgrade engine.
 *
 * Features:
 *   - 4 batch strategies (fixed_size, percentage, one_by_one, all_at_once)
 *   - Canary deployment with configurable bake time and auto-promotion
 *   - Multi-dimensional health gating (latency, error rate, availability)
 *   - 5 rollback trigger policies (first_failure, batch_threshold, canary_failure, degradation, manual_only)
 *   - Graceful node draining with inflight request completion
 *   - Time-bounded execution with auto-abort
 *   - Pause/resume at batch boundaries
 *   - Full audit trail via RollingUpgradeEvent history
 *
 * @module @agentix-e/db-node/rollingupgrade/impl
 */

import type {
  IRollingUpgrade,
  RollingUpgradePlan,
  RollingUpgradeStats,
  RollingUpgradeEvent,
  UpgradePhase,
  UpgradeBatch,
  BatchHealth,
  NodeUpgradeState,
  CanaryConfig,
  DrainConfig,
  IVersionProbe,
} from '../interfaces/index.js';

/** Default drain configuration. */
const DEFAULT_DRAIN: Required<DrainConfig> = {
  timeoutMs: 30_000,
  waitForInflight: true,
  connectionDrainMs: 5_000,
};

/** Minimum canary bake time (safety floor). */
const MIN_CANARY_BAKE_MS = 10_000;

/** How long a node gets to report the target version, before the plan's own value. */
const DEFAULT_UPGRADE_TIMEOUT_MS = 30_000;

/** How often a node's version is read while waiting for it to change. */
const DEFAULT_UPGRADE_POLL_MS = 250;

/**
 * A node did not report the target version in time.
 *
 * Typed so the batch path can turn it into a failed batch — and the plan's
 * rollback policy — while every other error keeps propagating out of `execute()`
 * as it did before. An interruption during the drain is the caller's problem;
 * a node that came back on the old version is the upgrade's.
 */
class UpgradeNotVerified extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'UpgradeNotVerified';
  }
}

// ── Orchestrator ─────────────────────────────────────────────

export class RollingUpgradeOrchestrator implements IRollingUpgrade {
  private plan: RollingUpgradePlan | null = null;
  private phase: UpgradePhase = 'idle';
  private batches: UpgradeBatch[] = [];
  private events: RollingUpgradeEvent[] = [];
  private paused = false;
  private stats: RollingUpgradeStats | null = null;
  private healthChecks = new Map<string, (nodeId: string) => Promise<BatchHealth>>();
  private startTime = 0;

  /** Injectable sleep for testing. Defaults to real setTimeout. */
  private _sleepFn: (ms: number) => Promise<void>;
  /** Override min canary bake time for testing (default 10s). */
  private _minBakeMs: number;
  /** The node's own account of what it is running. Absent means no upgrade can be verified. */
  private _probe: IVersionProbe | undefined;

  constructor(opts?: { minBakeMs?: number; sleep?: (ms: number) => Promise<void>; probe?: IVersionProbe }) {
    this._sleepFn = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms))));
    this._minBakeMs = opts?.minBakeMs ?? MIN_CANARY_BAKE_MS;
    this._probe = opts?.probe;
  }

  // ── Public API ──────────────────────────────────────────

  getPhase(): UpgradePhase {
    return this.phase;
  }

  getBatches(): UpgradeBatch[] {
    return this.batches.map((b) => ({
      ...b,
      nodes: b.nodes.map((n) => ({ ...n })),
    }));
  }

  getEvents(): RollingUpgradeEvent[] {
    return [...this.events];
  }

  getStats(): RollingUpgradeStats | null {
    return this.stats ? { ...this.stats, events: [...this.stats.events] } : null;
  }

  async pause(): Promise<void> {
    this.paused = true;
    this._emit('paused', { phase: this.phase });
  }

  async resume(): Promise<void> {
    this.paused = false;
    this._emit('resumed', { phase: this.phase });
  }

  async rollback(): Promise<RollingUpgradeStats> {
    this._emit('rollback_triggered', { reason: 'manual' });

    let rolledBack = 0;
    for (const batch of this.batches) {
      for (const node of batch.nodes) {
        if (this._rollbackNode(node)) rolledBack++;
      }
      if (batch.nodes.some((n) => n.status === 'rolled_back')) {
        batch.status = 'rolled_back';
      }
    }

    this.phase = 'rolling_back';
    this._emit('rollback_completed', { rolledBackNodes: rolledBack });
    this.phase = 'idle';

    return this._buildStats();
  }

  /**
   * Roll back a single node if it has begun progressing (draining/upgrading/
   * health_check) or already completed. Returns true if the node was rolled
   * back. `failed` nodes are left as-is — they never reached a healthy state,
   * so there is nothing to roll back.
   */
  private _rollbackNode(node: NodeUpgradeState): boolean {
    const inFlightOrCompleted =
      node.status === 'completed' ||
      node.status === 'draining' ||
      node.status === 'upgrading' ||
      node.status === 'health_check';
    if (inFlightOrCompleted) {
      node.status = 'rolled_back';
      node.completedAt = Date.now();
      return true;
    }
    return false;
  }

  registerHealthCheck(name: string, fn: (nodeId: string) => Promise<BatchHealth>): void {
    this.healthChecks.set(name, fn);
  }

  // ── Execute ──────────────────────────────────────────────

  async execute(plan: RollingUpgradePlan): Promise<RollingUpgradeStats> {
    // Validate
    this._validatePlan(plan);
    this.plan = plan;
    this.startTime = Date.now();
    this.batches = this._buildBatches();
    this.events = [];
    this.paused = false;
    this.phase = 'validating';

    this._emit('plan_validated', {
      totalNodes: plan.nodes.length,
      totalBatches: this.batches.length,
      hasCanary: !!plan.canary,
    });

    // ── Canary phase ──────────────────────────────────────
    if (plan.canary) {
      this.phase = 'canary';
      const canaryBatch = this.batches.find((b) => b.isCanary);
      if (canaryBatch) {
        try {
          await this._executeCanary(canaryBatch, plan.canary);
        } catch (err) {
          // Canary failed — rollback trigger. The reason is the actual one: a
          // canary that never reported the target version and a canary that
          // reported it and then failed its health check are different incidents.
          this._handleFailure('canary', canaryBatch, err instanceof Error ? err.message : 'Canary failed');
          return this._buildStats();
        }
      }
    }

    // ── Rolling phase ──────────────────────────────────────
    this.phase = 'rolling';

    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i]!;

      // Skip canary (already handled)
      if (batch.isCanary) continue;

      // Time-bound abort
      if (plan.maxDurationMs && Date.now() - this.startTime > plan.maxDurationMs) {
        return this._abort('Maximum duration exceeded');
      }

      // Pause gate
      while (this.paused) {
        await this._sleepFn(100);
      }

      const ok = await this._executeBatch(batch, i);
      if (!ok) break; // Failure occurred, stop rolling
    }

    // Determine final phase
    if (this.phase === 'rolling' || this.phase === 'health_checking') {
      // No failures — complete
      this.phase = 'completing';
      this._emit('upgrade_completed', {
        totalBatches: this.batches.length,
        upgradedNodes: plan.nodes.length,
      });
      this.phase = 'completed';
    }

    return this._buildStats();
  }

  // ── Internal: Validation ─────────────────────────────────

  private _validatePlan(plan: RollingUpgradePlan): void {
    // An empty node list and a missing id are one refusal: a plan that names no
    // nodes has nothing to upgrade either way. The second `length === 0` check
    // that used to follow was unreachable — the first test already covers it, and
    // a branch nothing can enter is not a stricter validation, just a line that
    // shows up as uncovered.
    const missingId = !plan.id;
    const emptyNodes = !plan.nodes.length;
    if (missingId || emptyNodes) {
      throw new Error('Invalid plan: id and nodes are required');
    }
    if (plan.canary) {
      const fractionNotPositive = plan.canary.fraction <= 0;
      const fractionExceedsOne = plan.canary.fraction > 1;
      if (fractionNotPositive || fractionExceedsOne) {
        throw new Error('Canary fraction must be between 0 and 1');
      }
      const bakeTooShort = plan.canary.bakeTimeMs < this._minBakeMs;
      if (bakeTooShort) {
        throw new Error(`Canary bake time must be >= ${this._minBakeMs}ms`);
      }
    }
    const isFixedSize = plan.batchStrategy === 'fixed_size';
    const batchSizeInvalid = !plan.batchSize || plan.batchSize < 1;
    if (isFixedSize && batchSizeInvalid) {
      throw new Error('batchSize must be >= 1 for fixed_size strategy');
    }
    // Verify health checks exist
    for (const name of plan.healthCheckNames) {
      const missingCheck = !this.healthChecks.has(name);
      if (missingCheck) {
        throw new Error(`Health check "${name}" is not registered`);
      }
    }
    // A plan without a probe is a plan whose outcome nobody can check. Refusing
    // here costs a millisecond; the alternative is a `completed` batch of nodes
    // that are still on the old version, which is the failure mode this
    // orchestrator used to manufacture by sleeping for zero milliseconds and
    // calling that an upgrade.
    if (!this._probe) {
      throw new Error(
        `Invalid plan: targetVersion "${plan.targetVersion}" cannot be verified — ` +
          'no version probe was passed to the constructor',
      );
    }
  }

  // ── Internal: Batch Construction ─────────────────────────

  private _buildBatches(): UpgradeBatch[] {
    const plan = this.plan!;
    const batches: UpgradeBatch[] = [];
    const remainingNodes = [...plan.nodes];

    // Canary nodes first
    if (plan.canary) {
      const fraction = plan.canary.fraction;
      const fractionTimesLength = Math.ceil(remainingNodes.length * fraction);
      const maxCanary = plan.canary.maxCanaryNodes ?? remainingNodes.length;
      const floor = Math.min(fractionTimesLength, maxCanary);
      const canaryCount = Math.max(1, floor);
      const canaryNodes = remainingNodes.splice(0, canaryCount);
      batches.push(this._makeBatch(canaryNodes, batches.length + 1, true));
    }

    // Remaining batches by strategy
    switch (plan.batchStrategy) {
      case 'one_by_one':
        while (remainingNodes.length > 0) {
          batches.push(this._makeBatch(remainingNodes.splice(0, 1), batches.length + 1, false));
        }
        break;

      case 'all_at_once':
        if (remainingNodes.length > 0) {
          batches.push(this._makeBatch(remainingNodes.splice(0), batches.length + 1, false));
        }
        break;

      case 'percentage': {
        const pct = plan.batchSize && plan.batchSize > 0 ? plan.batchSize : 20;
        while (remainingNodes.length > 0) {
          const pctDiv100 = pct / 100;
          const multiplied = remainingNodes.length * pctDiv100;
          const size = Math.max(1, Math.ceil(multiplied));
          batches.push(this._makeBatch(remainingNodes.splice(0, size), batches.length + 1, false));
        }
        break;
      }

      case 'fixed_size':
      default: {
        const size = plan.batchSize ?? 1;
        while (remainingNodes.length > 0) {
          const cappedSize = Math.min(size, remainingNodes.length);
          batches.push(this._makeBatch(remainingNodes.splice(0, cappedSize), batches.length + 1, false));
        }
        break;
      }
    }

    return batches;
  }

  private _makeBatch(nodes: string[], index: number, isCanary: boolean): UpgradeBatch {
    return {
      index,
      isCanary,
      status: 'pending',
      nodes: nodes.map((nodeId) => ({
        nodeId,
        status: 'pending' as const,
      })),
    };
  }

  // ── Internal: Canary Execution ───────────────────────────

  private async _executeCanary(batch: UpgradeBatch, config: CanaryConfig): Promise<void> {
    this._emit('canary_started', { batchIndex: batch.index, nodes: batch.nodes.map((n) => n.nodeId) }, batch.index);

    // Mark nodes as upgrading
    await this._drainAndUpgrade(batch);

    // Check canary health
    batch.status = 'running';
    const health = await this._checkBatchHealth(batch);
    this._emit('canary_health_checked', { batchIndex: batch.index, healthy: health.healthy }, batch.index);

    if (!health.healthy) {
      this._emit('canary_failed', { batchIndex: batch.index }, batch.index);
      throw new Error('Canary health check failed');
    }

    // Bake period
    if (config.bakeTimeMs > 0) {
      await this._sleepFn(config.bakeTimeMs);
    }

    // Promote canary
    for (const node of batch.nodes) {
      node.status = 'completed';
      node.completedAt = Date.now();
    }
    batch.status = 'completed';
    this._emit('canary_promoted', { batchIndex: batch.index }, batch.index);
  }

  // ── Internal: Batch Execution ────────────────────────────

  private async _executeBatch(batch: UpgradeBatch, _globalIndex: number): Promise<boolean> {
    this._emit('batch_started', { batchIndex: batch.index, nodes: batch.nodes.map((n) => n.nodeId) }, batch.index);

    // Drain and upgrade
    try {
      await this._drainAndUpgrade(batch);
    } catch (err) {
      // A node that came back on the wrong version is a failed batch, and the
      // plan's rollback policy decides what happens next. Every other error — a
      // drain interrupted by the caller, a probe that threw something other than
      // a version read — keeps propagating as it did before.
      if (!(err instanceof UpgradeNotVerified)) throw err;
      this._handleFailure('upgrade', batch, err.message);
      return false;
    }

    // Health check
    batch.status = 'running';
    this.phase = 'health_checking';
    const health = await this._checkBatchHealth(batch);
    this._emit('batch_health_checked', { batchIndex: batch.index, healthy: health.healthy }, batch.index);

    const plan = this.plan!;

    if (!health.healthy) {
      if (plan.rollbackTrigger === 'on_batch_threshold') {
        const threshold = plan.batchFailureThreshold ?? 0.5;
        const failed = batch.nodes.filter((n) => n.status === 'failed').length;
        if (failed / batch.nodes.length >= threshold) {
          this._handleFailure('batch_threshold', batch, `Batch failure threshold ${threshold * 100}% reached`);
          return false;
        }
        // Below threshold: tolerate the partial failure. Promote the healthy
        // nodes to completed and leave the failed ones as-is, then continue
        // the rolling upgrade.
        for (const node of batch.nodes) {
          if (node.status !== 'failed') {
            node.status = 'completed';
            node.completedAt = Date.now();
          }
        }
        batch.status = 'completed';
        this._emit('batch_promoted', { batchIndex: batch.index }, batch.index);
        this.phase = 'rolling';
        return true;
      }

      this._handleFailure('batch', batch, 'Batch health check failed');
      return false;
    }

    // Promote batch
    for (const node of batch.nodes) {
      node.status = 'completed';
      node.completedAt = Date.now();
    }
    batch.status = 'completed';
    this._emit('batch_promoted', { batchIndex: batch.index }, batch.index);
    this.phase = 'rolling';
    return true;
  }

  // ── Internal: Drain & Upgrade ────────────────────────────

  private async _drainAndUpgrade(batch: UpgradeBatch): Promise<void> {
    const drain = this.plan?.drain ?? DEFAULT_DRAIN;

    for (const node of batch.nodes) {
      if (node.status === 'pending') {
        // Phase 1: Drain connections
        if (drain.waitForInflight) {
          node.status = 'draining';
          node.startedAt = Date.now();
          await this._sleepFn(drain.connectionDrainMs);
        }

        // Phase 2: Upgrade, and wait for the node to say so
        node.status = 'upgrading';
        await this._awaitReportedVersion(node);

        // Phase 3: Health check post-upgrade
        node.status = 'health_check';
      }
    }
  }

  /**
   * Wait until the node reports the plan's target version.
   *
   * The wait is the upgrade. Everything before it — draining connections, setting
   * `upgrading` — is preparation, and everything after it reasons about a node
   * whose version is known. The old implementation slept for zero milliseconds in
   * this position and moved on, so a node that failed to restart was counted in
   * `upgradedNodes` and health-checked as if it were new.
   *
   * The deadline is counted in polls, not against a wall clock: a caller that
   * injects an instant sleep still gets a bounded number of attempts, and the
   * failure arrives in the same number of polls on every machine.
   */
  private async _awaitReportedVersion(node: NodeUpgradeState): Promise<void> {
    const plan = this.plan!;
    const probe = this._probe!;
    const target = plan.targetVersion;
    const interval = Math.max(1, plan.upgradePollIntervalMs ?? DEFAULT_UPGRADE_POLL_MS);
    const timeoutMs = plan.upgradeTimeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS;
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / interval));

    // A restart that cannot be requested is not an upgrade that is merely slow:
    // the node was never asked to change version, so waiting for it would burn
    // the whole budget to report a timeout that hides the real reason.
    if (probe.requestUpgrade) {
      try {
        await probe.requestUpgrade(node.nodeId, target);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        node.status = 'failed';
        node.error = `could not request upgrade to ${target}: ${reason}`;
        throw new UpgradeNotVerified(node.nodeId, node.error);
      }
    }

    let last: string | null = null;
    let lastError: string | undefined;
    for (let poll = 0; poll < maxPolls; poll++) {
      try {
        last = await probe.reportedVersion(node.nodeId);
        lastError = undefined;
      } catch (err) {
        // A node that cannot be reached mid-restart is exactly what the loop is
        // for. The reason is kept so a timeout can say why it never heard back.
        last = null;
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (last === target) {
        node.reportedVersion = target;
        this._emit(
          'node_version_confirmed',
          { nodeId: node.nodeId, version: target, polls: poll + 1 },
          undefined,
          node.nodeId,
        );
        return;
      }

      if (poll + 1 < maxPolls) await this._sleepFn(interval);
    }

    node.status = 'failed';
    node.error =
      `node did not report version ${target} within ${timeoutMs} ms ` +
      `(${maxPolls} polls): ${last === null ? 'no version reported' : `it reports ${last}`}` +
      (lastError === undefined ? '' : ` — ${lastError}`);
    throw new UpgradeNotVerified(node.nodeId, node.error);
  }

  // ── Internal: Health Checking ─────────────────────────────

  private async _checkBatchHealth(batch: UpgradeBatch): Promise<BatchHealth> {
    const checks = this.plan!.healthCheckNames;
    if (checks.length === 0) {
      return { healthy: true, nodes: [], evaluatedAt: Date.now() };
    }

    const nodeResults: BatchHealth['nodes'] = [];
    let allHealthy = true;

    for (const node of batch.nodes) {
      let nodeHealthy = true;
      for (const checkName of checks) {
        // `_validatePlan` has already refused any name that is not registered, so
        // there is no missing-function case here to guard: the lookup cannot fail.
        const fn = this.healthChecks.get(checkName)!;

        try {
          const result = await fn(node.nodeId);
          nodeResults.push(...result.nodes);
          if (!result.healthy) nodeHealthy = false;
        } catch {
          nodeHealthy = false;
        }
      }

      // Mark only the nodes whose checks actually failed. Healthy nodes stay in
      // their in-flight `health_check` state so callers (e.g. on_batch_threshold)
      // can distinguish a partial failure from a total one.
      if (!nodeHealthy) {
        node.status = 'failed';
        allHealthy = false;
      }
    }

    return {
      healthy: allHealthy,
      nodes: nodeResults,
      evaluatedAt: Date.now(),
    };
  }

  // ── Internal: Failure Handling ───────────────────────────

  private _handleFailure(trigger: string, batch: UpgradeBatch, reason: string): void {
    batch.status = 'failed';
    for (const node of batch.nodes) {
      if (node.status !== 'completed') {
        node.status = 'failed';
        node.error = reason;
      }
    }
    this._emit('batch_failed', { batchIndex: batch.index, reason }, batch.index);

    const plan = this.plan!;

    // Determine rollback action based on trigger policy
    const isFirstFailure = plan.rollbackTrigger === 'on_first_failure';
    const isCanaryFailure = plan.rollbackTrigger === 'on_canary_failure';
    const isDegradation = plan.rollbackTrigger === 'on_degradation';
    const isBatchThreshold = trigger === 'batch_threshold' && plan.rollbackTrigger === 'on_batch_threshold';

    const shouldRollback = isFirstFailure || isCanaryFailure || isDegradation || isBatchThreshold;

    if (shouldRollback) {
      this._rollbackAll(trigger);
    } else {
      // manual_only or no matching trigger → mark failed but don't rollback
      this.phase = 'failed';
    }
  }

  private _rollbackAll(trigger: string): void {
    this._emit('rollback_triggered', { reason: trigger });
    this.phase = 'rolling_back';

    for (const batch of this.batches) {
      for (const node of batch.nodes) {
        this._rollbackNode(node);
      }
      if (batch.nodes.some((n) => n.status === 'rolled_back')) {
        batch.status = 'rolled_back';
      }
    }

    this._emit('rollback_completed', {
      rolledBackBatches: this.batches.filter((b) => b.status === 'rolled_back').length,
    });
    this.phase = 'failed';
  }

  private _abort(reason: string): RollingUpgradeStats {
    this._emit('upgrade_aborted', { reason });
    this.phase = 'aborted';
    return this._buildStats();
  }

  // ── Internal: Stats & Events ─────────────────────────────

  private _buildStats(): RollingUpgradeStats {
    const plan = this.plan!;
    const allNodes = this.batches.flatMap((b) => b.nodes);
    const completedNodes = allNodes.filter((n) => n.status === 'completed').length;
    const failedNodes = allNodes.filter((n) => n.status === 'failed').length;
    const rolledBackNodes = allNodes.filter((n) => n.status === 'rolled_back').length;
    const completedBatches = this.batches.filter((b) => b.status === 'completed').length;
    const completedAt = Date.now();
    const durationMs = completedAt - this.startTime;

    const stats: RollingUpgradeStats = {
      planId: plan.id,
      totalNodes: plan.nodes.length,
      upgradedNodes: completedNodes,
      failedNodes,
      rolledBackNodes,
      totalBatches: this.batches.length,
      completedBatches,
      startedAt: this.startTime,
      completedAt,
      durationMs,
      phase: this.phase,
      events: [...this.events],
    };

    this.stats = stats;
    return stats;
  }

  private _emit(
    type: RollingUpgradeEvent['type'],
    details: Record<string, unknown>,
    batchIndex?: number,
    nodeId?: string,
  ): void {
    const event: RollingUpgradeEvent = {
      type,
      timestamp: Date.now(),
      batchIndex,
      nodeId,
      details,
    };
    this.events.push(event);
  }

  // ── Utility ──────────────────────────────────────────────
}
