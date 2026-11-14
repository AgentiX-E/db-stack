/**
 * SchemaFederator — branch-completion tests.
 *
 * Targets the boundary branches the I36 suite leaves implicit:
 *   - detectAllDrifts (and detectSubset) when no reference snapshot resolves
 *   - executeRepair when the executor throws a non-Error value (`?? String`)
 *   - reportShardResult / pauseCoordination / resumeCoordination on unknown ids
 *   - resumeCoordination on a non-"paused" state
 *   - startMonitor when a timer is already running (re-arming)
 *   - _getReference "canonical" with an unset canonicalShardId, and the default
 *     case for an unrecognized strategy
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SchemaFederator } from "../impl/SchemaFederator.js";

function snapshot(shardId: string, version: number) {
  return { shardId, version, migrations: [], chainChecksum: "", capturedAt: Date.now() };
}

describe("SCF-branch: missing reference", () => {
  let fed: SchemaFederator;
  beforeEach(() => { fed = new SchemaFederator(); });

  it("detectAllDrifts returns [] when the canonical shard is unset", async () => {
    fed.registerShard(snapshot("s1", 1));
    fed.registerShard(snapshot("s2", 2));
    fed._setReferenceStrategy("canonical");
    // canonicalShardId was never set → reference resolves to undefined.
    expect(await fed.detectAllDrifts()).toEqual([]);
  });
});

describe("SCF-branch: repair executor throws non-Error", () => {
  let fed: SchemaFederator;
  beforeEach(() => { fed = new SchemaFederator(); });

  it("stringifies a non-Error rejection via `?? String(err)`", async () => {
    fed.registerShard(snapshot("s1", 1));
    fed.registerShard(snapshot("s2", 2));
    fed._setReferenceStrategy("primary");
    const drifts = await fed.detectAllDrifts();

    // Attach an executor that throws a bare string (not an Error instance).
    fed._setRepairExecutor(async () => {
      throw "raw-string-failure";
    });

    const repair = fed.planRepair(drifts[0]!);
    const result = await fed.executeRepair(repair);
    expect(result.success).toBe(false);
    expect(result.error).toBe("raw-string-failure");
  });
});

describe("SCF-branch: coordination unknown ids", () => {
  let fed: SchemaFederator;
  beforeEach(() => { fed = new SchemaFederator(); });

  it("reportShardResult silently ignores an unknown coordination", () => {
    expect(() => fed.reportShardResult("nope", { shardId: "s1", version: 1, success: true, durationMs: 1 }))
      .not.toThrow();
  });

  it("pauseCoordination throws for an unknown coordination", () => {
    expect(() => fed.pauseCoordination("nope")).toThrow("not found");
  });

  it("resumeCoordination throws for an unknown coordination", () => {
    expect(() => fed.resumeCoordination("nope")).toThrow("not found");
  });

  it("resumeCoordination throws when not paused", () => {
    const coord = fed.startCoordinatedMigration({ currentVersion: 0, targetVersion: 1, pending: [] }, "all");
    // A freshly started coordination is in "preparing", not "paused".
    expect(() => fed.resumeCoordination(coord.id)).toThrow("Cannot resume");
  });
});

describe("SCF-branch: monitor re-arm", () => {
  it("stopMonitor is called before re-arming an existing timer", () => {
    const fed = new SchemaFederator();
    fed.startMonitor({ scanIntervalMs: 3600_000 });
    const first = (fed as any).monitorTimer;
    fed.startMonitor({ scanIntervalMs: 3600_000 });
    const second = (fed as any).monitorTimer;
    // Re-arming replaced the timer (old one was cleared).
    expect(second).not.toBe(first);
    fed.stopMonitor();
  });
});

describe("SCF-branch: reference strategy fallbacks", () => {
  it("canonical without a nominated shard yields undefined", () => {
    const fed = new SchemaFederator();
    fed.registerShard(snapshot("s1", 1));
    fed._setReferenceStrategy("canonical");
    expect((fed as any)._getReference()).toBeUndefined();
  });

  it("an unrecognized strategy yields undefined (default case)", () => {
    const fed = new SchemaFederator();
    fed.registerShard(snapshot("s1", 1));
    fed._setReferenceStrategy("does-not-exist" as any);
    expect((fed as any)._getReference()).toBeUndefined();
  });
});
