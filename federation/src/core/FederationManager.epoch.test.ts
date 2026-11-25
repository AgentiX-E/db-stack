/**
 * FederationManager — a frame is from an incarnation, not from a node id.
 *
 * A datacenter that has been rebuilt, rolled back or re-keyed is a different
 * incumbent of the same node id. A frame from the previous one carries a world the
 * rebuild has already replaced; applying it is how a deleted key comes back, and
 * answering it as a duplicate is how the resurrection is confirmed to the sender.
 *
 *   FE.1  a frame with no epoch is applied, and counted as unnameable
 *   FE.2  the first epoch from a peer is current, and the second of the same is too
 *   FE.3  a frame from an older incarnation is refused, by name, on the wire
 *   FE.4  the stale frame is not applied, and does not consume its id
 *   FE.5  a rebuilt peer (higher epoch) is applied, and raises the watermark
 *   FE.6  the epoch is per peer: one node's numbers do not judge another's
 *   FE.7  a confirmation is not a change, so it does not move the watermark
 *   FE.8  the status names this incarnation and what it has refused
 *   FE.9  a stale frame is refused even when the change would have lost a conflict
 *   FE.10 the refusal survives a sender that retries: every attempt is answered
 */

import { describe, it, expect, vi } from 'vitest';
import { FederationManager, encodeEnvelope, type IFederationConsumer } from './FederationManager';
import type { IMultiLeaderReplication, ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import { CDC_ACK_TYPE, buildAckFrame, parseAck } from '../replication/cdcAck';
import { HLC } from '../hlc/HLC';
import { deriveRetention } from '../storage/retention';

// ── Fixtures ───────────────────────────────────────────────

const localHlc = new HLC('dc-west-1');

function replicationConfig(): ReplicationConfig {
  return { nodeId: 'dc-west-1', dc: 'dc-west', curveDir: '/tmp/test', targets: [] };
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

function storedEntry(): OutboxEntry {
  return {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: localHlc.now(),
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

interface TransportDouble {
  transport: ITransport;
  sent: TransportMessage[];
}

function capturingTransport(epoch = 4_242): TransportDouble {
  const sent: TransportMessage[] = [];
  return {
    sent,
    transport: {
      send: vi.fn().mockImplementation(async (msg: TransportMessage) => {
        sent.push(msg);
        return true;
      }),
      broadcast: vi.fn().mockResolvedValue(1),
      onMessage: vi.fn().mockReturnValue(() => undefined),
      getConnectedPeers: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({
        peersConnected: 1,
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        uptimeMs: 0,
      }),
      getEpoch: () => epoch,
    },
  };
}

function frame(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    sourcePeerId: 'dc-east-1',
    targetPeerId: 'dc-west-1',
    timestamp: { wallTime: 1_700_000_000_000n, logical: 0, nodeId: 'dc-east-1' } as never,
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

function consumer(overrides: Partial<IFederationConsumer> = {}): IFederationConsumer {
  return {
    proposeReplicated: vi.fn().mockResolvedValue(undefined),
    getHLC: () => localHlc,
    onConflict: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

async function started(
  options: { consumer?: IFederationConsumer; epoch?: number } = {},
): Promise<{ fm: FederationManager; sent: TransportMessage[] }> {
  const { transport, sent } = capturingTransport(options.epoch ?? 4_242);
  const fm = new FederationManager(mockReplication(), {
    nodeId: 'dc-west-1',
    dc: 'dc-west',
    replicationConfig: replicationConfig(),
    transport,
    outbox: mockOutbox(),
    hlc: localHlc,
  });
  fm.registerConsumer(options.consumer ?? consumer());
  await fm.start();
  return { fm, sent };
}

function verdictOf(ack: TransportMessage): { ok: boolean; error?: string } {
  return parseAck(ack.payload, ack.messageId);
}

/** A frame from the east coast as incarnation `epoch`, carrying `value`. */
function fromEast(epoch: number | undefined, id = 'msg-1', value = 'remote-value'): InboundMessage {
  return frame({
    sourceEpoch: epoch,
    messageId: id,
    payload:
      value === 'remote-value'
        ? frame().payload
        : new TextEncoder().encode(
            encodeEnvelope({
              key: 'customer:42',
              value,
              type: 'update',
              sourceNodeId: 'dc-east-1',
              sourceDc: 'dc-east',
              hlc: { wallTime: 2_000, logical: 1, nodeId: 'dc-east-1' },
            }),
          ),
  });
}

// ── Cases ──────────────────────────────────────────────────

describe('FederationManager — a frame is from an incarnation', () => {
  it('FE.1 — a frame with no epoch is applied, and counted as unnameable', async () => {
    const { fm, sent } = await started();

    // A peer on a build that predates the field. Refusing it would turn the
    // upgrade into an outage; accepting it silently would leave the operator
    // unable to tell a rollout from a healthy fleet.
    await expect(fm.applyInbound(fromEast(undefined))).resolves.toBe('applied');
    expect(verdictOf(sent[0]!)).toEqual({ ok: true });
    expect(fm.getEpochStatus()).toEqual({ self: 4_242, peers: {}, refused: 0, advanced: 0, epochless: 1 });
  });

  it('FE.2 — the first epoch from a peer is current, and the second of the same is too', async () => {
    const { fm, sent } = await started();

    await expect(fm.applyInbound(fromEast(1_000, 'msg-1'))).resolves.toBe('applied');
    await expect(fm.applyInbound(fromEast(1_000, 'msg-2'))).resolves.toBe('applied');

    expect(sent.map((ack) => verdictOf(ack).ok)).toEqual([true, true]);
    expect(fm.getEpochStatus().peers).toEqual({ 'dc-east-1': 1_000 });
  });

  it('FE.3 — a frame from an older incarnation is refused, by name, on the wire', async () => {
    const { fm, sent } = await started();

    await fm.applyInbound(fromEast(2_000, 'msg-1'));
    await expect(fm.applyInbound(fromEast(1_999, 'msg-2'))).resolves.toBe('stale-epoch');

    // The sender is the only party that can stop retrying: a frame that vanishes
    // teaches it nothing, and the reason is the only thing it can act on.
    expect(sent).toHaveLength(2);
    const refusal = verdictOf(sent[1]!);
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('dc-east-1');
    expect(refusal.error).toContain('1999');
    expect(refusal.error).toContain('2000');
    expect(fm.getLastInboundError()).toBe(refusal.error);
    expect(fm.getEpochStatus()).toMatchObject({ refused: 1, peers: { 'dc-east-1': 2_000 } });
  });

  it('FE.4 — the stale frame is not applied, and does not consume its id', async () => {
    const { fm, sent } = await started();

    await fm.applyInbound(fromEast(2_000, 'msg-1', 'after-the-rebuild'));
    await fm.applyInbound(fromEast(1_999, 'msg-9', 'resurrected'));
    // The stale frame's value never reached the store: it carried a world the
    // rebuild has already replaced, which is exactly how a deleted key comes back.
    expect(fm.getLocalValue('customer:42')).toBe('after-the-rebuild');

    // Nor did its id enter the ring. If it had, the *current* incarnation's retry
    // of the same id would be answered as a duplicate of a change that never
    // landed — a silent loss wearing two acknowledgements.
    await expect(fm.applyInbound(fromEast(2_000, 'msg-9'))).resolves.toBe('applied');
    expect(sent).toHaveLength(3);
    expect(verdictOf(sent[2]!)).toEqual({ ok: true });
  });

  it('FE.5 — a rebuilt peer (higher epoch) is applied, and raises the watermark', async () => {
    const { fm } = await started();

    await expect(fm.applyInbound(fromEast(2_000, 'msg-1'))).resolves.toBe('applied');
    // The rebuild is the truth going forward: refusing *it* would take a
    // datacenter out of service for having been restored.
    await expect(fm.applyInbound(fromEast(5_000, 'msg-2'))).resolves.toBe('applied');

    expect(fm.getEpochStatus()).toMatchObject({
      peers: { 'dc-east-1': 5_000 },
      advanced: 1,
      refused: 0,
    });
    // And the old incarnation is now refused, which is the whole point.
    await expect(fm.applyInbound(fromEast(2_000, 'msg-3'))).resolves.toBe('stale-epoch');
  });

  it('FE.6 — the epoch is per peer: one node’s numbers do not judge another’s', async () => {
    const { fm } = await started();

    await fm.applyInbound(fromEast(9_000, 'msg-1'));
    // dc-north has never been heard from, so its 5 is not "older than 9 000".
    // An epoch is a per-node incarnation, not a global clock, and a comparison
    // across nodes would be a clock comparison dressed as a safety check.
    await expect(
      fm.applyInbound(frame({ sourcePeerId: 'dc-north-1', sourceEpoch: 5, messageId: 'msg-2' })),
    ).resolves.toBe('applied');

    expect(fm.getEpochStatus().peers).toEqual({ 'dc-east-1': 9_000, 'dc-north-1': 5 });
  });

  it('FE.7 — a confirmation is not a change, so it does not move the watermark', async () => {
    const { fm, sent } = await started();

    // A `cdc_ack` carries the acker's incarnation, but it is an answer about a
    // frame, not a change: it says nothing about whether this node's view of that
    // peer's world is current, and it must not raise the bar for the peer's own
    // changes.
    await fm.applyInbound(frame({ type: CDC_ACK_TYPE, sourceEpoch: 9_000, messageId: 'ack-1' }));

    expect(fm.getEpochStatus().peers).toEqual({});
    expect(sent).toHaveLength(0);
    await expect(fm.applyInbound(fromEast(1, 'msg-1'))).resolves.toBe('applied');
  });

  it('FE.8 — the status names this incarnation and what it has refused', async () => {
    const { fm } = await started({ epoch: 777 });

    expect(fm.getEpochStatus()).toEqual({ self: 777, peers: {}, refused: 0, advanced: 0, epochless: 0 });

    // A transport that cannot name its incarnation reports `null` rather than a
    // number it invented: a status page must not be the one place a deployment
    // looks healthy.
    const anonymous = new FederationManager(mockReplication(), {
      nodeId: 'dc-west-1',
      dc: 'dc-west',
      replicationConfig: replicationConfig(),
      transport: {
        send: vi.fn().mockResolvedValue(true),
        broadcast: vi.fn().mockResolvedValue(1),
        onMessage: vi.fn().mockReturnValue(() => undefined),
        getConnectedPeers: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({
          peersConnected: 0,
          messagesSent: 0,
          messagesReceived: 0,
          bytesSent: 0,
          bytesReceived: 0,
          uptimeMs: 0,
        }),
      },
      outbox: mockOutbox(),
      hlc: localHlc,
    });
    expect(anonymous.getEpochStatus().self).toBeNull();
  });

  it('FE.9 — a stale frame is refused even when the change would have lost a conflict', async () => {
    const { fm, sent } = await started();

    await fm.applyInbound(fromEast(2_000, 'msg-1'));
    // A newer write is in the store; the stale frame is *also* older than the
    // conflict resolution would care about. The epoch check runs first, so the
    // refusal is about the incarnation rather than about the value: a `superseded`
    // answer here would confirm a change this node never even considered.
    await expect(fm.applyInbound(fromEast(1_999, 'msg-2'))).resolves.toBe('stale-epoch');
    expect(verdictOf(sent[1]!)).toMatchObject({ ok: false });
  });

  it('FE.10 — the refusal survives a sender that retries: every attempt is answered', async () => {
    const { fm, sent } = await started();

    await fm.applyInbound(fromEast(2_000, 'msg-1'));
    for (const id of ['msg-retry-1', 'msg-retry-2', 'msg-retry-3']) {
      await expect(fm.applyInbound(fromEast(1_999, id))).resolves.toBe('stale-epoch');
    }

    // Three answers for three attempts: `unsolicited` refusals would leave the
    // sender waiting out a timeout it could have been told about immediately.
    expect(sent).toHaveLength(4);
    for (const ack of sent.slice(1)) expect(verdictOf(ack).ok).toBe(false);
    expect(fm.getEpochStatus().refused).toBe(3);
  });
});
