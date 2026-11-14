/**
 * I35 — C5 Federated Query Router tests.
 *
 * FQR1-FQR14: node registration, routing strategies (6), query planning,
 * execution + fan-out/fan-in, failover + retry, result merging,
 * policy management, stats, edge cases, production workflow.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FederatedQueryRouter } from "../impl/FederatedQueryRouter.js";
import type {
  FederatedNode,
  FederatedQuery,
  RoutingPolicy,
  NodeResult,
} from "../interfaces/index.js";

// ── Helpers ────────────────────────────────────────────────

function makeNode(overrides: Partial<FederatedNode> = {}): FederatedNode {
  return {
    id: `node-${Math.random().toString(36).slice(2, 6)}`,
    host: "localhost",
    port: 5432,
    role: "primary",
    health: "healthy",
    shardIds: ["shard-0"],
    weight: 0.5,
    capabilities: ["read", "write"],
    region: "us-east-1",
    load: { cpuPercent: 30, memoryPercent: 40, activeConnections: 10, pendingQueries: 2, avgLatencyMs: 5 },
    ...overrides,
  };
}

function makeQuery(overrides: Partial<FederatedQuery> = {}): FederatedQuery {
  return {
    id: `q-${Math.random().toString(36).slice(2, 8)}`,
    sql: "SELECT * FROM users WHERE id = $1",
    intent: "read",
    consistency: "eventual",
    targetShards: [],
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeExecutor(
  shouldSucceed = true,
  rows: unknown[] = [{ id: 1 }],
): () => Promise<NodeResult> {
  return async (node, query, shardIds) => ({
    nodeId: node.id,
    shardIds,
    rows: rows as Record<string, unknown>[],
    rowCount: rows.length,
    durationMs: 10,
    success: shouldSucceed,
  });
}

function makeFailingExecutor(error = "connection refused"): () => Promise<NodeResult> {
  return async (node, query, shardIds) => ({
    nodeId: node.id,
    shardIds,
    rows: [],
    rowCount: 0,
    durationMs: 5,
    success: false,
    error,
  });
}

// ── FQR1: Node Registration ────────────────────────────────

describe("FQR1: Node registration and management", () => {
  let router: FederatedQueryRouter;

  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("registers a node", () => {
    const n = makeNode({ id: "n1" });
    router.registerNode(n);
    expect(router.getNodes()).toHaveLength(1);
    expect(router.getNodes()[0]!.id).toBe("n1");
  });

  it("deregisters a node", () => {
    router.registerNode(makeNode({ id: "n1" }));
    router.registerNode(makeNode({ id: "n2" }));
    router.deregisterNode("n1");
    expect(router.getNodes()).toHaveLength(1);
    expect(router.getNodes()[0]!.id).toBe("n2");
  });

  it("deregister non-existent node is no-op", () => {
    expect(() => router.deregisterNode("nope")).not.toThrow();
  });

  it("updates node load metrics", () => {
    router.registerNode(makeNode({ id: "n1" }));
    router.updateNodeLoad("n1", { cpuPercent: 90, memoryPercent: 80, activeConnections: 50, pendingQueries: 20, avgLatencyMs: 100 });
    const node = router.getNodes()[0]!;
    expect(node.load?.cpuPercent).toBe(90);
    expect(node.load?.avgLatencyMs).toBe(100);
  });

  it("updates node health", () => {
    router.registerNode(makeNode({ id: "n1", health: "healthy" }));
    router.updateNodeHealth("n1", "unhealthy");
    expect(router.getNodes()[0]!.health).toBe("unhealthy");
  });

  it("update non-existent node is no-op", () => {
    expect(() => router.updateNodeHealth("nope", "healthy")).not.toThrow();
    expect(() => router.updateNodeLoad("nope", {} as any)).not.toThrow();
  });

  it("nodes are deep-copied on register", () => {
    const n = makeNode({ id: "n1", health: "healthy" });
    router.registerNode(n);
    n.health = "unhealthy";
    expect(router.getNodes()[0]!.health).toBe("healthy");
  });
});

// ── FQR2: Round Robin ──────────────────────────────────────

describe("FQR2: Round robin routing", () => {
  it("cycles through nodes in order", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "n2", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "n3", shardIds: ["s1"] }));

    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("n1");
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("n2");
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("n3");
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("n1");
  });

  it("single node always returns same", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "only" }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("only");
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("only");
  });
});

// ── FQR3: Least Connections ────────────────────────────────

describe("FQR3: Least connections routing", () => {
  it("selects node with fewest active connections", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "least_connections", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "busy", load: { cpuPercent: 80, memoryPercent: 60, activeConnections: 500, pendingQueries: 50, avgLatencyMs: 200 } }));
    router.registerNode(makeNode({ id: "idle", load: { cpuPercent: 10, memoryPercent: 20, activeConnections: 5, pendingQueries: 1, avgLatencyMs: 2 } }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("idle");
  });

  it("prefers nodes with load data over those without", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "least_connections", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "noload", load: undefined }));
    router.registerNode(makeNode({ id: "loaded", load: { cpuPercent: 30, memoryPercent: 40, activeConnections: 10, pendingQueries: 2, avgLatencyMs: 5 } }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("loaded");
  });
});

// ── FQR4: Weighted ─────────────────────────────────────────

describe("FQR4: Weighted routing", () => {
  it("selects highest weight node first", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "low", weight: 0.2 }));
    router.registerNode(makeNode({ id: "high", weight: 0.9 }));
    router.registerNode(makeNode({ id: "mid", weight: 0.5 }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("high");
  });

  it("weighted returns all candidates with priorities", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a", weight: 0.3 }));
    router.registerNode(makeNode({ id: "b", weight: 0.7 }));
    const plan = router.planQuery(makeQuery());
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments[0]!.priority).toBeLessThan(plan.assignments[1]!.priority);
  });
});

// ── FQR5: Geo Affinity ─────────────────────────────────────

describe("FQR5: Geo affinity routing", () => {
  it("prefers nodes in preferred region", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "geo_affinity", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: true, preferredRegion: "us-east-1" });
    router.registerNode(makeNode({ id: "local", region: "us-east-1" }));
    router.registerNode(makeNode({ id: "remote", region: "eu-west-2" }));
    const plan = router.planQuery(makeQuery());
    expect(plan.assignments[0]!.nodeId).toBe("local");
    expect(plan.assignments[0]!.priority).toBe(1);
    expect(plan.assignments[1]!.priority).toBe(10);
  });

  it("no region preference falls to round robin", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "geo_affinity", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a" }));
    router.registerNode(makeNode({ id: "b" }));
    expect(router.planQuery(makeQuery()).assignments.length).toBeGreaterThanOrEqual(1);
  });
});

// ── FQR6: Cost-Based ───────────────────────────────────────

describe("FQR6: Cost-based routing", () => {
  const threshold = { maxCpuPercent: 80, maxMemoryPercent: 80, maxPendingQueries: 50, maxAvgLatencyMs: 100 };

  it("selects node with lowest cost score", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false, costThreshold: threshold });
    router.registerNode(makeNode({ id: "expensive", load: { cpuPercent: 90, memoryPercent: 85, activeConnections: 100, pendingQueries: 60, avgLatencyMs: 150 } }));
    router.registerNode(makeNode({ id: "cheap", load: { cpuPercent: 10, memoryPercent: 10, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("cheap");
  });

  it("all exceeding thresholds falls back to least bad", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false, costThreshold: { maxCpuPercent: 50, maxMemoryPercent: 50, maxPendingQueries: 5, maxAvgLatencyMs: 10 } });
    router.registerNode(makeNode({ id: "overloaded", load: { cpuPercent: 99, memoryPercent: 99, activeConnections: 500, pendingQueries: 100, avgLatencyMs: 500 } }));
    const plan = router.planQuery(makeQuery());
    expect(plan.assignments[0]!.nodeId).toBe("overloaded");
    expect(plan.assignments[0]!.reason).toContain("all exceeded");
  });

  it("degraded nodes get cost penalty", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false, costThreshold: threshold });
    router.registerNode(makeNode({ id: "degraded", health: "degraded", load: { cpuPercent: 20, memoryPercent: 20, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 2 } }));
    router.registerNode(makeNode({ id: "healthy", health: "healthy", load: { cpuPercent: 30, memoryPercent: 30, activeConnections: 2, pendingQueries: 1, avgLatencyMs: 3 } }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("healthy");
  });
});

// ── FQR7: Leader-Only ──────────────────────────────────────

describe("FQR7: Leader-only routing", () => {
  it("selects only primary nodes", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "leader_only", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "primary", role: "primary" }));
    router.registerNode(makeNode({ id: "replica", role: "replica" }));
    const plan = router.planQuery(makeQuery());
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.nodeId).toBe("primary");
  });
});

// ── FQR8: Query Planning ───────────────────────────────────

describe("FQR8: Query planning", () => {
  it("plans query with full metadata", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    const plan = router.planQuery(makeQuery({ id: "q1" }));
    expect(plan.query.id).toBe("q1");
    expect(plan.strategy).toBe("round_robin");
    expect(plan.estimatedCost).toBeGreaterThan(0);
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.assignments.length).toBeGreaterThanOrEqual(1);
  });

  it("plans are cached", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    router.planQuery(makeQuery({ id: "q1" }));
    router.planQuery(makeQuery({ id: "q2" }));
    expect(router.getActivePlans()).toHaveLength(2);
  });

  it("empty assignment when no nodes", () => {
    const router = new FederatedQueryRouter();
    expect(router.planQuery(makeQuery()).assignments).toHaveLength(0);
  });

  it("skips unhealthy nodes when policy demands", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: true, geoAffinity: false });
    router.registerNode(makeNode({ id: "sick", health: "unhealthy" }));
    router.registerNode(makeNode({ id: "healthy", health: "healthy" }));
    expect(router.planQuery(makeQuery()).assignments[0]!.nodeId).toBe("healthy");
  });

  it("write intent filters to primary/coordinator", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "primary", role: "primary" }));
    router.registerNode(makeNode({ id: "replica", role: "replica" }));
    const plan = router.planQuery(makeQuery({ intent: "write" }));
    expect(plan.assignments[0]!.nodeId).toBe("primary");
  });

  it("analytics intent filters to analytics-capable", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "analytics", capabilities: ["analytics"] }));
    router.registerNode(makeNode({ id: "web", capabilities: ["read", "write"] }));
    expect(router.planQuery(makeQuery({ intent: "analytics" })).assignments[0]!.nodeId).toBe("analytics");
  });
});

// ── FQR9: Fan-Out/Fan-In ───────────────────────────────────

describe("FQR9: Fan-out/fan-in execution", () => {
  it("executes on all assigned nodes via executor", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "n2", shardIds: ["s2"] }));
    const exec = vi.fn(makeExecutor());
    const result = await router.executeQuery(makeQuery(), exec);
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.nodeResults).toHaveLength(2);
    expect(result.totalRowCount).toBeGreaterThan(0);
  });

  it("executePlan uses pre-built plan", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    const plan = router.planQuery(makeQuery());
    const result = await router.executePlan(plan, makeExecutor());
    expect(result.success).toBe(true);
    expect(result.nodeResults).toHaveLength(1);
  });

  it("parallelizes execution", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    router.registerNode(makeNode({ id: "n2" }));
    router.registerNode(makeNode({ id: "n3" }));
    const delays: number[] = [];
    const slowExec = async (node: any, query: any, shardIds: any) => {
      const delay = 10 + Math.random() * 20;
      delays.push(delay);
      await new Promise((r) => setTimeout(r, delay));
      return { nodeId: node.id, shardIds, rows: [{ id: 1 }], rowCount: 1, durationMs: delay, success: true };
    };
    const start = Date.now();
    const result = await router.executeQuery(makeQuery(), slowExec);
    const elapsed = Date.now() - start;
    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(Math.max(...delays) * 3);
  });

  it("returns partial results on node failure", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "good", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "bad", shardIds: ["s2"] }));
    const mixedExec = async (node: any, query: any, shardIds: any) => {
      if (node.id === "bad") return { nodeId: node.id, shardIds, rows: [], rowCount: 0, durationMs: 5, success: false, error: "timeout" };
      return { nodeId: node.id, shardIds, rows: [{ id: 1 }], rowCount: 1, durationMs: 10, success: true };
    };
    const result = await router.executeQuery(makeQuery(), mixedExec);
    expect(result.success).toBe(true);
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.totalRowCount).toBe(1);
  });
});

// ── FQR10: Failover & Retry ────────────────────────────────

describe("FQR10: Failover and retry", () => {
  it("retries with fallback strategy", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", fallbackStrategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "bad", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "backup", health: "healthy", shardIds: ["s1"] }));
    let calls = 0;
    const exec = async (node: any, query: any, shardIds: any) => {
      calls++;
      if (node.id === "bad") return { nodeId: node.id, shardIds, rows: [], rowCount: 0, durationMs: 5, success: false, error: "fail" };
      return { nodeId: node.id, shardIds, rows: [{ id: 1 }], rowCount: 1, durationMs: 10, success: true };
    };
    const result = await router.executeQuery(makeQuery({ targetShards: ["s1"] }), exec);
    expect(result.success).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("records failover events", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", fallbackStrategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "spare", health: "healthy", shardIds: ["s1"] }));
    const exec = async (node: any) => ({
      nodeId: node.id, shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 5,
      success: node.id !== "fail", error: node.id === "fail" ? "timeout" : undefined,
    });
    await router.executeQuery(makeQuery({ targetShards: ["s1"] }), exec);
    const hist = router.getFailoverHistory();
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0]!.failedNodeId).toBe("fail");
    expect(hist[0]!.failoverNodeId).toBe("spare");
  });

  it("returns failure after max retries", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "doomed", health: "healthy" }));
    const result = await router.executeQuery(makeQuery(), makeFailingExecutor());
    expect(result.success).toBe(false);
  });
});

// ── FQR11: Result Merging ──────────────────────────────────

describe("FQR11: Result merging", () => {
  it("merges rows from multiple nodes", () => {
    const router = new FederatedQueryRouter();
    const results: NodeResult[] = [
      { nodeId: "n1", shardIds: ["s1"], rows: [{ id: 1 }, { id: 2 }], rowCount: 2, durationMs: 10, success: true },
      { nodeId: "n2", shardIds: ["s2"], rows: [{ id: 3 }], rowCount: 1, durationMs: 12, success: true },
    ];
    const merged = router.mergeResults(results);
    expect(merged.success).toBe(true);
    expect(merged.totalRowCount).toBe(3);
    expect(merged.rows).toHaveLength(3);
    expect(merged.successCount).toBe(2);
    expect(merged.failCount).toBe(0);
  });

  it("merge with failures is not successful", () => {
    const router = new FederatedQueryRouter();
    const results: NodeResult[] = [
      { nodeId: "n1", shardIds: ["s1"], rows: [{ id: 1 }], rowCount: 1, durationMs: 10, success: true },
      { nodeId: "n2", shardIds: ["s2"], rows: [], rowCount: 0, durationMs: 5, success: false, error: "fail" },
    ];
    const merged = router.mergeResults(results);
    expect(merged.success).toBe(false);
    expect(merged.rows).toHaveLength(1);
    expect(merged.successCount).toBe(1);
    expect(merged.failCount).toBe(1);
  });

  it("aggregated error from all failures", () => {
    const router = new FederatedQueryRouter();
    const results: NodeResult[] = [
      { nodeId: "n1", shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 5, success: false, error: "err1" },
      { nodeId: "n2", shardIds: ["s2"], rows: [], rowCount: 0, durationMs: 5, success: false, error: "err2" },
    ];
    const merged = router.mergeResults(results);
    expect(merged.error).toContain("err1");
    expect(merged.error).toContain("err2");
  });

  it("sums node durations", () => {
    const router = new FederatedQueryRouter();
    const results: NodeResult[] = [
      { nodeId: "n1", shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 100, success: true },
      { nodeId: "n2", shardIds: ["s2"], rows: [], rowCount: 0, durationMs: 200, success: true },
    ];
    expect(router.mergeResults(results).totalDurationMs).toBe(300);
  });
});

// ── FQR12: Stats ───────────────────────────────────────────

describe("FQR12: Statistics", () => {
  it("initial stats zeroed", () => {
    const s = new FederatedQueryRouter().getStats();
    expect(s.totalNodes).toBe(0);
    expect(s.totalQueries).toBe(0);
    expect(s.successfulQueries).toBe(0);
    expect(s.totalFailovers).toBe(0);
  });

  it("stats reflect node health breakdown", () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "h", health: "healthy" }));
    router.registerNode(makeNode({ id: "d", health: "degraded" }));
    router.registerNode(makeNode({ id: "u", health: "unhealthy" }));
    const s = router.getStats();
    expect(s.healthyNodes).toBe(1);
    expect(s.degradedNodes).toBe(1);
    expect(s.unhealthyNodes).toBe(1);
  });

  it("stats track query counts", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    await router.executeQuery(makeQuery(), makeExecutor());
    await router.executeQuery(makeQuery(), makeExecutor());
    await router.executeQuery(makeQuery(), makeFailingExecutor());
    const s = router.getStats();
    expect(s.totalQueries).toBe(3);
    expect(s.successfulQueries).toBe(2);
    expect(s.failedQueries).toBe(1);
  });

  it("avg timestamps computed", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    await router.executeQuery(makeQuery(), makeExecutor());
    const s = router.getStats();
    expect(s.avgPlanTimeMs).toBeGreaterThanOrEqual(0);
    expect(s.avgExecutionTimeMs).toBeGreaterThanOrEqual(0);
    expect(s.lastQueryTimestamp).toBeGreaterThan(0);
  });
});

// ── FQR13: Edge Cases ──────────────────────────────────────

describe("FQR13: Edge cases", () => {
  it("executePlan with no nodes returns empty", async () => {
    const router = new FederatedQueryRouter();
    const plan = router.planQuery(makeQuery());
    const result = await router.executePlan(plan, makeExecutor());
    expect(result.nodeResults).toHaveLength(0);
    expect(result.success).toBe(false);
  });

  it("default policy is round_robin", () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "n1" }));
    expect(router.planQuery(makeQuery()).strategy).toBe("round_robin");
  });

  it("targetShards filter to matching shards", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1", shardIds: ["s1", "s2", "s3"] }));
    const plan = router.planQuery(makeQuery({ targetShards: ["s1", "s3"] }));
    expect(plan.assignments[0]!.shardIds).toEqual(["s1", "s3"]);
  });

  it("executor that throws is caught and reported", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    const boom = async () => { throw new Error("Boom"); };
    const plan = router.planQuery(makeQuery());
    const result = await router.executePlan(plan, boom);
    // The thrown promise is caught by Promise.allSettled
    expect(result.success).toBe(false);
    expect(result.nodeResults.length).toBe(1);
    expect(result.nodeResults[0]!.success).toBe(false);
    expect(result.nodeResults[0]!.error).toContain("Boom");
  });

  it("failover history is isolated copy", () => {
    const router = new FederatedQueryRouter();
    expect(router.getFailoverHistory()).toEqual([]);
  });
});

// ── FQR14: Production Workflow ─────────────────────────────

describe("FQR14: Production workflow", () => {
  it("full lifecycle: register → plan → execute → merge", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", fallbackStrategy: "least_connections", maxRetries: 1, retryBackoffMs: 10, skipUnhealthy: true, geoAffinity: false, costThreshold: { maxCpuPercent: 80, maxMemoryPercent: 80, maxPendingQueries: 50, maxAvgLatencyMs: 100 } });

    // Register a multi-shard cluster
    router.registerNode(makeNode({ id: "us-east-a", region: "us-east-1", shardIds: ["s0", "s1"], role: "primary", health: "healthy", weight: 0.8, load: { cpuPercent: 20, memoryPercent: 30, activeConnections: 5, pendingQueries: 0, avgLatencyMs: 2 } }));
    router.registerNode(makeNode({ id: "us-east-b", region: "us-east-1", shardIds: ["s2", "s3"], role: "primary", health: "healthy", weight: 0.7, load: { cpuPercent: 40, memoryPercent: 50, activeConnections: 15, pendingQueries: 3, avgLatencyMs: 8 } }));
    router.registerNode(makeNode({ id: "eu-west-a", region: "eu-west-2", shardIds: ["s0", "s1", "s2", "s3"], role: "replica", health: "healthy", weight: 0.5, load: { cpuPercent: 10, memoryPercent: 15, activeConnections: 3, pendingQueries: 0, avgLatencyMs: 1 } }));

    // Plan a read query targeting specific shards
    const q = makeQuery({ id: "prod-query", intent: "read", targetShards: ["s0", "s1"] });
    const plan = router.planQuery(q);
    expect(plan.strategy).toBe("cost_based");
    expect(plan.assignments.length).toBeGreaterThan(0);

    // Execute with a real-ish executor
    const exec = async (node: any, query: any, shardIds: any) => ({
      nodeId: node.id, shardIds,
      rows: shardIds.map((s: string, i: number) => ({ shard: s, user_id: i + 1 })),
      rowCount: shardIds.length, durationMs: 5 + shardIds.length * 2, success: true,
    });
    const result = await router.executePlan(plan, exec);
    expect(result.success).toBe(true);
    expect(result.totalRowCount).toBeGreaterThan(0);

    // Stats reflect execution
    const stats = router.getStats();
    expect(stats.totalQueries).toBe(1);
    expect(stats.successfulQueries).toBe(1);
  });

  it("query with geo-affinity and failover", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({
      strategy: "geo_affinity", fallbackStrategy: "least_connections", maxRetries: 1,
      retryBackoffMs: 1, skipUnhealthy: true, geoAffinity: true, preferredRegion: "us-east-1",
    });

    router.registerNode(makeNode({ id: "local", region: "us-east-1", shardIds: ["s1"], health: "healthy" }));
    router.registerNode(makeNode({ id: "remote", region: "eu-west-2", shardIds: ["s1"], health: "healthy" }));

    const plan = router.planQuery(makeQuery({ id: "geo-q" }));
    expect(plan.assignments[0]!.reason).toContain("geo_affinity");

    const exec = async (node: any, query: any, shardIds: any) => ({
      nodeId: node.id, shardIds, rows: [{ x: 1 }], rowCount: 1, durationMs: 5, success: true,
    });

    const result = await router.executePlan(plan, exec);
    expect(result.success).toBe(true);
  });
});