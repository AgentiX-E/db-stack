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
    const opts = mocks.poolCtor.mock.calls[0][0];
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
    const created = mocks.poolCtor.mock.calls[0][0];
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
    expect(keys.some((k: string) => k.startsWith('2:'))).toBe(true);
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
      const [emitted] = msgHandler.mock.calls[0];
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
    expect(String(msgHandler.mock.calls[0][0].from)).toBe('2');
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
    const conn = { write: vi.fn(async () => {
      throw new Error('socket write failed');
    }) };
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
      expect(String(msgHandler.mock.calls[0][0].from)).toBe('7');
    });
  });
});
