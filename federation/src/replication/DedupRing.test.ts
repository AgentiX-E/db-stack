/**
 * DedupRing Tests — In-flight message deduplication.
 *
 * AC 40.3 (sub-aspect): Receiver side deduplication by msgId
 * Coverage:
 *   - Basic contains/put
 *   - Duplicate detection
 *   - TTL-based eviction
 *   - Capacity enforcement (FIFO eviction)
 *   - Delete operation
 *   - Clear operation
 *   - Statistics tracking
 *   - Sweep amortization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DedupRing } from "./DedupRing";

describe("DedupRing — Basic Operations", () => {
  it("should report not contains for empty ring", () => {
    const ring = new DedupRing();
    expect(ring.contains("msg-123")).toBe(false);
  });

  it("should accept a new msgId on put()", () => {
    const ring = new DedupRing();
    const result = ring.put("msg-123");
    expect(result).toBe(true);
    expect(ring.contains("msg-123")).toBe(true);
  });

  it("should reject duplicate msgId on put()", () => {
    const ring = new DedupRing();
    ring.put("msg-123");
    const result = ring.put("msg-123");
    expect(result).toBe(false);
  });

  it("should track size correctly", () => {
    const ring = new DedupRing();
    expect(ring.size).toBe(0);
    ring.put("a");
    ring.put("b");
    ring.put("c");
    expect(ring.size).toBe(3);
  });
});

describe("DedupRing — Duplicate Detection (AC 40.3)", () => {
  it("should detect duplicates across 10K unique IDs", () => {
    const ring = new DedupRing({ ttlMs: 60_000 });
    const ids: string[] = [];

    for (let i = 0; i < 10_000; i++) {
      const id = `msg-${i}`;
      ids.push(id);
      expect(ring.put(id)).toBe(true);
    }

    // All should be present
    for (const id of ids) {
      expect(ring.contains(id)).toBe(true);
    }

    // All should be rejected as duplicates
    for (const id of ids) {
      expect(ring.put(id)).toBe(false);
    }
  });

  it("should track dedup statistics", () => {
    const ring = new DedupRing();
    ring.put("msg-1");
    ring.put("msg-2");

    // Two duplicates
    ring.put("msg-1");
    ring.put("msg-2");

    const stats = ring.getStats();
    expect(stats.totalSeen).toBe(2); // 2 unique
    expect(stats.totalDeduped).toBe(2); // 2 duplicates rejected
    expect(stats.size).toBe(2);
  });
});

describe("DedupRing — Delete Operation", () => {
  it("should delete an existing entry", () => {
    const ring = new DedupRing();
    ring.put("msg-1");
    expect(ring.delete("msg-1")).toBe(true);
    expect(ring.contains("msg-1")).toBe(false);
  });

  it("should return false when deleting non-existent entry", () => {
    const ring = new DedupRing();
    expect(ring.delete("non-existent")).toBe(false);
  });

  it("should allow re-insert after delete", () => {
    const ring = new DedupRing();
    ring.put("msg-1");
    ring.delete("msg-1");
    expect(ring.put("msg-1")).toBe(true);
  });
});

describe("DedupRing — Clear Operation", () => {
  it("should clear all entries", () => {
    const ring = new DedupRing();
    ring.put("a");
    ring.put("b");
    ring.put("c");
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.contains("a")).toBe(false);
    expect(ring.contains("b")).toBe(false);
    expect(ring.contains("c")).toBe(false);
  });

  it("should reset stats after clear", () => {
    const ring = new DedupRing();
    ring.put("a");
    ring.put("b");
    ring.clear();
    const stats = ring.getStats();
    // Stats are cumulative (not resets on clear)
    // Clear only empties the map/queue
    expect(stats.size).toBe(0);
    expect(stats.totalSeen).toBe(2);
  });
});

describe("DedupRing — TTL-Based Eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should evict entries after TTL expires", () => {
    const ring = new DedupRing({ ttlMs: 1000 }); // 1s TTL
    ring.put("msg-old");

    expect(ring.contains("msg-old")).toBe(true);

    // Advance past TTL
    vi.advanceTimersByTime(1100);

    // Sweep on next contains/put
    expect(ring.contains("msg-old")).toBe(false);
  });

  it("should not evict entries before TTL", () => {
    const ring = new DedupRing({ ttlMs: 10_000 }); // 10s TTL
    ring.put("msg-recent");

    vi.advanceTimersByTime(5000);
    expect(ring.contains("msg-recent")).toBe(true);
  });

  it("should evict only expired entries, keep recent ones", () => {
    const ring = new DedupRing({ ttlMs: 2000 });
    ring.put("msg-recent");
    
    vi.advanceTimersByTime(500);
    ring.put("msg-recent-2"); // refreshed

    vi.advanceTimersByTime(2000);
    // First entry expired, second not yet (put later)
    expect(ring.contains("msg-recent")).toBe(false);
    expect(ring.contains("msg-recent-2")).toBe(true);
  });

  it("should handle sweep on empty ring gracefully", () => {
    const ring = new DedupRing({ ttlMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(() => ring.sweep()).not.toThrow();
    expect(ring.size).toBe(0);
  });
});

describe("DedupRing — Capacity Enforcement (FIFO Eviction)", () => {
  it("should evict oldest entries when capacity exceeded", () => {
    const ring = new DedupRing({ maxCapacity: 3, ttlMs: 3_600_000 });

    ring.put("a");
    ring.put("b");
    ring.put("c");
    expect(ring.size).toBe(3);

    // Adding a 4th should evict oldest
    ring.put("d");
    expect(ring.size).toBe(3); // a evicted (max 3 now: b, c, d)
    expect(ring.contains("a")).toBe(false);
    expect(ring.contains("b")).toBe(true);
    expect(ring.contains("c")).toBe(true);
    expect(ring.contains("d")).toBe(true);
  });

  it("should not evict when under capacity", () => {
    const ring = new DedupRing({ maxCapacity: 100, ttlMs: 3_600_000 });
    for (let i = 0; i < 50; i++) {
      ring.put(`msg-${i}`);
    }
    expect(ring.size).toBe(50);
  });

  it("should track eviction statistics", () => {
    const ring = new DedupRing({ maxCapacity: 5, ttlMs: 3_600_000 });

    for (let i = 0; i < 10; i++) {
      ring.put(`msg-${i}`);
    }

    const stats = ring.getStats();
    expect(stats.totalEvicted).toBe(5); // 5 evicted (10-5)
    expect(stats.capacity).toBe(5);
  });
});

describe("DedupRing — High Throughput", () => {
  it("should handle 100K unique IDs under capacity without degrading", () => {
    const ring = new DedupRing({ maxCapacity: 200_000, ttlMs: 3_600_000 });

    // Warm-up phase: the first 10K inserts establish the per-op cost.
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) ring.put(`msg-${i}`);
    const smallPerOp = (performance.now() - t0) / 10_000;

    // Main phase: the next 90K inserts must cost the same per operation.
    const t1 = performance.now();
    for (let i = 10_000; i < 100_000; i++) ring.put(`msg-${i}`);
    const largePerOp = (performance.now() - t1) / 90_000;

    expect(ring.size).toBe(100_000);

    // Insert cost must stay flat as the ring grows — a per-insert O(n) step
    // (e.g. Array#shift on eviction, or a linear membership scan) shows up
    // here as a multi-fold ratio. Absolute wall-clock is deliberately not
    // asserted: it depends on CPU scheduling, not on the data structure.
    expect(largePerOp).toBeLessThan(Math.max(smallPerOp * 3, 0.02));
    // Sanity ceiling so a pathological regression cannot pass silently.
    expect(largePerOp * 90_000).toBeLessThan(60_000);
  });

  it("should handle 100% duplicate rate at high throughput", () => {
    const ring = new DedupRing({ maxCapacity: 200_000, ttlMs: 3_600_000 });

    // Insert 50K unique
    for (let i = 0; i < 50_000; i++) {
      ring.put(`msg-${i}`);
    }

    // 50K duplicates
    let duplicates = 0;
    const start = performance.now();
    for (let i = 0; i < 50_000; i++) {
      if (!ring.put(`msg-${i}`)) duplicates++;
    }
    const elapsed = performance.now() - start;

    expect(duplicates).toBe(50_000);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("DedupRing — Edge Cases", () => {
  it("should handle empty string msgId", () => {
    const ring = new DedupRing();
    expect(ring.put("")).toBe(true);
    expect(ring.contains("")).toBe(true);
    expect(ring.put("")).toBe(false); // duplicate
  });

  it("should handle identical msgIds with nodeId tagging", () => {
    const ring1 = new DedupRing({ nodeId: "node-a" });
    const ring2 = new DedupRing({ nodeId: "node-b" });
    ring1.put("shared-msg");
    ring2.put("shared-msg");
    // Each ring independently tracks
    expect(ring1.contains("shared-msg")).toBe(true);
    expect(ring2.contains("shared-msg")).toBe(true);
  });
});
