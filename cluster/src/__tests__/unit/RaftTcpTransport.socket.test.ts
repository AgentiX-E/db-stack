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
import { RaftTcpTransport } from '../../consensus/transport/RaftTcpTransport';
import type { RaftMessage } from '../../consensus/transport/MessageCodec';
import { generateClusterCerts, type TestClusterCerts } from '../../testing/test-certs';

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
  await first.start();
  await second.start();

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
  for (const transport of transports) await transport.stop();
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
    await taken.stop();
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
