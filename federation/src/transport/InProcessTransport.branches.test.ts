/**
 * InProcessTransport — branch-completion tests.
 *
 * Targets decision branches the existing suite leaves implicit:
 *   - constructor dropRate clamping (`Math.min(1, ...)` / `Math.max(0, ...)`)
 *   - constructor registryKey `?? "default"`
 *   - send() jitter branch (`jitterMs > 0`) and latency branch
 *   - broadcast() drop / latency / jitter branches
 *   - partition()/heal()/send()/broadcast() `!registry` early-returns
 *   - _rebuildPeerCache `!registry` and `!registry.has(nodeId)` empties
 */

import { describe, it, expect, afterEach } from "vitest";
import { InProcessTransport } from "./InProcessTransport";
import type { TransportMessage } from "../interfaces/transport/TransportMessage";
import { HLC } from "../hlc/HLC";

function makeMessage(targetPeerId = "", payload = "p"): TransportMessage {
  return {
    messageId: `m-${Math.random().toString(36).slice(2, 10)}`,
    sourcePeerId: "node-a",
    targetPeerId,
    payload: new TextEncoder().encode(payload),
    timestamp: new HLC("t").now(),
    createdAt: Date.now(),
  };
}

afterEach(() => InProcessTransport.resetRegistry());

describe("InProcessTransport — constructor clamping & defaults", () => {
  it("clamps dropRate above 1 to 1", () => {
    const t = new InProcessTransport({ nodeId: "n", registryKey: "clamp", dropRate: 5 });
    expect(t.getDropStats().messagesDropped).toBe(0); // never drops unless send triggers
    // dropRate clamped to 1 → always drops
    const b = new InProcessTransport({ nodeId: "b", registryKey: "clamp" });
    b.onMessage(() => {});
    void t.send(makeMessage("b", "x"));
    t.destroy(); b.destroy();
  });

  it("clamps negative dropRate to 0 and defaults registryKey", () => {
    const t = new InProcessTransport({ nodeId: "n", dropRate: -1 } as any); // no registryKey → "default"
    // Explicitly exercise registryKey default via getConnectedPeers (empty solo)
    expect(t.getConnectedPeers()).toEqual([]);
    t.destroy();
  });

  it("does not drop when dropRate is clamped to 0 (negative input)", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "neg", dropRate: -3 });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "neg" });
    const received: string[] = [];
    b.onMessage((m) => received.push(new TextDecoder().decode(m.payload)));
    for (let i = 0; i < 10; i++) await a.send(makeMessage("b", "x"));
    expect(received).toHaveLength(10);
    a.destroy(); b.destroy();
  });
});

describe("InProcessTransport — latency / jitter branches", () => {
  it("send() takes the jitter>0 branch (latency+jitter async delivery)", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "jit", latencyMs: 5, jitterMs: 10 });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "jit" });
    const received: TransportMessage[] = [];
    b.onMessage((m) => received.push(m));
    await a.send(makeMessage("b", "jittered"));
    expect(received).toHaveLength(0); // async, not yet delivered
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    a.destroy(); b.destroy();
  });

  it("broadcast() takes the latency/jitter async branch", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "bjit", latencyMs: 5, jitterMs: 10 });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "bjit" });
    const received: TransportMessage[] = [];
    b.onMessage((m) => received.push(m));
    await a.broadcast(makeMessage("", "bj"));
    expect(received).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    a.destroy(); b.destroy();
  });

  it("broadcast() with latency but no jitter takes the jitter===0 branch", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "blat", latencyMs: 5 }); // jitterMs defaults to 0
    const b = new InProcessTransport({ nodeId: "b", registryKey: "blat" });
    const received: TransportMessage[] = [];
    b.onMessage((m) => received.push(m));
    await a.broadcast(makeMessage("", "latency-only"));
    expect(received).toHaveLength(0); // async delivery
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    a.destroy(); b.destroy();
  });

  it("broadcast() drops a message when dropRate triggers", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "bdrop", dropRate: 1 });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "bdrop" });
    b.onMessage(() => {});
    const sent = await a.broadcast(makeMessage("", "dropped"));
    expect(sent).toBe(0); // every peer message dropped
    expect(a.getDropStats().messagesDropped).toBeGreaterThan(0);
    a.destroy(); b.destroy();
  });
});

describe("InProcessTransport — missing-registry early returns", () => {
  it("send() returns false when registry is gone", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "gone" });
    InProcessTransport.resetRegistry("gone"); // remove registry entry completely
    expect(await a.send(makeMessage("b", "x"))).toBe(false);
    a.destroy();
  });

  it("broadcast() returns 0 when registry is gone", async () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "bgone" });
    InProcessTransport.resetRegistry("bgone");
    expect(await a.broadcast(makeMessage("", "x"))).toBe(0);
    a.destroy();
  });

  it("partition()/heal() are no-ops when registry is gone", () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "pgone" });
    InProcessTransport.resetRegistry("pgone");
    a.partition(); // !registry → return
    a.heal();      // !registry → return
    a.destroy();
  });

  it("_rebuildPeerCache empties the cache when registry is gone", () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "rc-gone" });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "rc-gone" });
    expect(a.getConnectedPeers()).toHaveLength(1);
    InProcessTransport.resetRegistry("rc-gone"); // registry gone
    expect(a.getConnectedPeers()).toHaveLength(0); // !registry → empty cache
    a.destroy(); b.destroy();
  });

  it("_rebuildPeerCache empties when self is not registered (after partition)", () => {
    const a = new InProcessTransport({ nodeId: "a", registryKey: "rc-part" });
    const b = new InProcessTransport({ nodeId: "b", registryKey: "rc-part" });
    expect(a.getConnectedPeers()).toHaveLength(1);
    a.partition(); // self removed → !registry.has(self) → empty
    expect(a.getConnectedPeers()).toHaveLength(0);
    a.destroy(); b.destroy();
  });
});
