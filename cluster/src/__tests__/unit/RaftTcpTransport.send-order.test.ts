/**
 * RaftTcpTransport — one order per peer, across every path that can write.
 *
 * Iteration 70 gave a peer a send queue and the frames it carried reached the
 * socket in submission order. The queue only ever held compressed frames: the
 * uncompressed fast path kept writing straight through, and the peer's pending
 * buffer — the one that receives frames while a connection is down — was filled
 * by that path. So a peer had *three* ways to write (chain link, direct write,
 * buffered flush) and Raft was promised one order across all of them.
 *
 * The cases here are the two crossings that were reachable:
 *
 *   AC 73.1  a compressed frame awaiting the compressor is not overtaken by a
 *            later frame that was buffered while the peer had no connection
 *   AC 73.2  a batch that failed to flush is not overtaken by a frame submitted
 *            after it, on the replacement connection
 *   AC 73.3  a write that fails on a live connection is re-buffered, not
 *            dropped, and still precedes anything newer
 *   AC 73.4  an idle peer keeps the synchronous fast path — no queue is built
 *            for a frame that has nothing to be ordered against
 *   AC 73.5  a heartbeat with a backlog behind it is dropped, not appended
 *   AC 73.6  nothing is left behind: queues drain to empty once delivered
 *   AC 73.7  a flush whose connection has gone by the time it runs puts the
 *            batch back instead of writing to a socket the pool has abandoned
 *
 * The tests drive the transport's own methods with a mocked pool and a mocked
 * TLS server, because the property under test is the order in which this class
 * issues writes — a property a real socket would report only as a flaky test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const poolInstances: any[] = [];
  const poolCtor = vi.fn(() => {
    const inst = {
      tryGetConnection: vi.fn(() => null),
      getConnection: vi.fn(async () => ({ write: vi.fn(async () => {}) })),
      onIncoming: vi.fn(async () => null),
      addNode: vi.fn(),
      removeNode: vi.fn(),
      stop: vi.fn(async () => {}),
      getCircuitBreakerMetrics: vi.fn(() => []),
      get connectedPeers() {
        return [];
      },
      onConnectionCreated: null as null | ((peerId: number, conn: any) => void),
    };
    poolInstances.push(inst);
    return inst;
  });

  const tlsState = {
    createServer: vi.fn(() => {
      const server: any = {
        on: vi.fn(),
        once: vi.fn(),
        listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
        address: vi.fn(() => ({ port: 9001 })),
        close: vi.fn((cb?: () => void) => cb?.()),
      };
      return server;
    }),
  };

  return { poolCtor, poolInstances, tlsState };
});

vi.mock('node:tls', () => ({ default: { createServer: mocks.tlsState.createServer } }));
vi.mock('../../consensus/transport/ConnectionPool', () => ({ ConnectionPool: mocks.poolCtor }));

import { RaftTcpTransport } from '../../consensus/transport/RaftTcpTransport';
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

function validConfig(overrides: any = {}): any {
  return {
    node: { id: 1, host: '127.0.0.1', port: 9001 },
    peers: [{ id: 2, host: '127.0.0.1', port: 9002 }],
    tls: {
      cert: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
      key: '-----BEGIN KEY-----\nMOCK\n-----END KEY-----',
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    },
    ...overrides,
  };
}

const priv = (t: RaftTcpTransport): any => t as any;
const freshPool = (): any => mocks.poolInstances[mocks.poolInstances.length - 1];

/** A frame in the wire shape `_sendFrame` expects: 4-byte length, then body. */
function framed(byte: number, size = 5_000): Buffer {
  const body = Buffer.alloc(size, byte);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** A connection whose writes are recorded in order, with the payload's first byte. */
function recordingConn(sink: string[]): any {
  return {
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    write: vi.fn(async (frame: Buffer) => {
      // `_sendFrame` frames carry a 4-byte header; `_doSendFrame` callers in these
      // tests hand over the body only, so record whichever is there.
      const body = frame.length >= 4 && frame.readUInt32BE(0) === frame.length - 4 ? frame.subarray(4) : frame;
      sink.push(body.toString('latin1'));
    }),
  };
}

beforeEach(() => {
  mocks.poolInstances.length = 0;
  mocks.poolCtor.mockClear();
  mocks.tlsState.createServer.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RaftTcpTransport — one order per peer', () => {
  it('AC 73.1: a compressed frame in flight is not overtaken by a frame buffered while the peer was down', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue(null);

    const written: string[] = [];
    const conn = recordingConn(written);

    // The first frame is large, so it is queued for compression — and its
    // compression is the slow one, as zstd on a busy pool is.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(priv(t)._compressor, 'compress').mockImplementation(async (...args: unknown[]) => {
      const payload = args[0] as Buffer;
      if (payload[0] === 0x41) await gate;
      return payload;
    });

    priv(t)._sendFrame(2, framed(0x41), false); // queued, compression pending
    // A small frame arrives while no connection exists. The old code took the
    // fast path here, found no connection, and buffered it — then the buffer was
    // flushed the moment the connection appeared, ahead of the frame that had
    // been submitted first and was still waiting for the compressor.
    priv(t)._sendFrame(2, framed(0x59, 16), false);

    pool.tryGetConnection.mockReturnValue(conn);
    pool.onConnectionCreated(2, conn);
    await new Promise((resolve) => setTimeout(resolve, 20));

    release();
    await vi.waitFor(() => expect(written).toHaveLength(2));

    expect(written.map((body) => body.charCodeAt(0))).toEqual([0x41, 0x59]);
    await stopWithin(t);
  });

  it('AC 73.2: a batch that failed to flush is not overtaken by a frame submitted after it', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();

    const dead = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
      write: vi.fn(async () => {
        throw new Error('socket reset');
      }),
    };
    priv(t)._pendingMessages.set(2, [Buffer.from('old')]);
    pool.tryGetConnection.mockReturnValue(dead);
    pool.onConnectionCreated(2, dead);
    // The batch goes back in the buffer and the socket is closed: the pool will
    // dial again, and the dial is what used to let a newer frame past.
    await vi.waitFor(() => expect(dead.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(priv(t)._pendingMessages.get(2)).toHaveLength(1));

    const written: string[] = [];
    const live = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(live);
    priv(t)._doSendFrame(2, Buffer.from('new'), false);
    pool.onConnectionCreated(2, live);

    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written).toEqual(['old', 'new']);
    await stopWithin(t);
  });

  it('AC 73.3: a write that fails on a live connection is re-buffered, and still precedes anything newer', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();

    const failing = {
      write: vi.fn(async () => {
        throw new Error('socket write failed');
      }),
      close: vi.fn(),
    };
    pool.tryGetConnection.mockReturnValue(failing);
    priv(t)._doSendFrame(2, Buffer.from('first'), false);

    // The frame is not lost. A failed write on a connection the pool still calls
    // live used to be a warning and a dropped frame; the peer simply never saw
    // the entry and Raft waited for an answer that could not come.
    await vi.waitFor(() => expect(priv(t)._pendingMessages.get(2) ?? []).toHaveLength(1));
    expect(priv(t)._pendingMessages.get(2)![0]!.toString()).toBe('first');

    const written: string[] = [];
    const live = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(live);
    priv(t)._doSendFrame(2, Buffer.from('second'), false);
    pool.onConnectionCreated(2, live);

    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written).toEqual(['first', 'second']);
    await stopWithin(t);
  });

  it('AC 73.4: an idle peer keeps the synchronous fast path', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._sendFrame(2, framed(0x41, 16), false);

    // Nothing was in flight, so nothing had to be ordered against: the write
    // happens before the call returns and no queue is created. A transport that
    // queued every frame to fix an ordering bug it cannot have would pay a
    // microtask per heartbeat, and heartbeat latency is liveness.
    expect(written).toHaveLength(1);
    expect(priv(t)._sendChains.size).toBe(0);
    expect(priv(t)._pendingMessages.size).toBe(0);
    await stopWithin(t);
  });

  it('AC 73.5: a heartbeat with a backlog behind it is dropped, not appended', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._pendingMessages.set(2, [Buffer.from('queued')]);
    priv(t)._doSendFrame(2, Buffer.from('beat'), true);

    // A heartbeat is state, not an event: the next one carries a newer commit
    // index, so queueing it behind a backlog buys nothing and spends the cap
    // that the entries behind it need.
    expect(priv(t)._pendingMessages.get(2)).toHaveLength(1);
    expect(written).toEqual([]);
    await stopWithin(t);
  });

  it('AC 73.6: queues drain to empty once the frames are delivered', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._pendingMessages.set(2, [Buffer.from('a'), Buffer.from('b')]);
    pool.onConnectionCreated(2, conn);
    priv(t)._sendFrame(2, framed(0x43, 16), false);

    await vi.waitFor(() => expect(written).toHaveLength(3));
    await vi.waitFor(() => expect(priv(t)._sendChains.size).toBe(0));
    expect(priv(t)._pendingMessages.size).toBe(0);
    expect(written.map((body) => body.slice(0, 1))).toEqual(['a', 'b', 'C']);
    await stopWithin(t);
  });

  it('AC 73.8: a flush that reaches the front after the transport stopped drops what it can no longer deliver', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._pendingMessages.set(2, [Buffer.from('queued')]);
    priv(t)._doSendFrame(2, Buffer.from('behind'), false);
    // The flush is a link, so it runs on a later microtask — and `stop()` can land
    // in between. There is no socket left to drain into, and the queue is Raft's to
    // re-drive, so the frames go rather than being held for a restart that may
    // never come.
    priv(t).pool = null;

    await vi.waitFor(() => expect(priv(t)._pendingMessages.has(2)).toBe(false));
    expect(written).toEqual([]);
    expect(priv(t)._flushScheduled.has(2)).toBe(false);
  });

  it('AC 73.9: a heartbeat whose write fails is dropped, not re-buffered', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const failing = {
      write: vi.fn(async () => {
        throw new Error('socket write failed');
      }),
      close: vi.fn(),
    };
    pool.tryGetConnection.mockReturnValue(failing);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    priv(t)._doSendFrame(2, Buffer.from('beat'), true);
    await vi.waitFor(() =>
      expect(warn.mock.calls.some((args: unknown[]) => String(args[0]).includes('re-buffering'))).toBe(true),
    );

    // A heartbeat is state: the next one carries a newer commit index, so putting
    // this one back would spend the cap that the entries behind it need.
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    await stopWithin(t);
  });

  it('AC 73.10: two frames behind one backlog ask for one flush, and are written in order', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const failing = {
      write: vi.fn(async () => {
        throw new Error('socket write failed');
      }),
      close: vi.fn(),
    };
    pool.tryGetConnection.mockReturnValue(failing);

    priv(t)._pendingMessages.set(2, [Buffer.from('old')]);
    priv(t)._doSendFrame(2, Buffer.from('a'), false);
    priv(t)._doSendFrame(2, Buffer.from('b'), false);

    // One flush per peer, not one per frame: a thousand frames behind a full queue
    // would otherwise add a thousand links that each find nothing to write.
    expect(priv(t)._flushScheduled.has(2)).toBe(true);
    expect(
      priv(t)
        ._pendingMessages.get(2)!
        .map((frame: Buffer) => frame.toString()),
    ).toEqual(['old', 'a', 'b']);

    const written: string[] = [];
    const live = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(live);
    await vi.waitFor(() => expect(written).toEqual(['old', 'a', 'b']));
    await stopWithin(t);
  });

  it('AC 73.11: a small frame behind a buffered backlog takes its place in the queue, not the fast path', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    // A backlog with no queue behind it: nothing is being compressed, so the only
    // thing standing between this frame and the socket is the buffer. Writing it
    // now would put it in front of a frame that was submitted first.
    priv(t)._pendingMessages.set(2, [Buffer.from('older')]);
    priv(t)._sendFrame(2, framed(0x59, 16), false);

    // Nothing on the socket yet: the frame joined the queue instead of taking the
    // fast path past the backlog.
    expect(written).toEqual([]);

    // And the backlog drains in submission order once the queue reaches it.
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written.map((body) => body.charCodeAt(0))).toEqual(['o'.charCodeAt(0), 0x59]);
    await stopWithin(t);
  });

  it('AC 73.12: a queued frame that does not need compressing is not compressed', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();
    const written: string[] = [];
    const conn = recordingConn(written);
    pool.tryGetConnection.mockReturnValue(conn);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compress = vi.spyOn(priv(t)._compressor, 'compress').mockImplementation(async (...args: unknown[]) => {
      await gate;
      return args[0] as Buffer;
    });

    priv(t)._sendFrame(2, framed(0x41), false); // over the threshold: compresses
    priv(t)._sendFrame(2, framed(0x59, 16), false); // queued for order only

    release();
    await vi.waitFor(() => expect(written).toHaveLength(2));

    // One call for one frame. The small one is in the queue because something
    // older was in flight, not because of its size; compressing it would make the
    // queue longer without making the wire smaller.
    expect(compress).toHaveBeenCalledTimes(1);
    expect(written.map((body) => body.charCodeAt(0))).toEqual([0x41, 0x59]);
    await stopWithin(t);
  });

  it('AC 73.13: without a pool the batch goes out over the socket it was handed', async () => {
    const t = new RaftTcpTransport(validConfig());
    // No `start()`: there is no pool and no other socket in existence, so the
    // connection the caller passed is the only possible destination.
    const written: string[] = [];
    const conn = recordingConn(written);
    priv(t)._pendingMessages.set(2, [Buffer.from('only')]);

    priv(t)._flushPending(2, conn);

    await vi.waitFor(() => expect(written).toEqual(['only']));
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
  });

  it('AC 73.7: a flush whose connection is gone by the time it runs puts the batch back', async () => {
    const t = new RaftTcpTransport(validConfig());
    await startWithin(t);
    const pool = freshPool();

    priv(t)._pendingMessages.set(2, [Buffer.from('kept')]);
    const abandoned = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      write: vi.fn(async () => {}),
    };
    // The pool has already replaced or dropped the socket this batch was handed
    // with. Writing to it is the one outcome that cannot be detected afterwards:
    // the kernel accepts the bytes and the peer never reads them.
    pool.tryGetConnection.mockReturnValue(null);
    pool.onConnectionCreated(2, abandoned);

    await vi.waitFor(() => expect(priv(t)._pendingMessages.get(2)).toHaveLength(1));
    expect(abandoned.write).not.toHaveBeenCalled();
    await stopWithin(t);
  });
});
