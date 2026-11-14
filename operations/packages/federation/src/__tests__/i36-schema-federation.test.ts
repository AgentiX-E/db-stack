/**
 * I36 — C6 Schema Federation tests.
 *
 * SCF1-SCF14: snapshots, drift detection (6 types), repair plans/execution,
 * migration coordination (4 modes), drift monitor, stats, rules,
 * reference strategies (4), edge cases, production workflow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MigrationDescriptor, MigrationPlan } from "@agentix-e/db-operations-core";
import { SchemaFederator } from "../impl/SchemaFederator.js";
import type {
  SchemaSnapshot,
  SchemaDrift,
  DriftRepair,
  SchemaRule,
} from "../interfaces/schema-federation.js";

// ── Helpers ────────────────────────────────────────────────

function makeMigration(
  overrides: Partial<MigrationDescriptor> & { version: number; checksum: string },
): MigrationDescriptor {
  return {
    version: overrides.version,
    description: overrides.description ?? `Migration v${overrides.version}`,
    state: overrides.state ?? "applied",
    checksum: overrides.checksum,
    appliedAt: overrides.appliedAt ?? new Date().toISOString(),
    durationMs: overrides.durationMs ?? 100,
  };
}

function makeSnapshot(
  overrides: Partial<SchemaSnapshot> & { shardId: string },
): SchemaSnapshot {
  return {
    shardId: overrides.shardId,
    version: overrides.version ?? 0,
    migrations: overrides.migrations ?? [],
    chainChecksum: overrides.chainChecksum ?? "",
    capturedAt: overrides.capturedAt ?? Date.now(),
  };
}

function makePlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    currentVersion: overrides.currentVersion ?? 0,
    targetVersion: overrides.targetVersion ?? 1,
    pending: overrides.pending ?? [],
  };
}

function makeDrift(overrides: {
  type: SchemaDrift["type"];
  severity?: SchemaDrift["severity"];
  migration?: MigrationDescriptor;
}): SchemaDrift {
  return {
    id: `drift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: overrides.type,
    severity: overrides.severity ?? "warning",
    shardId: "test-shard",
    referenceShardId: "ref-shard",
    driftedVersion: 1,
    referenceVersion: 2,
    migration: overrides.migration,
    description: `Test ${overrides.type}`,
    detectedAt: Date.now(),
    resolved: false,
  };
}

afterEach(() => {
  // Clean up stray timers
  // (no-op — vitest cleans up between tests)
});

// ── SCF1: Snapshot Capture ─────────────────────────────────

describe("SCF1: Snapshot capture and management", () => {
  let federator: SchemaFederator;

  beforeEach(() => { federator = new SchemaFederator(); });

  it("captures snapshot with computed checksum", async () => {
    const migs = [
      makeMigration({ version: 1, checksum: "abc123" }),
      makeMigration({ version: 2, checksum: "def456" }),
    ];
    federator._setSnapshotInject(async (shardId: string) => ({
      shardId, version: 2, migrations: migs, chainChecksum: "", capturedAt: 0,
    }));

    const snapshot = await federator.captureSnapshot("shard-1");
    expect(snapshot.shardId).toBe("shard-1");
    expect(snapshot.version).toBe(2);
    expect(snapshot.chainChecksum).toBeTruthy();
    expect(snapshot.chainChecksum.length).toBe(16);
    expect(snapshot.capturedAt).toBeGreaterThan(0);
  });

  it("computed checksum is deterministic", async () => {
    const migs = [makeMigration({ version: 1, checksum: "abc" })];
    federator._setSnapshotInject(async (shardId) => ({
      shardId, version: 1, migrations: migs, chainChecksum: "", capturedAt: 0,
    }));
    const s1 = await federator.captureSnapshot("shard-1");
    const s2 = await federator.captureSnapshot("shard-1");
    expect(s1.chainChecksum).toBe(s2.chainChecksum);
  });

  it("getSnapshot returns undefined for unknown shard", () => {
    expect(federator.getSnapshot("nope")).toBeUndefined();
  });

  it("registerShard computes checksum automatically", () => {
    const migs = [makeMigration({ version: 1, checksum: "v1hash" })];
    federator.registerShard(makeSnapshot({ shardId: "reg-1", version: 1, migrations: migs }));
    expect(federator.getSnapshot("reg-1")!.chainChecksum).toBeTruthy();
  });

  it("snapshot checksum changes when migration state changes", async () => {
    federator._setSnapshotInject(async (shardId) => ({
      shardId, version: 1,
      migrations: shardId === "s1"
        ? [makeMigration({ version: 1, checksum: "abc", state: "applied" })]
        : [makeMigration({ version: 1, checksum: "abc", state: "failed" })],
      chainChecksum: "", capturedAt: 0,
    }));
    const s1 = await federator.captureSnapshot("s1");
    const s2 = await federator.captureSnapshot("s2");
    expect(s1.chainChecksum).not.toBe(s2.chainChecksum);
  });
});

// ── SCF2: Version Mismatch ─────────────────────────────────

describe("SCF2: Version mismatch drift detection", () => {
  it("detects version mismatch between two shards", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "behind", version: 3 }));
    fed.registerShard(makeSnapshot({ shardId: "ahead", version: 5 }));

    const drifts = fed.compareShards("behind", "ahead");
    const v = drifts.find((d) => d.type === "version_mismatch")!;
    expect(v).toBeDefined();
    expect(v.driftedVersion).toBe(3);
    expect(v.referenceVersion).toBe(5);
    expect(v.severity).toBe("info");
  });

  it("large version gap is critical", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "old", version: 1 }));
    fed.registerShard(makeSnapshot({ shardId: "new", version: 50 }));
    const d = fed.compareShards("old", "new").find((x) => x.type === "version_mismatch")!;
    expect(d.severity).toBe("critical");
  });

  it("same version produces no version_mismatch", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "a", version: 4 }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 4 }));
    expect(fed.compareShards("a", "b").filter((d) => d.type === "version_mismatch")).toEqual([]);
  });
});

// ── SCF3: Missing/Extra Migration ──────────────────────────

describe("SCF3: Missing and extra migration drift", () => {
  it("detects missing migration", () => {
    const fed = new SchemaFederator();
    const v1 = makeMigration({ version: 1, checksum: "abc" });
    const v2 = makeMigration({ version: 2, checksum: "def" });

    fed.registerShard(makeSnapshot({ shardId: "partial", version: 1, migrations: [v1] }));
    fed.registerShard(makeSnapshot({ shardId: "full", version: 2, migrations: [v1, v2] }));

    const miss = fed.compareShards("partial", "full").find((d) => d.type === "missing_migration")!;
    expect(miss).toBeDefined();
    expect(miss.migration!.version).toBe(2);
    expect(miss.severity).toBe("warning");
  });

  it("detects extra migration", () => {
    const fed = new SchemaFederator();
    const v1 = makeMigration({ version: 1, checksum: "abc" });
    const v2 = makeMigration({ version: 2, checksum: "def" });

    fed.registerShard(makeSnapshot({ shardId: "extra", version: 2, migrations: [v1, v2] }));
    fed.registerShard(makeSnapshot({ shardId: "clean", version: 1, migrations: [v1] }));

    const extra = fed.compareShards("extra", "clean").find((d) => d.type === "extra_migration")!;
    expect(extra).toBeDefined();
    expect(extra.migration!.version).toBe(2);
  });

  it("identical migrations produce zero drift", () => {
    const fed = new SchemaFederator();
    const v1 = makeMigration({ version: 1, checksum: "abc" });
    fed.registerShard(makeSnapshot({ shardId: "a", version: 1, migrations: [v1] }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 1, migrations: [v1] }));
    expect(fed.compareShards("a", "b")).toEqual([]);
  });
});

// ── SCF4: Checksum Divergence ──────────────────────────────

describe("SCF4: Checksum divergence drift", () => {
  it("detects checksum divergence", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({
      shardId: "a", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "aaa111" })],
    }));
    fed.registerShard(makeSnapshot({
      shardId: "b", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "bbb222" })],
    }));

    const div = fed.compareShards("a", "b").find((d) => d.type === "checksum_divergence")!;
    expect(div).toBeDefined();
    expect(div.severity).toBe("critical");
    expect(div.driftedChecksum).toBe("aaa111");
    expect(div.referenceChecksum).toBe("bbb222");
  });

  it("same checksum produces no divergence", () => {
    const fed = new SchemaFederator();
    const v1 = makeMigration({ version: 1, checksum: "abc" });
    fed.registerShard(makeSnapshot({ shardId: "a", version: 1, migrations: [v1] }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 1, migrations: [v1] }));
    expect(fed.compareShards("a", "b").filter((d) => d.type === "checksum_divergence")).toEqual([]);
  });
});

// ── SCF5: Order & State Divergence ─────────────────────────

describe("SCF5: Order and state divergence", () => {
  it("detects order divergence", () => {
    const fed = new SchemaFederator();
    // Create separate migration objects to avoid sort-in-place mutation
    const v1a = makeMigration({ version: 1, checksum: "a1" });
    const v2a = makeMigration({ version: 2, checksum: "b2" });
    const v1b = makeMigration({ version: 1, checksum: "a1" });
    const v2b = makeMigration({ version: 2, checksum: "b2" });

    fed.registerShard(makeSnapshot({ shardId: "a", version: 2, migrations: [v1a, v2a] }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 2, migrations: [v2b, v1b] }));

    const order = fed.compareShards("a", "b").find((d) => d.type === "order_divergence")!;
    expect(order).toBeDefined();
    expect(order.severity).toBe("critical");
  });

  it("detects migration state mismatch", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({
      shardId: "ok", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "abc", state: "applied" })],
    }));
    fed.registerShard(makeSnapshot({
      shardId: "broken", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "abc", state: "failed" })],
    }));

    const state = fed.compareShards("broken", "ok").find((d) => d.type === "migration_state_mismatch")!;
    expect(state).toBeDefined();
    expect(state.severity).toBe("critical");
  });

  it("non-failed state mismatch is info level", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({
      shardId: "a", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "abc", state: "pending" })],
    }));
    fed.registerShard(makeSnapshot({
      shardId: "b", version: 1,
      migrations: [makeMigration({ version: 1, checksum: "abc", state: "applied" })],
    }));

    const state = fed.compareShards("a", "b").find((d) => d.type === "migration_state_mismatch")!;
    expect(state.severity).toBe("info");
  });
});

// ── SCF6: Reference Strategies ─────────────────────────────

describe("SCF6: Reference strategy comparison", () => {
  it("primary strategy uses highest version", () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "low", version: 1 }));
    fed.registerShard(makeSnapshot({ shardId: "high", version: 5 }));

    const drifts = fed.compareAgainstReference("low");
    expect(drifts.some((d) => d.type === "version_mismatch")).toBe(true);
  });

  it("majority strategy picks most common version", () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("majority");
    fed.registerShard(makeSnapshot({ shardId: "a", version: 3 }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 3 }));
    fed.registerShard(makeSnapshot({ shardId: "c", version: 3 }));
    fed.registerShard(makeSnapshot({ shardId: "outlier", version: 5 }));

    expect(fed.compareAgainstReference("outlier").some((d) => d.type === "version_mismatch")).toBe(true);
  });

  it("latest strategy uses numerically highest", () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("latest");
    fed.registerShard(makeSnapshot({ shardId: "a", version: 10 }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 2 }));

    const v = fed.compareAgainstReference("b").find((d) => d.type === "version_mismatch")!;
    expect(v.referenceVersion).toBe(10);
  });

  it("canonical strategy uses nominated shard", () => {
    const fed = new SchemaFederator();
    fed.setCanonicalShard("canon");
    fed.registerShard(makeSnapshot({ shardId: "canon", version: 1 }));
    fed.registerShard(makeSnapshot({ shardId: "other", version: 5 }));

    expect(fed.compareAgainstReference("other").some((d) => d.type === "version_mismatch")).toBe(true);
  });
});

// ── SCF7: Batch Drift Detection ────────────────────────────

describe("SCF7: Batch drift detection", () => {
  it("detectAllDrifts scans all shards", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");

    const v1 = makeMigration({ version: 1, checksum: "abc" });
    const v2 = makeMigration({ version: 2, checksum: "def" });

    fed.registerShard(makeSnapshot({ shardId: "leader", version: 2, migrations: [v1, v2] }));
    fed.registerShard(makeSnapshot({ shardId: "follower", version: 1, migrations: [v1] }));

    const drifts = await fed.detectAllDrifts();
    expect(drifts.length).toBeGreaterThan(0);
  });

  it("detectAllDrifts with <2 shards returns empty", async () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "solo", version: 1 }));
    expect(await fed.detectAllDrifts()).toEqual([]);
  });

  it("detectAllDrifts updates stats", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 2 }));
    fed.registerShard(makeSnapshot({ shardId: "drifted", version: 1 }));

    await fed.detectAllDrifts();
    const stats = fed.getMonitorStats();
    expect(stats.totalScans).toBe(1);
    expect(stats.totalDriftsDetected).toBeGreaterThan(0);
    expect(stats.lastScanAt).toBeGreaterThan(0);
  });

  it("drift type breakdown in stats", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 1, migrations: [makeMigration({ version: 1, checksum: "a1" })] }));
    fed.registerShard(makeSnapshot({ shardId: "div", version: 1, migrations: [makeMigration({ version: 1, checksum: "b2" })] }));

    await fed.detectAllDrifts();
    expect(fed.getMonitorStats().driftsByType.checksum_divergence).toBeGreaterThan(0);
  });
});

// ── SCF8: Repair Plans ─────────────────────────────────────

describe("SCF8: Repair plan generation", () => {
  it("missing_migration → apply_migration", () => {
    const fed = new SchemaFederator();
    const m = makeMigration({ version: 2, checksum: "def" });
    const repair = fed.planRepair(makeDrift({ type: "missing_migration", migration: m, severity: "warning" }));
    expect(repair.action).toBe("apply_migration");
    expect(repair.migrationsToApply).toEqual([m]);
    expect(repair.automatable).toBe(true);
  });

  it("checksum_divergence → resync_snapshot (manual)", () => {
    const fed = new SchemaFederator();
    const repair = fed.planRepair(makeDrift({ type: "checksum_divergence", severity: "critical" }));
    expect(repair.action).toBe("resync_snapshot");
    expect(repair.automatable).toBe(false);
    expect(repair.requiresDowntime).toBe(true);
  });

  it("extra_migration → rollback", () => {
    const fed = new SchemaFederator();
    const m = makeMigration({ version: 5, checksum: "extra" });
    const repair = fed.planRepair(makeDrift({ type: "extra_migration", migration: m }));
    expect(repair.action).toBe("rollback_migration");
    expect(repair.migrationToRollback!.version).toBe(5);
  });

  it("order_divergence is not automatable", () => {
    const fed = new SchemaFederator();
    const repair = fed.planRepair(makeDrift({ type: "order_divergence", severity: "critical" }));
    expect(repair.action).toBe("reorder_migrations");
    expect(repair.automatable).toBe(false);
  });
});

// ── SCF9: Repair Execution ─────────────────────────────────

describe("SCF9: Repair execution", () => {
  it("executeRepair runs executor and marks resolved", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed._setRepairExecutor(async () => {});

    const v1 = makeMigration({ version: 1, checksum: "abc" });
    const v2 = makeMigration({ version: 2, checksum: "def" });
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 2, migrations: [v1, v2] }));
    fed.registerShard(makeSnapshot({ shardId: "drifted", version: 1, migrations: [v1] }));

    await fed.detectAllDrifts();
    const active = fed.getActiveDrifts();
    expect(active.length).toBeGreaterThan(0);

    // Repair ALL active drifts
    for (const d of active) {
      const repair = fed.planRepair(d);
      const result = await fed.executeRepair(repair);
      expect(result.success).toBe(true);
    }

    expect(fed.getActiveDrifts()).toHaveLength(0);
    expect(fed.getDriftHistory().length).toBeGreaterThan(0);
  });

  it("executeRepair on non-existent drift returns failure", async () => {
    const fed = new SchemaFederator();
    const repair: DriftRepair = {
      driftId: "nonexistent", action: "mark_resolved", requiresDowntime: false, automatable: true,
    };
    const result = await fed.executeRepair(repair);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("autoRepair fixes automatable drifts only", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed._setRepairExecutor(async () => {});

    const v1 = makeMigration({ version: 1, checksum: "abc" });
    const v2 = makeMigration({ version: 2, checksum: "def" });
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 2, migrations: [v1, v2] }));
    fed.registerShard(makeSnapshot({ shardId: "partial", version: 1, migrations: [v1] }));

    await fed.detectAllDrifts();
    const repaired = await fed.autoRepair();
    expect(repaired.length).toBeGreaterThan(0);
    expect(repaired.every((r) => r.success)).toBe(true);
  });

  it("resolveManually marks drift resolved", () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");

    fed.registerShard(makeSnapshot({ shardId: "ref", version: 1, migrations: [makeMigration({ version: 1, checksum: "a1" })] }));
    fed.registerShard(makeSnapshot({ shardId: "div", version: 1, migrations: [makeMigration({ version: 1, checksum: "b2" })] }));

    const drifts = fed.compareShards("div", "ref");
    expect(drifts.length).toBeGreaterThan(0);

    const d = drifts[0]!;
    const resolved = fed.resolveManually(d.id, "acknowledged false positive");
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolution).toBe("acknowledged false positive");
  });

  it("resolveManually throws for unknown drift", () => {
    const fed = new SchemaFederator();
    expect(() => fed.resolveManually("nope", "reason")).toThrow("not found");
  });
});

// ── SCF10: Migration Coordination ──────────────────────────

describe("SCF10: Migration coordination", () => {
  it("starts coordination in 'all' mode", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));
    fed.registerShard(makeSnapshot({ shardId: "s2" }));

    const coord = fed.startCoordinatedMigration(makePlan({ currentVersion: 1, targetVersion: 2 }), "all");
    expect(coord.state).toBe("preparing");
    expect(coord.shardIds).toEqual(["s1", "s2"]);
  });

  it("canary mode sets canaryShardId", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));
    fed.registerShard(makeSnapshot({ shardId: "s2" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "canary");
    expect(coord.canaryShardId).toBe("s1");
    expect(coord.shardIds).toHaveLength(2);
  });

  it("manual mode starts with empty shardIds", () => {
    const fed = new SchemaFederator();
    const coord = fed.startCoordinatedMigration(makePlan(), "manual");
    expect(coord.shardIds).toEqual([]);
  });

  it("reportShardResult transitions state → verifying", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));
    fed.registerShard(makeSnapshot({ shardId: "s2" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "all");

    fed.reportShardResult(coord.id, { shardId: "s1", version: 2, success: true, durationMs: 100 });
    expect(coord.state).toBe("rolling_out");

    fed.reportShardResult(coord.id, { shardId: "s2", version: 2, success: true, durationMs: 150 });
    expect(coord.state).toBe("verifying");
  });

  it("failed shard triggers rollback", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));
    fed.registerShard(makeSnapshot({ shardId: "s2" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "all");

    fed.reportShardResult(coord.id, { shardId: "s1", version: 2, success: true, durationMs: 100 });
    fed.reportShardResult(coord.id, { shardId: "s2", version: 2, success: false, durationMs: 50, error: "constraint" });

    expect(coord.state).toBe("rolled_back");
    expect(coord.error).toBeTruthy();
    expect(coord.completedAt).toBeGreaterThan(0);
  });

  it("pause and resume coordination", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "all");
    expect(coord.state).toBe("preparing");

    fed.pauseCoordination(coord.id);
    expect(fed.getCoordinationState(coord.id)!.state).toBe("paused");

    fed.resumeCoordination(coord.id);
    expect(fed.getCoordinationState(coord.id)!.state).toBe("rolling_out");
  });

  it("cannot pause completed/rolled_back", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "s1" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "all");
    fed.reportShardResult(coord.id, { shardId: "s1", version: 1, success: true, durationMs: 10 });
    // 1 shard all done → verifying
    expect(coord.state).toBe("verifying");
    expect(() => fed.pauseCoordination(coord.id)).toThrow("Cannot pause");
  });

  it("getCoordinationState for unknown ID", () => {
    expect(new SchemaFederator().getCoordinationState("nope")).toBeUndefined();
  });

  it("batched mode includes all shards", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "a" }));
    fed.registerShard(makeSnapshot({ shardId: "b" }));

    const coord = fed.startCoordinatedMigration(makePlan(), "batched");
    expect(coord.shardIds).toHaveLength(2);
    expect(coord.mode).toBe("batched");
  });
});

// ── SCF11: Drift Monitor ───────────────────────────────────

describe("SCF11: Drift monitor lifecycle", () => {
  it("start and stop monitor", () => {
    const fed = new SchemaFederator();
    fed.startMonitor({ scanIntervalMs: 50 });
    fed.stopMonitor();
  });

  it("monitor with autoResolve", () => {
    const fed = new SchemaFederator();
    fed.startMonitor({ scanIntervalMs: 100, autoResolve: true });
    fed.stopMonitor();
  });

  it("scanNow returns drifts from all shards", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 5 }));
    fed.registerShard(makeSnapshot({ shardId: "behind", version: 1 }));

    const drifts = await fed.scanNow();
    expect(drifts.length).toBeGreaterThan(0);
  });
});

// ── SCF12: Custom Rules ────────────────────────────────────

describe("SCF12: Custom schema validation rules", () => {
  it("register + validate with custom rule", () => {
    const fed = new SchemaFederator();
    fed.registerRule({
      name: "no_empty", description: "Must have migrations",
      enforced: true, severity: "critical",
      check: (s) => s.version > 0,
    });

    const drifts = fed.validateSnapshot(makeSnapshot({ shardId: "empty", version: 0 }));
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.description).toContain("no_empty");
    expect(drifts[0]!.severity).toBe("critical");
  });

  it("passing rule produces no drift", () => {
    const fed = new SchemaFederator();
    fed.registerRule({
      name: "positive", description: "Version > 0",
      enforced: true, severity: "info",
      check: (s) => s.version > 0,
    });
    expect(fed.validateSnapshot(makeSnapshot({ shardId: "ok", version: 5 }))).toEqual([]);
  });

  it("rule that throws produces error drift", () => {
    const fed = new SchemaFederator();
    fed.registerRule({
      name: "explode", description: "Always throws",
      enforced: true, severity: "critical",
      check: () => { throw new Error("boom"); },
    });

    const drifts = fed.validateSnapshot(makeSnapshot({ shardId: "x", version: 1 }));
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.description).toContain("threw an error");
  });

  it("unregisterRule removes check", () => {
    const fed = new SchemaFederator();
    fed.registerRule({
      name: "temp", description: "Temporary", enforced: true, severity: "info",
      check: () => false,
    });
    fed.unregisterRule("temp");
    expect(fed.validateSnapshot(makeSnapshot({ shardId: "x", version: 1 }))).toEqual([]);
  });
});

// ── SCF13: Edge Cases ──────────────────────────────────────

describe("SCF13: Edge cases", () => {
  it("compareShards with unknown shard returns empty", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "a", version: 1 }));
    expect(fed.compareShards("a", "unknown")).toEqual([]);
    expect(fed.compareShards("unknown", "a")).toEqual([]);
  });

  it("getDrift for unknown ID returns undefined", () => {
    expect(new SchemaFederator().getDrift("nope")).toBeUndefined();
  });

  it("getActiveDrifts vs getDriftHistory isolation", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed._setRepairExecutor(async () => {});

    fed.registerShard(makeSnapshot({ shardId: "ref", version: 2 }));
    fed.registerShard(makeSnapshot({ shardId: "behind", version: 1 }));

    await fed.detectAllDrifts();
    await fed.autoRepair();

    expect(fed.getActiveDrifts()).toEqual([]);
    expect(fed.getDriftHistory().length).toBeGreaterThan(0);
  });

  it("getDriftsForShard filters correctly", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 3 }));
    fed.registerShard(makeSnapshot({ shardId: "diverged", version: 1 }));

    await fed.detectAllDrifts();
    const shardDrifts = fed.getDriftsForShard("diverged");
    expect(shardDrifts.length).toBeGreaterThan(0);
    expect(shardDrifts.every((d) => d.shardId === "diverged")).toBe(true);
    expect(fed.getDriftsForShard("no-such")).toEqual([]);
  });

  it("empty snapshots compare correctly", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "a", version: 0 }));
    fed.registerShard(makeSnapshot({ shardId: "b", version: 0 }));
    expect(fed.compareShards("a", "b")).toEqual([]);
  });

  it("self-comparison returns empty", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "self", version: 1 }));
    expect(fed.compareShards("self", "self")).toEqual([]);
  });

  it("stats init zeroed", () => {
    const s = new SchemaFederator().getMonitorStats();
    expect(s.totalScans).toBe(0);
    expect(s.totalDriftsDetected).toBe(0);
    expect(s.activeDrifts).toBe(0);
    expect(s.driftsResolved).toBe(0);
    expect(s.autoResolved).toBe(0);
    expect(s.manuallyResolved).toBe(0);
    expect(s.lastScanAt).toBeNull();
  });

  it("stats reflect manual resolution count", () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed.registerShard(makeSnapshot({ shardId: "ref", version: 1, migrations: [makeMigration({ version: 1, checksum: "a1" })] }));
    fed.registerShard(makeSnapshot({ shardId: "div", version: 1, migrations: [makeMigration({ version: 1, checksum: "b2" })] }));

    const drifts = fed.compareShards("div", "ref");
    fed.resolveManually(drifts[0]!.id, "fixed");

    const stats = fed.getMonitorStats();
    expect(stats.manuallyResolved).toBe(1);
  });
});

// ── SCF14: Production Workflow ─────────────────────────────

describe("SCF14: Production workflow", () => {
  it("full lifecycle: register → detect → repair → verify", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed._setRepairExecutor(async () => {});

    const v1 = makeMigration({ version: 1, checksum: "base_migration_v1" });
    const v2 = makeMigration({ version: 2, checksum: "add_indexes_v2" });
    const v3 = makeMigration({ version: 3, checksum: "audit_columns_v3" });

    // Step 1: Register 3 shards — 2 up-to-date, 1 behind
    fed.registerShard(makeSnapshot({ shardId: "us-east-a", version: 3, migrations: [v1, v2, v3] }));
    fed.registerShard(makeSnapshot({ shardId: "us-east-b", version: 3, migrations: [v1, v2, v3] }));
    fed.registerShard(makeSnapshot({ shardId: "eu-west-c", version: 1, migrations: [v1] }));

    // Step 2: Detect drifts globally
    const drifts = await fed.detectAllDrifts();
    const euDrifts = drifts.filter((d) => d.shardId === "eu-west-c");
    expect(euDrifts.length).toBeGreaterThan(0);
    expect(euDrifts.some((d) => d.type === "missing_migration")).toBe(true);

    // Step 3: Plan repairs for all active drifts
    const active = fed.getActiveDrifts();
    const plans = active.map((d) => fed.planRepair(d));
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.driftId !== ""));
    expect(plans.every((p) => p.action.length > 0));

    // Step 4: Execute auto-repair for automatable drifts
    const repairs = await fed.autoRepair();
    expect(repairs.every((r) => r.success)).toBe(true);

    // Step 5: Verify no active drifts remain
    expect(fed.getActiveDrifts()).toEqual([]);
  });

  it("coordinated migration across 4 shards with canary", () => {
    const fed = new SchemaFederator();
    fed.registerShard(makeSnapshot({ shardId: "canary" }));
    fed.registerShard(makeSnapshot({ shardId: "batch-1" }));
    fed.registerShard(makeSnapshot({ shardId: "batch-2" }));
    fed.registerShard(makeSnapshot({ shardId: "batch-3" }));

    const plan = makePlan({ currentVersion: 2, targetVersion: 3 });
    const coord = fed.startCoordinatedMigration(plan, "canary");

    expect(coord.shardIds).toHaveLength(4);
    expect(coord.canaryShardId).toBe("canary");
    expect(coord.mode).toBe("canary");
    expect(coord.state).toBe("preparing");

    // Canary succeeds
    fed.reportShardResult(coord.id, { shardId: "canary", version: 3, success: true, durationMs: 50 });
    expect(coord.state).toBe("rolling_out");

    // Batch 1-3 succeed
    fed.reportShardResult(coord.id, { shardId: "batch-1", version: 3, success: true, durationMs: 80 });
    fed.reportShardResult(coord.id, { shardId: "batch-2", version: 3, success: true, durationMs: 90 });
    fed.reportShardResult(coord.id, { shardId: "batch-3", version: 3, success: true, durationMs: 75 });

    // All 4 done + all success = verifying
    expect(coord.state).toBe("verifying");
  });

  it("production drift: checksum + missing migrations in multi-region cluster", async () => {
    const fed = new SchemaFederator();
    fed._setReferenceStrategy("primary");
    fed._setRepairExecutor(async () => {});

    const base = makeMigration({ version: 1, checksum: "prod-v1" });
    const featA = makeMigration({ version: 2, checksum: "feature-a" });
    const featB = makeMigration({ version: 3, checksum: "feature-b" });
    const corruptedChecksum = makeMigration({ version: 2, checksum: "feature-a-CORRUPTED" });

    // Primary region (reference)
    fed.registerShard(makeSnapshot({ shardId: "us-primary", version: 3, migrations: [base, featA, featB] }));
    // Secondary region - missing featB
    fed.registerShard(makeSnapshot({ shardId: "us-replica", version: 2, migrations: [base, featA] }));
    // EU region - has corrupted v2 checksum
    fed.registerShard(makeSnapshot({ shardId: "eu-replica", version: 2, migrations: [base, corruptedChecksum] }));

    const allDrifts = await fed.detectAllDrifts();
    const usDrifts = allDrifts.filter((d) => d.shardId === "us-replica");
    const euDrifts = allDrifts.filter((d) => d.shardId === "eu-replica");

    expect(usDrifts.some((d) => d.type === "missing_migration")).toBe(true);
    expect(euDrifts.some((d) => d.type === "checksum_divergence")).toBe(true);

    // Only missing_migration is automatable; checksum_divergence stays unresolved
    const repaired = await fed.autoRepair();
    expect(repaired.length).toBeGreaterThan(0);
    expect(repaired.every((r) => r.success)).toBe(true);

    // Checksum divergence still active
    const stillActive = fed.getActiveDrifts();
    expect(stillActive.some((d) => d.type === "checksum_divergence")).toBe(true);
  });
});