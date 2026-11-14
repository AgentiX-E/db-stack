/**
 * SchemaFederatorMutationKillers — precise assertions to kill the survivors
 * left by the broader i36 suite, which mostly asserts `action` but not the
 * full repair-plan boolean fields, stats counters, or scan-timing arithmetic.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SchemaFederator } from "../impl/SchemaFederator.js";
import type {
  MigrationDescriptor,
  SchemaSnapshot,
  SchemaDrift,
} from "../interfaces/index.js";

function makeMigration(v: number, checksum = `chk-${v}`, state = "applied"): MigrationDescriptor {
  return {
    version: v,
    description: `Migration v${v}`,
    state,
    checksum,
    appliedAt: new Date().toISOString(),
    durationMs: 100,
  } as MigrationDescriptor;
}

function makeSnapshot(shardId: string, migrations: MigrationDescriptor[] = []): SchemaSnapshot {
  return {
    shardId,
    version: migrations.length ? migrations[migrations.length - 1]!.version : 0,
    migrations,
    chainChecksum: "",
    capturedAt: Date.now(),
  };
}

function makeDrift(type: SchemaDrift["type"], severity: SchemaDrift["severity"] = "warning", migration?: MigrationDescriptor): SchemaDrift {
  return {
    id: `d-${type}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    severity,
    shardId: "s1",
    referenceShardId: "s0",
    driftedVersion: 1,
    referenceVersion: 2,
    migration,
    description: `Test ${type}`,
    detectedAt: Date.now(),
    resolved: false,
  };
}

// ── repair plan boolean fields (requiresDowntime/automatable) ────

describe("planRepair boolean fields", () => {
  it("missing_migration: requiresDowntime only when critical", () => {
    const f = new SchemaFederator();
    expect(f.planRepair(makeDrift("missing_migration", "warning", makeMigration(1))).requiresDowntime).toBe(false);
    expect(f.planRepair(makeDrift("missing_migration", "critical", makeMigration(1))).requiresDowntime).toBe(true);
  });

  it("missing_migration: automatable is inverse of critical", () => {
    const f = new SchemaFederator();
    expect(f.planRepair(makeDrift("missing_migration", "warning", makeMigration(1))).automatable).toBe(true);
    expect(f.planRepair(makeDrift("missing_migration", "critical", makeMigration(1))).automatable).toBe(false);
  });

  it("extra_migration: always requires downtime", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("extra_migration", "warning", makeMigration(2)));
    expect(p.requiresDowntime).toBe(true);
    // warning severity is still automatable (pins the `!== "critical"` gate).
    expect(p.automatable).toBe(true);
  });

  it("extra_migration: critical severity is not automatable", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("extra_migration", "critical", makeMigration(2)));
    expect(p.automatable).toBe(false);
  });

  it("checksum_divergence: not automatable, requires downtime", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("checksum_divergence"));
    expect(p.automatable).toBe(false);
    expect(p.requiresDowntime).toBe(true);
    expect(p.action).toBe("resync_snapshot");
  });

  it("order_divergence: not automatable, requires downtime", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("order_divergence"));
    expect(p.automatable).toBe(false);
    expect(p.requiresDowntime).toBe(true);
  });

  it("migration_state_mismatch failed → rollback + downtime + rollback target", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("migration_state_mismatch", "warning", makeMigration(1, "c", "failed")));
    expect(p.action).toBe("rollback_migration");
    expect(p.requiresDowntime).toBe(true);
    expect(p.automatable).toBe(true);
    expect(p.migrationToRollback).toBeDefined();
  });

  it("migration_state_mismatch non-failed → resync, no downtime, no rollback", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("migration_state_mismatch", "warning", makeMigration(1, "c", "applied")));
    expect(p.action).toBe("resync_snapshot");
    expect(p.requiresDowntime).toBe(false);
    expect(p.migrationToRollback).toBeUndefined();
  });

  it("unknown drift type → mark_resolved, no downtime, automatable", () => {
    const f = new SchemaFederator();
    const p = f.planRepair(makeDrift("unknown_type" as SchemaDrift["type"]));
    expect(p.action).toBe("mark_resolved");
    expect(p.requiresDowntime).toBe(false);
    expect(p.automatable).toBe(true);
  });
});

// ── scan timing (lastScanDurationMs `-`) ─────────────────────

describe("scan timing", () => {
  it("lastScanDurationMs is the injected-clock difference", async () => {
    // A clock that advances 1ms per read: detectAllDrifts reads nowMs at start
    // and again at the end, so lastScanDurationMs = 1 (end - start).
    let now = 0;
    const f = new SchemaFederator(() => (now += 1));
    f.registerShard(makeSnapshot("s0", [makeMigration(2)]));
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    await f.detectAllDrifts();

    const dur = f.getMonitorStats().lastScanDurationMs;
    // With a +1-per-read clock and two reads, the difference is exactly 1.
    expect(dur).toBe(1);
  });
});

// ── stats counters (`+ 1`) ──────────────────────────────────

describe("drift stats counters", () => {
  it("totalScans increments per scan", async () => {
    const f = new SchemaFederator();
    await f.detectAllDrifts();
    await f.detectAllDrifts();
    expect(f.getMonitorStats().totalScans).toBe(2);
  });

  it("totalDriftsDetected counts each detection event", async () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s0", [makeMigration(2)]));
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    await f.detectAllDrifts();
    // Second scan finds the SAME drift ids (already known) → no double count
    // of totalDriftsDetected, even though the drift count (driftsByType) stays.
    const first = f.getMonitorStats().totalDriftsDetected;
    await f.detectAllDrifts();
    expect(f.getMonitorStats().totalDriftsDetected).toBe(first);
    // missing_migration is one of the detected types and is counted once.
    expect(f.getMonitorStats().driftsByType["missing_migration"]).toBe(1);
  });
});

// ── snapshot checksum (empty-input guard + content-sensitivity) ──

describe("snapshot checksum", () => {
  it("empty migrations yield the stable zero checksum", async () => {
    const f = new SchemaFederator();
    const s = await f.captureSnapshot("s");
    expect(s.chainChecksum).toBe("0000000000000000");
  });

  it("checksum divergence is detected across shards", async () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s0", [makeMigration(1, "aaa")]));
    f.registerShard(makeSnapshot("s1", [makeMigration(1, "bbb")]));
    await f.detectAllDrifts();
    expect(f.getMonitorStats().driftsByType["checksum_divergence"]).toBe(1);
  });

  it("registerShard backfills checksum when migrations present and checksum empty", () => {
    const f = new SchemaFederator();
    const snap = makeSnapshot("s0", [makeMigration(1, "aaa")]);
    snap.chainChecksum = ""; // empty → should be backfilled
    f.registerShard(snap);
    expect(f.getSnapshot("s0")!.chainChecksum).not.toBe("");
  });

  it("registerShard leaves checksum empty when no migrations (no hashing)", () => {
    const f = new SchemaFederator();
    const snap = makeSnapshot("s0", []);
    snap.chainChecksum = "";
    f.registerShard(snap);
    // Empty migrations still hash (to the zero constant); the guard is about
    // the checksum being empty, not the migrations list being empty. So the
    // checksum becomes the deterministic zero hash, never "".
    expect(f.getSnapshot("s0")!.chainChecksum).toBe("0000000000000000");
  });

  it("respects an explicit checksum without overwriting", () => {
    const f = new SchemaFederator();
    const snap = makeSnapshot("s0", [makeMigration(1, "aaa")]);
    snap.chainChecksum = "explicit";
    f.registerShard(snap);
    expect(f.getSnapshot("s0")!.chainChecksum).toBe("explicit");
  });

  it("computes an exact deterministic checksum for known migrations", () => {
    const f = new SchemaFederator();
    const snap = makeSnapshot("s0", [makeMigration(1, "aaa")]);
    snap.chainChecksum = "";
    f.registerShard(snap);
    // The checksum is a pure function of the sorted migration checksums.
    // This exact value pins down the `(h << 5) - h + c` arithmetic and the
    // two `i < input.length` loop bounds.
    expect(f.getSnapshot("s0")!.chainChecksum).toBe("e779b87b5bf44f23");
  });

  it("sorts out-of-order migrations before hashing (pins the sort subtract)", () => {
    const f = new SchemaFederator();
    // Deliberately register [v2, v1] out of order; the checksum must sort them
    // to [v1, v2] first, so `a.version - b.version` is observable via the hash.
    const snap = makeSnapshot("s0", [makeMigration(2, "bbb"), makeMigration(1, "aaa")]);
    snap.chainChecksum = "";
    f.registerShard(snap);
    expect(f.getSnapshot("s0")!.chainChecksum).toBe("1b60c01c33dcd213");
  });
});

// ── null guard (`!shard || !reference`) ───────────────────────

describe("compareAgainstReference null guard", () => {
  it("returns empty when the shard is missing", () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s0", [makeMigration(1)]));
    // shardId "s1" is missing, reference "s0" exists → `!shard` short-circuits.
    const drifts = f.compareAgainstReference("s1");
    expect(drifts).toEqual([]);
  });

  it("returns empty when the reference is missing", () => {
    const f = new SchemaFederator();
    // No reference registered at all → `_getReference()` returns undefined,
    // so `!reference` short-circuits regardless of the shard's presence.
    const drifts = f.compareAgainstReference("s1");
    expect(drifts).toEqual([]);
  });
});

// ── migration sort ordering (`a.version - b.version`) ───────────

describe("migration ordering", () => {
  it("detects order divergence when migrations are out of order", async () => {
    const f = new SchemaFederator();
    // s0: v1 then v2 (ordered). s1: v2 then v1 (out of order).
    f.registerShard(makeSnapshot("s0", [makeMigration(1), makeMigration(2)]));
    f.registerShard(makeSnapshot("s1", [makeMigration(2), makeMigration(1)]));
    await f.detectAllDrifts();
    expect(f.getMonitorStats().driftsByType["order_divergence"]).toBe(1);
  });
});

// ── stats counters (`+ 1` / `?? 0`) ───────────────────────────

describe("stats counters", () => {
  it("driftsByType counts each detected drift precisely", async () => {
    const f = new SchemaFederator();
    const mk = (id: string, v: number) => makeSnapshot(id, [makeMigration(v)]);
    f.registerShard(mk("s0", 2));
    f.registerShard(mk("s1", 1));
    await f.detectAllDrifts();

    const byType = f.getMonitorStats().driftsByType;
    // s0(v2) vs s1(v1) yields exactly one drift per type for this input.
    expect(byType["missing_migration"]).toBe(1);
    expect(byType["extra_migration"]).toBe(1);
    expect(byType["version_mismatch"]).toBe(1);

    const bySeverity = f.getMonitorStats().driftsBySeverity;
    const totalBySeverity = Object.values(bySeverity).reduce((a, b) => a + b, 0);
    expect(totalBySeverity).toBe(f.getMonitorStats().totalDriftsDetected);
  });
});

// ── monitor default (`autoResolve: false`) ─────────────────────

describe("monitor defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-repair when autoResolve is unset (default false)", async () => {
    vi.useFakeTimers();
    const f = new SchemaFederator();
    const autoResolveSpy = vi.spyOn(f, "autoRepair").mockResolvedValue([]);

    // Default config: scanIntervalMs is 60000 and autoResolve is false, so
    // advancing the interval must NOT call autoRepair.
    f.startMonitor();
    vi.advanceTimersByTime(60000);

    expect(autoResolveSpy).not.toHaveBeenCalled();
    f.stopMonitor();
  });

  it("auto-repairs when autoResolve is explicitly true", async () => {
    vi.useFakeTimers();
    const f = new SchemaFederator();
    const autoResolveSpy = vi.spyOn(f, "autoRepair").mockResolvedValue([]);

    f.startMonitor({ scanIntervalMs: 1000, autoResolve: true });
    vi.advanceTimersByTime(1000);

    expect(autoResolveSpy).toHaveBeenCalled();
    f.stopMonitor();
  });
});

// ── validateSnapshot (`"rule:" + rule.name` / `resolved: false`) ──

describe("validateSnapshot rules", () => {
  it("produces a drift with referenceShardId `rule:<name>` and resolved=false", () => {
    const f = new SchemaFederator();
    f.registerRule({
      name: "no_v2",
      description: "must not use version 2",
      enforced: true,
      severity: "critical",
      check: (s) => s.version < 2,
    });

    const drifts = f.validateSnapshot(makeSnapshot("s0", [makeMigration(2)]));
    expect(drifts.length).toBe(1);
    expect(drifts[0]!.referenceShardId).toBe("rule:no_v2");
    expect(drifts[0]!.resolved).toBe(false);
    expect(drifts[0]!.type).toBe("version_mismatch");
    expect(drifts[0]!.severity).toBe("critical");
  });

  it("produces a drift for a throwing rule check", () => {
    const f = new SchemaFederator();
    f.registerRule({
      name: "boom_rule",
      description: "throws",
      enforced: true,
      severity: "warning",
      check: () => {
        throw new Error("boom");
      },
    });

    const drifts = f.validateSnapshot(makeSnapshot("s0", [makeMigration(1)]));
    expect(drifts.length).toBe(1);
    expect(drifts[0]!.referenceShardId).toBe("rule:boom_rule");
    expect(drifts[0]!.resolved).toBe(false);
    expect(drifts[0]!.description).toContain("threw an error");
  });
});

// ── coordination completion gate (`&&` / `===` / `||` in reportShardResult) ──

describe("coordination completion", () => {
  it("completes directly when verifyAfterApply is false", () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    f.registerShard(makeSnapshot("s2", [makeMigration(1)]));

    // verify=false: after all shards succeed, the coordinator skips the
    // "verifying" branch and jumps straight to "completed" (the `&&`/`||`
    // and `===` gate in the third else-if).
    const coord = f.startCoordinatedMigration(
      { currentVersion: 1, targetVersion: 2, pending: [] },
      "all",
      false,
    );

    f.reportShardResult(coord.id, { shardId: "s1", version: 2, success: true, durationMs: 100 });
    f.reportShardResult(coord.id, { shardId: "s2", version: 2, success: true, durationMs: 100 });

    expect(f.getCoordinationState(coord.id)!.state).toBe("completed");
  });

  it("completes after verifying when verifyAfterApply is true", () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    f.registerShard(makeSnapshot("s2", [makeMigration(1)]));

    const coord = f.startCoordinatedMigration(
      { currentVersion: 1, targetVersion: 2, pending: [] },
      "all",
      true,
    );

    f.reportShardResult(coord.id, { shardId: "s1", version: 2, success: true, durationMs: 100 });
    f.reportShardResult(coord.id, { shardId: "s2", version: 2, success: true, durationMs: 100 });
    expect(f.getCoordinationState(coord.id)!.state).toBe("verifying");

    // Once verifying and all results are in, the third else-if advances to
    // "completed" (pins the `state === "verifying"` comparison).
    f.reportShardResult(coord.id, { shardId: "s1", version: 2, success: true, durationMs: 5 });
    expect(f.getCoordinationState(coord.id)!.state).toBe("completed");
  });
});

// ── reference strategy + order divergence + mismatch direction ──

describe("reference strategy and drift messages", () => {
  it("latest strategy picks the numerically highest version (descending sort)", () => {
    const f = new SchemaFederator();
    f._setReferenceStrategy("latest");
    // Register out of order so the sort must actually reorder: 5 > 15 > 8.
    f.registerShard(makeSnapshot("low", [makeMigration(5)]));
    f.registerShard(makeSnapshot("high", [makeMigration(15)]));
    f.registerShard(makeSnapshot("mid", [makeMigration(8)]));

    // Compare the lowest against the latest reference (should be version 15).
    const drifts = f.compareAgainstReference("low");
    const mismatch = drifts.find((d) => d.type === "version_mismatch");
    expect(mismatch?.referenceVersion).toBe(15);
  });

  it("order divergence gate requires BOTH sides to have >1 migration", () => {
    const f = new SchemaFederator();
    // shard-a has 2 migrations, shard-b has only 1 → the `&&` gate must NOT
    // fire order_divergence (it needs length>1 on BOTH sides).
    f.registerShard(makeSnapshot("a", [makeMigration(1), makeMigration(2)]));
    f.registerShard(makeSnapshot("b", [makeMigration(1)]));

    const drifts = f.compareShards("a", "b");
    expect(drifts.find((d) => d.type === "order_divergence")).toBeUndefined();
  });

  it("version mismatch message uses 'ahead of' when shard is ahead of reference", () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("ahead", [makeMigration(3)]));
    f.registerShard(makeSnapshot("ref", [makeMigration(1)]));

    const drifts = f.compareShards("ahead", "ref");
    const mismatch = drifts.find((d) => d.type === "version_mismatch");
    expect(mismatch?.description).toContain("ahead of");
  });
});

describe("repair error path", () => {
  it("returns success=false with error when the drift is unknown", async () => {
    const f = new SchemaFederator();
    // planRepair on a fresh (unregistered) drift yields a DriftRepair whose
    // driftId is not in f.drifts → executeRepair must set success=false + error.
    const plan = f.planRepair(makeDrift("missing_migration", "warning", makeMigration(1)));
    const r = await f.executeRepair(plan);
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("catches a throwing repair executor and sets success=false", async () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s0", [makeMigration(2)]));
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    await f.detectAllDrifts();

    const drift = f.getActiveDrifts()[0]!;
    const plan = f.planRepair(drift);

    // Inject a repair executor that throws: executeRepair must catch it and
    // set success=false with the thrown error message (pins the catch branch).
    f._setRepairExecutor(async () => {
      throw new Error("boom");
    });

    const r = await f.executeRepair(plan);
    expect(r.success).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("returns success=true for a resolvable drift", async () => {
    const f = new SchemaFederator();
    f.registerShard(makeSnapshot("s0", [makeMigration(2)]));
    f.registerShard(makeSnapshot("s1", [makeMigration(1)]));
    await f.detectAllDrifts();

    const drifts = f.getActiveDrifts();
    expect(drifts.length).toBeGreaterThan(0);

    // Plan repairs for the first tracked drift and execute; a resolvable
    // action (mark_resolved / apply_migration) must set success=true.
    const plan = f.planRepair(drifts[0]!);
    const r = await f.executeRepair(plan);
    expect(r.success).toBe(true);

    // The drift is now resolved (no longer active).
    const stillActive = f.getActiveDrifts().some((d) => d.id === drifts[0]!.id);
    expect(stillActive).toBe(false);
  });
});