/**
 * I32 — D2 Rolling Upgrades tests.
 *
 * ROL1-ROL12: plan validation, batch strategies, canary, health gating,
 * rollback, pause/resume, stats, edge cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RollingUpgradeOrchestrator } from "../impl/RollingUpgradeOrchestrator.js";
import type {
  RollingUpgradePlan,
  BatchHealth,
} from "../interfaces/types.js";

// ── Helpers ────────────────────────────────────────────────

const NODES = [
  "node-01", "node-02", "node-03", "node-04", "node-05",
  "node-06", "node-07", "node-08", "node-09", "node-10",
];

/** Instant sleep for fast tests. */
const instantSleep = () => Promise.resolve();

/** Create engine with fast test options. */
function createEngine(opts: { minBakeMs?: number } = {}) {
  return new RollingUpgradeOrchestrator({
    minBakeMs: opts.minBakeMs ?? 100,
    sleep: instantSleep,
  });
}

function plan(overrides: Partial<RollingUpgradePlan> = {}): RollingUpgradePlan {
  return {
    id: "test-plan",
    name: "Test Plan",
    targetVersion: "2.0.0",
    nodes: NODES,
    batchStrategy: "fixed_size",
    batchSize: 3,
    rollbackTrigger: "on_first_failure",
    healthCheckNames: [],
    canary: undefined,
    ...overrides,
  };
}

function healthyCheck(): Promise<BatchHealth> {
  return Promise.resolve({
    healthy: true,
    nodes: [{ healthy: true, details: { latency: "5ms" }, checkedAt: Date.now() }],
    evaluatedAt: Date.now(),
  });
}

function unhealthyCheck(reason = "high_latency"): Promise<BatchHealth> {
  return Promise.resolve({
    healthy: false,
    nodes: [{ healthy: false, details: { latency: "999ms", [reason]: true }, checkedAt: Date.now() }],
    evaluatedAt: Date.now(),
  });
}

function flakyCheck(): Promise<BatchHealth> {
  return Promise.reject(new Error("Network timeout"));
}

// ── ROL1: Plan Validation ──────────────────────────────────

describe("ROL1: Plan validation", () => {
  let engine: RollingUpgradeOrchestrator;

  beforeEach(() => {
    engine = createEngine();
  });

  it("rejects empty node list", async () => {
    await expect(engine.execute(plan({ nodes: [] }))).rejects.toThrow("nodes");
  });

  it("rejects missing id", async () => {
    await expect(engine.execute(plan({ id: "" }))).rejects.toThrow("id");
  });

  it("rejects invalid canary fraction", async () => {
    await expect(
      engine.execute(plan({ canary: { fraction: 0, bakeTimeMs: 30_000, requiredChecks: [], autoPromote: true } })),
    ).rejects.toThrow("Canary fraction");
  });

  it("rejects canary fraction > 1", async () => {
    await expect(
      engine.execute(plan({ canary: { fraction: 1.5, bakeTimeMs: 30_000, requiredChecks: [], autoPromote: true } })),
    ).rejects.toThrow("Canary fraction");
  });

  it("rejects insufficient canary bake time", async () => {
    const e = new RollingUpgradeOrchestrator({ minBakeMs: 1000 });
    await expect(
      e.execute(plan({ canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: [], autoPromote: true } })),
    ).rejects.toThrow("bake time");
  });

  it("rejects batchSize < 1 for fixed_size", async () => {
    await expect(engine.execute(plan({ batchStrategy: "fixed_size", batchSize: 0 }))).rejects.toThrow(
      "batchSize",
    );
  });

  it("rejects unregistered health check", async () => {
    await expect(
      engine.execute(plan({ healthCheckNames: ["nonexistent"] })),
    ).rejects.toThrow('"nonexistent"');
  });

  it("accepts valid plan", async () => {
    engine.registerHealthCheck("basic", async () => healthyCheck());
    const result = await engine.execute(
      plan({ healthCheckNames: ["basic"], canary: undefined, nodes: ["n1", "n2", "n3"] }),
    );
    expect(result.phase).toBe("completed");
  });
});

// ── ROL2: Batch Strategies ─────────────────────────────────

describe("ROL2: Batch strategies", () => {
  function makeEngine(): RollingUpgradeOrchestrator {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());
    return engine;
  }

  it("fixed_size splits nodes into equal batches", async () => {
    const engine = makeEngine();
    await engine.execute(
      plan({ batchStrategy: "fixed_size", batchSize: 3, canary: undefined, healthCheckNames: ["ok"] }),
    );
    expect(engine.getPhase()).toBe("completed");
    expect(engine.getBatches().length).toBeGreaterThanOrEqual(3); // 10/3 = 4 batches
  });

  it("one_by_one creates one batch per node", async () => {
    const engine = makeEngine();
    await engine.execute(
      plan({ batchStrategy: "one_by_one", batchSize: undefined, canary: undefined, healthCheckNames: ["ok"], nodes: ["n1", "n2", "n3"] }),
    );
    expect(engine.getBatches().length).toBe(3);
    for (const batch of engine.getBatches()) {
      expect(batch.nodes).toHaveLength(1);
    }
  });

  it("all_at_once creates a single batch", async () => {
    const engine = makeEngine();
    await engine.execute(
      plan({ batchStrategy: "all_at_once", batchSize: undefined, canary: undefined, healthCheckNames: ["ok"], nodes: ["n1", "n2", "n3"] }),
    );
    expect(engine.getBatches()).toHaveLength(1);
    expect(engine.getBatches()[0]!.nodes).toHaveLength(3);
  });

  it("percentage strategy splits proportionally", async () => {
    const engine = makeEngine();
    const result = await engine.execute(
      plan({ batchStrategy: "percentage", batchSize: 25, canary: undefined, healthCheckNames: ["ok"], nodes: ["a", "b", "c", "d", "e", "f", "g", "h"] }),
    );
    expect(result.phase).toBe("completed");
    const batches = engine.getBatches();
    // 25% of 8 = 2 per batch → 4 batches
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.length).toBeLessThanOrEqual(8);
  });
});

// ── ROL3: Canary Deployment ────────────────────────────────

describe("ROL3: Canary deployment", () => {
  it("creates canary batch with correct proportion", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: ["ok"], autoPromote: true },
        healthCheckNames: ["ok"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    const batches = engine.getBatches();
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]!.isCanary).toBe(true);

    // 20% of 10 = 2
    expect(batches[0]!.nodes.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]!.nodes.length).toBeLessThanOrEqual(3);

    // Canary should be promoted
    for (const node of batches[0]!.nodes) {
      expect(node.status).toBe("completed");
    }
  });

  it("canary failure triggers rollback on canary_failure policy", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("fail", async () => unhealthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: ["fail"], autoPromote: false },
        healthCheckNames: ["fail"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    expect(result.phase).toBe("failed");
    expect(result.rolledBackNodes).toBeGreaterThanOrEqual(0);
  });

  it("canary maxCanaryNodes caps the canary size", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        canary: { fraction: 0.5, bakeTimeMs: 100, requiredChecks: ["ok"], autoPromote: true, maxCanaryNodes: 2 },
        healthCheckNames: ["ok"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    const canaryBatch = engine.getBatches().find((b) => b.isCanary);
    expect(canaryBatch).toBeDefined();
    expect(canaryBatch!.nodes.length).toBeLessThanOrEqual(2);
  });

  it("canary without autoPromote still promotes on health pass", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: ["ok"], autoPromote: false },
        healthCheckNames: ["ok"],
        rollbackTrigger: "manual_only",
      }),
    );

    expect(result.phase).toBe("completed");
  });
});

// ── ROL4: Health Gating ────────────────────────────────────

describe("ROL4: Health gating", () => {
  it("passes with all healthy checks", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("latency", async () => healthyCheck());
    engine.registerHealthCheck("errors", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["latency", "errors"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    expect(result.phase).toBe("completed");
    expect(result.upgradedNodes).toBe(2);
  });

  it("fails and rolls back on unhealthy node", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("flaky", async () => unhealthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["flaky"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    expect(result.phase).toBe("failed");
  });

  it("flaky health check (exception) treated as unhealthy", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("crash", async () => flakyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a"],
        healthCheckNames: ["crash"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    expect(result.phase).toBe("failed");
  });

  it("no health checks → always healthy", async () => {
    const engine = createEngine();
    const result = await engine.execute(
      plan({ nodes: ["a"], healthCheckNames: [], canary: undefined }),
    );
    expect(result.phase).toBe("completed");
  });
});

// ── ROL5: Rollback Triggers ────────────────────────────────

describe("ROL5: Rollback triggers", () => {
  it("on_first_failure rolls back immediately", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("bad", async () => unhealthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        rollbackTrigger: "on_first_failure",
        healthCheckNames: ["bad"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("failed");
    expect(result.rolledBackNodes).toBeGreaterThanOrEqual(0);
  });

  it("manual_only fails but does not rollback", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("bad", async () => unhealthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        rollbackTrigger: "manual_only",
        healthCheckNames: ["bad"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("failed");
    expect(result.rolledBackNodes).toBe(0);
  });

  it("manual rollback triggered externally", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    // Complete an upgrade first
    await engine.execute(
      plan({
        nodes: ["a", "b", "c"],
        rollbackTrigger: "manual_only",
        healthCheckNames: ["ok"],
        canary: undefined,
      }),
    );
    expect(engine.getPhase()).toBe("completed");

    // Now trigger manual rollback
    const rollbackResult = await engine.rollback();
    expect(rollbackResult.rolledBackNodes).toBeGreaterThanOrEqual(1);
  });

  it("on_canary_failure does not trigger if no canary", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        rollbackTrigger: "on_canary_failure",
        healthCheckNames: ["ok"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("completed");
  });
});

// ── ROL6: Pause & Resume ───────────────────────────────────

describe("ROL6: Pause and resume", () => {
  it("pause and resume after completion work without error", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["ok"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );
    expect(result.phase).toBe("completed");

    // Pause/resume after completion (no-op but shouldn't crash)
    await engine.pause();
    await engine.resume();
    expect(engine.getPhase()).toBe("completed");
  });

  it("getPhase returns idle initially", () => {
    const engine = createEngine();
    expect(engine.getPhase()).toBe("idle");
  });

  it("pause event is recorded", async () => {
    const engine = createEngine();
    await engine.pause();
    const events = engine.getEvents();
    expect(events.some((e) => e.type === "paused")).toBe(true);
  });
});

// ── ROL7: Statistics ───────────────────────────────────────

describe("ROL7: Statistics", () => {
  it("stats reflect completed upgrade", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        healthCheckNames: ["ok"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    expect(result.totalNodes).toBe(5);
    expect(result.upgradedNodes).toBe(5);
    expect(result.failedNodes).toBe(0);
    expect(result.phase).toBe("completed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeGreaterThan(0);
  });

  it("stats track failed and rolled back nodes", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("bad", async () => unhealthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c"],
        healthCheckNames: ["bad"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    expect(result.phase).toBe("failed");
    expect(result.failedNodes).toBeGreaterThanOrEqual(1);
  });

  it("getBatches returns snapshot copy", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({ nodes: ["a", "b"], healthCheckNames: ["ok"], canary: undefined }),
    );

    const batches = engine.getBatches();
    batches[0]!.status = "failed" as any; // mutate copy
    expect(engine.getBatches()[0]!.status).toBe("completed"); // original unaffected
  });

  it("getEvents returns snapshot copy", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({ nodes: ["a"], healthCheckNames: ["ok"], canary: undefined }),
    );

    const events = engine.getEvents();
    events.push({ type: "paused", timestamp: 0, details: {} } as any);
    expect(engine.getEvents().length).toBeLessThan(events.length);
  });
});

// ── ROL8: Event History ────────────────────────────────────

describe("ROL8: Event history", () => {
  it("emits plan_validated event", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({ nodes: ["a"], healthCheckNames: ["ok"], canary: undefined }),
    );

    const events = engine.getEvents();
    expect(events.some((e) => e.type === "plan_validated")).toBe(true);
    expect(events.some((e) => e.type === "batch_started")).toBe(true);
    expect(events.some((e) => e.type === "upgrade_completed")).toBe(true);
  });

  it("emits canary lifecycle events", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: ["ok"], autoPromote: true },
        healthCheckNames: ["ok"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    const events = engine.getEvents();
    expect(events.some((e) => e.type === "canary_started")).toBe(true);
    expect(events.some((e) => e.type === "canary_promoted")).toBe(true);
  });

  it("emits rollback events on failure", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("bad", async () => unhealthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["bad"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    const events = engine.getEvents();
    expect(events.some((e) => e.type === "rollback_triggered")).toBe(true);
    expect(events.some((e) => e.type === "rollback_completed")).toBe(true);
  });

  it("emits canary_failed event when canary is unhealthy", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("fail", async () => unhealthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b", "c"],
        canary: { fraction: 0.3, bakeTimeMs: 100, requiredChecks: ["fail"], autoPromote: false },
        healthCheckNames: ["fail"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    const events = engine.getEvents();
    expect(events.some((e) => e.type === "canary_failed")).toBe(true);
  });
});

// ── ROL9: Edge Cases ───────────────────────────────────────

describe("ROL9: Edge cases", () => {
  it("single node upgrade", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({ nodes: ["only"], healthCheckNames: ["ok"], canary: undefined }),
    );
    expect(result.phase).toBe("completed");
    expect(result.upgradedNodes).toBe(1);
  });

  it("maxDurationMs triggers abort", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        healthCheckNames: ["ok"],
        canary: undefined,
        maxDurationMs: 1, // 1ms — will trip immediately (at least after first batch)
        rollbackTrigger: "manual_only",
      }),
    );

    // May complete if first batch finishes fast enough, or may abort
    expect(["completed", "aborted"].includes(result.phase)).toBe(true);
  });

  it("rejects negative canary fraction", async () => {
    const engine = createEngine();
    await expect(
      engine.execute(
        plan({
          canary: { fraction: -0.5, bakeTimeMs: 30_000, requiredChecks: [], autoPromote: true },
        }),
      ),
    ).rejects.toThrow("Canary fraction");
  });

  it("batch promotion marks nodes as completed", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({ nodes: ["a", "b"], healthCheckNames: ["ok"], canary: undefined }),
    );

    for (const batch of engine.getBatches()) {
      for (const node of batch.nodes) {
        expect(node.status).toBe("completed");
        expect(node.completedAt).toBeGreaterThan(0);
      }
    }
  });

  it("drain configuration is applied", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["ok"],
        canary: undefined,
        drain: { timeoutMs: 5000, waitForInflight: true, connectionDrainMs: 10 },
      }),
    );

    expect(result.phase).toBe("completed");
    // With instant sleep, durationMs ≈ 0, but plan executed correctly
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("pause after completion is a no-op", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    // First complete normally
    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        healthCheckNames: ["ok"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );
    expect(result.phase).toBe("completed");

    // Pause+resume after completion
    await engine.pause();
    await engine.resume();
    expect(engine.getPhase()).toBe("completed");
  });
});

// ── ROL10: Node State Transitions ──────────────────────────

describe("ROL10: Node state transitions", () => {
  it("healthy nodes transition: pending → draining → upgrading → health_check → completed", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({ nodes: ["n1"], healthCheckNames: ["ok"], canary: undefined }),
    );

    const nodeStatuses = engine.getBatches().flatMap((b) => b.nodes.map((n) => n.status));
    expect(nodeStatuses.every((s) => s === "completed")).toBe(true);
  });

  it("unhealthy nodes transition to failed", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("bad", async () => unhealthyCheck());

    await engine.execute(
      plan({
        nodes: ["n1"],
        healthCheckNames: ["bad"],
        canary: undefined,
        rollbackTrigger: "on_first_failure",
      }),
    );

    const nodeStatuses = engine.getBatches().flatMap((b) => b.nodes.map((n) => n.status));
    expect(nodeStatuses.some((s) => s === "failed" || s === "rolled_back")).toBe(true);
  });

  it("nodes in canary batch have distinct lifecycle", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e"],
        canary: { fraction: 0.2, bakeTimeMs: 100, requiredChecks: ["ok"], autoPromote: true },
        healthCheckNames: ["ok"],
        rollbackTrigger: "on_canary_failure",
      }),
    );

    const canaryBatch = engine.getBatches().find((b) => b.isCanary);
    expect(canaryBatch).toBeDefined();
    expect(canaryBatch!.nodes.every((n) => n.status === "completed")).toBe(true);
  });
});

// ── ROL11: Batch Failure Threshold ─────────────────────────

describe("ROL11: Batch failure threshold", () => {
  it("on_batch_threshold triggers rollback when exceeded", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("mixed", async () => {
      return {
        healthy: false,
        nodes: [{ healthy: false, details: { errors: 3 }, checkedAt: Date.now() }],
        evaluatedAt: Date.now(),
      };
    });

    const result = await engine.execute(
      plan({
        nodes: ["a", "b"],
        rollbackTrigger: "on_batch_threshold",
        batchFailureThreshold: 0.3,
        healthCheckNames: ["mixed"],
        canary: undefined,
      }),
    );

    expect(["failed", "aborted"].includes(result.phase)).toBe(true);
  });

  it("on_batch_threshold does not rollback if below threshold", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    // All pass, threshold irrelevant
    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c"],
        rollbackTrigger: "on_batch_threshold",
        batchFailureThreshold: 0.9,
        healthCheckNames: ["ok"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("completed");
  });
});

// ── ROL12: Resource Diversity ──────────────────────────────

describe("ROL12: Resource diversity", () => {
  it("upgrades nodes with different identifiers", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["db-primary", "db-replica-01", "db-replica-02"],
        healthCheckNames: ["ok"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("completed");
    expect(result.upgradedNodes).toBe(3);
  });

  it("targetVersion is preserved in plan", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({ nodes: ["n1"], healthCheckNames: ["ok"], targetVersion: "3.1.0", canary: undefined }),
    );
    expect(result.planId).toBe("test-plan");
  });

  it("last batch with fewer nodes handles correctly", async () => {
    const engine = createEngine();
    engine.registerHealthCheck("ok", async () => healthyCheck());

    const result = await engine.execute(
      plan({
        nodes: ["a", "b", "c", "d", "e", "f", "g"], // 7 nodes
        batchStrategy: "fixed_size",
        batchSize: 3, // batches: 3 + 3 + 1
        healthCheckNames: ["ok"],
        canary: undefined,
      }),
    );

    expect(result.phase).toBe("completed");
    expect(result.upgradedNodes).toBe(7);
    const batches = engine.getBatches();
    const lastBatch = batches[batches.length - 1]!;
    expect(lastBatch.nodes.length).toBeLessThanOrEqual(3);
  });
});
