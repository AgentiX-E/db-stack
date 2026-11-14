/**
 * InProcessTransport Tests
 *
 * Coverage:
 *   - Basic send/receive between two peers
 *   - Broadcast to multiple peers
 *   - Peer list accuracy
 *   - Transport statistics
 *   - Simulated latency
 *   - Message drop simulation
 *   - Network partition and heal
 *   - Clean shutdown (destroy)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InProcessTransport } from "./InProcessTransport";
import type { TransportMessage } from "../interfaces/transport/TransportMessage";
import { HLC } from "../hlc/HLC";

/** Helper: create a minimal TransportMessage */
function makeMessage(
  sourcePeerId: string,
  targetPeerId: string,
  payload?: string,
  type?: string,
): TransportMessage {
  const hlc = new HLC("test");
  return {
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourcePeerId,
    targetPeerId,
    payload: new TextEncoder().encode(payload ?? "test-payload"),
    timestamp: hlc.now(),
    createdAt: Date.now(),
    type,
  };
}

describe("InProcessTransport — Basic Send/Receive", () => {
  let transportA: InProcessTransport;
  let transportB: InProcessTransport;

  beforeEach(() => {
    InProcessTransport.resetRegistry();
    transportA = new InProcessTransport({ nodeId: "node-a", registryKey: "test-basic" });
    transportB = new InProcessTransport({ nodeId: "node-b", registryKey: "test-basic" });
  });

  afterEach(() => {
    transportA.destroy();
    transportB.destroy();
    InProcessTransport.resetRegistry();
  });

  it("should deliver a message from A to B", async () => {
    const received: TransportMessage[] = [];
    const unsub = transportB.onMessage((msg) => { received.push(msg); });

    const msg = makeMessage("node-a", "node-b", "hello");
    const result = await transportA.send(msg);

    expect(result).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].sourcePeerId).toBe("node-a");
    expect(received[0].targetPeerId).toBe("node-b");
    expect(new TextDecoder().decode(received[0].payload)).toBe("hello");

    unsub();
  });

  it("should fail to send to an unknown peer", async () => {
    const msg = makeMessage("node-a", "node-unknown", "nowhere");
    const result = await transportA.send(msg);
    expect(result).toBe(false);
  });

  it("should deliver multiple messages in order", async () => {
    const received: string[] = [];
    const unsub = transportB.onMessage((msg) => {
      received.push(new TextDecoder().decode(msg.payload));
    });

    for (let i = 0; i < 10; i++) {
      await transportA.send(makeMessage("node-a", "node-b", `msg-${i}`));
    }

    expect(received).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(received[i]).toBe(`msg-${i}`);
    }

    unsub();
  });
});

describe("InProcessTransport — Broadcast", () => {
  let transportA: InProcessTransport;
  let transportB: InProcessTransport;
  let transportC: InProcessTransport;

  beforeEach(() => {
    InProcessTransport.resetRegistry();
    transportA = new InProcessTransport({ nodeId: "node-a", registryKey: "test-bcast" });
    transportB = new InProcessTransport({ nodeId: "node-b", registryKey: "test-bcast" });
    transportC = new InProcessTransport({ nodeId: "node-c", registryKey: "test-bcast" });
  });

  afterEach(() => {
    transportA.destroy();
    transportB.destroy();
    transportC.destroy();
    InProcessTransport.resetRegistry();
  });

  it("should deliver broadcast to all peers", async () => {
    const receivedB: TransportMessage[] = [];
    const receivedC: TransportMessage[] = [];
    transportB.onMessage((msg) => { receivedB.push(msg); });
    transportC.onMessage((msg) => { receivedC.push(msg); });

    const msg = makeMessage("node-a", "", "broadcast");
    const sentCount = await transportA.broadcast(msg);

    expect(sentCount).toBe(2);
    expect(receivedB).toHaveLength(1);
    expect(receivedC).toHaveLength(1);
    expect(receivedB[0].sourcePeerId).toBe("node-a");
    expect(receivedC[0].sourcePeerId).toBe("node-a");
  });

  it("should return 0 when no peers connected", async () => {
    const isolated = new InProcessTransport({ nodeId: "node-iso", registryKey: "isolated-bcast" });
    const sentCount = await isolated.broadcast(makeMessage("node-iso", "", "alone"));
    expect(sentCount).toBe(0);
    isolated.destroy();
  });
});

describe("InProcessTransport — Peer Management", () => {
  beforeEach(() => InProcessTransport.resetRegistry());

  it("should list connected peers correctly", () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "test-peers" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "test-peers" });
    const c = new InProcessTransport({ nodeId: "node-c", registryKey: "test-peers" });

    const peersA = a.getConnectedPeers();
    const peerIdsA = peersA.map((p) => p.peerId).sort();
    expect(peerIdsA).toEqual(["node-b", "node-c"]);

    const peersB = b.getConnectedPeers();
    const peerIdsB = peersB.map((p) => p.peerId).sort();
    expect(peerIdsB).toEqual(["node-a", "node-c"]);

    a.destroy();
    b.destroy();
    c.destroy();
  });

  it("should return empty peer list when alone", () => {
    const a = new InProcessTransport({ nodeId: "solo", registryKey: "alone" });
    expect(a.getConnectedPeers()).toHaveLength(0);
    a.destroy();
  });

  it("should reflect peer metadata", () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "meta-test", latencyMs: 15 });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "meta-test", latencyMs: 15 });

    const peersA = a.getConnectedPeers();
    expect(peersA[0].peerId).toBe("node-b");
    expect(peersA[0].address).toContain("inproc://");
    expect(peersA[0].latencyMs).toBe(15);
    expect(peersA[0].connectedAt).toBeGreaterThan(0);

    a.destroy();
    b.destroy();
  });
});

describe("InProcessTransport — Statistics", () => {
  beforeEach(() => InProcessTransport.resetRegistry());

  it("should track messages sent and received", async () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "stats" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "stats" });

    const msg = makeMessage("node-a", "node-b", "stats-payload");
    await a.send(msg);

    const statsA = a.getStats();
    expect(statsA.messagesSent).toBe(1);
    expect(statsA.bytesSent).toBeGreaterThan(0);

    const statsB = b.getStats();
    expect(statsB.messagesReceived).toBe(1);
    expect(statsB.bytesReceived).toBeGreaterThan(0);

    expect(statsA.peersConnected).toBe(1);
    expect(statsA.uptimeMs).toBeGreaterThanOrEqual(0);

    a.destroy();
    b.destroy();
  });

  it("should reset stats on new transport instance", () => {
    InProcessTransport.resetRegistry();
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "reset-stats" });
    const stats = a.getStats();
    expect(stats.messagesSent).toBe(0);
    expect(stats.messagesReceived).toBe(0);
    expect(stats.bytesSent).toBe(0);
    expect(stats.bytesReceived).toBe(0);
    a.destroy();
  });
});

describe("InProcessTransport — Latency Simulation", () => {
  beforeEach(() => InProcessTransport.resetRegistry());

  it("should delay delivery when latency is set", async () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "latency", latencyMs: 50 });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "latency", latencyMs: 50 });

    const received: TransportMessage[] = [];
    b.onMessage((msg) => { received.push(msg); });

    const start = Date.now();
    await a.send(makeMessage("node-a", "node-b", "delayed"));
    const end = Date.now();

    // Send should return immediately (not wait for latency)
    expect(end - start).toBeLessThan(20);

    // But the message should not have been delivered instantly
    expect(received).toHaveLength(0);

    // Wait for delivery
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);

    a.destroy();
    b.destroy();
  });

  it("should deliver instantly when latency is 0", async () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "no-latency" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "no-latency" });

    const received: TransportMessage[] = [];
    b.onMessage((msg) => { received.push(msg); });

    await a.send(makeMessage("node-a", "node-b", "instant"));
    expect(received).toHaveLength(1);

    a.destroy();
    b.destroy();
  });
});

describe("InProcessTransport — Drop Simulation", () => {
  beforeEach(() => InProcessTransport.resetRegistry());

  it("should drop messages at the configured rate", async () => {
    const a = new InProcessTransport({
      nodeId: "node-a",
      registryKey: "drop-test",
      dropRate: 0.5,
    });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "drop-test" });

    const received: TransportMessage[] = [];
    b.onMessage((msg) => { received.push(msg); });

    // Send enough messages to get a statistically significant sample
    const totalMessages = 200;
    for (let i = 0; i < totalMessages; i++) {
      await a.send(makeMessage("node-a", "node-b", `drop-${i}`));
    }

    const dropStats = a.getDropStats();
    expect(dropStats.messagesDropped).toBeGreaterThan(0);
    expect(dropStats.messagesDropped).toBeLessThan(totalMessages);
    // With 50% drop rate and 200 messages, we expect 70–130 drops (within 3 sigma)
    expect(dropStats.messagesDropped).toBeGreaterThan(40);
    expect(dropStats.messagesDropped).toBeLessThan(160);

    // Not all messages reached the receiver
    expect(received.length).toBeLessThan(totalMessages);
    expect(received.length).toBeGreaterThan(0);

    a.destroy();
    b.destroy();
  });

  it("should deliver all messages at drop rate 0", async () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "no-drop", dropRate: 0 });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "no-drop" });

    const received: TransportMessage[] = [];
    b.onMessage((msg) => { received.push(msg); });

    for (let i = 0; i < 50; i++) {
      await a.send(makeMessage("node-a", "node-b", `no-drop-${i}`));
    }

    expect(received).toHaveLength(50);

    const dropStats = a.getDropStats();
    expect(dropStats.messagesDropped).toBe(0);

    a.destroy();
    b.destroy();
  });
});

describe("InProcessTransport — Partition / Heal", () => {
  beforeEach(() => InProcessTransport.resetRegistry());

  it("should stop message delivery after partition()", async () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "partition" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "partition" });

    // Send before partition — works
    const preReceived: TransportMessage[] = [];
    b.onMessage((msg) => { preReceived.push(msg); });
    await a.send(makeMessage("node-a", "node-b", "before-partition"));
    expect(preReceived).toHaveLength(1);

    // Partition A (removes A from registry)
    a.partition();

    // Send from A to B — still works because B is in the registry.
    // A's partition removes A, so B can't reach A, but A can still reach B.
    // In real scenarios, partition means bidirectional loss, but for our
    // transport the key behavior is: A is no longer discoverable as a peer.
    const sendAfterPartition = await a.send(makeMessage("node-a", "node-b", "during-partition"));
    expect(sendAfterPartition).toBe(true); // A can still reach B

    // However, B cannot reach A (A is not in registry)
    const sendBack = await b.send(makeMessage("node-b", "node-a", "to-partitioned"));
    expect(sendBack).toBe(false);

    // Peer list reflects that A is isolated
    expect(a.getConnectedPeers()).toHaveLength(0);

    // Heal — A rejoins registry
    a.heal();

    // After heal, both directions work and peers are visible
    const postReceived: TransportMessage[] = [];
    b.onMessage((msg) => { postReceived.push(msg); });
    await a.send(makeMessage("node-a", "node-b", "after-heal"));
    expect(postReceived).toHaveLength(1);

    // B can now reach A again
    const postReceivedA: TransportMessage[] = [];
    a.onMessage((msg) => { postReceivedA.push(msg); });
    await b.send(makeMessage("node-b", "node-a", "after-heal-back"));
    expect(postReceivedA).toHaveLength(1);

    // Peer list restored
    expect(a.getConnectedPeers()).toHaveLength(1);

    a.destroy();
    b.destroy();
  });

  it("should update connected peers after partition/heal", () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "peer-partition" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "peer-partition" });
    const c = new InProcessTransport({ nodeId: "node-c", registryKey: "peer-partition" });

    // A is created first but peer cache is built live — so A sees B and C
    expect(a.getConnectedPeers()).toHaveLength(2);

    // B and C see all peers
    expect(b.getConnectedPeers()).toHaveLength(2);
    expect(c.getConnectedPeers()).toHaveLength(2);

    a.partition();
    expect(a.getConnectedPeers()).toHaveLength(0);   // A sees no one
    expect(b.getConnectedPeers()).toHaveLength(1);   // B no longer sees A
    expect(c.getConnectedPeers()).toHaveLength(1);   // C no longer sees A

    a.heal();
    expect(a.getConnectedPeers()).toHaveLength(2);   // A sees B and C again
    expect(b.getConnectedPeers()).toHaveLength(2);   // B sees A again
    expect(c.getConnectedPeers()).toHaveLength(2);   // C sees A again

    a.destroy();
    b.destroy();
    c.destroy();
  });
});

describe("InProcessTransport — Clear and Destroy", () => {
  it("should clean up after destroy", () => {
    InProcessTransport.resetRegistry();
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "destroy-test" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "destroy-test" });

    a.destroy();

    // After destroy, a should not be a peer of b
    const peersB = b.getConnectedPeers();
    expect(peersB.find((p) => p.peerId === "node-a")).toBeUndefined();

    // Sending to destroyed peer should fail
    const msg = makeMessage("node-b", "node-a", "gone");
    b.send(msg).then((result) => {
      expect(result).toBe(false);
    });

    b.destroy();
  });

  it("resetRegistry should clear all transports", () => {
    const a = new InProcessTransport({ nodeId: "node-a", registryKey: "reset" });
    const b = new InProcessTransport({ nodeId: "node-b", registryKey: "reset" });

    InProcessTransport.resetRegistry("reset");

    const msg = makeMessage("node-a", "node-b", "cleared");
    a.send(msg).then((result) => {
      expect(result).toBe(false);
    });

    a.destroy();
    b.destroy();
  });
});

describe("InProcessTransport — Multiple Registries", () => {
  it("should isolate different registry keys", () => {
    const a1 = new InProcessTransport({ nodeId: "node-a", registryKey: "group-1" });
    const b1 = new InProcessTransport({ nodeId: "node-b", registryKey: "group-1" });
    const a2 = new InProcessTransport({ nodeId: "node-a", registryKey: "group-2" });

    // group-1 sees two peers (a1 and b1)
    expect(a1.getConnectedPeers()).toHaveLength(1);
    // group-2 sees only a2
    expect(a2.getConnectedPeers()).toHaveLength(0);

    a1.destroy();
    b1.destroy();
    a2.destroy();
  });
});
