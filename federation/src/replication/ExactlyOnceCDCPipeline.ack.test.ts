/**
 * ExactlyOnceCDCPipeline — a frame is delivered when the peer says so.
 *
 * `ITransport.send()` resolves `true` when the bytes reached a socket, and a TCP
 * write into a connection whose peer has gone is accepted by the local kernel.
 * The pump treated that as a delivery, so an acceptance run reported twenty
 * changes delivered and thirteen applied — with `refusals: 0` and
 * `deadLetterCount: 0`, because nothing had failed as far as the sender could
 * tell. The sender was making a claim about the peer without asking the peer.
 *
 * These cases cover the answer: the confirmation frame, the wait for it, and the
 * four outcomes a cycle can end in.
 *
 *   ACK.1  an entry is not delivered until the peer confirms it
 *   ACK.2  the confirmation is what advances the checkpoint
 *   ACK.3  a silent peer costs a timeout, and the entry stays pending
 *   ACK.4  a refusal fails the entry on the spot, with the peer's reason
 *   ACK.5  an acknowledgement that does not parse is not a confirmation
 *   ACK.6  an empty acknowledgement body is a confirmation
 *   ACK.7  a confirmation for an id nobody is waiting for is ignored
 *   ACK.8  the checkpoint follows send order, not arrival order of the answers
 *   ACK.9  one unanswered entry holds the ones behind it pending
 *   ACK.10 stop() while waiting leaves the entry pending and charges no attempt
 *   ACK.11 acknowledge() without a transport is refused by name
 *   ACK.12 acknowledge() answers the frame's sender, under the frame's id
 *   ACK.13 processInbound does not confirm anything by itself
 *   ACK.14 acknowledgement 'none' is the weaker contract, chosen explicitly
 *   ACK.15 stop() detaches the transport subscription
 *   ACK.16 two pipelines over one transport: applied changes are confirmed
 *   ACK.17 a replayed frame is deduplicated and confirmed again
 *   ACK.18 the acknowledgment carries the acker's own timestamp
 *   ACK.19 a refused send fails the entry without waiting for an answer
 *   ACK.20 a transport that throws fails the entry with the thrown reason
 *   ACK.21 a payload that cannot be decoded is refused, and is not remembered as applied
 *
 * One mutant survives in `cdcAck.ts`, and it is equivalent rather than untested:
 * dropping `typeof body === 'object'` from the refusal guard leaves `body.ok` to be
 * read off a primitive, which yields `undefined` exactly as the real condition does
 * not yield `true` — so `null`, `42` and `"applied"` are read as confirmations either
 * way. ACK.6 pins the behaviour on all three; the guard stays because a sentence
 * about an object should not rest on the fact that `(42).ok` happens not to throw.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExactlyOnceCDCPipeline, type ExactlyOnceCDCPipelineConfig } from './ExactlyOnceCDCPipeline';
import { buildAckFrame, CDC_ACK_TYPE, parseAck } from './cdcAck';
import { makeHLC } from '../hlc/HLC';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { CDCChangeEvent } from '../interfaces/replication/ICDCManager';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdc-ack-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Answer = 'applied' | 'refused' | 'silent';

/**
 * A peer at the other end of a transport.
 *
 * Not a stand-in for the pipeline: it is the party the sender is making a claim
 * about, so it is the only thing that can say whether the claim is true. Every
 * frame it accepts is also handed to any handler that registered — which is how
 * the two-pipeline cases wire a real receiver into the same wire.
 */
function peer(initial: { answer?: Answer } = {}) {
  const frames: TransportMessage[] = [];
  const acks: TransportMessage[] = [];
  const handlers = new Set<(message: InboundMessage) => void>();
  let answer: Answer = initial.answer ?? 'applied';

  const emit = (message: TransportMessage): void => {
    for (const handler of handlers) handler({ ...message, receivedAt: Date.now() });
  };

  const transport: ITransport = {
    async send(message: TransportMessage): Promise<boolean> {
      if (message.type === CDC_ACK_TYPE) {
        acks.push(message);
        emit(message);
        return true;
      }
      frames.push(message);
      // The frame is on the wire before `send` resolves — the order a real
      // transport produces, and the reason the pipeline registers the wait first.
      emit(message);
      if (answer === 'applied') {
        emit(buildAckFrame(message, 'dc-b', message.timestamp));
      } else if (answer === 'refused') {
        emit(buildAckFrame(message, 'dc-b', message.timestamp, 'the row violates a constraint'));
      }
      return true;
    },
    async broadcast(message: TransportMessage): Promise<number> {
      emit(message);
      return 1;
    },
    onMessage(callback: (message: InboundMessage) => void): () => void {
      handlers.add(callback);
      return () => {
        handlers.delete(callback);
      };
    },
    getConnectedPeers: () => [],
    getStats: () => ({
      peersConnected: 1,
      messagesSent: frames.length,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };

  return {
    transport,
    frames,
    acks,
    answerTo(next: Answer) {
      answer = next;
    },
    listenerCount: () => handlers.size,
    /** Hand a frame to whoever is listening, as the network would. */
    emit,
  };
}

function config(dir: string, overrides: Partial<ExactlyOnceCDCPipelineConfig> = {}): ExactlyOnceCDCPipelineConfig {
  return {
    nodeId: 'dc-a',
    cdcConfig: { nodeId: 'dc-a' },
    outboxConfig: { dataDir: join(dir, 'outbox') },
    checkpointDir: join(dir, 'outbox'),
    pumpIntervalMs: 10,
    pumpBatchSize: 100,
    dedupTtlMs: 60_000,
    ackTimeoutMs: 60,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A pipeline with one change waiting in its outbox and a peer on the wire. */
async function pipelineWithOneChange(
  dir: string,
  remote: ReturnType<typeof peer>,
  overrides: Partial<ExactlyOnceCDCPipelineConfig> = {},
): Promise<ExactlyOnceCDCPipeline> {
  const pipeline = new ExactlyOnceCDCPipeline({
    ...config(dir, overrides),
    transport: remote.transport,
    remoteNodeId: 'dc-b',
  });
  cleanups.push(() => pipeline.cleanup());
  await pipeline.start();
  pipeline.watchTable('users');
  pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id: 1 } });
  return pipeline;
}

describe('ExactlyOnceCDCPipeline — a delivery is the peer’s answer', () => {
  it('ACK.1: an entry is not delivered until the peer confirms it', async () => {
    const dir = makeDir();
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(dir, remote);

    await waitFor(() => remote.frames.length === 1);
    // The frame is on the wire and the outbox still holds the change. Under the
    // old contract this was the moment `markedDelivered` ran.
    const quiet = await pipeline.getMetrics();
    expect(quiet.pendingCount).toBe(1);
    expect(quiet.outboxDelivered).toBe(0);
    expect(quiet.acksReceived).toBe(0);

    remote.answerTo('applied');
    remote.emit(buildAckFrame(remote.frames[0]!, 'dc-b', remote.frames[0]!.timestamp));

    await waitFor(async () => (await pipeline.getMetrics()).outboxDelivered === 1);
    const confirmed = await pipeline.getMetrics();
    expect(confirmed.pendingCount).toBe(0);
    expect(confirmed.acksReceived).toBe(1);
  });

  it('ACK.2: the confirmation is what advances the checkpoint', async () => {
    const dir = makeDir();
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(dir, remote);

    await waitFor(() => remote.frames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(pipeline.getLastConfirmedLSN('users'), 'nothing was confirmed').toBeNull();

    remote.emit(buildAckFrame(remote.frames[0]!, 'dc-b', remote.frames[0]!.timestamp));
    await waitFor(async () => (await pipeline.getMetrics()).outboxDelivered === 1);
    expect(pipeline.getLastConfirmedLSN('users')).toBe('0/00000001');
  });

  it('ACK.3: a silent peer costs a timeout, and the entry stays pending', async () => {
    const dir = makeDir();
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(dir, remote, { ackTimeoutMs: 40 });

    await waitFor(async () => (await pipeline.getMetrics()).ackTimeouts >= 1);
    const metrics = await pipeline.getMetrics();
    expect(metrics.outboxDelivered).toBe(0);
    expect(metrics.pendingCount).toBe(1);
    expect(metrics.deadLetterCount, 'one timeout is not a dead letter').toBe(0);

    // The attempt was charged, and the retry was scheduled rather than fired on
    // the next tick: a hot loop is not a retry policy.
    const [pending] = await pipeline['outbox'].fetchOldestPending(1);
    expect(pending?.attemptCount).toBe(1);
    expect(pending?.nextAttemptAt).toBeGreaterThan(Date.now() - 1);
  });

  it('ACK.4: a refusal fails the entry on the spot, with the peer’s reason', async () => {
    const dir = makeDir();
    const remote = peer({ answer: 'refused' });
    const pipeline = await pipelineWithOneChange(dir, remote, { ackTimeoutMs: 5_000 });

    const errors: string[] = [];
    pipeline.onEvent((event) => {
      if (event.type === 'pump_error') errors.push(event.error ?? '');
    });

    // The refusal is answered immediately, so this is not a 5 s timeout.
    await waitFor(async () => (await pipeline.getMetrics()).acksReceived >= 1, 1_000);
    await waitFor(() => errors.length > 0, 1_000);

    expect(errors[0]).toContain('the row violates a constraint');
    const [pending] = await pipeline['outbox'].fetchOldestPending(1);
    expect(pending?.lastError).toBe('the row violates a constraint');
    expect((await pipeline.getMetrics()).ackTimeouts).toBe(0);
  });

  it('ACK.5: an acknowledgement that does not parse is not a confirmation', async () => {
    // It arrived, on this message's id, from the peer — but the sender cannot
    // read it, and taking an unreadable answer as a yes is how a lost change
    // becomes an invisible one.
    const body = new TextEncoder().encode('not json at all');
    const verdict = parseAck(body, '0/1:1');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('is not JSON');

    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(makeDir(), remote);
    await waitFor(() => remote.frames.length === 1);
    remote.emit({
      ...buildAckFrame(remote.frames[0]!, 'dc-b', remote.frames[0]!.timestamp),
      payload: body,
    });

    await waitFor(() => remote.frames.length >= 1);
    expect((await pipeline.getMetrics()).outboxDelivered).toBe(0);
    const [pending] = await pipeline['outbox'].fetchOldestPending(1);
    expect(pending?.lastError).toContain('is not JSON');
  });

  it('ACK.6: an empty acknowledgement body is a confirmation', () => {
    // A peer that answered at all, on the frame it was asked about, has said the
    // only thing the sender needs. Requiring a body would make the minimal ack —
    // the one a bridge is most likely to send — a delivery failure.
    expect(parseAck(new Uint8Array(), '0/1:1')).toEqual({ ok: true });
    expect(parseAck(new TextEncoder().encode('{"ok":true}'), '0/1:1')).toEqual({ ok: true });
    expect(parseAck(new TextEncoder().encode('{"applied":true}'), '0/1:1')).toEqual({ ok: true });
    // A body that is valid JSON and not an object has no `ok` to be false. The
    // guard around it is what keeps `null` from being read as an object, and these
    // three are the shapes that reach it.
    expect(parseAck(new TextEncoder().encode('null'), '0/1:1')).toEqual({ ok: true });
    expect(parseAck(new TextEncoder().encode('42'), '0/1:1')).toEqual({ ok: true });
    expect(parseAck(new TextEncoder().encode('"applied"'), '0/1:1')).toEqual({ ok: true });
    expect(parseAck(new TextEncoder().encode('{"ok":false}'), '0/1:1')).toEqual({
      ok: false,
      error: 'the peer refused 0/1:1',
    });
    expect(parseAck(new TextEncoder().encode('{"ok":false,"error":"poison"}'), '0/1:1')).toEqual({
      ok: false,
      error: 'poison',
    });
  });

  it('ACK.7: a confirmation for an id nobody is waiting for is ignored', async () => {
    // A retry that timed out and was re-sent re-uses the message id, so a late
    // answer arrives after the wait it belonged to has ended. Dropping it is the
    // designed behaviour, not an error.
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(makeDir(), remote);

    await waitFor(() => remote.frames.length === 1);
    remote.emit(buildAckFrame({ ...remote.frames[0]!, messageId: 'never-sent' }, 'dc-b', remote.frames[0]!.timestamp));

    const metrics = await pipeline.getMetrics();
    expect(metrics.acksReceived).toBe(0);
    expect(metrics.outboxDelivered).toBe(0);
    expect(metrics.pendingCount).toBe(1);
  });

  it('ACK.8: the checkpoint follows send order, not the arrival order of the answers', async () => {
    const remote = peer({ answer: 'silent' });
    const pipeline = new ExactlyOnceCDCPipeline({
      ...config(makeDir()),
      transport: remote.transport,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();
    pipeline.watchTable('users');
    pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id: 1 } });
    pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id: 2 } });

    await waitFor(() => remote.frames.length === 2);
    // The second answer first: a checkpoint that followed arrival order would
    // record 0/1 and then refuse 0/2 as stale, or record 0/2 and skip 0/1.
    remote.emit(buildAckFrame(remote.frames[1]!, 'dc-b', remote.frames[1]!.timestamp));
    remote.emit(buildAckFrame(remote.frames[0]!, 'dc-b', remote.frames[0]!.timestamp));

    await waitFor(async () => (await pipeline.getMetrics()).outboxDelivered === 2);
    expect(pipeline.getLastConfirmedLSN('users')).toBe('0/00000002');
  });

  it('ACK.9: one unanswered entry holds the ones behind it pending', async () => {
    const remote = peer({ answer: 'silent' });
    const pipeline = new ExactlyOnceCDCPipeline({
      ...config(makeDir(), { ackTimeoutMs: 40 }),
      transport: remote.transport,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();
    pipeline.watchTable('users');
    for (const id of [1, 2, 3]) {
      pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id } });
    }

    await waitFor(async () => (await pipeline.getMetrics()).ackTimeouts >= 1);
    const metrics = await pipeline.getMetrics();
    // Two and three were sent too, and may well have been applied — but marking
    // them delivered would let the checkpoint move past an entry still owed. They
    // are re-sent, the receiver deduplicates, and the answer comes again.
    expect(metrics.pendingCount).toBe(3);
    expect(metrics.outboxDelivered).toBe(0);
  });

  it('ACK.10: stop() while waiting leaves the entry pending and charges no attempt', async () => {
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(makeDir(), remote, { ackTimeoutMs: 30_000 });

    await waitFor(() => remote.frames.length === 1);
    const started = Date.now();
    await pipeline.stop();
    // Waiting is not failing: the stop must not wait out a 30 s timeout.
    expect(Date.now() - started).toBeLessThan(1_000);

    const [pending] = await pipeline['outbox'].fetchOldestPending(1);
    expect(pending?.id).toBeDefined();
    expect(pending?.attemptCount, 'our own shutdown is not the peer’s refusal').toBe(0);
    const metrics = await pipeline.getMetrics();
    expect(metrics.deadLetterCount).toBe(0);
  });

  it('ACK.11: acknowledge() without a transport is refused by name', async () => {
    const pipeline = new ExactlyOnceCDCPipeline(config(makeDir()));
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    await expect(
      pipeline.acknowledge({
        messageId: '0/1:1',
        sourcePeerId: 'dc-a',
        targetPeerId: 'dc-b',
        payload: new Uint8Array(),
        timestamp: makeHLC(1n, 0, 'dc-a'),
        createdAt: Date.now(),
        type: 'cdc_event:0/1',
      }),
    ).rejects.toThrow(/has no transport, so it cannot confirm 0\/1:1 to dc-a/);
  });

  it('ACK.12: acknowledge() answers the frame’s sender, under the frame’s id', async () => {
    const remote = peer();
    const pipeline = new ExactlyOnceCDCPipeline({
      ...config(makeDir()),
      transport: remote.transport,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    const inbound: TransportMessage = {
      messageId: '0/42:7',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-b',
      payload: new TextEncoder().encode('{}'),
      timestamp: makeHLC(1n, 0, 'dc-a'),
      createdAt: Date.now(),
      type: 'cdc_event:0/42',
    };
    expect(await pipeline.acknowledge(inbound)).toBe(true);

    expect(remote.acks).toHaveLength(1);
    expect(remote.acks[0]!.messageId).toBe('0/42:7');
    expect(remote.acks[0]!.sourcePeerId).toBe('dc-a');
    expect(remote.acks[0]!.targetPeerId).toBe('dc-a');
    // The body itself, not only the way this package reads it: the frame is a wire
    // format, and a peer that is not this package may require an explicit `ok`.
    expect(JSON.parse(new TextDecoder().decode(remote.acks[0]!.payload))).toEqual({ ok: true });
    expect(parseAck(remote.acks[0]!.payload, '0/42:7')).toEqual({ ok: true });

    await pipeline.acknowledge(inbound, 'cannot apply: unknown table');
    expect(parseAck(remote.acks[1]!.payload, '0/42:7')).toEqual({
      ok: false,
      error: 'cannot apply: unknown table',
    });
  });

  it('ACK.13: processInbound does not confirm anything by itself', async () => {
    // An ack means "applied", and applying is the caller's next line. A pipeline
    // that confirmed here would turn a crash between the callback and the
    // caller's write into a silent lost change.
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(makeDir(), remote);
    await waitFor(() => remote.frames.length === 1);

    const inbound = remote.frames[0]!;
    const result = pipeline.processInbound(inbound);
    expect(result.accepted).toBe(true);
    expect(remote.acks, 'no answer was sent on the sender’s behalf').toHaveLength(0);
    expect(remote.acks).toHaveLength(0);
  });

  it('ACK.14: acknowledgement none is the weaker contract, chosen explicitly', async () => {
    const remote = peer({ answer: 'silent' });
    const pipeline = await pipelineWithOneChange(makeDir(), remote, { acknowledgement: 'none' });

    await waitFor(async () => (await pipeline.getMetrics()).outboxDelivered === 1);
    const metrics = await pipeline.getMetrics();
    expect(metrics.pendingCount).toBe(0);
    expect(metrics.acksReceived, 'nobody answers under this contract').toBe(0);
    expect(remote.listenerCount(), 'and nothing is subscribed to listen').toBe(0);
  });

  it('ACK.15: stop() detaches the transport subscription', async () => {
    const remote = peer();
    const pipeline = await pipelineWithOneChange(makeDir(), remote);
    expect(remote.listenerCount()).toBe(1);

    await pipeline.stop();
    expect(remote.listenerCount()).toBe(0);
  });

  it('ACK.16: two pipelines over one transport — applied changes are confirmed', async () => {
    const remote = peer({ answer: 'silent' });
    const applied: string[] = [];

    const sender = new ExactlyOnceCDCPipeline({
      ...config(makeDir(), { nodeId: 'dc-a' }),
      transport: remote.transport,
      remoteNodeId: 'dc-b',
    });
    const receiver = new ExactlyOnceCDCPipeline({
      ...config(makeDir(), { nodeId: 'dc-b', ackTimeoutMs: 500 }),
      transport: remote.transport,
    });
    cleanups.push(() => sender.cleanup());
    cleanups.push(() => receiver.cleanup());
    await sender.start();
    await receiver.start();

    remote.transport.onMessage((message) => {
      if (message.type === CDC_ACK_TYPE) return;
      const result = receiver.processInbound(message);
      if (result.event) applied.push(result.event.lsn);
      // The apply is over, so the confirmation is sent.
      void receiver.acknowledge(message);
    });

    sender.watchTable('users');
    for (const id of [1, 2, 3, 4, 5]) {
      sender.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id } });
    }

    await waitFor(async () => (await sender.getMetrics()).outboxDelivered === 5);
    expect(applied).toHaveLength(5);
    expect(applied).toEqual([...applied].sort());

    const metrics = await sender.getMetrics();
    expect(metrics.pendingCount).toBe(0);
    expect(metrics.acksReceived).toBe(5);
    // The receiver's own checkpoint is the *sender's* resume point, so it is the
    // caller that advances it — here, by never needing one. What the receiving
    // side owes the sender is the apply and the answer, and both are counted.
    const receiverMetrics = await receiver.getMetrics();
    expect(receiverMetrics.totalDelivered).toBe(5);
    expect(receiverMetrics.totalDeduped).toBe(0);
  });

  it('ACK.17: a replayed frame is deduplicated and confirmed again', async () => {
    // A confirmation lost in a partition is not a lost change: the sender retries
    // the same message id, the ring rejects the repeat, and the receiver answers a
    // second time. That is the whole reason delivery is at-least-once.
    const remote = peer({ answer: 'silent' });
    const applied: CDCChangeEvent[] = [];
    const receiver = new ExactlyOnceCDCPipeline(config(makeDir(), { nodeId: 'dc-b' }));
    cleanups.push(() => receiver.cleanup());
    await receiver.start();

    const inbound: TransportMessage = {
      messageId: '0/9:2',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-b',
      payload: new TextEncoder().encode(
        JSON.stringify({
          lsn: '0/00000009',
          tableName: 'users',
          operation: 'insert',
          oldValues: null,
          newValues: { id: 9 },
          txId: 2,
          timestamp: 1,
        }),
      ),
      timestamp: makeHLC(1n, 0, 'dc-a'),
      createdAt: Date.now(),
      type: 'cdc_event:0/00000009',
    };

    const first = receiver.processInbound(inbound);
    const second = receiver.processInbound(inbound);
    if (first.event) applied.push(first.event);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(applied).toHaveLength(1);
    expect((await receiver.getMetrics()).totalDeduped).toBe(1);
    expect(remote.acks).toHaveLength(0);
  });

  it('ACK.19: a refused send fails the entry without waiting for an answer', async () => {
    // `send()` returning false is the transport saying it could not reach the
    // peer. Under acknowledgements there is nothing to wait for, so the wait is
    // abandoned rather than timed out — a refusal and a silence are different
    // facts, and the counters have to keep them apart.
    const remote = peer();
    const refusing: ITransport = { ...remote.transport, send: async () => false };
    const pipeline = new ExactlyOnceCDCPipeline({
      ...config(makeDir()),
      transport: refusing,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());

    const errors: string[] = [];
    pipeline.onEvent((event) => {
      if (event.type === 'pump_error') errors.push(event.error ?? '');
    });

    await pipeline.start();
    pipeline.watchTable('users');
    pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id: 1 } });

    await waitFor(() => errors.length > 0);
    expect(errors[0]).toContain('Transport refused message to dc-b');

    const metrics = await pipeline.getMetrics();
    expect(metrics.ackTimeouts, 'a refusal is not a silence').toBe(0);
    expect(metrics.pendingCount).toBe(1);
    expect(metrics.outboxDelivered).toBe(0);
  });

  it('ACK.20: a transport that throws fails the entry with the thrown reason', async () => {
    const remote = peer();
    const throwing: ITransport = {
      ...remote.transport,
      send: async () => {
        throw new Error('socket closed while writing');
      },
    };
    const pipeline = new ExactlyOnceCDCPipeline({
      ...config(makeDir()),
      transport: throwing,
      remoteNodeId: 'dc-b',
    });
    cleanups.push(() => pipeline.cleanup());

    const errors: string[] = [];
    pipeline.onEvent((event) => {
      if (event.type === 'pump_error') errors.push(event.error ?? '');
    });

    await pipeline.start();
    pipeline.watchTable('users');
    pipeline.appendChange({ tableName: 'users', operation: 'insert', oldValues: null, newValues: { id: 1 } });

    await waitFor(() => errors.length > 0);
    expect(errors[0]).toBe('socket closed while writing');
    expect((await pipeline.getMetrics()).ackTimeouts).toBe(0);
  });

  it('ACK.21: a payload that cannot be decoded is refused, and is not remembered as applied', async () => {
    // The ring is the record of what has been *applied*. A frame that failed to
    // decode was not, so leaving its id there would make the next delivery look
    // like a duplicate — and a caller that confirms duplicates (the correct thing
    // to do for a real one) would then tell the sender a change had landed that
    // never did. The retry has to be judged on its own and refused again.
    const pipeline = new ExactlyOnceCDCPipeline(config(makeDir()));
    cleanups.push(() => pipeline.cleanup());
    await pipeline.start();

    const frame: TransportMessage = {
      messageId: '0/77:1',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-b',
      payload: new TextEncoder().encode('not a change event'),
      timestamp: makeHLC(1n, 0, 'dc-a'),
      createdAt: Date.now(),
      type: 'cdc_event:0/00000077',
    };

    const first = pipeline.processInbound(frame);
    expect(first).toMatchObject({ accepted: false, reason: 'undecodable' });
    // Not a duplicate: the same frame, offered again, is judged again.
    const retry = pipeline.processInbound(frame);
    expect(retry).toMatchObject({ accepted: false, reason: 'undecodable' });

    const metrics = await pipeline.getMetrics();
    expect(metrics.totalDeduped).toBe(0);
    expect(metrics.totalDelivered).toBe(0);
  });

  it('ACK.18: the acknowledgment carries the acker’s own timestamp', async () => {
    // A frame stamped with the timestamp of the frame it answers would claim both
    // events happened at the same instant on the same clock.
    const acked: TransportMessage = {
      messageId: '0/3:1',
      sourcePeerId: 'dc-a',
      targetPeerId: 'dc-b',
      payload: new Uint8Array(),
      timestamp: makeHLC(10n, 4, 'dc-a'),
      createdAt: 1,
      type: 'cdc_event:0/00000003',
    };

    const frame = buildAckFrame(acked, 'dc-b', makeHLC(99n, 0, 'dc-b'));
    // The three components, not the object: `makeHLC` attaches fresh closures,
    // and what this case is about is whose clock the numbers came from.
    expect({ ...frame.timestamp, compare: undefined, serialize: undefined, deserialize: undefined }).toEqual({
      wallTime: 99n,
      logical: 0,
      nodeId: 'dc-b',
      compare: undefined,
      serialize: undefined,
      deserialize: undefined,
    });
    expect(frame.messageId).toBe(acked.messageId);
    expect(frame.type).toBe(CDC_ACK_TYPE);
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({ ok: true });
    expect(frame.createdAt).toBeGreaterThan(0);
  });
});
