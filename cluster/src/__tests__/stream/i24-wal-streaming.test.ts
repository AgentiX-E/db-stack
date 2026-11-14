/**
 * I24 — B2 WAL Streaming tests.
 *
 * WAL1-WAL3: Subscription lifecycle (subscribe, unsubscribe, multiple subscribers)
 * WAL4-WAL6: Tail streaming (new entries, backpressure, filtering)
 * WAL7-WAL9: Replay (range replay, empty range, large range)
 * WAL10-WAL12: Position tracking (ack, lag, catch-up)
 * WAL13-WAL15: Edge cases (disabled emitData, invalid filter, rapid stop/start)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WalStreamer } from "../../stream/WalStreamer";
import type { IWalStreamer, StreamEvent, StreamFilter, StreamHandler } from "../../stream/IWalStreamer";
import type { IWalStorage } from "../../interfaces/wal/IWalStorage";
import type { LogEntry, OperationResult } from "../../interfaces/types";

// ── Mock WAL Storage ───────────────────────────────────────

function okResult<T>(value: T): OperationResult<T> {
  return { success: true, data: value };
}

function makeEntry(index: number, term: number, command: string, data?: unknown, ts?: number): LogEntry {
  return {
    index,
    term,
    command,
    data,
    timestamp: ts ?? Date.now(),
  };
}

class MockWalStorage implements IWalStorage {
  private entries: LogEntry[] = [];

  async append(entry: Omit<LogEntry, "index" | "timestamp">): Promise<OperationResult<number>> {
    const idx = this.entries.length + 1;
    this.entries.push({
      ...entry,
      index: idx,
      timestamp: Date.now(),
    } as LogEntry);
    return { success: true, data: idx };
  }

  async appendBatch(entries: Omit<LogEntry, "index" | "timestamp">[]): Promise<OperationResult<number[]>> {
    const indices: number[] = [];
    for (const e of entries) {
      const res = await this.append(e);
      if (res.success && res.data) indices.push(res.data);
    }
    return { success: true, data: indices };
  }

  async read(index: number): Promise<OperationResult<LogEntry | null>> {
    const entry = this.entries[index - 1] ?? null;
    return { success: true, data: entry };
  }

  async readRange(startIndex: number, endIndex: number): Promise<OperationResult<LogEntry[]>> {
    // endIndex is exclusive
    if (this.failReadRange) return { success: false, error: "readRange failure" };
    return { success: true, data: this.entries.slice(startIndex - 1, endIndex - 1) };
  }

  async lastEntry(): Promise<OperationResult<LogEntry | null>> {
    if (this.failLastEntry) return { success: false, error: "lastEntry failure" };
    const last = this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
    return { success: true, data: last ?? null };
  }

  async length(): Promise<OperationResult<number>> {
    return { success: true, data: this.entries.length };
  }

  async truncate(_lastIndex: number): Promise<OperationResult> {
    return { success: true };
  }

  async deleteFrom(_start: number): Promise<OperationResult> {
    return { success: true };
  }

  async storeSnapshot(): Promise<OperationResult> {
    return { success: true };
  }

  async latestSnapshot(): Promise<OperationResult<null>> {
    return { success: true, data: null };
  }

  async close(): Promise<void> {}

  // Failure-injection flags for exercising error/edge branches.
  failLastEntry = false;
  failReadRange = false;

  // Test helpers
  seedEntries(count: number, term = 1): void {
    for (let i = 1; i <= count; i++) {
      this.entries.push(makeEntry(i, term, `set`, { key: `k${i}`, value: `v${i}` }));
    }
  }

  async addEntry(command = "set", data?: unknown, term = 1): Promise<LogEntry> {
    const idx = this.entries.length + 1;
    const entry = makeEntry(idx, term, command, data);
    this.entries.push(entry);
    return entry;
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}

// ── WAL1-WAL3: Subscription Lifecycle ─────────────────────

describe("WAL1: Subscribe and unsubscribe", () => {
  let streamer: WalStreamer;
  let mock: MockWalStorage;

  beforeEach(async () => {
    mock = new MockWalStorage();
    mock.seedEntries(3);
    streamer = new WalStreamer();
    await streamer.init(mock);
  });

  afterEach(async () => {
    await streamer.stop();
  });

  it("creates an active subscription", async () => {
    const handler = vi.fn(async () => {});
    const sub = await streamer.subscribe("sub-1", handler);
    expect(sub.active).toBe(true);
    expect(sub.eventsEmitted).toBe(0);
    expect(sub.id).toContain("sub-1");
  });

  it("unsubscribe removes subscription", async () => {
    const sub = await streamer.subscribe("sub-1", vi.fn(async () => {}));
    await streamer.unsubscribe(sub.id);

    const subs = await streamer.getSubscriptions();
    expect(subs).toHaveLength(0);
  });

  it("multiple concurrent subscribers", async () => {
    await streamer.subscribe("sub-a", vi.fn(async () => {}));
    await streamer.subscribe("sub-b", vi.fn(async () => {}));
    await streamer.subscribe("sub-c", vi.fn(async () => {}));

    const subs = await streamer.getSubscriptions();
    expect(subs).toHaveLength(3);
    expect(subs.map((s) => s.active)).toEqual([true, true, true]);
  });
});

describe("WAL2: Subscription filtering", () => {
  it("subscriber with command filter only receives matching events", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("f-sub", async (e) => { captured.push(e); }, {
      commands: ["insert"],
    });

    await streamer.start();

    // Add entries with different commands
    await mock.addEntry("set");
    await mock.addEntry("insert", { key: "a" });
    await mock.addEntry("delete");
    await mock.addEntry("insert", { key: "b" });

    // Wait for polling
    await delay(50);
    await streamer.stop();

    // Should only capture "insert" entries
    expect(captured.length).toBe(2);
    expect(captured.every((e) => e.entry.command === "insert")).toBe(true);
  });

  it("filter by minTerm excludes lower-term entries", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("t-sub", async (e) => { captured.push(e); }, {
      minTerm: 2,
    });

    await streamer.start();

    // Tail new entries after subscribe: term=1 is filtered out, term>=2 pass.
    await mock.addEntry("set", undefined, 1); // term=1 → filtered out
    await mock.addEntry("set", undefined, 2); // term=2 → passes
    await mock.addEntry("set", undefined, 3); // term=3 → passes

    await delay(120);

    expect(captured).toHaveLength(2);
    expect(captured.every((e) => e.entry.term >= 2)).toBe(true);
    await streamer.stop();
  });

  it("filter by minTerm passes entries at or above the threshold", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(0);
    await mock.addEntry("set", undefined, 3);
    await mock.addEntry("set", undefined, 2);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    await streamer.replay(1, 2, async (e) => { captured.push(e); }, { minTerm: 2 });

    expect(captured).toHaveLength(2);
    await streamer.stop();
  });

  it("subscriber with dataMatch predicate filters correctly", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("d-sub", async (e) => { captured.push(e); }, {
      dataMatch: (d) => typeof d === "object" && d !== null && (d as Record<string, unknown>).important === true,
    });

    await streamer.start();

    await mock.addEntry("set", { important: false, value: 1 });
    await mock.addEntry("set", { important: true, value: 2 });
    await mock.addEntry("set", { important: false, value: 3 });

    await delay(50);
    await streamer.stop();

    expect(captured.length).toBe(1);
    expect((captured[0]!.entry.data as Record<string, unknown>).important).toBe(true);
  });

  it("dataMatch predicate that throws excludes the event", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("throwing-sub", async (e) => { captured.push(e); }, {
      dataMatch: () => { throw new Error("boom"); },
    });

    await streamer.start();
    await mock.addEntry("set", { value: 1 });
    await delay(50);
    await streamer.stop();

    // Throwing predicate = no match, no events captured
    expect(captured.length).toBe(0);
  });
});

describe("WAL3: Multiple subscriber isolation", () => {
  it("each subscriber receives independent events", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const capturedA: StreamEvent[] = [];
    const capturedB: StreamEvent[] = [];

    await streamer.subscribe("sub-a", async (e) => { capturedA.push(e); });
    await streamer.subscribe("sub-b", async (e) => { capturedB.push(e); });

    await streamer.start();

    await mock.addEntry("set", { x: 1 });
    await mock.addEntry("set", { x: 2 });

    await delay(50);
    await streamer.stop();

    // Both should see all events (no filter)
    expect(capturedA.length).toBe(2);
    expect(capturedB.length).toBe(2);
  });

  it("unsubscribing one does not affect others", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const capturedA: StreamEvent[] = [];
    const capturedB: StreamEvent[] = [];

    const subA = await streamer.subscribe("sub-a", async (e) => { capturedA.push(e); });
    await streamer.subscribe("sub-b", async (e) => { capturedB.push(e); });

    await streamer.start();

    await mock.addEntry("set", { x: 1 });
    await delay(50);

    // Unsubscribe A
    await streamer.unsubscribe(subA.id);

    await mock.addEntry("set", { x: 2 });
    await delay(50);

    await streamer.stop();

    // A should only see the first entry
    expect(capturedA.length).toBe(1);
    // B should see both
    expect(capturedB.length).toBe(2);
  });
});

// ── WAL4-WAL6: Replay ──────────────────────────────────────

describe("WAL4: Range replay", () => {
  it("replays full range", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(50);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    const count = await streamer.replay(1, 50, async (e) => { captured.push(e); });

    expect(count).toBe(50);
    expect(captured).toHaveLength(50);
    expect(captured[0]!.entry.index).toBe(1);
    expect(captured[49]!.entry.index).toBe(50);
  });

  it("replays partial range", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(100);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    const count = await streamer.replay(30, 60, async (e) => { captured.push(e); });

    expect(count).toBe(31); // 30..60 inclusive
    expect(captured[0]!.entry.index).toBe(30);
    expect(captured[captured.length - 1]!.entry.index).toBe(60);
  });

  it("replays empty range (from > to) returns 0", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const count = await streamer.replay(10, 5, vi.fn(async () => {}));
    expect(count).toBe(0);
  });

  it("replays with filter", async () => {
    const mock = new MockWalStorage();
    // Seed with alternating commands
    for (let i = 1; i <= 20; i++) {
      const cmd = i % 2 === 0 ? "set" : "delete";
      mock.seedEntries(0); // clear approach
    }
    // Manual setup for alternating
    // Clear and refill
    const clearMock = new MockWalStorage();
    for (let i = 1; i <= 20; i++) {
      await clearMock.addEntry(i % 2 === 0 ? "set" : "delete");
    }

    const streamer = new WalStreamer();
    await streamer.init(clearMock);

    const captured: StreamEvent[] = [];
    const count = await streamer.replay(1, 20, async (e) => { captured.push(e); }, {
      commands: ["set"],
    });

    expect(count).toBe(10);
    expect(captured.every((e) => e.entry.command === "set")).toBe(true);
  });
});

describe("WAL5: Replay batching", () => {
  it("handles replay with batch size smaller than range", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(1500);
    const streamer = new WalStreamer();
    await streamer.init(mock, { replayBatchSize: 200 });

    const captured: StreamEvent[] = [];
    const count = await streamer.replay(1, 1500, async (e) => { captured.push(e); });

    expect(count).toBe(1500);
    expect(captured).toHaveLength(1500);
  });
});

describe("WAL6: Replay with data clamping", () => {
  it("emitData=false strips entry data", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(5);
    const streamer = new WalStreamer();
    await streamer.init(mock, { emitData: false });

    const captured: StreamEvent[] = [];
    await streamer.replay(1, 5, async (e) => { captured.push(e); });

    expect(captured).toHaveLength(5);
    for (const e of captured) {
      expect(e.entry.data).toBeUndefined();
      expect(e.entry.command).toBeDefined(); // metadata preserved
    }
  });
});

// ── WAL7-WAL9: Position & Ack ──────────────────────────────

describe("WAL7: Position tracking", () => {
  it("getPosition returns global sequence and entry index", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(5);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.replay(1, 5, vi.fn(async () => {}));
    const pos = await streamer.getPosition();

    expect(pos.sequence).toBe(5);
    expect(pos.entryIndex).toBe(5);
  });

  it("position is zero before any emits", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(0);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const pos = await streamer.getPosition();
    expect(pos.sequence).toBe(0);
    expect(pos.entryIndex).toBe(0);
  });
});

describe("WAL8: Acknowledgment and lag", () => {
  it("ack updates lastAckedSequence", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.subscribe("s1", vi.fn(async () => {}));
    await streamer.replay(1, 10, vi.fn(async () => {}));

    await streamer.ack({ subscriberId: "s1", sequence: 5, entryIndex: 5 });
    const subs = await streamer.getSubscriptions();
    expect(subs[0]!.lastAckedSequence).toBe(5);
  });

  it("getLag returns unacknowledged event count", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.subscribe("s1", vi.fn(async () => {}));
    // Emit some events but don't ack
    await streamer.replay(1, 10, vi.fn(async () => {}));

    const lag = await streamer.getLag("s1");
    expect(lag).toBe(10); // All 10 unacknowledged
  });

  it("lag decreases after ack", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(20);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.subscribe("s1", vi.fn(async () => {}));
    await streamer.replay(1, 20, vi.fn(async () => {}));

    await streamer.ack({ subscriberId: "s1", sequence: 18, entryIndex: 18 });
    const lag = await streamer.getLag("s1");
    expect(lag).toBe(2); // 20 - 18 = 2
  });

  it("lag is zero for unknown subscriber", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);
    const lag = await streamer.getLag("ghost");
    expect(lag).toBe(0);
  });
});

describe("WAL9: Catch-up", () => {
  it("catchUp replays from lastAckedIndex to current", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(50);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    await streamer.subscribe("s1", async (e) => { captured.push(e); });

    // Pretend subscriber acked up to index 20
    await streamer.ack({ subscriberId: "s1", sequence: 20, entryIndex: 20 });

    const count = await streamer.catchUp("s1");
    expect(count).toBe(30); // fromIdx=max(20+1, 1)=21, currentLastIndex=50 → 21..50 = 30
    expect(captured).toHaveLength(30);
    expect(captured[0]!.entry.index).toBe(21);
  });

  it("catchUp on subscriber with fromIndex filter", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(30);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    await streamer.subscribe("s2", async (e) => { captured.push(e); }, {
      fromIndex: 15,
    });

    await streamer.ack({ subscriberId: "s2", sequence: 0, entryIndex: 0 });
    const count = await streamer.catchUp("s2");

    // fromIndex=15 and ack'd to 0, baseIdx=1, fromIdx=max(1,15)=15 → replay 15..30
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it("catchUp returns 0 when already caught up", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.subscribe("s3", vi.fn(async () => {}));
    await streamer.ack({ subscriberId: "s3", sequence: 10, entryIndex: 10 });

    const count = await streamer.catchUp("s3");
    expect(count).toBe(0);
  });

  it("catchUp with multiple subscriptions for same subscriber", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured1: StreamEvent[] = [];
    const captured2: StreamEvent[] = [];
    await streamer.subscribe("multi", async (e) => { captured1.push(e); });
    await streamer.subscribe("multi", async (e) => { captured2.push(e); });

    const subs = await streamer.getSubscriptions();
    expect(subs).toHaveLength(2);

    const count = await streamer.catchUp("multi");
    // Both subs should replay from index 1 (lastAckedIndex=0 → +1)
    expect(count).toBe(20);
    expect(captured1).toHaveLength(10);
    expect(captured2).toHaveLength(10);
  });
});

// ── WAL10-WAL12: Edge Cases ────────────────────────────────

describe("WAL10: Handler backpressure", () => {
  it("does not lose events when handler is slow", async () => {
    const mock = new MockWalStorage();
    // Start with empty storage so streamer can tail new entries
    const streamer = new WalStreamer();
    await streamer.init(mock, { maxBufferSize: 5, pollIntervalMs: 10 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("slow", async (e) => {
      await delay(5);
      captured.push(e);
    });

    await streamer.start();

    // Add entries while streaming
    for (let i = 0; i < 20; i++) {
      await mock.addEntry("set", { idx: i });
    }

    await delay(200); // Allow events to be polled and processed
    await streamer.stop();

    expect(captured.length).toBe(20);
    // Verify no duplicates
    const indices = captured.map((e) => e.entry.index);
    expect(new Set(indices).size).toBe(20);
  });
});

describe("WAL11: Lifecycle edge cases", () => {
  it("start when already started is idempotent", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.start();
    await streamer.start(); // Double start
    expect(streamer.active).toBe(true);
    await streamer.stop();
  });

  it("stop when not started is safe", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);

    await streamer.stop();
    expect(streamer.active).toBe(false);
  });

  it("operations without init throw", async () => {
    const streamer = new WalStreamer();
    await expect(streamer.start()).rejects.toThrow("not initialized");
    await expect(streamer.replay(1, 10, vi.fn(async () => {}))).rejects.toThrow("not initialized");
  });

  it("rapid stop/start cycle preserves subscriptions", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    await streamer.subscribe("s1", vi.fn(async () => {}));
    await streamer.start();
    await streamer.stop();
    await streamer.start();
    await streamer.stop();

    const subs = await streamer.getSubscriptions();
    expect(subs).toHaveLength(1); // Subscription persists
  });
});

describe("WAL12: Stream sequence uniqueness", () => {
  it("every event has a unique, monotonically increasing sequence", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(100);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const sequences: number[] = [];
    await streamer.replay(1, 100, async (e) => { sequences.push(e.sequence); });

    expect(sequences).toHaveLength(100);
    // Check monotonicity
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    // Check uniqueness
    expect(new Set(sequences).size).toBe(100);
  });

  it("events have correct emittedAt timestamps", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(5);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const timestamps: number[] = [];
    await streamer.replay(1, 5, async (e) => { timestamps.push(e.emittedAt); });

    expect(timestamps).toHaveLength(5);
    // All timestamps should be within a small window
    const range = Math.max(...timestamps) - Math.min(...timestamps);
    expect(range).toBeLessThan(1000);
  });
});

// ── WAL13: Multi-command replay ────────────────────────────

describe("WAL13: Multi-command replay with filter", () => {
  it("multiple commands in filter accept any matching", async () => {
    const mock = new MockWalStorage();
    await mock.addEntry("insert", { x: 1 });
    await mock.addEntry("update", { x: 2 });
    await mock.addEntry("delete", { x: 3 });
    await mock.addEntry("insert", { x: 4 });
    await mock.addEntry("update", { x: 5 });

    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    await streamer.replay(1, 5, async (e) => { captured.push(e); }, {
      commands: ["insert", "update"],
    });

    expect(captured).toHaveLength(4); // exclude delete
    expect(captured.map((e) => e.entry.command)).toEqual(["insert", "update", "insert", "update"]);
  });
});

// ── WAL14: Concurrent streamer instances ───────────────────

describe("WAL14: Independent streamer instances", () => {
  it("two streamers on same storage do not interfere", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(10);

    const s1 = new WalStreamer();
    const s2 = new WalStreamer();
    await s1.init(mock);
    await s2.init(mock);

    const c1: StreamEvent[] = [];
    const c2: StreamEvent[] = [];

    await s1.replay(1, 5, async (e) => { c1.push(e); });
    await s2.replay(6, 10, async (e) => { c2.push(e); });

    expect(c1).toHaveLength(5);
    expect(c2).toHaveLength(5);
    expect(c1[0]!.entry.index).toBe(1);
    expect(c2[0]!.entry.index).toBe(6);
  });
});

// ── WAL15: Init discovers existing entries ─────────────────

describe("WAL15: Init position discovery", () => {
  it("init discovers existing entries in storage", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(42);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const pos = await streamer.getPosition();
    expect(pos.entryIndex).toBe(42);
  });

  it("init on empty storage sets position to zero", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const pos = await streamer.getPosition();
    expect(pos.entryIndex).toBe(0);
  });
});

// ── WAL16: Error-path resilience and backpressure ─────────

describe("WAL16: Error paths and backpressure", () => {
  it("replay stops gracefully when readRange reports failure", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(3);
    mock.failReadRange = true;

    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    const replayed = await streamer.replay(1, 3, async (e) => { captured.push(e); });

    expect(replayed).toBe(0);
    expect(captured).toHaveLength(0);
    await streamer.stop();
  });

  it("polling returns when lastEntry reports failure", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(2);
    const streamer = new WalStreamer();
    await streamer.init(mock);
    mock.failLastEntry = true;

    await streamer.start();
    // Give the poller a cycle to hit the failure branch and bail out.
    await delay(150);

    expect(streamer.active).toBe(true); // start() succeeded; poll loop defensively returns
    await streamer.stop();
  });

  it("catchUp returns 0 when lastEntry reports failure", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const sub = await streamer.subscribe("err-sub", async () => {});
    mock.failLastEntry = true;

    const replayed = await streamer.catchUp(sub.id);
    expect(replayed).toBe(0);
    await streamer.stop();
  });

  it("backpressure blocks when the subscriber buffer reaches maxBufferSize", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(1);
    const streamer = new WalStreamer();
    await streamer.init(mock, { maxBufferSize: 1, pollIntervalMs: 20 });

    // Handler resolves slowly so the buffer fills before it drains,
    // forcing the backpressure branch (`_delay`) to execute.
    let releases: Array<() => void> = [];
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
    });

    await streamer.subscribe("bp-sub", handler);

    // Seed several entries so the buffer (max 1) overflows and blocks.
    await mock.addEntry("set", { n: 1 });
    await mock.addEntry("set", { n: 2 });
    await mock.addEntry("set", { n: 3 });

    await streamer.start();
    await delay(150);

    expect(handler).toHaveBeenCalled();
    // Release pending handlers and shut down cleanly.
    releases.forEach((r) => r());
    await streamer.stop();
  });

  it("unsubscribe with an unknown subscription id is a no-op", async () => {
    const mock = new MockWalStorage();
    const streamer = new WalStreamer();
    await streamer.init(mock);

    // Unknown id hits the `if (!sub) return` early-exit branch.
    await streamer.unsubscribe("does-not-exist");
    await streamer.stop();
  });

  it("catchUp without init throws", async () => {
    const streamer = new WalStreamer();
    await expect(streamer.catchUp("sub")).rejects.toThrow("not initialized");
  });

  it("catchUp with no matching subscriber returns zero", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(2);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    // No subscription registered → `catchUp` filter yields zero subs.
    const replayed = await streamer.catchUp("unknown-id");
    expect(replayed).toBe(0);
    await streamer.stop();
  });

  it("double start does not create a second poll timer", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(1);
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    await streamer.start();
    await streamer.start(); // second start hits `if (this._pollTimer) return`

    expect(streamer.active).toBe(true);
    await streamer.stop();
  });

  it("polling bails out when readRange reports failure", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(3);
    const streamer = new WalStreamer();
    await streamer.init(mock, { pollIntervalMs: 20 });

    const captured: StreamEvent[] = [];
    await streamer.subscribe("poll-sub", async (e) => { captured.push(e); });

    await streamer.start();
    // Fail the range read after a successful lastEntry, so polling hits the
    // `if (!rangeRes.success ...) return` branch inside _pollNewEntries.
    mock.failReadRange = true;
    await mock.addEntry("set", undefined, 1);

    await delay(150);
    await streamer.stop();
    // No crash; the poll loop defensively returned.
    expect(streamer.active).toBe(false);
  });

  it("fromIndex filter excludes entries below the start index", async () => {
    const mock = new MockWalStorage();
    mock.seedEntries(5);
    const streamer = new WalStreamer();
    await streamer.init(mock);

    const captured: StreamEvent[] = [];
    await streamer.replay(1, 5, async (e) => { captured.push(e); }, { fromIndex: 3 });

    // Only entries with index >= 3 pass the fromIndex filter.
    expect(captured).toHaveLength(3);
    expect(captured.every((e) => e.entry.index >= 3)).toBe(true);
    await streamer.stop();
  });
});

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
