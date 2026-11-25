/**
 * FederationManager — the receiver's half of the delivery contract.
 *
 * A sender retires an outbox entry on a confirmation, so the confirmation has to be
 * exactly as strong as the claim it replaces: *this node applied this change, or it
 * did not and here is why*. These cases pin every outcome of `applyInbound` to the
 * answer it sends, and pin the one defect the answer could create on its own — a
 * refusal followed by a retry read as a duplicate, which is a silent loss wearing
 * two acknowledgements.
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

function capturingTransport(sendResult: boolean | Error = true): TransportDouble {
  const sent: TransportMessage[] = [];
  const send = vi.fn().mockImplementation(async (msg: TransportMessage) => {
    if (sendResult instanceof Error) throw sendResult;
    sent.push(msg);
    return sendResult;
  });

  return {
    sent,
    transport: {
      send,
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
  options: {
    consumer?: IFederationConsumer;
    sendResult?: boolean | Error;
  } = {},
): Promise<{ fm: FederationManager; sent: TransportMessage[] }> {
  const { transport, sent } = capturingTransport(options.sendResult ?? true);
  const fm = new FederationManager(mockReplication(), {
    nodeId: 'dc-west-1',
    dc: 'dc-west',
    replicationConfig: replicationConfig(),
    transport,
    outbox: mockOutbox(),
    hlc: localHlc,
  });
  if (options.consumer) fm.registerConsumer(options.consumer);
  await fm.start();
  return { fm, sent };
}

/** The verdict one sent confirmation carries, read the way a sender reads it. */
function verdictOf(ack: TransportMessage): { ok: boolean; error?: string } {
  return parseAck(ack.payload, ack.messageId);
}

// ── Cases ──────────────────────────────────────────────────

describe('FederationManager — every outcome is answered', () => {
  it('FA.1 — an applied change is confirmed, addressed back to its sender', async () => {
    const { fm, sent } = await started();

    await expect(fm.applyInbound(frame())).resolves.toBe('applied');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe(CDC_ACK_TYPE);
    // The id of the frame it answers — that is how the sender matches it.
    expect(sent[0]!.messageId).toBe('msg-1');
    expect(sent[0]!.targetPeerId).toBe('dc-east-1');
    expect(verdictOf(sent[0]!)).toEqual({ ok: true });
    // The confirmation carries the acker's own clock, not the clock of the frame it
    // answers: two events did not happen at the same instant on the same node.
    expect(sent[0]!.timestamp.nodeId).toBe('dc-west-1');

    await fm.stop();
  });

  it('FA.2 — a duplicate is confirmed: it was applied, earlier', async () => {
    const { fm, sent } = await started();
    await fm.applyInbound(frame());

    await expect(fm.applyInbound(frame())).resolves.toBe('duplicate');

    expect(sent).toHaveLength(2);
    expect(verdictOf(sent[1]!)).toEqual({ ok: true });

    await fm.stop();
  });

  it('FA.3 — a superseded frame is confirmed: retrying would decide it the same way', async () => {
    const { fm, sent } = await started();
    // A newer local value first, then an older remote one on the same key.
    await fm.applyInbound(
      frame({
        messageId: 'msg-newer',
        payload: new TextEncoder().encode(
          encodeEnvelope({
            key: 'customer:42',
            value: 'newer',
            type: 'update',
            sourceNodeId: 'dc-east-1',
            sourceDc: 'dc-east',
            hlc: { wallTime: 5_000, logical: 0, nodeId: 'dc-east-1' },
          }),
        ),
      }),
    );

    await expect(fm.applyInbound(frame({ messageId: 'msg-older' }))).resolves.toBe('superseded');

    expect(fm.getLocalValue('customer:42')).toBe('newer');
    expect(verdictOf(sent[1]!)).toEqual({ ok: true });

    await fm.stop();
  });

  it('FA.4 — a frame that cannot be decoded is refused, with a reason', async () => {
    const { fm, sent } = await started();
    // A bare string is a *legacy* payload and is accepted by the codec with a
    // derived key; an envelope from a version this build does not know is not.
    const unknownVersion = new TextEncoder().encode(
      JSON.stringify({ __fb: 'fb9', key: 'customer:42', value: 'remote-value' }),
    );

    await expect(fm.applyInbound(frame({ payload: unknownVersion }))).resolves.toBe('malformed');

    expect(sent).toHaveLength(1);
    const verdict = verdictOf(sent[0]!);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('msg-1');
    expect(fm.getLastInboundError()).toContain('not a decodable replicate envelope');

    await fm.stop();
  });

  it('FA.5 — a frame with no id is malformed, and nothing is answered', async () => {
    const { fm, sent } = await started();

    await expect(fm.applyInbound(frame({ messageId: '' }))).resolves.toBe('malformed');

    // The id *is* what a confirmation is matched by, so there is nothing to answer.
    expect(sent).toHaveLength(0);
    expect(fm.getLastInboundError()).toContain('no message id');

    await fm.stop();
  });

  it('FA.6 — a consumer that cannot propose is refused, and the retry is applied', async () => {
    // The defect the dedup ring would otherwise create: the id is registered before
    // the consumer runs, so a refusal that left it behind would answer the retry as
    // a duplicate of a change that never landed.
    const propose = vi.fn().mockRejectedValueOnce(new Error('raft unavailable')).mockResolvedValue(undefined);
    const { fm, sent } = await started({ consumer: consumer({ proposeReplicated: propose }) });

    await expect(fm.applyInbound(frame())).resolves.toBe('declined');
    const refusal = verdictOf(sent[0]!);
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('raft unavailable');

    // The same frame, again: the sender's retry.
    await expect(fm.applyInbound(frame())).resolves.toBe('applied');
    expect(verdictOf(sent[1]!)).toEqual({ ok: true });
    expect(propose).toHaveBeenCalledTimes(2);

    await fm.stop();
  });

  it('FA.7 — a confirmation is not a change, and is not answered', async () => {
    const { fm, sent } = await started();
    const ack = buildAckFrame(frame(), 'dc-east-1', localHlc.now());

    await expect(fm.applyInbound(ack as unknown as InboundMessage)).resolves.toBe('not-a-change');

    // Answering an answer is a conversation that never ends.
    expect(sent).toHaveLength(0);
    expect(fm.getLocalValue('customer:42')).toBeUndefined();

    await fm.stop();
  });

  it('FA.8 — an applied change is still applied when the confirmation cannot be sent', async () => {
    const { fm } = await started({ sendResult: false });

    await expect(fm.applyInbound(frame())).resolves.toBe('applied');

    expect(fm.getLocalValue('customer:42')).toBe('remote-value');
    expect(fm.getLastAckError()).toContain('refused the confirmation for msg-1');

    await fm.stop();
  });

  it('FA.9 — a transport that throws on the confirmation is a diagnostic, not a failure', async () => {
    const { fm } = await started({ sendResult: new Error('socket closed') });

    await expect(fm.applyInbound(frame())).resolves.toBe('applied');

    expect(fm.getLocalValue('customer:42')).toBe('remote-value');
    expect(fm.getLastAckError()).toBe('Error: socket closed');

    await fm.stop();
  });

  it('FA.10 — a confirmation that succeeds clears the previous ack error', async () => {
    const { fm } = await started();
    // One frame with no id (no answer), then a normal one: the error from the first
    // must not outlive the confirmation that followed it.
    await fm.applyInbound(frame({ messageId: '' }));
    expect(fm.getLastAckError()).toBeNull();

    await fm.applyInbound(frame());
    expect(fm.getLastAckError()).toBeNull();

    await fm.stop();
  });

  it('FA.11 — nothing is confirmed before the consumers have proposed', async () => {
    const order: string[] = [];
    const propose = vi.fn().mockImplementation(async () => {
      order.push('propose');
    });
    const { transport, fm } = (() => {
      const capturing = capturingTransport();
      const original = capturing.transport.send as unknown as (m: TransportMessage) => Promise<boolean>;
      (capturing.transport as { send: unknown }).send = vi.fn().mockImplementation(async (m: TransportMessage) => {
        if (m.type === CDC_ACK_TYPE) order.push('ack');
        return original(m);
      });
      const manager = new FederationManager(mockReplication(), {
        nodeId: 'dc-west-1',
        dc: 'dc-west',
        replicationConfig: replicationConfig(),
        transport: capturing.transport,
        outbox: mockOutbox(),
        hlc: localHlc,
      });
      manager.registerConsumer(consumer({ proposeReplicated: propose }));
      return { transport: capturing, fm: manager };
    })();

    await transport.transport.getConnectedPeers();
    await fm.start();
    await fm.applyInbound(frame());

    // An ack sent before the proposal would be the same lie one layer up.
    expect(order).toEqual(['propose', 'ack']);

    await fm.stop();
  });
});
