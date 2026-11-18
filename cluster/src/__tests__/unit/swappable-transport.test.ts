/**
 * The transport seam, tested as an object.
 *
 * Why this file exists
 * --------------------
 * `ChaosCluster.start()` installs its fault injector like this:
 *
 *     const injector = new ChaosInjectingTransport((adapter as any).transport, …);
 *     (adapter as any).transport = injector;
 *
 * and a probe on 2026-11-18 showed what that achieves: with the leader
 * "partitioned", the injector recorded `{lost: 0, delayed: 0, partitioned: 0,
 * forwarded: 0}` — it had never been called — and the isolated leader committed a
 * write anyway. The reason is ordering, not carelessness in the harness:
 * `RaftNode` captures the `Transport` object it is constructed with, so replacing
 * `adapter.transport` afterwards changes a field that raft-core never reads again.
 * Every partition, loss and latency fault in this repository was applied to a
 * transport nobody used, which means the assertions that followed ("no split
 * brain", "converges after partition recovery") were describing a cluster that
 * was never partitioned.
 *
 * The fix is a stable object: raft-core is given a `SwappableTransport` that
 * delegates to a replaceable inner transport. Re-pointing the inner is then a
 * change raft-core observes, because it is the same object it has always held.
 *
 * The subtle half of that contract is inbound traffic. raft-core registers exactly
 * one message handler, once, at start. A seam that forwards sends but not the
 * handler would produce the worst possible failure: a node that answers nothing
 * while looking correctly wired, with every inbound RPC delivered to a transport
 * the node no longer uses.
 *
 * Acceptance criteria:
 *   AC 47.1  send reaches the current inner transport and its answer is returned unchanged
 *   AC 47.2  a swap re-points send without touching the transport it replaced
 *   AC 47.3  lifecycle calls delegate to the current inner transport
 *   AC 47.4  the message handler follows every swap, because raft-core registers it once
 *   AC 47.5  a handler registered after a swap lands on the transport installed then
 *   AC 47.6  a swap does not stop the previous transport: its owner still holds it
 *   AC 47.7  sending with nothing installed names the state instead of failing as a TypeError
 *   AC 47.8  underlying reports the current inner so connection reporting can walk the chain
 *   AC 47.9  optional peer management is absent while the current transport cannot do it
 *   AC 47.10 absence turns into presence when a transport that supports it is installed
 */

import { describe, expect, it, vi } from 'vitest';
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';
import { SwappableTransport } from '../../consensus/transport/SwappableTransport';

/** A transport that answers with its own name, for telling two of them apart. */
function namedTransport(name: string) {
  const seen: Array<{ peer: NodeId; message: RPCMessage }> = [];
  const answers: RPCMessage[] = [];
  const handlers: MessageHandler[] = [];
  const transport = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isStarted: vi.fn(() => true),
    send: vi.fn(async (peer: NodeId, message: RPCMessage) => {
      seen.push({ peer, message });
      const answer = { type: 'AppendEntries', direction: 'response', payload: { term: 1, success: true, from: name } };
      answers.push(answer as unknown as RPCMessage);
      return answer as unknown as RPCMessage;
    }),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
  } satisfies Transport;

  return { name, transport, seen, answers, handlers };
}

const aMessage = {
  type: 'AppendEntries',
  direction: 'request',
  payload: { term: 1, leaderId: '1', prevLogIndex: 0, prevLogTerm: 0, entries: [], leaderCommit: 0 },
} as unknown as RPCMessage;

const aHandler: MessageHandler = async () => aMessage;

describe('SwappableTransport', () => {
  it('AC 47.1 — send reaches the current transport and returns its answer unchanged', async () => {
    const first = namedTransport('first');
    const seam = new SwappableTransport(first.transport);

    const answer = await seam.send('2', aMessage);

    expect(first.seen).toEqual([{ peer: '2', message: aMessage }]);
    // Verbatim: raft-core reads `payload.success` and `payload.term` off this object,
    // so a copy that dropped an optional field would change consensus behaviour.
    expect(answer).toBe(first.answers[0]);
  });

  it('AC 47.2 — a swap re-points send without touching the transport it replaced', async () => {
    const first = namedTransport('first');
    const second = namedTransport('second');
    const seam = new SwappableTransport(first.transport);

    await seam.send('2', aMessage);
    seam.swap(second.transport);
    await seam.send('3', aMessage);

    expect(first.seen.map((call) => call.peer)).toEqual(['2']);
    expect(second.seen.map((call) => call.peer)).toEqual(['3']);
  });

  it('AC 47.3 — lifecycle calls delegate to the current transport', async () => {
    const first = namedTransport('first');
    const second = namedTransport('second');
    const seam = new SwappableTransport(first.transport);

    await seam.start();
    expect(first.transport.start).toHaveBeenCalledTimes(1);
    expect(seam.isStarted()).toBe(true);

    seam.swap(second.transport);
    expect(seam.isStarted()).toBe(true);
    await seam.stop();
    expect(second.transport.stop).toHaveBeenCalledTimes(1);
    expect(first.transport.stop).not.toHaveBeenCalled();
  });

  it('AC 47.4 — the message handler follows every swap, because raft-core registers it once', async () => {
    const first = namedTransport('first');
    const second = namedTransport('second');
    const seam = new SwappableTransport(first.transport);

    seam.onMessage(aHandler);
    expect(first.handlers).toEqual([aHandler]);

    seam.swap(second.transport);
    // Without this, raft-core would keep receiving nothing: it never calls onMessage
    // again, and the transport it registered on is no longer the one sending.
    expect(second.handlers).toEqual([aHandler]);
  });

  it('AC 47.5 — a handler registered after a swap lands on the transport installed then', async () => {
    const first = namedTransport('first');
    const second = namedTransport('second');
    const seam = new SwappableTransport(first.transport);

    seam.swap(second.transport);
    seam.onMessage(aHandler);

    expect(second.handlers).toEqual([aHandler]);
    expect(first.handlers).toEqual([]);
  });

  it('AC 47.6 — a swap does not stop the previous transport: its owner still holds it', async () => {
    // The injector in the chaos harness wraps the transport it replaces, so stopping
    // it here would kill the sockets the new chain depends on. Ownership stays with
    // whoever installed the transport, which is what makes wrapping possible.
    const first = namedTransport('first');
    const seam = new SwappableTransport(first.transport);

    seam.swap(namedTransport('second').transport);

    expect(first.transport.stop).not.toHaveBeenCalled();
    expect(first.transport.start).not.toHaveBeenCalled();
  });

  it('AC 47.7 — sending with nothing installed names the state instead of failing as a TypeError', async () => {
    const seam = new SwappableTransport(null);

    expect(() => seam.isStarted()).not.toThrow();
    expect(seam.isStarted()).toBe(false);
    await expect(seam.send('2', aMessage)).rejects.toThrow(/no transport installed/i);
  });

  it('AC 47.8 — underlying reports the current transport', () => {
    const first = namedTransport('first');
    const second = namedTransport('second');
    const seam = new SwappableTransport(first.transport);

    expect(seam.underlying).toBe(first.transport);
    seam.swap(second.transport);
    expect(seam.underlying).toBe(second.transport);
    seam.swap(null);
    expect(seam.underlying).toBeNull();
  });

  it('AC 47.9 — optional peer management is absent while the current transport cannot do it', async () => {
    // `addPeer`/`removePeer` are optional in the transport interface, and raft-core
    // branches on whether the method exists. A wrapper that always defines it turns
    // "this transport cannot add peers" into a failing reconfiguration; one that
    // silently ignores the call answers "added" for a peer nobody added.
    const plain = namedTransport('plain');
    const seam = new SwappableTransport(plain.transport);

    expect(seam.addPeer).toBeUndefined();
    expect(seam.removePeer).toBeUndefined();
  });

  it('AC 47.10 — absence turns into presence when a transport that supports it is installed', async () => {
    const plain = namedTransport('plain');
    const capable = {
      ...namedTransport('capable').transport,
      addPeer: vi.fn(async () => {}),
      removePeer: vi.fn(),
    } satisfies Transport;
    const seam = new SwappableTransport(plain.transport);

    seam.swap(capable);
    await seam.addPeer!('4', '127.0.0.1:1');
    seam.removePeer!('4');

    expect(capable.addPeer).toHaveBeenCalledWith('4', '127.0.0.1:1');
    expect(capable.removePeer).toHaveBeenCalledWith('4');

    seam.swap(plain.transport);
    expect(seam.addPeer).toBeUndefined();
  });
});
