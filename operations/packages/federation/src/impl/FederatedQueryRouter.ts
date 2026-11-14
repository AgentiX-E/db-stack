/**
 * C5 Federated Query Router — production-grade distributed query engine.
 *
 * Features:
 *   - 6 routing strategies: round_robin, least_connections, weighted, geo_affinity,
 *     cost_based, leader_only
 *   - Intelligent node selection with health gating, load filtering, and geo-preference
 *   - Fan-out/fan-in execution with partial result merging
 *   - Automatic failover with configurable retry + backoff
 *   - Weighted node ranking with composite scoring
 *   - Cost-based routing with multi-dimensional load thresholds
 *   - Query plan cache for inspection and replay
 *
 * @module @agentix-e/db-operations-federation/impl
 */

import type {
  IFederatedQueryRouter,
  FederatedNode,
  NodeLoad,
  NodeHealth,
  FederatedQuery,
  QueryPlan,
  NodeAssignment,
  RoutingPolicy,
  RoutingStrategy,
  FederatedResult,
  NodeResult,
  NodeExecutor,
  FailoverEvent,
  RouterStats,
} from "../interfaces/index.js";

// ── Router Implementation ────────────────────────────────────

export class FederatedQueryRouter implements IFederatedQueryRouter {
  private nodes = new Map<string, FederatedNode>();
  private policy: RoutingPolicy = DEFAULT_POLICY;
  private planCache = new Map<string, QueryPlan>();
  private failoverHistory: FailoverEvent[] = [];
  private totalQueries = 0;
  private successfulQueries = 0;
  private failedQueries = 0;
  private totalFailovers = 0;
  private totalPlanTimeNs = 0;
  private totalExecTimeMs = 0;
  private lastQueryTimestamp: number | null = null;
  private roundRobinCounter = 0;

  // Injectable clock for deterministic timing. Defaults to the real monotonic
  // nanosecond clock (`_nowNs`) and wall-clock milliseconds (`Date.now`).
  // Tests inject a fake clock so elapsed-time arithmetic (`-`) and average
  // division (`/`) become precisely assertable.
  private readonly _clock: { nowNs: () => number; nowMs: () => number };

  constructor(clock?: { nowNs?: () => number; nowMs?: () => number }) {
    this._clock = {
      nowNs: clock?.nowNs ?? _nowNs,
      nowMs: clock?.nowMs ?? Date.now,
    };
  }

  // ── Node Management ───────────────────────────────────────

  registerNode(node: FederatedNode): void {
    this.nodes.set(node.id, { ...node });
  }

  deregisterNode(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  updateNodeLoad(nodeId: string, load: NodeLoad): void {
    const node = this.nodes.get(nodeId);
    if (node) node.load = { ...load };
  }

  updateNodeHealth(nodeId: string, health: NodeHealth): void {
    const node = this.nodes.get(nodeId);
    if (node) node.health = health;
  }

  // ── Policy ────────────────────────────────────────────────

  setRoutingPolicy(policy: RoutingPolicy): void {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  // ── Query Planning ────────────────────────────────────────

  planQuery(query: FederatedQuery): QueryPlan {
    const startNs = this._clock.nowNs();
    const assignments = this._computeAssignments(query, this.policy.strategy);
    const cost = this._estimateCost(assignments);

    const plan: QueryPlan = {
      query,
      assignments,
      strategy: this.policy.strategy,
      estimatedCost: cost,
      createdAt: Date.now(),
    };

    this.planCache.set(query.id, plan);
    const elapsedNs = this._clock.nowNs() - startNs;
    this.totalPlanTimeNs += elapsedNs;

    return plan;
  }

  // ── Execution ─────────────────────────────────────────────

  async executeQuery(
    query: FederatedQuery,
    executor: NodeExecutor,
  ): Promise<FederatedResult> {
    this.totalQueries++;
    this.lastQueryTimestamp = Date.now();

    let plan = this.planQuery(query);
    let lastError: string | undefined;
    let retries = 0;

    // Retry loop with failover
    while (retries <= this.policy.maxRetries) {
      const result = await this._executePlanInternal(plan, executor);

      if (result.success) {
        this.successfulQueries++;
        this.totalExecTimeMs += result.totalDurationMs;
        return result;
      }

      // Failover: reassign failed nodes
      const failedNodeIds = result.nodeResults
        .filter((r) => !r.success)
        .map((r) => r.nodeId);

      if (failedNodeIds.length === 0) {
        // No nodes reported as failed. This happens when all nodes were
        // excluded by a prior failover and the re-planned assignment was
        // empty — so there's nothing new to record, but we still must not lose
        // the original failure reason.
        this.failedQueries++;
        if (result.nodeResults.length > 0) return result;
        return {
          ...result,
          error: lastError || result.error || "Max retries exceeded",
        };
      }

      for (const nid of failedNodeIds) {
        this.totalFailovers++;
        const event = this._failover(nid, plan, retries);
        this.failoverHistory.push(event);
      }

      // Preserve the real error from this attempt regardless of whether we
      // re-plan, so callers never lose the underlying failure reason. If this
      // attempt produced no error string (e.g. all nodes were excluded), keep
      // the previous lastError.
      const attemptError = result.nodeResults
        .filter((r) => !r.success)
        .map((r) => r.error)
        .join("; ");
      if (attemptError) lastError = attemptError;

      if (retries < this.policy.maxRetries) {
        // Re-plan with fallback strategy
        const fbStrategy = this.policy.fallbackStrategy || this.policy.strategy;
        plan = this._replan(plan, fbStrategy, failedNodeIds);

        // Backoff
        await _sleep(this.policy.retryBackoffMs * Math.pow(2, retries));
      }

      retries++;
    }

    this.failedQueries++;
    return {
      queryId: query.id,
      success: false,
      rows: [],
      totalRowCount: 0,
      nodeResults: [],
      totalDurationMs: 0,
      successCount: 0,
      failCount: 1,
      error: lastError || "Max retries exceeded",
    };
  }

  async executePlan(
    plan: QueryPlan,
    executor: NodeExecutor,
  ): Promise<FederatedResult> {
    this.totalQueries++;
    this.lastQueryTimestamp = Date.now();

    const start = this._clock.nowMs();
    const result = await this._executePlanInternal(plan, executor);
    result.totalDurationMs = this._clock.nowMs() - start;

    if (result.success) {
      this.successfulQueries++;
      this.totalExecTimeMs += result.totalDurationMs;
    } else {
      this.failedQueries++;
    }

    return result;
  }

  // ── Merge ─────────────────────────────────────────────────

  mergeResults(results: NodeResult[]): FederatedResult {
    const successResults = results.filter((r) => r.success);
    const failResults = results.filter((r) => !r.success);

    let mergedRows: Record<string, unknown>[] = [];
    for (const r of successResults) {
      mergedRows = mergedRows.concat(r.rows);
    }

    return {
      queryId: "",
      success: failResults.length === 0,
      rows: mergedRows,
      totalRowCount: mergedRows.length,
      nodeResults: results,
      totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
      successCount: successResults.length,
      failCount: failResults.length,
      error: failResults.length > 0
        ? failResults.map((r) => r.error).join("; ")
        : undefined,
    };
  }

  // ── Queries ───────────────────────────────────────────────

  getNodes(): FederatedNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  getActivePlans(): QueryPlan[] {
    return Array.from(this.planCache.values());
  }

  getFailoverHistory(): FailoverEvent[] {
    return [...this.failoverHistory];
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats(): RouterStats {
    const allNodes = Array.from(this.nodes.values());
    const planCount = this.planCache.size || 1;
    const queryCount = this.totalQueries || 1;

    return {
      totalNodes: allNodes.length,
      healthyNodes: allNodes.filter((n) => n.health === "healthy").length,
      degradedNodes: allNodes.filter((n) => n.health === "degraded").length,
      unhealthyNodes: allNodes.filter((n) => n.health === "unhealthy").length,
      totalQueries: this.totalQueries,
      successfulQueries: this.successfulQueries,
      failedQueries: this.failedQueries,
      totalFailovers: this.totalFailovers,
      avgPlanTimeMs: this.totalPlanTimeNs / planCount / 1_000_000,
      avgExecutionTimeMs: this.totalExecTimeMs / queryCount,
      lastQueryTimestamp: this.lastQueryTimestamp,
    };
  }

  // ── Internal: Assignment ──────────────────────────────────

  private _computeAssignments(
    query: FederatedQuery,
    strategy: RoutingStrategy,
    excludeNodeIds: string[] = [],
  ): NodeAssignment[] {
    let candidates = Array.from(this.nodes.values());

    // Filter out unhealthy nodes if policy says so
    if (this.policy.skipUnhealthy) {
      candidates = candidates.filter((n) => n.health === "healthy");
    }

    // Exclude failed nodes during retry
    if (excludeNodeIds.length > 0) {
      candidates = candidates.filter((n) => !excludeNodeIds.includes(n.id));
    }

    // Filter by role based on intent
    if (query.intent === "write" || strategy === "leader_only") {
      candidates = candidates.filter(
        (n) => n.role === "primary" || n.role === "coordinator",
      );
    } else if (query.intent === "analytics") {
      candidates = candidates.filter((n) =>
        n.capabilities.includes("analytics"),
      );
    }

    if (candidates.length === 0) {
      return [];
    }

    // Apply routing strategy
    const selected = this._selectNodes(query, strategy, candidates);
    return selected;
  }

  private _selectNodes(
    query: FederatedQuery,
    strategy: RoutingStrategy,
    candidates: FederatedNode[],
  ): NodeAssignment[] {
    const targetShards = query.targetShards.length > 0
      ? new Set(query.targetShards)
      : null;

    switch (strategy) {
      case "round_robin":
        return this._selectRoundRobin(candidates, targetShards);

      case "least_connections":
        return this._selectLeastConnections(candidates, targetShards);

      case "weighted":
        return this._selectWeighted(candidates, targetShards);

      case "geo_affinity":
        return this._selectGeoAffinity(candidates, targetShards);

      case "cost_based":
        return this._selectCostBased(candidates, targetShards);

      case "leader_only":
        return candidates
          .filter((n) => n.role === "primary")
          .map((n) => ({
            nodeId: n.id,
            shardIds: n.shardIds.filter(
              (s) => !targetShards || targetShards.has(s),
            ),
            priority: 1,
            reason: "leader_only",
          }));

      default:
        return this._selectRoundRobin(candidates, targetShards);
    }
  }

  private _selectRoundRobin(
    candidates: FederatedNode[],
    targetShards: Set<string> | null,
  ): NodeAssignment[] {
    const idx = this.roundRobinCounter++ % candidates.length;
    const node = candidates[idx]!;
    return [{
      nodeId: node.id,
      shardIds: node.shardIds.filter((s) => !targetShards || targetShards.has(s)),
      priority: 1,
      reason: `round_robin (index ${idx})`,
    }];
  }

  private _selectLeastConnections(
    candidates: FederatedNode[],
    targetShards: Set<string> | null,
  ): NodeAssignment[] {
    const sorted = [...candidates].sort(
      (a, b) => (a.load?.activeConnections ?? Infinity) - (b.load?.activeConnections ?? Infinity),
    );
    const node = sorted[0]!;
    return [{
      nodeId: node.id,
      shardIds: node.shardIds.filter((s) => !targetShards || targetShards.has(s)),
      priority: 1,
      reason: `least_connections (${node.load?.activeConnections ?? "unknown"})`,
    }];
  }

  private _selectWeighted(
    candidates: FederatedNode[],
    targetShards: Set<string> | null,
  ): NodeAssignment[] {
    // Sort by weight descending (higher = more preferred)
    const sorted = [...candidates].sort((a, b) => b.weight - a.weight);
    return sorted.slice(0, candidates.length).map((node, i) => ({
      nodeId: node.id,
      shardIds: node.shardIds.filter((s) => !targetShards || targetShards.has(s)),
      priority: i + 1,
      reason: `weighted (weight=${node.weight})`,
    }));
  }

  private _selectGeoAffinity(
    candidates: FederatedNode[],
    targetShards: Set<string> | null,
  ): NodeAssignment[] {
    const preferred = this.policy.preferredRegion;
    const local = candidates.filter(
      (n) => !preferred || n.region === preferred,
    );
    const remote = candidates.filter(
      (n) => preferred && n.region !== preferred,
    );

    const result: NodeAssignment[] = [
      ...local.map((n) => ({
        nodeId: n.id,
        shardIds: n.shardIds.filter((s) => !targetShards || targetShards.has(s)),
        priority: 1,
        reason: `geo_affinity (region=${n.region})`,
      })),
      ...remote.map((n) => ({
        nodeId: n.id,
        shardIds: n.shardIds.filter((s) => !targetShards || targetShards.has(s)),
        priority: 10, // Less preferred
        reason: `geo_affinity (remote region=${n.region})`,
      })),
    ];

    return result.length > 0 ? result : this._selectRoundRobin(candidates, targetShards);
  }

  private _selectCostBased(
    candidates: FederatedNode[],
    targetShards: Set<string> | null,
  ): NodeAssignment[] {
    const threshold = this.policy.costThreshold;

    // Score each node based on load metrics
    const scored = candidates.map((node) => ({
      node,
      score: this.computeNodeScore(node, threshold),
    }));

    // Filter nodes exceeding cost thresholds
    const valid = scored.filter((s) => s.score < 100);

    // Sort by score ascending (lower = better)
    valid.sort((a, b) => a.score - b.score);

    if (valid.length === 0) {
      // All candidates exceed thresholds — pick the least bad one
      const leastBad = scored.sort((a, b) => a.score - b.score)[0]!;
      return [{
        nodeId: leastBad.node.id,
        shardIds: leastBad.node.shardIds.filter(
          (s) => !targetShards || targetShards.has(s),
        ),
        priority: 1,
        reason: `cost_based (score=${leastBad.score}, all exceeded thresholds)`,
      }];
    }

    return valid.slice(0, candidates.length).map((s, i) => ({
      nodeId: s.node.id,
      shardIds: s.node.shardIds.filter(
        (si) => !targetShards || targetShards.has(si),
      ),
      priority: i + 1,
      reason: `cost_based (score=${s.score})`,
    }));
  }

  computeNodeScore(
    node: FederatedNode,
    threshold?: import("../interfaces/index.js").CostThreshold,
  ): number {
    const load = node.load;
    if (!load || !threshold) return 50; // No data = medium score

    let score = 0;

    const cpuRatio = load.cpuPercent / threshold.maxCpuPercent;
    score += cpuRatio / 30;

    const memRatio = load.memoryPercent / threshold.maxMemoryPercent;
    score += memRatio * 25;

    const pendingRatio = load.pendingQueries / Math.max(threshold.maxPendingQueries, 1);
    score += pendingRatio * 25;

    const latRatio = load.avgLatencyMs / Math.max(threshold.maxAvgLatencyMs, 1);
    score += latRatio * 20;

    // Add health penalty
    if (node.health === "degraded") score += 30;
    if (node.health === "unhealthy") score += 100;

    return Math.round(score);
  }

  private _estimateCost(assignments: NodeAssignment[]): number {
    return Math.max(1, assignments.length * 10);
  }

  // ── Internal: Execution ───────────────────────────────────

  private async _executePlanInternal(
    plan: QueryPlan,
    executor: NodeExecutor,
  ): Promise<FederatedResult> {
    const results: NodeResult[] = [];
    const startMs = this._clock.nowMs();

    // Execute fan-out
    const nodeIds = new Set(plan.assignments.map((a) => a.nodeId));
    const promises = Array.from(nodeIds).map(async (nodeId) => {
      const node = this.nodes.get(nodeId);
      if (!node) {
        return {
          nodeId,
          shardIds: [],
          rows: [],
          rowCount: 0,
          durationMs: 0,
          success: false,
          error: `Node ${nodeId} not found`,
        };
      }

      const shardIds = plan.assignments
        .filter((a) => a.nodeId === nodeId)
        .flatMap((a) => a.shardIds);

      if (shardIds.length === 0 && plan.assignments.some((a) => a.nodeId === nodeId)) {
        // This node was assigned but has no shards — execute on all its shards
        shardIds.push(...node.shardIds);
      }

      return executor(node, plan.query, shardIds);
    });

    const settled = await Promise.allSettled(promises);
    for (const r of settled) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({
          nodeId: "unknown",
          shardIds: [],
          rows: [],
          rowCount: 0,
          durationMs: 0,
          success: false,
          error: r.reason?.message ?? "Promise rejected",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const totalDuration = this._clock.nowMs() - startMs;

    // Merge rows from successful nodes
    const mergedRows = results
      .filter((r) => r.success)
      .flatMap((r) => r.rows);

    return {
      queryId: plan.query.id,
      success: successCount > 0,
      rows: mergedRows,
      totalRowCount: mergedRows.length,
      nodeResults: results,
      totalDurationMs: totalDuration,
      successCount,
      failCount: results.length - successCount,
      error: successCount === 0
        ? results.filter((r) => !r.success).map((r) => r.error).join("; ")
        : undefined,
    };
  }

  // ── Internal: Failover ────────────────────────────────────

  private _failover(
    failedNodeId: string,
    plan: QueryPlan,
    retryAttempt: number,
  ): FailoverEvent {
    // Try to find a replacement
    const failed = this.nodes.get(failedNodeId);
    const shards = failed?.shardIds ?? [];
    const candidates = Array.from(this.nodes.values()).filter(
      (n) =>
        n.id !== failedNodeId &&
        n.health === "healthy" &&
        shards.some((s) => n.shardIds.includes(s)),
    );

    const replacement = this.policy.skipUnhealthy
      ? candidates.filter((n) => n.health === "healthy")
      : candidates;

    const fbNode = replacement.length > 0 ? replacement[0]! : undefined;

    // Update plan assignments
    if (fbNode) {
      plan.assignments = plan.assignments.filter((a) => a.nodeId !== failedNodeId);
      plan.assignments.push({
        nodeId: fbNode.id,
        shardIds: fbNode.shardIds.filter((s) => shards.includes(s)),
        priority: 99, // Low priority (fallback)
        reason: `failover from ${failedNodeId}, attempt ${retryAttempt + 1}`,
      });
    }

    // Mark failed node as degraded
    if (failed) {
      failed.health = "degraded";
    }

    return {
      failedNodeId,
      error: `Node ${failedNodeId} failed during query ${plan.query.id}`,
      timestamp: Date.now(),
      failoverNodeId: fbNode?.id,
      success: fbNode !== undefined,
      retryAttempt,
    };
  }

  private _replan(
    plan: QueryPlan,
    fallbackStrategy: RoutingStrategy,
    excludeNodeIds: string[],
  ): QueryPlan {
    const assignments = this._computeAssignments(
      plan.query,
      fallbackStrategy,
      excludeNodeIds,
    );

    return {
      ...plan,
      assignments,
      strategy: fallbackStrategy,
      estimatedCost: this._estimateCost(assignments),
    };
  }
}

// ── Default Policy ──────────────────────────────────────────

const DEFAULT_POLICY: RoutingPolicy = {
  strategy: "round_robin",
  fallbackStrategy: "least_connections",
  maxRetries: 3,
  retryBackoffMs: 100,
  skipUnhealthy: true,
  geoAffinity: false,
};

// ── Helpers ─────────────────────────────────────────────────

function _nowNs(): number {
  const [s, ns] = process.hrtime();
  return s * 1e9 + ns;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
