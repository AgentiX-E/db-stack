/**
 * A partition a test can turn on and off, over whatever transport a node has.
 *
 * Why this file exists
 * --------------------
 * Isolating a node in-process used to mean stopping it, which is not a partition:
 * a stopped node is a dead node, and the cluster's reaction to a dead node (its
 * sockets close, sends fail with ECONNREFUSED) is a different fault from a network
 * that silently drops packets. The chaos harness tried to model the silent version
 * and, until the transport seam existed, its injector was never called at all.
 *
 * What a partition does here is stated rather than implied: a blocked send does not
 * reject. It answers with a refusal of the request's own kind and term 0 — the
 * closest in-process shape of a packet that vanished, because raft-core's
 * replication path is written for answers, not for exceptions, and a thrown error
 * in a heartbeat loop is a different event from silence. Inbound requests from a
 * blocked peer are refused the same way, so isolation is symmetric: a node that
 * cannot be reached also cannot answer.
 *
 * Acceptance criteria:
 *   AC 50.1  a send to a blocked peer returns a refusal of the request's own kind, never the peer's answer
 *   AC 50.2  a send to a healthy peer reaches the wrapped transport and returns its answer unchanged
 *   AC 50.3  an inbound request from a blocked peer is refused without reaching the handler
 *   AC 50.4  heal restores both directions
 *   AC 50.5  isolating with no argument blocks every peer
 *   AC 50.6  statistics separate delivered, blocked and refused
 *   AC 50.7  underlying reports the wrapped transport
 *   AC 50.8  optional peer management mirrors the wrapped transport instead of inventing it
 *   AC 50.9  a blocked InstallSnapshot is refused as an InstallSnapshot, not as an append
 */

import { describe, expect, it, vi } from 'vitest';
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';
import { PartitionTransport } from '../../testing/partition';

const appendEntries = {
  type: 'AppendEntries',
  direction: 'request',
  payload: { term: 7, leaderId: '1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 },
} as unknown as RPCMessage;

const requestVote = {
  type: 'RequestVote',
  direction: 'request',
  payload: { term: 7, candidateId: '1', lastLogIndex: 0, lastLogTerm: 0 },
} as unknown as RPCMessage;

function innerTransport() {
  const handlers: MessageHandler[] = [];
  const transport = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isStarted: vi.fn(() => true),
    send: vi.fn(async (peer: NodeId, message: RPCMessage) => {
      const answer = {
        type: message.type,
        direction: 'response',
        payload: { term: 7, success: true, voteGranted: true },
      };
      return answer as unknown as RPCMessage;
    }),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
  } satisfies Transport;
  return { transport, handlers };
}

describe('PartitionTransport', () => {
  it('AC 50.1 — a blocked send is refused in the request’s own kind, never answered as the peer', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);
    subject.isolate();

    const toVote = await subject.send('2', requestVote);
    const toAppend = await subject.send('2', appendEntries);

    // The refusal has to match the request, or raft-core reads a vote rejection out of
    // an append failure. The chaos harness answered every request with an AppendEntries
    // message, which only worked because nothing ever read it.
    expect(toVote.type).toBe('RequestVote');
    expect((toVote.payload as { voteGranted: boolean; term: number }).voteGranted).toBe(false);
    expect((toVote.payload as { term: number }).term).toBe(0);
    expect(toAppend.type).toBe('AppendEntries');
    expect((toAppend.payload as { success: boolean }).success).toBe(false);
    expect(inner.transport.send).not.toHaveBeenCalled();
  });

  it('AC 50.2 — a send to a healthy peer reaches the wrapped transport and returns its answer', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);

    const answer = await subject.send('2', appendEntries);

    expect(inner.transport.send).toHaveBeenCalledTimes(1);
    expect((answer.payload as { success: boolean }).success).toBe(true);
  });

  it('AC 50.3 — an inbound request from a blocked peer is refused without reaching the handler', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);
    let delivered = 0;
    subject.onMessage(async () => {
      delivered++;
      return appendEntries;
    });
    const handler = inner.handlers[0]!;

    subject.isolate([2]);
    const refused = await handler('2', appendEntries);
    expect(delivered).toBe(0);
    expect((refused.payload as { success: boolean }).success).toBe(false);

    // A peer that is not blocked still gets through: isolation is per peer, not a
    // switch that turns the whole node into a black hole.
    await handler('3', appendEntries);
    expect(delivered).toBe(1);
  });

  it('AC 50.4 — heal restores both directions', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);
    let delivered = 0;
    subject.onMessage(async () => {
      delivered++;
      return appendEntries;
    });
    const handler = inner.handlers[0]!;

    subject.isolate([2]);
    await subject.send('2', appendEntries);
    subject.heal();

    await subject.send('2', appendEntries);
    await handler('2', appendEntries);
    expect(inner.transport.send).toHaveBeenCalledTimes(1);
    expect(delivered).toBe(1);
  });

  it('AC 50.5 — isolating with no argument blocks every peer', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);

    subject.isolate();

    expect(subject.blocked).toEqual([]);
    expect(subject.isIsolated()).toBe(true);
    await subject.send('2', appendEntries);
    await subject.send('9', appendEntries);
    expect(inner.transport.send).not.toHaveBeenCalled();
  });

  it('AC 50.6 — statistics separate what crossed each direction from what was blocked', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);
    subject.onMessage(async () => appendEntries);
    const handler = inner.handlers[0]!;

    await subject.send('2', appendEntries);
    subject.isolate([3]);
    await subject.send('3', appendEntries);
    await handler('3', appendEntries);
    await handler('2', appendEntries);

    // Named per direction: "messages dropped" alone cannot tell a node that stopped
    // sending from one that stopped answering, and those are different faults.
    expect(subject.getStats()).toEqual({ forwarded: 1, blocked: 1, delivered: 1, refused: 1 });
  });

  it('AC 50.8 — optional peer management mirrors the wrapped transport instead of inventing it', async () => {
    const plain = innerTransport();
    expect(new PartitionTransport(plain.transport).addPeer).toBeUndefined();

    const capable = {
      ...innerTransport().transport,
      addPeer: vi.fn(async () => {}),
      removePeer: vi.fn(),
    } satisfies Transport;
    const subject = new PartitionTransport(capable);
    await subject.addPeer!('4', '127.0.0.1:1');
    subject.removePeer!('4');
    expect(capable.removePeer).toHaveBeenCalledWith('4');
  });

  it('AC 50.9 — a blocked InstallSnapshot is refused as an InstallSnapshot, not as an append', async () => {
    // The third request kind. Snapshot install is the path a follower needs most after
    // a partition, so a refusal that claims to be an append is the one that produces
    // the least readable log when a re-sync stalls.
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);
    subject.isolate([2]);

    const refused = await subject.send('2', {
      type: 'InstallSnapshot',
      direction: 'request',
      payload: {
        term: 9,
        leaderId: '1',
        lastIncludedIndex: 10,
        lastIncludedTerm: 1,
        data: Buffer.alloc(0),
        config: {},
        offset: 0,
        done: true,
      },
    } as unknown as RPCMessage);

    expect(refused.type).toBe('InstallSnapshot');
    expect((refused.payload as { success: boolean }).success).toBe(false);
  });

  it('AC 50.7 — underlying reports the wrapped transport, and the lifecycle delegates', async () => {
    const inner = innerTransport();
    const subject = new PartitionTransport(inner.transport);

    expect(subject.underlying).toBe(inner.transport);
    await subject.start();
    expect(subject.isStarted()).toBe(true);
    await subject.stop();
    expect(inner.transport.start).toHaveBeenCalledTimes(1);
    expect(inner.transport.stop).toHaveBeenCalledTimes(1);
  });
});
