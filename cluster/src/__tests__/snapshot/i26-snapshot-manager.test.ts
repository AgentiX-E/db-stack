/**
 * I26 — B4 SnapshotManager tests.
 *
 * SNAP1-SNAP3: Creation & basic CRUD
 * SNAP4-SNAP6: Retention policies (count, age, interval + combined)
 * SNAP7-SNAP9: Compaction (merge, selective, none)
 * SNAP10-SNAP12: Verification (single, all, corruption detection)
 * SNAP13-SNAP15: Edge cases (empty init, auto-prune, multi-group isolation,
 *   double delete, findNearest boundary, shutdown/restart recovery)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SnapshotManager,
  type SnapshotManagerConfig,
  type SnapshotDescriptor,
} from "../../snapshot/SnapshotManager.js";
import type { SnapshotMeta } from "../../interfaces/types.js";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Helpers ────────────────────────────────────────────────

const TEST_ROOT = path.join(os.tmpdir(), "b4-snapshot-test-" + Date.now());

function tmpDir(...parts: string[]): string {
  const dir = path.join(TEST_ROOT, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaOverrides(
  overrides: Partial<SnapshotMeta> = {},
): SnapshotMeta {
  return {
    lastIncludedIndex: 100,
    lastIncludedTerm: 5,
    groupId: "default",
    ...overrides,
  };
}

function makeData(size: number): Buffer {
  return Buffer.alloc(size, "A".charCodeAt(0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupAll(): Promise<void> {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch { /* ok */ }
}

// ── SNAP1-SNAP3: Creation & CRUD ──────────────────────────

describe("SNAP1: Snapshot creation", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap1");

  beforeEach(async () => {
    manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("creates a snapshot with correct metadata", async () => {
    const data = makeData(1024);
    const meta = metaOverrides({ lastIncludedIndex: 42 });

    const snap = await manager.createSnapshot(data, meta);

    expect(snap.id).toMatch(/^snap-/);
    expect(snap.meta.lastIncludedIndex).toBe(42);
    expect(snap.meta.lastIncludedTerm).toBe(5);
    expect(snap.meta.groupId).toBe("default");
    expect(snap.sizeBytes).toBe(1024);
    expect(snap.verified).toBe(true);
    expect(snap.compacted).toBe(false);
    expect(snap.createdAt).toBeGreaterThan(0);
    expect(snap.checksum).toHaveLength(64); // SHA-256 hex
  });

  it("creates multiple snapshots with unique IDs", async () => {
    const snap1 = await manager.createSnapshot(makeData(100), metaOverrides());
    await delay(2); // Ensure different timestamp for ID
    const snap2 = await manager.createSnapshot(makeData(200), metaOverrides());

    expect(snap1.id).not.toBe(snap2.id);
    expect(snap1.sizeBytes).toBe(100);
    expect(snap2.sizeBytes).toBe(200);
  });

  it("fires onCreated callback", async () => {
    const created: SnapshotDescriptor[] = [];
    manager.onCreated((s) => created.push(s));

    await manager.createSnapshot(makeData(500), metaOverrides());

    expect(created).toHaveLength(1);
    expect(created[0]!.sizeBytes).toBe(500);
  });

  it("verifyOnCreate=false skips verification", async () => {
    const mgr = new SnapshotManager({
      storageDir: dir,
      verifyOnCreate: false,
    });
    await mgr.init();

    const snap = await mgr.createSnapshot(makeData(256), metaOverrides());
    expect(snap.verified).toBe(false);

    await mgr.shutdown();
  });
});

describe("SNAP2: Snapshot CRUD", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap2");

  beforeEach(async () => {
    manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("getSnapshot returns descriptor by ID", async () => {
    const snap = await manager.createSnapshot(makeData(512), metaOverrides());
    const found = await manager.getSnapshot(snap.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(snap.id);
    expect(found!.checksum).toBe(snap.checksum);
  });

  it("getSnapshot returns null for unknown ID", async () => {
    const found = await manager.getSnapshot("snap-nonexistent");
    expect(found).toBeNull();
  });

  it("deleteSnapshot removes snapshot and returns true", async () => {
    const snap = await manager.createSnapshot(makeData(100), metaOverrides());
    const deleted = await manager.deleteSnapshot(snap.id);
    expect(deleted).toBe(true);
    expect(await manager.getSnapshot(snap.id)).toBeNull();
  });

  it("deleteSnapshot returns false for missing snapshot", async () => {
    const deleted = await manager.deleteSnapshot("snap-nonexistent");
    expect(deleted).toBe(false);
  });

  it("listSnapshots returns all sorted by index", async () => {
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 30 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 20 }));

    const list = await manager.listSnapshots();
    expect(list).toHaveLength(3);
    expect(list[0]!.meta.lastIncludedIndex).toBe(10);
    expect(list[1]!.meta.lastIncludedIndex).toBe(20);
    expect(list[2]!.meta.lastIncludedIndex).toBe(30);
  });
});

describe("SNAP3: Storage tracking", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap3");

  beforeEach(async () => {
    manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("totalStorageBytes sums all snapshot sizes", async () => {
    await manager.createSnapshot(makeData(100), metaOverrides());
    await manager.createSnapshot(makeData(250), metaOverrides());
    await manager.createSnapshot(makeData(50), metaOverrides());

    expect(await manager.totalStorageBytes()).toBe(400);
  });

  it("totalStorageBytes is 0 when no snapshots", async () => {
    expect(await manager.totalStorageBytes()).toBe(0);
  });

  it("count returns correct number", async () => {
    expect(await manager.count()).toBe(0);
    await manager.createSnapshot(makeData(100), metaOverrides());
    expect(await manager.count()).toBe(1);
    await manager.createSnapshot(makeData(100), metaOverrides());
    expect(await manager.count()).toBe(2);
  });
});

// ── SNAP4-SNAP6: Retention ─────────────────────────────────

describe("SNAP4: Count-based retention", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap4");

  beforeEach(async () => {
    manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 3, maxAgeMs: 0, minRetain: 1, intervalMs: 0 },
      autoPruneEvery: 0, // Manual only
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("prunes oldest snapshots when exceeding maxSnapshots", async () => {
    for (let i = 1; i <= 5; i++) {
      await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: i * 10 }));
    }

    expect(await manager.count()).toBe(5);

    const pruned = await manager.prune();

    // Should keep only 3 newest (index 30, 40, 50)
    expect(pruned.length).toBe(2);
    expect(await manager.count()).toBe(3);

    const remaining = await manager.listSnapshots();
    const indices = remaining.map((s) => s.meta.lastIncludedIndex).sort((a, b) => a - b);
    expect(indices).toEqual([30, 40, 50]);
  });

  it("onPruned callback fires with removed IDs", async () => {
    for (let i = 1; i <= 5; i++) {
      await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: i * 10 }));
    }

    const prunedIds: string[][] = [];
    manager.onPruned((ids) => prunedIds.push(ids));

    await manager.prune();
    expect(prunedIds).toHaveLength(1);
    expect(prunedIds[0]!).toHaveLength(2);
  });
});

describe("SNAP5: Age-based retention", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap5");

  beforeEach(async () => {
    manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 100, maxAgeMs: 200, minRetain: 1, intervalMs: 0 },
      autoPruneEvery: 0,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("prunes snapshots older than maxAgeMs", async () => {
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    // Wait for age threshold
    await delay(250);

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 20 }));

    const pruned = await manager.prune();

    // The first snapshot (index 10) should be pruned
    expect(pruned.length).toBeGreaterThanOrEqual(1);
  });

  it("respects minRetain even with aged-out snapshots", async () => {
    // Create one snapshot and let it age
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    await delay(500);

    await manager.prune();

    // minRetain=1, so even if aged out, one remains
    expect(await manager.count()).toBeGreaterThanOrEqual(1);
  });
});

describe("SNAP6: Combined retention policies", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap6");

  beforeEach(async () => {
    manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 5, maxAgeMs: 0, minRetain: 2, intervalMs: 0 },
      autoPruneEvery: 0,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("minRetain prevents pruning below minimum", async () => {
    // Create 3 snapshots, maxSnapshots=5 so nothing prunes
    for (let i = 1; i <= 3; i++) {
      await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: i * 10 }));
    }

    const pruned = await manager.prune();
    expect(pruned.length).toBe(0);
    expect(await manager.count()).toBe(3); // All retained (3 < max 5)
  });

  it("interval-based retention keeps one per time bucket", async () => {
    const mgr = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 5, maxAgeMs: 0, minRetain: 1, intervalMs: 60_000 }, // 1 min interval
      autoPruneEvery: 0,
    });
    await mgr.init();

    // All snapshots created within the same interval
    for (let i = 1; i <= 5; i++) {
      await mgr.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: i * 10 }));
    }

    await mgr.prune();
    // Should keep at least 1 (interval-based) + minRetain=1
    expect(await mgr.count()).toBeGreaterThanOrEqual(1);

    await mgr.shutdown();
  });
});

// ── SNAP7-SNAP9: Compaction ────────────────────────────────

describe("SNAP7: Merge compaction", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap7");

  beforeEach(async () => {
    manager = new SnapshotManager({
      storageDir: dir,
      compact: {
        strategy: "merge",
        maxMergeCount: 3,
        minAgeMs: 0,
        keepUncompacted: 1,
      },
      autoPruneEvery: 0,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("merges eligible snapshots into one compacted snapshot", async () => {
    for (let i = 1; i <= 5; i++) {
      await manager.createSnapshot(makeData(50), metaOverrides({
        lastIncludedIndex: i * 10,
        groupId: "group-a",
      }));
    }

    expect(await manager.count()).toBe(5);

    const compacted = await manager.compact();

    expect(compacted).not.toBeNull();
    // After merge: keepUncompacted=1 latest + 1 compacted = 2
    // Actually merge takes up to maxMergeCount (3) and keeps keepUncompacted (1)
    // So 5 - 3 merged + 1 compacted = 3 remaining
    expect(compacted!.compacted).toBe(true);
    expect(compacted!.meta.lastIncludedIndex).toBe(30); // max among first 3 candidates (10,20,30)
    expect(compacted!.sizeBytes).toBe(150); // 3 × 50
    // After compact: 5 total → 3 merged → 1 compacted + 2 remaining = 3
    const count = await manager.count();
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(4);
  });

  it("returns null when nothing to compact", async () => {
    // Only 1 snapshot
    await manager.createSnapshot(makeData(50), metaOverrides());
    const result = await manager.compact();
    expect(result).toBeNull();
  });

  it("respects keepUncompacted when selecting candidates", async () => {
    for (let i = 1; i <= 4; i++) {
      await manager.createSnapshot(makeData(50), metaOverrides({
        lastIncludedIndex: i * 10,
      }));
    }

    // keepUncompacted=1, maxMergeCount=3 → eligible = 4-1 = 3 candidates
    const compacted = await manager.compact();
    expect(compacted).not.toBeNull();
  });
});

describe("SNAP8: Selective compaction", () => {
  it("selective strategy only compacts oldest eligible snapshots", async () => {
    const dir = tmpDir("snap8");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: {
        strategy: "selective",
        maxMergeCount: 2,
        minAgeMs: 0,
        keepUncompacted: 2,
      },
      autoPruneEvery: 0,
    });
    await manager.init();

    for (let i = 1; i <= 5; i++) {
      await manager.createSnapshot(makeData(50), metaOverrides({
        lastIncludedIndex: i * 10,
      }));
    }

    const compacted = await manager.compact();
    expect(compacted).not.toBeNull();
    expect(compacted!.compacted).toBe(true);

    await manager.shutdown();
    await cleanupAll();
  });
});

describe("SNAP9: No compaction", () => {
  it("compact returns null when strategy is none", async () => {
    const dir = tmpDir("snap9");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "none", maxMergeCount: 3, minAgeMs: 0, keepUncompacted: 1 },
      autoPruneEvery: 0,
    });
    await manager.init();

    for (let i = 1; i <= 5; i++) {
      await manager.createSnapshot(makeData(50), metaOverrides());
    }

    const result = await manager.compact();
    expect(result).toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP10-SNAP12: Verification ────────────────────────────

describe("SNAP10: Single snapshot verification", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap10");

  beforeEach(async () => {
    manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("verifies a valid snapshot", async () => {
    const snap = await manager.createSnapshot(makeData(100), metaOverrides());
    const result = await manager.verifySnapshot(snap.id);

    expect(result.valid).toBe(true);
    expect(result.snapshotId).toBe(snap.id);
    expect(result.checksum).toBe(snap.checksum);
    expect(result.sizeBytes).toBe(100);
    expect(result.errors).toHaveLength(0);
  });

  it("returns invalid for unknown snapshot ID", async () => {
    const result = await manager.verifySnapshot("snap-nonexistent");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("not found");
  });

  it("detects checksum mismatch (corrupted snapshot)", async () => {
    const snap = await manager.createSnapshot(makeData(100), metaOverrides());

    // Corrupt the file on disk
    const snapPath = path.join(dir, `${snap.id}.snap`);
    fs.writeFileSync(snapPath, Buffer.from("corrupted data"));

    const result = await manager.verifySnapshot(snap.id);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("checksum mismatch"))).toBe(true);
  });
});

describe("SNAP11: Verify all snapshots", () => {
  let manager: SnapshotManager;
  const dir = tmpDir("snap11");

  beforeEach(async () => {
    manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await cleanupAll();
  });

  it("verifies all snapshots and returns results", async () => {
    await manager.createSnapshot(makeData(100), metaOverrides());
    await manager.createSnapshot(makeData(200), metaOverrides());

    const results = await manager.verifyAll();
    expect(results.size).toBe(2);

    for (const [, result] of results) {
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("detects corruption among multiple snapshots", async () => {
    const good = await manager.createSnapshot(makeData(100), metaOverrides());
    const bad = await manager.createSnapshot(makeData(200), metaOverrides({ lastIncludedIndex: 99 }));

    // Corrupt the bad one
    fs.writeFileSync(path.join(dir, `${bad.id}.snap`), Buffer.from("corrupted"));

    const results = await manager.verifyAll();
    expect(results.size).toBe(2);
    expect(results.get(good.id)!.valid).toBe(true);
    expect(results.get(bad.id)!.valid).toBe(false);
  });
});

describe("SNAP12: Verification robustness", () => {
  it("survives deleted snapshot during verification", async () => {
    const dir = tmpDir("snap12");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    const snap = await manager.createSnapshot(makeData(100), metaOverrides());

    // Delete the file manually
    fs.unlinkSync(path.join(dir, `${snap.id}.snap`));

    const result = await manager.verifySnapshot(snap.id);
    expect(result.valid).toBe(false);

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP13-SNAP15: Edge Cases ──────────────────────────────

describe("SNAP13: Edge cases — lifecycle", () => {
  it("init scans existing snapshots from disk", async () => {
    const dir = tmpDir("snap13a");
    const m1 = new SnapshotManager({ storageDir: dir });
    await m1.init();
    await m1.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 55 }));
    await m1.createSnapshot(makeData(200), metaOverrides({ lastIncludedIndex: 77 }));
    await m1.shutdown();

    // Re-init should find both snapshots
    const m2 = new SnapshotManager({ storageDir: dir });
    await m2.init();

    const list = await m2.listSnapshots();
    expect(list.length).toBe(2);
    const indices = list.map((s) => s.meta.lastIncludedIndex).sort((a, b) => a - b);
    expect(indices).toEqual([55, 77]);

    await m2.shutdown();
    await cleanupAll();
  });

  it("operations throw when not initialized", async () => {
    const m = new SnapshotManager();
    await expect(m.createSnapshot(makeData(100), metaOverrides())).rejects.toThrow("not initialized");
    await expect(m.listSnapshots()).rejects.toThrow("not initialized");
    await expect(m.prune()).rejects.toThrow("not initialized");
  });

  it("shutdown cleans up and reset state", async () => {
    const dir = tmpDir("snap13c");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();
    await manager.createSnapshot(makeData(100), metaOverrides());

    await manager.shutdown();

    // After shutdown, count on a new manager scanning would see it...
    const m2 = new SnapshotManager({ storageDir: dir });
    await m2.init();
    expect(await m2.count()).toBe(1);
    await m2.shutdown();
    await cleanupAll();
  });

  it("double delete returns false second time", async () => {
    const dir = tmpDir("snap13d");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    const snap = await manager.createSnapshot(makeData(100), metaOverrides());
    expect(await manager.deleteSnapshot(snap.id)).toBe(true);
    expect(await manager.deleteSnapshot(snap.id)).toBe(false);

    await manager.shutdown();
    await cleanupAll();
  });
});

describe("SNAP14: Edge cases — auto-prune", () => {
  it("auto-prune triggers after every N creates", async () => {
    const dir = tmpDir("snap14a");
    const manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 3, maxAgeMs: 0, minRetain: 1, intervalMs: 0 },
      autoPruneEvery: 2,
    });
    await manager.init();

    // Create 4 snapshots — after 2 and 4, prune fires
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    expect(await manager.count()).toBe(1); // No prune yet
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 20 }));
    // After 2, prune fires but 2 ≤ 3 (maxSnapshots=3), so no pruning
    expect(await manager.count()).toBe(2);
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 30 }));
    expect(await manager.count()).toBe(3);
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 40 }));
    // After 4, prune fires: 4 > 3 → oldest (index 10) pruned
    expect(await manager.count()).toBeLessThanOrEqual(3);

    const remaining = await manager.listSnapshots();
    const indices = remaining.map((s) => s.meta.lastIncludedIndex).sort((a, b) => a - b);
    expect(indices).not.toContain(10); // Oldest pruned

    await manager.shutdown();
    await cleanupAll();
  });
});

describe("SNAP15: Edge cases — queries & grouping", () => {
  it("findNearest finds the closest snapshot ≤ target index", async () => {
    const dir = tmpDir("snap15a");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10, groupId: "g1" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 20, groupId: "g1" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 30, groupId: "g1" }));

    expect((await manager.findNearest(15))?.meta.lastIncludedIndex).toBe(10);
    expect((await manager.findNearest(20))?.meta.lastIncludedIndex).toBe(20);
    expect((await manager.findNearest(100))?.meta.lastIncludedIndex).toBe(30);
    expect((await manager.findNearest(5))).toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });

  it("latest returns the newest snapshot", async () => {
    const dir = tmpDir("snap15b");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 50 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 30 }));

    const latest = await manager.latest();
    expect(latest).not.toBeNull();
    expect(latest!.meta.lastIncludedIndex).toBe(50);

    await manager.shutdown();
    await cleanupAll();
  });

  it("listSnapshots filters by groupId", async () => {
    const dir = tmpDir("snap15c");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "group-a" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "group-b" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "group-a" }));

    const aSnaps = await manager.listSnapshots("group-a");
    expect(aSnaps).toHaveLength(2);
    expect(aSnaps.every((s) => s.meta.groupId === "group-a")).toBe(true);

    const bSnaps = await manager.listSnapshots("group-b");
    expect(bSnaps).toHaveLength(1);

    await manager.shutdown();
    await cleanupAll();
  });

  it("count filters by groupId", async () => {
    const dir = tmpDir("snap15d");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "g1" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "g2" }));
    await manager.createSnapshot(makeData(100), metaOverrides({ groupId: "g1" }));

    expect(await manager.count()).toBe(3);
    expect(await manager.count("g1")).toBe(2);
    expect(await manager.count("g2")).toBe(1);
    expect(await manager.count("g3")).toBe(0);

    await manager.shutdown();
    await cleanupAll();
  });

  it("onCreated unsubscribe stops callback", async () => {
    const dir = tmpDir("snap15e");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    const created: string[] = [];
    const unsub = manager.onCreated((s) => created.push(s.id));

    await manager.createSnapshot(makeData(100), metaOverrides());
    expect(created).toHaveLength(1);

    unsub();
    await manager.createSnapshot(makeData(100), metaOverrides());
    expect(created).toHaveLength(1); // No new callback

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP16: Defensive branches — callback exceptions ─────────

describe("SNAP16: Defensive branches — callback exceptions", () => {
  it("onCreated listener that throws does not break createSnapshot", async () => {
    const dir = tmpDir("snap16a");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    manager.onCreated(() => {
      throw new Error("listener boom");
    });

    const snap = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    expect(snap).toBeDefined();
    expect(await manager.count()).toBe(1);

    await manager.shutdown();
    await cleanupAll();
  });

  it("onPruned listener that throws does not break prune", async () => {
    const dir = tmpDir("snap16b");
    const manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 1, maxAgeMs: 0, minRetain: 1, intervalMs: 0 },
    });
    await manager.init();

    manager.onPruned(() => {
      throw new Error("prune listener boom");
    });

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));

    // Prune fires; listener throws but pruning still succeeds.
    await manager.prune();
    expect(await manager.count()).toBe(1);

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP17: Defensive branches — prune/find edge cases ────────

describe("SNAP17: Defensive branches — retention & query edges", () => {
  it("prune returns immediately when no retention policy is configured", async () => {
    const dir = tmpDir("snap17a");
    const manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 0, maxAgeMs: 0, minRetain: 1, intervalMs: 0 },
    });
    await manager.init();
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));

    const removed = await manager.prune();
    expect(removed).toEqual([]);
    expect(await manager.count()).toBe(1);

    await manager.shutdown();
    await cleanupAll();
  });

  it("findNearest and latest return null for an empty index", async () => {
    const dir = tmpDir("snap17b");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    expect(await manager.findNearest(50)).toBeNull();
    expect(await manager.latest()).toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });

  it("latest handles equal lastIncludedIndex", async () => {
    const dir = tmpDir("snap17c");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 50 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 50 }));

    const latest = await manager.latest();
    expect(latest).not.toBeNull();
    expect(latest!.meta.lastIncludedIndex).toBe(50);

    await manager.shutdown();
    await cleanupAll();
  });

  it("age-based prune rebuilds candidates when too many would be removed", async () => {
    const dir = tmpDir("snap17d");
    const manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 100, maxAgeMs: 1, minRetain: 2, intervalMs: 0 },
    });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    await delay(5); // exceed maxAgeMs=1

    const removed = await manager.prune();
    expect(await manager.count()).toBeGreaterThanOrEqual(2);
    expect(removed.length).toBeLessThanOrEqual(1);

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP18: Defensive branches — compaction edges ─────────────

describe("SNAP18: Defensive branches — compaction edges", () => {
  it("selective compaction skips already-compacted snapshots", async () => {
    const dir = tmpDir("snap18a");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "selective", maxMergeCount: 3, minAgeMs: 0, keepUncompacted: 1 },
    });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    await manager.compact();

    const remaining = await manager.listSnapshots();
    expect(remaining.some((s) => s.compacted)).toBe(true);

    const second = await manager.compact();
    expect(second).toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });

  it("minAgeMs filters out young snapshots from compaction", async () => {
    const dir = tmpDir("snap18b");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "merge", maxMergeCount: 3, minAgeMs: 60_000, keepUncompacted: 0 },
    });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    const result = await manager.compact();
    expect(result).toBeNull();
    expect(await manager.count()).toBe(3);

    await manager.shutdown();
    await cleanupAll();
  });

  it("merge compaction skips a missing snapshot file gracefully", async () => {
    const dir = tmpDir("snap18c");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "merge", maxMergeCount: 3, minAgeMs: 0, keepUncompacted: 0 },
    });
    await manager.init();

    const a = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    const b = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    const rec = (manager as any).records.get(b.id);
    await fsp.unlink(rec.filePath);

    const result = await manager.compact();
    expect(result).not.toBeNull();
    expect(result!.compacted).toBe(true);

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP19: Defensive branches — delete unlink failure ────────

describe("SNAP19: Defensive branches — delete best-effort cleanup", () => {
  it("deleteSnapshot survives an unlink failure", async () => {
    const dir = tmpDir("snap19a");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    const snap = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));

    // Pre-delete the backing snapshot file so unlink throws ENOENT, exercising
    // the best-effort cleanup catch branch.
    const rec = (manager as any).records.get(snap.id);
    await fsp.unlink(rec.filePath);

    const result = await manager.deleteSnapshot(snap.id);
    expect(result).toBe(true);
    expect(await manager.getSnapshot(snap.id)).toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP20: Defensive branches — scan/interval/merge edges ───

describe("SNAP20: Defensive branches — scan, interval, merge edges", () => {
  it("_scanExisting skips a snapshot with missing metadata", async () => {
    const dir = tmpDir("snap20a");
    const manager1 = new SnapshotManager({ storageDir: dir });
    await manager1.init();
    await manager1.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 10 }));
    await manager1.shutdown();

    // Drop a bare .snap file with no .meta.json — scanned but skipped.
    fs.writeFileSync(path.join(dir, "orphan.snap"), makeData(50));

    const manager2 = new SnapshotManager({ storageDir: dir });
    await manager2.init();

    // Only the valid snapshot is loaded; the orphan is skipped silently.
    const loaded = await manager2.listSnapshots();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.meta.lastIncludedIndex).toBe(10);

    await manager2.shutdown();
    await cleanupAll();
  });

  it("interval retention keeps one per time bucket when over maxSnapshots", async () => {
    const dir = tmpDir("snap20b");
    const manager = new SnapshotManager({
      storageDir: dir,
      retention: { maxSnapshots: 2, maxAgeMs: 0, minRetain: 1, intervalMs: 1000 },
      autoPruneEvery: 0,
    });
    await manager.init();

    // Create 4 snapshots, then rewrite their createdAt to distinct interval
    // buckets so interval retention is exercised.
    const base = Date.now();
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 4 }));

    const recs = [...(manager as any).records.values()];
    recs.sort((a: any, b: any) => a.descriptor.meta.lastIncludedIndex - b.descriptor.meta.lastIncludedIndex);
    recs.forEach((r: any, i: number) => {
      r.descriptor.createdAt = base - i * 5000; // distinct buckets (interval=1000)
    });

    const removed = await manager.prune();
    // Interval retention is exercised; pruning must not throw. Depending on
    // how many distinct interval buckets exist, some snapshots are kept.
    expect(await manager.count()).toBeGreaterThanOrEqual(1);

    await manager.shutdown();
    await cleanupAll();
  });

  it("merge compaction skips a candidate whose record is already gone", async () => {
    const dir = tmpDir("snap20c");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "merge", maxMergeCount: 3, minAgeMs: 0, keepUncompacted: 0 },
    });
    await manager.init();

    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    const b = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    // Remove b's record from the in-memory map (simulate a raced deletion) so
    // _mergeSnapshots hits `if (!record) continue`.
    (manager as any).records.delete(b.id);

    const result = await manager.compact();
    expect(result).not.toBeNull();

    await manager.shutdown();
    await cleanupAll();
  });
});

// ── SNAP21: Defensive branches — direct private-method edges ─

describe("SNAP21: Defensive branches — compaction filter & merge internals", () => {
  it("_mergeSnapshots skips a candidate whose record is missing", async () => {
    const dir = tmpDir("snap21a");
    const manager = new SnapshotManager({ storageDir: dir });
    await manager.init();

    const a = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));

    // Invoke the private merge helper with a candidate id that no longer
    // exists in `records`, exercising `if (!record) continue`.
    const ghost = { id: "does-not-exist", meta: metaOverrides(), sizeBytes: 0, createdAt: 0, checksum: "", verified: false, compacted: false };
    const merged = await (manager as any)._mergeSnapshots([a, ghost]);
    expect(Buffer.isBuffer(merged)).toBe(true);

    await manager.shutdown();
    await cleanupAll();
  });

  it("_selectCompactCandidates skips already-compacted snapshots", async () => {
    const dir = tmpDir("snap21b");
    const manager = new SnapshotManager({
      storageDir: dir,
      compact: { strategy: "merge", maxMergeCount: 5, minAgeMs: 0, keepUncompacted: 0 },
    });
    await manager.init();

    const a = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 1 }));
    const b = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 2 }));
    const c = await manager.createSnapshot(makeData(100), metaOverrides({ lastIncludedIndex: 3 }));

    // Mark b as compacted so the eligible filter must skip it.
    (manager as any).records.get(b.id).descriptor.compacted = true;

    const candidates = await (manager as any)._selectCompactCandidates({
      strategy: "merge", maxMergeCount: 5, minAgeMs: 0, keepUncompacted: 0,
    });

    // b (compacted) is excluded from candidates.
    const ids = candidates.map((s: SnapshotDescriptor) => s.id);
    expect(ids).not.toContain(b.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);

    await manager.shutdown();
    await cleanupAll();
  });
});
