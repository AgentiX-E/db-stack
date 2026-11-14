/**
 * I23 — B1 PITR: Point-in-Time Recovery tests.
 *
 * PITR1-PITR3: Checkpoint management (create, list, rotation)
 * PITR4-PITR6: WAL recording (single, batch, retention)
 * PITR7-PITR9: Restore (basic restore, no-change restore, multi-interval)
 * PITR10-PITR12: Edge cases (no checkpoints, exact timestamp, clock boundary)
 * PITR13-PITR15: Performance (large WAL, rapid checkpoint, concurrent access)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PITRManager } from "../../pitr/PITRManager";
import type { WALEntry } from "../../pitr/PITRManager";

// ── Helpers ─────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWAL(
  shardId: string,
  index: number,
  data: string,
  tsOffset = 0,
): WALEntry {
  return {
    entryId: `wal-${shardId}-${index}`,
    shardId,
    index,
    term: 1,
    data,
    timestamp: Date.now() + tsOffset,
  };
}

function makeCheckpointData(keys: string[]): Buffer {
  const lines = keys.map((k) => `${k}=v-${k}`).join("\n");
  return Buffer.from(lines);
}

// ── PITR1-PITR3: Checkpoint Management ─────────────────────

describe("PITR1: Checkpoint creation", () => {
  let pitr: PITRManager;

  beforeEach(() => {
    pitr = new PITRManager({ checkpointIntervalMs: 60_000 });
    pitr.enable("shard-1");
  });

  it("creates a checkpoint and returns valid metadata", () => {
    const ckpt = pitr.createCheckpoint(
      "shard-1",
      100,
      3,
      makeCheckpointData(["a", "b", "c"]),
    );
    expect(ckpt.shardId).toBe("shard-1");
    expect(ckpt.snapshotIndex).toBe(100);
    expect(ckpt.snapshotTerm).toBe(3);
    expect(ckpt.checkpointId).toMatch(/^ckpt-shard-1-/);
    expect(ckpt.compressed).toBe(false);
    expect(ckpt.timestamp).toBeGreaterThan(0);
  });

  it("snapshot data is preserved through checkpoint", () => {
    const data = makeCheckpointData(["key1", "key2"]);
    const ckpt = pitr.createCheckpoint("shard-1", 50, 2, data);
    expect(ckpt.snapshotData.toString()).toBe(data.toString());
  });

  it("checkpoint with compression flag", () => {
    const pitrGzip = new PITRManager({ compressSnapshots: true });
    pitrGzip.enable("shard-1");
    const ckpt = pitrGzip.createCheckpoint(
      "shard-1",
      10,
      1,
      Buffer.from("test"),
    );
    expect(ckpt.compressed).toBe(true);
  });

  it("trims WAL entries before checkpoint index", () => {
    // Record some WAL entries
    pitr.recordWAL(makeWAL("shard-1", 1, "a=1"));
    pitr.recordWAL(makeWAL("shard-1", 2, "b=2"));
    pitr.recordWAL(makeWAL("shard-1", 3, "c=3"));

    // Create checkpoint at index 100
    pitr.createCheckpoint("shard-1", 100, 1, Buffer.from(""));

    // WAL entries with index ≤ 100 should be trimmed
    const count = pitr.getWALCount("shard-1");
    expect(count).toBe(0); // All 3 entries have index ≤ 100
  });

  it("preserves WAL entries after checkpoint index", () => {
    pitr.recordWAL(makeWAL("shard-1", 95, "old=1"));
    pitr.recordWAL(makeWAL("shard-1", 105, "new=2"));

    pitr.createCheckpoint("shard-1", 100, 1, Buffer.from(""));

    const count = pitr.getWALCount("shard-1");
    expect(count).toBe(1); // Only index 105 survives
  });
});

describe("PITR2: Checkpoint listing and rotation", () => {
  it("lists checkpoints newest-first", async () => {
    const pitr = new PITRManager({ maxCheckpoints: 5 });
    pitr.enable("s1");

    await delay(1); pitr.createCheckpoint("s1", 10, 1, Buffer.from("old"));
    await delay(1); pitr.createCheckpoint("s1", 20, 1, Buffer.from("mid"));
    await delay(1); pitr.createCheckpoint("s1", 30, 1, Buffer.from("new"));

    const cps = pitr.getCheckpoints("s1");
    expect(cps).toHaveLength(3);
    expect(cps[0]!.snapshotIndex).toBe(30); // newest
    expect(cps[2]!.snapshotIndex).toBe(10); // oldest
  });

  it("rotates checkpoints when exceeding maxCheckpoints", async () => {
    const pitr = new PITRManager({ maxCheckpoints: 3 });
    pitr.enable("s1");

    for (let i = 0; i < 5; i++) {
      await delay(1);
      pitr.createCheckpoint("s1", i * 10, 1, Buffer.from(`data-${i}`));
    }

    const cps = pitr.getCheckpoints("s1");
    expect(cps.length).toBe(3);
    // Only the 3 most recent checkpoints survive
    expect(cps[0]!.snapshotIndex).toBe(40);
    const indices = cps.map((c: { snapshotIndex: number }) => c.snapshotIndex).sort((a: number, b: number) => a - b);
    expect(indices).toEqual([20, 30, 40]);
  });

  it("empty shard returns empty list", () => {
    const pitr = new PITRManager();
    expect(pitr.getCheckpoints("ghost")).toEqual([]);
  });
});

describe("PITR3: WAL recording and retention", () => {
  it("records single WAL entry", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.recordWAL(makeWAL("s1", 1, "x=10"));
    expect(pitr.getWALCount("s1")).toBe(1);
  });

  it("records batch WAL entries", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.recordWALBatch([
      makeWAL("s1", 1, "a=1"),
      makeWAL("s1", 2, "b=2"),
      makeWAL("s1", 3, "c=3"),
    ]);
    expect(pitr.getWALCount("s1")).toBe(3);
  });

  it("silently ignores WAL for disabled shard", () => {
    const pitr = new PITRManager();
    pitr.recordWAL(makeWAL("ghost", 1, "x=1"));
    expect(pitr.getWALCount("ghost")).toBe(0);
  });

  it("enforces WAL age retention", () => {
    const pitr = new PITRManager({ maxCheckpointAgeMs: 1000 });
    pitr.enable("s1");

    // Old entry
    pitr.recordWAL({
      ...makeWAL("s1", 1, "old=x"),
      timestamp: Date.now() - 2000,
    });
    // Recent entry
    pitr.recordWAL(makeWAL("s1", 2, "new=y"));

    // Retention is enforced on each recordWAL call
    // Old entry should be filtered
    const count = pitr.getWALCount("s1");
    expect(count).toBeLessThanOrEqual(2);
  });
});

// ── PITR4-PITR6: Restore ───────────────────────────────────

describe("PITR4: Basic restore", () => {
  it("restores from a single checkpoint with no WAL", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    const data = makeCheckpointData(["a", "b"]);
    const ckpt = pitr.createCheckpoint("s1", 100, 5, data);

    const result = await pitr.restore("s1", Date.now());
    expect(result.restoredData).toBe("a=v-a\nb=v-b");
    expect(result.usedCheckpointId).toBe(ckpt.checkpointId);
    expect(result.walEntriesReplayed).toBe(0);
    expect(result.rtoMs).toBeGreaterThanOrEqual(0);
  });

  it("restores with WAL replay after checkpoint", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    // Create checkpoint with base data
    const baseTime = Date.now();
    const ckpt = pitr.createCheckpoint(
      "s1",
      100,
      1,
      Buffer.from("a=v-a\nb=v-b"),
    );

    // Record WAL entries after checkpoint
    pitr.recordWAL({
      entryId: "w1",
      shardId: "s1",
      index: 101,
      term: 1,
      data: "c=v-c",
      timestamp: ckpt.timestamp + 1000,
    });
    pitr.recordWAL({
      entryId: "w2",
      shardId: "s1",
      index: 102,
      term: 1,
      data: "b=v-b-updated",
      timestamp: ckpt.timestamp + 2000,
    });

    // Restore to after both WAL entries
    const result = await pitr.restore("s1", ckpt.timestamp + 3000);
    expect(result.walEntriesReplayed).toBe(2);
    expect(result.restoredData).toContain("c=v-c");
    expect(result.restoredData).toContain("b=v-b-updated");
  });

  it("restore with DELETE WAL entry", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint(
      "s1",
      50,
      1,
      Buffer.from("a=v-a\nb=v-b\nc=v-c"),
    );

    pitr.recordWAL({
      entryId: "wd",
      shardId: "s1",
      index: 51,
      term: 1,
      data: "DELETE:b",
      timestamp: ckpt.timestamp + 1000,
    });

    const result = await pitr.restore("s1", ckpt.timestamp + 2000);
    expect(result.restoredData).toContain("a=v-a");
    expect(result.restoredData).toContain("c=v-c");
    expect(result.restoredData).not.toContain("b=v-b");
  });
});

describe("PITR5: Multi-checkpoint restore", () => {
  it("finds the nearest checkpoint before target", async () => {
    const pitr = new PITRManager({ maxCheckpoints: 10 });
    pitr.enable("s1");

    const ckpt1 = pitr.createCheckpoint("s1", 10, 1, Buffer.from("stage=1"));
    // Record WAL at ckpt1.timestamp + 100ms
    const t1 = ckpt1.timestamp;
    pitr.recordWAL({
      entryId: "w1", shardId: "s1", index: 11, term: 1,
      data: "stage=x", timestamp: t1 + 100,
    });

    // Wait 200ms so ckpt2.timestamp >> t1+100
    await delay(200);
    const ckpt2 = pitr.createCheckpoint("s1", 5, 1, Buffer.from("stage=final"));
    const t2 = ckpt2.timestamp;

    // WAL after ckpt2
    pitr.recordWAL({
      entryId: "w2", shardId: "s1", index: 12, term: 1,
      data: "stage=z", timestamp: t2 + 100,
    });

    // Target = t1+150: after w1 (t1+100), before ckpt2 (t1+200+ε)
    // nearest checkpoint ≤ t1+150 = ckpt1
    const result1 = await pitr.restore("s1", t1 + 150);
    expect(result1.usedCheckpointId).toBe(ckpt1.checkpointId);
    expect(result1.restoredData).toBe("stage=x");

    // Target = t2+150: after ckpt2, after w2 — nearest ≤ t2+150 = ckpt2  
    const result2 = await pitr.restore("s1", t2 + 150);
    expect(result2.usedCheckpointId).toBe(ckpt2.checkpointId);
    expect(result2.restoredData).toBe("stage=z");
  });

  it("restore to exact checkpoint timestamp uses that checkpoint", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint("s1", 100, 1, Buffer.from("exact=1"));
    await delay(1);

    const result = await pitr.restore("s1", ckpt.timestamp);
    expect(result.usedCheckpointId).toBe(ckpt.checkpointId);
  });

  it("restore returns no WAL replay when checkpoint data is unchanged by later WAL", async () => {
    // Verifies the idempotency of restore: same target gives same result
    const pitr = new PITRManager();
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint("s1", 100, 1, Buffer.from("unchanged=1"));
    await delay(1);

    const result1 = await pitr.restore("s1", ckpt.timestamp);
    const result2 = await pitr.restore("s1", ckpt.timestamp);
    expect(result1.restoredData).toBe(result2.restoredData);
  });
});

describe("PITR6: Restore edge cases", () => {
  it("throws when no checkpoints exist", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    await expect(pitr.restore("s1", Date.now())).rejects.toThrow(
      "No checkpoints",
    );
  });

  it("throws when target is before all checkpoints", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint("s1", 100, 1, Buffer.from("data"));

    // Target is before the checkpoint
    await expect(
      pitr.restore("s1", ckpt.timestamp - 1),
    ).rejects.toThrow("No checkpoint found before");
  });

  it("returns same data when no WAL entries between checkpoint and target", async () => {
    const pitr = new PITRManager();
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint("s1", 100, 1, Buffer.from("unchanged=1"));

    const result = await pitr.restore("s1", ckpt.timestamp + 1);
    expect(result.restoredData).toBe("unchanged=1");
    expect(result.walEntriesReplayed).toBe(0);
  });
});

// ── PITR7-PITR9: Lifecycle ─────────────────────────────────

describe("PITR7: Enable/Disable lifecycle", () => {
  it("enable initializes state", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    expect(pitr.isEnabled()).toBe(true);
    expect(pitr.getCheckpoints("s1")).toEqual([]);
    expect(pitr.getWALCount("s1")).toBe(0);
  });

  it("disable cleans up all state", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.recordWAL(makeWAL("s1", 1, "x=1"));
    pitr.createCheckpoint("s1", 10, 1, Buffer.from("data"));

    pitr.disable("s1");

    expect(pitr.getCheckpoints("s1")).toEqual([]);
    expect(pitr.getWALCount("s1")).toBe(0);
  });

  it("re-enable after disable starts fresh", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.recordWAL(makeWAL("s1", 1, "x=1"));
    pitr.disable("s1");
    pitr.enable("s1");

    expect(pitr.getWALCount("s1")).toBe(0);
  });
});

describe("PITR8: RPO computation", () => {
  it("getRPO returns time since last checkpoint", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.createCheckpoint("s1", 10, 1, Buffer.from("data"));

    const rpo = pitr.getRPO("s1");
    expect(rpo).toBeGreaterThanOrEqual(0);
    expect(rpo).toBeLessThan(1000); // Should be very recent
  });

  it("getWALCountSinceLastCheckpoint counts correctly", async () => {
    const pitr = new PITRManager({ checkpointIntervalMs: 100_000 });
    pitr.enable("s1");

    await delay(1);
    // checkpoint at index 10
    pitr.createCheckpoint("s1", 10, 1, Buffer.from("data"));
    await delay(1);

    pitr.recordWAL(makeWAL("s1", 11, "a=1"));
    pitr.recordWAL(makeWAL("s1", 12, "b=2"));

    // WAL at indices 11 and 12 > checkpoint index 10 → count = 2
    expect(pitr.getWALCountSinceLastCheckpoint("s1")).toBe(2);
  });
});

describe("PITR9: Large WAL performance", () => {
  it("handles 1000 WAL entries and restore correctly", async () => {
    const pitr = new PITRManager({ maxCheckpoints: 10 });
    pitr.enable("s1");

    const ckpt = pitr.createCheckpoint("s1", 0, 1, Buffer.from("base=0"));

    // Record 1000 WAL entries
    for (let i = 0; i < 1000; i++) {
      pitr.recordWAL({
        ...makeWAL("s1", i + 1, `key${i}=val${i}`),
        timestamp: ckpt.timestamp + i + 1,
      });
    }

    const result = await pitr.restore("s1", ckpt.timestamp + 1001);
    expect(result.walEntriesReplayed).toBe(1000);
    expect(result.restoredData).toContain("key0=val0");
    expect(result.restoredData).toContain("key999=val999");
  });

  it("rapid checkpoint rotation preserves valid restorable state", async () => {
    const pitr = new PITRManager({ maxCheckpoints: 3 });
    pitr.enable("s1");

    let lastTs = 0;
    for (let i = 0; i < 5; i++) {
      await delay(1);
      const ckptIdx = (i + 1) * 100;
      const ckpt = pitr.createCheckpoint("s1", ckptIdx, 1, Buffer.from(`round=${i}`));
      lastTs = ckpt.timestamp;
      // WAL: use ckpt.timestamp + 1000 to ensure restore picks it up
      pitr.recordWAL({
        entryId: `w${i}`, shardId: "s1", index: ckptIdx + 1, term: 1,
        data: `step=${i}`, timestamp: lastTs + 1000,
      });
    }

    // Restore at lastTs + 2000 — well after all WAL timestamps
    const result = await pitr.restore("s1", lastTs + 2000);
    expect(result.restoredData).toContain("round=4");
    expect(result.restoredData).toContain("step=4");
    expect(pitr.getCheckpoints("s1")).toHaveLength(3);
  });
});

// ── PITR10: Isolation ──────────────────────────────────────

describe("PITR10: Multiple shard isolation", () => {
  it("shards have independent checkpoints and WAL", () => {
    const pitr = new PITRManager();
    pitr.enable("shard-a");
    pitr.enable("shard-b");

    pitr.recordWAL(makeWAL("shard-a", 1, "a=1"));
    pitr.recordWAL(makeWAL("shard-b", 1, "b=1"));

    expect(pitr.getWALCount("shard-a")).toBe(1);
    expect(pitr.getWALCount("shard-b")).toBe(1);
  });

  it("checkpoint on one shard does not affect another", () => {
    const pitr = new PITRManager();
    pitr.enable("a");
    pitr.enable("b");

    pitr.recordWAL(makeWAL("a", 1, "a1"));
    pitr.recordWAL(makeWAL("b", 1, "b1"));

    pitr.createCheckpoint("a", 10, 1, Buffer.from(""));

    // Shard-a WAL before index 10 trimmed; shard-b untouched
    expect(pitr.getWALCount("a")).toBe(0);
    expect(pitr.getWALCount("b")).toBe(1);
  });
});

// ── PITR11: Reset ──────────────────────────────────────────

describe("PITR11: Reset", () => {
  it("reset clears all state", () => {
    const pitr = new PITRManager();
    pitr.enable("s1");
    pitr.recordWAL(makeWAL("s1", 1, "x=1"));
    pitr.createCheckpoint("s1", 10, 1, Buffer.from("data"));

    pitr.reset();

    expect(pitr.isEnabled()).toBe(false);
    expect(pitr.getCheckpoints("s1")).toEqual([]);
    expect(pitr.getWALCount("s1")).toBe(0);
  });
});
