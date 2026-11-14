/**
 * FederatedQueryRouter — branch-completion tests.
 *
 * Targets the routing-decision branches the I35 suite leaves implicit:
 *   - _failover when the failed node is no longer registered (`?? []`)
 *   - failover replacement selection with skipUnhealthy filtering
 *   - _selectLeastConnections `load` / `activeConnections` nullish fallbacks
 *   - _selectGeoAffinity remote-region branch and empty-result fallback
 *   - _selectCostBased all-nodes-exceed-threshold fallback (least-bad node)
 *   - computeNodeScore `!load || !threshold` medium-score return + health penalties
 *   - _executePlanInternal Promise rejection (`reason?.message ?? "Promise rejected"`)
 *   - retry loop with multiple failing nodes (attemptError concatenation)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FederatedQueryRouter } from "../impl/FederatedQueryRouter.js";
import type {
  FederatedNode,
  FederatedQuery,
  NodeResult,
} from "../interfaces/index.js";

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

describe("FQR-branch: failover edge cases", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("_failover handles an unregistered failed node (`?? []` fallback)", () => {
    const n = makeNode({ id: "healthy-1", shardIds: ["s1"] });
    router.registerNode(n);

    const plan = (router as any).planQuery(makeQuery());
    const event = (router as any)._failover("ghost-node", plan, 0);

    expect(event.failedNodeId).toBe("ghost-node");
    expect(event.success).toBe(false);
    expect(event.failoverNodeId).toBeUndefined();
  });

  it("_failover respects skipUnhealthy by excluding degraded candidates", () => {
    const degraded = makeNode({ id: "deg", health: "degraded", shardIds: ["s1"] });
    const healthy = makeNode({ id: "ok", health: "healthy", shardIds: ["s1"] });
    router.registerNode(degraded);
    router.registerNode(healthy);
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, skipUnhealthy: true } as any);

    const plan = (router as any).planQuery(makeQuery());
    const event = (router as any)._failover("deg", plan, 0);

    expect(event.failoverNodeId).toBe("ok");
  });
});

describe("FQR-branch: least-connections nullish fallbacks", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("treats missing load/activeConnections as Infinity (least preferred)", () => {
    const noLoad = makeNode({ id: "noload", load: undefined });
    const loaded = makeNode({ id: "loaded", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } });
    router.registerNode(noLoad);
    router.registerNode(loaded);

    const picks = (router as any)._selectLeastConnections(
      [noLoad, loaded], new Set(["shard-0"]),
    );
    expect(picks[0].nodeId).toBe("loaded");
  });
});

describe("FQR-branch: geo-affinity remote + fallback", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("routes remote-region nodes with lower priority", () => {
    const local = makeNode({ id: "local", region: "us-east-1" });
    const remote = makeNode({ id: "remote", region: "eu-west-2" });
    router.registerNode(local);
    router.registerNode(remote);
    (router as any).policy.preferredRegion = "us-east-1";

    const picks = (router as any)._selectGeoAffinity([local, remote], null);
    expect(picks[0].nodeId).toBe("local");
    expect(picks[1].nodeId).toBe("remote");
    expect(picks[1].priority).toBe(10);
  });

  it("treats an unset preferred region as matching every candidate (local branch)", () => {
    const a = makeNode({ id: "a", region: "eu-west-2" });
    const b = makeNode({ id: "b", region: "ap-south-1" });
    router.registerNode(a);
    router.registerNode(b);
    (router as any).policy.preferredRegion = undefined;

    // `!preferred` short-circuits: every candidate is local, remote is empty.
    const picks = (router as any)._selectGeoAffinity([a, b], null);
    expect(picks.map((p: any) => p.nodeId)).toEqual(["a", "b"]);
    expect(picks.every((p: any) => p.priority === 1)).toBe(true);
  });
});

describe("FQR-branch: cost-based all-exceeded fallback", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("picks the least-bad node when all exceed thresholds", () => {
    const bad1 = makeNode({ id: "bad1", load: { cpuPercent: 99, memoryPercent: 99, activeConnections: 500, pendingQueries: 100, avgLatencyMs: 500 } });
    const bad2 = makeNode({ id: "bad2", load: { cpuPercent: 95, memoryPercent: 95, activeConnections: 400, pendingQueries: 80, avgLatencyMs: 400 } });
    (router as any).policy.costThreshold = { maxCpuPercent: 50, maxMemoryPercent: 50, maxPendingQueries: 5, maxAvgLatencyMs: 10 };

    const picks = (router as any)._selectCostBased([bad1, bad2], new Set(["shard-0"]));
    expect(picks).toHaveLength(1);
    expect(picks[0].reason).toContain("all exceeded thresholds");
  });
});

describe("FQR-branch: computeNodeScore fallbacks and penalties", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("returns the medium score (50) when load or threshold is absent", () => {
    expect((router as any).computeNodeScore(makeNode({ load: undefined }))).toBe(50);
    expect((router as any).computeNodeScore(makeNode(), undefined)).toBe(50);
  });

  it("adds health penalties for degraded and unhealthy nodes", () => {
    const thr = { maxCpuPercent: 100, maxMemoryPercent: 100, maxPendingQueries: 100, maxAvgLatencyMs: 100 };
    const degraded = (router as any).computeNodeScore(makeNode({ health: "degraded" }), thr);
    const healthy = (router as any).computeNodeScore(makeNode({ health: "healthy" }), thr);
    expect(degraded).toBeGreaterThan(healthy);

    const unhealthy = (router as any).computeNodeScore(makeNode({ health: "unhealthy" }), thr);
    expect(unhealthy).toBeGreaterThanOrEqual(100);
  });
});

describe("FQR-branch: execution rejection handling", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("records a rejected executor promise as a failed nodeResult", async () => {
    const n = makeNode({ id: "n1" });
    router.registerNode(n);

    const plan = (router as any).planQuery(makeQuery());
    const executor = () => Promise.reject(new Error("executor exploded"));
    const result = await (router as any)._executePlanInternal(plan, executor);

    expect(result.success).toBe(false);
    expect(result.nodeResults[0].error).toBe("executor exploded");
  });

  it("uses a generic message when the rejection reason has no .message", async () => {
    const n = makeNode({ id: "n1" });
    router.registerNode(n);
    const plan = (router as any).planQuery(makeQuery());
    const executor = () => Promise.reject("non-error reason");
    const result = await (router as any)._executePlanInternal(plan, executor);

    expect(result.nodeResults[0].error).toBe("Promise rejected");
  });

  it("records a node-not-found result when the plan references an unregistered node", async () => {
    // Build a plan whose assignment references a node id never registered.
    const plan = (router as any).planQuery(makeQuery());
    plan.assignments = [{ nodeId: "missing-node", shardIds: ["s1"], priority: 1, reason: "manual" }];

    const result = await (router as any)._executePlanInternal(plan, async () => ({ nodeId: "x", shardIds: [], rows: [], rowCount: 0, durationMs: 0, success: true }));

    expect(result.nodeResults[0].success).toBe(false);
    expect(result.nodeResults[0].error).toContain("not found");
  });
});

describe("FQR-branch: retry loop with empty nodeResults", () => {
  it("returns max-retries error when all nodes are excluded (no nodeResults)", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false } as any);

    // No nodes registered → empty assignments → empty nodeResults.
    const result = await router.executeQuery(makeQuery(), async () => ({
      nodeId: "x", shardIds: [], rows: [], rowCount: 0, durationMs: 0, success: true,
    }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("Max retries exceeded");
  });

  it("concatenates multiple failing nodes' errors into lastError", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false } as any);
    router.registerNode(makeNode({ id: "n1", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "n2", shardIds: ["s1"] }));
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false } as any);

    const result = await router.executeQuery(makeQuery(), async (node) => ({
      nodeId: node.id, shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 1,
      success: false, error: `err-${node.id}`,
    }));

    expect(result.success).toBe(false);
    // Both nodes failed; their errors were concatenated into the final error.
    expect(result.error).toContain("err-n1");
    expect(result.error).toContain("err-n2");
  });
});

describe("FQR-branch: executePlan failure accounting", () => {
  it("increments failedQueries when the plan executes unsuccessfully", async () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "n1" }));
    const plan = (router as any).planQuery(makeQuery());

    const before = (router as any).failedQueries;
    await router.executePlan(plan, async () => ({
      nodeId: "n1", shardIds: [], rows: [], rowCount: 0, durationMs: 0, success: false, error: "boom",
    }));

    expect((router as any).failedQueries).toBe(before + 1);
  });
});

describe("FQR-branch: constructor clock injection", () => {
  it("falls back to defaults when clock fields are absent", () => {
    const r = new FederatedQueryRouter({ nowMs: () => 12345 } as any);
    expect((r as any)._clock.nowMs()).toBe(12345);
    // nowNs absent → default _nowNs still callable
    expect(typeof (r as any)._clock.nowNs).toBe("function");
  });

  it("falls back to Date.now when nowMs is absent", () => {
    const r = new FederatedQueryRouter({} as any);
    expect((r as any)._clock.nowMs).toBe(Date.now);
  });
});

describe("FQR-branch: least-connections missing activeConnections", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("treats a missing activeConnections field as Infinity", () => {
    const partial = makeNode({ id: "partial", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: undefined as any, pendingQueries: 0, avgLatencyMs: 1 } });
    const full = makeNode({ id: "full", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } });
    router.registerNode(partial);
    router.registerNode(full);

    const picks = (router as any)._selectLeastConnections([partial, full], new Set(["shard-0"]));
    expect(picks[0].nodeId).toBe("full");
  });

  it("reports an unknown connection count when activeConnections is missing", () => {
    const partial = makeNode({ id: "partial", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: undefined as any, pendingQueries: 0, avgLatencyMs: 1 } });
    router.registerNode(partial);

    const picks = (router as any)._selectLeastConnections([partial], new Set(["shard-0"]));
    expect(picks[0].reason).toContain("unknown");
  });
});

describe("FQR-branch: geo-affinity with target shards", () => {
  let router: FederatedQueryRouter;
  beforeEach(() => { router = new FederatedQueryRouter(); });

  it("filters shards against the target set for local and remote nodes", () => {
    const local = makeNode({ id: "local", region: "us-east-1", shardIds: ["s1", "s2", "s3"] });
    const remote = makeNode({ id: "remote", region: "eu-west-2", shardIds: ["s1", "s2"] });
    router.registerNode(local);
    router.registerNode(remote);
    (router as any).policy.preferredRegion = "us-east-1";

    const picks = (router as any)._selectGeoAffinity([local, remote], new Set(["s1"]));
    expect(picks[0].nodeId).toBe("local");
    expect(picks[0].shardIds).toEqual(["s1"]);
    expect(picks[1].nodeId).toBe("remote");
    expect(picks[1].shardIds).toEqual(["s1"]);
  });
});

describe("FQR-branch: retry with fallbackStrategy unset", () => {
  it("re-plans on failure and reuses the primary strategy when fallback is cleared", async () => {
    const router = new FederatedQueryRouter();
    // Explicitly clear fallbackStrategy so the `|| strategy` fallback is exercised.
    router.setRoutingPolicy({ strategy: "round_robin", fallbackStrategy: "" as any, maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false } as any);
    router.registerNode(makeNode({ id: "n1", shardIds: ["s1"] }));

    // First attempt fails, triggering a re-plan that resolves fallback to the primary strategy.
    await router.executeQuery(makeQuery(), async (node) => ({
      nodeId: node.id, shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 1, success: false, error: "flaky",
    }));

    // The query consumed its retry budget (initial + one retry).
    expect((router as any).totalFailovers).toBe(1);
    expect((router as any).failedQueries).toBeGreaterThanOrEqual(1);
  });

  it("returns a default max-retries error when no error string is recorded", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false } as any);

    const result = await router.executeQuery(makeQuery(), async () => ({
      nodeId: "x", shardIds: [], rows: [], rowCount: 0, durationMs: 0, success: true,
    }));

    // Empty nodeResults → lastError stays undefined → default error string.
    expect(result.error).toBe("Max retries exceeded");
  });
});

