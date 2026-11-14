/**
 * InMemorySlowQueryRecorder — branch-completion tests.
 *
 * Targets the `?? 'default'` nullish fallback in getSlowQueries and
 * getRecentSlowQueries:
 *
 *   database: e.shardId ?? 'default'
 *
 * The SlowQueryRecord.database field is declared required, but record()
 * stores it into InternalEntry.shardId which is typed optional. When a
 * caller omits database (defensive boundary), shardId is undefined and the
 * `?? 'default'` fallback keeps the returned record's database a valid
 * string instead of leaking undefined to downstream consumers.
 */

import { describe, it, expect } from "vitest";
import { InMemorySlowQueryRecorder } from "../impl/InMemorySlowQueryRecorder.js";
import type { SlowQueryRecord } from "../interfaces/index.js";

describe("ISQR-branch: database '?? default' fallback", () => {
  it("getSlowQueries defaults a missing database to 'default'", async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    // Omit `database` entirely (record stores shardId = undefined).
    const record = { query: "SELECT 1", durationMs: 200, timestamp: new Date() } as SlowQueryRecord;
    await recorder.record(record);

    const result = await recorder.getSlowQueries(100);
    expect(result).toHaveLength(1);
    expect(result[0].database).toBe("default");
  });

  it("getRecentSlowQueries defaults a missing database to 'default'", async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    await recorder.record({ query: "SELECT 2", durationMs: 300, timestamp: new Date() } as SlowQueryRecord);

    const result = recorder.getRecentSlowQueries();
    expect(result).toHaveLength(1);
    expect(result[0].database).toBe("default");
  });

  it("preserves an explicit database when provided", async () => {
    const recorder = new InMemorySlowQueryRecorder(0);
    await recorder.record({ query: "SELECT 3", durationMs: 150, timestamp: new Date(), database: "prod" });

    const recent = recorder.getRecentSlowQueries();
    expect(recent[0].database).toBe("prod");
  });
});
