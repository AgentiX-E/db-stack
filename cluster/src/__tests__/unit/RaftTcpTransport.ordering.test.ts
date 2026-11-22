/**
 * RaftTcpTransport — the order frames leave the process.
 *
 * A framed stream carries one promise about order: what was submitted first is
 * read first. Every layer above this one assumes it — Raft asks a follower to
 * append after an index it has not sent yet, and the CDC pipeline's consumer
 * applies changes in the order they arrive, so a frame that overtakes its
 * predecessor becomes a change applied out of order in another datacenter.
 *
 * Frames above the compression threshold go through zstd, which runs on libuv's
 * thread pool and resolves when the pool gets to it, not when it was asked.
 * `_sendFrame` used to write the frame inside that `.then()`, so the socket saw
 * the frames in *completion* order. On an idle machine the pool answers in
 * submission order and nothing shows; on a loaded CI runner the same code
 * delivers `1,2,3,5,4,6,7,3,5,4,…` — out of order *and* duplicated — and the
 * cross-datacenter suite fails with `expected [ 2, 3, 1, 4, … ] to deeply equal
 * [ 1, 2, 3, 4, … ]`.
 *
 * These cases are the observation, on real mTLS sockets between two real
 * transports, that order is a property of the sender. The slow frame is 300 KB
 * and every frame behind it is just over the threshold, so the compressor's
 * answer for the first frame cannot arrive first: the inversion is a property of
 * the sizes rather than of the machine's mood, which is what makes this a test
 * instead of a coin toss.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RaftMessage } from '../../consensus/transport/MessageCodec';
import type { CompressionConfig } from '../../interfaces/types';
import { RaftTcpTransport } from '../../consensus/transport/RaftTcpTransport';
import { generateClusterCerts, type TestClusterCerts } from '../../testing/test-certs';

/** The frame that takes the compressor the longest — sent first, so it must arrive first. */
const SLOW_BYTES = 300_000;
/** Every frame behind it: just over the 1024-byte default threshold. */
const QUEUED_BYTES = 1_200;
const QUEUED = 20;
const COUNT = QUEUED + 1;

let certs: TestClusterCerts;
/** Every transport built here, so teardown also runs when a case half-failed. */
const transports: RaftTcpTransport[] = [];

type Compression = CompressionConfig;
const COMPRESSED: Compression = { enabled: true, algorithm: 'zstd', threshold: 1024, level: 3 };
const PLAIN: Compression = { enabled: false, algorithm: 'none', threshold: 1024, level: 3 };

function transportFor(id: number, compression: Compression): RaftTcpTransport {
  const bundle = certs.nodes[id - 1]!;
  const transport = new RaftTcpTransport({
    node: { id, host: '127.0.0.1', port: 0 },
    peers: [],
    tls: { cert: bundle.cert, key: bundle.key, ca: certs.caPem },
    compression,
  });
  transports.push(transport);
  return transport;
}

/**
 * A message whose encoded frame is about `bytes` long.
 *
 * `MessageCodec` encodes the whole message as JSON and `_sendFrame` strips only
 * the four-byte length header before handing the rest to the compressor, so the
 * entry's data is what decides whether a frame crosses the threshold.
 */
function message(from: number, to: number, index: number, bytes: number): RaftMessage {
  return {
    msgType: 1,
    from: String(from),
    to: String(to),
    term: '1',
    index: String(index),
    entries: [{ index: String(index), term: '1', entryType: 0, data: 'x'.repeat(bytes) }],
  } as unknown as RaftMessage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

interface Burst {
  compression: Compression;
  /** Whether the receiver also dials the sender — the shape a real cluster runs in. */
  bothWays: boolean;
}

/**
 * Send one slow frame and then a queue of fast ones; return what the peer decoded.
 *
 * Two transports on ephemeral loopback ports, connected before anything is sent.
 * `bothWays` is the shape a real cluster runs in — each node dials the other and
 * the pool keeps whichever connection arrives last — so the promise has to hold
 * there too, not only in the one-directional shape a test finds easier to build.
 */
async function burst({ compression, bothWays }: Burst): Promise<number[]> {
  const sender = transportFor(1, compression);
  const receiver = transportFor(2, compression);
  await sender.start();
  await receiver.start();
  sender.register({ id: 2, host: '127.0.0.1', port: receiver.getBoundPort() });
  if (bothWays) receiver.register({ id: 1, host: '127.0.0.1', port: sender.getBoundPort() });

  const seen: number[] = [];
  receiver.on('message', (msg: RaftMessage) => {
    seen.push(Number(msg.index));
  });

  await waitFor(() => sender.getConnectedPeers().length === 1, 'the sender to reach its peer');
  // Both dials have to have happened before anything is sent: a frame handed to a
  // connection that is about to be superseded is a different question from the
  // one these cases ask.
  await waitFor(() => !bothWays || receiver.getConnectedPeers().length === 1, 'both dials to be made');
  await sleep(200);

  await sender.send(1, [message(1, 2, 1, SLOW_BYTES)]);
  for (let index = 2; index <= COUNT; index += 1) {
    await sender.send(1, [message(1, 2, index, QUEUED_BYTES)]);
  }

  // One late frame is the symptom under test, so wait for the count or give the
  // stream time to go quiet before deciding.
  await waitFor(() => seen.length >= COUNT, `${COUNT} frames to arrive`, 30_000).catch(() => undefined);
  await sleep(300);
  await sender.stop();
  await receiver.stop();
  return seen;
}

const SUBMISSION_ORDER = Array.from({ length: COUNT }, (_, i) => i + 1);

beforeAll(() => {
  certs = generateClusterCerts(2);
});

afterAll(async () => {
  for (const transport of transports) await transport.stop();
});

describe('RaftTcpTransport — frame order', () => {
  it('O1: a slow frame is not overtaken by the frames queued behind it', async () => {
    expect(await burst({ compression: COMPRESSED, bothWays: false })).toEqual(SUBMISSION_ORDER);
  }, 180_000);

  it('O2: no frame is delivered twice', async () => {
    const seen = await burst({ compression: COMPRESSED, bothWays: false });
    // Order is O1's question; this one is the count. The run that produced the
    // inversion also produced 91 arrivals for 40 frames sent, because a frame
    // re-buffered after a failed flush had already been written once.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(COUNT);
  }, 180_000);

  it('O3: order holds when both peers dial, which is the shape a cluster runs in', async () => {
    expect(await burst({ compression: COMPRESSED, bothWays: true })).toEqual(SUBMISSION_ORDER);
  }, 180_000);

  it('O4: with compression off the order is the submission order as well', async () => {
    expect(await burst({ compression: PLAIN, bothWays: false })).toEqual(SUBMISSION_ORDER);
  }, 180_000);
});
