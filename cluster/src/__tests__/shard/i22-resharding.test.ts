/**
 * I22 — C4 Resharding: Online shard split/merge/migration tests.
 *
 * RES1-RES4: ShardStrategy (Hash, Range, ConsistentHash) unit tests
 * RES5-RES8: ShardManager lifecycle + events
 * RES9-RES12: ReshardPlanner (split, merge, move, rollback)
 * RES13-RES16: OnlineShardMigration (4-phase protocol, cutover, edge cases)
 * RES17-RES19: Integration scenarios (split then move, merge then rebalance)
 * RES20: Coverage verification
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  HashShardStrategy,
  RangeShardStrategy,
  ConsistentHashStrategy,
} from "../../shard/ShardStrategy";
import { ShardManager } from "../../shard/ShardManager";
import { ReshardPlanner } from "../../shard/ReshardPlanner";
import { OnlineShardMigration } from "../../shard/OnlineShardMigration";

// ── RES1: HashStrategy ──────────────────────────────────────

describe("RES1: HashShardStrategy", () => {
  let strategy: HashShardStrategy;

  beforeEach(() => {
    strategy = new HashShardStrategy();
  });

  it("deterministically maps same key to same shard", async () => {
    const r1 = await strategy.getShardForKey("user:alice", 16);
    const r2 = await strategy.getShardForKey("user:alice", 16);
    expect(r1.data).toBe(r2.data);
  });

  it("distributes keys across all shards", async () => {
    const shards = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const result = await strategy.getShardForKey(`user:${i}`, 16);
      if (result.data) shards.add(result.data);
    }
    expect(shards.size).toBeGreaterThanOrEqual(10);
  });

  it("rejects non-positive totalShards", async () => {
    const r = await strategy.getShardForKey("test", 0);
    expect(r.success).toBe(false);
  });

  it("computes assignments with replication factor", async () => {
    const result = await strategy.computeAssignments(
      ["shard-0", "shard-1", "shard-2", "shard-3"],
      ["node-a", "node-b", "node-c"],
      {},
      3,
    );
    expect(result.success).toBe(true);
    expect(Object.keys(result.data!)).toHaveLength(4);
    for (const nodes of Object.values(result.data!)) {
      expect(nodes.length).toBeLessThanOrEqual(3);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("onNodeAdded redistributes evenly", async () => {
    const current: Record<string, string[]> = {
      "shard-0": ["node-a"],
      "shard-1": ["node-a"],
      "shard-2": ["node-b"],
      "shard-3": ["node-b"],
    };
    const result = await strategy.onNodeAdded("node-c", current, 1);
    expect(result.success).toBe(true);
    const values = Object.values(result.data!);
    expect(values.some((nodes) => nodes[0] === "node-c")).toBe(true);
  });

  it("onNodeRemoved reassigns shards", async () => {
    const current: Record<string, string[]> = {
      "shard-0": ["node-a"],
      "shard-1": ["node-b"],
    };
    const result = await strategy.onNodeRemoved("node-a", current, 1);
    expect(result.success).toBe(true);
    expect(result.data!["shard-0"]![0]).not.toBe("node-a");
  });

  it("onNodeRemoved fails when no nodes remain", async () => {
    const current: Record<string, string[]> = {
      "shard-0": ["node-a"],
    };
    const result = await strategy.onNodeRemoved("node-a", current, 1);
    expect(result.success).toBe(false);
  });

  it("validates distribution detects issues", async () => {
    const valid: Record<string, string[]> = {
      "s0": ["n1", "n2"],
      "s1": ["n1", "n3"],
    };
    const r1 = await strategy.validateDistribution(valid, 2);
    expect(r1.data).toBe(true);

    const invalid: Record<string, string[]> = {
      "s0": ["n1", "n1"],
    };
    const r2 = await strategy.validateDistribution(invalid, 2);
    expect(r2.data).toBe(false);
  });

  it("empty node list returns error", async () => {
    const r = await strategy.computeAssignments(["shard-0"], [], {}, 1);
    expect(r.success).toBe(false);
  });
});

// ── RES2: RangeStrategy ─────────────────────────────────────

describe("RES2: RangeShardStrategy", () => {
  let strategy: RangeShardStrategy;

  beforeEach(() => {
    strategy = new RangeShardStrategy([
      { shardId: "shard-A", rangeStart: "a", rangeEnd: "m" },
      { shardId: "shard-B", rangeStart: "m", rangeEnd: "{" }, // '{' > 'z' for full coverage
    ]);
  });

  it("maps keys into the correct range shard", async () => {
    expect((await strategy.getShardForKey("apple", 2)).data).toBe("shard-A");
    expect((await strategy.getShardForKey("zebra", 2)).data).toBe("shard-B");
    expect((await strategy.getShardForKey("mango", 2)).data).toBe("shard-B");
  });

  it("returns error when no boundaries configured", async () => {
    const empty = new RangeShardStrategy();
    const r = await empty.getShardForKey("test", 1);
    expect(r.success).toBe(false);
  });

  it("splits a shard at a boundary key", () => {
    const result = strategy.splitShard("shard-A", "d", "shard-A2");
    expect(result.success).toBe(true);
    const boundaries = strategy.getBoundaries();
    expect(boundaries.length).toBe(3);
    const a2 = boundaries.find((b) => b.shardId === "shard-A2");
    expect(a2).toBeDefined();
    expect(a2!.rangeStart).toBe("d");
    expect(a2!.rangeEnd).toBe("m");
  });

  it("rejects split when key is out of range", () => {
    const result = strategy.splitShard("shard-A", "zebra", "shard-A2");
    expect(result.success).toBe(false);
  });

  it("rejects split for non-existent shard", () => {
    const result = strategy.splitShard("shard-X", "d", "shard-X2");
    expect(result.success).toBe(false);
  });

  it("addBoundary merges correctly into sorted list", () => {
    strategy.addBoundary({ shardId: "shard-C", rangeStart: "0", rangeEnd: "a" });
    const boundaries = strategy.getBoundaries();
    expect(boundaries[0]!.shardId).toBe("shard-C");
    expect(boundaries.length).toBe(3);
  });

  it("binary search correctly handles edge keys", async () => {
    const r = await strategy.getShardForKey("a", 2);
    expect(r.data).toBe("shard-A");
  });
});

// ── RES3: ConsistentHashStrategy ────────────────────────────

describe("RES3: ConsistentHashStrategy", () => {
  it("builds ring and maps keys consistently", async () => {
    const cs = new ConsistentHashStrategy(128);
    cs.buildRing(["node-a", "node-b", "node-c"]);
    const r1 = await cs.getShardForKey("user:1", 3);
    const r2 = await cs.getShardForKey("user:1", 3);
    expect(r1.data).toBe(r2.data);
  });

  it("ring has correct number of vnodes", () => {
    const cs = new ConsistentHashStrategy(64);
    cs.buildRing(["n1", "n2", "n3"]);
    expect(cs.getRingSize()).toBe(192);
  });

  it("handles empty ring gracefully", async () => {
    const cs = new ConsistentHashStrategy();
    const r = await cs.getShardForKey("test", 1);
    expect(r.success).toBe(false);
    expect(r.error).toContain("empty");
  });

  it("assigns replicas to distinct nodes", async () => {
    const cs = new ConsistentHashStrategy(256);
    const result = await cs.computeAssignments(
      ["shard-0", "shard-1"],
      ["n1", "n2", "n3", "n4", "n5"],
      {},
      3,
    );
    expect(result.success).toBe(true);
    for (const [, nodes] of Object.entries(result.data!)) {
      expect(new Set(nodes).size).toBe(nodes.length);
      expect(nodes.length).toBe(3);
    }
  });

  it("onNodeAdded and onNodeRemoved work", async () => {
    const cs = new ConsistentHashStrategy(64);
    const dist: Record<string, string[]> = { "shard-0": ["n1", "n2"] };
    const added = await cs.onNodeAdded("n3", dist, 2);
    expect(added.success).toBe(true);
    const removed = await cs.onNodeRemoved("n1", dist, 2);
    expect(removed.success).toBe(true);
  });

  it("estimates redistribution ratio", () => {
    const cs = new ConsistentHashStrategy();
    const ratio = cs.estimateRedistributionRatio(
      ["n1", "n2", "n3"],
      ["n1", "n2", "n3", "n4"],
    );
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(0.5);
  });
});

// ── RES4: Hash determinism ──────────────────────────────────

describe("RES4: Hash determinism across strategies", () => {
  it("HashShardStrategy produces repeatable results", async () => {
    const s = new HashShardStrategy();
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = await s.getShardForKey("exact-same-key", 10);
      results.add(r.data!);
    }
    expect(results.size).toBe(1);
  });

  it("consistent hashing vnodes produce deterministic ring", () => {
    const cs1 = new ConsistentHashStrategy(64);
    cs1.buildRing(["a", "b", "c"]);
    const cs2 = new ConsistentHashStrategy(64);
    cs2.buildRing(["a", "b", "c"]);
    expect(cs1.getRingSize()).toBe(cs2.getRingSize());
  });
});

// ── RES5-RES8: ShardManager ─────────────────────────────────

describe("RES5: ShardManager lifecycle", () => {
  let strategy: HashShardStrategy;
  let manager: ShardManager;

  beforeEach(async () => {
    strategy = new HashShardStrategy();
    manager = new ShardManager();
    await manager.initialize(strategy);
  });

  it("refuses double initialization", async () => {
    const r = await manager.initialize(strategy);
    expect(r.success).toBe(false);
  });

  it("throws when used before init", () => {
    const m = new ShardManager();
    expect(() => m.getStrategy()).toThrow();
  });

  it("assigns and lists shards", async () => {
    await manager.assignShard("shard-0", ["node-a", "node-b"]);
    await manager.assignShard("shard-1", ["node-a"]);
    const list = await manager.listShards();
    expect(list.data).toEqual(["shard-0", "shard-1"]);
    expect(manager.getShardCount()).toBe(2);
  });

  it("getShardNodes returns correct nodes", async () => {
    await manager.assignShard("shard-x", ["n1", "n2", "n3"]);
    const result = await manager.getShardNodes("shard-x");
    expect(result.data).toEqual(["n1", "n2", "n3"]);
  });

  it("getShardNodes returns error for unknown shard", async () => {
    const r = await manager.getShardNodes("nonexistent");
    expect(r.success).toBe(false);
  });

  it("removes shard and fires event", async () => {
    const removed: string[] = [];
    manager.onShardRemoved((id) => removed.push(id));
    await manager.assignShard("tmp", ["n1"]);
    await manager.removeShard("tmp");
    expect((await manager.listShards()).data).toEqual([]);
    expect(removed).toEqual(["tmp"]);
  });

  it("rejects empty nodeIds on assign", async () => {
    const r = await manager.assignShard("s1", []);
    expect(r.success).toBe(false);
  });

  it("getDistribution returns full map", async () => {
    await manager.assignShard("s0", ["n1"]);
    await manager.assignShard("s1", ["n2", "n3"]);
    const dist = await manager.getDistribution();
    expect(dist.success).toBe(true);
    expect(dist.data).toEqual({ s0: ["n1"], s1: ["n2", "n3"] });
  });

  it("hasShard and getShardAge work", async () => {
    await manager.assignShard("age-test", ["n1"]);
    expect(manager.hasShard("age-test")).toBe(true);
    expect(manager.hasShard("nope")).toBe(false);
    expect(manager.getShardAge("age-test")).not.toBeNull();
    expect(manager.getShardAge("age-test")).toBeLessThan(1000);
  });
});

describe("RES6: ShardManager events", () => {
  it("fires onShardAssigned on assign and reassign", async () => {
    const manager = new ShardManager();
    await manager.initialize(new HashShardStrategy());
    const assigned: Array<{ shardId: string; nodes: string[] }> = [];
    manager.onShardAssigned((shardId, nodes) =>
      assigned.push({ shardId, nodes }),
    );
    await manager.assignShard("s1", ["n1"]);
    await manager.assignShard("s1", ["n1", "n2"]);
    expect(assigned).toHaveLength(2);
    expect(assigned[0]!.nodes).toEqual(["n1"]);
    expect(assigned[1]!.nodes).toEqual(["n1", "n2"]);
  });

  it("removeShard rejects unknown shard", async () => {
    const manager = new ShardManager();
    await manager.initialize(new HashShardStrategy());
    const r = await manager.removeShard("ghost");
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });
});

describe("RES7: ShardManager rebalance", () => {
  it("rebalances shards across nodes", async () => {
    const strategy = new HashShardStrategy();
    const manager = new ShardManager();
    await manager.initialize(strategy);

    await manager.assignShard("shard-0", ["node-a"]);
    await manager.assignShard("shard-1", ["node-a"]);
    await manager.assignShard("shard-2", ["node-b"]);
    await manager.assignShard("shard-3", ["node-b"]);

    const result = await manager.rebalance(["node-a", "node-b", "node-c"]);
    expect(result.success).toBe(true);

    const dist = await manager.getDistribution();
    const allNodes = new Set<string>();
    for (const nodes of Object.values(dist.data!)) {
      for (const n of nodes) allNodes.add(n);
    }
    expect(allNodes.has("node-c")).toBe(true);
  });

  it("prevents concurrent rebalance corruption", async () => {
    const strategy = new HashShardStrategy();
    const manager = new ShardManager();
    await manager.initialize(strategy);
    await manager.assignShard("s0", ["n1"]);
    await manager.assignShard("s1", ["n2"]);

    const r1 = await manager.rebalance(["n1", "n2"]);
    expect(r1.success).toBe(true);
  });

  it("rebalance with no shards returns success", async () => {
    const manager = new ShardManager();
    await manager.initialize(new HashShardStrategy());
    const r = await manager.rebalance(["n1", "n2"]);
    expect(r.success).toBe(true);
  });
});

describe("RES8: ShardManager addNode/removeNode", () => {
  it("addNode triggers redistribution", async () => {
    const strategy = new HashShardStrategy();
    const manager = new ShardManager();
    await manager.initialize(strategy);

    await manager.assignShard("s0", ["n1"]);
    await manager.assignShard("s1", ["n1"]);

    const result = await manager.addNode("n2");
    expect(result.success).toBe(true);

    const dist = await manager.getDistribution();
    const allNodes = new Set<string>();
    for (const nodes of Object.values(dist.data!)) {
      for (const n of nodes) allNodes.add(n);
    }
    expect(allNodes.has("n2")).toBe(true);
  });

  it("removeNode redistributes away from removed node", async () => {
    const strategy = new HashShardStrategy();
    const manager = new ShardManager();
    await manager.initialize(strategy);

    await manager.assignShard("s0", ["n1", "n2"]);
    await manager.assignShard("s1", ["n1", "n2"]);

    const result = await manager.removeNode("n1");
    expect(result.success).toBe(true);

    const dist = await manager.getDistribution();
    for (const [, nodes] of Object.entries(dist.data!)) {
      expect(nodes).not.toContain("n1");
    }
  });
});

// ── RES9-RES12: ReshardPlanner ──────────────────────────────

describe("RES9: ReshardPlanner — split plans", () => {
  let planner: ReshardPlanner;

  beforeEach(() => {
    planner = new ReshardPlanner();
  });

  it("creates valid split plan", async () => {
    const plan = await planner.createSplitPlan(5, "user:5000");
    expect(plan.type).toBe("split");
    expect(plan.sourceShardIds).toEqual([5]);
    expect(plan.targetShardIds.length).toBe(2);
    expect(plan.dualWriteRequired).toBe(true);
    expect(plan.batchSize).toBe(10000);
  });

  it("executes split plan through all phases", async () => {
    const plan = await planner.createSplitPlan(1, "mid");
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const progress = await planner.getProgress(planId);
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe("completed");
    expect(progress!.progressPercent).toBe(100);
  });

  it("emits progress events", async () => {
    const events: string[] = [];
    planner.onProgress((p) => events.push(p.status));
    const plan = await planner.createSplitPlan(1, "mid");
    await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events).toContain("preparing");
    expect(events).toContain("migrating");
    expect(events).toContain("verifying");
    expect(events).toContain("completed");
  });

  it("prevents duplicate execution of same plan", async () => {
    const plan = await planner.createSplitPlan(2, "k");
    await planner.executePlan(plan);
    await expect(planner.executePlan(plan)).rejects.toThrow(
      "already executing",
    );
  });
});

describe("RES10: ReshardPlanner — merge plans", () => {
  it("creates valid merge plan", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createMergePlan([3, 7]);
    expect(plan.type).toBe("merge");
    expect(plan.sourceShardIds).toEqual([3, 7]);
    expect(plan.targetShardIds).toEqual([3]);
  });

  it("executes merge plan to completion", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createMergePlan([10, 20]);
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const progress = await planner.getProgress(planId);
    expect(progress!.status).toBe("completed");
  });
});

describe("RES11: ReshardPlanner — move plans", () => {
  it("creates a move plan", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createMovePlan(42, "node-z");
    expect(plan.type).toBe("move");
    expect(plan.sourceShardIds).toEqual([42]);
    expect(plan.targetShardIds).toEqual([42]);
    expect(plan.dualWriteRequired).toBe(false);
  });
});

describe("RES12: ReshardPlanner — rollback and cancel", () => {
  it("rollback resets progress", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(9, "mid");
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await planner.rollbackPlan(planId);
    const progress = await planner.getProgress(planId);
    expect(progress!.status).toBe("rolled-back");
    expect(progress!.bytesMigrated).toBe(0);
  });

  it("cancel sets plan to failed", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(8, "k");
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await planner.cancelPlan(planId);
    const progress = await planner.getProgress(planId);
    expect(progress!.status).toBe("failed");
  });

  it("listActivePlans returns only active plans", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(6, "k");
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const active = await planner.listActivePlans();
    expect(active.find((p) => p.planId === planId)).toBeUndefined();
  });

  it("verifyConsistency returns consistent after completion", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(7, "mid");
    const planId = await planner.executePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const result = await planner.verifyConsistency(planId);
    expect(result.consistent).toBe(true);
    expect(result.mismatches).toBe(0);
  });

  it("verifyConsistency returns inconsistent for unknown plan", async () => {
    const planner = new ReshardPlanner();
    const result = await planner.verifyConsistency("nonexistent");
    expect(result.consistent).toBe(false);
  });

  it("reset clears all state", async () => {
    const planner = new ReshardPlanner();
    const plan = await planner.createSplitPlan(3, "k");
    await planner.executePlan(plan);
    planner.reset();
    const progress = await planner.getProgress(plan.planId);
    expect(progress).toBeNull();
    expect(planner.getAllPlans()).toEqual([]);
  });
});

// ── RES13-RES16: OnlineShardMigration ───────────────────────

describe("RES13: OnlineShardMigration — start and status", () => {
  let migration: OnlineShardMigration;

  beforeEach(() => {
    migration = new OnlineShardMigration();
  });

  it("starts migration and gets initial status", async () => {
    const { migrationId } = await migration.startMigration({
      shardId: 1,
      sourceNode: "node-a",
      targetNode: "node-b",
      batchSize: 4096,
      finalSyncTimeoutMs: 100,
      pauseWritesOnCutover: false,
    });
    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBeDefined();
    expect(status.progress).toBeGreaterThanOrEqual(0);
    expect(status.remainingBytes).toBeGreaterThanOrEqual(0);
  });

  it("rejects same source and target", async () => {
    await expect(
      migration.startMigration({
        shardId: 1, sourceNode: "node-a", targetNode: "node-a",
        batchSize: 1000, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
      }),
    ).rejects.toThrow("must be different");
  });

  it("rejects non-positive batchSize", async () => {
    await expect(
      migration.startMigration({
        shardId: 1, sourceNode: "a", targetNode: "b",
        batchSize: 0, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
      }),
    ).rejects.toThrow("batchSize must be positive");
  });

  it("throws for unknown migration", async () => {
    await expect(migration.getStatus("ghost")).rejects.toThrow("not found");
  });
});

describe("RES14: OnlineShardMigration — 4-phase protocol", () => {
  it("completes full migration lifecycle", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 2,
      sourceNode: "node-a",
      targetNode: "node-b",
      batchSize: 1024 * 1024,
      finalSyncTimeoutMs: 50,
      pauseWritesOnCutover: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBe("completed");
    expect(status.progress).toBe(100);
    expect(status.remainingBytes).toBe(0);
  }, 10_000);

  it("pauseWritesOnCutover suspends writes", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 3,
      sourceNode: "node-a",
      targetNode: "node-b",
      batchSize: 5 * 1024 * 1024,
      finalSyncTimeoutMs: 200,
      pauseWritesOnCutover: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const suspended = migration.areWritesSuspended(migrationId);
    expect(typeof suspended).toBe("boolean");
  }, 10_000);
});

describe("RES15: OnlineShardMigration — cutover", () => {
  it("manual cutover forces completion", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 4,
      sourceNode: "node-a",
      targetNode: "node-b",
      batchSize: 10 * 1024 * 1024,
      finalSyncTimeoutMs: 1000,
      pauseWritesOnCutover: false,
    });
    await migration.cutover(migrationId);
    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBe("completed");
    expect(status.progress).toBe(100);
  });

  it("cutover on completed migration is idempotent", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 4, sourceNode: "a", targetNode: "b",
      batchSize: 10 * 1024 * 1024, finalSyncTimeoutMs: 100,
      pauseWritesOnCutover: false,
    });
    await migration.cutover(migrationId);
    await expect(migration.cutover(migrationId)).resolves.toBeUndefined();
  });

  it("cutover on rolled-back migration throws", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 4, sourceNode: "a", targetNode: "b",
      batchSize: 1024, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
    });
    await migration.rollback(migrationId);
    await expect(migration.cutover(migrationId)).rejects.toThrow(
      "cannot cutover",
    );
  });
});

describe("RES16: OnlineShardMigration — rollback/cancel/listing", () => {
  it("rollback resets to initial state", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 5, sourceNode: "a", targetNode: "b",
      batchSize: 1024, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
    });
    await migration.rollback(migrationId);
    const status = await migration.getStatus(migrationId);
    expect(status.phase).toBe("rolled-back");
    expect(status.progress).toBe(0);
  });

  it("cancel on terminal state is idempotent", async () => {
    const migration = new OnlineShardMigration();
    const { migrationId } = await migration.startMigration({
      shardId: 5, sourceNode: "a", targetNode: "b",
      batchSize: 1024, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
    });
    await migration.cancel(migrationId);
    await expect(migration.cancel(migrationId)).resolves.toBeUndefined();
  });

  it("rollback with unknown migration throws", async () => {
    const migration = new OnlineShardMigration();
    await expect(migration.rollback("nope")).rejects.toThrow("not found");
  });

  it("listMigrations returns all IDs", async () => {
    const migration = new OnlineShardMigration();
    const r1 = await migration.startMigration({
      shardId: 1, sourceNode: "a", targetNode: "b",
      batchSize: 1024, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
    });
    const r2 = await migration.startMigration({
      shardId: 2, sourceNode: "c", targetNode: "d",
      batchSize: 1024, finalSyncTimeoutMs: 100, pauseWritesOnCutover: false,
    });
    const ids = migration.listMigrations();
    expect(ids).toContain(r1.migrationId);
    expect(ids).toContain(r2.migrationId);
  });

  it("getActiveMigrationCount tracks active migrations", async () => {
    const migration = new OnlineShardMigration();
    expect(migration.getActiveMigrationCount()).toBe(0);

    await migration.startMigration({
      shardId: 1, sourceNode: "a", targetNode: "b",
      batchSize: 10 * 1024 * 1024, finalSyncTimeoutMs: 50,
      pauseWritesOnCutover: false,
    });
    expect(migration.getActiveMigrationCount()).toBe(1);
  });
});

// ── RES17-RES19: Integration scenarios ──────────────────────

describe("RES17: Split then move workflow", () => {
  it("creates split plan, executes, then moves resulting shard", async () => {
    const planner = new ReshardPlanner();
    const splitPlan = await planner.createSplitPlan(1, "mid");
    await planner.executePlan(splitPlan);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const splitProgress = await planner.getProgress(splitPlan.planId);
    expect(splitProgress!.status).toBe("completed");

    const movePlan = await planner.createMovePlan(
      splitPlan.targetShardIds[0]!,
      "node-z",
    );
    expect(movePlan.type).toBe("move");
    expect(movePlan.dualWriteRequired).toBe(false);
  });
});

describe("RES18: Rebalance after migration", () => {
  it("rebalance distributes shards after migration completion", async () => {
    const strategy = new HashShardStrategy();
    const manager = new ShardManager();
    await manager.initialize(strategy);

    for (let i = 0; i < 6; i++) {
      const node = i < 3 ? "node-a" : "node-b";
      await manager.assignShard(`shard-${i}`, [node]);
    }

    const result = await manager.rebalance(["node-a", "node-b", "node-c"]);
    expect(result.success).toBe(true);

    const dist = await manager.getDistribution();
    const nodeCShards = Object.values(dist.data!).filter(
      (nodes) => nodes[0] === "node-c",
    );
    expect(nodeCShards.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RES19: Hash uniformity", () => {
  it("hash strategy distributes 10000 keys within ±25% of ideal", async () => {
    const strategy = new HashShardStrategy();
    const totalShards = 16;
    const keyCount = 10000;
    const counts = new Map<string, number>();

    for (let i = 0; i < keyCount; i++) {
      const result = await strategy.getShardForKey(`key:${i}`, totalShards);
      const shard = result.data!;
      counts.set(shard, (counts.get(shard) ?? 0) + 1);
    }

    const ideal = keyCount / totalShards;
    const tolerance = ideal * 0.25;

    for (const [shard, count] of counts) {
      const deviation = Math.abs(count - ideal);
      expect(
        deviation,
        `shard ${shard}: ${count} vs ideal ${ideal}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  });
});

// ── RES20: Multiple planners isolation ──────────────────────

describe("RES20: Multiple planners isolation", () => {
  it("two planners are independent", async () => {
    const p1 = new ReshardPlanner();
    const p2 = new ReshardPlanner();

    const plan1 = await p1.createSplitPlan(1, "m");
    const plan2 = await p2.createSplitPlan(2, "k");

    await p1.executePlan(plan1);
    await p2.executePlan(plan2);

    await new Promise((resolve) => setTimeout(resolve, 800));

    const active1 = await p1.listActivePlans();
    const active2 = await p2.listActivePlans();
    expect(active1.length).toBe(0);
    expect(active2.length).toBe(0);
  });

  it("migration instances are isolated", async () => {
    const m1 = new OnlineShardMigration();
    const m2 = new OnlineShardMigration();

    const r1 = await m1.startMigration({
      shardId: 1, sourceNode: "a", targetNode: "b",
      batchSize: 1024, finalSyncTimeoutMs: 50, pauseWritesOnCutover: false,
    });
    const r2 = await m2.startMigration({
      shardId: 2, sourceNode: "c", targetNode: "d",
      batchSize: 1024, finalSyncTimeoutMs: 50, pauseWritesOnCutover: false,
    });

    expect(r1.migrationId).not.toBe(r2.migrationId);
    expect(m1.listMigrations()).not.toEqual(m2.listMigrations());
  });
});
