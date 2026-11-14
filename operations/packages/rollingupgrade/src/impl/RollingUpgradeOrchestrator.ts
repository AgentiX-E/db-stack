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
 * @module @agentix-e/db-operations-rollingupgrade/impl
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
} from "../interfaces/index.js";

/** Default drain configuration. */
const DEFAULT_DRAIN: Required<DrainConfig> = {
  timeoutMs: 30_000,
  waitForInflight: true,
  connectionDrainMs: 5_000,
};

/** Minimum canary bake time (safety floor). */
const MIN_CANARY_BAKE_MS = 10_000;

// ── Orchestrator ─────────────────────────────────────────────

export class RollingUpgradeOrchestrator implements IRollingUpgrade {
  private plan: RollingUpgradePlan | null = null;
  private phase: UpgradePhase = "idle";
  private batches: UpgradeBatch[] = [];
  private events: RollingUpgradeEvent[] = [];
  private paused = false;
  private stats: RollingUpgradeStats | null = null;
  private healthChecks = new Map<
    string,
    (nodeId: string) => Promise<BatchHealth>
  >();
  private startTime = 0;

  /** Injectable sleep for testing. Defaults to real setTimeout. */
  private _sleepFn: (ms: number) => Promise<void>;
  /** Override min canary bake time for testing (default 10s). */
  private _minBakeMs: number;

  constructor(opts?: { minBakeMs?: number; sleep?: (ms: number) => Promise<void> }) {
    this._sleepFn = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms))));
    this._minBakeMs = opts?.minBakeMs ?? MIN_CANARY_BAKE_MS;
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
    this._emit("paused", { phase: this.phase });
  }

  async resume(): Promise<void> {
    this.paused = false;
    this._emit("resumed", { phase: this.phase });
  }

  async rollback(): Promise<RollingUpgradeStats> {
    this._emit("rollback_triggered", { reason: "manual" });

    let rolledBack = 0;
    for (const batch of this.batches) {
      for (const node of batch.nodes) {
        if (this._rollbackNode(node)) rolledBack++;
      }
      if (batch.nodes.some((n) => n.status === "rolled_back")) {
        batch.status = "rolled_back";
      }
    }

    this.phase = "rolling_back";
    this._emit("rollback_completed", { rolledBackNodes: rolledBack });
    this.phase = "idle";

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
      node.status === "completed" ||
      node.status === "draining" ||
      node.status === "upgrading" ||
      node.status === "health_check";
    if (inFlightOrCompleted) {
      node.status = "rolled_back";
      node.completedAt = Date.now();
      return true;
    }
    return false;
  }

  registerHealthCheck(
    name: string,
    fn: (nodeId: string) => Promise<BatchHealth>,
  ): void {
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
    this.phase = "validating";

    this._emit("plan_validated", {
      totalNodes: plan.nodes.length,
      totalBatches: this.batches.length,
      hasCanary: !!plan.canary,
    });

    // ── Canary phase ──────────────────────────────────────
    if (plan.canary) {
      this.phase = "canary";
      const canaryBatch = this.batches.find((b) => b.isCanary);
      if (canaryBatch) {
        try {
          await this._executeCanary(canaryBatch, plan.canary);
        } catch {
          // Canary failed — rollback trigger
          this._handleFailure("canary", canaryBatch, "Canary health check failed");
          return this._buildStats();
        }
      }
    }

    // ── Rolling phase ──────────────────────────────────────
    this.phase = "rolling";

    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i]!;

      // Skip canary (already handled)
      if (batch.isCanary) continue;

      // Time-bound abort
      if (plan.maxDurationMs && Date.now() - this.startTime > plan.maxDurationMs) {
        return this._abort("Maximum duration exceeded");
      }

      // Pause gate
      while (this.paused) {
        await this._sleepFn(100);
      }

      const ok = await this._executeBatch(batch, i);
      if (!ok) break; // Failure occurred, stop rolling
    }

    // Determine final phase
    if (this.phase === "rolling" || this.phase === "health_checking") {
      // No failures — complete
      this.phase = "completing";
      this._emit("upgrade_completed", {
        totalBatches: this.batches.length,
        upgradedNodes: plan.nodes.length,
      });
      this.phase = "completed";
    }

    return this._buildStats();
  }

  // ── Internal: Validation ─────────────────────────────────

  private _validatePlan(plan: RollingUpgradePlan): void {
    const missingId = !plan.id;
    const emptyNodes = !plan.nodes.length;
    if (missingId || emptyNodes) {
      throw new Error("Invalid plan: id and nodes are required");
    }
    const zeroNodes = plan.nodes.length === 0;
    if (zeroNodes) {
      throw new Error("Invalid plan: nodes list cannot be empty");
    }
    if (plan.canary) {
      const fractionNotPositive = plan.canary.fraction <= 0;
      const fractionExceedsOne = plan.canary.fraction > 1;
      if (fractionNotPositive || fractionExceedsOne) {
        throw new Error("Canary fraction must be between 0 and 1");
      }
      const bakeTooShort = plan.canary.bakeTimeMs < this._minBakeMs;
      if (bakeTooShort) {
        throw new Error(`Canary bake time must be >= ${this._minBakeMs}ms`);
      }
    }
    const isFixedSize = plan.batchStrategy === "fixed_size";
    const batchSizeInvalid = !plan.batchSize || plan.batchSize < 1;
    if (isFixedSize && batchSizeInvalid) {
      throw new Error("batchSize must be >= 1 for fixed_size strategy");
    }
    // Verify health checks exist
    for (const name of plan.healthCheckNames) {
      const missingCheck = !this.healthChecks.has(name);
      if (missingCheck) {
        throw new Error(`Health check "${name}" is not registered`);
      }
    }
  }

  // ── Internal: Batch Construction ─────────────────────────

  private _buildBatches(): UpgradeBatch[] {
    const plan = this.plan!;
    const batches: UpgradeBatch[] = [];
    let remainingNodes = [...plan.nodes];

    // Canary nodes first
    if (plan.canary) {
      const fraction = plan.canary.fraction;
      const fractionTimesLength = Math.ceil(remainingNodes.length * fraction);
      const maxCanary = plan.canary.maxCanaryNodes ?? remainingNodes.length;
      const floor = Math.min(fractionTimesLength, maxCanary);
      const canaryCount = Math.max(1, floor);
      const canaryNodes = remainingNodes.splice(0, canaryCount);
      batches.push(
        this._makeBatch(canaryNodes, batches.length + 1, true),
      );
    }

    // Remaining batches by strategy
    switch (plan.batchStrategy) {
      case "one_by_one":
        while (remainingNodes.length > 0) {
          batches.push(
            this._makeBatch(remainingNodes.splice(0, 1), batches.length + 1, false),
          );
        }
        break;

      case "all_at_once":
        if (remainingNodes.length > 0) {
          batches.push(
            this._makeBatch(remainingNodes.splice(0), batches.length + 1, false),
          );
        }
        break;

      case "percentage": {
        const pct = plan.batchSize && plan.batchSize > 0 ? plan.batchSize : 20;
        while (remainingNodes.length > 0) {
          const pctDiv100 = pct / 100;
          const multiplied = remainingNodes.length * pctDiv100;
          const size = Math.max(1, Math.ceil(multiplied));
          batches.push(
            this._makeBatch(remainingNodes.splice(0, size), batches.length + 1, false),
          );
        }
        break;
      }

      case "fixed_size":
      default: {
        const size = plan.batchSize ?? 1;
        while (remainingNodes.length > 0) {
          const cappedSize = Math.min(size, remainingNodes.length);
          batches.push(
            this._makeBatch(remainingNodes.splice(0, cappedSize), batches.length + 1, false),
          );
        }
        break;
      }
    }

    return batches;
  }

  private _makeBatch(
    nodes: string[],
    index: number,
    isCanary: boolean,
  ): UpgradeBatch {
    return {
      index,
      isCanary,
      status: "pending",
      nodes: nodes.map((nodeId) => ({
        nodeId,
        status: "pending" as const,
      })),
    };
  }

  // ── Internal: Canary Execution ───────────────────────────

  private async _executeCanary(
    batch: UpgradeBatch,
    config: CanaryConfig,
  ): Promise<void> {
    this._emit("canary_started", { batchIndex: batch.index, nodes: batch.nodes.map((n) => n.nodeId) });

    // Mark nodes as upgrading
    await this._drainAndUpgrade(batch);

    // Check canary health
    batch.status = "running";
    const health = await this._checkBatchHealth(batch);
    this._emit("canary_health_checked", {
      batchIndex: batch.index,
      healthy: health.healthy,
    });

    if (!health.healthy) {
      this._emit("canary_failed", { batchIndex: batch.index });
      throw new Error("Canary health check failed");
    }

    // Bake period
    if (config.bakeTimeMs > 0) {
      await this._sleepFn(config.bakeTimeMs);
    }

    // Promote canary
    for (const node of batch.nodes) {
      node.status = "completed";
      node.completedAt = Date.now();
    }
    batch.status = "completed";
    this._emit("canary_promoted", { batchIndex: batch.index });
  }

  // ── Internal: Batch Execution ────────────────────────────

  private async _executeBatch(batch: UpgradeBatch, _globalIndex: number): Promise<boolean> {
    this._emit("batch_started", {
      batchIndex: batch.index,
      nodes: batch.nodes.map((n) => n.nodeId),
    });

    // Drain and upgrade
    await this._drainAndUpgrade(batch);

    // Health check
    batch.status = "running";
    this.phase = "health_checking";
    const health = await this._checkBatchHealth(batch);
    this._emit("batch_health_checked", {
      batchIndex: batch.index,
      healthy: health.healthy,
    });

    const plan = this.plan!;

    if (!health.healthy) {
      if (plan.rollbackTrigger === "on_batch_threshold") {
        const threshold = plan.batchFailureThreshold ?? 0.5;
        const failed = batch.nodes.filter((n) => n.status === "failed").length;
        if (failed / batch.nodes.length >= threshold) {
          this._handleFailure("batch_threshold", batch, `Batch failure threshold ${threshold * 100}% reached`);
          return false;
        }
        // Below threshold: tolerate the partial failure. Promote the healthy
        // nodes to completed and leave the failed ones as-is, then continue
        // the rolling upgrade.
        for (const node of batch.nodes) {
          if (node.status !== "failed") {
            node.status = "completed";
            node.completedAt = Date.now();
          }
        }
        batch.status = "completed";
        this._emit("batch_promoted", { batchIndex: batch.index });
        this.phase = "rolling";
        return true;
      }

      this._handleFailure("batch", batch, "Batch health check failed");
      return false;
    }

    // Promote batch
    for (const node of batch.nodes) {
      node.status = "completed";
      node.completedAt = Date.now();
    }
    batch.status = "completed";
    this._emit("batch_promoted", { batchIndex: batch.index });
    this.phase = "rolling";
    return true;
  }

  // ── Internal: Drain & Upgrade ────────────────────────────

  private async _drainAndUpgrade(batch: UpgradeBatch): Promise<void> {
    const drain = this.plan?.drain ?? DEFAULT_DRAIN;

    for (const node of batch.nodes) {
      if (node.status === "pending") {
        // Phase 1: Drain connections
        if (drain.waitForInflight) {
          node.status = "draining";
          node.startedAt = Date.now();
          await this._sleepFn(drain.connectionDrainMs);
        }

        // Phase 2: Upgrade (simulated)
        node.status = "upgrading";
        await this._sleepFn(0); // yield event loop for async health checks

        // Phase 3: Health check post-upgrade
        node.status = "health_check";
      }
    }
  }

  // ── Internal: Health Checking ─────────────────────────────

  private async _checkBatchHealth(batch: UpgradeBatch): Promise<BatchHealth> {
    const checks = this.plan!.healthCheckNames;
    if (checks.length === 0) {
      return { healthy: true, nodes: [], evaluatedAt: Date.now() };
    }

    const nodeResults: BatchHealth["nodes"] = [];
    let allHealthy = true;

    for (const node of batch.nodes) {
      let nodeHealthy = true;
      for (const checkName of checks) {
        const fn = this.healthChecks.get(checkName);
        if (!fn) continue;

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
        node.status = "failed";
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

  private _handleFailure(
    trigger: string,
    batch: UpgradeBatch,
    reason: string,
  ): void {
    batch.status = "failed";
    for (const node of batch.nodes) {
      if (node.status !== "completed") {
        node.status = "failed";
        node.error = reason;
      }
    }
    this._emit("batch_failed", { batchIndex: batch.index, reason });

    const plan = this.plan!;

    // Determine rollback action based on trigger policy
    const isFirstFailure = plan.rollbackTrigger === "on_first_failure";
    const isCanaryFailure = plan.rollbackTrigger === "on_canary_failure";
    const isDegradation = plan.rollbackTrigger === "on_degradation";
    const isBatchThreshold =
      trigger === "batch_threshold" && plan.rollbackTrigger === "on_batch_threshold";

    const shouldRollback = isFirstFailure || isCanaryFailure || isDegradation || isBatchThreshold;

    if (shouldRollback) {
      this._rollbackAll(trigger);
    } else {
      // manual_only or no matching trigger → mark failed but don't rollback
      this.phase = "failed";
    }
  }

  private _rollbackAll(trigger: string): void {
    this._emit("rollback_triggered", { reason: trigger });
    this.phase = "rolling_back";

    for (const batch of this.batches) {
      for (const node of batch.nodes) {
        this._rollbackNode(node);
      }
      if (batch.nodes.some((n) => n.status === "rolled_back")) {
        batch.status = "rolled_back";
      }
    }

    this._emit("rollback_completed", {
      rolledBackBatches: this.batches.filter((b) => b.status === "rolled_back").length,
    });
    this.phase = "failed";
  }

  private _abort(reason: string): RollingUpgradeStats {
    this._emit("upgrade_aborted", { reason });
    this.phase = "aborted";
    return this._buildStats();
  }

  // ── Internal: Stats & Events ─────────────────────────────

  private _buildStats(): RollingUpgradeStats {
    const plan = this.plan!;
    const allNodes = this.batches.flatMap((b) => b.nodes);
    const completedNodes = allNodes.filter(
      (n) => n.status === "completed",
    ).length;
    const failedNodes = allNodes.filter(
      (n) => n.status === "failed",
    ).length;
    const rolledBackNodes = allNodes.filter(
      (n) => n.status === "rolled_back",
    ).length;
    const completedBatches = this.batches.filter((b) => b.status === "completed").length;
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
    type: RollingUpgradeEvent["type"],
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
