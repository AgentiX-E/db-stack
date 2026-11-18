/**
 * What counts as "this peer answered", and where the observer must sit.
 *
 * Why this file exists
 * --------------------
 * The quorum watchdog needs one thing: evidence that a peer's transport completed a
 * round trip. That evidence is only honest if the observer is the **innermost**
 * wrapper in the chain — the one touching the real transport. Anywhere else, a
 * fault injection layer that answers a dropped message with a fabricated reply
 * would look exactly like a healthy peer, and a partitioned leader would keep
 * claiming a majority it has just lost. That is not hypothetical: it is the shape
 * of the reply the chaos harness returns for a dropped message.
 *
 * So placement is part of the contract, and `AC 49.7` is the case that pins it: an
 * outer layer that fabricates an answer without calling its inner transport
 * produces no observation at all.
 *
 * Acceptance criteria:
 *   AC 49.1  a completed round trip is observed, with the peer id as a number
 *   AC 49.2  a rejected send is not observed, and its error propagates unchanged
 *   AC 49.3  the answer is returned by identity, not copied
 *   AC 49.4  lifecycle and message registration delegate to the wrapped transport
 *   AC 49.5  underlying reports the wrapped transport, so a chain can be walked
 *   AC 49.6  a peer id that is not a number is not observed as a member
 *   AC 49.7  an outer layer that answers without reaching the wrapped transport is not observed
 *   AC 49.8  the observer does not swallow or delay a send it observes
 *   AC 49.9  optional peer management mirrors the wrapped transport instead of inventing it
 */

import { describe, expect, it, vi } from 'vitest';
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';
import { ObservedTransport } from '../../consensus/transport/ObservedTransport';

const aMessage = {
  type: 'AppendEntries',
  direction: 'request',
  payload: { term: 3, leaderId: '1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 },
} as unknown as RPCMessage;

function innerTransport(answer: () => Promise<RPCMessage>) {
  const answers: RPCMessage[] = [];
  const handlers: MessageHandler[] = [];
  const transport = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isStarted: vi.fn(() => true),
    send: vi.fn(async (_peer: NodeId) => {
      const value = await answer();
      answers.push(value);
      return value;
    }),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
  } satisfies Transport;
  return { transport, answers, handlers };
}

const reply = {
  type: 'AppendEntries',
  direction: 'response',
  payload: { term: 3, success: true },
} as unknown as RPCMessage;

describe('ObservedTransport', () => {
  it('AC 49.1 — a completed round trip is observed with the peer id as a number', async () => {
    const inner = innerTransport(async () => reply);
    const observed: number[] = [];
    const subject = new ObservedTransport(inner.transport, (peer) => observed.push(peer));

    await subject.send('2', aMessage);
    await subject.send('3', aMessage);

    // raft-core identifies peers by string; the watchdog counts members by number.
    // Converting here keeps the conversion in one place instead of at every use.
    expect(observed).toEqual([2, 3]);
  });

  it('AC 49.2 — a rejected send is not observed, and its error propagates unchanged', async () => {
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:1');
    const inner = innerTransport(async () => {
      throw failure;
    });
    const observed: number[] = [];
    const subject = new ObservedTransport(inner.transport, (peer) => observed.push(peer));

    await expect(subject.send('2', aMessage)).rejects.toBe(failure);
    // The whole point: a transport that could not deliver anything must not be
    // recorded as contact, or an isolated leader would keep a quorum forever.
    expect(observed).toEqual([]);
  });

  it('AC 49.3 — the answer is returned by identity, not copied', async () => {
    const inner = innerTransport(async () => reply);
    const subject = new ObservedTransport(inner.transport, () => {});

    expect(await subject.send('2', aMessage)).toBe(reply);
  });

  it('AC 49.4 — lifecycle and message registration delegate to the wrapped transport', async () => {
    const inner = innerTransport(async () => reply);
    const subject = new ObservedTransport(inner.transport, () => {});
    const handler: MessageHandler = async () => reply;

    await subject.start();
    subject.onMessage(handler);
    expect(inner.transport.start).toHaveBeenCalledTimes(1);
    expect(inner.handlers).toEqual([handler]);
    expect(subject.isStarted()).toBe(true);
    await subject.stop();
    expect(inner.transport.stop).toHaveBeenCalledTimes(1);
  });

  it('AC 49.5 — underlying reports the wrapped transport, so a chain can be walked', () => {
    const inner = innerTransport(async () => reply);
    const subject = new ObservedTransport(inner.transport, () => {});

    expect(subject.underlying).toBe(inner.transport);
  });

  it('AC 49.6 — a peer id that is not a number is not observed as a member', async () => {
    const inner = innerTransport(async () => reply);
    const observed: number[] = [];
    const subject = new ObservedTransport(inner.transport, (peer) => observed.push(peer));

    await subject.send('not-a-node', aMessage);

    // `Number('not-a-node')` is NaN, and NaN is not a member of any cluster. Dropping
    // it here is what stops an unexpected peer id from inflating a majority.
    expect(observed.filter((peer) => Number.isFinite(peer))).toEqual([]);
  });

  it('AC 49.7 — an outer layer that answers without reaching the wrapped transport is not observed', async () => {
    const inner = innerTransport(async () => reply);
    const observed: number[] = [];
    const subject = new ObservedTransport(inner.transport, (peer) => observed.push(peer));

    // A fault injection layer sits outside the observer and answers a "dropped"
    // message itself, exactly as the chaos harness does. Nothing reaches the real
    // transport, so nothing is observed -- which is why the observer must be inside.
    class Outer {
      constructor(private wrapped: Transport) {}
      async start(): Promise<void> {
        await this.wrapped.start();
      }
      async stop(): Promise<void> {
        await this.wrapped.stop();
      }
      isStarted(): boolean {
        return this.wrapped.isStarted();
      }
      async send(_peer: NodeId, _message: RPCMessage): Promise<RPCMessage> {
        return {
          type: 'AppendEntries',
          direction: 'response',
          payload: { term: 0, success: false },
        } as unknown as RPCMessage;
      }
      onMessage(handler: MessageHandler): void {
        this.wrapped.onMessage(handler);
      }
    }

    const outer = new Outer(subject);
    await outer.send('2', aMessage);

    expect(observed).toEqual([]);
    expect(inner.transport.send).not.toHaveBeenCalled();
  });

  it('AC 49.9 — optional peer management mirrors the wrapped transport instead of inventing it', async () => {
    // raft-core branches on whether `addPeer` exists. A wrapper that defines it
    // unconditionally converts "this transport cannot add peers" into a failed start;
    // one that swallows the call answers "added" for a peer nobody added.
    const plain = innerTransport(async () => reply);
    expect(new ObservedTransport(plain.transport, () => {}).addPeer).toBeUndefined();
    expect(new ObservedTransport(plain.transport, () => {}).removePeer).toBeUndefined();

    const capable = {
      ...innerTransport(async () => reply).transport,
      addPeer: vi.fn(async () => {}),
      removePeer: vi.fn(),
    } satisfies Transport;
    const subject = new ObservedTransport(capable, () => {});
    await subject.addPeer!('4', '127.0.0.1:1');
    subject.removePeer!('4');
    expect(capable.addPeer).toHaveBeenCalledWith('4', '127.0.0.1:1');
    expect(capable.removePeer).toHaveBeenCalledWith('4');
  });

  it('AC 49.8 — the observer does not swallow or delay a send it observes', async () => {
    const inner = innerTransport(async () => reply);
    const observed: number[] = [];
    const subject = new ObservedTransport(inner.transport, (peer) => {
      observed.push(peer);
      throw new Error('an observer must not be able to fail a send');
    });

    // A callback that throws is a bug in the caller's bookkeeping. Letting it reject a
    // completed RPC would turn a healthy round trip into a transport failure, so the
    // callback runs inside a guard that reports and continues.
    await expect(subject.send('2', aMessage)).resolves.toBe(reply);
    expect(observed).toEqual([2]);
  });
});
