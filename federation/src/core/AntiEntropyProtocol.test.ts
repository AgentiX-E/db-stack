/**
 * AntiEntropyProtocol — the sweep, over a real transport.
 *
 * `InProcessTransport` is a real `ITransport`: it addresses peers by id, delivers
 * frames to subscribers and can refuse a send for an unknown peer. It is not a
 * mock of the protocol's dependencies — it is one implementation of them, and the
 * one whose failure modes (an unreachable peer, a refused send) are cheapest to
 * produce here and identical to the ones TLS produces in the e2e suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InProcessTransport } from '../transport/InProcessTransport';
import { HLC } from '../hlc/HLC';
import { AntiEntropy, type DataEntry, type DataProvider } from '../replication/AntiEntropy';
import { AntiEntropyProtocol } from './AntiEntropyProtocol';
import { AE_PUSH_TYPE, AE_SUMMARY_TYPE } from '../replication/antientropyFrames';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';

// ── Fixtures ──

class MapProvider implements DataProvider {
  readonly data = new Map<string, DataEntry>();

  async getRange(start: string, end: string): Promise<DataEntry[]> {
    return [...this.data.values()]
      .filter((entry) => entry.key >= start && entry.key <= end)
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  async getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]> {
    return [...this.data.values()]
      .filter((entry) => entry.key > afterKey)
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
  }
  async apply(key: string, value: string, origin?: { hlc: DataEntry['hlc']; nodeId: string }): Promise<void> {
    this.data.set(key, {
      key,
      value,
      hlc: origin?.hlc ?? { wallTime: 1, logical: 0, nodeId: 'local' },
      nodeId: origin?.nodeId ?? 'local',
    });
  }
  async get(key: string): Promise<DataEntry | null> {
    return this.data.get(key) ?? null;
  }
}

interface Node {
  transport: InProcessTransport;
  provider: MapProvider;
  antiEntropy: AntiEntropy;
  protocol: AntiEntropyProtocol;
  unsubscribe: () => void;
}

function node(id: string, registryKey: string, targets: string[], options: { exchangeTimeoutMs?: number } = {}): Node {
  const transport = new InProcessTransport({ nodeId: id, registryKey });
  const provider = new MapProvider();
  const antiEntropy = new AntiEntropy({ nodeId: id, intervalMs: 60_000, merkleDepth: 4 }, provider);
  const protocol = new AntiEntropyProtocol(transport, new HLC(id), antiEntropy, {
    nodeId: id,
    targets,
    intervalMs: 0,
    exchangeTimeoutMs: options.exchangeTimeoutMs ?? 200,
  });
  // Routing, exactly as `FederationManager` does it: the first protocol that
  // claims the frame owns it.
  const unsubscribe = transport.onMessage((msg) => {
    void protocol.handle(msg).catch(() => undefined);
  });
  return { transport, provider, antiEntropy, protocol, unsubscribe };
}

function put(target: Node, key: string, value: string, wallTime: number, origin = 'seed'): void {
  target.provider.data.set(key, {
    key,
    value,
    hlc: { wallTime, logical: 0, nodeId: origin },
    nodeId: origin,
  });
}

function teardown(nodes: Node[]): void {
  for (const n of nodes) {
    n.unsubscribe();
    n.protocol.stop();
  }
}

/**
 * A transport whose socket is gone: `send()` rejects rather than resolving
 * `false`, which is the other half of "the frame did not arrive".
 *
 * `deliver` stands in for the socket's other direction, so a case can hand the
 * protocol an inbound frame without a peer to send it.
 */
function rejectingTransport(): { transport: ITransport; deliver: (msg: InboundMessage) => void } {
  let listener: ((msg: InboundMessage) => void) | null = null;
  const transport: ITransport = {
    send: async () => {
      throw new Error('socket exploded');
    },
    broadcast: async () => 0,
    onMessage: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    getConnectedPeers: () => [],
    getStats: () => ({
      peersConnected: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };
  return { transport, deliver: (msg) => listener?.(msg) };
}

// ── Convergence ──

describe('AntiEntropyProtocol — convergence', () => {
  let a: Node;
  let b: Node;

  beforeEach(() => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    a = node('dc-a', key, ['dc-b']);
    b = node('dc-b', key, ['dc-a']);
    a.protocol.start();
    b.protocol.start();
  });

  afterEach(() => {
    teardown([a, b]);
  });

  it('brings both sides to the same root in one sweep', async () => {
    put(a, 'a-only', 'from-a', 100);
    put(b, 'b-only', 'from-b', 200);

    await a.protocol.sweep();

    expect(await a.antiEntropy.getMerkleRoot('default')).toBe(await b.antiEntropy.getMerkleRoot('default'));
    expect([...a.provider.data.keys()].sort()).toEqual(['a-only', 'b-only']);
    expect([...b.provider.data.keys()].sort()).toEqual(['a-only', 'b-only']);
  });

  it('reports the root each peer claimed', async () => {
    put(a, 'k', 'v', 100);
    await a.protocol.sweep();

    const status = a.protocol.getStatus();
    expect(status.selfRoot).not.toBeNull();
    // The peer's root is fetched, not inferred: this is the number the old
    // implementation took from its caller.
    expect(status.peers['dc-b']).toMatchObject({ depth: 4, total: 0 });
    expect(status.repliesReceived).toBe(1);
    expect(status.entriesApplied).toBe(0);
  });

  it('does nothing on a second sweep once the roots agree', async () => {
    put(a, 'k', 'v', 100);
    await a.protocol.sweep();
    const after = a.protocol.getStatus();

    await a.protocol.sweep();
    const later = a.protocol.getStatus();

    expect(later.pushesSent).toBe(after.pushesSent);
    expect(later.entriesApplied).toBe(after.entriesApplied);
  });

  it('counts a sweep even when there is nothing to do', async () => {
    await a.protocol.sweep();
    expect(a.protocol.getStatus().sweeps).toBe(1);
    expect(a.protocol.getStatus().requestsSent).toBe(1);
  });
});

// ── Failure modes ──

describe('AntiEntropyProtocol — failure modes', () => {
  it('counts a timeout when the peer never answers', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    // A transport that exists and accepts frames, with nobody subscribed to them.
    // That is the shape of a peer whose process is up and whose protocol is not:
    // the send succeeds, so the only way to learn anything is the budget expiring.
    new InProcessTransport({ nodeId: 'dc-mute', registryKey: key });
    const lonely = node('dc-solo', key, ['dc-mute'], { exchangeTimeoutMs: 30 });
    lonely.protocol.start();

    await lonely.protocol.sweep();

    const status = lonely.protocol.getStatus();
    expect(status.timeouts).toBe(1);
    expect(status.lastError).toMatch(/no digest answer/);
    // The peer's silence is not an error a caller has to catch, but it is not
    // agreement either: the sweep completed and learned nothing.
    expect(status.selfRoot).not.toBeNull();

    teardown([lonely]);
  });

  it('abandons the wait when the transport refuses the frame', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const lonely = node('dc-solo', key, ['dc-absent'], { exchangeTimeoutMs: 5_000 });
    lonely.protocol.start();

    const startedAt = Date.now();
    await lonely.protocol.sweep();

    // Refused synchronously by the registry, so the round trip ends immediately
    // rather than waiting out a budget that nothing is working towards.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(lonely.protocol.getStatus().lastError).toMatch(/refused a digest request/);

    teardown([lonely]);
  });

  it('counts a frame it cannot read instead of treating it as agreement', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const receiver = node('dc-r', key, []);
    receiver.protocol.start();

    const garbage = new TextEncoder().encode('{"kind":"request"}');
    await receiver.protocol.handle({
      messageId: 'bad-1',
      sourcePeerId: 'dc-x',
      targetPeerId: 'dc-r',
      payload: garbage,
      timestamp: new HLC('dc-x').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_SUMMARY_TYPE,
    });

    const status = receiver.protocol.getStatus();
    expect(status.malformed).toBe(1);
    expect(status.lastError).toMatch(/not a decodable anti-entropy summary/);

    teardown([receiver]);
  });

  it('counts an unreadable push', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const receiver = node('dc-r', key, []);
    receiver.protocol.start();

    await receiver.protocol.handle({
      messageId: 'bad-2',
      sourcePeerId: 'dc-x',
      targetPeerId: 'dc-r',
      payload: new TextEncoder().encode('not json'),
      timestamp: new HLC('dc-x').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_PUSH_TYPE,
    });

    expect(receiver.protocol.getStatus().malformed).toBe(1);
    expect(receiver.protocol.getStatus().lastError).toMatch(/not a decodable anti-entropy push/);

    teardown([receiver]);
  });

  it('declines a frame of another family', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const receiver = node('dc-r', key, []);

    const claimed = await receiver.protocol.handle({
      messageId: 'other-1',
      sourcePeerId: 'dc-x',
      targetPeerId: 'dc-r',
      payload: new Uint8Array(),
      timestamp: new HLC('dc-x').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: 'cdc_ack',
    });

    expect(claimed).toBe(false);
    teardown([receiver]);
  });

  it('counts an answer that arrived after its wait expired', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    new InProcessTransport({ nodeId: 'dc-b', registryKey: key });
    const nodeA = node('dc-a', key, ['dc-b'], { exchangeTimeoutMs: 20 });
    nodeA.protocol.start();
    await nodeA.protocol.sweep();

    // The late answer: same id, nobody waiting.
    const late = nodeA.protocol.getStatus();
    expect(late.timeouts).toBeGreaterThanOrEqual(1);

    await nodeA.protocol.handle({
      messageId: 'never-waited',
      sourcePeerId: 'dc-b',
      targetPeerId: 'dc-a',
      payload: new TextEncoder().encode(
        JSON.stringify({
          kind: 'reply',
          shardId: 'default',
          digest: { shardId: 'default', depth: 4, root: 'r', total: 0, leaves: [] },
          want: [],
        }),
      ),
      timestamp: new HLC('dc-b').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_SUMMARY_TYPE,
    });

    expect(nodeA.protocol.getStatus().unsolicited).toBe(1);
    teardown([nodeA]);
  });
});

// ── Lifecycle ──

describe('AntiEntropyProtocol — lifecycle', () => {
  it('does not sweep on start', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, ['dc-b']);
    n.protocol.start();

    // Nothing is sent until a sweep is asked for: a first frame the caller cannot
    // predict is a frame that races the caller's own assertion.
    expect(n.protocol.getStatus().requestsSent).toBe(0);
    expect(n.protocol.getStatus().sweeps).toBe(0);

    teardown([n]);
  });

  it('binds every target exactly once and unbinds them on stop', () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, ['dc-b', 'dc-c'], {});
    n.protocol.start();

    expect(n.antiEntropy.getPeers().sort()).toEqual(['dc-b', 'dc-c']);

    n.protocol.stop();
    expect(n.antiEntropy.getPeers()).toEqual([]);
    n.unsubscribe();
  });

  it('ignores a second start', () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, ['dc-b']);
    n.protocol.start();
    n.protocol.start();
    expect(n.antiEntropy.getPeers()).toEqual(['dc-b']);
    teardown([n]);
  });

  it('does not run two sweeps at once', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const a = node('dc-a', key, ['dc-b']);
    const b = node('dc-b', key, ['dc-a']);
    a.protocol.start();
    b.protocol.start();
    put(a, 'k', 'v', 1);

    // Overlapping sweeps would push the same bucket twice and count the second as
    // a divergence that does not exist.
    await Promise.all([a.protocol.sweep(), a.protocol.sweep()]);
    expect(a.protocol.getStatus().sweeps).toBe(1);

    teardown([a, b]);
  });

  it('sweeps on its interval when one is configured', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const transport = new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-a', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-a'), antiEntropy, {
      nodeId: 'dc-a',
      targets: ['dc-b'],
      intervalMs: 20,
      exchangeTimeoutMs: 20,
    });
    protocol.start();

    await new Promise((resolve) => setTimeout(resolve, 90));
    protocol.stop();

    expect(protocol.getStatus().sweeps).toBeGreaterThanOrEqual(1);
  });

  it('reports a sweep that threw rather than swallowing it', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, []);
    // Break the algorithm underneath: a digest that cannot be built is a sweep
    // that learned nothing, and `catch(() => {})` was how that stayed invisible.
    n.antiEntropy.buildDigest = async () => {
      throw new Error('digest unavailable');
    };
    n.protocol.start();

    await n.protocol.sweep();

    expect(n.protocol.getStatus().lastError).toMatch(/digest unavailable/);
    expect(n.protocol.getStatus().sweeps).toBe(1);
    teardown([n]);
  });
});

// ── Push batching ──

describe('AntiEntropyProtocol — push batching', () => {
  it('splits a bucket across frames and marks all but the last as having more', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const transport = new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-a', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-a'), antiEntropy, {
      nodeId: 'dc-a',
      targets: ['dc-b'],
      intervalMs: 0,
      maxEntriesPerFrame: 2,
    });

    const frames: Array<{ more: boolean; count: number }> = [];
    const receiver = new InProcessTransport({ nodeId: 'dc-b', registryKey: key });
    receiver.onMessage((msg) => {
      const body = JSON.parse(new TextDecoder().decode(msg.payload)) as { entries: unknown[]; more: boolean };
      frames.push({ more: body.more, count: body.entries.length });
    });

    const entries: DataEntry[] = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
      hlc: { wallTime: 1, logical: 0, nodeId: 'dc-a' },
      nodeId: 'dc-a',
    }));

    await protocol['sendPush']('dc-b', 'default', '0000', entries);

    expect(frames.map((frame) => frame.count)).toEqual([2, 2, 1]);
    expect(frames.map((frame) => frame.more)).toEqual([true, true, false]);
    expect(protocol.getStatus().pushesSent).toBe(3);
    protocol.stop();
  });

  it('reports a refused push and stops sending the rest of the bucket', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const transport = new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-a', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-a'), antiEntropy, {
      nodeId: 'dc-a',
      targets: ['nobody'],
      intervalMs: 0,
      maxEntriesPerFrame: 1,
    });

    const entries: DataEntry[] = [
      { key: 'k0', value: 'v0', hlc: { wallTime: 1, logical: 0, nodeId: 'dc-a' }, nodeId: 'dc-a' },
      { key: 'k1', value: 'v1', hlc: { wallTime: 1, logical: 0, nodeId: 'dc-a' }, nodeId: 'dc-a' },
    ];

    const delivered = await protocol['sendPush']('nobody', 'default', '0000', entries);

    expect(delivered).toBe(false);
    expect(protocol.getStatus().lastError).toMatch(/refused a push of bucket/);
    protocol.stop();
  });
});

// ── Refusals the transport produces, not the peer ──

describe('AntiEntropyProtocol — a transport that fails rather than refuses', () => {
  function throwingTransport(): {
    transport: ITransport;
    deliver: (msg: InboundMessage) => void;
  } {
    const handlers: Array<(msg: InboundMessage) => void> = [];
    const transport: ITransport = {
      send: async () => {
        throw new Error('socket exploded');
      },
      broadcast: async () => 0,
      onMessage: (callback) => {
        handlers.push(callback);
        return () => {
          const index = handlers.indexOf(callback);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
      getConnectedPeers: () => [],
      getStats: () => ({
        peersConnected: 0,
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        uptimeMs: 0,
      }),
    };
    return { transport, deliver: (msg) => handlers.forEach((handler) => handler(msg)) };
  }

  it('ends the round trip when the send throws instead of waiting out the budget', async () => {
    const { transport } = throwingTransport();
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-a', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-a'), antiEntropy, {
      nodeId: 'dc-a',
      targets: ['dc-b'],
      intervalMs: 0,
      exchangeTimeoutMs: 5_000,
    });
    protocol.start();

    const startedAt = Date.now();
    await protocol.sweep();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(protocol.getStatus().lastError).toMatch(/socket exploded/);
    protocol.stop();
  });

  it('records a digest it could not build instead of pretending the sweep worked', async () => {
    const { transport, deliver } = throwingTransport();
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-r', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-r'), antiEntropy, {
      nodeId: 'dc-r',
      targets: [],
      intervalMs: 0,
    });
    protocol.start();
    // Routing is the manager's job in production; here the test is the manager.
    transport.onMessage((msg) => {
      void protocol.handle(msg);
    });
    antiEntropy.buildDigest = async () => {
      throw new Error('digest unavailable');
    };

    deliver({
      messageId: 'req-1',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-r',
      payload: new TextEncoder().encode(
        JSON.stringify({
          kind: 'request',
          shardId: 'default',
          digest: {
            shardId: 'default',
            depth: 4,
            root: 'r',
            total: 0,
            leaves: Array.from({ length: 16 }, (_, i) => ({
              prefix: i.toString(2).padStart(4, '0'),
              hash: 'h',
              count: 0,
            })),
          },
        }),
      ),
      timestamp: new HLC('dc-a').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_SUMMARY_TYPE,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(protocol.getStatus().lastError).toMatch(/digest unavailable/);
    protocol.stop();
  });

  it('records a push it could not apply', async () => {
    const { transport, deliver } = throwingTransport();
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-r', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-r'), antiEntropy, {
      nodeId: 'dc-r',
      targets: [],
      intervalMs: 0,
    });
    protocol.start();
    transport.onMessage((msg) => {
      void protocol.handle(msg);
    });
    antiEntropy.applyRemote = async () => {
      throw new Error('store is read-only');
    };

    deliver({
      messageId: 'push-1',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-r',
      payload: new TextEncoder().encode(
        JSON.stringify({
          shardId: 'default',
          prefix: '0000',
          entries: [{ key: 'k', value: 'v', hlc: { wallTime: 1, logical: 0, nodeId: 'a' }, nodeId: 'a' }],
          more: false,
        }),
      ),
      timestamp: new HLC('dc-a').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_PUSH_TYPE,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(protocol.getStatus().lastError).toMatch(/store is read-only/);
    expect(protocol.getStatus().pushesReceived).toBe(0);
    protocol.stop();
  });

  it('records a reply the transport would not carry', async () => {
    const { transport, deliver } = throwingTransport();
    const provider = new MapProvider();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-r', intervalMs: 60_000, merkleDepth: 4 }, provider);
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-r'), antiEntropy, {
      nodeId: 'dc-r',
      targets: [],
      intervalMs: 0,
    });
    protocol.start();
    transport.onMessage((msg) => {
      void protocol.handle(msg);
    });

    deliver({
      messageId: 'req-2',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-r',
      payload: new TextEncoder().encode(
        JSON.stringify({
          kind: 'request',
          shardId: 'default',
          digest: {
            shardId: 'default',
            depth: 4,
            root: 'r',
            total: 0,
            leaves: Array.from({ length: 16 }, (_, i) => ({
              prefix: i.toString(2).padStart(4, '0'),
              hash: 'h',
              count: 0,
            })),
          },
        }),
      ),
      timestamp: new HLC('dc-a').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_SUMMARY_TYPE,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(protocol.getStatus().lastError).toMatch(/socket exploded/);
    expect(protocol.getStatus().repliesSent).toBe(0);
    protocol.stop();
  });

  it('skips a bucket that emptied between the digest and the read', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, ['dc-b']);
    n.protocol.start();

    // The peer claims the bucket holds something; by the time this side reads it,
    // it does not. An empty push would tell the peer nothing, and the next sweep
    // compares again.
    const before = n.protocol.getStatus().pushesSent;
    await n.protocol['sendPushTo']('dc-b', 'default', '0000');

    expect(n.protocol.getStatus().pushesSent).toBe(before);
    expect(n.protocol.getStatus().lastError).toBeNull();
    teardown([n]);
  });
});

// ── Defaults and abandoned waits ──

describe('AntiEntropyProtocol — defaults and abandoned waits', () => {
  it('sweeps on a fifteen-second interval when nothing says otherwise', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const transport = new InProcessTransport({ nodeId: 'dc-a', registryKey: key });
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-a', intervalMs: 60_000, merkleDepth: 4 }, new MapProvider());
    // No `intervalMs`: the default is 15 000, which is long enough that the
    // assertion below cannot be a race and short enough that the timer is real.
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-a'), antiEntropy, {
      nodeId: 'dc-a',
      targets: [],
    });
    protocol.start();

    expect(protocol.getStatus().sweeps).toBe(0);
    await protocol.sweep();
    expect(protocol.getStatus().sweeps).toBe(1);

    protocol.stop();
  });

  it('records a digest reply the transport refused, and stays answerable', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, []);
    n.protocol.start();

    const digest = await n.antiEntropy.buildDigest('default');
    // A requester that is not on this registry: the reply has nowhere to go, and
    // the transport says so by resolving `false` rather than by throwing.
    await n.protocol.handle({
      messageId: 'req-from-nowhere',
      sourcePeerId: 'dc-ghost',
      targetPeerId: 'dc-a',
      payload: new TextEncoder().encode(JSON.stringify({ kind: 'request', shardId: 'default', digest })),
      timestamp: new HLC('dc-ghost').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_SUMMARY_TYPE,
    });

    expect(n.protocol.getStatus().repliesSent).toBe(0);
    expect(n.protocol.getStatus().lastError).toMatch(/refused a digest reply for dc-ghost/);
    teardown([n]);
  });

  it('abandons an outstanding round trip when stopped, and settles it once', async () => {
    const key = `ae-${Math.random().toString(36).slice(2)}`;
    const n = node('dc-a', key, []);
    n.protocol.start();
    const digest = await n.antiEntropy.buildDigest('default');

    // A peer that is on the registry and answers nothing: the exchange is still
    // outstanding when `stop()` runs. Leaving it to expire would resolve a promise
    // five seconds after the protocol stopped being able to answer it.
    const peer = n.protocol['makePeer']('dc-silent');
    const pending = peer.exchange('default', digest);

    n.protocol.stop();
    expect(await pending).toBeNull();
    expect(n.protocol.getStatus().timeouts).toBe(0);

    teardown([n]);
  });

  it('records a push whose store rejected with a bare string', async () => {
    const { transport, deliver } = rejectingTransport();
    const antiEntropy = new AntiEntropy({ nodeId: 'dc-r', intervalMs: 60_000, merkleDepth: 4 }, new MapProvider());
    const protocol = new AntiEntropyProtocol(transport, new HLC('dc-r'), antiEntropy, {
      nodeId: 'dc-r',
      targets: [],
      intervalMs: 0,
    });
    protocol.start();
    transport.onMessage((msg) => {
      void protocol.handle(msg);
    });
    antiEntropy.applyRemote = async () => {
      // eslint-disable-next-line no-throw-literal -- the case under test is a store that rejects with a value rather than an Error
      throw 'store is read-only';
    };

    deliver({
      messageId: 'push-string',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-r',
      payload: new TextEncoder().encode(
        JSON.stringify({
          shardId: 'default',
          prefix: '0000',
          entries: [{ key: 'k', value: 'v', hlc: { wallTime: 1, logical: 0, nodeId: 'a' }, nodeId: 'a' }],
          more: false,
        }),
      ),
      timestamp: new HLC('dc-a').now(),
      createdAt: Date.now(),
      receivedAt: Date.now(),
      type: AE_PUSH_TYPE,
    });

    // A rejection that is not an `Error` still has to read as a reason: a store
    // that throws a string is a store whose failure would otherwise be reported
    // as `[object Object]`.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(protocol.getStatus().lastError).toBe('store is read-only');
    protocol.stop();
  });
});
