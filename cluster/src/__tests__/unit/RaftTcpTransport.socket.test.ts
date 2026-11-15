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
  certs = generateClusterCerts(4);
  // Port 0: the OS picks a free port, so this cannot collide with another suite
  // or another agent's test run. The resolved port is read back below.
  first = transportFor(1, 0);
  second = transportFor(2, 0);
  await first.start();
  await second.start();

  // Only node 1 dials. A TLS socket is bidirectional, so node 2 answers over the
  // accepted connection; letting both nodes dial at once would make the test
  // depend on which side wins the race to replace its outgoing socket.
  first.register({ id: 2, host: '127.0.0.1', port: second.getBoundPort() });
  await first.waitForConnections();
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
