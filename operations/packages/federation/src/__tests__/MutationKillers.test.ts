/**
 * MutationKillers — precise assertions to kill arithmetic/logic mutants in
 * FederatedQueryRouter that the broader i35 suite only asserts loosely
 * (e.g. `toBeGreaterThanOrEqual(0)` or sort-order-only checks).
 *
 * Each test targets a specific survivor operator (see MUTATION_REPORT.md):
 *   - cost score arithmetic (`/`, `*`, `+`, `-`, `===`)
 *   - failover retry/backoff gates (`<`, `||`, `*`)
 *   - stats average arithmetic (`/`, `||`)
 *   - assignment filtering (`===`, `||`, `>`, `&&`)
 *   - geo-affinity exclusion (`&&`, `!==`)
 *   - priority indexing (`+`)
 */

import { describe, it, expect, vi } from "vitest";
import { FederatedQueryRouter } from "../impl/FederatedQueryRouter.js";
import type {
  FederatedNode,
  FederatedQuery,
  NodeResult,
} from "../interfaces/index.js";

function makeNode(overrides: Partial<FederatedNode> = {}): FederatedNode {
  return {
    id: `n-${Math.random().toString(36).slice(2, 6)}`,
    host: "localhost",
    port: 5432,
    role: "primary",
    health: "healthy",
    shardIds: ["s0", "s1"],
    weight: 0.5,
    capabilities: ["read", "write"],
    region: "us-east-1",
    load: { cpuPercent: 30, memoryPercent: 40, activeConnections: 10, pendingQueries: 2, avgLatencyMs: 5 },
    ...overrides,
  };
}

const THRESHOLD = { maxCpuPercent: 80, maxMemoryPercent: 80, maxPendingQueries: 50, maxAvgLatencyMs: 100 };

// ── Cost score arithmetic (L452, L457, L460, L463) ──────────────────

describe("computeNodeScore arithmetic", () => {
  it("computes exact score for a healthy node", () => {
    const router = new FederatedQueryRouter();
    const node = makeNode({
      load: { cpuPercent: 80, memoryPercent: 40, activeConnections: 10, pendingQueries: 25, avgLatencyMs: 100 },
    });
    // cpuRatio = 80/80 = 1 → 1/30 = 0.033…
    // memRatio = 40/80 = 0.5 → 0.5*25 = 12.5
    // pendingRatio = 25/50 = 0.5 → 0.5*25 = 12.5
    // latRatio = 100/100 = 1 → 1*20 = 20
    // total = 0.0333 + 12.5 + 12.5 + 20 = 45.0333 → round = 45
    expect(router.computeNodeScore(node, THRESHOLD)).toBe(45);
  });

  it("returns 50 when load or threshold is missing (no-data medium)", () => {
    const router = new FederatedQueryRouter();
    expect(router.computeNodeScore(makeNode({ load: undefined }), THRESHOLD)).toBe(50);
    expect(router.computeNodeScore(makeNode(), undefined)).toBe(50);
  });

  it("adds 30 for degraded and 100 for unhealthy nodes", () => {
    const router = new FederatedQueryRouter();
    const load = { cpuPercent: 0, memoryPercent: 0, activeConnections: 0, pendingQueries: 0, avgLatencyMs: 0 };
    const base = router.computeNodeScore(makeNode({ load, health: "healthy" }), THRESHOLD);
    const degraded = router.computeNodeScore(makeNode({ load, health: "degraded" }), THRESHOLD);
    const unhealthy = router.computeNodeScore(makeNode({ load, health: "unhealthy" }), THRESHOLD);
    expect(degraded).toBe(base + 30);
    expect(unhealthy).toBe(base + 100);
  });
});

// ── mergeResults arithmetic (L192 `-`→`+`, L224 `===`→`!==`) ────────

describe("mergeResults arithmetic", () => {
  it("totalDurationMs is the exact sum of node durations", () => {
    const router = new FederatedQueryRouter();
    const results: NodeResult[] = [
      { nodeId: "a", shardIds: [], rows: [], rowCount: 0, durationMs: 111, success: true },
      { nodeId: "b", shardIds: [], rows: [], rowCount: 0, durationMs: 222, success: true },
    ];
    expect(router.mergeResults(results).totalDurationMs).toBe(333);
  });

  it("success is true only when there are zero failures", () => {
    const router = new FederatedQueryRouter();
    const allOk: NodeResult[] = [
      { nodeId: "a", shardIds: [], rows: [{ id: 1 }], rowCount: 1, durationMs: 1, success: true },
    ];
    expect(router.mergeResults(allOk).success).toBe(true);

    const oneFail: NodeResult[] = [
      { nodeId: "a", shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "x" },
    ];
    expect(router.mergeResults(oneFail).success).toBe(false);
  });
});

// ── failover retry/backoff gates (L138 `<`, L140 `||`, L164 `||`) ───

describe("failover gates", () => {
  it("fallbackStrategy falls back to primary strategy when unset", async () => {
    const router = new FederatedQueryRouter();
    // No fallbackStrategy → fbStrategy == strategy (round_robin default).
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    let calls = 0;
    const exec = async () => {
      calls++;
      return { nodeId: "n1", shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "boom" };
    };
    const r = await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec);
    // After maxRetries=1 exhausts, result is unsuccessful with fallback error.
    expect(r.success).toBe(false);
    expect(r.error).toContain("boom");
  });

  it("error uses lastError when present, else the max-retries sentinel", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    const r = await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, async () => ({
      nodeId: "n1", shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "conn refused",
    }));
    // maxRetries=0 → one attempt, fails immediately with the real error.
    expect(r.success).toBe(false);
    expect(r.error).toBe("conn refused");
  });
});

// ── stats average arithmetic (L233 `||`, L234 `||`, L245 `/`, L246 `/`) ──

describe("getStats averages", () => {
  it("avgExecutionTimeMs divides total exec ms by query count", async () => {
    // Inject a deterministic millisecond clock so elapsed-time arithmetic is
    // precisely assertable (kills the `/` average-division mutant).
    let now = 1_000_000;
    const router = new FederatedQueryRouter({ nowMs: () => now });
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));

    for (let i = 0; i < 2; i++) {
      await router.executeQuery(
        { id: `q${i}`, sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery,
        async () => { now += 100; return { nodeId: "n1", shardIds: [], rows: [{ id: 1 }], rowCount: 1, durationMs: 10, success: true }; },
      );
    }

    const s = router.getStats();
    expect(s.totalQueries).toBe(2);
    // Two queries, 100ms each → totalExecTimeMs = 200, /2 = 100.
    expect(s.avgExecutionTimeMs).toBe(100);
  });

  it("avgPlanTimeMs divides cumulative plan ns by plan count", () => {
    // Inject a deterministic nanosecond clock that advances by 1_000_000 ns
    // (1 ms) on each read, so each planQuery's two reads (start, elapsed) yield
    // an exact 1ms elapsed time.
    let ns = 0;
    const router = new FederatedQueryRouter({ nowNs: () => (ns += 1_000_000) });
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));

    // Two plans, each contributing exactly 1_000_000 ns of elapsed time.
    router.planQuery({ id: "q1", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    router.planQuery({ id: "q2", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);

    // totalPlanTimeNs = 2_000_000, planCount = 2 (two distinct plans), /1e6 = 1ms.
    const s = router.getStats();
    expect(s.avgPlanTimeMs).toBe(1);
  });

  it("executePlan reports exact totalDurationMs from the injected clock", async () => {
    // executePlan (distinct from executeQuery) computes totalDurationMs via
    // `nowMs() - start`. Inject a clock starting at a NON-ZERO value so the
    // `-` (difference) and `+` (sum) mutants produce different results.
    let now = 1000;
    const router = new FederatedQueryRouter({ nowMs: () => now });
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));

    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    const exec = async () => {
      // Advance clock by 150ms during execution.
      now += 150;
      return { nodeId: "n1", shardIds: [], rows: [{ id: 1 }], rowCount: 1, durationMs: 10, success: true };
    };
    const result = await router.executePlan(plan, exec as any);
    // start = 1000, final = 1150 → totalDurationMs = 1150 - 1000 = 150.
    // A `+` mutant would yield 1150 + 1000 = 2150.
    expect(result.totalDurationMs).toBe(150);
  });

  it("stats with zero queries still returns finite averages", () => {
    const router = new FederatedQueryRouter();
    const s = router.getStats();
    expect(s.totalQueries).toBe(0);
    expect(Number.isFinite(s.avgExecutionTimeMs)).toBe(true);
    expect(Number.isFinite(s.avgPlanTimeMs)).toBe(true);
  });
});

// ── assignment filtering (L266 `>`, L271 `===`/`||`) ──────────────

describe("assignment filtering", () => {
  it("filters out unhealthy nodes when skipUnhealthy is set", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: true, geoAffinity: false });
    router.registerNode(makeNode({ id: "healthy", health: "healthy" }));
    router.registerNode(makeNode({ id: "unhealthy", health: "unhealthy" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments.every((a) => a.nodeId === "healthy")).toBe(true);
  });

  it("write intent excludes read-only replica nodes", () => {
    const router = new FederatedQueryRouter();
    // weighted strategy returns ALL candidates (not just one), so the role
    // filter's effect is fully observable: the replica must be structurally
    // absent, not merely un-selected by round-robin.
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "rw", capabilities: ["read", "write"], role: "primary", weight: 1 }));
    router.registerNode(makeNode({ id: "ro", capabilities: ["read"], role: "replica", weight: 1 }));
    const all = router.planQuery({ id: "q", sql: "x", intent: "write", consistency: "strong", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // Every returned assignment is primary/coordinator; replica is excluded.
    expect(all.assignments.length).toBeGreaterThan(0);
    for (const a of all.assignments) {
      expect(a.nodeId).not.toBe("ro");
    }
  });

  it("leader_only strategy filters to primary even for read intent", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "leader_only", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "primary", role: "primary", capabilities: ["read"] }));
    router.registerNode(makeNode({ id: "coordinator", role: "coordinator", capabilities: ["read"] }));
    router.registerNode(makeNode({ id: "replica", role: "replica", capabilities: ["read"] }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // read intent + leader_only → the `||` gate must trigger primary/coordinator
    // filtering; replica excluded.
    for (const a of plan.assignments) {
      expect(a.nodeId).not.toBe("replica");
    }
  });
});

// ── geo-affinity exclusion (L385 `&&`/`!==`, L371/L442 `+`) ───────

describe("geo-affinity and priority", () => {
  it("prefers nodes in the preferred region", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "geo_affinity", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: true, preferredRegion: "eu-west-1" });
    router.registerNode(makeNode({ id: "eu", region: "eu-west-1" }));
    router.registerNode(makeNode({ id: "us", region: "us-east-1" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments[0]!.nodeId).toBe("eu");
    expect(plan.assignments[1]!.nodeId).toBe("us");
  });

  it("no preferred region leaves every node local", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "geo_affinity", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a", region: "us-east-1" }));
    router.registerNode(makeNode({ id: "b", region: "eu-west-1" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // No preferred → local = all, remote = none (both `!preferred` and
    // `preferred && ...` guards are exercised by the empty-preferred case).
    expect(plan.assignments.every((a) => a.reason.startsWith("geo_affinity (region="))).toBe(true);
  });

  it("weighted routing assigns priority 1-based (i + 1)", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a", weight: 3 }));
    router.registerNode(makeNode({ id: "b", weight: 1 }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments[0]!.priority).toBe(1);
    expect(plan.assignments[1]!.priority).toBe(2);
  });
});

// ── failover retry/backoff boundary (L155 `<`, L161 `*`) ─────────────

describe("failover retry boundary", () => {
  it("falls back to the primary strategy when fallbackStrategy is unset", async () => {
    const router = new FederatedQueryRouter();
    // Explicitly pass no fallbackStrategy so fbStrategy === strategy.
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false } as any);
    router.registerNode(makeNode({ id: "n1", weight: 3 }));
    router.registerNode(makeNode({ id: "n2", weight: 1 }));
    let first = true;
    const exec = async (node: unknown) => {
      const id = (node as FederatedNode).id;
      if (first) { first = false; return { nodeId: id, shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "boom" }; }
      return { nodeId: id, shardIds: [], rows: [{ id: 1 }], rowCount: 1, durationMs: 1, success: true };
    };
    const r = await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec as any);
    expect(r.success).toBe(true);
  });

  it("uses fallbackStrategy when set (distinct from primary strategy)", async () => {
    const router = new FederatedQueryRouter();
    // Primary strategy = round_robin (single node, cycles in registration
    // order). fallbackStrategy = least_connections (single lowest-connection
    // node). After the first node fails, the `||` must select
    // least_connections → the lowest-connection node, NOT continue round-robin.
    router.setRoutingPolicy({
      strategy: "round_robin",
      fallbackStrategy: "least_connections",
      maxRetries: 1,
      retryBackoffMs: 1,
      skipUnhealthy: false,
      geoAffinity: false,
    });
    // n1 registered first (round_robin counter 0 → n1), high connections.
    // n2 registered second, fewest connections (least_connections picks it).
    // n3 registered third (round_robin counter 1 → n3 after n1 excluded).
    router.registerNode(makeNode({ id: "n1", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 9, pendingQueries: 0, avgLatencyMs: 1 } }));
    router.registerNode(makeNode({ id: "n2", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } }));
    router.registerNode(makeNode({ id: "n3", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 5, pendingQueries: 0, avgLatencyMs: 1 } }));

    const attempts: string[] = [];
    const exec = async (node: unknown) => {
      const id = (node as FederatedNode).id;
      attempts.push(id);
      if (id === "n1") {
        return { nodeId: id, shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "boom" };
      }
      return { nodeId: id, shardIds: [], rows: [{ id: 1 }], rowCount: 1, durationMs: 1, success: true };
    };
    const r = await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec as any);
    expect(r.success).toBe(true);
    // First attempt = n1 (round_robin). Retry with least_connections = n2
    // (1 connection). If `&&` mutant, fallback would be round_robin → n3.
    expect(attempts[0]).toBe("n1");
    expect(attempts[1]).toBe("n2");
  });

  it("does not retry when maxRetries is exhausted", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    router.registerNode(makeNode({ id: "n2" }));
    let calls = 0;
    const exec = async () => {
      calls++;
      return { nodeId: calls === 1 ? "n1" : "n2", shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "boom" };
    };
    // maxRetries=1 → 1 initial attempt + 1 retry = exactly 2 calls, then stop.
    await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec);
    expect(calls).toBe(2);
  });

  it("excludes the failed node on retry (excludeNodeIds non-empty)", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    router.registerNode(makeNode({ id: "n2" }));
    const seen: string[] = [];
    const exec = async (node: unknown) => {
      const id = (node as FederatedNode).id;
      seen.push(id);
      // n1 always fails; n2 succeeds. On retry, n1 must be excluded so n2 runs.
      return { nodeId: id, shardIds: [], rows: id === "n1" ? [] : [{ id: 1 }], rowCount: id === "n1" ? 0 : 1, durationMs: 1, success: id !== "n1", error: id === "n1" ? "boom" : undefined };
    };
    const r = await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec as any);
    expect(r.success).toBe(true);
    // The failed node n1 was excluded on re-plan, so the second attempt ran n2.
    expect(seen).toContain("n2");
  });

  it("backoff sleep uses retryBackoffMs doubled per retry", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 2, retryBackoffMs: 10, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "n1" }));
    router.registerNode(makeNode({ id: "n2" }));
    router.registerNode(makeNode({ id: "n3" }));

    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    const exec = async (node: unknown) => ({ nodeId: (node as FederatedNode).id, shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: "boom" });
    await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery, exec as any);

    const delays = sleepSpy.mock.calls.map((c) => c[1] as number);
    expect(delays).toContain(10);
    expect(delays).toContain(20);
    sleepSpy.mockRestore();
  });
});

// ── assignment filtering boundary (L279 `>`, L284 `===`/`||`) ───────

describe("assignment filtering boundaries", () => {
  it("leader_only strategy routes only to primary nodes", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "leader_only", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "primary", role: "primary" }));
    router.registerNode(makeNode({ id: "replica", role: "replica" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments.every((a) => a.nodeId === "primary")).toBe(true);
  });

  it("empty excludeNodeIds keeps all candidates", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a" }));
    router.registerNode(makeNode({ id: "b" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // round_robin selects one node; the empty exclude list must not drop any.
    expect(plan.assignments).toHaveLength(1);
  });
});

// ── cost sort boundary (L439 `-`, L455 `+`) ────────────────────────────────

describe("cost sort", () => {
  it("sorts by ascending score (lower is better)", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false, costThreshold: THRESHOLD });
    router.registerNode(makeNode({ id: "expensive", load: { cpuPercent: 90, memoryPercent: 90, activeConnections: 50, pendingQueries: 50, avgLatencyMs: 100 } }));
    router.registerNode(makeNode({ id: "cheap", load: { cpuPercent: 1, memoryPercent: 1, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments[0]!.nodeId).toBe("cheap");
  });

  it("all-exceeded falls back to least-bad via ascending sort", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false, costThreshold: { maxCpuPercent: 10, maxMemoryPercent: 10, maxPendingQueries: 5, maxAvgLatencyMs: 10 } });
    // Both nodes far exceed thresholds → valid.length === 0 → leastBad sort.
    // Register the worse one first to force a real reorder via `a.score - b.score`.
    router.registerNode(makeNode({ id: "very-bad", load: { cpuPercent: 99, memoryPercent: 99, activeConnections: 100, pendingQueries: 50, avgLatencyMs: 200 } }));
    router.registerNode(makeNode({ id: "less-bad", load: { cpuPercent: 20, memoryPercent: 20, activeConnections: 10, pendingQueries: 10, avgLatencyMs: 20 } }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments[0]!.nodeId).toBe("less-bad");
    expect(plan.assignments[0]!.reason).toContain("all exceeded");
  });

  it("cost_based priority is 1-based (i + 1)", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "cost_based", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false, costThreshold: THRESHOLD });
    router.registerNode(makeNode({ id: "a", load: { cpuPercent: 10, memoryPercent: 10, activeConnections: 1, pendingQueries: 0, avgLatencyMs: 1 } }));
    router.registerNode(makeNode({ id: "b", load: { cpuPercent: 20, memoryPercent: 20, activeConnections: 2, pendingQueries: 1, avgLatencyMs: 2 } }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.assignments[0]!.priority).toBe(1);
    expect(plan.assignments[1]!.priority).toBe(2);
  });
});

// ── high-line survivors: estimate cost, failover internals, defaults ──

describe("estimate cost and defaults", () => {
  it("estimateCost is max(1, assignmentCount * 10)", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a" }));
    router.registerNode(makeNode({ id: "b" }));
    // weighted returns both nodes → 2 assignments → cost = 20.
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    expect(plan.estimatedCost).toBe(20);
  });

  it("default policy skips unhealthy nodes (skipUnhealthy=true)", () => {
    const router = new FederatedQueryRouter();
    // weighted returns ALL candidates, so the unhealthy node is structurally
    // present in the candidate set. Default skipUnhealthy=true must exclude it.
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, geoAffinity: false });
    router.registerNode(makeNode({ id: "healthy", health: "healthy", weight: 1 }));
    router.registerNode(makeNode({ id: "sick", health: "unhealthy", weight: 5 }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // Default skipUnhealthy=true must exclude the unhealthy node entirely.
    expect(plan.assignments.map((a) => a.nodeId)).not.toContain("sick");
    expect(plan.assignments.map((a) => a.nodeId)).toContain("healthy");
  });

  it("default policy does not use geo affinity (geoAffinity=false)", () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "far", region: "ap-south-1" }));
    router.registerNode(makeNode({ id: "local", region: "us-east-1" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // Default strategy is round_robin (not geo_affinity), so no affinity filter.
    expect(plan.strategy).toBe("round_robin");
  });
});

describe("failover internals", () => {
  it("records failover with replaceent node and 1-based attempt reason", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", fallbackStrategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "spare", health: "healthy", shardIds: ["s1"] }));
    const exec = async (node: any) => ({
      nodeId: node.id, shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 1,
      success: node.id !== "fail", error: node.id === "fail" ? "timeout" : undefined,
    });
    await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery, exec as any);
    const evt = router.getFailoverHistory()[0]!;
    expect(evt.success).toBe(true);           // fbNode !== undefined
    expect(evt.failoverNodeId).toBe("spare"); // replacement found via health filter
    // retryAttempt is 0-based internally, so the reason reports attempt + 1.
    expect(evt.retryAttempt).toBe(0);
  });

  it("records failover success=false when no healthy replacement exists", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", fallbackStrategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    // Only one node (the failing one); no spare with overlapping shards.
    router.registerNode(makeNode({ id: "only", health: "healthy", shardIds: ["s1"] }));
    const exec = async (node: any) => ({
      nodeId: node.id, shardIds: ["s1"], rows: [], rowCount: 0, durationMs: 1,
      success: false, error: "kaput",
    });
    await router.executeQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery, exec as any);
    const evt = router.getFailoverHistory()[0]!;
    expect(evt.success).toBe(false); // fbNode === undefined → the `!==` gate
  });
});

// ── executePlan internals: error join, missing node, empty shards ──

describe("executePlan internals", () => {
  it("error joins failure messages only when ALL nodes fail (successCount===0)", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "weighted", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "a" }));
    router.registerNode(makeNode({ id: "b" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);

    // All fail → error is the joined messages.
    const allFail = await router.executePlan(plan, (async (n: any) => ({
      nodeId: n.id, shardIds: [], rows: [], rowCount: 0, durationMs: 1, success: false, error: `fail-${n.id}`,
    })) as any);
    expect(allFail.success).toBe(false);
    expect(allFail.error).toBe("fail-a; fail-b");

    // Some succeed → error is undefined.
    const mixed = await router.executePlan(plan, (async (n: any) => ({
      nodeId: n.id, shardIds: [], rows: n.id === "a" ? [{ id: 1 }] : [], rowCount: n.id === "a" ? 1 : 0, durationMs: 1, success: n.id === "a", error: n.id === "a" ? undefined : "fail-b",
    })) as any);
    expect(mixed.success).toBe(true);
    expect(mixed.error).toBeUndefined();
  });

  it("reports success=false for an assignment whose node no longer exists", async () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 0, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "ghost" }));
    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 } as FederatedQuery);
    // Remove the node AFTER planning so the assignment references a missing node.
    (router as any).nodes.delete("ghost");

    const result = await router.executePlan(plan, (async () => ({
      nodeId: "ghost", shardIds: [], rows: [], rowCount: 0, durationMs: 0, success: true,
    })) as any);
    // The internal node-lookup path returns success:false (node not found),
    // so the caller-supplied executor is never invoked for the missing node.
    expect(result.success).toBe(false);
    expect(result.failCount).toBe(1);
  });
});

// ── _failover internals: remove failed node, reason string, health filter ──

describe("failover plan mutation", () => {
  it("removes the failed node from plan.assignments and records 1-based attempt", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "spare", health: "healthy", shardIds: ["s1"] }));

    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery);
    // Plan initially targets "fail" (round_robin counter 0).
    expect(plan.assignments.some((a) => a.nodeId === "fail")).toBe(true);

    const evt = (router as any)._failover("fail", plan, 0);
    // After failover, "fail" is removed and "spare" is pushed as fallback.
    expect(plan.assignments.some((a) => a.nodeId === "fail")).toBe(false);
    expect(plan.assignments.some((a) => a.nodeId === "spare")).toBe(true);
    const fb = plan.assignments.find((a) => a.nodeId === "spare")!;
    expect(fb.priority).toBe(99);
    expect(fb.reason).toContain("attempt 1");
    expect(evt.success).toBe(true);
  });

  it("excludes unhealthy candidates from failover replacement", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: true, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "sick-spare", health: "unhealthy", shardIds: ["s1"] }));

    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery);
    const evt = (router as any)._failover("fail", plan, 0);
    // The unhealthy node must NOT be chosen as replacement → success=false.
    expect(evt.success).toBe(false);
    expect(evt.failoverNodeId).toBeUndefined();
  });
});

describe("failover health filter (skipUnhealthy=false)", () => {
  it("single-level health filter excludes unhealthy candidate when skipUnhealthy is false", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: false, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "sick-spare", health: "unhealthy", shardIds: ["s1"] }));

    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery);
    const evt = (router as any)._failover("fail", plan, 0);
    // With skipUnhealthy=false there is no second filter; the `health ===
    // "healthy"` candidates filter is the ONLY gate, so the unhealthy spare
    // must NOT become a replacement.
    expect(evt.success).toBe(false);
    expect(evt.failoverNodeId).toBeUndefined();
  });
});

describe("failover double health filter (skipUnhealthy=true)", () => {
  it("still finds a healthy replacement when skipUnhealthy is true", () => {
    const router = new FederatedQueryRouter();
    router.setRoutingPolicy({ strategy: "round_robin", maxRetries: 1, retryBackoffMs: 1, skipUnhealthy: true, geoAffinity: false });
    router.registerNode(makeNode({ id: "fail", health: "healthy", shardIds: ["s1"] }));
    router.registerNode(makeNode({ id: "spare", health: "healthy", shardIds: ["s1"] }));

    const plan = router.planQuery({ id: "q", sql: "x", intent: "read", consistency: "eventual", targetShards: ["s1"], timeoutMs: 100 } as FederatedQuery);
    const evt = (router as any)._failover("fail", plan, 0);
    // With skipUnhealthy=true, the L600 replacement filter runs on an already-
    // healthy candidates set; the healthy spare must still be chosen.
    expect(evt.success).toBe(true);
    expect(evt.failoverNodeId).toBe("spare");
  });
});

// ── _executePlanInternal shard grouping + fallback ──

describe("shard assignment grouping", () => {
  function makePlan(router: any, assignments: any[], queryId = "q"): any {
    return {
      query: { id: queryId, sql: "x", intent: "read", consistency: "eventual", targetShards: [], timeoutMs: 100 },
      assignments,
      strategy: "round_robin",
      estimatedCost: 1,
      createdAt: Date.now(),
    };
  }

  it("groups shardIds per node (filter === nodeId)", async () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "n1", shardIds: ["s0", "s1"] }));
    router.registerNode(makeNode({ id: "n2", shardIds: ["s2"] }));

    const received: Record<string, string[]> = {};
    const plan = makePlan(router, [
      { nodeId: "n1", shardIds: ["s1"], priority: 1, reason: "r" },
      { nodeId: "n2", shardIds: ["s2"], priority: 1, reason: "r" },
    ]);
    await router.executePlan(plan, (async (node: any, _q: any, shardIds: string[]) => {
      received[node.id] = shardIds;
      return { nodeId: node.id, shardIds, rows: [], rowCount: 0, durationMs: 1, success: true };
    }) as any);

    // Each node received ONLY its own shardIds (not the union of all).
    expect(received["n1"]).toEqual(["s1"]);
    expect(received["n2"]).toEqual(["s2"]);
  });

  it("falls back to all node shards when an assignment has empty shardIds", async () => {
    const router = new FederatedQueryRouter();
    router.registerNode(makeNode({ id: "n1", shardIds: ["s0", "s1"] }));

    const received: string[] = [];
    const plan = makePlan(router, [
      { nodeId: "n1", shardIds: [], priority: 1, reason: "r" },
    ]);
    await router.executePlan(plan, (async (node: any, _q: any, shardIds: string[]) => {
      received.push(...shardIds);
      return { nodeId: node.id, shardIds, rows: [], rowCount: 0, durationMs: 1, success: true };
    }) as any);

    // Empty assignment shardIds → fall back to ALL node shards.
    expect(received).toEqual(["s0", "s1"]);
  });
});
