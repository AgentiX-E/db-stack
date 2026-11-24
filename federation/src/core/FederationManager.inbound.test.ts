/**
 * FederationManager — inbound replication path.
 *
 * Cross-DC replication is only correct if the *receive* side behaves: a frame
 * delivered twice must not be applied twice, an older frame must not overwrite a
 * newer local value, an undecodable frame must be reported rather than silently
 * dropped, and an apply failure must never escape as an unhandled rejection
 * (which terminates the Node process).
 *
 * These tests drive that path directly through the transport subscription —
 * the same path the production gateway uses — plus the envelope codec that
 * carries the key and source HLC across the wire.
 */

import { describe, it, expect, vi } from 'vitest';
import { FederationManager, decodeEnvelope, encodeEnvelope, type IFederationConsumer } from './FederationManager';
import type { IMultiLeaderReplication, ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import { HLC } from '../hlc/HLC';
import { deriveRetention } from '../storage/retention';

// ── Fixtures ───────────────────────────────────────────────

function replicationConfig(): ReplicationConfig {
  return {
    nodeId: 'dc-west-1',
    dc: 'dc-west',
    curveDir: '/tmp/test',
    targets: [],
  };
}

function mockReplication(): IMultiLeaderReplication {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    replicate: vi.fn().mockResolvedValue({ msgId: 'repl:0:mock' }),
    getStatus: vi.fn().mockResolvedValue({ nodeId: 'dc-west-1', dc: 'dc-west', targets: [] }),
    retryFailed: vi.fn().mockResolvedValue(0),
    getPendingCounts: vi.fn().mockResolvedValue({}),
    onTargetConnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetDisconnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetRecovered: vi.fn().mockReturnValue(vi.fn()),
    isPeerReachable: vi.fn(() => true),
    onHighLag: vi.fn().mockReturnValue(vi.fn()),
    getRetention: () => deriveRetention(),
  };
}

/** Transport double that exposes the inbound handler so tests can deliver frames. */
function deliveryTransport() {
  const handlers: Array<(msg: InboundMessage) => void> = [];
  const transport: ITransport = {
    send: vi.fn().mockResolvedValue(true),
    broadcast: vi.fn().mockResolvedValue(1),
    onMessage: vi.fn().mockImplementation((handler: (msg: InboundMessage) => void) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    }),
    getConnectedPeers: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      peersConnected: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };
  return {
    transport,
    handlers,
    deliver: (msg: InboundMessage) => handlers.forEach((h) => h(msg)),
  };
}

/** A complete stored entry, as `add()` returns it. */
function storedEntry(): OutboxEntry {
  return {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: new HLC('test-node').now(),
    type: 'test',
    status: 'pending',
    createdAt: Date.now(),
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  };
}

function mockOutbox(): IOutboxStore {
  return {
    add: vi.fn().mockResolvedValue(storedEntry()),
    fetchOldestPending: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockReturnValue(false),
    getPendingCount: vi.fn().mockResolvedValue(0),
    getPendingStats: vi.fn(() => ({})),
    getDeadLetterEntries: vi.fn(() => []),
    retryDeadLetters: vi.fn(() => 0),
    housekeeping: vi.fn(() => ({ delivered: 0, deadLettered: 0 })),
    getRetention: () => deriveRetention(),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      pendingCount: 0,
      deliveredCount: 0,
      oldestPendingTimestamp: null,
    }),
  };
}

function frame(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    sourcePeerId: 'dc-east-1',
    targetPeerId: 'dc-west-1',
    timestamp: {
      wallTime: 1_700_000_000_000n,
      logical: 0,
      nodeId: 'dc-east-1',
    } as never,
    payload: new TextEncoder().encode(
      encodeEnvelope({
        key: 'customer:42',
        value: 'remote-value',
        type: 'update',
        sourceNodeId: 'dc-east-1',
        sourceDc: 'dc-east',
        hlc: { wallTime: 2_000, logical: 1, nodeId: 'dc-east-1' },
      }),
    ),
    createdAt: Date.now(),
    receivedAt: Date.now(),
    type: 'replicate',
    ...overrides,
  } as InboundMessage;
}

function consumer(overrides: Partial<IFederationConsumer> = {}): IFederationConsumer & {
  proposeReplicated: ReturnType<typeof vi.fn>;
  onConflict: ReturnType<typeof vi.fn>;
} {
  return {
    proposeReplicated: vi.fn().mockResolvedValue(undefined),
    getHLC: () => new HLC('dc-west-1'),
    onConflict: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

async function started(consumerImpl?: IFederationConsumer) {
  const t = deliveryTransport();
  const fm = new FederationManager(mockReplication(), {
    nodeId: 'dc-west-1',
    dc: 'dc-west',
    replicationConfig: replicationConfig(),
    transport: t.transport,
    outbox: mockOutbox(),
    hlc: new HLC('dc-west-1'),
  });
  if (consumerImpl) fm.registerConsumer(consumerImpl);
  await fm.start();
  return { fm, ...t };
}

// ── Envelope codec ─────────────────────────────────────────

describe('replication envelope codec', () => {
  it('round-trips key, value, type, source and HLC', () => {
    const encoded = encodeEnvelope({
      key: 'order:7',
      value: 'v',
      type: 'insert',
      sourceNodeId: 'dc-east-1',
      sourceDc: 'dc-east',
      hlc: { wallTime: 1234, logical: 5, nodeId: 'dc-east-1' },
    });
    const decoded = decodeEnvelope(new TextEncoder().encode(encoded), 'replicate');

    expect(decoded).not.toBeNull();
    expect(decoded?.key).toBe('order:7');
    expect(decoded?.value).toBe('v');
    expect(decoded?.sourceDc).toBe('dc-east');
    // The wall clock survives as a BigInt, not as a lossy Number.
    expect(decoded?.hlc?.wallTime).toBe(1234n);
    expect(decoded?.hlc?.logical).toBe(5);
  });

  it('rejects an empty payload', () => {
    expect(decodeEnvelope(new Uint8Array(), 'replicate')).toBeNull();
  });

  it('accepts a legacy key-less frame and derives a stable key', () => {
    const first = decodeEnvelope(new TextEncoder().encode('bare-value'), 'replicate');
    const second = decodeEnvelope(new TextEncoder().encode('bare-value'), 'replicate');

    expect(first?.value).toBe('bare-value');
    expect(first?.sourceNodeId).toBe('unknown');
    expect(first?.type).toBe('replicate');
    // Same payload must hash to the same key, otherwise dedup collapses.
    expect(first?.key).toBe(second?.key);
    expect(first?.key.startsWith('legacy:')).toBe(true);
  });

  it('gives different legacy payloads different keys', () => {
    const a = decodeEnvelope(new TextEncoder().encode('value-a'), 'replicate');
    const b = decodeEnvelope(new TextEncoder().encode('value-b'), 'replicate');

    expect(a?.key).not.toBe(b?.key);
  });

  it('rejects a frame with an unknown envelope version', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ __fb: 'fb9', key: 'k', value: 'v' }));

    expect(decodeEnvelope(payload, 'replicate')).toBeNull();
  });

  it('rejects a frame with no value', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ __fb: 'fb1', key: 'k' }));

    expect(decodeEnvelope(payload, 'replicate')).toBeNull();
  });

  it('rejects a frame that is not valid JSON', () => {
    const payload = new TextEncoder().encode('{"__fb":"fb1", broken');

    expect(decodeEnvelope(payload, 'replicate')).toBeNull();
  });
});

// ── Inbound apply ──────────────────────────────────────────

describe('FederationManager — applyInbound', () => {
  it('applies a well-formed frame and notifies consumers with the key', async () => {
    const spy = consumer();
    const { fm } = await started(spy);

    expect(await fm.applyInbound(frame())).toBe('applied');
    expect(fm.getLocalValue('customer:42')).toBe('remote-value');
    expect(spy.proposeReplicated).toHaveBeenCalledTimes(1);
    // Without the key the receiving DC cannot propose into its own Raft group.
    expect(spy.proposeReplicated.mock.calls[0]![0]).toMatchObject({
      key: 'customer:42',
      data: 'remote-value',
      sourceDc: 'dc-east',
    });

    await fm.stop();
  });

  it('is idempotent for a repeated message id', async () => {
    const spy = consumer();
    const { fm } = await started(spy);

    expect(await fm.applyInbound(frame())).toBe('applied');
    expect(await fm.applyInbound(frame())).toBe('duplicate');
    // A duplicate must not reach the consumer a second time.
    expect(spy.proposeReplicated).toHaveBeenCalledTimes(1);

    await fm.stop();
  });

  it('rejects a frame without a message id', async () => {
    const { fm } = await started();

    expect(await fm.applyInbound(frame({ messageId: '' }))).toBe('malformed');

    await fm.stop();
  });

  it('rejects an undecodable payload', async () => {
    const { fm } = await started();

    expect(await fm.applyInbound(frame({ payload: new Uint8Array() }))).toBe('malformed');
    expect(fm.getLocalStoreSize()).toBe(0);

    await fm.stop();
  });

  it('keeps the newer local value when the remote frame is stale', async () => {
    const spy = consumer();
    const { fm } = await started(spy);

    // Local value at HLC 2000 wins over the remote HLC 1000.
    await fm.replicate('customer:42', 'local-newer', 'update');
    const result = await fm.applyInbound(
      frame({
        messageId: 'msg-stale',
        payload: new TextEncoder().encode(
          encodeEnvelope({
            key: 'customer:42',
            value: 'remote-older',
            type: 'update',
            sourceNodeId: 'dc-east-1',
            sourceDc: 'dc-east',
            hlc: { wallTime: 1_000, logical: 0, nodeId: 'dc-east-1' },
          }),
        ),
      }),
    );

    expect(result).toBe('superseded');
    expect(fm.getLocalValue('customer:42')).toBe('local-newer');

    await fm.stop();
  });

  it('applies a legacy key-less frame under its derived key', async () => {
    const { fm } = await started();

    expect(
      await fm.applyInbound(
        frame({
          payload: new TextEncoder().encode('legacy-payload'),
          type: 'replicate',
        }),
      ),
    ).toBe('applied');
    expect([...fm.getLocalStore().values()].map((e) => e.value)).toEqual(['legacy-payload']);

    await fm.stop();
  });

  it('falls back to a local HLC when the frame carries none', async () => {
    const { fm } = await started();
    const legacyKey = decodeEnvelope(new TextEncoder().encode('no-hlc'), 'replicate')!.key;

    await fm.applyInbound(frame({ payload: new TextEncoder().encode('no-hlc') }));

    const entry = fm.getLocalStore().get(legacyKey);
    expect(entry?.value).toBe('no-hlc');
    expect(entry?.hlc.wallTime).toBeGreaterThan(1_600_000_000_000);

    await fm.stop();
  });

  it('propagates a consumer failure to the caller', async () => {
    const failing = consumer({
      proposeReplicated: vi.fn().mockRejectedValue(new Error('raft unavailable')),
    });
    const { fm } = await started(failing);

    await expect(fm.applyInbound(frame())).rejects.toThrow('raft unavailable');

    await fm.stop();
  });

  it('records — rather than crashes on — a failure raised by a transport delivery', async () => {
    const failing = consumer({
      proposeReplicated: vi.fn().mockRejectedValue(new TypeError('proposal rejected')),
    });
    const { fm, deliver } = await started(failing);

    expect(() => deliver(frame())).not.toThrow();
    await vi.waitFor(() => {
      expect(fm.getLastInboundError()).toBe('TypeError: proposal rejected');
    });

    await fm.stop();
  });

  it('records a non-Error rejection as a string', async () => {
    const failing = consumer({
      proposeReplicated: vi.fn().mockRejectedValue('plain-string-failure'),
    });
    const { fm, deliver } = await started(failing);

    deliver(frame());
    await vi.waitFor(() => {
      expect(fm.getLastInboundError()).toBe('plain-string-failure');
    });

    await fm.stop();
  });

  it('stops accepting frames after stop()', async () => {
    const { fm, deliver } = await started();
    await fm.stop();

    // The transport subscription is released on stop().
    deliver(frame());

    expect(fm.getLocalStoreSize()).toBe(0);
  });
});

// ── Accessors ──────────────────────────────────────────────

describe('FederationManager — accessors', () => {
  it('exposes lifecycle state and collaborators', async () => {
    const { fm } = await started();

    expect(fm.isStarted()).toBe(true);
    expect(fm.getReplication()).toBeDefined();
    expect(fm.getHLC()).toBeDefined();
    expect(fm.getLocalStore()).toBeInstanceOf(Map);
    expect(fm.getConsumers()).toEqual([]);

    await fm.stop();
    expect(fm.isStarted()).toBe(false);
  });

  it('starts only once', async () => {
    const repl = mockReplication();
    const t = deliveryTransport();
    const fm = new FederationManager(repl, {
      nodeId: 'dc-west-1',
      dc: 'dc-west',
      replicationConfig: replicationConfig(),
      transport: t.transport,
      outbox: mockOutbox(),
    });

    await fm.start();
    await fm.start();

    expect(repl.start).toHaveBeenCalledTimes(1);
    expect(t.handlers).toHaveLength(1);

    await fm.stop();
  });

  it('returns a defensive copy of the consumer list', async () => {
    const { fm } = await started();
    const spy = consumer();
    fm.registerConsumer(spy);

    const copy = fm.getConsumers();
    copy.length = 0;

    expect(fm.getConsumers()).toHaveLength(1);

    await fm.stop();
  });

  it('reports an empty local store before any write', async () => {
    const { fm } = await started();

    expect(fm.getLocalStoreSize()).toBe(0);
    expect(fm.getLocalValue('missing')).toBeUndefined();
    expect(fm.getLastInboundError()).toBeNull();

    await fm.stop();
  });
});
