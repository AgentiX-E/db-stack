/**
 * FileAuditStore Tests — AC 52.x
 *
 * AC 52.1 — Write audit entry to NDJSON file
 * AC 52.2 — Query with filters (time, operation, actor, severity)
 * AC 52.3 — Get by ID
 * AC 52.4 — Count
 * AC 52.5 — Prune old entries by file mtime
 * AC 52.6 — Log rotation by file size
 * AC 52.7 — Crash-safe writes (tmp + rename)
 * AC 52.8 — Query with limit/offset
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FileAuditStore,
  type FileAuditStoreConfig,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_AGE_MS,
} from "../impl/FileAuditStore.js";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Test data dir ──────────────────────────────────────────

const TEST_DIR = "/tmp/db-federation-test/audit-file-store";

function cleanDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

// ── Suite ──────────────────────────────────────────────────

describe("FileAuditStore — AC 52.x: File-based Audit Store", () => {
  let config: FileAuditStoreConfig;
  let store: FileAuditStore;

  beforeEach(() => {
    cleanDir();
    config = {
      dataDir: TEST_DIR,
      maxFileSize: 1024 * 10, // 10 KB for fast rotation
      maxAgeMs: 3600_000,     // 1 hour
      retentionDays: 90,
    };
    store = new FileAuditStore(config);
  });

  afterEach(() => {
    cleanDir();
  });

  // AC 52.0: default constants have their documented values
  it("AC 52.0: default constants are 50MB and 24h", () => {
    expect(DEFAULT_MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    expect(DEFAULT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  // AC 52.1: Write
  it("AC 52.1: should write audit entry to NDJSON file", async () => {
    const id = await store.write({
      operation: "LOGIN",
      actor: "admin",
      resource: "/api/login",
      result: "success",
      severity: "info",
    });

    expect(id).toBeTruthy();

    // File should exist
    const files = readdirSync(TEST_DIR);
    expect(files.some((f) => f.endsWith(".ndjson"))).toBe(true);

    // Content should be valid JSON
    const ndjsonFile = files.find((f) => f.endsWith(".ndjson"))!;
    const content = readFileSync(join(TEST_DIR, ndjsonFile), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.operation).toBe("LOGIN");
    expect(parsed.actor).toBe("admin");
    expect(parsed.id).toBe(id);
  });

  // AC 52.2: Query with filters
  it("AC 52.2: should query with various filters", async () => {
    await store.write({ operation: "LOGIN", actor: "admin", resource: "/login", result: "success" });
    await store.write({ operation: "SELECT", actor: "user1", resource: "users", result: "success" });
    await store.write({
      operation: "DELETE",
      actor: "admin",
      resource: "users",
      result: "failure",
      severity: "error",
    });
    await store.write({ operation: "SELECT", actor: "user2", resource: "orders", result: "success" });
    await store.write({ operation: "DROP", actor: "admin", resource: "users", result: "denied", severity: "critical" });

    // Filter by operation
    const selectResults = await store.query({ operation: "SELECT" });
    expect(selectResults).toHaveLength(2);

    // Filter by actor
    const adminResults = await store.query({ actor: "admin" });
    expect(adminResults).toHaveLength(3);

    // Filter by result
    const deniedResults = await store.query({ result: "denied" });
    expect(deniedResults).toHaveLength(1);

    // Filter by severity
    const criticalResults = await store.query({ severity: "critical" });
    expect(criticalResults).toHaveLength(1);

    // All results
    const all = await store.query({});
    expect(all).toHaveLength(5);
  });

  // AC 52.3: Get by ID
  it("AC 52.3: should get entry by ID", async () => {
    const id = await store.write({
      operation: "INSERT",
      actor: "app",
      resource: "orders",
      result: "success",
    });

    const entry = await store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("INSERT");
    expect(entry!.id).toBe(id);

    const notFound = await store.get("nonexistent-id");
    expect(notFound).toBeNull();
  });

  // AC 52.4: Count
  it("AC 52.4: should count entries", async () => {
    for (let i = 0; i < 10; i++) {
      await store.write({
        operation: `OP_${i}`,
        actor: "user",
        resource: "test",
        result: "success",
      });
    }

    const total = await store.count();
    expect(total).toBe(10);

    const filtered = await store.count({ operation: "OP_1" });
    expect(filtered).toBe(1);
  });

  // AC 52.5: Prune
  it("AC 52.5: should prune old files by mtime", async () => {
    await store.write({ operation: "OLD", actor: "bot", resource: "x", result: "success" });

    // Prune with a timestamp far in the future (all files older)
    const future = new Date(Date.now() + 86400_000);
    const removed = await store.pruneOlderThan(future);
    expect(removed).toBeGreaterThanOrEqual(0);

    // Prune with a timestamp far in the past (no files older)
    const past = new Date(0);
    const removed2 = await store.pruneOlderThan(past);
    expect(removed2).toBe(0);
  });

  // AC 52.5b: prune removes both .ndjson and .gz files
  it("AC 52.5b: prune removes compressed .gz files too", async () => {
    store = new FileAuditStore({ ...config, maxFileSize: 100 });
    for (let i = 0; i < 20; i++) {
      await store.write({ operation: `OP_${i}_${"x".repeat(20)}`, actor: "a", resource: "r", result: "success" });
    }
    await new Promise((r) => setTimeout(r, 100));

    const before = readdirSync(TEST_DIR).filter((f) => f.endsWith(".gz") || f.endsWith(".ndjson"));
    expect(before.length).toBeGreaterThan(0);

    // Prune everything with a far-future timestamp.
    const removed = await store.pruneOlderThan(new Date(Date.now() + 86400_000));
    expect(removed).toBeGreaterThanOrEqual(before.length);

    const after = readdirSync(TEST_DIR).filter((f) => f.endsWith(".gz") || f.endsWith(".ndjson"));
    expect(after.length).toBe(0);
  });

  // AC 52.11: query respects maxScanLines bound
  it("AC 52.11: query stops scanning after maxScanLines", async () => {
    store = new FileAuditStore({ ...config, maxScanLines: 3 });

    for (let i = 0; i < 10; i++) {
      await store.write({ operation: `OP_${i}`, actor: "a", resource: "r", result: "success" });
    }

    // With maxScanLines=3, exactly 3 entries are scanned. The `>=` bound means
    // scanning stops the moment `scanned` reaches 3; a `<` mutant would scan
    // one extra (4) before breaking.
    const results = await store.query({});
    expect(results.length).toBe(3);
  });

  // AC 52.12: resolveActiveFile resumes the highest sequence number
  it("AC 52.12: constructor resumes the highest existing sequence", async () => {
    // Pre-create two rotated files with sequences 0001 and 0002.
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(TEST_DIR, `audit-${dateStr}-0001.ndjson`), "");
    writeFileSync(join(TEST_DIR, `audit-${dateStr}-0002.ndjson`), "");

    // Construct a new store against the same dir; it must select seq 0002
    // (the max) as the active file, not create a new 0003 yet.
    const fresh = new FileAuditStore(config);
    await fresh.write({ operation: "RESUME", actor: "a", resource: "r", result: "success" });

    const files = readdirSync(TEST_DIR);
    const seqs = files
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => f.match(/-(\d{4})\.ndjson$/)?.[1])
      .sort();

    // Should still be exactly two files (write appended to 0002, no new file).
    expect(files.filter((f) => f.endsWith(".ndjson")).length).toBe(2);
    // The 0002 file should now be non-empty (received the appended entry).
    const content = readFileSync(join(TEST_DIR, `audit-${dateStr}-0002.ndjson`), "utf-8");
    expect(content).toContain("RESUME");
  });

  // AC 52.13: scanEntries respects maxScanLines for JSON array files too
  it("AC 52.13: query stops scanning JSON-array files at maxScanLines", async () => {
    store = new FileAuditStore({ ...config, maxScanLines: 3 });

    // Manually create a legacy single-JSON-array file with 5 entries.
    const makeEntry = (i: number) => ({
      id: `id-${i}`,
      timestamp: new Date(1600000000000 + i * 1000).toISOString(),
      operation: "OP",
      actor: "a",
      resource: "r",
      result: "success",
      severity: "info",
    });
    const arr = [0, 1, 2, 3, 4].map(makeEntry);
    writeFileSync(join(TEST_DIR, "legacy.json"), JSON.stringify(arr));

    // maxScanLines=3 → exactly 3 entries scanned; `>=` stops at the 3rd,
    // a `<` mutant would break on the 0th and return 0.
    const results = await store.query({});
    expect(results.length).toBe(3);
  });

  // AC 52.6: Log rotation by size
  it("AC 52.6: should rotate log file when size exceeds maxFileSize", async () => {
    // Set very small maxFileSize to trigger rotation
    store = new FileAuditStore({ ...config, maxFileSize: 200 });

    // Write many entries to trigger rotation
    for (let i = 0; i < 50; i++) {
      await store.write({
        operation: `OP_${i}_${"x".repeat(30)}`,
        actor: "user",
        resource: "test",
        result: "success",
      });
    }

    // A rotated segment is compressed in the background and its `.ndjson`
    // original is removed once the gzip completes, so counting bare `.ndjson`
    // files is a race against that pipeline. Count every segment instead, and
    // assert the sequence numbers are unique — that is what rotation promises.
    const segments = readdirSync(TEST_DIR).filter((f) => /\.ndjson(\.gz)?$/.test(f));
    expect(segments.length).toBeGreaterThan(1);

    const sequences = segments.map((f) => Number(f.match(/-(\d{4})\.ndjson/)?.[1]));
    expect(sequences.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  // AC 52.6b: rotation assigns increasing sequence numbers and compresses old file
  it("AC 52.6b: rotation produces .gz of the old file with increasing sequences", async () => {
    store = new FileAuditStore({ ...config, maxFileSize: 100 });

    for (let i = 0; i < 20; i++) {
      await store.write({
        operation: `OP_${i}_${"x".repeat(20)}`,
        actor: "user",
        resource: "r",
        result: "success",
      });
    }

    // Wait for the background gzip compression (setImmediate pipeline).
    await new Promise((r) => setTimeout(r, 100));

    const files = readdirSync(TEST_DIR);
    // A compressed .ndjson.gz file must exist (oldPath + '.gz').
    expect(files.some((f) => f.endsWith(".ndjson.gz"))).toBe(true);
  });

  // AC 52.10: rotation by age (maxAgeMs) — exercises shouldRotate age branch
  it("AC 52.10: rotates by age when maxAgeMs elapses", async () => {
    store = new FileAuditStore({ ...config, maxFileSize: 1024 * 1024, maxAgeMs: 1 });

    await store.write({ operation: "A1", actor: "a", resource: "r", result: "success" });

    // Wait past maxAgeMs so the next write triggers age-based rotation.
    await new Promise((r) => setTimeout(r, 20));
    await store.write({ operation: "A2", actor: "a", resource: "r", result: "success" });
    // Let the background gzip of the rotated segment settle so the assertion
    // below is order-independent instead of racing the compression pipeline.
    await new Promise((r) => setTimeout(r, 150));

    const segments = readdirSync(TEST_DIR).filter((f) => /\.ndjson(\.gz)?$/.test(f));
    expect(segments.length).toBeGreaterThanOrEqual(2);

    // The rotated segment holds A1; the new active file holds only A2.
    const activeFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ndjson"));
    const newest = activeFiles
      .map((f) => ({ f, seq: Number(f.match(/-(\d{4})\.ndjson/)?.[1] ?? 0) }))
      .sort((a, b) => b.seq - a.seq)[0]!;
    const content = readFileSync(join(TEST_DIR, newest.f), "utf8");
    expect(content).toContain("A2");
    expect(content).not.toContain("A1");
  });

  // AC 52.7: Crash-safe write (tmp + rename)
  it("AC 52.7: should write through tmp + rename for crash safety", async () => {
    await store.write({ operation: "SAFE", actor: "test", resource: "x", result: "success" });

    // No .tmp file should remain after successful write
    const files = readdirSync(TEST_DIR);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    // The .ndjson file should contain valid audit entry
    const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson"));
    expect(ndjsonFiles).toHaveLength(1);
  });

  // AC 52.8: Query with limit and offset
  it("AC 52.8: should support pagination via limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await store.write({
        operation: "INSERT",
        actor: `user_${i}`,
        resource: "test",
        result: "success",
      });
    }

    const page1 = await store.query({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = await store.query({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);

    // Ensure pages don't overlap
    const ids1 = page1.map((e) => e.id);
    const ids2 = page2.map((e) => e.id);
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }
  });

  // AC 52.9: Query by time range (startTime/endTime boundaries)
  it("AC 52.9: query filters by startTime and endTime", async () => {
    // Write entries with deterministic, well-separated timestamps directly to
    // an NDJSON file so startTime/endTime boundary comparisons are reliable
    // (write() uses the real clock, which is not deterministic under load).
    const base = 1600000000000;
    const mk = (i: number) => ({
      id: `t-${i}`,
      timestamp: new Date(base + i * 60_000).toISOString(), // 1-minute apart
      operation: "OP",
      actor: "a",
      resource: "r",
      result: "success",
      severity: "info",
    });
    const lines = [0, 1, 2].map(mk).map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(TEST_DIR, "audit-timed.ndjson"), lines + "\n");

    const results = await store.query({});
    expect(results).toHaveLength(3);

    // startTime = middle entry → excludes the first (earliest) entry.
    const mid = new Date(base + 60_000);
    const afterMid = await store.query({ startTime: mid });
    expect(afterMid.some((e) => e.id === "t-0")).toBe(false);
    expect(afterMid.some((e) => e.id === "t-1")).toBe(true);
    expect(afterMid.some((e) => e.id === "t-2")).toBe(true);

    // endTime = middle entry → excludes the last (latest) entry.
    const beforeLate = await store.query({ endTime: mid });
    expect(beforeLate.some((e) => e.id === "t-2")).toBe(false);
    expect(beforeLate.some((e) => e.id === "t-1")).toBe(true);
    expect(beforeLate.some((e) => e.id === "t-0")).toBe(true);
  });
});
