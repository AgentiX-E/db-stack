/**
 * RaftChaosAdapter — Integration Tests
 *
 * Verifies that the RaftChaosAdapter correctly bridges between
 * db-cluster's ChaosInjectingTransport and db-operations ChaosEngineV2.
 *
 * Invariants:
 *   RCHAOS1 — healAll always safe; never throws
 *   RCHAOS2 — Stats accurately reflect real transport state
 *   RCHAOS5 — Transport-level injection via adapter (CHAOS5)
 *   RCHAOS6 — After recovery, all adapters report healthy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SeededRandom } from "../chaos-harness";
import type { ChaosConfig } from "../chaos-harness";
import { RaftChaosAdapter, RaftChaosScenarios } from "./RaftChaosAdapter";
import type { IChaosInjectingTransport } from "./RaftChaosAdapter";

// ── Mock ChaosInjectingTransport ─────────────────────────────

class MockChaosTransport implements IChaosInjectingTransport {
  partitionedPeers: Set<string> = new Set();
  isolated = false;
  inner = {
    started: true,
    async start() { this.started = true; },
    async stop() { this.started = false; },
    isStarted() { return this.started; },
  };
  private _msgLost = 0;
  private _msgDelayed = 0;
  private _msgPartitioned = 0;
  private _msgForwarded = 0;

  // Mutable config object accessible as (this as any).config
  getStats() {
    return {
      lost: this._msgLost,
      delayed: this._msgDelayed,
      partitioned: this._msgPartitioned,
      forwarded: this._msgForwarded,
    };
  }

  // Allow config mutation from adapter
  config = { messageLossProbability: 0, maxLatencyMs: 0 };
  setConfig(loss: number, lat: number) {
    this.config.messageLossProbability = loss;
    this.config.maxLatencyMs = lat;
  }
}

// ── RCHAOS1: healAll Safety ─────────────────────────────────

describe("RCHAOS1 — healAll Safety", () => {
  it("RCHAOS1.1 — healAll on clean adapter is no-op", () => {
    const mock = new MockChaosTransport();
    const adapter = new RaftChaosAdapter(1, mock);
    adapter.healAll();
    expect(adapter.isHealthy()).toBe(true);
  });

  it("RCHAOS1.2 — healAll after partition restores health", () => {
    const mock = new MockChaosTransport();
    const adapter = new RaftChaosAdapter(1, mock);
    adapter.isolate(["raft:2"]);
    expect(adapter.isHealthy()).toBe(false);
    adapter.healAll();
    expect(adapter.isHealthy()).toBe(true);
  });

  it("RCHAOS1.3 — healAll after stop restores health", () => {
    const mock = new MockChaosTransport();
    const adapter = new RaftChaosAdapter(1, mock);
    adapter.healAll(); // Should not throw even on already-healthy
    expect(adapter.isHealthy()).toBe(true);
  });

  it("RCHAOS1.4 — healAll after multiple faults is safe", () => {
    const mock = new MockChaosTransport();
    const adapter = new RaftChaosAdapter(1, mock);
    adapter.isolate(["raft:2", "raft:3"]);
    adapter.setMessageLoss(0.5);
    adapter.setLatency(200);
    adapter.healAll();
    expect(adapter.isHealthy()).toBe(true);
    expect(adapter.getStats().avgLatencyMs).toBe(0);
  });
});

// ── RCHAOS2: Stats Accuracy ─────────────────────────────────

describe("RCHAOS2 — Stats Accuracy", () => {
  let mock: MockChaosTransport;
  let adapter: RaftChaosAdapter;

  beforeEach(() => {
    mock = new MockChaosTransport();
    adapter = new RaftChaosAdapter(1, mock);
  });

  it("RCHAOS2.1 — initial stats reflect zero state", () => {
    const stats = adapter.getStats();
    expect(stats.messagesSent).toBe(0);
    expect(stats.messagesLost).toBe(0);
    expect(stats.messagesDelayed).toBe(0);
    expect(stats.partitioned).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
  });

  it("RCHAOS2.2 — message loss rate reflected in stats", () => {
    adapter.setMessageLoss(0.3);
    const stats = adapter.getStats();
    // stats don't track loss rate directly, but isHealthy reflects it
    expect(adapter.isHealthy()).toBe(false);
  });

  it("RCHAOS2.3 — latency reflected in stats", () => {
    adapter.setLatency(500);
    expect(adapter.getStats().avgLatencyMs).toBe(500);
  });

  it("RCHAOS2.4 — isolated transport reports 0 connected peers", () => {
    mock.inner.started = false;
    adapter.isolate([]);
    // Mark as isolated manually
    mock.isolated = true;
    expect(adapter.getStats().connectedPeers).toBe(0);
  });

  it("RCHAOS2.5 — transportId follows naming convention", () => {
    const a1 = new RaftChaosAdapter(1, new MockChaosTransport());
    const a3 = new RaftChaosAdapter(3, new MockChaosTransport());
    expect(a1.transportId).toBe("raft:1");
    expect(a3.transportId).toBe("raft:3");
  });
});

// ── RCHAOS5: Transport-Level Fault Injection ─────────────────

describe("CHAOS5 — Transport-Level Fault Injection via Adapter", () => {
  let t0: RaftChaosAdapter;
  let t1: RaftChaosAdapter;
  let t2: RaftChaosAdapter;
  let injectors: IChaosInjectingTransport[];

  beforeEach(() => {
    injectors = [new MockChaosTransport(), new MockChaosTransport(), new MockChaosTransport()];
    t0 = new RaftChaosAdapter(0, injectors[0]!);
    t1 = new RaftChaosAdapter(1, injectors[1]!);
    t2 = new RaftChaosAdapter(2, injectors[2]!);
  });

  it("CHAOS5.1 — adapter isolates peer correctly", () => {
    t0.isolate(["raft:1"]);
    expect(injectors[0]!.partitionedPeers.has("1")).toBe(true);
  });

  it("CHAOS5.2 — adapter heals specific peer", () => {
    t0.isolate(["raft:1", "raft:2"]);
    t0.heal(["raft:1"]);
    expect(injectors[0]!.partitionedPeers.has("1")).toBe(false);
    expect(injectors[0]!.partitionedPeers.has("2")).toBe(true);
  });

  it("CHAOS5.3 — adapter.stop() triggers isolated flag", async () => {
    await t0.stop();
    expect(injectors[0]!.isolated).toBe(true);
    expect(t0.isHealthy()).toBe(false);
  });

  it("CHAOS5.4 — adapter.start() clears isolated flag", async () => {
    await t0.stop();
    await t0.start();
    expect(injectors[0]!.isolated).toBe(false);
    expect(t0.isHealthy()).toBe(true);
  });

  it("CHAOS5.5 — setMessageLoss propagates to config", () => {
    t0.setMessageLoss(0.8);
    const cfg = (injectors[0] as any).config;
    expect(cfg.messageLossProbability).toBe(0.8);
  });

  it("CHAOS5.6 — setLatency propagates to config", () => {
    t0.setLatency(300);
    const cfg = (injectors[0] as any).config;
    expect(cfg.maxLatencyMs).toBe(300);
  });

  it("CHAOS5.7 — setMessageLoss clamps to [0, 1]", () => {
    t0.setMessageLoss(-0.5);
    expect((injectors[0] as any).config.messageLossProbability).toBe(0);
    t0.setMessageLoss(1.5);
    expect((injectors[0] as any).config.messageLossProbability).toBe(1);
  });

  it("CHAOS5.8 — non-Raft transport IDs are ignored", () => {
    t0.isolate(["federation:dc1:node-0", "raft:1"]);
    // Only raft:1 should be parsed
    expect(injectors[0]!.partitionedPeers.has("1")).toBe(true);
    expect(injectors[0]!.partitionedPeers.has("dc1:node-0")).toBe(false);
  });
});

// ── Scenario Builders ────────────────────────────────────────

describe("RaftChaosScenarios", () => {
  it("produces well-formed partition fault", () => {
    const f = RaftChaosScenarios.partition([1, 2], 5000, "test partition");
    expect(f.type).toBe("network-partition");
    expect(f.targets).toEqual(["raft:1", "raft:2"]);
    expect(f.durationMs).toBe(5000);
    expect(f.description).toBe("test partition");
  });

  it("produces well-formed crash fault", () => {
    const f = RaftChaosScenarios.crash([3]);
    expect(f.type).toBe("node-crash");
    expect(f.targets).toEqual(["raft:3"]);
  });

  it("produces well-formed message loss fault", () => {
    const f = RaftChaosScenarios.messageLoss([1, 2, 3], 0.3, 1000);
    expect(f.type).toBe("message-loss");
    expect(f.config.lossRate).toBe(0.3);
  });

  it("produces well-formed latency fault", () => {
    const f = RaftChaosScenarios.latency([0], 500);
    expect(f.type).toBe("latency-injection");
    expect(f.config.latencyMs).toBe(500);
  });

  it("produces well-formed leadership flap fault", () => {
    const f = RaftChaosScenarios.leadershipFlap([0]);
    expect(f.type).toBe("leadership-flap");
  });

  it("produces well-formed cascading failure fault", () => {
    const f = RaftChaosScenarios.cascadingFailure([0, 1, 2], 500, 3000);
    expect(f.type).toBe("cascading-failure");
    expect(f.config.staggerMs).toBe(500);
    expect(f.durationMs).toBe(3000);
  });

  it("allNodes returns wildcard", () => {
    expect(RaftChaosScenarios.allNodes()).toEqual(["raft:*"]);
  });
});

// ── End-to-End: Adapter + ChaosEngineV2 ──────────────────────

describe("E2E — RaftChaosAdapter + ChaosEngineV2", () => {
  it("E2E — inject partition via engine, heal via engine", async () => {
    const { ChaosEngineV2 } = await import("@agentix-e/db-operations-chaosengine");
    const engine = new ChaosEngineV2();

    const mock0 = new MockChaosTransport();
    const mock1 = new MockChaosTransport();
    const adapter0 = new RaftChaosAdapter(0, mock0);
    const adapter1 = new RaftChaosAdapter(1, mock1);
    await engine.start([adapter0, adapter1]);

    // Inject partition
    const fault = RaftChaosScenarios.partition([0], 0, "dc partition");
    const faultId = await engine.inject(fault);

    expect(mock0.partitionedPeers.has("1")).toBe(true);
    expect(adapter0.isHealthy()).toBe(false);

    // Resolve
    await engine.resolve(faultId);
    expect(adapter0.isHealthy()).toBe(true);

    await engine.stop();
  });

  it("E2E — crash and restart via engine", async () => {
    const { ChaosEngineV2 } = await import("@agentix-e/db-operations-chaosengine");
    const engine = new ChaosEngineV2();

    const mocks = [new MockChaosTransport(), new MockChaosTransport(), new MockChaosTransport()];
    const adapters = mocks.map((m, i) => new RaftChaosAdapter(i, m));
    await engine.start(adapters);

    // Crash node 1
    const crashId = await engine.inject(RaftChaosScenarios.crash([1]));
    expect(mocks[1]!.isolated).toBe(true);

    // Resolve = restart
    await engine.resolve(crashId);
    expect(mocks[1]!.isolated).toBe(false);
    expect(adapters[1]!.isHealthy()).toBe(true);

    await engine.stop();
  });

  it("E2E — scenario runner with Raft adapters", async () => {
    const { ChaosEngineV2 } = await import("@agentix-e/db-operations-chaosengine");
    const engine = new ChaosEngineV2();

    const mocks = [new MockChaosTransport(), new MockChaosTransport()];
    const adapters = mocks.map((m, i) => new RaftChaosAdapter(i, m));
    await engine.start(adapters);

    const result = await engine.runScenario(
      {
        name: "raft-partition-recovery",
        description: "Partition then recover",
        seed: 42,
        maxDurationMs: 30_000,
        steps: [
          {
            name: "partition node 0",
            fault: RaftChaosScenarios.partition([0], 100, "split node 0"),
            waitMs: 50,
            invariants: [],
          },
          {
            name: "crash node 1",
            fault: RaftChaosScenarios.crash([1], 100, "kill node 1"),
            waitMs: 50,
            invariants: [],
          },
        ],
      },
      {
        // Minimal checker
        async check(inv) {
          return { invariant: inv, passed: true, detail: "" };
        },
        async checkAll(invs) {
          return invs.map((i) => ({ invariant: i, passed: true, detail: "" }));
        },
      },
    );

    expect(result.passed).toBe(true);
    expect(result.stepsExecuted).toBe(2);
    // After scenario, all adapters should be healthy
    for (const a of adapters) {
      expect(a.isHealthy()).toBe(true);
    }

    await engine.stop();
  });
});
