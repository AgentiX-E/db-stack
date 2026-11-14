/**
 * DCSplitBrainDetector — branch-completion tests.
 *
 * Targets the decision branches and methods the MA6-MA9 suite leaves implicit:
 *   - start() idempotence (`if (this.started) return`)
 *   - receiveHeartbeat early-return when not started
 *   - HLC chain trimming when length exceeds maxHlcChainLength
 *   - onSplitBrainResolved callback registration / unregistration
 *   - broadcastHeartbeat (heartbeat emit + expired-heartbeat detection)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DCSplitBrainDetector, type DCHeartbeat } from "./DCSplitBrainDetector";
import { HLC } from "../hlc/HLC";

function makeDetector(overrides?: Partial<Parameters<typeof DCSplitBrainDetector>[0]> & { autoRecover?: boolean }) {
  return new DCSplitBrainDetector({
    nodeId: "dc-1/node-1",
    dcId: "dc-1",
    hlc: new HLC("dc-1/node-1"),
    heartbeatIntervalMs: 100,
    missedHeartbeatThreshold: 3,
    autoRecover: false,
    ...overrides,
  });
}

function hb(dcId: string, wallTime: number, logical: number, appliedCount = 0, timestamp = Date.now()): DCHeartbeat {
  return {
    dcId,
    nodeId: `${dcId}/node-1`,
    hlc: { wallTime, logical, nodeId: `${dcId}/node-1` },
    appliedCount,
    timestamp,
  };
}

describe("DCSplitBrainDetector — lifecycle & heartbeat branches", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("start() is idempotent (second call early-returns)", () => {
    vi.useFakeTimers();
    const d = makeDetector();
    d.start();
    const timer1 = (d as any).heartbeatTimer;
    d.start(); // should no-op
    expect((d as any).heartbeatTimer).toBe(timer1);
    d.stop();
  });

  it("receiveHeartbeat early-returns when not started", () => {
    const d = makeDetector();
    // Not started → receiveHeartbeat should be a no-op (no divergence check)
    d.receiveHeartbeat(hb("dc-2", 1, 1));
    expect(d.hasSplitBrain()).toBe(false);
    expect(d.getActiveSplitBrains()).toHaveLength(0);
  });

  it("trims the HLC chain when it exceeds maxHlcChainLength", () => {
    const d = makeDetector();
    d.start();

    // Feed 105 heartbeats from dc-2 (over the 100-entry cap)
    for (let i = 0; i < 105; i++) {
      d.receiveHeartbeat(hb("dc-2", i, i));
    }

    const chain = (d as any).dcHlcChains.get("dc-2");
    expect(chain.length).toBeLessThanOrEqual(100);
    d.stop();
  });

  it("broadcastHeartbeat emits a heartbeat and detects expired entries", () => {
    vi.useFakeTimers();
    const d = makeDetector();
    d.start();

    const heartbeatSpy = vi.fn();
    const expiredSpy = vi.fn();
    (d as any).emitter.on("heartbeat", heartbeatSpy);
    (d as any).emitter.on("heartbeat-expired", expiredSpy);

    // Seed a stale remote heartbeat well past the timeout
    (d as any).remoteHeartbeats.set("dc-2", hb("dc-2", 1, 1, 0, Date.now() - 60_000));

    (d as any).broadcastHeartbeat();

    expect(heartbeatSpy).toHaveBeenCalledTimes(1);
    expect(expiredSpy).toHaveBeenCalledTimes(1);
    expect(expiredSpy.mock.calls[0][0].dcId).toBe("dc-2");
    d.stop();
  });

  it("onSplitBrainResolved registers and unregisters a callback", () => {
    const d = makeDetector();
    const cb = vi.fn();
    const off = d.onSplitBrainResolved(cb);

    // No split-brain yet → emit manually to prove wiring
    (d as any).emitter.emit("split-brain-resolved", { detectedAt: 1 });
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    (d as any).emitter.emit("split-brain-resolved", { detectedAt: 2 });
    expect(cb).toHaveBeenCalledTimes(1); // unchanged after unregister
  });

  it("broadcastHeartbeat early-returns when not started", () => {
    const d = makeDetector();
    const heartbeatSpy = vi.fn();
    (d as any).emitter.on("heartbeat", heartbeatSpy);

    (d as any).broadcastHeartbeat(); // not started → no emit
    expect(heartbeatSpy).not.toHaveBeenCalled();
  });

  it("resolveSplitBrain returns null when winner is not part of a divergence", () => {
    const d = makeDetector();
    d.start();

    // No divergence → no active split-brain → resolve on unknown winner is null
    const result = d.resolveSplitBrain("ghost-dc");
    expect(result).toBeNull();
    d.stop();
  });

  it("resolveSplitBrain skips a winner that is not in a detected divergence", () => {
    // Build a real split-brain (advanccing HLC chains on two DCs) with
    // autoRecover=false, then resolve against a winner not in the divergence.
    const d = makeDetector({ autoRecover: false });
    d.start();

    const base = Date.now();
    // dc-2: independently advancing logical counters
    for (let i = 0; i < 5; i++) {
      d.receiveHeartbeat({ dcId: "dc-2", nodeId: "dc-2/node-1", hlc: { wallTime: base + i * 1000, logical: 10 + i, nodeId: "dc-2/node-1" }, appliedCount: 0, timestamp: Date.now() });
    }
    // dc-1 (local): independently advancing logical counters
    for (let i = 0; i < 5; i++) {
      d.receiveHeartbeat({ dcId: "dc-1", nodeId: "dc-1/node-2", hlc: { wallTime: base + i * 800, logical: 20 + i, nodeId: "dc-1/node-2" }, appliedCount: 0, timestamp: Date.now() });
    }

    expect(d.hasSplitBrain()).toBe(true);

    // "ghost-dc" is not in any detected divergence → includes() is false
    const result = d.resolveSplitBrain("ghost-dc");
    expect(result).toBeNull();

    // Resolving with the actual winner (dc-1 or dc-2) hits the true branch.
    const events = d.getActiveSplitBrains();
    const winner = events[0]!.winningDc;
    const resolved = d.resolveSplitBrain(winner);
    expect(resolved).not.toBeNull();
    expect(resolved!.winningDc).toBe(winner);
    d.stop();
  });
});
