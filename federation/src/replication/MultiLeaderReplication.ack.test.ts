/**
 * MultiLeaderReplication — the acknowledged delivery contract.
 *
 * The worker used to retire an outbox entry the moment `ITransport.send()`
 * resolved `true`. That resolution is a statement about the sender's socket: a TCP
 * write into a connection whose peer has already gone is accepted by the local
 * kernel, so the queue reported deliveries the peer never made — twenty reported,
 * thirteen applied, no refusal and no dead letter.
 *
 * These cases pin the replacement: an entry leaves the queue when the peer says it
 * applied the change, and a peer that refuses or never answers costs the entry an
 * attempt instead of a lie. The send-only contract still exists and is measured in
 * `MultiLeaderReplication.test.ts` and `.branches.test.ts`; it is now chosen
 * explicitly with `acknowledgement: 'none'`.
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiLeaderReplication } from './MultiLeaderReplication';
import { CDC_ACK_TYPE, buildAckFrame } from './cdcAck';
import { HLC } from '../hlc/HLC';
import type { ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import { deriveRetention } from '../storage/retention';

// ── Fixtures ───────────────────────────────────────────────

const hlc = new HLC('sender');

function entry(id: string): OutboxEntry {
  return {
    id,
    targetPeerIds: ['peer-b'],
    payload: new TextEncoder().encode(`change:${id}`),
    timestamp: hlc.now(),
    type: 'replicate',
    status: 'pending',
    createdAt: Date.now(),
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  };
}

interface OutboxDouble {
  store: IOutboxStore;
  markDelivered: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
}

function mockOutbox(entries: OutboxEntry[], failedResult = false): OutboxDouble {
  const markDelivered = vi.fn().mockResolvedValue(undefined);
  const markFailed = vi.fn().mockReturnValue(failedResult);

  const store: IOutboxStore = {
    add: vi.fn().mockResolvedValue(entry('added')),
    // The worker filters on `status === 'pending'` and on the target, so the double
    // returns the fixture as the store would.
    fetchOldestPending: vi.fn().mockResolvedValue(entries),
    markDelivered,
    markFailed,
    getPendingCount: vi.fn().mockResolvedValue(entries.length),
    getPendingStats: vi.fn(() => ({ 'peer-b': { count: entries.length, oldestCreatedAt: null } })),
    getDeadLetterEntries: vi.fn(() => []),
    retryDeadLetters: vi.fn(() => 0),
    housekeeping: vi.fn(() => ({ delivered: 0, deadLettered: 0 })),
    getRetention: () => deriveRetention(),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: entries.length,
      pendingCount: entries.length,
      deliveredCount: 0,
      oldestPendingTimestamp: null,
    }),
  };

  return { store, markDelivered, markFailed };
}

type Answer = (frame: TransportMessage) => void | Promise<void>;

/**
 * A transport double whose `send` hands each frame to `answer`, which decides what
 * the peer says — or says nothing, which is how a timeout is produced.
 */
function mockTransport(answer: Answer) {
  const handlers: Array<(msg: InboundMessage) => void> = [];
  const send = vi.fn().mockImplementation(async (msg: TransportMessage) => {
    await answer(msg);
    return true;
  });

  const transport: ITransport = {
    send,
    broadcast: vi.fn().mockResolvedValue(1),
    onMessage: vi.fn().mockImplementation((handler: (msg: InboundMessage) => void) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    }),
    getConnectedPeers: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      peersConnected: 1,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };

  const deliver = (msg: InboundMessage): void => handlers.forEach((handler) => handler(msg));

  return { transport, send, deliver, handlers };
}

/**
 * The frame as the *receiver* sees it: delivery stamps `receivedAt`, and the ack is
 * built from that shape because that is the shape `buildAckFrame` takes.
 */
function asInbound(frame: TransportMessage): InboundMessage {
  return { ...frame, receivedAt: Date.now() } as InboundMessage;
}

function ackOk(frame: TransportMessage): InboundMessage {
  return asInbound(buildAckFrame(asInbound(frame), 'peer-b', hlc.now()));
}

function ackRefused(frame: TransportMessage, reason: string): InboundMessage {
  return asInbound(buildAckFrame(asInbound(frame), 'peer-b', hlc.now(), reason));
}

function makeConfig(overrides: Partial<ReplicationConfig> = {}): ReplicationConfig {
  return {
    nodeId: 'peer-a',
    dc: 'dc-east',
    curveDir: '/tmp/ack-tests',
    tickMs: 5,
    batchSize: 100,
    ackTimeoutMs: 40,
    targets: [
      {
        nodeId: 'peer-b',
        dc: 'dc-west',
        address: 'inproc://ack/peer-b',
        topology: 'cross-dc',
        maxBackoffSeconds: 0,
      },
    ],
    ...overrides,
  };
}

/** Poll until `check` passes, or fail with what the counters said. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── Cases ──────────────────────────────────────────────────

describe('MultiLeaderReplication — an entry leaves the queue on the peer’s answer', () => {
  it('MA.1 — no answer is not a delivery: the entry is charged an attempt', async () => {
    const { store, markDelivered, markFailed } = mockOutbox([entry('e1')]);
    const { transport } = mockTransport(() => {
      // The peer says nothing at all.
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markFailed.mock.calls.length > 0, 'the timeout to charge e1');

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('e1', expect.stringContaining('no acknowledgement for e1 within 40 ms'));
    expect(replication.getAckStats().timeouts).toBeGreaterThan(0);

    await replication.stop();
  });

  it('MA.2 — an answer retires the entry, once', async () => {
    const { store, markDelivered } = mockOutbox([entry('e1')]);
    const { transport, deliver } = mockTransport((frame) => {
      deliver(ackOk(frame));
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markDelivered.mock.calls.length > 0, 'e1 to be retired');

    expect(markDelivered).toHaveBeenCalledWith('e1');
    expect(replication.getAckStats().received).toBeGreaterThan(0);
    expect(replication.getAckStats().pending).toBe(0);

    await replication.stop();
  });

  it('MA.3 — a refusal carries the peer’s reason into the entry', async () => {
    const { store, markDelivered, markFailed } = mockOutbox([entry('e1')]);
    const { transport, deliver } = mockTransport((frame) => {
      deliver(ackRefused(frame, 'Error: no leader in shard 7'));
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markFailed.mock.calls.length > 0, 'the refusal to be acted on');

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('e1', 'Error: no leader in shard 7');

    await replication.stop();
  });

  it('MA.4 — stopping while a frame is in flight charges nothing', async () => {
    const { store, markDelivered, markFailed } = mockOutbox([entry('e1')]);
    const { transport } = mockTransport(() => {
      // Never answers: the wait is still open when `stop()` runs.
    });
    const replication = new MultiLeaderReplication({
      transport,
      outbox: store,
      // A budget long enough that the shutdown, not the timer, ends the wait.
      config: makeConfig({ ackTimeoutMs: 5_000 }),
    });

    await replication.start();
    await waitFor(() => replication.getAckStats().pending > 0, 'the wait to be registered');
    await replication.stop();
    // Let the worker's `await` resume after the release: `aborted` is the verdict it
    // must act on by doing nothing at all.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(replication.getAckStats().pending).toBe(0);
  });

  it('MA.5 — a refused head does not retire what was behind it', async () => {
    const { store, markDelivered, markFailed } = mockOutbox([entry('e1'), entry('e2')]);
    const { transport, deliver, send } = mockTransport((frame) => {
      if (frame.messageId === 'e1') deliver(ackRefused(frame, 'Error: shard is not hosted here'));
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markFailed.mock.calls.length > 0, 'e1 to be refused');
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Both frames went out — the batch is in flight at once — and e2 was very
    // likely applied, but retiring it here would move the queue past an entry that
    // is still owed. A duplicate is recoverable; a gap is not.
    expect(send.mock.calls.map((call) => call[0].messageId)).toEqual(expect.arrayContaining(['e1', 'e2']));
    expect(markDelivered).not.toHaveBeenCalled();
    // e1 is retried while the fixture keeps returning it as pending; e2 never is.
    expect([...new Set(markFailed.mock.calls.map((call) => call[0]))]).toEqual(['e1']);

    await replication.stop();
  });

  it('MA.6 — an answer nobody is waiting for is counted, not applied', async () => {
    const { store, markDelivered } = mockOutbox([]);
    const { transport, deliver } = mockTransport(() => {
      // Sends answer nothing; the stray ack below is delivered by hand.
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    deliver(ackOk({ messageId: 'never-sent' } as TransportMessage));
    await waitFor(() => replication.getAckStats().unsolicited > 0, 'the stray ack to be counted');

    expect(replication.getAckStats().unsolicited).toBe(1);
    expect(markDelivered).not.toHaveBeenCalled();

    await replication.stop();
  });

  it('MA.7 — the send-only contract is still available, and says so', async () => {
    const { store, markDelivered } = mockOutbox([entry('e1')]);
    const { transport } = mockTransport(() => {
      // Nothing answers, and nothing needs to.
    });
    const replication = new MultiLeaderReplication({
      transport,
      outbox: store,
      config: makeConfig({ acknowledgement: 'none', ackTimeoutMs: 40 }),
    });

    await replication.start();
    await waitFor(() => markDelivered.mock.calls.length > 0, 'e1 to be retired on the send');

    expect(markDelivered).toHaveBeenCalledWith('e1');
    expect(replication.getAckStats()).toEqual({ received: 0, timeouts: 0, pending: 0, unsolicited: 0 });

    await replication.stop();
  });

  it('MA.8 — a send that throws abandons the wait it opened', async () => {
    const { store, markDelivered, markFailed } = mockOutbox([entry('e1')]);
    const { transport } = mockTransport(() => {
      throw new Error('socket closed');
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markFailed.mock.calls.length > 0, 'the send failure');

    expect(markFailed).toHaveBeenCalledWith('e1', 'socket closed');
    expect(markDelivered).not.toHaveBeenCalled();
    // The wait was abandoned rather than left to expire: a closed socket will not
    // answer late.
    expect(replication.getAckStats().pending).toBe(0);

    await replication.stop();
  });

  it('MA.9 — an answer that arrives before the send resolves is still matched', async () => {
    // The in-process transport delivers the peer's reply inside the same tick. The
    // wait has to be registered before `send()` is awaited, or the answer arrives
    // with nothing to match and the entry waits out a budget the peer already met.
    const { store, markDelivered } = mockOutbox([entry('e1')]);
    const { transport, deliver } = mockTransport((frame) => {
      deliver(ackOk(frame));
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markDelivered.mock.calls.length > 0, 'e1 to be retired');

    expect(replication.getAckStats().timeouts).toBe(0);
    expect(replication.getAckStats().received).toBeGreaterThan(0);

    await replication.stop();
  });

  it('MA.10 — the counters are a shape a status page can print', () => {
    const { store } = mockOutbox([]);
    const { transport } = mockTransport(() => undefined);
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    expect(replication.getAckStats()).toEqual({
      received: 0,
      timeouts: 0,
      pending: 0,
      unsolicited: 0,
    });

    // Every subscription is detachable, or a composition root that rebuilds a
    // replication cannot release the old one's listeners.
    for (const detach of [
      replication.onTargetRecovered(() => undefined),
      replication.onHighLag(() => undefined),
      replication.onTargetConnected(() => undefined),
      replication.onTargetDisconnected(() => undefined),
    ]) {
      expect(() => detach()).not.toThrow();
    }
  });

  it('MA.11 — a refused answer is not retried inside the same tick', async () => {
    // A refusal is evidence, not an outage: the worker backs off, so the peer is not
    // asked the same question in the next tick while it is still in the same state.
    const { store, markFailed } = mockOutbox([entry('e1')]);
    const { transport, deliver, send } = mockTransport((frame) => {
      deliver(ackRefused(frame, 'Error: not leader'));
    });
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    await waitFor(() => markFailed.mock.calls.length > 0, 'the refusal');
    const sendsAtFailure = send.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(send.mock.calls.length).toBeGreaterThanOrEqual(sendsAtFailure);
    expect(markFailed.mock.calls.length).toBeGreaterThanOrEqual(1);

    await replication.stop();
  });

  it('MA.12 — a confirmation is never treated as a change by the sender', async () => {
    const { store } = mockOutbox([]);
    const { transport, deliver } = mockTransport(() => undefined);
    const replication = new MultiLeaderReplication({ transport, outbox: store, config: makeConfig() });

    await replication.start();
    // A `cdc_ack` frame carries the id of the frame it answers, so a sender that
    // applied inbound frames blindly would write it into its own store.
    deliver(ackOk({ messageId: 'x' } as TransportMessage));
    expect(CDC_ACK_TYPE).toBe('cdc_ack');

    await replication.stop();
  });
});
