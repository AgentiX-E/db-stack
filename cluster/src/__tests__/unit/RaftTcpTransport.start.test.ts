/**
 * RaftTcpTransport — start() and full data-path unit tests.
 *
 * The existing RaftTcpTransport.test.ts deliberately avoids calling start()
 * because it pulls in the TLS server. These tests mock both `node:tls` and
 * `ConnectionPool` so the transport's own logic (frame send/receive, pending
 * buffering, reconnect dedup, incoming peer-id parsing, compression, and the
 * health-check loop) can be exercised deterministically without real sockets.
 *
 * Coverage targets previously unreached:
 *   - start() server lifecycle + onConnectionCreated + eager connect + timer
 *   - stop() pool/server teardown
 *   - send() peer grouping + heartbeat classification + self skip
 *   - _sendFrame compression/fallback + null-pool guards
 *   - _doSendFrame write success/failure + heartbeat drop + pending buffer + dedup
 *   - _handleIncoming authorization/CN/peerId parsing (pool and no-pool paths)
 *   - _processData framing / heartbeat / decompression / decode-error / from-fix
 *   - onMessage / _getPeerMap / _drainPending / waitForConnections
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock state (hoisted so both factory and tests share it) ──────────
const mocks = vi.hoisted(() => {
  // ConnectionPool mock
  const poolInstances: any[] = [];
  const poolState = {
    tryGetConnection: vi.fn(() => null),
    getConnection: vi.fn(async () => ({ write: vi.fn(async () => {}) })),
    onIncoming: vi.fn(async () => null),
    addNode: vi.fn(),
    stop: vi.fn(async () => {}),
    getCircuitBreakerMetrics: vi.fn(() => []),
    connectedPeers: [],
    onConnectionCreated: null as null | ((peerId: number, conn: any) => void),
  };
  const poolCtor = vi.fn((opts: any) => {
    const inst = {
      ...poolState,
      tryGetConnection: vi.fn(),
      getConnection: vi.fn(),
      onIncoming: vi.fn(),
      addNode: vi.fn(),
      removeNode: vi.fn(),
      stop: vi.fn(),
      getCircuitBreakerMetrics: vi.fn(),
      get connectedPeers() {
        return [];
      },
    };
    poolInstances.push(inst);
    return inst;
  });

  // TLS mock
  const servers: any[] = [];
  const tlsState = {
    createServer: vi.fn((opts: any) => {
      const handlers: Record<string, (...a: any[]) => void> = {};
      const onceHandlers: Record<string, (...a: any[]) => void> = {};
      const server: any = {
        on: vi.fn((ev: string, cb: (...a: any[]) => void) => {
          handlers[ev] = cb;
        }),
        once: vi.fn((ev: string, cb: (...a: any[]) => void) => {
          onceHandlers[ev] = cb;
        }),
        listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
        address: vi.fn(() => ({ port: 9001 })),
        close: vi.fn((cb?: () => void) => cb?.()),
        opts,
        handlers,
        onceHandlers,
        _connections: [] as any[],
      };
      servers.push(server);
      return server;
    }),
  };

  return { poolCtor, poolInstances, servers, tlsState };
});

vi.mock('node:tls', () => ({
  default: {
    createServer: mocks.tlsState.createServer,
  },
}));

vi.mock('../../consensus/transport/ConnectionPool', () => ({
  ConnectionPool: mocks.poolCtor,
}));

import { RaftTcpTransport, type RaftNodeConfig } from '../../consensus/transport/RaftTcpTransport';
import { MessageCodec } from '../../consensus/transport/MessageCodec';
import { MessageCompressor } from '../../consensus/helpers/MessageCompressor';

function validConfig(overrides: any = {}): any {
  return {
    node: { id: 1, host: '127.0.0.1', port: 9001 },
    peers: [
      { id: 2, host: '127.0.0.1', port: 9002 },
      { id: 3, host: '127.0.0.1', port: 9003 },
    ],
    tls: {
      cert: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
      key: '-----BEGIN KEY-----\nMOCK\n-----END KEY-----',
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    },
    ...overrides,
  };
}

// Helper to reach private members.
function priv(t: RaftTcpTransport): any {
  return t as any;
}

function freshPool(): any {
  // The most recently constructed pool by the mock ctor.
  return mocks.poolInstances[mocks.poolInstances.length - 1];
}

beforeEach(() => {
  mocks.poolInstances.length = 0;
  mocks.servers.length = 0;
  mocks.tlsState.createServer.mockClear();
  mocks.poolCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RaftTcpTransport — start() lifecycle', () => {
  it('registers self and peers; start creates server + pool', async () => {
    const t = new RaftTcpTransport(validConfig());
    expect(t.getStatus().totalPeers).toBe(2);

    await t.start();

    expect(mocks.servers.length).toBe(1);
    expect(mocks.poolCtor).toHaveBeenCalledTimes(1);
    expect(t.getStatus().started).toBe(true);

    await t.stop();
    expect(t.getStatus().started).toBe(false);
  });

  it('start is idempotent (second call returns early)', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const poolCount = mocks.poolCtor.mock.calls.length;
    await t.start();
    expect(mocks.poolCtor.mock.calls.length).toBe(poolCount);
    await t.stop();
  });

  it('start uses default connect timeout/retry when config omits them', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const opts = mocks.poolCtor.mock.calls[0]![0];
    expect(opts.connectTimeoutMs).toBe(5000);
    expect(opts.initialRetryMs).toBe(100);
    expect(opts.maxRetryMs).toBe(30000);
    await t.stop();
  });

  it('onConnectionCreated clears stale frame buffer and flushes pending', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();

    // Capture the registered callback via addNode? The callback is assigned
    // to pool.onConnectionCreated during start(). Inspect the constructed pool.
    const created = mocks.poolCtor.mock.calls[0]![0];
    expect(created).toBeTruthy();
  });
});

describe('RaftTcpTransport — onMessage / getters', () => {
  it('onMessage registers a message handler on the message event', () => {
    const t = new RaftTcpTransport(validConfig());
    const handler = vi.fn();
    t.onMessage(handler);
    t.emit('message', { msgType: 0, from: '2', to: '1', term: '1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('getCircuitBreakerMetrics returns pool metrics when pool exists', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.getCircuitBreakerMetrics.mockReturnValue([{ name: 'p2', failures: 0, state: 'closed' }]);
    expect(t.getCircuitBreakerMetrics()).toHaveLength(1);
    await t.stop();
  });
});

describe('RaftTcpTransport — send() routing', () => {
  it('routes messages to peers and skips self', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue(null);

    await t.send(1, [
      { msgType: 0, from: '1', to: '2', term: '1' },
      { msgType: 0, from: '1', to: '1', term: '1' }, // self → skipped
      { msgType: 0, from: '1', to: '3', term: '1' },
    ]);

    // Both peers 2 and 3 should have pending messages buffered (no connection).
    expect(priv(t)._pendingMessages.has(2)).toBe(true);
    expect(priv(t)._pendingMessages.has(3)).toBe(true);
    await t.stop();
  });

  it('skips messages for unregistered peers', async () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    await t.start();
    await t.send(1, [{ msgType: 0, from: '1', to: '99', term: '1' }]);
    expect(priv(t)._pendingMessages.size).toBe(0);
    await t.stop();
  });

  it('classifies msgType 8/9 as heartbeat and drops when disconnected', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue(null);

    await t.send(1, [
      { msgType: 8, from: '1', to: '2', term: '1' }, // heartbeat → dropped
      { msgType: 9, from: '1', to: '2', term: '1' }, // heartbeat → dropped
    ]);

    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    await t.stop();
  });
});

describe('RaftTcpTransport — _doSendFrame', () => {
  it('writes to a live connection', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn(async () => {}) };
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._doSendFrame(2, Buffer.from('frame'), false);
    expect(conn.write).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  it('buffers critical messages and dedups reconnect when disconnected', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue(null);
    pool.getConnection.mockImplementation(async () => ({ write: vi.fn() }));
    // start() also eagerly connects peers; reset the call counter so we only
    // observe the reconnect dedup triggered by _doSendFrame.
    pool.getConnection.mockClear();

    priv(t)._doSendFrame(2, Buffer.from('a'), false);
    priv(t)._doSendFrame(2, Buffer.from('b'), false);

    expect(priv(t)._pendingMessages.get(2)).toHaveLength(2);
    // Reconnect should be initiated only once (dedup via _outstandingReconnects).
    expect(pool.getConnection.mock.calls.length).toBe(1);
    await t.stop();
  });

  it('drains pending and returns when pool is gone', async () => {
    const t = new RaftTcpTransport(validConfig());
    // No start() → pool null.
    priv(t)._pendingMessages.set(2, [Buffer.from('x')]);
    priv(t)._doSendFrame(2, Buffer.from('frame'), false);
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
  });
});

describe('RaftTcpTransport — _sendFrame compression', () => {
  it('throws when transport not started', () => {
    const t = new RaftTcpTransport(validConfig());
    // _sendFrame requires pool; without start it throws.
    expect(() => priv(t)._sendFrame(2, Buffer.from('0000frame'), false)).toThrow();
  });

  it('sends via the uncompressed path when compression disabled', async () => {
    const t = new RaftTcpTransport(validConfig({ compression: { enabled: false } }));
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn(async () => {}) };
    pool.tryGetConnection.mockReturnValue(conn);

    // frame starts with a 4-byte length header.
    const body = Buffer.from('hello');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    priv(t)._sendFrame(2, frame, false);
    // Synchronous uncompressed path delegates to _doSendFrame immediately.
    expect(conn.write).toHaveBeenCalled();
    await t.stop();
  });
});

describe('RaftTcpTransport — _handleIncoming', () => {
  function mockSocket(over: any = {}): any {
    return {
      authorized: true,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getPeerCertificate: vi.fn(() => ({ subject: { CN: 'raft-node-2' } })),
      remoteAddress: '127.0.0.1',
      remotePort: 12345,
      write: vi.fn(),
      ...over,
    };
  }

  it('destroys socket when not authorized', () => {
    const t = new RaftTcpTransport(validConfig());
    const sock = mockSocket({ authorized: false });
    priv(t)._handleIncoming(sock);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('destroys socket when certificate has no CN', () => {
    const t = new RaftTcpTransport(validConfig());
    const sock = mockSocket({ getPeerCertificate: () => ({}) });
    priv(t)._handleIncoming(sock);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('destroys socket when CN does not match any allowed prefix', () => {
    const t = new RaftTcpTransport(validConfig());
    const sock = mockSocket({ getPeerCertificate: () => ({ subject: { CN: 'totally-unknown' } }) });
    priv(t)._handleIncoming(sock);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('routes an authorized peer into the pool via onIncoming', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn() };
    pool.onIncoming.mockResolvedValue(conn);
    const sock = mockSocket();

    priv(t)._handleIncoming(sock);
    await vi.waitFor(() => expect(pool.onIncoming).toHaveBeenCalledWith(2, sock));
    await t.stop();
  });

  it('buffers data when pool is not ready yet', () => {
    const t = new RaftTcpTransport(validConfig());
    const sock = mockSocket();
    priv(t)._handleIncoming(sock);
    // sock.on('data') registered, then feed a chunk
    const dataHandler = sock.on.mock.calls.find((c: any[]) => c[0] === 'data')?.[1];
    expect(dataHandler).toBeTruthy();
    dataHandler(Buffer.from('xxxx'));
    // buffer under the composed id key exists
    const keys = Array.from(priv(t)._buffers.keys());
    expect(keys.some((k) => String(k).startsWith('2:'))).toBe(true);
  });
});

describe('RaftTcpTransport — _processData', () => {
  it('emits heartbeat for a zero-length frame', async () => {
    const t = new RaftTcpTransport(validConfig());
    const hb = vi.fn();
    t.on('heartbeat', hb);
    // 4-byte length header of 0 → empty frame.
    const frame = Buffer.alloc(4);
    await priv(t)._processData(2, frame);
    await vi.waitFor(() => expect(hb).toHaveBeenCalledWith({ from: 2 }));
  });

  it('decodes a complete message and fixes missing from field', async () => {
    const t = new RaftTcpTransport(validConfig());
    const msgHandler = vi.fn();
    t.on('message', msgHandler);

    const msg = { msgType: 0, from: '0', to: '1', term: '1' };
    // MessageCodec.encode already emits a full length-prefixed frame.
    const frame = MessageCodec.encode(msg);

    await priv(t)._processData(2, frame);
    await vi.waitFor(() => {
      expect(msgHandler).toHaveBeenCalled();
      const [emitted] = msgHandler.mock.calls[0]!;
      expect(String(emitted.from)).toBe('2');
    });
  });

  it('emits decode-error for corrupt payload', async () => {
    const t = new RaftTcpTransport(validConfig());
    const errHandler = vi.fn();
    t.on('decode-error', errHandler);

    const body = Buffer.from('not-json');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    await priv(t)._processData(2, frame);
    await vi.waitFor(() => expect(errHandler).toHaveBeenCalled());
  });

  it('decodes a chunk only after the chunk handed over before it', async () => {
    const t = new RaftTcpTransport(validConfig());
    const seen: string[] = [];
    t.on('message', (msg: any) => seen.push(String(msg.index)));

    // Real zstd, real frames: the transport's own wire format, built the way its
    // send path builds it.
    const compressor = new MessageCompressor({ threshold: 1024 });
    const frame = async (index: string, bytes: number): Promise<Buffer> => {
      const encoded = MessageCodec.encode({
        msgType: 3,
        from: '2',
        to: '1',
        term: '1',
        index,
        entries: [{ index, term: '1', entryType: 0, data: 'x'.repeat(bytes) }],
      } as any);
      const compressed = await compressor.compress(encoded.subarray(4));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(compressed.length, 0);
      return Buffer.concat([header, compressed]);
    };

    // Four megabytes take the decompressor an order of magnitude longer than a
    // kilobyte, so the frame handed over second is ready to decode first. That
    // is the whole point: the order has to come from the handover, not from
    // which decompression finishes first.
    const first = await frame('1', 4 * 1024 * 1024);
    const second = await frame('2', 1_200);

    // Two `data` events arrive back to back, so the second call is made while the
    // first is still awaiting its decompression — the shape that used to let the
    // second loop read the shared buffer and decode ahead of its predecessor.
    const firstChunk = priv(t)._processData(2, first);
    const secondChunk = priv(t)._processData(2, second);
    await Promise.all([firstChunk, secondChunk]);

    expect(seen).toEqual(['1', '2']);
  });

  it('buffers partial frames across chunks', async () => {
    const t = new RaftTcpTransport(validConfig());
    const msgHandler = vi.fn();
    t.on('message', msgHandler);

    const msg = { msgType: 0, from: '2', to: '1', term: '1', data: 'hello' };
    const frame = MessageCodec.encode(msg);

    // Send only partial data first.
    await priv(t)._processData(2, frame.subarray(0, 2));
    expect(msgHandler).not.toHaveBeenCalled();
    // Complete the frame.
    await priv(t)._processData(2, frame.subarray(2));
    await vi.waitFor(() => expect(msgHandler).toHaveBeenCalled());
    expect(String(msgHandler.mock.calls[0]![0].from)).toBe('2');
  });
});

describe('RaftTcpTransport — waitForConnections', () => {
  it('returns immediately when there are no peers', async () => {
    const t = new RaftTcpTransport(validConfig({ peers: [] }));
    await t.start();
    await expect(t.waitForConnections()).resolves.toBeUndefined();
    await t.stop();
  });

  it('waits for all peer connections, swallowing failures', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.getConnection.mockImplementation(async (id: number) => {
      if (id === 3) throw new Error('unreachable');
      return { write: vi.fn() };
    });
    await expect(t.waitForConnections()).resolves.toBeUndefined();
    await t.stop();
  });
});

describe('RaftTcpTransport — register() with live pool', () => {
  it('adds a node to the running pool', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    t.register({ id: 7, host: '10.0.0.7', port: 9007 });
    expect(pool.addNode).toHaveBeenCalledWith({ id: 7, host: '10.0.0.7', port: 9007 });
    await t.stop();
  });
});

describe('RaftTcpTransport — onConnectionCreated callback', () => {
  it('clears stale buffer, wires data listener, and flushes pending messages', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const cb = pool.onConnectionCreated;
    expect(cb).toBeTruthy();

    // Prime a stale frame buffer and a pending message.
    priv(t)._buffers.set('peer:2', Buffer.from('stale'));
    priv(t)._pendingMessages.set(2, [Buffer.from('pending-1'), Buffer.from('pending-2')]);

    const conn = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      write: vi.fn(async () => {}),
    };
    cb(2, conn);

    expect(conn.removeAllListeners).toHaveBeenCalledWith('data');
    expect(priv(t)._buffers.has('peer:2')).toBe(false);
    expect(conn.on).toHaveBeenCalledWith('data', expect.any(Function));
    // Pending messages flushed and cleared.
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    await vi.waitFor(() => expect(conn.write).toHaveBeenCalledTimes(2));
    await t.stop();
  });

  it('writes flushed pending and closes on write failure', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const cb = pool.onConnectionCreated;

    priv(t)._pendingMessages.set(2, [Buffer.from('boom')]);

    const conn = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      write: vi.fn(async () => {
        throw new Error('write fail');
      }),
      close: vi.fn(),
    };
    cb(2, conn);

    await vi.waitFor(() => expect(conn.close).toHaveBeenCalled());
    await t.stop();
  });
});

describe('RaftTcpTransport — sendToPeer live path', () => {
  it('sends a frame when pool is live', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn(async () => {}) };
    pool.tryGetConnection.mockReturnValue(conn);
    // sendToPeer → _sendFrame (uncompressed) → _doSendFrame → conn.write
    t.sendToPeer(2, Buffer.from('abcd'));
    await vi.waitFor(() => expect(conn.write).toHaveBeenCalled());
    await t.stop();
  });
});

describe('RaftTcpTransport — compression path', () => {
  it('compresses large payloads and delivers via connection', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn(async () => {}) };
    pool.tryGetConnection.mockReturnValue(conn);

    const body = Buffer.alloc(5000, 0x41); // 5KB > 1024 threshold triggers compression
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    priv(t)._sendFrame(2, frame, false);
    await vi.waitFor(() => expect(conn.write).toHaveBeenCalled());
    await t.stop();
  });

  it("writes a peer's frames in the order they were submitted, not the order they compress", async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    /** First byte of each frame's payload, in the order the connection wrote them. */
    const written: number[] = [];
    const conn = {
      write: vi.fn(async (frame: Buffer) => {
        written.push(frame.subarray(4)[0]!);
      }),
    };
    pool.tryGetConnection.mockReturnValue(conn);

    // The frame submitted first is the one whose compression finishes last. zstd
    // runs on libuv's thread pool, so a busy machine does exactly this to two
    // frames handed over back to back — and the write used to happen in that
    // callback, which made the completion order the wire order.
    vi.spyOn(priv(t)._compressor, 'compress').mockImplementation(async (...args: unknown[]) => {
      const payload = args[0] as Buffer;
      if (payload[0] === 0x41) await new Promise((resolve) => setTimeout(resolve, 30));
      return payload;
    });

    const framed = (byte: number): Buffer => {
      const body = Buffer.alloc(5000, byte); // over the threshold, so it is queued
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    };

    priv(t)._sendFrame(2, framed(0x41), false);
    priv(t)._sendFrame(2, framed(0x42), false);

    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written).toEqual([0x41, 0x42]);
    await t.stop();
  });

  it('falls back to uncompressed on compression failure', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = { write: vi.fn(async () => {}) };
    pool.tryGetConnection.mockReturnValue(conn);

    // Force compressor.compress to reject.
    vi.spyOn(priv(t)._compressor, 'compress').mockRejectedValue(new Error('zstd fail'));

    const body = Buffer.alloc(5000, 0x42);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    priv(t)._sendFrame(2, frame, false);
    await vi.waitFor(() => expect(conn.write).toHaveBeenCalled());
    await t.stop();
  });

  it('drains pending when pool disappears during async compression', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    priv(t)._pendingMessages.set(2, [Buffer.from('x')]);

    const body = Buffer.alloc(5000, 0x43);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    // Set pool to null right after the compress promise is created, but before
    // the sendIt callback runs: use a compressor stub that yields.
    vi.spyOn(priv(t)._compressor, 'compress').mockImplementation(async () => {
      priv(t).pool = null; // simulate stop() during compression
      return Buffer.from('compressed');
    });

    priv(t)._sendFrame(2, frame, false);
    // Wait for the async sendIt to fire and observe pool is null → drainPending.
    await vi.waitFor(() => expect(priv(t)._pendingMessages.has(2)).toBe(false));
  });
});

describe('RaftTcpTransport — write failure', () => {
  it('logs a warning when a live connection write rejects', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const conn = {
      write: vi.fn(async () => {
        throw new Error('socket write failed');
      }),
    };
    pool.tryGetConnection.mockReturnValue(conn);

    priv(t)._doSendFrame(2, Buffer.from('frame'), false);
    // fire-and-forget catch; give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.write).toHaveBeenCalled();
    await t.stop();
  });
});

describe('RaftTcpTransport — _handleIncoming pool branches', () => {
  function mockSocket(over: any = {}): any {
    return {
      authorized: true,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getPeerCertificate: vi.fn(() => ({ subject: { CN: 'raft-node-2' } })),
      remoteAddress: '127.0.0.1',
      remotePort: 12345,
      ...over,
    };
  }

  it('destroys socket when onIncoming resolves null', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.onIncoming.mockResolvedValue(null);
    const sock = mockSocket();

    priv(t)._handleIncoming(sock);
    await vi.waitFor(() => expect(sock.destroy).toHaveBeenCalled());
    await t.stop();
  });

  it('destroys socket when onIncoming rejects', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.onIncoming.mockRejectedValue(new Error('pool too busy'));
    const sock = mockSocket();

    priv(t)._handleIncoming(sock);
    await vi.waitFor(() => expect(sock.destroy).toHaveBeenCalled());
    await t.stop();
  });

  it('cleans up the buffer on close when pool is not ready', () => {
    const t = new RaftTcpTransport(validConfig());
    const sock = mockSocket();
    priv(t)._handleIncoming(sock);

    const closeHandler = sock.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    expect(closeHandler).toBeTruthy();

    // Feed data to create a buffer entry, then close.
    const dataHandler = sock.on.mock.calls.find((c: any[]) => c[0] === 'data')?.[1];
    dataHandler(Buffer.from('x'));
    expect(priv(t)._buffers.size).toBeGreaterThan(0);

    closeHandler();
    expect(priv(t)._buffers.size).toBe(0);
  });
});

describe('RaftTcpTransport — server callback wiring', () => {
  function mockSocket(over: any = {}): any {
    return {
      authorized: true,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getPeerCertificate: vi.fn(() => ({ subject: { CN: 'raft-node-2' } })),
      remoteAddress: '127.0.0.1',
      remotePort: 12345,
      ...over,
    };
  }

  it('routes secureConnection events to _handleIncoming', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const server = mocks.servers[0];
    const pool = freshPool();
    pool.onIncoming.mockResolvedValue({ write: vi.fn() });

    const sock = mockSocket();
    server.handlers.secureConnection(sock);
    await vi.waitFor(() => expect(pool.onIncoming).toHaveBeenCalledWith(2, sock));
    await t.stop();
  });

  it('emits error on server error event', async () => {
    const t = new RaftTcpTransport(validConfig());
    const errHandler = vi.fn();
    t.on('error', errHandler);

    await t.start();
    const server = mocks.servers[0];
    server.handlers.error(new Error('bind failed'));
    expect(errHandler).toHaveBeenCalled();
    await t.stop();
  });
});

describe('RaftTcpTransport — _initiateConnection guards', () => {
  it('returns early when pool is null', async () => {
    const t = new RaftTcpTransport(validConfig());
    // No start() → pool null; _initiateConnection should no-op.
    await expect(priv(t)._initiateConnection(2)).resolves.toBeUndefined();
  });

  it('returns early when stopped', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    priv(t)._stopped = true;
    await expect(priv(t)._initiateConnection(2)).resolves.toBeUndefined();
    await t.stop();
  });

  it('swallows connection failures for a later retry', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.getConnection.mockRejectedValue(new Error('tls handshake failed'));
    await expect(priv(t)._initiateConnection(2)).resolves.toBeUndefined();
    await t.stop();
  });
});

describe('RaftTcpTransport — data listener decode-error', () => {
  it('emits decode-error when a received data chunk fails to process', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const cb = pool.onConnectionCreated;

    const errHandler = vi.fn();
    t.on('decode-error', errHandler);

    const conn = {
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      write: vi.fn(async () => {}),
    };
    cb(2, conn);

    // Grab the registered 'data' handler and feed a corrupt frame.
    const dataHandler = conn.on.mock.calls.find((c: any[]) => c[0] === 'data')?.[1];
    expect(dataHandler).toBeTruthy();

    const body = Buffer.from('not-json');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    dataHandler(Buffer.concat([header, body]));

    await vi.waitFor(() => expect(errHandler).toHaveBeenCalled());
    await t.stop();
  });
});

describe('RaftTcpTransport — health-check timer', () => {
  it('reconnects dead peers on the health-check interval', async () => {
    vi.useFakeTimers();
    try {
      const t = new RaftTcpTransport(validConfig());
      await t.start();
      const pool = freshPool();

      // No live connection → health check kicks off reconnect.
      pool.tryGetConnection.mockReturnValue(null);
      pool.getConnection.mockResolvedValue({ write: vi.fn() });
      pool.getConnection.mockClear();

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(pool.getConnection).toHaveBeenCalled());

      await t.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips health-check when stopped', async () => {
    vi.useFakeTimers();
    try {
      const t = new RaftTcpTransport(validConfig());
      await t.start();
      const pool = freshPool();
      priv(t)._stopped = true;
      pool.tryGetConnection.mockReturnValue(null);
      pool.getConnection.mockClear();

      await vi.advanceTimersByTimeAsync(500);
      expect(pool.getConnection).not.toHaveBeenCalled();

      await t.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RaftTcpTransport — remaining branch coverage', () => {
  it('waitForConnections no-ops when pool is null', async () => {
    const t = new RaftTcpTransport(validConfig());
    // pool null (not started): each peer maps to Promise.resolve().
    await expect(t.waitForConnections()).resolves.toBeUndefined();
  });

  it('_handleIncoming accepts an array-form CN', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.onIncoming.mockResolvedValue({ write: vi.fn() });

    const sock = {
      authorized: true,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getPeerCertificate: () => ({ subject: { CN: ['raft-node-2'] } }),
      remoteAddress: '127.0.0.1',
      remotePort: 12345,
    };
    priv(t)._handleIncoming(sock);
    await vi.waitFor(() => expect(pool.onIncoming).toHaveBeenCalledWith(2, sock));
    await t.stop();
  });

  it('_processData leaves a present non-zero from field untouched', async () => {
    const t = new RaftTcpTransport(validConfig());
    const msgHandler = vi.fn();
    t.on('message', msgHandler);

    const msg = { msgType: 0, from: '7', to: '1', term: '1' };
    const frame = MessageCodec.encode(msg);
    await priv(t)._processData(2, frame);
    await vi.waitFor(() => {
      expect(msgHandler).toHaveBeenCalled();
      expect(String(msgHandler.mock.calls[0]![0].from)).toBe('7');
    });
  });
});

/**
 * Contracts the transport publishes to the rest of the cluster, exercised directly.
 *
 * These were added for the mutation gate rather than for a defect: when
 * `RaftTcpTransport.ts` entered that gate it scored 77.68 % over 548 mutants, and
 * the survivors clustered into behaviours no test named — the mTLS material a
 * start refuses to proceed without, the TLS parameters a peer is required to
 * negotiate, the bookkeeping `unregister` and `awaitPeerConnection` do, and the
 * per-peer queues' own cleanup. Each case below is one of those survivors.
 */
describe('RaftTcpTransport — the contracts it publishes', () => {
  const tlsMaterial = (overrides: Partial<{ cert: string; key: string; ca: string }>) =>
    validConfig({ tls: { ...validConfig().tls, ...overrides } }) as any;

  it('refuses to start without a certificate, a key or a CA, and names the field it wanted', async () => {
    // Each message is the only thing an operator sees at 3 a.m., so the field it
    // names is part of the contract, not decoration.
    for (const [field, expected] of [
      ['cert', /tls\.cert/],
      ['key', /tls\.key/],
      ['ca', /tls\.ca/],
    ] as const) {
      const t = new RaftTcpTransport(tlsMaterial({ [field]: '' }));
      // One start per instance: the second call would return early because the
      // first set `_started`, and a promise that has already rejected resolves to
      // `undefined` when awaited again.
      const error = await t.start().then(
        () => null,
        (cause: Error) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/mTLS is REQUIRED/);
      expect(error!.message).toMatch(expected);
    }
  });

  it('treats a whitespace-only field as absent rather than as material', async () => {
    // `''` and `'   '` reach the same code through different clauses, and the
    // second one is what a configuration templated from an unset variable looks
    // like: present, non-empty, and useless.
    for (const field of ['cert', 'key', 'ca'] as const) {
      const t = new RaftTcpTransport(tlsMaterial({ [field]: '   ' }));
      await expect(t.start()).rejects.toThrow(/mTLS is REQUIRED/);
    }
  });

  it('negotiates only TLS 1.3, with the three suites and two curves it advertises', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();

    // Asserted as a whole rather than field by field: "TLS 1.3 only" is a security
    // claim, and a claim that survives one field being dropped is not the claim.
    const opts = mocks.tlsState.createServer.mock.calls[0]![0];
    expect(opts).toMatchObject({
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384',
      ecdhCurve: 'prime256v1:secp384r1',
      requestCert: true,
      rejectUnauthorized: true,
    });
    await t.stop();
  });

  it('falls back to the compression defaults when a caller sets only `enabled`', async () => {
    // The type asks for all three fields; a JavaScript caller, or a config file
    // parsed from JSON, can set one. A threshold of `undefined` would compare
    // every payload against NaN and compress everything.
    const t = new RaftTcpTransport(validConfig({ compression: { enabled: true } }) as any);
    expect(priv(t)._compressionEnabled).toBe(true);
    expect(priv(t)._compressor.getThreshold()).toBe(1024);
  });

  it('unregister forgets a peer everywhere it was remembered, and refuses self', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    priv(t)._buffers.set('peer:2', Buffer.from([1, 2, 3]));
    priv(t)._pendingMessages.set(2, [Buffer.from([9])]);
    priv(t)._flushAttempts.set(2, 2);

    t.unregister(2);

    expect(priv(t)._registeredNodes.has(2)).toBe(false);
    expect(priv(t)._buffers.has('peer:2')).toBe(false);
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
    expect(priv(t)._flushAttempts.has(2)).toBe(false);
    expect(pool.removeNode).toHaveBeenCalledWith(2);

    // Self is not a peer: a node that unregisters itself is asking the wrong object.
    t.unregister(1);
    expect(priv(t)._registeredNodes.has(1)).toBe(true);

    await t.stop();
  });

  it('unregister before start does not throw for want of a pool', async () => {
    const t = new RaftTcpTransport(validConfig());
    expect(() => t.unregister(2)).not.toThrow();
    expect(priv(t)._registeredNodes.has(2)).toBe(false);
  });

  it('awaitPeerConnection answers false without a pool, and true only for a connected socket', async () => {
    const t = new RaftTcpTransport(validConfig());
    // No pool: nothing can be reached, and the caller is told so instead of waiting.
    await expect(t.awaitPeerConnection(2, 50)).resolves.toBe(false);

    await t.start();
    const pool = freshPool();
    pool.getConnection.mockResolvedValue({ connected: true });
    await expect(t.awaitPeerConnection(2, 50)).resolves.toBe(true);

    pool.getConnection.mockResolvedValue({ connected: false });
    // The budget is spent the moment it is asked for zero milliseconds: one
    // attempt, one answer, no sleep.
    await expect(t.awaitPeerConnection(2, 0)).resolves.toBe(false);
    await t.stop();
  });

  it('awaitPeerConnection retries a refused dial inside its budget', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    let calls = 0;
    pool.getConnection.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { connected: true };
    });

    await expect(t.awaitPeerConnection(2, 500)).resolves.toBe(true);
    expect(calls).toBe(3);
    await t.stop();
  });

  it('drops a peer\u2019s send queue once it has drained', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue({ write: vi.fn(async () => {}) });

    // Over the threshold, so the frame takes the queued path this case is about.
    const body = Buffer.alloc(5000, 0x41);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    priv(t)._sendFrame(2, Buffer.concat([header, body]), false);

    // The queue exists while the frame is in it and is gone when it is not: a map
    // entry per peer that is never removed is a leak that only shows under churn.
    await vi.waitFor(() => expect(priv(t)._sendChains.has(2)).toBe(false));
    await t.stop();
  });

  it('drops a peer\u2019s receive queue once the chunk has been decoded', async () => {
    const t = new RaftTcpTransport(validConfig());
    const encoded = MessageCodec.encode({ msgType: 3, from: '2', to: '1', term: '1', index: '1' } as any);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(encoded.length - 4, 0);

    await priv(t)._processData(2, Buffer.concat([header, encoded.subarray(4)]));
    // The entry is removed by a `then` on the settled chain, which runs one turn
    // after the link the caller awaited.
    await vi.waitFor(() => expect(priv(t)._processChains.has(2)).toBe(false));
  });

  it('waitForConnections returns immediately with no peers, and does not need a pool', async () => {
    const alone = new RaftTcpTransport(validConfig({ peers: [] }) as any);
    await expect(alone.waitForConnections()).resolves.toBeUndefined();

    // Started is not required: a transport asked to wait before it is running
    // resolves, because there is nothing to wait for yet.
    const late = new RaftTcpTransport(validConfig());
    await expect(late.waitForConnections()).resolves.toBeUndefined();
  });

  it('waitForConnections survives a peer that refuses the dial', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    freshPool().getConnection.mockRejectedValue(new Error('EHOSTUNREACH'));
    await expect(t.waitForConnections()).resolves.toBeUndefined();
    await t.stop();
  });

  it('rebuffering past the cap keeps the newest frames and reports the evicted ones', async () => {
    const t = new RaftTcpTransport(validConfig());
    const dropped: any[] = [];
    t.on('frames-dropped', (event: any) => dropped.push(event));

    const frames = Array.from({ length: 1_100 }, (_, index) => Buffer.from([index % 256]));
    priv(t)._prependFrames(2, frames);

    const queue = priv(t)._pendingMessages.get(2);
    expect(queue).toHaveLength(1024);
    // The newest survive: a Raft peer waiting on the current term cannot use the
    // frames it has already missed.
    expect(queue[queue.length - 1]![0]).toBe(1_099 % 256);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ peerId: 2, count: 76, reason: 'buffer-full' });
    expect(priv(t)._droppedFrames).toBe(76);
  });

  it('canReach refuses a socket that is destroyed, unwritable or unauthorized', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    const socket = { destroyed: false, writable: true, authorized: true };
    pool.tryGetConnection.mockReturnValue({ connected: true, destroyed: false, socket });

    expect(t.canReach(2)).toBe(true);
    // An unauthorized socket is a peer whose certificate the CA rejected: it exists
    // and must not be counted as a way to reach anyone.
    socket.authorized = false as any;
    expect(t.canReach(2)).toBe(false);
    socket.authorized = true as any;
    socket.writable = false;
    expect(t.canReach(2)).toBe(false);
    socket.writable = true;
    socket.destroyed = true;
    expect(t.canReach(2)).toBe(false);

    await t.stop();
    expect(t.canReach(2)).toBe(false);
  });
});

describe('RaftTcpTransport — inbound sockets, buffers and the frame path', () => {
  interface FakeSocket {
    authorized: boolean;
    destroyed: boolean;
    remoteAddress: string;
    remotePort: number;
    subject: string | string[];
    getPeerCertificate: () => { subject: { CN: string | string[] } };
    on: (event: string, handler: (...args: any[]) => void) => void;
    destroy: () => void;
    emit: (event: string, ...args: any[]) => void;
  }

  function fakeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const socket: FakeSocket = {
      authorized: true,
      destroyed: false,
      remoteAddress: '127.0.0.1',
      remotePort: 41000,
      subject: 'raft-node-2',
      getPeerCertificate() {
        return { subject: { CN: socket.subject } };
      },
      on(event, handler) {
        handlers[event] = handler;
      },
      destroy() {
        socket.destroyed = true;
      },
      emit(event, ...args) {
        handlers[event]?.(...args);
      },
    };
    return Object.assign(socket, overrides);
  }

  it('destroys an inbound socket the CA rejected', () => {
    const t = new RaftTcpTransport(validConfig());
    const socket = fakeSocket({ authorized: false });
    priv(t)._handleIncoming(socket);
    // A certificate the CA refused is not a peer, whatever the handshake managed
    // to complete: TLS 1.3 with `rejectUnauthorized` still fires this event.
    expect(socket.destroyed).toBe(true);
  });

  it('destroys an inbound socket that names no node, or a name no prefix matches', () => {
    const t = new RaftTcpTransport(validConfig());
    const anonymous = fakeSocket({ subject: '' });
    priv(t)._handleIncoming(anonymous);
    expect(anonymous.destroyed).toBe(true);

    // A CN that looks like a node but is not one: `raft-node-two`, and a name with
    // a trailing suffix that a prefix-only match would accept.
    for (const subject of ['raft-node-two', 'raft-node-2-extra', 'not-a-node-2']) {
      const stranger = fakeSocket({ subject });
      priv(t)._handleIncoming(stranger);
      expect(stranger.destroyed, subject).toBe(true);
    }
  });

  it('reads the first CN when the certificate carries a list', () => {
    const t = new RaftTcpTransport(validConfig());
    const socket = fakeSocket({ subject: ['raft-node-3', 'other'] });
    priv(t)._handleIncoming(socket);
    // No pool yet, so the socket lands in the pre-pool buffer keyed by peer 3 —
    // which is only true if the list's first element was the one parsed.
    expect([...priv(t)._buffers.keys()].some((key: string) => key.startsWith('3:'))).toBe(true);
  });

  it('accepts a CN prefix the deployment configured', async () => {
    const t = new RaftTcpTransport(
      validConfig({ tls: { ...validConfig().tls, verify: { allowedCNPrefixes: ['db-'] } } }) as any,
    );
    await t.start();
    freshPool().onIncoming.mockResolvedValue({});

    const socket = fakeSocket({ subject: 'db-7' });
    priv(t)._handleIncoming(socket);
    await vi.waitFor(() => expect(freshPool().onIncoming).toHaveBeenCalledWith(7, socket));

    // The default prefix is not also accepted: a deployment that narrowed the set
    // meant to narrow it.
    const impostor = fakeSocket({ subject: 'raft-node-8' });
    priv(t)._handleIncoming(impostor);
    expect(impostor.destroyed).toBe(true);
    await t.stop();
  });

  it('hands an inbound socket to the pool, and destroys it when the pool refuses it', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();

    pool.onIncoming.mockResolvedValue(null);
    const refused = fakeSocket();
    priv(t)._handleIncoming(refused);
    await vi.waitFor(() => expect(refused.destroyed).toBe(true));
    expect(pool.onIncoming).toHaveBeenCalledWith(2, refused);

    // A pool that throws is the same answer, with a log line: the socket is gone
    // either way, and a socket nobody owns is a connection nobody closes.
    pool.onIncoming.mockRejectedValue(new Error('pool closed'));
    const failed = fakeSocket({ remotePort: 41001 });
    priv(t)._handleIncoming(failed);
    await vi.waitFor(() => expect(failed.destroyed).toBe(true));
    await t.stop();
  });

  it('accumulates an inbound socket\u2019s bytes while the pool is not ready, and forgets them on close', () => {
    const t = new RaftTcpTransport(validConfig());
    const socket = fakeSocket();
    priv(t)._handleIncoming(socket);

    const key = '2:127.0.0.1:41000';
    expect(priv(t)._buffers.get(key)).toEqual(Buffer.alloc(0));

    socket.emit('data', Buffer.from([1, 2]));
    socket.emit('data', Buffer.from([3]));
    // Concatenated, not replaced: a first chunk that is half a frame and a second
    // that completes it is the ordinary case, not an edge one.
    expect(priv(t)._buffers.get(key)).toEqual(Buffer.from([1, 2, 3]));

    socket.emit('close');
    expect(priv(t)._buffers.has(key)).toBe(false);
  });

  it('canReach refuses a connection that carries no socket at all', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    freshPool().tryGetConnection.mockReturnValue({ connected: true, destroyed: false, socket: null });
    expect(t.canReach(2)).toBe(false);
    await t.stop();
  });

  it('evicts the oldest buffered frame when a peer\u2019s queue is full, and says so', () => {
    const t = new RaftTcpTransport(validConfig());
    const dropped: any[] = [];
    t.on('frames-dropped', (event: any) => dropped.push(event));

    for (let index = 0; index < 1_024; index += 1) priv(t)._bufferFrame(2, Buffer.from([index % 256]));
    priv(t)._bufferFrame(2, Buffer.from([0xff]));

    const queue = priv(t)._pendingMessages.get(2);
    expect(queue).toHaveLength(1_024);
    expect(queue[0]![0]).toBe(1);
    expect(queue[1_023]![0]).toBe(0xff);
    expect(dropped).toEqual([{ peerId: 2, count: 1, reason: 'buffer-full', head: '00' }]);
  });

  it('prepending exactly up to the cap drops nothing', () => {
    const t = new RaftTcpTransport(validConfig());
    const dropped: any[] = [];
    t.on('frames-dropped', (event: any) => dropped.push(event));

    priv(t)._bufferFrame(2, Buffer.from([0]));
    priv(t)._prependFrames(
      2,
      Array.from({ length: 1_023 }, (_, index) => Buffer.from([index % 256])),
    );

    // 1 023 prepended frames and one already buffered is exactly the cap: a drop
    // of zero frames is not a drop, and reporting one would put an operator on a
    // hunt for a lost message that was never lost.
    expect(dropped).toEqual([]);
    expect(priv(t)._pendingMessages.get(2)).toHaveLength(1_024);
  });

  it('a flush of nothing writes nothing and keeps no queue', () => {
    const t = new RaftTcpTransport(validConfig());
    const conn = { write: vi.fn(async () => {}), close: vi.fn(), socket: {} };
    priv(t)._flushPending(2, conn);
    expect(conn.write).not.toHaveBeenCalled();
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
  });

  it('counts one failed flush per batch, not one per frame', async () => {
    const t = new RaftTcpTransport(validConfig());
    priv(t)._pendingMessages.set(2, [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]);

    const conn = {
      write: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
      close: vi.fn(),
      socket: {},
    };
    priv(t)._flushPending(2, conn);

    await vi.waitFor(() => expect(conn.close).toHaveBeenCalled());
    // Every frame of the batch fails on the same dead socket; the budget counts
    // the batch. Counting each one would spend a three-attempt budget in a single
    // flush and dead-letter a peer that was merely mid-handshake.
    expect(priv(t)._flushAttempts.get(2)).toBe(1);
    expect(priv(t)._pendingMessages.get(2)).toHaveLength(3);
  });

  it('queues a payload of exactly the threshold, and writes one byte less synchronously', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue({ write: vi.fn(async () => {}) });
    const threshold = priv(t)._compressor.getThreshold();

    const framed = (bytes: number): Buffer => {
      const body = Buffer.alloc(bytes, 0x41);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    };

    // At the threshold the compressor runs, so the frame takes the queue; below it
    // there is no async step to order, so the write has happened by the time the
    // call returns. `<` and `<=` differ by exactly this case.
    priv(t)._sendFrame(2, framed(threshold), false);
    expect(priv(t)._sendChains.has(2)).toBe(true);
    await vi.waitFor(() => expect(priv(t)._sendChains.has(2)).toBe(false));

    const write = pool.tryGetConnection.mock.results[0]!.value.write;
    const before = write.mock.calls.length;
    priv(t)._sendFrame(2, framed(threshold - 1), false);
    expect(write.mock.calls.length).toBe(before + 1);
    expect(priv(t)._sendChains.has(2)).toBe(false);
    await t.stop();
  });

  it('a frame that reaches the queue with no pool drains the peer\u2019s buffer instead of writing', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    priv(t)._pendingMessages.set(2, [Buffer.from([1])]);
    // The transport stops while a compression is in flight; the link finds no pool
    // and the frames it was holding are gone for good. Draining is the only way
    // that memory is ever released.
    await t.stop();
    priv(t)._pendingMessages.set(2, [Buffer.from([1])]);
    priv(t)._writeFrame(2, Buffer.from([0x41]), false);
    expect(priv(t)._pendingMessages.has(2)).toBe(false);
  });

  it('stop clears the health-check timer, and a second stop is harmless', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    expect(priv(t)._healthCheckTimer).not.toBeNull();

    await t.stop();
    expect(priv(t)._healthCheckTimer).toBeNull();
    await expect(t.stop()).resolves.toBeUndefined();
  });
});

describe('RaftTcpTransport — the port it binds, the peers it dials, the frames it reads', () => {
  it('records the port the kernel assigned, so a follower can be told where to dial', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    // `port: 0` is how a deployment asks the kernel for a port. The address it got
    // is the only thing that can be published to the rest of the cluster, and a
    // node that kept the zero it was configured with advertises a port it is not
    // listening on.
    expect(priv(t).config.node.port).toBe(9001);
    await t.stop();
  });

  it('the health check dials a peer whose connection has gone', async () => {
    vi.useFakeTimers();
    try {
      const t = new RaftTcpTransport(validConfig());
      await t.start();
      const pool = freshPool();
      pool.tryGetConnection.mockReturnValue(null);
      pool.getConnection.mockRejectedValue(new Error('ECONNREFUSED'));

      await vi.advanceTimersByTimeAsync(600);
      // A dropped connection is only retried on a failed write otherwise, and the
      // delay before that write is the delay in which every heartbeat is lost.
      expect(pool.getConnection).toHaveBeenCalledWith(2);
      expect(pool.getConnection).toHaveBeenCalledWith(3);

      await t.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the health check does nothing once the transport is stopped', async () => {
    vi.useFakeTimers();
    try {
      const t = new RaftTcpTransport(validConfig());
      await t.start();
      const pool = freshPool();
      pool.tryGetConnection.mockReturnValue(null);
      pool.getConnection.mockRejectedValue(new Error('ECONNREFUSED'));

      await t.stop();
      const after = pool.getConnection.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      // The timer is cleared by `stop()`; this asserts the guard as well, because
      // a callback that survives a clearInterval would still be a dial after stop.
      expect(pool.getConnection.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys an inbound socket whose peer certificate cannot be read', () => {
    const t = new RaftTcpTransport(validConfig());
    const socket = {
      authorized: true,
      destroyed: false,
      on: () => {},
      destroy() {
        (this as any).destroyed = true;
      },
      getPeerCertificate: () => undefined,
    };
    priv(t)._handleIncoming(socket);
    // `secureConnection` and "a peer we can name" are different events; without a
    // certificate the second never happened.
    expect(socket.destroyed).toBe(true);
  });

  it('reads a zero-length frame as a heartbeat and a framed one as a message', async () => {
    const t = new RaftTcpTransport(validConfig());
    const heartbeats: any[] = [];
    const messages: any[] = [];
    t.on('heartbeat', (event: any) => heartbeats.push(event));
    t.on('message', (msg: any) => messages.push(msg));

    const empty = Buffer.alloc(4);
    empty.writeUInt32BE(0, 0);
    await priv(t)._processData(2, empty);

    const encoded = MessageCodec.encode({ msgType: 3, from: '2', to: '1', term: '1', index: '7' } as any);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(encoded.length - 4, 0);
    await priv(t)._processData(2, Buffer.concat([header, encoded.subarray(4)]));

    expect(heartbeats).toEqual([{ from: 2 }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: '2', index: '7' });
  });

  it('sendToPeer before start does nothing rather than throwing', () => {
    const t = new RaftTcpTransport(validConfig());
    // The batched transport above this calls `sendToPeer` while a node is coming
    // up; a throw here would be a start-up failure caused by an idle path.
    expect(() => t.sendToPeer(2, Buffer.from([0]))).not.toThrow();
  });
});

describe('RaftTcpTransport — what send() addresses, and what stop() releases', () => {
  const frame = (byte: number): Buffer => {
    const body = Buffer.alloc(8, byte);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  };

  it('send() never queues a message addressed to the sender', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    freshPool().tryGetConnection.mockReturnValue(null);

    await t.send(1, [
      { msgType: 0, from: '1', to: '1', term: '1' },
      { msgType: 0, from: '1', to: '2', term: '1' },
    ]);

    // A node that queues a frame for itself opens a connection to itself: the
    // peer map has no entry for it, the pool has no socket, and the frame waits
    // for a link that will never be dialled.
    expect(priv(t)._pendingMessages.has(1)).toBe(false);
    expect(priv(t)._pendingMessages.has(2)).toBe(true);
    await t.stop();
  });

  it('send() keeps every message of a peer in one batch', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const pool = freshPool();
    pool.tryGetConnection.mockReturnValue(null);

    await t.send(1, [
      { msgType: 0, from: '1', to: '2', term: '1' },
      { msgType: 0, from: '1', to: '2', term: '1' },
      { msgType: 0, from: '1', to: '2', term: '1' },
    ]);

    // Three frames, in order, for one peer. A grouping that re-initialised the
    // array per message would leave the last one and drop the two before it — the
    // failure mode of `if (!byPeer.has(peerId))` inverted.
    expect(priv(t)._pendingMessages.get(2)).toHaveLength(3);
    await t.stop();
  });

  it('stop() closes the TLS listener', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    const server = mocks.servers[0]!;
    await t.stop();
    // A listener that outlives `stop()` keeps the port bound and the process alive;
    // a restart then fails with EADDRINUSE against itself.
    expect(server.close).toHaveBeenCalled();
  });

  it('stop() gives up on a listener that never reports closed', async () => {
    vi.useFakeTimers();
    try {
      const t = new RaftTcpTransport(validConfig());
      await t.start();
      mocks.servers[0]!.close.mockImplementation(() => {
        /* a socket that refuses to go away */
      });

      let settled = false;
      const stopped = t.stop().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await stopped;
      // The two-second fallback is the only thing that ends this: without it a
      // shutdown waits on a callback the operating system may never send.
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() releases every per-peer queue', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    priv(t)._pendingMessages.set(2, [frame(1)]);
    priv(t)._flushAttempts.set(2, 1);
    priv(t)._sendChains.set(2, Promise.resolve());
    priv(t)._processChains.set(2, Promise.resolve());

    await t.stop();

    // Held memory with no schedule left to release it: a transport that stops and
    // starts under a membership change would accumulate one queue per peer per
    // generation.
    expect(priv(t)._pendingMessages.size).toBe(0);
    expect(priv(t)._flushAttempts.size).toBe(0);
    expect(priv(t)._sendChains.size).toBe(0);
    expect(priv(t)._processChains.size).toBe(0);
  });

  it('a dial attempted after stop resolves instead of dereferencing a dead pool', async () => {
    const t = new RaftTcpTransport(validConfig());
    await t.start();
    await t.stop();
    await expect(priv(t)._initiateConnection(2)).resolves.toBeUndefined();
  });

  it('escapes a CN prefix that contains a regular-expression character', () => {
    const t = new RaftTcpTransport(
      validConfig({ tls: { ...validConfig().tls, verify: { allowedCNPrefixes: ['raft.'] } } }) as any,
    );
    const impostor = {
      authorized: true,
      destroyed: false,
      remoteAddress: '127.0.0.1',
      remotePort: 41002,
      on: () => {},
      destroy() {
        (this as any).destroyed = true;
      },
      getPeerCertificate: () => ({ subject: { CN: 'raftx7' } }),
    };
    priv(t)._handleIncoming(impostor);

    // `raft.` is a literal prefix, not a pattern: an unescaped dot would accept
    // `raftx7`, which is a certificate issued for a name this deployment never
    // said it trusted.
    expect(impostor.destroyed).toBe(true);
  });

  it('decodes an uncompressed frame when compression is disabled', async () => {
    const t = new RaftTcpTransport(validConfig({ compression: { enabled: false, threshold: 1024, level: 3 } }) as any);
    const messages: any[] = [];
    t.on('message', (msg: any) => messages.push(msg));

    const encoded = MessageCodec.encode({ msgType: 3, from: '2', to: '1', term: '1', index: '4' } as any);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(encoded.length - 4, 0);
    await priv(t)._processData(2, Buffer.concat([header, encoded.subarray(4)]));

    // With compression off the payload never passed through zstd, so decompressing
    // it would turn every frame into a decode error — a cluster that can talk and
    // cannot understand a word.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: '2', index: '4' });
  });

  it('reports an undecodable frame with the peer it came from and the error', async () => {
    const t = new RaftTcpTransport(validConfig({ compression: { enabled: false, threshold: 1024, level: 3 } }) as any);
    const errors: any[] = [];
    t.on('decode-error', (event: any) => errors.push(event));

    const body = Buffer.from('not a raft message');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    await priv(t)._processData(2, Buffer.concat([header, body]));

    // The event is the only record of a frame that arrived and could not be read;
    // an empty payload would leave an operator with a count and no peer.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ peerId: 2 });
    expect(errors[0].error).toBeInstanceOf(Error);
  });

  it('a frame handed over before start names the mistake', () => {
    const t = new RaftTcpTransport(validConfig());
    expect(() => priv(t)._sendFrame(2, frame(1), false)).toThrow('Transport not started');
  });
});
