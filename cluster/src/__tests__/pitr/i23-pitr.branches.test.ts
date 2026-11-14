/**
 * PITRManager — boundary branch coverage
 *
 * Complements i23-pitr.test.ts with the remaining branches:
 * compressed-snapshot restore (decompressSnapshot), the timestamp/sort
 * tiebreaks, null-safe fallbacks for un-initialized shards, and the
 * `?? []`/`?? 0` defaults across query/restore helpers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PITRManager } from "../../pitr/PITRManager";
import type { WALEntry } from "../../pitr/PITRManager";

function makeWAL(shardId: string, index: number, data: string, ts = 0): WALEntry {
  return { entryId: `wal-${shardId}-${index}`, shardId, index, term: 1, data, timestamp: ts };
}

describe("PITRManager — branch completion", () => {
  let pitr: PITRManager;

  beforeEach(() => {
    pitr = new PITRManager();
  });

  it("recordWAL falls back to Date.now() when timestamp is absent", () => {
    pitr.enable("s1");
    const before = Date.now();
    pitr.recordWAL({ entryId: "w", shardId: "s1", index: 1, term: 1, data: "a=1", timestamp: 0 });
    // timestamp 0 is falsy -> replaced with Date.now()
    const recorded = (pitr as any).walEntries.get("s1")[0];
    expect(recorded.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("restore uses decompressSnapshot when checkpoint is compressed", async () => {
    const pitrCompressed = new PITRManager({ compressSnapshots: true });
    pitrCompressed.enable("s1");
    const cp = pitrCompressed.createCheckpoint("s1", 10, 1, Buffer.from("k=v"));
    expect(cp.compressed).toBe(true);
    const result = await pitrCompressed.restore("s1", cp.timestamp);
    expect(result.restoredData).toBe("k=v");
  });

  it("getCheckpoints tiebreaks equal timestamps by snapshotIndex desc", () => {
    pitr.enable("s1");
    const t = Date.now();
    // Inject two checkpoints with identical timestamp but different index.
    (pitr as any).checkpoints.set("s1", [
      { checkpointId: "a", shardId: "s1", snapshotIndex: 1, snapshotTerm: 1, snapshotData: Buffer.from(""), timestamp: t, compressed: false },
      { checkpointId: "b", shardId: "s1", snapshotIndex: 5, snapshotTerm: 1, snapshotData: Buffer.from(""), timestamp: t, compressed: false },
    ]);
    const cps = pitr.getCheckpoints("s1");
    expect(cps[0].snapshotIndex).toBe(5);
    expect(cps[1].snapshotIndex).toBe(1);
  });

  it("getRPO returns 0 when no checkpoint has ever been taken", () => {
    pitr.enable("s1");
    expect(pitr.getRPO("s1")).toBe(0);
  });

  it("trimWALBeforeIndex and retention are no-ops for un-initialized shard", () => {
    // private helpers — exercised via public createCheckpoint/recordWAL on a
    // shard with no WAL map entry, but simpler: assert no throw on missing map.
    expect(() => (pitr as any).trimWALBeforeIndex("ghost", 0)).not.toThrow();
    expect(() => (pitr as any).enforceWALRetention("ghost")).not.toThrow();
  });

  it("getWALCountSinceLastCheckpoint returns WAL count when no checkpoints", () => {
    pitr.enable("s1");
    pitr.recordWAL(makeWAL("s1", 1, "a=1", Date.now()));
    pitr.recordWAL(makeWAL("s1", 2, "b=2", Date.now()));
    expect(pitr.getWALCountSinceLastCheckpoint("s1")).toBe(2);
  });

  it("removeWALTrims entries at or below checkpoint index on restore path", async () => {
    pitr.enable("s1");
    const cp = pitr.createCheckpoint("s1", 10, 1, Buffer.from("base=ok"));
    // record WAL with higher index to ensure replay filter has entries
    pitr.recordWAL(makeWAL("s1", 11, "x=1", cp.timestamp + 1000));
    const result = await pitr.restore("s1", cp.timestamp + 1000);
    expect(result.walEntriesReplayed).toBe(1);
  });

  it("createCheckpoint on non-enabled shard materializes via ?? []", () => {
    // L170 `?? []` — checkpoints map has no entry yet.
    const cp = pitr.createCheckpoint("ghost", 1, 1, Buffer.from("g=v"));
    expect(cp.shardId).toBe("ghost");
    expect(pitr.getCheckpoints("ghost")).toHaveLength(1);
  });

  it("restore on non-enabled shard triggers ?? [] then throws no checkpoints", async () => {
    // L205 `?? []` — checkpoints map returns undefined, size 0, then throw.
    await expect(pitr.restore("ghost", Date.now())).rejects.toThrow("No checkpoints");
  });

  it("getWALCountSinceLastCheckpoint on non-enabled shard returns 0 via ?? []", () => {
    // L268/L269 `?? []` — both maps return undefined.
    expect(pitr.getWALCountSinceLastCheckpoint("ghost")).toBe(0);
  });

  it("getRPO on non-enabled shard returns 0 via ?? []", () => {
    // L285 `?? 0` — lastCheckpointTime returns undefined.
    expect(pitr.getRPO("ghost")).toBe(0);
  });
});
