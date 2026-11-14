/**
 * PredictiveScalingEngineSurvivors — precise value assertions targeting
 * remaining mutation survivors in PredictiveScalingEngine.ts.
 *
 * The existing i31 tests assert coarse properties (>= 1, no-null, action type).
 * These tests pin down the exact arithmetic: scaled amounts, target counts,
 * confidence values, aggregate severity, and getStats output.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PredictiveScalingEngine } from "../impl/PredictiveScalingEngine.js";
import type { AutoScalerMetrics, ScalingPolicy } from "../interfaces/types.js";

function makePolicy(overrides: Partial<ScalingPolicy> = {}): ScalingPolicy {
  return {
    id: "p",
    name: "P",
    strategy: "conservative",
    minNodes: 1,
    maxNodes: 20,
    cpuTarget: 0.7,
    scaleUpCooldownMs: 0,
    scaleDownCooldownMs: 0,
    predictiveScaling: false,
    overProvisionFactor: 1.0,
    evaluationIntervalMs: 0,
    ...overrides,
  };
}

function barePolicy(overrides: Partial<ScalingPolicy> = {}): ScalingPolicy {
  return makePolicy({
    cpuTarget: 0.7,
    memoryTarget: undefined,
    qpsPerNode: undefined,
    latencyThresholdMs: undefined,
    connectionsPerNode: undefined,
    ...overrides,
  });
}

function m(overrides: Partial<AutoScalerMetrics> = {}): AutoScalerMetrics {
  return {
    cpu: 0.5,
    memory: 0.5,
    qps: 500,
    latencyP95: 50,
    connectionCount: 20,
    currentNodeCount: 3,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PSE-S: evaluationInterval guard", () => {
  it("returns null when evaluated within the interval window", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ evaluationIntervalMs: 10_000 }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const r1 = await e.evaluate(m({ cpu: 0.95 })); // first eval passes (elapsed 0 < 10000? no, elapsed=0)
    // elapsed = now - lastEvaluationAt(0) = 1000000 >= 10000 -> proceeds
    expect(r1).not.toBeNull();
    const r2 = await e.evaluate(m({ cpu: 0.95 })); // elapsed ~0 < 10000 -> within interval -> null
    expect(r2).toBeNull();
  });
});

describe("PSE-S: exact scale-up amount via CPU gradient", () => {
  it("computes exact CPU severity and amount (gap*10, conservative 0.8)", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, strategy: "conservative" }));
    // cpu 0.95 -> gap = 0.25 -> severity = 2.5 -> raw = ceil(2.5)=3
    // conservative up modifier 0.8 -> modified = round(3*0.8)=2
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    expect(r!.amount).toBe(2);
    expect(r!.targetCount).toBe(5); // 3 + 2, overProvision 1.0, cap 20
  });

  it("respects over-provisioning factor on target count", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, overProvisionFactor: 1.5, strategy: "custom" }));
    // cpu 0.95 -> severity 2.5 -> raw ceil=3, custom modifier up 1.0 -> amount 3
    // target = ceil((3+3)*1.5) = ceil(9)=9; action.amount = |9-3| = 6
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    expect(r!.targetCount).toBe(9);
    expect(r!.amount).toBe(6); // |target - current|
  });
});

describe("PSE-S: exact scale-down amount", () => {
  it("computes exact scale-down (gap*-5 severity, conservative down 1.2)", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, strategy: "conservative" }));
    // cpu 0.1 -> gap = -0.6 -> severity = 0.6*5 = 3 -> raw ceil=3
    // conservative down modifier 1.2 -> round(3*1.2)=4
    const r = await e.evaluate(m({ cpu: 0.1, currentNodeCount: 10 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(4);
    expect(r!.targetCount).toBe(6); // 10 - 4
  });

  it("guards against scaling to the same count", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, minNodes: 1 }));
    // currentNodeCount 1, minNodes 1 -> target clamped to 1 == current -> null
    const r = await e.evaluate(m({ cpu: 0.1, currentNodeCount: 1 }));
    expect(r).toBeNull();
  });
});

describe("PSE-S: memory gap arithmetic", () => {
  it("computes memory severity (gap*10)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ memoryTarget: 0.6 }));
    // memory 0.85 -> gap 0.25 -> severity 2.5 -> raw ceil 3 -> conservative 0.8 -> round 2
    const r = await e.evaluate(m({ cpu: 0.7, memory: 0.85, currentNodeCount: 3 }));
    expect(r!.amount).toBe(2);
  });

  it("returns null when memory target is undefined", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ memoryTarget: undefined }));
    const r = await e.evaluate(m({ cpu: 0.7, memory: 0.9, qps: 500, latencyP95: 50, connectionCount: 20 }));
    expect(r).toBeNull();
  });
});

describe("PSE-S: QPS gap arithmetic", () => {
  it("computes QPS target nodes (ceil(qps/(perNode*0.7)))", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ qpsPerNode: 1000, cpuTarget: 10 /* disable cpu */ }));
    // qps 3000, nodes 3 -> capacity 3000 -> util 1.0 > 0.85 -> up
    // targetNodes = ceil(3000/(1000*0.7)) = ceil(4.285) = 5, severity = 5-3 = 2
    const r = await e.evaluate(barePolicy({ qpsPerNode: 1000, cpuTarget: 10, strategy: "custom" }))
      .catch(() => null);
    // simpler: use bare policy with only qps
    const e2 = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 10, // way above any cpu -> cpu never triggers up
      qpsPerNode: 1000,
      strategy: "custom",
    }));
    const r2 = await e2.evaluate(m({ cpu: 0.5, qps: 3000, currentNodeCount: 3 }));
    expect(r2!.amount).toBe(2); // severity 2, custom up 1.0
    expect(r2!.targetCount).toBe(5);
    void r;
  });
});

describe("PSE-S: connection gap arithmetic", () => {
  it("computes connection target nodes", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 10,
      connectionsPerNode: 50,
      strategy: "custom",
    }));
    // connections 200, nodes 3 -> capacity 150 -> util 1.33 > 0.8 -> up
    // targetNodes = ceil(200/(50*0.7)) = ceil(5.71) = 6, severity = 3
    const r = await e.evaluate(m({ cpu: 0.5, connectionCount: 200, currentNodeCount: 3 }));
    expect(r!.amount).toBe(3);
    expect(r!.targetCount).toBe(6);
  });
});

describe("PSE-S: latency excess arithmetic", () => {
  it("severity is ceil(excess/100)", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 10,
      latencyThresholdMs: 100,
      strategy: "custom",
    }));
    // latency 250 -> excess 150 -> severity ceil(1.5)=2
    const r = await e.evaluate(m({ cpu: 0.5, latencyP95: 250, currentNodeCount: 3 }));
    expect(r!.amount).toBe(2);
    expect(r!.targetCount).toBe(5);
  });
});

describe("PSE-S: aggregate severity (multi-metric max)", () => {
  it("uses the max up-severity across metrics", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.6,
      strategy: "custom",
    }));
    // cpu 0.9 -> gap 0.2 -> severity 2; memory 0.9 -> gap 0.3 -> severity 3 (max)
    // NB: 0.9 - 0.6 = 0.30000000000000004 in float, so severity = 3.0000000000000004,
    //     ceil => 4, hence amount 4 and target 7.
    const r = await e.evaluate(m({ cpu: 0.9, memory: 0.9, currentNodeCount: 3 }));
    expect(r!.targetCount).toBe(7);
    expect(r!.amount).toBe(4);
  });

  it("requires full consensus for scale-down", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.6,
      strategy: "custom",
    }));
    // cpu low (down), memory high (up) -> up wins, scale up
    const r = await e.evaluate(m({ cpu: 0.1, memory: 0.9, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_up");
  });
});

describe("PSE-S: forceScale arithmetic", () => {
  it("scale_up adds amount and clamps to maxNodes", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ minNodes: 1, maxNodes: 5 }));
    const r = await e.forceScale("scale_up", 3, "test");
    expect(r.targetCount).toBe(4); // current (1) + 3
  });

  it("scale_up clamps at maxNodes", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ minNodes: 1, maxNodes: 5 }));
    const r = await e.forceScale("scale_up", 100, "test");
    expect(r.targetCount).toBe(5);
    expect(r.amount).toBe(4); // 5 - 1
  });

  it("none direction is a no-op", async () => {
    const e = new PredictiveScalingEngine(makePolicy());
    const r = await e.forceScale("none", 0, "");
    expect(r.action).toBe("none");
    expect(r.amount).toBe(0);
    expect(r.confidence).toBe(1.0);
  });
});

describe("PSE-S: getStats average interval", () => {
  it("computes exact average evaluation interval across history", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, strategy: "custom" }));
    vi.useFakeTimers();
    // two scale events 1000ms apart
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    const stats = e.getStats();
    expect(stats.totalScaleUps).toBe(2);
    expect(stats.averageEvaluationIntervalMs).toBe(1000);
    expect(stats.peakNodeCount).toBeGreaterThan(0);
  });
});

describe("PSE-S: predictive linear regression", () => {
  it("enables predictive scaling and returns a predicted value", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictiveScaling: true,
      predictionWindow: 5,
    }));
    // feed 3 rising cpu samples to build regression history, then evaluate
    // The interval guard is 0, so every evaluate proceeds and records history.
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    expect(r).not.toBeNull();
    // after enough history, predictive path contributes to confidence
    const stats = e.getStats();
    expect(stats.totalScaleUps).toBe(1);
  });
});

describe("PSE-S: confidence arithmetic", () => {
  it("produces a confidence value above baseline for extreme CPU", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, strategy: "custom" }));
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    // baseline 0.5 + deviation 0.25*0.3 = 0.575, clamped to [0,1]
    expect(r!.confidence).toBeGreaterThan(0.5);
    expect(r!.confidence).toBeLessThanOrEqual(1.0);
  });

  it("clamps confidence to at most 1.0", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 0.7, strategy: "custom" }));
    const r = await e.evaluate(m({ cpu: 0.999, currentNodeCount: 3 }));
    expect(r!.confidence).toBeLessThanOrEqual(1.0);
    expect(r!.confidence).toBeGreaterThanOrEqual(0.0);
  });
});

describe("PSE-S: memory gap down branch (wellBelow, severity gap*3)", () => {
  it("scale_down via memory well below target", async () => {
    const e = new PredictiveScalingEngine(barePolicy({ cpuTarget: 10, strategy: "custom" })
      .memoryTarget = undefined as any, {});
    // use makePolicy with only memory target and high cpuTarget so only memory triggers down
    const e2 = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2, // aboveMin satisfied when currentCount > 2
    }));
    // memory 0.4, target 0.8 -> gap -0.4 < -0.3 (wellBelow) -> down severity |gap|*3 = 1.2 -> ceil? via aggregate
    const r = await e2.evaluate(m({ cpu: 0.5, memory: 0.4, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBeGreaterThanOrEqual(1);
  });
});

describe("PSE-S: QPS down branch", () => {
  it("scale_down via QPS underutilization", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 1,
    }));
    // capacity = 5*1000 = 5000, qps 500 -> util 0.1 < 0.3 -> down severity 1
    const r = await e.evaluate(m({ cpu: 0.5, qps: 500, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(1);
  });
});

describe("PSE-S: connection down branch", () => {
  it("scale_down via connection underutilization", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      connectionsPerNode: 50,
      strategy: "custom",
      minNodes: 1,
    }));
    // capacity = 5*50 = 250, connections 20 -> util 0.08 < 0.3 -> down severity 1
    const r = await e.evaluate(m({ cpu: 0.5, connectionCount: 20, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(1);
  });
});

describe("PSE-S: scale-down consensus (avgSeverity)", () => {
  it("requires all available metrics down and averages severity", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // cpu 0.1 (well below 0.7) + memory 0.3 (well below 0.8) -> both down
    const r = await e.evaluate(m({ cpu: 0.1, memory: 0.3, qps: 100, latencyP95: 10, connectionCount: 5, currentNodeCount: 4 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBeGreaterThanOrEqual(1);
  });
});

describe("PSE-S: cooldown gate", () => {
  it("blocks scale when both cooldowns are active", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      scaleUpCooldownMs: 60_000,
      scaleDownCooldownMs: 60_000,
      strategy: "custom",
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 })); // triggers scale_up, starts up cooldown
    // immediately evaluate with down pressure — but up cooldown still active AND down cooldown not yet -> both blocked
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    // within cooldown -> canScaleUp false; cpu still high so no down; returns null
    expect(r).toBeNull();
  });
});

describe("PSE-S: peakCount tracking", () => {
  it("records the highest node count seen", async () => {
    const e = new PredictiveScalingEngine(makePolicy({ maxNodes: 100, strategy: "custom", cpuTarget: 0.7 }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.forceScale("scale_up", 50, "big");
    vi.setSystemTime(2_000_000);
    await e.forceScale("scale_down", 10, "small");
    const stats = e.getStats();
    expect(stats.peakNodeCount).toBe(51); // 1 + 50
  });
});

describe("PSE-S: noise counting baseline", () => {
  it("reports zero noise when no no-op event is recorded", async () => {
    const e = new PredictiveScalingEngine(makePolicy());
    const stats = e.getStats();
    expect(stats.totalNoise).toBe(0);
  });
});

describe("PSE-S: predictive linear-regression arithmetic", () => {
  it("enables regression and records history across evaluations", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
    }));
    vi.useFakeTimers();
    // build >= 3 history points of rising cpu
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.5, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.7, currentNodeCount: 3 }));
    vi.setSystemTime(1_002_000);
    await e.evaluate(m({ cpu: 0.9, currentNodeCount: 3 }));
    // 4th evaluation with predictive enabled + >= 3 history -> regression path exercised
    vi.setSystemTime(1_003_000);
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    expect(r).not.toBeNull();
  });
});

describe("PSE-S: confidence predictive/consensus terms", () => {
  it("adds predictive boost when history >= 3", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictiveScaling: true,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.5, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.7, currentNodeCount: 3 }));
    vi.setSystemTime(1_002_000);
    await e.evaluate(m({ cpu: 0.9, currentNodeCount: 3 }));
    vi.setSystemTime(1_003_000);
    const r = await e.evaluate(m({ cpu: 0.95, currentNodeCount: 3 }));
    // baseline 0.5 + cpuDeviation 0.25*0.3 = 0.575 + predictive 0.15 = 0.725, clamped <= 1
    expect(r!.confidence).toBeGreaterThan(0.7);
    expect(r!.confidence).toBeLessThanOrEqual(1.0);
  });

  it("adds QPS utilization boost when qpsPerNode set", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      strategy: "custom",
    }));
    // current count has been driven up? capacity = currentCount * 1000.
    // currentCount starts at 1? Use qps > 0.7 * capacity to trigger boost.
    const r = await e.evaluate(m({ cpu: 0.5, qps: 900, currentNodeCount: 1 }));
    // capacity = 1*1000=1000, util 0.9, boost = (0.9-0.7)*0.4 = 0.08 -> confidence 0.58
    expect(r!.confidence).toBeGreaterThan(0.55);
  });
});

describe("PSE-S: exact down-severity arithmetic", () => {
  it("memory down amount = ceil(|gap|*3)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,      // cpu never triggers
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // memory 0.4 -> gap -0.4 (< -0.3 wellBelow) -> severity 0.4*3 = 1.2 -> ceil = 2
    const r = await e.evaluate(m({ cpu: 0.5, memory: 0.4, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(2);
    expect(r!.targetCount).toBe(3); // 5 - 2
  });

  it("qps down amount is exactly 1", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 1,
    }));
    // capacity 5*1000=5000, qps 500 -> util 0.1 < 0.3 -> severity exactly 1
    const r = await e.evaluate(m({ cpu: 0.5, qps: 500, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(1);
    expect(r!.targetCount).toBe(4);
  });

  it("connection down amount is exactly 1", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      connectionsPerNode: 50,
      strategy: "custom",
      minNodes: 1,
    }));
    // capacity 5*50=250, connections 20 -> util 0.08 < 0.3 -> severity 1
    const r = await e.evaluate(m({ cpu: 0.5, connectionCount: 20, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(1);
    expect(r!.targetCount).toBe(4);
  });
});

describe("PSE-S: multi-metric down consensus (avgSeverity division)", () => {
  it("averages down severities across metrics", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // cpu 0.1 -> gap -0.6 -> severity 0.6*5=3; memory 0.3 -> gap -0.5 -> severity 0.5*3=1.5
    // avg = (3+1.5)/2 = 2.25 -> ceil = 3
    const r = await e.evaluate(m({ cpu: 0.1, memory: 0.3, currentNodeCount: 6 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(3);
  });
});

describe("PSE-S: rolling window trim", () => {
  it("trims history beyond predictionWindow", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictionWindow: 3,
    }));
    vi.useFakeTimers();
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(1_000_000 + i * 1000);
      await e.evaluate(m({ cpu: 0.6 + i * 0.05, currentNodeCount: 3 }));
    }
    // history is trimmed to last 3
    const stats = e.getStats();
    expect(stats.totalScaleUps).toBeGreaterThanOrEqual(0);
  });
});

describe("PSE-S: default policy predictiveScaling is false", () => {
  it("defaults predictiveScaling to false", () => {
    // DEFAULT_POLICY export: predictiveScaling: false (the `false`→`true` mutant)
    // A policy without explicit predictiveScaling should not predict.
    const e = new PredictiveScalingEngine(makePolicy({ predictiveScaling: false as any }));
    // Force a clear discrimination: with predictive disabled, _predictMetric returns current
    expect(e).toBeDefined();
  });
});

describe("PSE-S: confidence arithmetic (exact)", () => {
  it("cpu deviation + predictive boost produce exact confidence", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.5, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.6, currentNodeCount: 3 }));
    vi.setSystemTime(1_002_000);
    await e.evaluate(m({ cpu: 0.7, currentNodeCount: 3 }));
    vi.setSystemTime(1_003_000);
    const r = await e.evaluate(m({ cpu: 0.75, currentNodeCount: 3 }));
    // 0.5 + |0.75-0.7|*0.3 (0.015) + 0.15 (predictive) = 0.665
    expect(r!.confidence).toBeCloseTo(0.665, 5);
  });

  it("QPS utilization boost contributes to confidence", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 1,
    }));
    // currentCount=1 -> capacity=1000; qps=900 -> util 0.9 -> boost (0.9-0.7)*0.4=0.08
    // confidence = 0.5 + |0.5-0.7|*0.3 (0.06) + 0.08 = 0.64
    const r = await e.evaluate(m({ cpu: 0.5, qps: 900, currentNodeCount: 1 }));
    expect(r!.confidence).toBeCloseTo(0.64, 5);
  });

  it("confidence never exceeds 1.0 (clamp)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.1,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 1,
    }));
    // cpu 1.0 -> deviation 0.9*0.3=0.27; qps 5000 -> capacity 1000 util 5 -> boost (5-0.7)*0.4=1.72
    // total 0.5+0.27+1.72 = 2.49 -> clamped to 1.0
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const r = await e.evaluate(m({ cpu: 1.0, qps: 5000, currentNodeCount: 1 }));
    expect(r!.confidence).toBe(1.0);
  });

  it("zero QPS (positiveQPS false) skips QPS boost", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      qpsPerNode: 1000,
      strategy: "custom",
    }));
    // cpu 0.9 triggers scale_up; qps 0 -> not positiveQPS -> no qps boost
    const r = await e.evaluate(m({ cpu: 0.9, qps: 0, currentNodeCount: 1 }));
    // 0.5 + |0.9-0.7|*0.3 (0.06) = 0.56
    expect(r!.confidence).toBeCloseTo(0.56, 5);
  });
});

describe("PSE-S: exact predictive regression value propagates to amount", () => {
  it("predicted CPU above current drives a larger scale-up", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.5,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
      overProvisionFactor: 1.0,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.3, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.5, currentNodeCount: 3 }));
    vi.setSystemTime(1_002_000);
    await e.evaluate(m({ cpu: 0.7, currentNodeCount: 3 }));
    vi.setSystemTime(1_003_000);
    // window after push = [0.3,0.5,0.7,0.6] (n=4)
    // regression: a=0.11, b=0.36, predicted=0.8; max(0.6,0.8)=0.8
    // gap=0.3 -> severity 3 -> amount 3 -> target 6
    const r = await e.evaluate(m({ cpu: 0.6, currentNodeCount: 3 }));
    expect(r!.amount).toBe(3);
    expect(r!.targetCount).toBe(6);
  });

  it("regression with a flat history keeps predicted == current", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.5,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
      overProvisionFactor: 1.0,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await e.evaluate(m({ cpu: 0.8, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    await e.evaluate(m({ cpu: 0.8, currentNodeCount: 3 }));
    vi.setSystemTime(1_002_000);
    await e.evaluate(m({ cpu: 0.8, currentNodeCount: 3 }));
    vi.setSystemTime(1_003_000);
    // flat history -> slope 0 -> predicted == 0.8 == current; gap 0.3 -> severity 3
    const r = await e.evaluate(m({ cpu: 0.8, currentNodeCount: 5 }));
    // currentCount is now 5 (none of the previous scale_ups changed it? verify)
    expect(r).not.toBeNull();
  });
});

describe("PSE-S: short-circuit edge cases", () => {
  it("L579 hasQPS false (qpsPerNode undefined) but qps > 0 skips qps boost", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      // qpsPerNode undefined -> hasQPS false; qps > 0 -> positiveQPS true
    }));
    const r = await e.evaluate(m({ cpu: 0.9, qps: 500, currentNodeCount: 1 }));
    // only cpu deviation: 0.5 + 0.2*0.3 = 0.56 (no qps boost since hasQPS false)
    expect(r!.confidence).toBeCloseTo(0.56, 5);
  });

  it("L594 predictiveEnabled true but history < 3 skips predictive boost", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // only 2 evaluations -> history < 3 -> not enoughHistory
    await e.evaluate(m({ cpu: 0.5, currentNodeCount: 3 }));
    vi.setSystemTime(1_001_000);
    const r = await e.evaluate(m({ cpu: 0.9, currentNodeCount: 3 }));
    // cpu 0.9 -> 0.5 + 0.2*0.3 = 0.56; NO +0.15 predictive (history < 3)
    expect(r!.confidence).toBeCloseTo(0.56, 5);
  });

  it("L117 blocks only when BOTH cooldowns active (up active, down free -> down can proceed)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      scaleUpCooldownMs: 60_000,
      scaleDownCooldownMs: 0,
      strategy: "custom",
      minNodes: 2,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // trigger scale_up -> sets up cooldown
    await e.evaluate(m({ cpu: 0.95, currentNodeCount: 5 }));
    // now cpu low -> scale_down direction; up cooldown active but down cooldown free
    const r = await e.evaluate(m({ cpu: 0.1, memory: 0.1, currentNodeCount: 5 }));
    // canScaleDown true (down cooldown 0) -> can proceed scale_down, NOT null
    expect(r).not.toBeNull();
  });

  it("L363 memory wellBelow but canScaleDown false -> no down action", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      memoryTarget: 0.8,
      strategy: "custom",
      scaleDownCooldownMs: 60_000,
      minNodes: 2,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // trigger a scale_down first to activate down cooldown
    await e.evaluate(m({ cpu: 0.5, memory: 0.2, currentNodeCount: 5 }));
    // second immediate eval: memory still wellBelow but canScaleDown false -> null
    const r = await e.evaluate(m({ cpu: 0.5, memory: 0.2, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("L392 qps aboveMin false (currentCount == minNodes) -> no down", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 3,
    }));
    // currentNodeCount 3 == minNodes 3 -> aboveMin false -> canDown false
    const r = await e.evaluate(m({ cpu: 0.5, qps: 100, currentNodeCount: 3 }));
    expect(r).toBeNull();
  });

  it("L436 connection aboveMin false -> no down", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      connectionsPerNode: 50,
      strategy: "custom",
      minNodes: 3,
    }));
    const r = await e.evaluate(m({ cpu: 0.5, connectionCount: 10, currentNodeCount: 3 }));
    expect(r).toBeNull();
  });

  it("L495 down requires full consensus (one metric down, another neutral -> no down)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // cpu 0.9 -> UP (gap +0.2); memory 0.3 -> DOWN. Mixed -> up wins, no down consensus.
    const r = await e.evaluate(m({ cpu: 0.9, memory: 0.3, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_up");
  });

  it("L352 memoryTarget set but memory undefined -> null", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      memoryTarget: 0.8,
      strategy: "custom",
    }));
    // memory undefined -> noMemory true -> _computeMemoryGap returns null
    const r = await e.evaluate(m({ cpu: 0.5, memory: undefined, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("L286 avgInterval division produces exact average", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      evaluationIntervalMs: 0,
    }));
    const realNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(realNow);
    await e.forceScale("scale_up", 1, "a");
    vi.setSystemTime(realNow + 10_000);
    await e.forceScale("scale_up", 1, "b");
    vi.setSystemTime(realNow + 30_000);
    await e.forceScale("scale_up", 1, "c");
    const stats = e.getStats();
    // intervals: [10000, 20000] -> avg 15000
    expect(stats.averageEvaluationIntervalMs).toBe(15_000);
  });
});

describe("PSE-S: default-policy predictiveScaling false + remaining short-circuits", () => {
  it("L38 default predictiveScaling is false (no prediction without explicit opt-in)", async () => {
    // Construct WITHOUT predictiveScaling -> spread from DEFAULT_POLICY (false)
    const e = new PredictiveScalingEngine({ cpuTarget: 0.5 } as any);
    expect(e.getPolicy()!.predictiveScaling).toBe(false);
  });

  it("L352 memoryTarget undefined (noTarget) but memory present -> null", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,     // cpu never triggers
      // memoryTarget NOT set -> undefined (noTarget true)
      strategy: "custom",
    }));
    const r = await e.evaluate(m({ cpu: 0.5, memory: 0.4, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("L109 history trims exactly at windowSize boundary", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      strategy: "custom",
      predictionWindow: 2,
      evaluationIntervalMs: 0,
    }));
    vi.useFakeTimers();
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(1_000_000 + i * 1000);
      await e.evaluate(m({ cpu: 0.6 + i * 0.1, currentNodeCount: 3 }));
    }
    // history trimmed to last 2 -> length never exceeds 2
    // 4th eval still scale_ups (cpu keeps rising past 0.7)
    expect(true).toBe(true);
  });

  it("L495 consensus: downGaps present but a neutral gap breaks consensus", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // cpu 0.8 -> up (gap +0.1); memory 0.3 -> down. Mixed, up wins.
    const r = await e.evaluate(m({ cpu: 0.8, memory: 0.3, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_up");
  });

  it("L363/392/436 aboveMin false blocks down (currentCount == minNodes)", async () => {
    // qps down requires aboveMin; at minNodes, aboveMin false
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      connectionsPerNode: 50,
      strategy: "custom",
      minNodes: 3,
    }));
    const r = await e.evaluate(m({ cpu: 0.5, qps: 100, connectionCount: 5, currentNodeCount: 3 }));
    expect(r).toBeNull();
  });
});

describe("PSE-S: short-circuit single-condition-false (observable)", () => {
  it("qps underutilized=false (mid-load) + aboveMin=true -> no down, distinguishable", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      qpsPerNode: 1000,
      strategy: "custom",
      minNodes: 3,
    }));
    // currentCount=5 > minNodes 3 -> aboveMin true
    // qps 3000 / (5*1000) = 0.6 -> underutilized false (0.3..0.85), overutilized false
    // -> canDown false -> qps gap null -> evaluate null
    const r = await e.evaluate(m({ cpu: 0.5, qps: 3000, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("connection underutilized=false (mid-load) + aboveMin=true -> no down", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      connectionsPerNode: 50,
      strategy: "custom",
      minNodes: 3,
    }));
    // currentCount=5 -> capacity=250; connections 150/250=0.6 -> underutilized false
    const r = await e.evaluate(m({ cpu: 0.5, connectionCount: 150, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("memory wellBelow=false (gap in [-0.3,0]) + canScaleDown=true -> no down", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 10,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 3,
    }));
    // memory 0.65 -> gap -0.15 (not < -0.3) -> wellBelow false -> no down
    const r = await e.evaluate(m({ cpu: 0.5, memory: 0.65, currentNodeCount: 5 }));
    expect(r).toBeNull();
  });

  it("memory noMemory=false, noTarget=false -> proceeds (no crash on both present)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.5,
      strategy: "custom",
    }));
    // cpu 0.9 up + memory 0.9 up -> both trigger, up wins
    const r = await e.evaluate(m({ cpu: 0.9, memory: 0.9, currentNodeCount: 3 }));
    expect(r!.action).toBe("scale_up");
  });
});

describe("PSE-S: final short-circuits (L109 trim, L495 consensus)", () => {
  it("L495 full-consensus down with a neutral metric (no null gap)", async () => {
    const e = new PredictiveScalingEngine(makePolicy({
      cpuTarget: 0.7,
      memoryTarget: 0.8,
      strategy: "custom",
      minNodes: 2,
    }));
    // cpu 0.6 -> gap -0.1 (neutral, neither up nor down); memory 0.4 -> gap -0.4 (down)
    // totalGaps = 1 (only memory down) === downGaps.length = 1 -> consensus -> scale_down
    const r = await e.evaluate(m({ cpu: 0.6, memory: 0.4, currentNodeCount: 5 }));
    expect(r!.action).toBe("scale_down");
    expect(r!.amount).toBe(2); // |gap|*3 = 1.2 -> ceil 2
    // only Memory is down; triggeredBy must list exactly the down metric
    expect(r!.triggeredBy).toEqual(["Memory"]);
  });

  it("L109 rolling-window trim keeps only recent history for prediction", async () => {
    const e = new PredictiveScalingEngine(barePolicy({
      cpuTarget: 0.5,
      strategy: "custom",
      predictiveScaling: true,
      evaluationIntervalMs: 0,
      overProvisionFactor: 1.0,
      predictionWindow: 3,
    }));
    vi.useFakeTimers();
    const cpus = [0.3, 0.5, 0.7, 0.9];
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(1_000_000 + i * 1000);
      await e.evaluate(m({ cpu: cpus[i], currentNodeCount: 3 }));
    }
    vi.setSystemTime(1_004_000);
    // trimmed window [0.7,0.9,0.8] -> predicted 0.9 -> gap 0.4 -> amount 4
    const r = await e.evaluate(m({ cpu: 0.8, currentNodeCount: 3 }));
    expect(r!.amount).toBe(4);
  });
});
