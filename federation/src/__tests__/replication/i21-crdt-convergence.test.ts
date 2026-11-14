/**
 * I21 — CRDT Convergence Tests
 *
 * CRT1-CRT3: CRDT Type Unit Tests (GCounter, PNCounter, LWWRegister, MVRegister, ORSet)
 * CRT4-CRT6: Convergence Verifier (associativity, commutativity, idempotence)
 * CRT7-CRT9: AntiEntropy CRDT integration (Merkle tree + CRDT merge)
 * CRT10-CRT12: Edge cases (empty states, rapid cycles, cross-type scenarios)
 */

import { describe, it, expect } from "vitest";
import {
  GCounter,
  PNCounter,
  LWWRegister,
  MVRegister,
  ORSet,
} from "../../replication/crdt-types";
import {
  ConvergenceVerifier,
  SeededRNG,
  countersEqual,
  pnCountersEqual,
  mvRegistersEqual,
  orSetsEqual,
} from "../../replication/crdt-convergence";
import { ConflictResolver } from "../../replication/ConflictResolver";

// ── CRT1-CRT3: CRDT Type Unit Tests ─────────────────────────

describe("CRT1: GCounter", () => {
  it("starts at zero", () => {
    const c = new GCounter();
    expect(c.value()).toBe(0);
  });

  it("increments per node", () => {
    const c = new GCounter();
    c.increment("node-a", 5);
    c.increment("node-b", 3);
    c.increment("node-a", 2);
    expect(c.value()).toBe(10);
    expect(c.toState().counts["node-a"]).toBe(7);
    expect(c.toState().counts["node-b"]).toBe(3);
  });

  it("merges element-wise max", () => {
    const a = new GCounter({ counts: { "n1": 5, "n2": 3 } });
    const b = new GCounter({ counts: { "n1": 3, "n2": 8 } });
    a.merge(b.toState());
    expect(a.toState().counts["n1"]).toBe(5); // max(5, 3)
    expect(a.toState().counts["n2"]).toBe(8); // max(3, 8)
  });

  it("serializes round-trip", () => {
    const original = new GCounter({ counts: { "n1": 10, "n2": 7 } });
    const restored = GCounter.fromState(original.toState());
    expect(restored.value()).toBe(17);
    expect(restored.toState().counts["n1"]).toBe(10);
  });

  it("handles empty merge", () => {
    const c = new GCounter({ counts: { "n1": 42 } });
    c.merge({ counts: {} });
    expect(c.value()).toBe(42);
  });
});

describe("CRT1: PNCounter", () => {
  it("increments and decrements", () => {
    const c = new PNCounter();
    c.increment("n1", 10);
    c.decrement("n1", 3);
    expect(c.value()).toBe(7);
  });

  it("merges P and N independently", () => {
    const a = new PNCounter({ p: { "n1": 10 }, n: { "n1": 2 } });
    const b = new PNCounter({ p: { "n1": 8 }, n: { "n1": 5 } });
    a.merge(b.toState());
    expect(a.toState().p["n1"]).toBe(10); // max(10, 8)
    expect(a.toState().n["n1"]).toBe(5);  // max(2, 5)
    expect(a.value()).toBe(5);
  });

  it("differs from GCounter by supporting decrement", () => {
    const c = new PNCounter();
    c.increment("n1", 5);
    c.decrement("n1", 6);
    expect(c.value()).toBe(-1);
  });

  it("serializes round-trip", () => {
    const original = new PNCounter({ p: { "n1": 7 }, n: { "n1": 3 } });
    const restored = PNCounter.fromState(original.toState());
    expect(restored.value()).toBe(4);
  });
});

describe("CRT2: LWWRegister", () => {
  it("assigns new value with higher HLC", () => {
    const reg = new LWWRegister({
      value: "old",
      hlcWallTime: 100,
      hlcLogical: 0,
      nodeId: "n1",
    });
    reg.assign("new", { wallTime: BigInt(200), logical: 0, nodeId: "n2" } as any);
    expect(reg.value).toBe("new");
    expect(reg.hlcWallTime).toBe(200);
  });

  it("rejects older HLC on assign", () => {
    const reg = new LWWRegister({
      value: "current",
      hlcWallTime: 300,
      hlcLogical: 1,
      nodeId: "n1",
    });
    reg.assign("stale", { wallTime: BigInt(100), logical: 0, nodeId: "n2" } as any);
    expect(reg.value).toBe("current");
  });

  it("tiebreaks by nodeId when HLC equal", () => {
    const reg = new LWWRegister({
      value: "small-node",
      hlcWallTime: 100,
      hlcLogical: 0,
      nodeId: "n1",
    });
    reg.assign("big-node", { wallTime: BigInt(100), logical: 0, nodeId: "n9" } as any);
    expect(reg.value).toBe("big-node"); // n9 > n1
  });

  it("merges with higher-HLC remote", () => {
    const reg = new LWWRegister({
      value: "local",
      hlcWallTime: 50,
      hlcLogical: 0,
      nodeId: "n1",
    });
    reg.merge({ value: "remote", hlcWallTime: 100, hlcLogical: 0, nodeId: "n2" });
    expect(reg.value).toBe("remote");
  });

  it("serializes round-trip", () => {
    const original = new LWWRegister({
      value: "test",
      hlcWallTime: 999,
      hlcLogical: 5,
      nodeId: "n3",
    });
    const restored = LWWRegister.fromState(original.toState());
    expect(restored.value).toBe("test");
    expect(restored.hlcWallTime).toBe(999);
    expect(restored.hlcLogical).toBe(5);
  });
});

describe("CRT2: MVRegister", () => {
  it("assign replaces all values", () => {
    const reg = new MVRegister();
    reg.assign("v1", { wallTime: BigInt(100), logical: 0, nodeId: "n1" } as any);
    reg.assign("v2", { wallTime: BigInt(200), logical: 0, nodeId: "n2" } as any);
    expect(reg.values()).toEqual(["v2"]);
  });

  it("add keeps concurrent values", () => {
    const reg = new MVRegister();
    reg.add("v1", { wallTime: BigInt(100), logical: 0, nodeId: "n1" } as any);
    reg.add("v2", { wallTime: BigInt(100), logical: 0, nodeId: "n2" } as any);
    const vals = reg.values().sort();
    expect(vals).toContain("v1");
    expect(vals).toContain("v2");
  });

  it("prunes causally superseded entries on merge", () => {
    const reg = new MVRegister({
      entries: [
        { value: "old", wallTime: 50, logical: 0, nodeId: "n1" },
        { value: "new", wallTime: 100, logical: 0, nodeId: "n2" },
      ],
    });
    reg.merge({
      entries: [
        { value: "newer", wallTime: 150, logical: 0, nodeId: "n3" },
      ],
    });
    expect(reg.values()).toEqual(["newer"]); // supersedes all
  });

  it("deduplicates identical entries on merge", () => {
    const reg = new MVRegister({
      entries: [
        { value: "a", wallTime: 100, logical: 0, nodeId: "n1" },
      ],
    });
    reg.merge({
      entries: [
        { value: "a", wallTime: 100, logical: 0, nodeId: "n1" },
      ],
    });
    expect(reg.values().length).toBe(1);
  });
});

describe("CRT3: ORSet", () => {
  it("adds and checks membership", () => {
    const set = new ORSet();
    set.add("apple", "tag-1");
    set.add("banana", "tag-2");
    expect(set.contains("apple")).toBe(true);
    expect(set.contains("banana")).toBe(true);
    expect(set.contains("cherry")).toBe(false);
    expect(set.members().sort()).toEqual(["apple", "banana"]);
  });

  it("removes element via tombstone", () => {
    const set = new ORSet();
    set.add("apple", "tag-1");
    set.add("apple", "tag-2");
    set.remove("apple");
    expect(set.contains("apple")).toBe(false);
    expect(set.members()).toEqual([]);
  });

  it("observes remove — add-wins over remove", () => {
    // If a replica removes an element but another concurrently adds it,
    // the add wins because the new tag isn't in the tombstone set.
    const set = new ORSet();
    set.add("apple", "tag-1");
    set.remove("apple");

    // Concurrent add with a new tag
    set.add("apple", "tag-3");
    expect(set.contains("apple")).toBe(true); // tag-3 not tombstoned
  });

  it("merges two ORSets", () => {
    const a = new ORSet();
    a.add("x", "a1");
    a.add("y", "a2");

    const b = new ORSet();
    b.add("y", "b1");
    b.add("z", "b2");

    a.merge(b.toState());
    const members = a.members().sort();
    expect(members).toEqual(["x", "y", "z"]);
    // y has both a2 and b1 tags
    expect(a.toState().elements["y"]!.sort()).toEqual(["a2", "b1"]);
  });

  it("respects tombstones across merge", () => {
    const a = new ORSet();
    a.add("x", "a1");
    a.remove("x"); // tombstoned a1

    const b = new ORSet();
    b.add("x", "b1"); // new tag, not tombstoned

    a.merge(b.toState());
    expect(a.contains("x")).toBe(true); // b1 survives
  });

  it("serializes round-trip", () => {
    const original = new ORSet();
    original.add("a", "t1");
    original.add("a", "t2");
    original.remove("a");
    const restored = ORSet.fromState(original.toState());
    expect(restored.members()).toEqual([]);
    expect(restored.toState().tombstones["a"]!.sort()).toEqual(["t1", "t2"]);
  });
});

// ── CRT4-CRT6: Convergence Verifier ─────────────────────────

describe("CRT4: Convergence — Associativity", () => {
  it("GCounter is associative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const report = verifier.verifyGCounter();
    expect(report.associativeFailed).toBe(0);
    expect(report.associativePassed).toBe(500);
  });

  it("PNCounter is associative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const report = verifier.verifyPNCounter();
    expect(report.associativeFailed).toBe(0);
    expect(report.associativePassed).toBe(500);
  });

  it("LWWRegister is associative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const report = verifier.verifyLWWRegister();
    expect(report.associativeFailed).toBe(0);
    expect(report.associativePassed).toBe(500);
  });

  it("MVRegister is associative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const report = verifier.verifyMVRegister();
    expect(report.associativeFailed).toBe(0);
    expect(report.associativePassed).toBe(500);
  });

  it("ORSet is associative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const report = verifier.verifyORSet();
    expect(report.associativeFailed).toBe(0);
    expect(report.associativePassed).toBe(500);
  });
});

describe("CRT5: Convergence — Commutativity", () => {
  it("GCounter is commutative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(99, 500);
    const report = verifier.verifyGCounter();
    expect(report.commutativeFailed).toBe(0);
    expect(report.commutativePassed).toBe(500);
  });

  it("PNCounter is commutative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(99, 500);
    const report = verifier.verifyPNCounter();
    expect(report.commutativeFailed).toBe(0);
    expect(report.commutativePassed).toBe(500);
  });

  it("LWWRegister is commutative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(99, 500);
    const report = verifier.verifyLWWRegister();
    expect(report.commutativeFailed).toBe(0);
    expect(report.commutativePassed).toBe(500);
  });

  it("MVRegister is commutative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(99, 500);
    const report = verifier.verifyMVRegister();
    expect(report.commutativeFailed).toBe(0);
    expect(report.commutativePassed).toBe(500);
  });

  it("ORSet is commutative (500 trials)", () => {
    const verifier = new ConvergenceVerifier(99, 500);
    const report = verifier.verifyORSet();
    expect(report.commutativeFailed).toBe(0);
    expect(report.commutativePassed).toBe(500);
  });
});

describe("CRT6: Convergence — Idempotence", () => {
  it("GCounter is idempotent (500 trials)", () => {
    const verifier = new ConvergenceVerifier(7, 500);
    const report = verifier.verifyGCounter();
    expect(report.idempotentFailed).toBe(0);
    expect(report.idempotentPassed).toBe(500);
  });

  it("PNCounter is idempotent (500 trials)", () => {
    const verifier = new ConvergenceVerifier(7, 500);
    const report = verifier.verifyPNCounter();
    expect(report.idempotentFailed).toBe(0);
    expect(report.idempotentPassed).toBe(500);
  });

  it("LWWRegister is idempotent (500 trials)", () => {
    const verifier = new ConvergenceVerifier(7, 500);
    const report = verifier.verifyLWWRegister();
    expect(report.idempotentFailed).toBe(0);
    expect(report.idempotentPassed).toBe(500);
  });

  it("MVRegister is idempotent (500 trials)", () => {
    const verifier = new ConvergenceVerifier(7, 500);
    const report = verifier.verifyMVRegister();
    expect(report.idempotentFailed).toBe(0);
    expect(report.idempotentPassed).toBe(500);
  });

  it("ORSet is idempotent (500 trials)", () => {
    const verifier = new ConvergenceVerifier(7, 500);
    const report = verifier.verifyORSet();
    expect(report.idempotentFailed).toBe(0);
    expect(report.idempotentPassed).toBe(500);
  });
});

// ── CRT7-CRT9: AntiEntropy + CRDT Integration ───────────────

describe("CRT7: AntiEntropy with GCounter merge", () => {
  it("converges two diverged GCounters via merge", () => {
    // Simulate two replicas with diverged counters
    const replicaA = new GCounter();
    replicaA.increment("n1", 5);
    replicaA.increment("n1", 3);

    const replicaB = new GCounter();
    replicaB.increment("n1", 2);
    replicaB.increment("n2", 8);

    // AntiEntropy would detect divergence and trigger merge
    replicaA.merge(replicaB.toState());
    replicaB.merge(replicaA.toState());

    // GCounter merge is element-wise max:
    // n1: max(5+3=8, 2) = 8, n2: max(0, 8) = 8 → total 16
    expect(replicaA.value()).toBe(16);
    expect(replicaB.value()).toBe(16);
  });

  it("serialization preserves CRDT semantics through ConflictResolver", async () => {
    const resolver = new ConflictResolver("n1");
    const state: { p: Record<string, number>; n: Record<string, number> } = {
      p: { n1: 5, n2: 3 },
      n: { n1: 1, n2: 0 },
    };

    const local = {
      key: "counter:views",
      value: JSON.stringify({ p: { n1: 5, n2: 3 }, n: { n1: 1, n2: 0 } }),
      hlc: { wallTime: BigInt(100), logical: 0, nodeId: "n1" } as any,
      nodeId: "n1",
    };

    const remote = {
      key: "counter:views",
      value: JSON.stringify({ p: { n1: 3, n2: 7 }, n: { n1: 0, n2: 0 } }),
      hlc: { wallTime: BigInt(100), logical: 1, nodeId: "n2" } as any,
      nodeId: "n2",
    };

    const result = await resolver.resolve("counter:views", local, remote, "crdt-counter");
    expect(result.merged).toBe(true);
    const resolved = JSON.parse(result.resolvedValue);
    // n1: max(5, 3) = 5, n2: max(3, 7) = 7
    expect(resolved.p.n1).toBe(5);
    expect(resolved.p.n2).toBe(7);
  });
});

describe("CRT8: AntiEntropy with ORSet merge", () => {
  it("detects tombstones across replicas", async () => {
    // ORSet with two replicas — both added bob, one removed bob
    // After merge: bob's tags are partially tombstoned, partially active
    const resolver = new ConflictResolver("n1");

    const localSet = new ORSet();
    localSet.add("user:alice", "n1-t1");
    localSet.add("user:bob", "n1-t2");

    const remoteSet = new ORSet();
    remoteSet.add("user:alice", "n2-t1");
    remoteSet.add("user:bob", "n2-t1");
    remoteSet.add("user:charlie", "n2-t2");
    remoteSet.remove("user:bob"); // tombstoned n2-t1 only

    const local = {
      key: "set:users",
      value: JSON.stringify(localSet.toState()),
      hlc: { wallTime: BigInt(100), logical: 0, nodeId: "n1" } as any,
      nodeId: "n1",
    };

    const remote = {
      key: "set:users",
      value: JSON.stringify(remoteSet.toState()),
      hlc: { wallTime: BigInt(100), logical: 1, nodeId: "n2" } as any,
      nodeId: "n2",
    };

    const result = await resolver.resolve("set:users", local, remote, "crdt-set");
    expect(result.merged).toBe(true);

    const resolved: any = JSON.parse(result.resolvedValue);
    expect(resolved.elements["user:alice"]).toBeDefined();
    expect(resolved.elements["user:charlie"]).toBeDefined();
    // bob: n2-t1 is tombstoned, n1-t2 is still active → bob survives partially
    const bobTags = resolved.elements["user:bob"] ?? [];
    const bobTOMBS = resolved.tombstones["user:bob"] ?? [];
    const activeBobTags = bobTags.filter((t: string) => !bobTOMBS.includes(t));
    expect(activeBobTags.length).toBe(1); // n1-t2 survives
  });

  it("concurrent add-wins over remove", () => {
    const set1 = new ORSet();
    set1.add("item-x", "t-a");

    const set2 = new ORSet();
    set2.add("item-x", "t-a");
    set2.remove("item-x"); // remove t-a
    set2.add("item-x", "t-b"); // concurrent re-add with new tag

    // Merge both directions
    set1.merge(set2.toState());
    expect(set1.contains("item-x")).toBe(true); // t-b not in tombstones
  });
});

describe("CRT9: MVRegister — LWW-only register", () => {
  it("converges to single value when HLCs are comparable", () => {
    const reg1 = new MVRegister();
    reg1.add("val-a", { wallTime: BigInt(100), logical: 1, nodeId: "n1" } as any);

    const reg2 = new MVRegister();
    reg2.add("val-b", { wallTime: BigInt(200), logical: 0, nodeId: "n2" } as any);

    // Merge — val-b supersedes val-a
    reg1.merge(reg2.toState());
    expect(reg1.values()).toEqual(["val-b"]);
  });

  it("keeps all concurrent values when HLCs are incomparable", () => {
    const reg1 = new MVRegister();
    reg1.add("val-a", { wallTime: BigInt(100), logical: 0, nodeId: "n1" } as any);

    const reg2 = new MVRegister();
    reg2.add("val-b", { wallTime: BigInt(100), logical: 0, nodeId: "n2" } as any);

    reg1.merge(reg2.toState());
    const vals = reg1.values().sort();
    expect(vals).toContain("val-a");
    expect(vals).toContain("val-b");
    expect(vals.length).toBe(2);
  });
});

// ── CRT10-CRT12: Edge Cases ─────────────────────────────────

describe("CRT10: Empty state convergence", () => {
  it("GCounter handles empty state gracefully", () => {
    const c = new GCounter();
    c.merge({ counts: {} });
    expect(c.value()).toBe(0);
  });

  it("PNCounter handles empty merge", () => {
    const c = new PNCounter();
    c.merge({ p: {}, n: {} });
    expect(c.value()).toBe(0);
  });

  it("ORSet handles empty merge", () => {
    const s = new ORSet();
    s.merge({ elements: {}, tombstones: {} });
    expect(s.members()).toEqual([]);
  });

  it("MVRegister handles empty merge", () => {
    const r = new MVRegister();
    r.merge({ entries: [] });
    expect(r.values()).toEqual([]);
  });
});

describe("CRT11: Rapid merge cycles", () => {
  it("GCounter stable after 100 rapid merges", () => {
    const c = new GCounter({ counts: { n1: 42 } });
    for (let i = 0; i < 100; i++) {
      c.merge({ counts: { n1: 42, n2: 7 } });
    }
    expect(c.toState().counts["n1"]).toBe(42);
    expect(c.toState().counts["n2"]).toBe(7);
  });

  it("ORSet stable after 100 rapid merges", () => {
    const s = new ORSet();
    s.add("x", "t1");
    for (let i = 0; i < 100; i++) {
      s.merge({ elements: { x: ["t1"] }, tombstones: {} });
    }
    expect(s.members()).toEqual(["x"]);
  });

  it("LWWRegister stable after 100 rapid same-value merges", () => {
    const r = new LWWRegister({
      value: "stable", hlcWallTime: 100, hlcLogical: 0, nodeId: "n1",
    });
    for (let i = 0; i < 100; i++) {
      r.merge({ value: "stable", hlcWallTime: 100, hlcLogical: 0, nodeId: "n1" });
    }
    expect(r.value).toBe("stable");
  });
});

describe("CRT12: SeededRNG determinism", () => {
  it("produces same sequence for same seed", () => {
    const rng1 = new SeededRNG(42);
    const rng2 = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = new SeededRNG(42);
    const rng2 = new SeededRNG(99);
    let diffCount = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1.next() !== rng2.next()) diffCount++;
    }
    expect(diffCount).toBeGreaterThan(0);
  });

  it("int generates values within range", () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 200; i++) {
      const v = rng.int(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});

// ── Convergence summary test ─────────────────────────────────

describe("CRT13: Full Convergence Report", () => {
  it("all 5 CRDT types pass all 3 laws (500 trials each)", () => {
    const verifier = new ConvergenceVerifier(42, 500);
    const reports = verifier.verifyAll();

    for (const [crdtType, report] of Object.entries(reports)) {
      // All laws must pass 100%
      expect(report.associativePassed, `${crdtType} associativity`).toBe(500);
      expect(report.associativeFailed, `${crdtType} associativity`).toBe(0);
      expect(report.commutativePassed, `${crdtType} commutativity`).toBe(500);
      expect(report.commutativeFailed, `${crdtType} commutativity`).toBe(0);
      expect(report.idempotentPassed, `${crdtType} idempotence`).toBe(500);
      expect(report.idempotentFailed, `${crdtType} idempotence`).toBe(0);
      expect(report.failures).toEqual([]);
    }
  });
});

// ── CRT14: CRDT State Equivalence Helpers ───────────────────

describe("CRT14: CRDT state equivalence helpers", () => {
  it("countersEqual returns true for equal counts and false for differing ones", () => {
    const a = new GCounter({ counts: { n1: 5, n2: 3 } });
    const b = new GCounter({ counts: { n1: 5, n2: 3 } });
    expect(countersEqual(a, b)).toBe(true);

    const c = new GCounter({ counts: { n1: 5, n2: 8 } });
    expect(countersEqual(a, c)).toBe(false); // differing count
    expect(countersEqual(a, new GCounter({ counts: { n1: 5 } }))).toBe(false); // b missing n2
    // Reverse direction: a missing a key that b has (exercises a.counts[k] ?? 0).
    expect(countersEqual(new GCounter({ counts: { n1: 5 } }), b)).toBe(false);
  });

  it("pnCountersEqual detects differences in either p or n", () => {
    const a = new PNCounter({ p: { n1: 10 }, n: { n1: 2 } });
    const b = new PNCounter({ p: { n1: 10 }, n: { n1: 2 } });
    expect(pnCountersEqual(a, b)).toBe(true);

    const pDiff = new PNCounter({ p: { n1: 11 }, n: { n1: 2 } });
    expect(pnCountersEqual(a, pDiff)).toBe(false);

    const nDiff = new PNCounter({ p: { n1: 10 }, n: { n1: 3 } });
    expect(pnCountersEqual(a, nDiff)).toBe(false);

    // Missing-key directions exercise the `?? 0` nullish branches.
    expect(pnCountersEqual(new PNCounter({ p: { n1: 10 }, n: {} }), b)).toBe(false); // a.n missing n1
    expect(pnCountersEqual(new PNCounter({ p: {}, n: { n1: 2 } }), b)).toBe(false); // a.p missing n1
    expect(pnCountersEqual(a, new PNCounter({ p: { n1: 10 }, n: {} }))).toBe(false); // b.n missing n1
    expect(pnCountersEqual(a, new PNCounter({ p: {}, n: { n1: 2 } }))).toBe(false); // b.p missing n1
  });

  it("mvRegistersEqual detects both size mismatch and value mismatch", () => {
    const a = new MVRegister({ entries: [{ value: "x", wallTime: 1, logical: 0, nodeId: "n1" }] });
    const b = new MVRegister({ entries: [{ value: "x", wallTime: 1, logical: 0, nodeId: "n1" }] });
    expect(mvRegistersEqual(a, b)).toBe(true);

    // Different value (same size)
    const c = new MVRegister({ entries: [{ value: "y", wallTime: 1, logical: 0, nodeId: "n1" }] });
    expect(mvRegistersEqual(a, c)).toBe(false);

    // Different size
    const d = new MVRegister({
      entries: [
        { value: "x", wallTime: 1, logical: 0, nodeId: "n1" },
        { value: "z", wallTime: 1, logical: 0, nodeId: "n1" },
      ],
    });
    expect(mvRegistersEqual(a, d)).toBe(false);
  });

  it("orSetsEqual detects size mismatch and membership mismatch", () => {
    const a = new ORSet();
    a.add("apple", "t1");
    a.add("banana", "t2");

    const b = new ORSet();
    b.add("apple", "t1");
    b.add("banana", "t2");
    expect(orSetsEqual(a, b)).toBe(true);

    // Membership mismatch (same size, different element)
    const c = new ORSet();
    c.add("apple", "t1");
    c.add("cherry", "t2");
    expect(orSetsEqual(a, c)).toBe(false);

    // Size mismatch
    const d = new ORSet();
    d.add("apple", "t1");
    expect(orSetsEqual(a, d)).toBe(false);
  });
});

// ── CRT15: Fault Detection (dependency-injected violating merge) ──
//
// The verifier's core value is two-sided: it must PASS correct CRDTs *and*
// FAIL violating ones. The failure-report branches (`associativeFailed++`,
// `commutativeFailed++`, `idempotentFailed++`, `failures.push`) are physically
// unreachable with the real CRDTs (each provably satisfies all three laws).
// To exercise them honestly — without faking coverage — we inject a
// deliberately law-violating merge per CRDT type and assert the verifier
// correctly reports the violation.

describe("CRT15: verifier detects law-violating merges", () => {
  // Each fault merge uses a monotonic counter to inject a unique, order-
  // dependent mutation on every call — breaking idempotence, commutativity and
  // associativity simultaneously (non-symmetric + non-idempotent + non-assoc).
  const makeFaults = () => {
    let n = 0;
    return {
      GCounter: (self: any, _other: any): void => {
        self.counts[`fault#${++n}`] = 1;
      },
      PNCounter: (self: any, _other: any): void => {
        self.increment(`fault#${++n}`, 1);
      },
      LWWRegister: (self: any, _other: any): void => {
        self.value = `${self.value}#${++n}`;
      },
      MVRegister: (self: any, _other: any): void => {
        self.entries.push({ value: `fault#${++n}`, wallTime: 100000 + n, logical: 0, nodeId: "fault" });
      },
      ORSet: (self: any, _other: any): void => {
        self.add(`fault#${++n}`, `ft${n}`);
      },
    };
  };

  const types = ["GCounter", "PNCounter", "LWWRegister", "MVRegister", "ORSet"] as const;
  const verify = {
    GCounter: (v: ConvergenceVerifier) => v.verifyGCounter(),
    PNCounter: (v: ConvergenceVerifier) => v.verifyPNCounter(),
    LWWRegister: (v: ConvergenceVerifier) => v.verifyLWWRegister(),
    MVRegister: (v: ConvergenceVerifier) => v.verifyMVRegister(),
    ORSet: (v: ConvergenceVerifier) => v.verifyORSet(),
  };

  for (const type of types) {
    it(`${type}: reports associativity, commutativity and idempotence violations`, () => {
      const verifier = new ConvergenceVerifier(42, 50, { [type]: makeFaults()[type] });
      const report = verify[type](verifier);

      expect(report.associativeFailed, "associativity").toBeGreaterThan(0);
      expect(report.commutativeFailed, "commutativity").toBeGreaterThan(0);
      expect(report.idempotentFailed, "idempotence").toBeGreaterThan(0);

      // Each violated law must leave a corresponding failure entry.
      const laws = report.failures.map((f) => f.law);
      expect(laws).toContain("associativity");
      expect(laws).toContain("commutativity");
      expect(laws).toContain("idempotence");
    });
  }

  it("reports zero failures for the real merges (sanity)", () => {
    const verifier = new ConvergenceVerifier(42, 200);
    const report = verifier.verifyGCounter();
    expect(report.associativeFailed).toBe(0);
    expect(report.commutativeFailed).toBe(0);
    expect(report.idempotentFailed).toBe(0);
    expect(report.failures).toEqual([]);
  });
});
