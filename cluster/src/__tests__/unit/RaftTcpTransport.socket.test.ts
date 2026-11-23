/**
 * RaftTcpTransport — real mTLS round trip between two nodes.
 *
 * The other transport suites mock `node:tls` and `ConnectionPool`, which proves
 * the transport's branching but not that two nodes can exchange a framed message
 * at all. Here two transports bind ephemeral loopback ports with certificates
 * from the shared harness, discover each other through `getBoundPort()`, and are
 * driven only through the public API.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MessageCodec } from '../../consensus/transport/MessageCodec';
import { RaftTcpTransport } from '../../consensus/transport/RaftTcpTransport';
import type { RaftMessage } from '../../consensus/transport/MessageCodec';
import { generateClusterCerts, type TestClusterCerts } from '../../testing/test-certs';
import { bounded } from '../support/awaitBound';

/**
 * Start and stop, bounded.
 *
 * Both are promises the product resolves, which means both are promises a mutation
 * can leave unresolved — and a case that waits on one of those is a case the runner
 * has to time out instead of one that fails. `bounded` makes the difference visible
 * (see `../support/awaitBound`).
 */
const startWithin = (t: RaftTcpTransport) => bounded(t.start(), 'transport.start()');
const stopWithin = (t: RaftTcpTransport) => bounded(t.stop(), 'transport.stop()');

const RECEIVE_TIMEOUT_MS = 20_000;

let certs: TestClusterCerts;
let first: RaftTcpTransport;
let second: RaftTcpTransport;
/** Every transport built here, so teardown also runs when setup half-failed. */
const transports: RaftTcpTransport[] = [];

function transportFor(id: number, port: number, peerIds: number[] = []): RaftTcpTransport {
  const bundle = certs.nodes[id - 1]!;
  const transport = new RaftTcpTransport({
    node: { id, host: '127.0.0.1', port },
    peers: peerIds.map((peerId) => ({ id: peerId, host: '127.0.0.1', port: 1 })),
    tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
  });
  transports.push(transport);
  return transport;
}

/** Wait for the next raft message on `transport`, failing the test if none arrives. */
function nextMessage(transport: RaftTcpTransport): Promise<RaftMessage> {
  return new Promise<RaftMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a delivered message')), RECEIVE_TIMEOUT_MS);
    transport.once('message', (msg: RaftMessage) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

beforeAll(async () => {
  certs = generateClusterCerts(6);
  // Port 0: the OS picks a free port, so this cannot collide with another suite
  // or another agent's test run. The resolved port is read back below.
  first = transportFor(1, 0);
  second = transportFor(2, 0);
  await startWithin(first);
  await startWithin(second);

  // Both sides dial, which is what start() does for every configured peer in a
  // real cluster: a pair that only ever connects one way is not the shape the
  // product runs in. The pool keeps whichever connection arrives last and closes
  // the superseded one; a TLS socket is bidirectional, so the surviving
  // connection carries both directions. Eight consecutive both-ways dials
  // delivered every message both ways (worst 23 ms), which is why this is
  // asserted rather than avoided.
  first.register({ id: 2, host: '127.0.0.1', port: second.getBoundPort() });
  second.register({ id: 1, host: '127.0.0.1', port: first.getBoundPort() });
  await vi.waitFor(() => expect(first.getConnectedPeers()).toEqual([2]), 20_000);
  await vi.waitFor(() => expect(second.getConnectedPeers()).toEqual([1]), 20_000);
}, 120_000);

afterAll(async () => {
  for (const transport of transports) await stopWithin(transport);
});

describe('RaftTcpTransport — bound port', () => {
  it('reports the port the TLS server actually bound when configured with port 0', () => {
    const port = first.getBoundPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    expect(second.getBoundPort()).not.toBe(port);
  });

  it('reports the configured port before the server has been started', () => {
    expect(transportFor(3, 41000).getBoundPort()).toBe(41000);
  });
});

describe('RaftTcpTransport — a port that is taken', () => {
  it('rejects start() with EADDRINUSE instead of throwing out of band', async () => {
    // A busy machine hands the same port to two suites. The listen error arrives
    // asynchronously, and the transport used to re-emit it on itself: with no
    // 'error' listener that is an uncaught exception, which fails an entire run
    // even though start() was already rejecting with the same error.
    const taken = new RaftTcpTransport({
      node: { id: 6, host: '127.0.0.1', port: first.getBoundPort() },
      peers: [],
      tls: {
        cert: certs.nodes[5]!.cert,
        key: certs.nodes[5]!.key,
        ca: certs.caPem,
      },
    });

    await expect(taken.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await stopWithin(taken);
  });
});

describe('RaftTcpTransport — peer connections', () => {
  it('lists the peer it holds a live mTLS connection to, and nobody else', () => {
    expect(first.getConnectedPeers()).toEqual([2]);
    expect(second.getConnectedPeers()).toEqual([1]);
  });

  it('reports no connected peers before start', () => {
    expect(transportFor(4, 0, [5]).getConnectedPeers()).toEqual([]);
  });
});

describe('RaftTcpTransport — reachability', () => {
  it('reports a live, certificate-verified peer as reachable', () => {
    // AC 44.1 — the question `send()` cannot answer on its own: `send()` is
    // non-blocking and buffers when no connection is live, so an application that
    // needs to know whether a frame left the process has to ask the socket.
    expect(first.canReach(2)).toBe(true);
  });

  it('reports a peer with no connection as unreachable', () => {
    expect(first.canReach(5)).toBe(false);
  });

  it('reports every peer as unreachable before start and after stop', async () => {
    const fresh = transportFor(3, 0, [4]);
    // No pool exists until start(), and a frame written now would go nowhere.
    expect(fresh.canReach(4)).toBe(false);

    const live = transportFor(5, 0);
    await startWithin(live);
    await stopWithin(live);
    expect(live.canReach(1)).toBe(false);
  });
});

describe('RaftTcpTransport — handler removal', () => {
  it('stops delivering to a handler removed with offMessage', async () => {
    // AC 44.2 — `onMessage` registers on the inner emitter, and nothing removed
    // it. A transport that is stopped and reused therefore delivered every
    // inbound message once per registration.
    const delivered: RaftMessage[] = [];
    const handler = (msg: RaftMessage): void => {
      delivered.push(msg);
    };

    first.onMessage(handler);

    await second.send(2, [
      {
        msgType: 5,
        from: '2',
        to: '1',
        term: '9',
        entries: [{ index: '5', term: '9', entryType: 0, data: 'before-off' }],
      },
    ]);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), 10_000);

    first.offMessage(handler);
    expect(first.listenerCount('message')).toBe(0);

    // A second, still-registered handler proves the next frame really arrives —
    // without it, `delivered` staying at 1 would also be explained by the frame
    // never being sent, which is not what this case is about.
    const observed: RaftMessage[] = [];
    const probe = (msg: RaftMessage): void => {
      observed.push(msg);
    };
    first.onMessage(probe);

    await second.send(2, [
      {
        msgType: 5,
        from: '2',
        to: '1',
        term: '10',
        entries: [{ index: '6', term: '10', entryType: 0, data: 'after-off' }],
      },
    ]);
    await vi.waitFor(() => expect(observed).toHaveLength(1), 10_000);
    expect(delivered).toHaveLength(1);
    first.offMessage(probe);
  });
});

describe('RaftTcpTransport — message delivery', () => {
  it('delivers an uncompressed raft message with the sender id preserved', async () => {
    const received = nextMessage(second);

    await first.send(1, [
      {
        msgType: 1,
        from: '1',
        to: '2',
        term: '7',
        index: '3',
        commit: '2',
        entries: [{ index: '3', term: '7', entryType: 0, data: 'a-command' }],
      },
    ]);

    const msg = await received;
    expect(msg.from).toBe('1');
    expect(msg.to).toBe('2');
    expect(msg.msgType).toBe(1);
    expect(msg.term).toBe('7');
    expect(msg.entries?.[0]?.data).toBe('a-command');
  });

  it('carries an InstallSnapshot chunk as bytes, not as a JSON object', async () => {
    // The end-to-end shape that failed: `BatchedRaftTransport` frames an
    // InstallSnapshot request as `{requestId, msg}` and this transport JSON-encodes
    // it. Before the codec was binary-safe, the chunk arrived as
    // `{type: 'Buffer', data: [ … ]}` — an object whose `.length` is `undefined` —
    // and raft-core drops a chunk with `if (request.data.length > 0)`, so the
    // assembled snapshot was empty and the follower never installed it.
    const chunk = randomBytes(4096);
    const received = nextMessage(second);

    first.sendToPeer(
      2,
      MessageCodec.encode({
        requestId: 'r-1',
        msg: { type: 'InstallSnapshot', direction: 'request', payload: { data: chunk } },
      }),
    );

    const frame = (await received) as unknown as { requestId: string; msg: { payload: { data: Buffer } } };
    expect(frame.requestId).toBe('r-1');
    expect(Buffer.isBuffer(frame.msg.payload.data)).toBe(true);
    expect(frame.msg.payload.data.length).toBe(chunk.length);
    expect(frame.msg.payload.data.equals(chunk)).toBe(true);
  });

  it('delivers in the reverse direction over the same pair', async () => {
    // The direction that a one-way setup never exercises: node 2 speaks first.
    const received = nextMessage(first);

    await second.send(2, [
      {
        msgType: 1,
        from: '2',
        to: '1',
        term: '9',
        index: '5',
        commit: '4',
        entries: [{ index: '5', term: '9', entryType: 0, data: 'a-reply' }],
      },
    ]);

    const msg = await received;
    expect(msg.from).toBe('2');
    expect(msg.to).toBe('1');
    expect(msg.entries?.[0]?.data).toBe('a-reply');
  });

  it('delivers a payload above the compression threshold after decompressing it', async () => {
    // 7.8 KiB of repeated text clears the default 1 KiB threshold, so the frame
    // is written zstd-compressed and the receiver has to decompress it.
    const data = 'compressible-'.repeat(600);
    const received = nextMessage(second);

    await first.send(1, [
      {
        msgType: 3,
        from: '1',
        to: '2',
        term: '8',
        entries: [{ index: '4', term: '8', entryType: 0, data }],
      },
    ]);

    const msg = await received;
    expect(msg.entries?.[0]?.data).toBe(data);
  });
});
