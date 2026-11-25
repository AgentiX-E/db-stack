/**
 * TcpSecureTransport — what the frame carries, and what a refusal costs.
 *
 * The AC 46 suite drives the happy path and the lifecycle suite drives the
 * reconnect schedule. This file drives the two properties a cross-datacenter
 * link lives or dies by, neither of which a return value can express:
 *
 *   - **The wire frame is the contract.** `send()` returning `true` says the
 *     transport accepted the message; it says nothing about whether the frame
 *     on the socket is one the receiving DC can decode. Every field is asserted
 *     here, including the ones that only exist because JSON cannot encode a
 *     BigInt.
 *   - **A configuration that cannot be addressed is refused at construction.**
 *     Two peers sharing a wire id, a node id with no number in it, a peer list
 *     that is a typo away from an empty one — each of these produces a link
 *     that never connects and an error message that blames the network. They
 *     are diagnosed where the configuration is still in someone's hands.
 *
 * Measurements of internal state are marked: they exist because the property
 * has no public surface cheap enough to observe, not because the surface is
 * unimportant.
 *
 * Acceptance criteria:
 *   AC 47.1  the wire frame carries every field the receiver needs
 *   AC 47.2  an address that is not a configured peer is refused by name
 *   AC 47.3  two peers sharing a wire id are refused, naming both
 *   AC 47.4  an id with no number in it is refused, naming the role
 *   AC 47.5  a peers: [] list falls through to the legacy address list
 *   AC 47.6  the retry schedule doubles, then holds at the cap
 *   AC 47.7  the retry attempt counter resets on success, and only then
 *   AC 47.8  a pending retry timer is replaced, not doubled
 *   AC 47.9  an unknown peer is not registered and does not reject
 *   AC 47.10 reachability falls back to the status snapshot
 *   AC 47.11 broadcast counts only the deliveries that succeeded
 *   AC 47.12 a multi-digit wire id maps back to its logical id
 *   AC 47.13 the injected default reaches the production transport
 *   AC 47.14 stats move forward with traffic, never backwards
 *   AC 47.15 destroy() stops delivering to subscribers
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
// The class through the published barrel, the schedule helper from the module:
// `retryDelayMs` is `@internal` and the barrel deliberately does not re-export
// it, so importing it this way is also the assertion that it stays internal.
import { TcpSecureTransport } from './index';
import { retryDelayMs } from './TcpSecureTransport';
import type { TcpSecureTransportConfig } from './TcpSecureTransport';

const TLS = { cert: 'fake-cert', key: 'fake-key', ca: 'fake-ca' };

interface Recorded {
  /** `send(from, messages)` calls, in order. */
  sends: Array<{ from: number; messages: Array<Record<string, unknown>> }>;
  /** `register(peer)` calls, in order. */
  registers: Array<Record<string, unknown>>;
  starts: number;
  stops: number;
}

interface Harness {
  override: Record<string, unknown>;
  recorded: Recorded;
  /** Deliver a raw inbound frame to every registered handler. */
  emit(frame: unknown): void;
  /** How many inbound handlers the transport currently holds. */
  handlerCount(): number;
}

interface HarnessOptions {
  connectedPeers?: Array<number | string | Record<string, unknown>>;
  statusPeers?: number[];
  registerThrows?: boolean;
  sendThrowsFor?: string;
  withCanReach?: boolean;
  withOffMessage?: boolean;
}

/**
 * A transport double that records what it was asked to do.
 *
 * It is the product's own seam (`_transportOverride`), not a stand-in for the
 * code under test: `TcpSecureTransport` is the subject, and every recorded call
 * is one it really made.
 */
function harness(options: HarnessOptions = {}): Harness {
  const recorded: Recorded = { sends: [], registers: [], starts: 0, stops: 0 };
  const handlers: Array<(frame: unknown) => void> = [];

  const override: Record<string, unknown> = {
    async send(from: number, messages: Array<Record<string, unknown>>) {
      const target = String(messages[0]?.['to']);
      if (options.sendThrowsFor === target) throw new Error(`link to ${target} is down`);
      recorded.sends.push({ from, messages });
    },
    async start() {
      recorded.starts += 1;
    },
    async stop() {
      recorded.stops += 1;
    },
    register(peer: Record<string, unknown>) {
      if (options.registerThrows) throw new Error('register refused');
      recorded.registers.push(peer);
    },
    onMessage(handler: (frame: unknown) => void) {
      handlers.push(handler);
    },
    getConnectedPeers: () => options.connectedPeers ?? [],
    // The status snapshot reports the numeric ids among the connected peers
    // unless a test says otherwise: `send()` judges reachability from this one
    // when the transport has no `canReach`, so a default of `[]` would make
    // every send in the file look like a refusal.
    getStatus: () => ({
      connectedPeers: options.statusPeers ?? (options.connectedPeers ?? []).filter((p) => typeof p === 'number'),
      totalPeers: (options.connectedPeers ?? []).length,
      started: true,
    }),
  };
  if (options.withCanReach) {
    override['canReach'] = (id: number) => (options.statusPeers ?? []).includes(id);
  }
  if (options.withOffMessage !== false) {
    override['offMessage'] = (handler: (frame: unknown) => void) => {
      const at = handlers.indexOf(handler);
      if (at >= 0) handlers.splice(at, 1);
    };
  }

  return {
    override,
    recorded,
    emit(frame: unknown) {
      for (const handler of [...handlers]) handler(frame);
    },
    handlerCount: () => handlers.length,
  };
}

const DEFAULT_PEERS = [
  { nodeId: 'dc-west-1', host: '127.0.0.1', port: 7101, transportNodeId: 5 },
  { nodeId: 'dc-west-2', host: '127.0.0.1', port: 7102, transportNodeId: 6 },
];

function transport(override: Record<string, unknown>, extra: Partial<TcpSecureTransportConfig> = {}) {
  return new TcpSecureTransport({
    nodeId: 'dc-east-7',
    transportNodeId: 7,
    listen: { host: '127.0.0.1', port: 0 },
    peers: DEFAULT_PEERS,
    tls: TLS,
    initialRetryMs: 10,
    maxRetryMs: 40,
    // Named rather than defaulted, so a case that asserts the stamp is asserting
    // the configuration rather than the second the suite ran in.
    epoch: 1_700_000_000_000,
    _transportOverride: override as never,
    ...extra,
  });
}

function message(targetPeerId = 'dc-west-1') {
  return {
    messageId: 'msg-1',
    sourcePeerId: 'dc-east-7',
    targetPeerId,
    timestamp: { wallTime: 1_700_000_000_000n, logical: 3, nodeId: 'dc-east-7' },
    payload: new Uint8Array([1, 2, 3]),
    createdAt: 0,
    type: 'replicate',
  } as never;
}

/** A frame shaped like the one `send()` puts on the wire. */
function inboundFrame(payload: Record<string, unknown> = {}, from = '5') {
  return {
    type: 'federation_send',
    term: 1,
    from,
    to: '7',
    payload: {
      messageId: 'in-1',
      sourcePeerId: 'dc-west-1',
      timestamp: { wallTime: '1700000000000', logical: 3, nodeId: 'dc-west-1' },
      payload: [1, 2, 3],
      type: 'replicate',
      ...payload,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TcpSecureTransport — the wire frame', () => {
  it('AC 47.1: send() puts every field of the message on the wire', async () => {
    const h = harness({ connectedPeers: [5] });
    const t = transport(h.override);
    await t.start();

    expect(await t.send(message())).toBe(true);

    expect(h.recorded.sends).toHaveLength(1);
    const { from, messages } = h.recorded.sends[0]!;
    // The frame is addressed to the peer's wire id and signed with this node's.
    expect(from).toBe(7);

    // Every field the receiver decodes, including the BigInt wall clock, which
    // travels as a string because JSON.stringify throws on BigInt.
    expect(messages[0]).toEqual({
      type: 'federation_send',
      term: 1,
      from: '7',
      to: '5',
      // On the header: the incarnation travels with the frame, not with the
      // change inside it, so every frame family carries it the same way.
      epoch: 1_700_000_000_000,
      payload: {
        messageId: 'msg-1',
        sourcePeerId: 'dc-east-7',
        timestamp: { wallTime: '1700000000000', logical: 3, nodeId: 'dc-east-7' },
        payload: [1, 2, 3],
        type: 'replicate',
      },
    });

    await t.stop();
  });

  it('AC 47.1: the header carries the incarnation, and the receiver reads it back', async () => {
    const h = harness({ connectedPeers: [5] });
    const t = transport(h.override);
    const received: Array<Record<string, unknown>> = [];
    t.onMessage((msg) => received.push(msg as unknown as Record<string, unknown>));
    await t.start();

    expect(t.getEpoch()).toBe(1_700_000_000_000);
    await t.send(message());
    // The stamp is the transport's, not the caller's: `message()` does not carry
    // one, and a change that had to remember to stamp itself is a change that can
    // forget.
    expect(h.recorded.sends[0]!.messages[0]!['epoch']).toBe(1_700_000_000_000);

    h.emit({ ...inboundFrame(), epoch: 999 });
    expect(received[0]!['sourceEpoch']).toBe(999);

    // A peer on a build that predates the field. `undefined` is the honest
    // answer — this node cannot name that incarnation — and the receiver counts
    // it rather than refusing the peer out of service.
    h.emit(inboundFrame());
    expect(received[1]!['sourceEpoch']).toBeUndefined();

    await t.stop();
  });

  it('AC 47.1: an epoch is what the deployment says, not what the clock says', () => {
    // A rebuild on a host whose clock is behind takes a number that reads as
    // older to every peer. The configuration is the promise the deployment can
    // keep, so it wins over the default rather than being merged with it.
    const h = harness();
    const t = transport(h.override, { epoch: 12 });
    expect(t.getEpoch()).toBe(12);
  });

  it('AC 47.1: a frame with no optional fields decodes to safe defaults', async () => {
    const h = harness();
    const t = transport(h.override);
    const received: Array<Record<string, unknown>> = [];
    t.onMessage((msg) => received.push(msg as unknown as Record<string, unknown>));

    // No payload at all beyond the envelope: the bridge still has to produce a
    // message rather than throwing inside the transport's read loop.
    h.emit({ type: 'federation_send', from: '5', to: '7', payload: {} });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ messageId: '', sourcePeerId: '5', targetPeerId: '7' });
    expect((received[0]!['payload'] as Uint8Array).length).toBe(0);
  });

  it('AC 47.1: bytesReceived counts the decoded payload', () => {
    const h = harness();
    const t = transport(h.override);
    t.onMessage(() => undefined);

    h.emit(inboundFrame());
    expect(t.getStats().bytesReceived).toBe(3);

    h.emit(inboundFrame());
    expect(t.getStats().bytesReceived).toBe(6);
  });

  it('AC 47.1: the timestamp is rebuilt field by field', () => {
    const h = harness();
    const t = transport(h.override);
    const received: Array<Record<string, unknown>> = [];
    t.onMessage((msg) => received.push(msg as unknown as Record<string, unknown>));

    h.emit(inboundFrame({ timestamp: { wallTime: '1700000000123', logical: 9, nodeId: 'dc-west-2' } }));
    expect(received[0]!['timestamp']).toMatchObject({ wallTime: 1_700_000_000_123n, logical: 9, nodeId: 'dc-west-2' });

    // A frame from a build that did not stamp the logical counter or the node:
    // the envelope's sender is the only identity available.
    h.emit(inboundFrame({ timestamp: { wallTime: '1700000000123' } }, 'dc-west-2'));
    expect(received[1]!['timestamp']).toMatchObject({ logical: 0, nodeId: 'dc-west-2' });
  });
});

describe('TcpSecureTransport — configurations that cannot work', () => {
  it('AC 47.2: an address that is not a configured peer is refused by name', async () => {
    const h = harness({ connectedPeers: [5] });
    const t = transport(h.override);
    await t.start();

    // Before the guard existed, this derived a wire id and handed the frame to
    // whatever node held that number — or buffered it forever.
    expect(await t.send(message('dc-nowhere'))).toBe(false);
    expect(t.getLastSendError()).toBe('peer dc-nowhere is not a configured peer');
    expect(h.recorded.sends).toHaveLength(0);

    await t.stop();
  });

  it('AC 47.3: two peers sharing a wire id are refused, naming both', () => {
    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-east-7',
          transportNodeId: 7,
          peers: [
            { nodeId: 'dc-west-1', host: '127.0.0.1', port: 7101, transportNodeId: 5 },
            { nodeId: 'dc-west-2', host: '127.0.0.1', port: 7102, transportNodeId: 5 },
          ],
          tls: TLS,
        }),
    ).toThrow('Wire id 5 names both peer dc-west-1 and peer dc-west-2; give one of them an explicit transportNodeId');
  });

  it('AC 47.3: a peer sharing this node’s wire id is refused, naming the remedy', () => {
    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-east-7',
          transportNodeId: 7,
          peers: [{ nodeId: 'dc-west-7', host: '127.0.0.1', port: 7101 }],
          tls: TLS,
        }),
    ).toThrow(/give one of them an explicit transportNodeId/);
  });

  it('AC 47.4: an id with no number in it is refused, naming the role', () => {
    // `dc-west` used to fall back to wire id 1 by a silent constant, which made
    // two datacenters both claim to be node 1 and nothing ever connected.
    expect(() => new TcpSecureTransport({ nodeId: 'dc-west', peers: [], tls: TLS })).toThrow(
      /^node dc-west has no number in its id/,
    );

    expect(
      () =>
        new TcpSecureTransport({
          nodeId: 'dc-east-7',
          transportNodeId: 7,
          peers: [{ nodeId: 'dc-west', host: '127.0.0.1', port: 7101 }],
          tls: TLS,
        }),
    ).toThrow(/^peer dc-west has no number in its id/);
  });

  it('AC 47.5: a peers: [] list falls through to the legacy address list', () => {
    const t = new TcpSecureTransport({
      nodeId: 'node-1',
      peers: [],
      peerAddresses: ['127.0.0.1:7001'],
      tls: TLS,
    });
    const peers = (t as unknown as { peers: Array<Record<string, unknown>> }).peers;

    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ host: '127.0.0.1', port: 7001 });
    // Wire id 1 belongs to this node, so the first synthetic peer takes 2.
    expect(peers[0]!['transportNodeId']).toBe(2);
  });

  it('AC 47.5: no peer shape at all gives an empty list, not a phantom peer', () => {
    const t = new TcpSecureTransport({ nodeId: 'node-1', peers: [], tls: TLS });
    expect((t as unknown as { peers: unknown[] }).peers).toEqual([]);
    expect(t.getConnectedPeers()).toEqual([]);
  });

  it('AC 47.5: a malformed legacy address keeps loopback and the default port', () => {
    const t = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: [':7001', '127.0.0.2:7002', '127.0.0.3'],
      tls: TLS,
    });
    const peers = (t as unknown as { peers: Array<Record<string, unknown>> }).peers;

    expect(peers.map((p) => [p['host'], p['port']])).toEqual([
      ['127.0.0.1', 7001],
      ['127.0.0.2', 7002],
      ['127.0.0.3', 7000],
    ]);
  });
});

describe('TcpSecureTransport — the retry schedule', () => {
  it('AC 47.6: the schedule doubles, then holds at the cap', () => {
    // base 10, cap 1000, five fast attempts.
    const schedule = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt, 10, 1000, 5));

    expect(schedule).toEqual([10, 20, 40, 80, 160, 1000, 1000]);
  });

  it('AC 47.6: the cap wins as soon as doubling passes it', () => {
    expect(retryDelayMs(4, 10, 40, 5)).toBe(40);
    expect(retryDelayMs(5, 10, 40, 5)).toBe(40);
    expect(retryDelayMs(1, 10, 40, 5)).toBe(10);
  });

  it('AC 47.7: the attempt counter resets on a successful register', async () => {
    const h = harness();
    const t = transport(h.override);

    await t.reconnect('dc-west-1');

    // One lookup, one guard, one call — and the counter is back to 0 so the next
    // outage starts its backoff from the fast end.
    expect(h.recorded.registers).toEqual([{ id: 5, host: '127.0.0.1', port: 7101 }]);
    expect((t as unknown as { _attemptCount: Map<string, number> })._attemptCount.get('dc-west-1')).toBe(0);
  });

  it('AC 47.8: a pending retry timer is replaced, not doubled', async () => {
    vi.useFakeTimers();
    const h = harness({ registerThrows: true });
    const t = transport(h.override);

    await t.reconnect('dc-west-1');
    const timers = (t as unknown as { _retryTimers: Map<string, unknown> })._retryTimers;
    const first = timers.get('dc-west-1');
    expect(first).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    await t.reconnect('dc-west-1');

    // The old timer is cleared rather than overwritten in the map: a map entry
    // that is replaced still leaves the old callback armed, and two chains of
    // retries against one dead peer is a connection storm.
    expect(timers.get('dc-west-1')).not.toBe(first);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('AC 47.8: stop() clears every pending retry timer', async () => {
    vi.useFakeTimers();
    const h = harness({ registerThrows: true });
    const t = transport(h.override);
    await t.start();

    await t.reconnect('dc-west-1');
    await t.reconnect('dc-west-2');
    expect(vi.getTimerCount()).toBe(2);

    await t.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect((t as unknown as { _retryTimers: Map<string, unknown> })._retryTimers.size).toBe(0);
  });

  it('AC 47.9: an unknown peer is not registered and does not reject', async () => {
    const h = harness();
    const t = transport(h.override);

    // A typo in a peer id must not throw inside a fire-and-forget path where
    // nothing can catch it.
    await expect(t.reconnect('dc-nowhere')).resolves.toBeUndefined();
    expect(h.recorded.registers).toHaveLength(0);
  });

  it('AC 47.9: a transport without register() is left alone', async () => {
    const h = harness();
    delete h.override['register'];
    const t = transport(h.override);

    await expect(t.reconnect('dc-west-1')).resolves.toBeUndefined();
  });

  it('AC 47.9: an unknown peer arms no retry timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    const t = transport(h.override);

    await t.reconnect('dc-nowhere');

    // A typo has to be a no-op. Arming a timer for a peer that is not in the
    // configuration retries against nothing for the life of the process, and
    // the first sign of it is a socket that opens to a real node that was never
    // configured.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC 47.9: a transport without register() arms no retry timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    delete h.override['register'];
    const t = transport(h.override);

    await t.reconnect('dc-west-1');

    // There is nothing to retry: the call that would have opened the channel
    // does not exist on this transport.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC 47.7: a delivered message clears the failure counter', async () => {
    const h = harness({ connectedPeers: [5] });
    const t = transport(h.override);
    await t.start();
    (t as unknown as { _attemptCount: Map<string, number> })._attemptCount.set('dc-west-1', 4);

    expect(await t.send(message('dc-west-1'))).toBe(true);

    // Delivery is the proof the channel works. Leaving the count at 4 makes the
    // next outage wait at the capped interval instead of backing off from the
    // fast end, which is several seconds of an outbox that could have retried
    // in milliseconds.
    expect((t as unknown as { _attemptCount: Map<string, number> })._attemptCount.get('dc-west-1')).toBe(0);

    await t.stop();
  });
});

describe('TcpSecureTransport — reachability and fan-out', () => {
  it('AC 47.10: reachability falls back to the status snapshot', async () => {
    // No `canReach`, and a status that reports no live peers: the send must be
    // refused, because a buffered frame reported as delivered is an entry the
    // outbox will never retry.
    const h = harness({ connectedPeers: [{ nodeId: '5' }], statusPeers: [] });
    const t = transport(h.override);
    await t.start();

    expect(await t.send(message())).toBe(false);
    expect(t.getLastSendError()).toContain('not reachable');
    expect(h.recorded.sends).toHaveLength(0);

    await t.stop();
  });

  it('AC 47.10: a live status lets the send through', async () => {
    const h = harness({ connectedPeers: [{ nodeId: '5' }], statusPeers: [5] });
    const t = transport(h.override);
    await t.start();

    expect(await t.send(message())).toBe(true);
    expect(h.recorded.sends).toHaveLength(1);

    await t.stop();
  });

  it('AC 47.10: canReach is preferred over the status snapshot', async () => {
    // The snapshot lags by up to a second after a peer goes away; `canReach`
    // asks the socket. A transport that has it must have it believed.
    const h = harness({ connectedPeers: [{ nodeId: '5' }], statusPeers: [5], withCanReach: true });
    const t = transport(h.override);
    await t.start();

    // Status says connected, canReach says no.
    (h.override['canReach'] as (id: number) => boolean) = () => false;
    expect(await t.send(message())).toBe(false);
    expect(t.getLastSendError()).toContain('not reachable');

    await t.stop();
  });

  it('AC 47.11: broadcast counts only the deliveries that succeeded', async () => {
    const h = harness({
      connectedPeers: [{ nodeId: '5' }, { nodeId: '6' }],
      statusPeers: [5, 6],
      sendThrowsFor: '6',
    });
    const t = transport(h.override);
    await t.start();

    // One link is down. Counting the attempt would tell the outbox that two
    // entries were delivered and let it drop the one that failed.
    expect(await t.broadcast(message())).toBe(1);
    expect(h.recorded.sends).toHaveLength(1);

    await t.stop();
  });

  it('AC 47.11: broadcast with no connected peers returns 0 without sending', async () => {
    const h = harness({ connectedPeers: [] });
    const t = transport(h.override);
    await t.start();

    expect(await t.broadcast(message())).toBe(0);
    expect(h.recorded.sends).toHaveLength(0);

    await t.stop();
  });

  it('AC 47.12: a multi-digit wire id maps back to its logical id', () => {
    const h = harness({ connectedPeers: [{ nodeId: '12' }] });
    const t = transport(h.override, {
      peers: [{ nodeId: 'dc-west-12', host: '127.0.0.1', port: 7101, transportNodeId: 12 }],
    });

    // A single-digit test would pass on `/^\d$/`: the guard has to hold for
    // every id a certificate can carry, not just the first nine.
    expect(t.getConnectedPeers().map((p) => p.peerId)).toEqual(['dc-west-12']);
  });

  it('AC 47.13: the injected defaults reach the production transport', () => {
    const t = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: TLS,
      connectTimeoutMs: 1234,
      initialRetryMs: 2345,
      maxRetryMs: 3456,
    });

    // Settings that exist only to be forwarded are the ones a default can
    // silently swallow: the transport would fall back to its own numbers and
    // the configuration would look applied.
    const config = (t as unknown as { transport: { config: Record<string, unknown> & { node: unknown } } }).transport
      .config;
    expect(config).toMatchObject({ connectTimeoutMs: 1234, initialRetryMs: 2345, maxRetryMs: 3456 });
    expect(config.node).toEqual({ id: 1, host: '127.0.0.1', port: 0 });
  });

  it('AC 47.13: an unset listen block still binds loopback on an ephemeral port', () => {
    const t = new TcpSecureTransport({ nodeId: 'node-1', peerAddresses: ['127.0.0.1:7001'], tls: TLS });

    expect(t.getLocalAddress()).toEqual({ host: '127.0.0.1', port: 0 });
    const config = (t as unknown as { transport: { config: { node: unknown } } }).transport.config;
    expect(config.node).toEqual({ id: 1, host: '127.0.0.1', port: 0 });
  });

  it('AC 47.14: stats move forward with traffic, never backwards', async () => {
    const h = harness({ connectedPeers: [5] });
    const t = transport(h.override);
    await t.start();

    await t.send(message());
    t.onMessage(() => undefined);
    h.emit(inboundFrame());

    const stats = t.getStats();
    expect(stats.messagesSent).toBe(1);
    expect(stats.messagesReceived).toBe(1);
    expect(stats.bytesSent).toBe(3);
    expect(stats.bytesReceived).toBe(3);
    // Uptime is a duration, so it lies between zero and the age of the process.
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(stats.uptimeMs).toBeLessThan(60_000);

    await t.stop();
  });

  it('AC 47.15: destroy() stops delivering to subscribers', () => {
    const h = harness();
    const t = transport(h.override);
    const seen = vi.fn();
    t.onMessage(seen);

    t.destroy();
    h.emit(inboundFrame());

    expect(seen).not.toHaveBeenCalled();
    expect(h.handlerCount()).toBe(0);
  });
});
