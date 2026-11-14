/**
 * ConflictResolver Tests — AC 44.1–44.4
 *
 * AC 44.1 — LWW selects larger HLC timestamp
 * AC 44.2 — LWW tiebreak: equal HLC → larger nodeId wins
 * AC 44.3 — CRDT merge for counter/set/map
 * AC 44.4 — Custom resolver registration and dispatch
 *     — Custom resolver priority over default
 *     — Custom resolver on table prefix
 */

import { describe, it, expect } from "vitest";
import { ConflictResolver, type ConflictValue, type CustomResolver, type ConflictResult } from "./ConflictResolver";
import { HLC, makeHLC } from "../hlc/HLC";

function hlcTs(wallTime: number, logical: number, nodeId: string) {
  return makeHLC(wallTime, logical, nodeId);
}

/** Helper: create a ConflictValue from wall/logical/nodeId/value */
function val(wallTime: number, logical: number, nodeId: string, value: string): ConflictValue {
  return {
    key: "test-key",
    value,
    hlc: hlcTs(wallTime, logical, nodeId),
    nodeId,
  };
}

describe("ConflictResolver — AC 44.1: LWW selects larger HLC", () => {
  const resolver = new ConflictResolver("local-node");

  it("should resolve to remote when remote has larger HLC", async () => {
    const local = val(100, 1, "node-a", "local-value");
    const remote = val(200, 1, "node-b", "remote-value");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("remote-value");
    expect(result.strategyUsed).toBe("lww");
    expect(result.loserNodeIds).toEqual(["node-a"]);
    expect(result.merged).toBe(false);
  });

  it("should resolve to local when local has larger HLC", async () => {
    const local = val(300, 1, "node-a", "local-value");
    const remote = val(100, 1, "node-b", "remote-value");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("local-value");
    expect(result.loserNodeIds).toEqual(["node-b"]);
  });

  it("should respect logical clock ordering within same wall time", async () => {
    const local = val(100, 5, "node-a", "local-value");
    const remote = val(100, 3, "node-b", "remote-value");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("local-value"); // local has higher logical
  });
});

describe("ConflictResolver — AC 44.2: LWW tiebreak by nodeId", () => {
  const resolver = new ConflictResolver("local-node");

  it("should resolve to larger nodeId when HLC is equal", async () => {
    const local = val(100, 1, "node-a", "local-value");
    const remote = val(100, 1, "node-z", "remote-value");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("remote-value"); // node-z > node-a
  });

  it("should handle nodeId tiebreak in reverse order", async () => {
    const local = val(100, 1, "node-z", "local-value");
    const remote = val(100, 1, "node-a", "remote-value");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("local-value"); // node-z > node-a
  });

  it("should handle equal HLC with same nodeId (edge case)", async () => {
    const local = val(100, 1, "same-node", "local-val");
    const remote = val(100, 1, "same-node", "remote-val");

    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("remote-val"); // remote wins on tiebreak (same node, else branch)
  });
});

describe("ConflictResolver — AC 44.3: CRDT Counter", () => {
  const resolver = new ConflictResolver("n1");

  it("should merge PN-Counters correctly", async () => {
    // Node A incremented 5 times, Node B incremented 3 times
    const local: ConflictValue = {
      key: "counter-x",
      value: JSON.stringify({ p: { "node-a": 5 }, n: {} }),
      hlc: hlcTs(100, 1, "node-a"),
      nodeId: "node-a",
    };
    const remote: ConflictValue = {
      key: "counter-x",
      value: JSON.stringify({ p: { "node-b": 3 }, n: {} }),
      hlc: hlcTs(100, 2, "node-b"),
      nodeId: "node-b",
    };

    const result = await resolver.resolve("counter-x", local, remote, "crdt-counter");
    expect(result.strategyUsed).toBe("crdt-counter");
    expect(result.merged).toBe(true);
    expect(result.loserNodeIds.length).toBeGreaterThan(0);

    const merged = JSON.parse(result.resolvedValue);
    expect(merged.p["node-a"]).toBe(5);
    expect(merged.p["node-b"]).toBe(3);
  });

  it("should take max per-node P on conflict", async () => {
    const local = {
      key: "counter-y",
      value: JSON.stringify({ p: { "n1": 10, "n2": 3 }, n: {} }),
      hlc: hlcTs(100, 1, "n1"),
      nodeId: "n1",
    };
    const remote = {
      key: "counter-y",
      value: JSON.stringify({ p: { "n2": 7, "n3": 2 }, n: {} }),
      hlc: hlcTs(100, 2, "n2"),
      nodeId: "n2",
    };

    const result = await resolver.resolve("counter-y", local, remote, "crdt-counter");
    const merged = JSON.parse(result.resolvedValue);
    expect(merged.p["n1"]).toBe(10);
    expect(merged.p["n2"]).toBe(7); // max(3, 7) = 7
    expect(merged.p["n3"]).toBe(2);
  });

  it("should fallback to LWW on invalid CRDT state", async () => {
    const local = val(100, 1, "n1", "not-json-counter");
    const remote = val(50, 1, "n2", "not-json-counter");

    const result = await resolver.resolve("counter-z", local, remote, "crdt-counter");
    expect(result.strategyUsed).toBe("lww"); // fallback
    expect(result.resolvedValue).toBe("not-json-counter"); // local (100 > 50)
  });
});

describe("ConflictResolver — AC 44.3: CRDT Set (OR-Set)", () => {
  const resolver = new ConflictResolver("n1");

  it("should merge OR-Sets correctly", async () => {
    const local: ConflictValue = {
      key: "set-x",
      value: JSON.stringify({
        elements: { "a": ["tag:a1", "tag:a2"], "b": ["tag:b1"] },
        tombstones: {},
      }),
      hlc: hlcTs(100, 1, "n1"),
      nodeId: "n1",
    };
    const remote: ConflictValue = {
      key: "set-x",
      value: JSON.stringify({
        elements: { "b": ["tag:b2"], "c": ["tag:c1"] },
        tombstones: { "a": ["tag:a1"] },
      }),
      hlc: hlcTs(100, 2, "n2"),
      nodeId: "n2",
    };

    const result = await resolver.resolve("set-x", local, remote, "crdt-set");
    expect(result.strategyUsed).toBe("crdt-set");
    expect(result.merged).toBe(true);

    const merged = JSON.parse(result.resolvedValue);
    // "a" had tags [a1, a2]; a1 is tombstoned, a2 is still active → keep
    expect(merged.elements["a"]).toEqual(["tag:a2"]);
    // "b" has tags [b1] + [b2] = [b1, b2]
    expect(merged.elements["b"].sort()).toEqual(["tag:b1", "tag:b2"]);
    // "c" is new
    expect(merged.elements["c"]).toEqual(["tag:c1"]);
  });
});

describe("ConflictResolver — AC 44.3: CRDT Map", () => {
  const resolver = new ConflictResolver("n1");

  it("should merge CRDT Map with counters and sets", async () => {
    const local: ConflictValue = {
      key: "map-x",
      value: JSON.stringify({
        counters: { "visits": { p: { "n1": 5 }, n: {} } },
        sets: { "tags": { elements: { "urgent": ["tag:u1"] }, tombstones: {} } },
      }),
      hlc: hlcTs(100, 1, "n1"),
      nodeId: "n1",
    };
    const remote: ConflictValue = {
      key: "map-x",
      value: JSON.stringify({
        counters: { "visits": { p: { "n2": 3 }, n: {} } },
        sets: { "tags": { elements: { "low-pri": ["tag:l1"] }, tombstones: {} } },
      }),
      hlc: hlcTs(100, 1, "n2"),
      nodeId: "n2",
    };

    const result = await resolver.resolve("map-x", local, remote, "crdt-map");
    expect(result.strategyUsed).toBe("crdt-map");
    expect(result.merged).toBe(true);

    const merged = JSON.parse(result.resolvedValue);
    expect(merged.counters.visits.p["n1"]).toBe(5);
    expect(merged.counters.visits.p["n2"]).toBe(3);
    expect(merged.sets.tags.elements.urgent).toEqual(["tag:u1"]);
    expect(merged.sets.tags.elements["low-pri"]).toEqual(["tag:l1"]);
  });
});

describe("ConflictResolver — AC 44.4: Custom Resolver", () => {
  it("should dispatch to registered custom resolver", async () => {
    const resolver = new ConflictResolver("n1");

    const customFn: CustomResolver = async (_key, _local, _remote) => ({
      resolvedValue: "custom-resolved",
      strategyUsed: "custom",
      loserNodeIds: [_local.nodeId, _remote.nodeId],
      merged: true,
    });

    resolver.registerCustomResolver({ tableName: "orders" }, customFn);

    const local = val(100, 1, "n1", "local");
    const remote = val(200, 1, "n2", "remote");
    const result = await resolver.resolve("orders:123", local, remote, "lww");

    expect(result.strategyUsed).toBe("custom");
    expect(result.resolvedValue).toBe("custom-resolved");
  });

  it("should fallback to default strategy when no custom resolver matches", async () => {
    const resolver = new ConflictResolver("n1");

    const customFn: CustomResolver = async (_key, _local, _remote) => ({
      resolvedValue: "custom",
      strategyUsed: "custom",
      loserNodeIds: [],
      merged: false,
    });

    resolver.registerCustomResolver({ tableName: "orders" }, customFn);

    const local = val(100, 1, "n1", "local");
    const remote = val(200, 1, "n2", "remote");

    // Key "users:456" does not match "orders" table
    const result = await resolver.resolve("users:456", local, remote, "lww");
    expect(result.strategyUsed).toBe("lww");
    expect(result.resolvedValue).toBe("remote");
  });

  it("should unregister custom resolver", async () => {
    const resolver = new ConflictResolver("n1");

    const customFn: CustomResolver = async () => ({
      resolvedValue: "custom",
      strategyUsed: "custom",
      loserNodeIds: [],
      merged: false,
    });

    resolver.registerCustomResolver({ tableName: "products" }, customFn);
    resolver.unregisterCustomResolver({ tableName: "products" });

    const local = val(100, 1, "n1", "local");
    const remote = val(200, 1, "n2", "remote");
    const result = await resolver.resolve("products:1", local, remote, "lww");

    expect(result.strategyUsed).toBe("lww");
  });

  it("should support keyPrefix matching", async () => {
    const resolver = new ConflictResolver("n1");

    const customFn: CustomResolver = async () => ({
      resolvedValue: "prefix-match",
      strategyUsed: "custom",
      loserNodeIds: [],
      merged: false,
    });

    resolver.registerCustomResolver({ keyPrefix: "widgets" }, customFn);

    const local = val(100, 1, "n1", "local");
    const remote = val(200, 1, "n2", "remote");
    const result = await resolver.resolve("widgets/xyz", local, remote, "lww");

    expect(result.resolvedValue).toBe("prefix-match");
  });

  it("should register multiple custom resolvers with different tables", async () => {
    const resolver = new ConflictResolver("n1");

    const tableAResolver: CustomResolver = async () => ({
      resolvedValue: "table-a",
      strategyUsed: "custom",
      loserNodeIds: [],
      merged: false,
    });
    const tableBResolver: CustomResolver = async () => ({
      resolvedValue: "table-b",
      strategyUsed: "custom",
      loserNodeIds: [],
      merged: false,
    });

    resolver.registerCustomResolver({ tableName: "table_a" }, tableAResolver);
    resolver.registerCustomResolver({ tableName: "table_b" }, tableBResolver);

    const local = val(100, 1, "n1", "v1");
    const remote = val(50, 1, "n2", "v2");

    const r1 = await resolver.resolve("table_a:1", local, remote, "lww");
    expect(r1.resolvedValue).toBe("table-a");

    const r2 = await resolver.resolve("table_b:1", local, remote, "lww");
    expect(r2.resolvedValue).toBe("table-b");
  });
});

describe("ConflictResolver — Edge Cases", () => {
  it("should handle empty values", async () => {
    const resolver = new ConflictResolver("n1");
    const local = val(100, 1, "n1", "");
    const remote = val(50, 1, "n2", "");
    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("");
  });

  it("should handle identical local and remote", async () => {
    const resolver = new ConflictResolver("n1");
    const local = val(100, 1, "n1", "same");
    const remote = val(100, 1, "n1", "same");
    const result = await resolver.resolve("key", local, remote, "lww");
    expect(result.resolvedValue).toBe("same");
  });
});
