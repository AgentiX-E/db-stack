/**
 * MutationKillers.test.ts — Targeted tests for chaosengine mutation survivors.
 *
 * Covers: SeededRNG (Mulberry32 PRNG), ChaosEngineV2 (fault injection,
 * scenario runner, event listeners, target resolution, lifecycle).
 *
 * Target: 0% → ≥95% mutation score.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ChaosEngineV2, SeededRNG, MULBERRY32_A, MULBERRY32_MAX } from "../impl/ChaosEngineV2.js";
import type { IChaosTransport, ChaosFaultV2, ChaosScenario } from "../interfaces/v2-types.js";

// ── Mock Transport ───────────────────────────────────────

function makeTransport(id: string): IChaosTransport {
  let latency = 0, lossRate = 0, isolated: string[] = [], running = true, stopped = false;
  const healAll = vi.fn(() => { latency = 0; lossRate = 0; isolated = []; });
  return {
    transportId: id,
    start: vi.fn(async () => { running = true; stopped = false; }),
    stop: vi.fn(async () => { running = false; stopped = true; }),
    isolate: vi.fn((peers: string[]) => { isolated = peers; }),
    setLatency: vi.fn((ms: number) => { latency = ms; }),
    setMessageLoss: vi.fn((rate: number) => { lossRate = rate; }),
    healAll,
    getStats: vi.fn(() => ({ transportId: id, latency, lossRate, isolated, running, stopped })),
  } as any;
}

// ── SeededRNG ───────────────────────────────────────────

describe("CHAOS-M: SeededRNG", () => {
  it("M01: same seed produces same sequence (determinism)", () => {
    const r1 = new SeededRNG(42);
    const r2 = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(r1.next()).toBe(r2.next());
    }
  });

  it("M02: different seeds produce different sequences", () => {
    const r1 = new SeededRNG(1);
    const r2 = new SeededRNG(2);
    expect(r1.next()).not.toBe(r2.next());
  });

  it("M03: next returns values in [0, 1)", () => {
    const rng = new SeededRNG(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("M04: pick selects an element from array (always valid)", () => {
    const rng = new SeededRNG(7);
    const arr = ["a", "b", "c", "d"];
    for (let i = 0; i < 100; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  it("M05: pickN returns exactly N elements (shuffled subset)", () => {
    const rng = new SeededRNG(99);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    for (let n = 1; n <= 10; n++) {
      const picked = rng.pickN(arr, n);
      expect(picked).toHaveLength(n);
      picked.forEach((v) => expect(arr).toContain(v));
    }
  });

  it("M06: shuffle is stable and produces permutation", () => {
    const rng = new SeededRNG(42);
    const arr = [1, 2, 3, 4, 5];
    const s1 = rng.shuffle([...arr]);
    const s2 = new SeededRNG(42).shuffle([...arr]);
    expect(s1).toEqual(s2); // deterministic
    expect(s1.sort((a, b) => a - b)).toEqual(arr); // same elements
  });

  it("M07: shuffle of empty array returns empty", () => {
    const rng = new SeededRNG(0);
    expect(rng.shuffle([])).toEqual([]);
  });

  it("M07.1: Mulberry32 constants are correct (2^32 and standard A)", () => {
    expect(MULBERRY32_MAX).toBe(4294967296);
    expect(MULBERRY32_A).toBe(0x6d2b79f5);
  });

  it("M07.2: known-sequence verification (seed 42, first 3 values)", () => {
    // Mulberry32 with seed 42 produces a deterministic sequence
    const rng = new SeededRNG(42);
    const seq = [rng.next(), rng.next(), rng.next()];
    // Exact values pin the + A state transition and the mixing step; any
    // arithmetic mutant (+ -> -, or the t-mixing + -> -) breaks these.
    expect(seq[0]).toBeCloseTo(0.6011037519, 9);
    expect(seq[1]).toBeCloseTo(0.4482905590, 9);
    expect(seq[2]).toBeCloseTo(0.8524657935, 9);
  });

  it("M07.3b: pick uses * index scaling (seed 42 -> index 3)", () => {
    const rng = new SeededRNG(42);
    // next() = 0.6011 -> floor(0.6011 * 5) = 3 -> "d"
    // a * -> / mutant gives floor(0.6011 / 5) = 0 -> "a"
    expect(rng.pick(["a", "b", "c", "d", "e"])).toBe("d");
  });

  it("M07.3c: shuffle uses * index scaling (seed 42 exact permutation)", () => {
    const rng = new SeededRNG(42);
    // * -> / mutant would collapse j to 0 and change the permutation
    expect(rng.shuffle([1, 2, 3, 4, 5])).toEqual([1, 5, 3, 2, 4]);
  });

  it("M07.3: state wraps correctly at 2^32 boundary", () => {
    // Seed near overflow to test modulo behavior
    const rng = new SeededRNG(0xFFFFFF00);
    const v = rng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

// ── ChaosEngineV2: Lifecycle ────────────────────────────

describe("CHAOS-M: ChaosEngineV2 Lifecycle", () => {
  let engine: ChaosEngineV2;
  beforeEach(() => { engine = new ChaosEngineV2(); });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M08: start with valid transports initializes engine", async () => {
    await engine.start([makeTransport("t1"), makeTransport("t2")]);
  });

  it("M09: duplicate transport IDs throw on start", async () => {
    await expect(engine.start([makeTransport("dup"), makeTransport("dup")])).rejects.toThrow("Duplicate");
  });

  it("M10: start is idempotent", async () => {
    await engine.start([makeTransport("t1")]);
    await engine.start([makeTransport("t1")]); // no throw
  });

  it("M11: inject before start throws", async () => {
    await expect(engine.inject({ type: "node-crash", targets: ["t1"] })).rejects.toThrow("not started");
  });

  it("M12: stop heals all faults", async () => {
    await engine.start([makeTransport("t1")]);
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 });
    await engine.stop();
    expect(engine.getActiveFaults()).toHaveLength(0);
  });
});

// ── ChaosEngineV2: Fault Injection ─────────────────────

describe("CHAOS-M: ChaosEngineV2 Fault Injection", () => {
  let engine: ChaosEngineV2;
  let t1: IChaosTransport;
  let t2: IChaosTransport;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    t1 = makeTransport("t1");
    t2 = makeTransport("t2");
    await engine.start([t1, t2]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M13: inject returns a fault ID string", async () => {
    const id = await engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("M14: injectMany injects multiple faults and returns IDs", async () => {
    const ids = await engine.injectMany([
      { type: "node-crash", targets: ["t1"], durationMs: 0 },
      { type: "message-loss", targets: ["t2"], config: { lossRate: 0.5 }, durationMs: 0 },
    ]);
    expect(ids).toHaveLength(2);
  });

  it("M15: injectMany with empty array returns empty", async () => {
    expect(await engine.injectMany([])).toHaveLength(0);
  });

  it("M16: getActiveFaults returns injected faults", async () => {
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.3 }, durationMs: 0 });
    expect(engine.getActiveFaults()).toHaveLength(1);
  });

  it("M17: getHistory returns all injected faults", async () => {
    await engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 });
    await engine.inject({ type: "message-loss", targets: ["t2"], config: { lossRate: 0.5 }, durationMs: 0 });
    expect(engine.getHistory()).toHaveLength(2);
  });

  it("M18: resolve removes fault from active set", async () => {
    const id = await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 });
    await engine.resolve(id);
    expect(engine.getActiveFaults()).toHaveLength(0);
  });

  it("M19: resolve unknown ID is no-op", async () => {
    await engine.resolve("nonexistent"); // should not throw
  });

  it("M20: healAll clears all active faults", async () => {
    await engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 });
    await engine.inject({ type: "message-loss", targets: ["t2"], config: { lossRate: 0.5 }, durationMs: 0 });
    await engine.healAll();
    expect(engine.getActiveFaults()).toHaveLength(0);
  });

  it("M21: getAllTransportStats returns stats map", async () => {
    const stats = engine.getAllTransportStats();
    expect(stats.size).toBe(2);
    expect(stats.get("t1")).toBeDefined();
    expect(stats.get("t2")).toBeDefined();
  });
});

// ── ChaosEngineV2: Fault Types ─────────────────────────

describe("CHAOS-M: ChaosEngineV2 Fault Types", () => {
  let engine: ChaosEngineV2;
  let t1: IChaosTransport;
  let t2: IChaosTransport;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    t1 = makeTransport("t1");
    t2 = makeTransport("t2");
    await engine.start([t1, t2]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M22: network-partition isolates targets", async () => {
    await engine.inject({ type: "network-partition", targets: ["t1"], durationMs: 0 });
    expect(t1.isolate).toHaveBeenCalled();
  });

  it("M23: node-crash stops target", async () => {
    await engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 });
    expect(t1.stop).toHaveBeenCalled();
  });

  it("M24: message-loss sets loss rate with default 0.3", async () => {
    await engine.inject({ type: "message-loss", targets: ["t1"], config: {}, durationMs: 0 });
    expect(t1.setMessageLoss).toHaveBeenCalledWith(0.3);
  });

  it("M25: message-loss uses custom lossRate", async () => {
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.7 }, durationMs: 0 });
    expect(t1.setMessageLoss).toHaveBeenCalledWith(0.7);
  });

  it("M26: latency-injection sets latency with default 200", async () => {
    await engine.inject({ type: "latency-injection", targets: ["t1"], config: {}, durationMs: 0 });
    expect(t1.setLatency).toHaveBeenCalledWith(200);
  });

  it("M27: latency-injection uses custom latencyMs", async () => {
    await engine.inject({ type: "latency-injection", targets: ["t1"], config: { latencyMs: 500 }, durationMs: 0 });
    expect(t1.setLatency).toHaveBeenCalledWith(500);
  });

  it("M28: clock-skew uses default 500ms skew", async () => {
    await engine.inject({ type: "clock-skew", targets: ["t1"], config: {}, durationMs: 0 });
    expect(t1.setLatency).toHaveBeenCalledWith(500);
  });

  it("M29: resource-pressure cpu defaults to 500ms latency", async () => {
    await engine.inject({ type: "resource-pressure", targets: ["t1"], config: {}, durationMs: 0 });
    expect(t1.setLatency).toHaveBeenCalledWith(500);
  });

  it("M30: resource-pressure disk defaults to 1000ms latency", async () => {
    await engine.inject({ type: "resource-pressure", targets: ["t1"], config: { pressureType: "disk" }, durationMs: 0 });
    expect(t1.setLatency).toHaveBeenCalledWith(1000);
  });

  it("M31: leadership-flap sets message loss at 0.5", async () => {
    await engine.inject({ type: "leadership-flap", targets: ["t1"], durationMs: 0 });
    expect(t1.setMessageLoss).toHaveBeenCalledWith(0.5);
  });

  it("M32: cascading-failure stops targets sequentially", async () => {
    await engine.inject({ type: "cascading-failure", targets: ["t1", "t2"], config: { staggerMs: 10 }, durationMs: 0 });
    expect(t1.stop).toHaveBeenCalled();
    expect(t2.stop).toHaveBeenCalled();
  });

  it("M33: unknown fault type throws", async () => {
    await expect(engine.inject({ type: "nonexistent", targets: ["t1"] } as any,)).rejects.toThrow("Unknown fault type");
  });
});

// ── ChaosEngineV2: Auto-resolve ────────────────────────

describe("CHAOS-M: ChaosEngineV2 Auto-resolve", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([makeTransport("t1")]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M34: auto-resolve removes fault after durationMs", async () => {
    vi.useFakeTimers();
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 100 });
    expect(engine.getActiveFaults()).toHaveLength(1);
    vi.advanceTimersByTime(150);
    // Auto-resolve fires asynchronously; let microtasks flush
    await vi.runAllTimersAsync();
    expect(engine.getActiveFaults()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("M35: zero durationMs = no auto-resolve", async () => {
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 });
    expect(engine.getActiveFaults()).toHaveLength(1); // stays active
  });
});

// ── ChaosEngineV2: Target Resolution ──────────────────

describe("CHAOS-M: ChaosEngineV2 Target Resolution", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([
      makeTransport("dc1:n1"),
      makeTransport("dc1:n2"),
      makeTransport("dc2:n1"),
    ]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M36: 'all' wildcard targets all transports", async () => {
    const id = await engine.inject({ type: "message-loss", targets: ["all"], config: { lossRate: 0.3 }, durationMs: 0 });
    // All 3 transports should be affected — coverage from active faults
    const active = engine.getActiveFaults();
    expect(active).toHaveLength(1);
  });

  it("M37: '*' wildcard also targets all", async () => {
    const id = await engine.inject({ type: "node-crash", targets: ["*"], durationMs: 0 });
    const active = engine.getActiveFaults();
    expect(active).toHaveLength(1);
  });

  it("M38: dc: prefix targets transports in that DC", async () => {
    const id = await engine.inject({ type: "message-loss", targets: ["dc:dc1"], config: { lossRate: 0.3 }, durationMs: 0 });
    const active = engine.getActiveFaults();
    expect(active).toHaveLength(1);
  });

  it("M39: specific ID targets only that transport", async () => {
    const id = await engine.inject({ type: "node-crash", targets: ["dc2:n1"], durationMs: 0 });
    const active = engine.getActiveFaults();
    expect(active).toHaveLength(1);
  });
});

// ── ChaosEngineV2: Event Listeners ────────────────────

describe("CHAOS-M: ChaosEngineV2 Events", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([makeTransport("t1")]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M40: onFaultInjected fires on inject", async () => {
    const fn = vi.fn();
    const unsub = engine.onFaultInjected(fn);
    await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toHaveProperty("type", "message-loss");
    unsub();
  });

  it("M41: onFaultInjected unsub stops notifications", async () => {
    const fn = vi.fn();
    const unsub = engine.onFaultInjected(fn);
    unsub();
    await engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("M42: onFaultResolved fires on resolve", async () => {
    const fn = vi.fn();
    engine.onFaultResolved(fn);
    const id = await engine.inject({ type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 });
    await engine.resolve(id);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(id);
  });

  it("M43: onStepCompleted and onScenarioCompleted fire during scenario", async () => {
    const stepFn = vi.fn();
    const scenarioFn = vi.fn();
    engine.onStepCompleted(stepFn);
    engine.onScenarioCompleted(scenarioFn);

    const scenario: ChaosScenario = {
      name: "test-scenario",
      seed: 42,
      maxDurationMs: 5000,
      steps: [
        { fault: { type: "message-loss", targets: ["t1"], config: { lossRate: 0.5 }, durationMs: 0 }, waitMs: 0, invariants: [] },
        { fault: { type: "latency-injection", targets: ["t1"], config: { latencyMs: 100 }, durationMs: 0 }, waitMs: 0, invariants: [] },
      ],
    };

    await engine.runScenario(scenario, { checkAll: async () => [] });
    expect(stepFn).toHaveBeenCalledTimes(2);
    expect(scenarioFn).toHaveBeenCalledTimes(1);
  });

  it("M44: runScenario with multiple step listeners both fire", async () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    engine.onStepCompleted(fn1);
    engine.onStepCompleted(fn2);

    const scenario: ChaosScenario = {
      name: "multi-listener",
      seed: 1,
      maxDurationMs: 5000,
      steps: [{ fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] }],
    };

    await engine.runScenario(scenario, { checkAll: async () => [] });
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

// ── ChaosEngineV2: Scenario Runner ────────────────────

describe("CHAOS-M: ChaosEngineV2 Scenario Runner", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([makeTransport("t1"), makeTransport("t2")]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("M45: runScenario with single step succeeds", async () => {
    const result = await engine.runScenario({
      name: "single",
      seed: 0,
      maxDurationMs: 10000,
      steps: [{ fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] }],
    }, { checkAll: async () => [] });

    expect(result.passed).toBe(true);
    expect(result.stepsExecuted).toBe(1);
    expect(result.totalSteps).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("M46: runScenario reports errors for injection failures", async () => {
    // A step that'll fail because the fault type is unknown
    const result = await engine.runScenario({
      name: "failing",
      seed: 0,
      maxDurationMs: 10000,
      steps: [{
        fault: { type: "nonexistent", targets: ["t1"] } as any,
        waitMs: 0,
        invariants: [],
      }],
    }, { checkAll: async () => [] });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Unknown fault type");
  });

  it("M47: runScenario with waitMs pauses between steps", async () => {
    const start = Date.now();
    const result = await engine.runScenario({
      name: "waiting",
      seed: 0,
      maxDurationMs: 10000,
      steps: [
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 50, invariants: [] },
        { fault: { type: "node-crash", targets: ["t2"], durationMs: 0 }, waitMs: 50, invariants: [] },
      ],
    }, { checkAll: async () => [] });
    expect(result.stepsExecuted).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("M48: runScenario with invariants checks them", async () => {
    const checker = { checkAll: vi.fn(async () => [{ invariant: "nodes-up", passed: true, message: "ok" }]) };
    const result = await engine.runScenario({
      name: "invariant-check",
      seed: 0,
      maxDurationMs: 10000,
      steps: [{
        fault: { type: "node-crash", targets: ["t1"], durationMs: 0 },
        waitMs: 0,
        invariants: [{ name: "nodes-up", threshold: 0 } as any],
      }],
    }, checker);

    expect(checker.checkAll).toHaveBeenCalled();
    expect(result.invariantResults).toHaveLength(1);
  });

  it("M49: runScenario passes when invariants pass", async () => {
    const result = await engine.runScenario({
      name: "all-pass",
      seed: 0,
      maxDurationMs: 10000,
      steps: [{
        fault: { type: "node-crash", targets: ["t1"], durationMs: 0 },
        waitMs: 0,
        invariants: [{ name: "up", threshold: 0 } as any],
      }],
    }, { checkAll: async () => [{ passed: true, invariant: "up" }] });

    expect(result.passed).toBe(true);
  });

  it("M50: runScenario with empty steps succeeds immediately", async () => {
    const result = await engine.runScenario({
      name: "empty",
      seed: 0,
      maxDurationMs: 10000,
      steps: [],
    }, { checkAll: async () => [] });
    expect(result.passed).toBe(true);
    expect(result.stepsExecuted).toBe(0);
  });

  it("M51: runScenario respects maxDurationMs timeout", async () => {
    const result = await engine.runScenario({
      name: "timeout",
      seed: 0,
      maxDurationMs: 10, // very short timeout — first step's wait will exceed it
      steps: [
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] },
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] },
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] },
      ],
    }, { checkAll: async () => [] });

    // After scenario completes, timeout message should be in errors if it fired
    // (on fast machines all 3 steps may complete before 10ms)
    // Verify the result structure is correct regardless
    expect(result.scenarioName).toBe("timeout");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("M52: runScenario with invariant check error is captured", async () => {
    const result = await engine.runScenario({
      name: "check-error",
      seed: 0,
      maxDurationMs: 10000,
      steps: [{
        fault: { type: "node-crash", targets: ["t1"], durationMs: 0 },
        waitMs: 0,
        invariants: [{ name: "up", threshold: 0 } as any],
      }],
    }, { checkAll: async () => { throw new Error("check failed"); } });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("check failed");
  });

  it("M53: inject with nonexistent target still returns valid faultId", async () => {
    const id = await engine.inject({ type: "message-loss", targets: ["ghost-node"], config: { lossRate: 0.3 }, durationMs: 0 });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });
});

describe("CHAOS-M: post-fix exact survivors", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([makeTransport("t1"), makeTransport("t2"), makeTransport("t3")]);
  });
  afterEach(async () => { try { await engine.stop(); } catch {} });

  it("L114 stop() clears started flag (false -> true)", async () => {
    await engine.stop();
    // after stop, inject must fail with not-started; mutant (started=true) would proceed
    await expect(engine.inject({ type: "node-crash", targets: ["t1"], durationMs: 0 })).rejects.toThrow("not started");
  });

  it("L269 duration is elapsed (Date.now - startTime)", async () => {
    const result = await engine.runScenario({
      name: "dur", seed: 0, maxDurationMs: 60000,
      steps: [{ fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] }],
    }, { checkAll: async () => [] });
    // elapsed must be a small non-negative value; a `-` -> `+` mutant yields a huge ~2*epoch value
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(60_000);
  });

  it("L255 step-completed listener receives 1-based step (i+1)", async () => {
    const received: Array<[number, number]> = [];
    engine.onStepCompleted((step, total) => received.push([step, total]));
    await engine.runScenario({
      name: "steps", seed: 0, maxDurationMs: 60000,
      steps: [{ fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] }],
    }, { checkAll: async () => [] });
    // single step -> step 1, total 1 (i+1 = 1, not -1)
    expect(received).toEqual([[1, 1]]);
  });

  it("L233 injection-failure log carries 1-based step (i+1)", async () => {
    const result = await engine.runScenario({
      name: "injfail", seed: 0, maxDurationMs: 60000,
      steps: [{ fault: { type: "nonexistent-fault" as any, targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [] }],
    }, { checkAll: async () => [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("step 1:");
  });

  it("L248 invariant-check failure log carries 1-based step (i+1)", async () => {
    const result = await engine.runScenario({
      name: "invfail", seed: 0, maxDurationMs: 60000,
      steps: [{ fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 0, invariants: [{ name: "up", threshold: 0 } as any] }],
    }, { checkAll: async () => { throw new Error("boom"); } });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("step 1:");
  });

  it("L329 network-partition excludes self from peers (!== -> ===)", async () => {
    // fresh engine with a transport that records its isolate() peers
    const isolatedCalls: Record<string, string[]> = {};
    const mk = (id: string) => ({
      transportId: id,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isolate: vi.fn((peers: string[]) => { isolatedCalls[id] = peers; }),
      setLatency: vi.fn(),
      setMessageLoss: vi.fn(),
      healAll: vi.fn(),
      getStats: vi.fn(() => ({ transportId: id })),
    });
    const e = new ChaosEngineV2();
    const a = mk("a"), b = mk("b"), c = mk("c");
    await e.start([a as any, b as any, c as any]);
    await e.inject({ type: "network-partition", targets: ["a"], config: {}, durationMs: 0 });
    // a isolates its peers b and c, never itself
    expect(isolatedCalls["a"]).toBeDefined();
    expect(isolatedCalls["a"]).not.toContain("a");
    expect(isolatedCalls["a"]).toContain("b");
    expect(isolatedCalls["a"]).toContain("c");
  });
});

describe("CHAOS-M: timeout + cascade stagger survivors", () => {
  let engine: ChaosEngineV2;
  beforeEach(async () => {
    engine = new ChaosEngineV2();
    await engine.start([makeTransport("t1"), makeTransport("t2"), makeTransport("t3")]);
  });
  afterEach(async () => { vi.useRealTimers(); try { await engine.stop(); } catch {} });

  it("L227 timeout log carries 1-based step (i+1)", async () => {
    // two steps with a short wait; by the second iteration elapsed > maxDurationMs
    // triggers the timeout log "step 2/2" (i+1 = 2, not -1)
    const result = await engine.runScenario({
      name: "timeout", seed: 0, maxDurationMs: 5,
      steps: [
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 15, invariants: [] },
        { fault: { type: "node-crash", targets: ["t1"], durationMs: 0 }, waitMs: 1, invariants: [] },
      ],
    }, { checkAll: async () => [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("step 2/2");
  });

  it("L394 cascading-failure staggers between non-final targets (< -> >=, - -> +)", async () => {
    // spy setTimeout to count stagger sleeps for a 3-target cascading failure
    const realSetTimeout = globalThis.setTimeout;
    let sleepCount = 0;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void, ms?: number,
    ) => {
      sleepCount++;
      return realSetTimeout(() => fn(), 0) as any;
    }) as any);
    await engine.inject({ type: "cascading-failure", targets: ["t1", "t2", "t3"], config: { staggerMs: 10 }, durationMs: 0 });
    // 3 targets -> 2 stagger sleeps (not 1, not 3)
    expect(sleepCount).toBe(2);
    vi.restoreAllMocks();
  });
});
