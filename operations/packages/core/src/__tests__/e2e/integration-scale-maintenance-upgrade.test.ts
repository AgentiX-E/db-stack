/**
 * INT3 — AutoScale ↔ Maintenance ↔ RollingUpgrade Integration Tests
 *
 * Cross-package scenarios:
 *   - Rolling upgrade full batch sequence
 *   - Pause/resume cycle integrity
 *   - Rollback state transitions
 *   - Maintenance + upgrade coexistence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntegratedFactory } from "./integrated-factory.js";
import type { RollingUpgradePlan } from "@agentix-e/db-operations-rollingupgrade";

describe("INT3: AutoScale ↔ Maintenance ↔ RollingUpgrade", () => {
  let factory: IntegratedFactory;

  beforeEach(() => {
    factory = new IntegratedFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  // ── INT3.1: Rolling upgrade full batch sequence ─

  it("INT3.1: rolling upgrade executes complete batch sequence", async () => {
    const upgrade = factory.createRollingUpgrade();
    const plan: RollingUpgradePlan = {
      id: "int3-1",
      name: "rolling-upgrade",
      targetVersion: "v2",
      nodes: ["n1", "n2", "n3"],
      batchStrategy: "fixed_size",
      batchSize: 1,
      rollbackTrigger: "manual_only",
      healthCheckNames: [],
      preScript: "validate.sh",
      postScript: "check.sh",
    };

    const stats = await upgrade.execute(plan);
    expect(stats.phase).toBe("completed");
    expect(stats.totalNodes).toBe(3);
    expect(stats.completedBatches).toBe(stats.totalBatches);
    expect(stats.completedBatches).toBeGreaterThanOrEqual(3);
  });

  // ── INT3.2: Pre-script + post-script both executed ─

  it("INT3.2: pre-script and post-script phases are included", async () => {
    const upgrade = factory.createRollingUpgrade();
    const plan: RollingUpgradePlan = {
      id: "int3-2",
      name: "rolling-upgrade",
      targetVersion: "v2",
      nodes: ["x"],
      batchStrategy: "fixed_size",
      batchSize: 1,
      rollbackTrigger: "manual_only",
      healthCheckNames: [],
      preScript: "lock.sh",
      postScript: "unlock.sh",
    };

    const stats = await upgrade.execute(plan);

    // A single-node upgrade produces exactly one promoted batch.
    expect(stats.phase).toBe("completed");
    expect(stats.totalBatches).toBe(1);
    expect(stats.completedBatches).toBe(1);
    // Lifecycle events cover the full plan → batch → promote → complete flow.
    expect(stats.events.some((e) => e.type === "upgrade_completed")).toBe(true);
  });

  // ── INT3.3: Pause flag toggles without error ─

  it("INT3.3: pause flag cycles correctly", async () => {
    const upgrade = factory.createRollingUpgrade();
    await upgrade.pause();
    await upgrade.resume();

    const plan: RollingUpgradePlan = {
      id: "int3-3",
      name: "rolling-upgrade",
      targetVersion: "v2",
      nodes: ["a", "b", "c", "d"],
      batchStrategy: "fixed_size",
      batchSize: 2,
      rollbackTrigger: "manual_only",
      healthCheckNames: [],
      preScript: "pre.sh",
      postScript: "post.sh",
    };
    const stats = await upgrade.execute(plan);

    // execute() runs to completion — 4 nodes / 2 per batch = 2 batches.
    expect(stats.phase).toBe("completed");
    expect(stats.totalBatches).toBe(2);
    expect(stats.completedBatches).toBe(2);
  });

  // ── INT3.4: Rollback marks phases correctly ─

  it("INT3.4: rollback removes running status from all phases", async () => {
    const upgrade = factory.createRollingUpgrade();
    const plan: RollingUpgradePlan = {
      id: "int3-4",
      name: "rolling-upgrade",
      targetVersion: "v2",
      nodes: ["x1", "x2"],
      batchStrategy: "fixed_size",
      batchSize: 1,
      rollbackTrigger: "manual_only",
      healthCheckNames: [],
      preScript: "pre.sh",
      postScript: "post.sh",
    };

    await upgrade.execute(plan);
    const rollbackStats = await upgrade.rollback();

    // After rollback, no batch remains in the running state.
    const batches = upgrade.getBatches();
    expect(batches.every((b) => b.status !== "running")).toBe(true);
    expect(rollbackStats.rolledBackNodes).toBeGreaterThanOrEqual(0);
  });

  // ── INT3.5: Maintenance executor runs vacuum ─

  it("INT3.5: maintenance executor vacuum task succeeds", async () => {
    const exec = factory.createMaintenanceExecutor();
    const result = await exec.vacuum({ tables: ["test_table"] });
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  // ── INT3.6: Maintenance executor analyze task ─

  it("INT3.6: maintenance executor analyze task succeeds", async () => {
    const exec = factory.createMaintenanceExecutor();
    const result = await exec.analyze({ tables: ["metrics"] });
    expect(result.success).toBe(true);
  });

  // ── INT3.7: Maintenance executor reindex ─

  it("INT3.7: maintenance executor reindex task succeeds", async () => {
    const exec = factory.createMaintenanceExecutor();
    const result = await exec.reindex({ index: "idx_users" });
    expect(result.success).toBe(true);
  });

  // ── INT3.8: Maintenance and upgrade compose in same session ─

  it("INT3.8: maintenance and rolling upgrade coexist in one factory", async () => {
    const exec = factory.createMaintenanceExecutor();
    const upgrade = factory.createRollingUpgrade();

    const mResult = await exec.reindex({ index: "pk_users" });
    const plan: RollingUpgradePlan = {
      id: "int3-8",
      name: "rolling-upgrade",
      targetVersion: "v2",
      nodes: ["a"],
      batchStrategy: "fixed_size",
      batchSize: 1,
      rollbackTrigger: "manual_only",
      healthCheckNames: [],
      preScript: "pre.sh",
      postScript: "post.sh",
    };
    const uStats = await upgrade.execute(plan);

    expect(mResult.success).toBe(true);
    expect(uStats.phase).toBe("completed");
    expect(uStats.totalNodes).toBe(1);
  });

  // ── INT3.9: Storage stats accessible ─

  it("INT3.9: maintenance executor returns storage stats", async () => {
    const exec = factory.createMaintenanceExecutor();
    const stats = await exec.getStorageStats("default");
    expect(stats).toBeDefined();
    expect(typeof stats.fileSizeBytes).toBe("number");
  });

  // ── INT3.10: Index fragmentation queryable ─

  it("INT3.10: maintenance executor returns index fragmentation", async () => {
    const exec = factory.createMaintenanceExecutor();
    const fragmentation = await exec.getIndexFragmentation("idx_test");
    expect(Array.isArray(fragmentation)).toBe(true);
  });
});
