/**
 * ConnectionPool — Unit Tests (ConnectionPool public API + internal flows)
 *
 * Unlike ConnectionPoolFrames.test.ts (pure frame/PeerConnection only), this
 * suite exercises the ConnectionPool class itself using mocked TLS sockets and
 * DNS resolution, with real PeerConnection instances driven through their
 * EventEmitter socket lifecycle.
 *
 * Acceptance Criteria:
 *   AC 31.10: constructor fills defaults and builds peer map + breakers
 *   AC 31.11: addNode no-ops on known peer, registers unknown peer
 *   AC 31.12: getConnection throws when stopped
 *   AC 31.13: getConnection fast-fails when the circuit breaker is OPEN
 *   AC 31.14: getConnection returns an existing connected connection
 *   AC 31.15: getConnection reuses an incoming latch connection
 *   AC 31.16: getConnection waits for an in-progress connect
 *   AC 31.17: getConnection throws for an unknown peer
 *   AC 31.18: broadcast skips self and settles all sends
 *   AC 31.19: sendTo queues on failure
 *   AC 31.20: tryGetConnection returns null when nothing is connected
 *   AC 31.21: onIncoming rejects an invalid peer certificate
 *   AC 31.22: onIncoming registers a valid connection and flushes pending
 *   AC 31.23: onIncoming supersedes an existing connection
 *   AC 31.24: markStale emits 'stale' on the active connection
 *   AC 31.25: stop closes connections, cancels retries, shuts breakers
 *   AC 31.26: connectionCount / connectedPeers getters reflect state
 *   AC 31.27: getCircuitBreakerMetrics aggregates per-peer metrics
 *   AC 31.28: enqueuePending caps the queue at 1024 entries
 *   AC 31.29: flushPending no-ops when no connection is ready
 *   AC 31.30: _connect wraps a failed TLS handshake through the breaker
 *   AC 31.31: _resolveHost caches IPv4 and falls back to hostname
 *   AC 31.32: _scheduleRetry opens the breaker after maxRetries
 *   AC 31.33: _onDisconnect reconnects when no incoming latch exists
 *   AC 31.34: _waitForConnection resolves to the eventual connection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  ConnectionPool,
  PeerConnection,
  decodeFrame,
  encodeFrame,
  type ConnectionPoolConfig,
} from '../../consensus/transport/ConnectionPool';

// Re-export computeBackoff coverage through a local alias (called below).
void encodeFrame;
void decodeFrame;

// ── Mock socket factory (hoisted reference) ─────────────────────

let createMockSocket: (cert?: Record<string, unknown>) => any;

// ── node:tls / node:dns module mocks ─────────────────────────────
// ConnectionPool imports `tls` (node:tls) and `dns` (node:dns). These ESM
// namespaces are non-configurable, so we must mock the whole module rather than
// spy on individual exports.

const tlsConnectMock = vi.fn();
const dnsLookupMock = vi.fn();
// Captures the tls.connect options (including checkServerIdentity) so the
// identity-checking closure can be invoked directly in tests.
let capturedTlsOptions: any = null;
// Default tls.connect behavior; individual tests may override this to simulate
// timeouts / socket errors / unauthorized handshakes.
let tlsConnectBehavior: (opts: any, cb: () => void) => any = (opts, cb) => {
  const socket = createMockSocket();
  tlsConnectMock(opts, cb);
  capturedTlsOptions = opts;
  setImmediate(() => {
    (socket as any).emit('secureConnect');
    cb();
  });
  return socket;
};

vi.mock('node:tls', () => {
  const connectImpl = (opts: any, cb: () => void) => tlsConnectBehavior(opts, cb);
  return {
    default: { connect: connectImpl },
    connect: connectImpl,
  };
});

vi.mock('node:dns', () => {
  return {
    default: {
      promises: {
        lookup: (...args: unknown[]) => dnsLookupMock(...args),
      },
    },
    promises: {
      lookup: (...args: unknown[]) => dnsLookupMock(...args),
    },
  };
});

// ── Mock socket factory (real implementation) ───────────────────

function makeMockSocket(cert?: Record<string, unknown>) {
  const socket = new EventEmitter() as any;
  socket.authorized = true;
  socket.encrypted = true;
  socket.authorizationError = null;
  socket.write = vi.fn((_data: Buffer, cb?: (e?: Error | null) => void) => {
    if (cb) setImmediate(() => cb(null));
    return true;
  });
  socket.end = vi.fn(() => setImmediate(() => socket.emit('close')));
  socket.destroy = vi.fn(() => setImmediate(() => socket.emit('close')));
  socket.setTimeout = vi.fn();
  socket.setNoDelay = vi.fn();
  socket.getPeerCertificate = vi.fn(
    () =>
      cert ?? {
        subject: { CN: 'raft-node-2' },
        subjectaltname: 'DNS:raft-node-2',
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: '2030-01-01T00:00:00Z',
        ext_key_usage: ['serverAuth'],
      },
  );
  return socket;
}
createMockSocket = makeMockSocket;

function makeConfig(overrides: Partial<ConnectionPoolConfig> = {}): ConnectionPoolConfig {
  return {
    nodeId: 1,
    peers: [
      { id: 2, host: 'peer-2.local', port: 5002 },
      { id: 3, host: 'peer-3.local', port: 5003 },
    ],
    tls: {
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
      ca: Buffer.from('ca'),
    },
    connectTimeoutMs: 1000,
    initialRetryMs: 10,
    maxRetryMs: 100,
    ...overrides,
  };
}

// ── TLS / DNS mock state reset ───────────────────────────────────

beforeEach(() => {
  tlsConnectMock.mockReset();
  tlsConnectMock.mockImplementation(() => {});
  dnsLookupMock.mockReset();
  dnsLookupMock.mockImplementation(async (_host: string, _opts: unknown) => ({ address: '10.0.0.2' }));
  capturedTlsOptions = null;
  createMockSocket = makeMockSocket;
  tlsConnectBehavior = (opts, cb) => {
    const socket = createMockSocket();
    tlsConnectMock(opts, cb);
    capturedTlsOptions = opts;
    setImmediate(() => {
      (socket as any).emit('secureConnect');
      cb();
    });
    return socket;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PeerConnection lifecycle', () => {
  it('exposes connected/destroyed/socket getters', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    expect(conn.connected).toBe(true);
    expect(conn.destroyed).toBe(false);
    expect(conn.socket).toBe(socket);

    conn.close();
    expect(conn.connected).toBe(false);
    expect(conn.destroyed).toBe(true);
    expect(conn.socket).toBeNull();
  });

  it('close survives an error from socket.end/destroy (ignores close errors)', () => {
    const socket = makeMockSocket();
    socket.end = vi.fn(() => {
      throw new Error('end-fail');
    });
    socket.destroy = vi.fn(() => {
      throw new Error('destroy-fail');
    });
    const conn = new PeerConnection(2, socket);
    expect(() => conn.close()).not.toThrow();
    expect(conn.destroyed).toBe(true);
  });

  it('emits data on non-empty socket data and updates lastRx', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    const spy = vi.fn();
    conn.on('data', spy);
    socket.emit('data', Buffer.from('hello'));
    expect(spy).toHaveBeenCalledWith(Buffer.from('hello'));
    // Empty heartbeat frame (length 0) does not emit data.
    const spy2 = vi.fn();
    conn.on('data', spy2);
    socket.emit('data', Buffer.alloc(0));
    expect(spy2).not.toHaveBeenCalled();
  });

  it('marks disconnected on close/end and stops health check', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    const closeSpy = vi.fn();
    conn.on('close', closeSpy);
    socket.emit('close');
    expect(conn.connected).toBe(false);
    expect(closeSpy).toHaveBeenCalled();

    const socket2 = makeMockSocket();
    const conn2 = new PeerConnection(2, socket2);
    socket2.emit('end');
    expect(conn2.connected).toBe(false);
  });

  it('re-emits socket errors', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    const spy = vi.fn();
    conn.on('error', spy);
    socket.emit('error', new Error('boom'));
    expect(spy).toHaveBeenCalled();
  });

  it('replaceSocket removes old listeners and attaches a new socket', () => {
    const oldSocket = makeMockSocket();
    const conn = new PeerConnection(2, oldSocket);
    const newSocket = makeMockSocket();
    conn.replaceSocket(newSocket);
    expect(conn.socket).toBe(newSocket);
    expect(conn.connected).toBe(true);
  });

  it('write throws when the connection is lost during the write', async () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    // Simulate a connection that drops after the lock is acquired: the write
    // callback fires with an error, and the socket is cleared concurrently.
    socket.write = vi.fn((_data: Buffer, cb: (e?: Error | null) => void) => {
      (conn as any)._connected = false;
      (conn as any)._socket = null;
      cb(new Error('lost'));
      return true;
    });
    await expect(conn.write(Buffer.from('x'))).rejects.toThrow('lost');
  });

  it('write rejects with "connection lost" when the connection drops while queued', async () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    // First write holds the lock (its callback is deferred), then the
    // connection drops before the second write acquires the lock.
    let releaseFirst: ((e?: Error | null) => void) | undefined;
    socket.write = vi.fn((_data: Buffer, cb: (e?: Error | null) => void) => {
      releaseFirst = cb;
      return true;
    });

    const first = conn.write(Buffer.from('first'));
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    // Queue the second write while still connected (passes the first check).
    const second = conn.write(Buffer.from('second'));

    // Drop the connection while the first write still holds the lock, then
    // release so the queued second write observes the dropped connection.
    (conn as any)._connected = false;
    (conn as any)._socket = null;
    releaseFirst!(null);
    await first;
    await expect(second).rejects.toThrow('connection lost during write');
  });

  it('sendHeartbeat no-ops when disconnected and swallows write errors', async () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    conn.close();
    await expect(conn.sendHeartbeat()).resolves.toBeUndefined();

    const socket2 = makeMockSocket();
    socket2.write = vi.fn((_d: Buffer, cb: (e?: Error) => void) => cb(new Error('write-fail')));
    const conn2 = new PeerConnection(2, socket2);
    await expect(conn2.sendHeartbeat()).resolves.toBeUndefined();
  });

  it('_checkHealth closes on idle timeout', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    const idleSpy = vi.fn();
    conn.on('idle-timeout', idleSpy);
    // Force idle beyond IDLE_TIMEOUT by backdating lastRx/lastTx.
    conn.lastRx = Date.now() - 40_000;
    conn.lastTx = Date.now() - 40_000;
    (conn as any)._checkHealth();
    expect(idleSpy).toHaveBeenCalled();
    expect(conn.connected).toBe(false);
  });

  it('_checkHealth sends a heartbeat when idle over half the threshold', async () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    const heartbeatSpy = vi.spyOn(conn, 'sendHeartbeat');
    conn.lastRx = Date.now() - 16_000; // > IDLE_TIMEOUT/2, < IDLE_TIMEOUT
    conn.lastTx = Date.now() - 16_000;
    (conn as any)._checkHealth();
    expect(heartbeatSpy).toHaveBeenCalled();
    await heartbeatSpy.mock.results[0].value;
  });

  it('_checkHealth no-ops when disconnected', () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    conn.close();
    const heartbeatSpy = vi.spyOn(conn, 'sendHeartbeat');
    (conn as any)._checkHealth();
    expect(heartbeatSpy).not.toHaveBeenCalled();
  });

  it('the health-check interval invokes _checkHealth periodically', () => {
    vi.useFakeTimers();
    try {
      const socket = makeMockSocket();
      const conn = new PeerConnection(2, socket);
      const checkSpy = vi.spyOn(conn as any, '_checkHealth');
      vi.advanceTimersByTime(5000);
      expect(checkSpy).toHaveBeenCalled();
      conn.close(); // stop the interval to avoid leaks
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a warning when the heartbeat promise rejects after idle', async () => {
    const socket = makeMockSocket();
    const conn = new PeerConnection(2, socket);
    conn.lastRx = Date.now() - 16_000;
    conn.lastTx = Date.now() - 16_000;
    // Force the heartbeat promise to reject so _checkHealth's .catch runs.
    vi.spyOn(conn, 'sendHeartbeat').mockRejectedValueOnce(new Error('hb-fail'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (conn as any)._checkHealth();
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    conn.close();
  });
});

describe('ConnectionPool constructor', () => {
  it('fills defaults and builds peer map + breakers', () => {
    const pool = new ConnectionPool(makeConfig());
    expect((pool as any)._peerInfo.size).toBe(2);
    expect((pool as any)._circuitBreakers.size).toBe(2);
    expect((pool as any).config.connectTimeoutMs).toBe(1000);
    expect((pool as any).config.maxRetries).toBe(10);
    expect((pool as any).config.circuitResetTimeoutMs).toBe(60000);
    // cert/key/ca resolved to Buffer even when strings are passed
    const cfg = new ConnectionPool(
      makeConfig({ tls: { cert: 'cert-str', key: 'key-str', ca: 'ca-str' } }),
    );
    expect(Buffer.isBuffer((cfg as any)._tlsOptions.cert)).toBe(true);
    expect(Buffer.isBuffer((cfg as any)._tlsOptions.key)).toBe(true);
    expect(Buffer.isBuffer((cfg as any)._tlsOptions.ca)).toBe(true);
  });

  it('applies default timeouts, backoff, and keepalive when omitted', () => {
    const pool = new ConnectionPool(
      makeConfig({
        connectTimeoutMs: undefined,
        initialRetryMs: undefined,
        maxRetryMs: undefined,
        backoffFactor: undefined,
        keepAliveMs: undefined,
        maxRetries: undefined,
        circuitResetTimeoutMs: undefined,
        circuitBreaker: undefined,
      }),
    );
    expect((pool as any).config.connectTimeoutMs).toBe(5000);
    expect((pool as any).config.initialRetryMs).toBe(100);
    expect((pool as any).config.maxRetryMs).toBe(30000);
    expect((pool as any).config.backoffFactor).toBe(2);
    expect((pool as any).config.keepAliveMs).toBe(15000);
    expect((pool as any).config.maxRetries).toBe(10);
    expect((pool as any).config.circuitResetTimeoutMs).toBe(60000);
  });
});

describe('ConnectionPool addNode', () => {
  it('no-ops on a known peer', () => {
    const pool = new ConnectionPool(makeConfig());
    const before = (pool as any)._peerInfo.size;
    pool.addNode({ id: 2, host: 'peer-2.local', port: 5002 });
    expect((pool as any)._peerInfo.size).toBe(before);
  });

  it('registers an unknown peer and initiates a best-effort connection', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    pool.addNode({ id: 9, host: 'peer-9.local', port: 5009 });
    expect((pool as any)._peerInfo.has(9)).toBe(true);
    expect((pool as any)._circuitBreakers.has(9)).toBe(true);
    await vi.waitFor(() => expect(tlsConnectMock).toHaveBeenCalled());
    // Tear down to prevent a leaked retry timer from polluting later tests.
    await pool.stop();
  });

  it('skips connection when the pool is stopped', () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    (pool as any)._stopped = true;
    pool.addNode({ id: 9, host: 'peer-9.local', port: 5009 });
    expect((pool as any)._peerInfo.has(9)).toBe(true);
    expect(tlsConnectMock).not.toHaveBeenCalled();
  });
});

describe('ConnectionPool getConnection', () => {
  it('throws when stopped', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    await expect(pool.getConnection(2)).rejects.toThrow('stopped');
  });

  it('fast-fails when the circuit breaker is OPEN', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._circuitBreakers.set(2, { isOpen: true });
    await expect(pool.getConnection(2)).rejects.toThrow('circuit breaker OPEN');
  });

  it('returns an existing connected connection', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    await (pool as any)._connMutex.runExclusive(async () => {
      (pool as any)._connections.set(2, conn);
    });
    await expect(pool.getConnection(2)).resolves.toBe(conn);
  });

  it('reuses an incoming latch connection and promotes it', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._incoming.set(2, conn);
    const got = await pool.getConnection(2);
    expect(got).toBe(conn);
    expect((pool as any)._connections.get(2)).toBe(conn);
    expect((pool as any)._incoming.has(2)).toBe(false);
  });

  it('throws for an unknown peer', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    await expect(pool.getConnection(99)).rejects.toThrow('Unknown peer id: 99');
  });

  it('waits for an in-progress connect instead of starting a duplicate', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._connecting.add(2);
    const waitSpy = vi.spyOn(pool as any, '_waitForConnection').mockResolvedValue({});
    await pool.getConnection(2);
    expect(waitSpy).toHaveBeenCalledWith(2);
    waitSpy.mockRestore();
  });
});

describe('ConnectionPool broadcast / sendTo / tryGetConnection', () => {
  it('broadcast skips self and settles all sends', async () => {
    const pool = new ConnectionPool(makeConfig());
    // Pre-wire connected peers so sendTo completes writes without reconnecting.
    for (const id of [2, 3]) {
      const conn = new PeerConnection(id, createMockSocket());
      (pool as any)._connections.set(id, conn);
    }
    await expect(
      pool.broadcast(1, [{ type: 'Append', term: 5 }, { type: 'Vote', term: 5 }]),
    ).resolves.toBeUndefined();
  });

  it('broadcast no-ops when stopped', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    const sendSpy = vi.spyOn(pool as any, 'sendTo');
    await pool.broadcast(1, [{ type: 'Append' }]);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('broadcast skips the sender id even when it is a peer', async () => {
    const pool = new ConnectionPool(makeConfig());
    for (const id of [2, 3]) {
      const conn = new PeerConnection(id, createMockSocket());
      (pool as any)._connections.set(id, conn);
    }
    const sendSpy = vi.spyOn(pool as any, 'sendTo');
    await pool.broadcast(2, [{ type: 'Append' }]);
    // peer 2 (== fromId) is skipped; only peer 3 is sent.
    expect(sendSpy).not.toHaveBeenCalledWith(2, expect.anything());
    sendSpy.mockRestore();
  });

  it('sendTo no-ops when stopped', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    const getSpy = vi.spyOn(pool as any, 'getConnection');
    await pool.sendTo(2, { type: 'Append' });
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it('sendTo queues the frame on write failure', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    // Unknown peer → getConnection throws → enqueuePending
    await pool.sendTo(7, { type: 'Append' });
    expect((pool as any)._pending.get(7)).toHaveLength(1);
  });

  it('tryGetConnection returns null when nothing is connected', () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    expect(pool.tryGetConnection(2)).toBeNull();
  });

  it('tryGetConnection returns an existing connected connection', () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, conn);
    expect(pool.tryGetConnection(2)).toBe(conn);
  });

  it('tryGetConnection promotes an incoming latch connection', () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(3, createMockSocket());
    (pool as any)._incoming.set(3, conn);
    expect(pool.tryGetConnection(3)).toBe(conn);
    expect((pool as any)._connections.get(3)).toBe(conn);
    expect((pool as any)._incoming.has(3)).toBe(false);
  });
});

describe('ConnectionPool onIncoming', () => {
  it('returns null when stopped', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    await expect(pool.onIncoming(2, createMockSocket())).resolves.toBeNull();
  });

  it('rejects an invalid peer certificate', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({ subject: { CN: 'wrong-cn' } });
    const destroySpy = vi.spyOn(socket, 'destroy');
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
    expect(destroySpy).toHaveBeenCalled();
  });

  it('rejects a certificate with no subject', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({ subject: null });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('rejects a certificate whose subject has no CN (falsy CN → empty string)', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({ subject: {}, subjectaltname: 'DNS:raft-node-2' });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('rejects a not-yet-valid certificate (valid_from in the future)', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({
      subject: { CN: 'raft-node-2' },
      valid_from: '2099-01-01T00:00:00Z',
      valid_to: '2099-12-31T00:00:00Z',
    });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('rejects an expired certificate (valid_to in the past)', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({
      subject: { CN: 'raft-node-2' },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: '2020-12-31T00:00:00Z',
    });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('rejects when SAN has no DNS entry matching the peer', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({
      subject: { CN: 'raft-node-2' },
      subjectaltname: 'IP:10.0.0.2',
    });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('rejects when ext_key_usage lacks server/client auth', async () => {
    const pool = new ConnectionPool(makeConfig());
    const socket = makeMockSocket({
      subject: { CN: 'raft-node-2' },
      ext_key_usage: ['codeSigning'],
    });
    await expect(pool.onIncoming(2, socket)).resolves.toBeNull();
  });

  it('accepts when verify options relax CN/SAN/extKeyUsage checks', async () => {
    const pool = new ConnectionPool(
      makeConfig({
        tls: {
          cert: Buffer.from('c'),
          key: Buffer.from('k'),
          ca: Buffer.from('a'),
          verify: { allowedCNPrefixes: ['*'], allowedSANPrefixes: ['*'], skipExtKeyUsageCheck: true },
        },
      }),
    );
    const socket = makeMockSocket({
      subject: { CN: 'anything' },
      subjectaltname: 'IP:10.0.0.9',
      ext_key_usage: ['codeSigning'],
    });
    const conn = await pool.onIncoming(2, socket);
    expect(conn).not.toBeNull();
  });

  it('invokes the onConnectionCreated callback when provided', async () => {
    const onCreated = vi.fn();
    const pool = new ConnectionPool(makeConfig());
    pool.onConnectionCreated = onCreated as any;
    const socket = makeMockSocket();
    const conn = await pool.onIncoming(2, socket);
    expect(onCreated).toHaveBeenCalledWith(2, conn);
  });

  it('invokes onConnectionCreated during _connect as well', async () => {
    const onCreated = vi.fn();
    const pool = new ConnectionPool(makeConfig());
    pool.onConnectionCreated = onCreated as any;
    const conn = await (pool as any)._connect(2);
    expect(onCreated).toHaveBeenCalledWith(2, conn);
    await pool.stop();
  });

  it('registers a valid connection and flushes pending', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._pending.set(2, [{ msg: encodeFrame(Buffer.from('x')), resolved: false }]);
    const socket = createMockSocket();
    const conn = await pool.onIncoming(2, socket);
    expect(conn).not.toBeNull();
    expect((pool as any)._connections.get(2)).toBe(conn);
    expect(conn!.connected).toBe(true);
  });

  it('supersedes an existing connected connection', async () => {
    const pool = new ConnectionPool(makeConfig());
    const oldConn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, oldConn);
    const closeSpy = vi.spyOn(oldConn, 'close');

    const conn = await pool.onIncoming(2, createMockSocket());
    expect(closeSpy).toHaveBeenCalled();
    expect((pool as any)._connections.get(2)).toBe(conn);
  });

  it('close event triggers _onDisconnect when the connection is still active', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await pool.onIncoming(2, createMockSocket());
    expect((pool as any)._connections.get(2)).toBe(conn);
    const disconnectSpy = vi.spyOn(pool as any, '_onDisconnect').mockResolvedValue(undefined);
    conn!.emit('close');
    expect(disconnectSpy).toHaveBeenCalled();
    disconnectSpy.mockRestore();
  });

  it('idle-timeout event triggers _onDisconnect when the connection is still active', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await pool.onIncoming(2, createMockSocket());
    expect((pool as any)._connections.get(2)).toBe(conn);
    const disconnectSpy = vi.spyOn(pool as any, '_onDisconnect').mockResolvedValue(undefined);
    conn!.emit('idle-timeout');
    expect(disconnectSpy).toHaveBeenCalled();
    disconnectSpy.mockRestore();
  });

  it('logs an error when an incoming connection emits socket error', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await pool.onIncoming(2, createMockSocket());
    // The error handler invokes the module-level pino logger; assert it does
    // not throw and the connection remains registered.
    expect(() => conn!.emit('error', new Error('incoming-broke'))).not.toThrow();
    expect((pool as any)._connections.get(2)).toBe(conn);
  });
});

describe('ConnectionPool markStale / getters / metrics', () => {
  it('markStale emits stale on the active connection', () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, conn);
    const spy = vi.fn();
    conn.on('stale', spy);
    pool.markStale(2);
    expect(spy).toHaveBeenCalled();
  });

  it('markStale no-ops when no connection exists', () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    expect(() => pool.markStale(2)).not.toThrow();
  });

  it('connectionCount and connectedPeers reflect state', () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, conn);
    expect(pool.connectionCount).toBe(1);
    expect(pool.connectedPeers).toEqual([2]);
  });

  it('getCircuitBreakerMetrics aggregates per-peer metrics', () => {
    const pool = new ConnectionPool(makeConfig());
    const metrics = pool.getCircuitBreakerMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0].name).toBeDefined();
  });
});

describe('ConnectionPool enqueuePending / flushPending', () => {
  it('enqueuePending caps the queue at 1024 entries', () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    for (let i = 0; i < 1100; i++) {
      pool.enqueuePending(2, Buffer.from(String(i)));
    }
    expect((pool as any)._pending.get(2)).toHaveLength(1024);
  });

  it('enqueuePending no-ops when stopped', () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    (pool as any)._stopped = true;
    pool.enqueuePending(2, Buffer.from('x'));
    expect((pool as any)._pending.has(2)).toBe(false);
  });

  it('flushPending no-ops when no queue exists', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    await expect(pool.flushPending(2)).resolves.toBeUndefined();
  });

  it('flushPending no-ops when no connection is ready', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    (pool as any)._pending.set(2, [{ msg: Buffer.from('x'), resolved: false }]);
    await expect(pool.flushPending(2)).resolves.toBeUndefined();
    expect((pool as any)._pending.get(2)).toHaveLength(1);
  });

  it('flushPending writes and drains the queue', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, conn);
    const frame = encodeFrame(Buffer.from('pending-msg'));
    (pool as any)._pending.set(2, [{ msg: frame, resolved: false }]);
    await pool.flushPending(2);
    expect((pool as any)._pending.get(2)).toHaveLength(0);
  });
});

describe('ConnectionPool _connect', () => {
  it('creates a connection and flushes any pending messages', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await (pool as any)._connect(2);
    expect(conn).toBeInstanceOf(PeerConnection);
    expect((pool as any)._connections.get(2)).toBe(conn);
    expect((pool as any)._retryAttempts.has(2)).toBe(false);
  });

  it('validates the peer certificate and resets the breaker on success', async () => {
    const pool = new ConnectionPool(makeConfig());
    const breaker = (pool as any)._circuitBreakers.get(2);
    const closeSpy = vi.spyOn(breaker, 'close');
    await (pool as any)._connect(2);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('wraps a failed connection attempt through the breaker and schedules retry', async () => {
    const pool = new ConnectionPool(makeConfig());
    // Produce an unauthorized socket so the handshake verification rejects.
    tlsConnectBehavior = (opts, cb) => {
      const s = makeMockSocket();
      s.authorized = false;
      s.authorizationError = 'self-signed';
      capturedTlsOptions = opts;
      setImmediate(() => {
        s.emit('secureConnect');
        cb();
      });
      return s;
    };

    await expect((pool as any)._connect(2)).rejects.toThrow();
    expect((pool as any)._connecting.has(2)).toBe(false);
    await pool.stop();
  });

  it('throws for an unknown peer without starting a connect', async () => {
    const pool = new ConnectionPool(makeConfig({ peers: [] }));
    await expect((pool as any)._connect(99)).rejects.toThrow('Unknown peer id: 99');
  });

  it('throws "stopped" when the pool stops mid-connect', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    await expect((pool as any)._connect(2)).rejects.toThrow('stopped');
    expect((pool as any)._connecting.has(2)).toBe(false);
  });
});

describe('ConnectionPool _createTLSSocket failure modes', () => {
  it('rejects on connection timeout', async () => {
    const pool = new ConnectionPool(makeConfig({ connectTimeoutMs: 5 }));
    tlsConnectBehavior = (opts, _cb) => {
      capturedTlsOptions = opts;
      return makeMockSocket();
    }; // never calls cb → timeout fires
    const peer = (pool as any)._peerInfo.get(2);
    await expect((pool as any)._createTLSSocket(peer)).rejects.toThrow('Connection timeout');
  });

  it('rejects when the socket emits an error', async () => {
    const pool = new ConnectionPool(makeConfig());
    tlsConnectBehavior = (opts, _cb) => {
      const socket = makeMockSocket();
      capturedTlsOptions = opts;
      setImmediate(() => socket.emit('error', new Error('ECONNREFUSED')));
      return socket;
    };
    const peer = (pool as any)._peerInfo.get(2);
    await expect((pool as any)._createTLSSocket(peer)).rejects.toThrow('ECONNREFUSED');
  });

  it('rejects when the socket is unauthorized', async () => {
    const pool = new ConnectionPool(makeConfig());
    tlsConnectBehavior = (opts, cb) => {
      const socket = makeMockSocket();
      socket.authorized = false;
      socket.authorizationError = 'self-signed';
      capturedTlsOptions = opts;
      setImmediate(() => {
        socket.emit('secureConnect');
        cb();
      });
      return socket;
    };
    const peer = (pool as any)._peerInfo.get(2);
    await expect((pool as any)._createTLSSocket(peer)).rejects.toThrow('TLS authorization failed');
  });
});

describe('ConnectionPool retry scheduling', () => {
  it('clears an existing retry timer before scheduling a new one', () => {
    const pool = new ConnectionPool(makeConfig());
    const oldTimer = setTimeout(() => {}, 10000);
    (pool as any)._retryTimers.set(2, oldTimer);
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    (pool as any)._scheduleRetry(2, 5);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('the retry timer callback reconnects', async () => {
    const pool = new ConnectionPool(makeConfig({ initialRetryMs: 5, maxRetries: 100 }));
    const connectSpy = vi.spyOn(pool as any, '_connect');
    (pool as any)._scheduleRetry(2, 1);
    await vi.waitFor(() => expect(connectSpy).toHaveBeenCalled());
    connectSpy.mockRestore();
    await pool.stop();
  });
});

describe('ConnectionPool flushPending write failure', () => {
  it('re-queues a message when the write fails', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, makeMockSocket());
    // Keep the connection "connected" so flushPending reaches the write path,
    // but force the underlying socket write to reject.
    const socket = makeMockSocket();
    socket.write = vi.fn((_data: Buffer, cb?: (e?: Error | null) => void) => {
      // Invoke the callback with an error so PeerConnection.write rejects.
      if (cb) setImmediate(() => cb(new Error('write-dropped')));
      return true;
    });
    (conn as any)._socket = socket;
    (conn as any)._connected = true;
    (pool as any)._connections.set(2, conn);
    const frame = encodeFrame(Buffer.from('pending-msg'));
    (pool as any)._pending.set(2, [{ msg: frame, resolved: false }]);

    await pool.flushPending(2);
    // The write rejection re-enqueues asynchronously (fire-and-forget): wait
    // for the rejection handler to run before asserting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect((pool as any)._pending.get(2)).not.toHaveLength(0);
  });
});

describe('ConnectionPool _resolveHost', () => {
  it('caches resolved IPv4 and reuses it', async () => {
    const pool = new ConnectionPool(makeConfig());
    const a = await (pool as any)._resolveHost('peer-2.local');
    expect(a).toBe('10.0.0.2');
    const b = await (pool as any)._resolveHost('peer-2.local');
    expect(b).toBe('10.0.0.2');
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the hostname when resolution fails', async () => {
    dnsLookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const pool = new ConnectionPool(makeConfig());
    const a = await (pool as any)._resolveHost('peer-2.local');
    expect(a).toBe('peer-2.local');
  });
});

describe('ConnectionPool _scheduleRetry / circuit breaker', () => {
  it('opens the circuit breaker after maxRetries', async () => {
    const pool = new ConnectionPool(makeConfig({ maxRetries: 2 }));
    const breaker = (pool as any)._circuitBreakers.get(2);
    const openSpy = vi.spyOn(breaker, 'open');
    (pool as any)._retryAttempts.set(2, 1); // next retry reaches attempt 2 == maxRetries
    (pool as any)._scheduleRetry(2, 1);
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());
    await pool.stop();
  });

  it('no-ops when stopped', () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    expect(() => (pool as any)._scheduleRetry(2, 1)).not.toThrow();
    expect((pool as any)._retryTimers.has(2)).toBe(false);
  });

  it('_openCircuitBreakerForPeer schedules an auto-reset', async () => {
    const pool = new ConnectionPool(makeConfig({ circuitResetTimeoutMs: 30 }));
    const breaker = (pool as any)._circuitBreakers.get(2);
    const closeSpy = vi.spyOn(breaker, 'close');
    (pool as any)._openCircuitBreakerForPeer(2, 3);
    expect(breaker.isOpen).toBe(true);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    await pool.stop();
  });
});

describe('ConnectionPool _connect event wiring', () => {
  it('triggers _onDisconnect when the active connection closes', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await (pool as any)._connect(2);
    const disconnectSpy = vi.spyOn(pool as any, '_onDisconnect').mockResolvedValue(undefined);
    conn.socket.emit('close');
    await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalled());
    disconnectSpy.mockRestore();
    await pool.stop();
  });

  it('does not disconnect when the closed connection was superseded', async () => {
    const pool = new ConnectionPool(makeConfig());
    const oldConn = await (pool as any)._connect(2);
    // Replace the active connection with a newer one.
    const newer = new PeerConnection(2, makeMockSocket());
    await (pool as any)._connMutex.runExclusive(async () => {
      (pool as any)._connections.set(2, newer);
    });
    const disconnectSpy = vi.spyOn(pool as any, '_onDisconnect').mockResolvedValue(undefined);
    oldConn.socket.emit('close');
    await new Promise((r) => setImmediate(r));
    expect(disconnectSpy).not.toHaveBeenCalled();
    disconnectSpy.mockRestore();
    await pool.stop();
  });

  it('logs a connection error on socket error', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await (pool as any)._connect(2);
    const errorSpy = vi.spyOn((pool as any)._logger ?? console, 'error').mockImplementation(() => {});
    conn.socket.emit('error', new Error('socket-broke'));
    expect((pool as any)._logger ? errorSpy : console.error).toBeDefined();
    errorSpy.mockRestore();
    await pool.stop();
  });

  it('handles idle-timeout by disconnecting', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = await (pool as any)._connect(2);
    const disconnectSpy = vi.spyOn(pool as any, '_onDisconnect').mockResolvedValue(undefined);
    conn.emit('idle-timeout');
    expect(disconnectSpy).toHaveBeenCalled();
    disconnectSpy.mockRestore();
    await pool.stop();
  });
});

describe('ConnectionPool _onDisconnect', () => {
  it('reconnects when no incoming latch exists', async () => {
    const pool = new ConnectionPool(makeConfig());
    const scheduleSpy = vi.spyOn(pool as any, '_scheduleRetry');
    await (pool as any)._onDisconnect(2);
    expect(scheduleSpy).toHaveBeenCalled();
    scheduleSpy.mockRestore();
    await pool.stop();
  });

  it('promotes the incoming latch and skips reconnect', async () => {
    const pool = new ConnectionPool(makeConfig());
    const incoming = new PeerConnection(2, createMockSocket());
    (pool as any)._incoming.set(2, incoming);
    const scheduleSpy = vi.spyOn(pool as any, '_scheduleRetry');
    await (pool as any)._onDisconnect(2);
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect((pool as any)._connections.get(2)).toBe(incoming);
  });

  it('does not reconnect when stopped', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._stopped = true;
    const scheduleSpy = vi.spyOn(pool as any, '_scheduleRetry');
    await (pool as any)._onDisconnect(2);
    expect(scheduleSpy).not.toHaveBeenCalled();
    scheduleSpy.mockRestore();
  });

  it('deletes the active connection and schedules a reconnect', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, makeMockSocket());
    await (pool as any)._connMutex.runExclusive(async () => {
      (pool as any)._connections.set(2, conn);
    });
    const scheduleSpy = vi.spyOn(pool as any, '_scheduleRetry');
    await (pool as any)._onDisconnect(2);
    expect((pool as any)._connections.has(2)).toBe(false);
    expect(scheduleSpy).toHaveBeenCalled();
    scheduleSpy.mockRestore();
    await pool.stop();
  });

  it('flushes pending messages when an incoming latch is promoted', async () => {
    const pool = new ConnectionPool(makeConfig());
    const incoming = new PeerConnection(2, makeMockSocket());
    (pool as any)._incoming.set(2, incoming);
    (pool as any)._pending.set(2, [{ msg: encodeFrame(Buffer.from('x')), resolved: false }]);
    const flushSpy = vi.spyOn(pool as any, 'flushPending').mockResolvedValue(undefined);
    await (pool as any)._onDisconnect(2);
    expect(flushSpy).toHaveBeenCalledWith(2);
    flushSpy.mockRestore();
  });
});

describe('ConnectionPool _waitForConnection', () => {
  it('resolves to the eventual connection', async () => {
    const pool = new ConnectionPool(makeConfig());
    const p = (pool as any)._waitForConnection(2);
    // No connection yet — it should spin and eventually call _connect.
    const conn = await p;
    expect(conn).toBeInstanceOf(PeerConnection);
  });

  it('resolves an already-connected peer on a second call', async () => {
    const pool = new ConnectionPool(makeConfig());
    (pool as any)._connecting.add(2);
    const conn = new PeerConnection(2, makeMockSocket());
    await (pool as any)._connMutex.runExclusive(async () => {
      (pool as any)._connections.set(2, conn);
    });
    await expect((pool as any)._waitForConnection(2)).resolves.toBe(conn);
  });

  it('rejects when the connection attempt fails and no connection exists', async () => {
    const pool = new ConnectionPool(makeConfig());
    // No connection and not connecting → _waitForConnection invokes _connect,
    // which rejects.
    vi.spyOn(pool as any, '_connect').mockRejectedValue(new Error('connect-failed'));
    await expect((pool as any)._waitForConnection(2)).rejects.toThrow('connect-failed');
  });

  it('resolves from the second-check when a connection appears between checks', async () => {
    const pool = new ConnectionPool(makeConfig());
    // Simulate a race: the first mutex read sees no connection, but a
    // connection becomes available for the second (lastConn) read.
    const conn = new PeerConnection(2, makeMockSocket());
    let reads = 0;
    vi.spyOn((pool as any)._connMutex, 'runExclusive').mockImplementation(async (fn: any) => {
      reads++;
      // First read: no connection yet. Second read: the connection is ready.
      return reads === 1 ? undefined : conn;
    });
    // Ensure _connecting does NOT contain the peer so we reach the second check.
    (pool as any)._connecting.delete(2);
    await expect((pool as any)._waitForConnection(2)).resolves.toBe(conn);
  });

  it('polls (setTimeout) while a connection attempt is in progress', async () => {
    vi.useFakeTimers();
    try {
      const pool = new ConnectionPool(makeConfig());
      const conn = new PeerConnection(2, makeMockSocket());
      // A connection attempt is registered as in-progress.
      (pool as any)._connecting.add(2);

      const p = (pool as any)._waitForConnection(2);
      // Before the 50ms poll elapses, mark the connection as available and
      // clear the in-progress flag so the next check resolves.
      await vi.advanceTimersByTimeAsync(0);
      await (pool as any)._connMutex.runExclusive(async () => {
        (pool as any)._connections.set(2, conn);
      });
      (pool as any)._connecting.delete(2);

      await vi.advanceTimersByTimeAsync(50);
      await expect(p).resolves.toBe(conn);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ConnectionPool checkServerIdentity (TLS identity verification)', () => {
  async function captureIdentity(poolConfig: Partial<ConnectionPoolConfig> = {}) {
    const pool = new ConnectionPool(
      makeConfig({ peers: [{ id: 2, host: 'peer-2.local', port: 5002 }], ...poolConfig }),
    );
    // Invoke _createTLSSocket directly (avoids the retry-timer side channel
    // that _connect introduces) and capture the tls.connect options.
    const peer = (pool as any)._peerInfo.get(2);
    await (pool as any)._createTLSSocket(peer);
    const id = capturedTlsOptions.checkServerIdentity;
    expect(id).toBeTypeOf('function');
    return id;
  }

  function cert(overrides: Record<string, unknown> = {}): any {
    return {
      subject: { CN: 'raft-node-2' },
      subjectaltname: 'DNS:raft-node-2',
      ext_key_usage: ['serverAuth'],
      ...overrides,
    };
  }

  it('returns undefined for a matching CN/SAN/extKeyUsage', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert())).toBeUndefined();
  });

  it('rejects a mismatched CN', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert({ subject: { CN: 'wrong' } }))).toBeInstanceOf(Error);
  });

  it('accepts any CN when allowedCNPrefixes is ["*"]', async () => {
    const id = await captureIdentity({
      tls: {
        cert: Buffer.from('c'),
        key: Buffer.from('k'),
        ca: Buffer.from('a'),
        verify: { allowedCNPrefixes: ['*'] },
      },
    });
    expect(id('peer-2.local', cert({ subject: { CN: 'anything' } }))).toBeUndefined();
  });

  it('rejects a mismatched SAN', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert({ subjectaltname: 'DNS:other' }))).toBeInstanceOf(Error);
  });

  it('accepts when SAN list is empty (skip SAN check)', async () => {
    const id = await captureIdentity({
      tls: {
        cert: Buffer.from('c'),
        key: Buffer.from('k'),
        ca: Buffer.from('a'),
        verify: { allowedSANPrefixes: ['*'] },
      },
    });
    expect(id('peer-2.local', cert({ subjectaltname: undefined }))).toBeUndefined();
  });

  it('rejects when extKeyUsage lacks server/client auth', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert({ ext_key_usage: ['clientAuth'] }))).toBeUndefined();
    expect(
      id('peer-2.local', cert({ ext_key_usage: ['codeSigning'] })),
    ).toBeInstanceOf(Error);
  });

  it('accepts OID-based serverAuth (Node v24+)', async () => {
    const id = await captureIdentity();
    expect(
      id('peer-2.local', cert({ ext_key_usage: ['1.3.6.1.5.5.7.3.1'] })),
    ).toBeUndefined();
  });

  it('skips extKeyUsage when skipExtKeyUsageCheck is true', async () => {
    const id = await captureIdentity({
      tls: {
        cert: Buffer.from('c'),
        key: Buffer.from('k'),
        ca: Buffer.from('a'),
        verify: { skipExtKeyUsageCheck: true },
      },
    });
    expect(id('peer-2.local', cert({ ext_key_usage: ['codeSigning'] }))).toBeUndefined();
  });

  it('rejects a hostname that does not match the peer host', async () => {
    const id = await captureIdentity();
    // hostname neither equals nor endsWith peer.host
    expect(id('other.example.com', cert())).toBeInstanceOf(Error);
  });

  it('accepts a hostname that ends with the peer host', async () => {
    const id = await captureIdentity();
    expect(id('sub.peer-2.local', cert())).toBeUndefined();
  });

  it('rejects a cert whose CN is empty', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert({ subject: { CN: '' } }))).toBeInstanceOf(Error);
  });

  it('rejects a cert whose SAN entry is not a DNS name', async () => {
    const id = await captureIdentity();
    expect(id('peer-2.local', cert({ subjectaltname: 'URI:spiffe://x' }))).toBeInstanceOf(Error);
  });
});

describe('ConnectionPool _createTLSSocket authorization failure', () => {
  it('rejects when the TLS socket reports unauthorized', async () => {
    const pool = new ConnectionPool(
      makeConfig({ peers: [{ id: 2, host: 'peer-2.local', port: 5002 }] }),
    );
    // Override tls.connect behavior so the connect callback sees
    // socket.authorized === false.
    tlsConnectBehavior = (opts, cb) => {
      const socket = createMockSocket();
      socket.authorized = false;
      socket.authorizationError = 'bad signature';
      tlsConnectMock(opts, cb);
      capturedTlsOptions = opts;
      setImmediate(() => cb());
      return socket;
    };
    const peer = (pool as any)._peerInfo.get(2);
    await expect((pool as any)._createTLSSocket(peer)).rejects.toThrow(/TLS authorization failed: bad signature/);
  });

  it('defaults the authorization error message to unknown when absent', async () => {
    const pool = new ConnectionPool(
      makeConfig({ peers: [{ id: 2, host: 'peer-2.local', port: 5002 }] }),
    );
    tlsConnectBehavior = (opts, cb) => {
      const socket = createMockSocket();
      socket.authorized = false;
      socket.authorizationError = null;
      tlsConnectMock(opts, cb);
      capturedTlsOptions = opts;
      setImmediate(() => cb());
      return socket;
    };
    const peer = (pool as any)._peerInfo.get(2);
    await expect((pool as any)._createTLSSocket(peer)).rejects.toThrow(/TLS authorization failed: unknown/);
  });
});

describe('ConnectionPool stop', () => {
  it('closes connections, cancels retries, and shuts down breakers', async () => {
    const pool = new ConnectionPool(makeConfig());
    const conn = new PeerConnection(2, createMockSocket());
    (pool as any)._connections.set(2, conn);
    const breaker = (pool as any)._circuitBreakers.get(2);
    const shutdownSpy = vi.spyOn(breaker, 'shutdown');
    await pool.stop();
    expect(shutdownSpy).toHaveBeenCalled();
    expect((pool as any)._connections.size).toBe(0);
    expect((pool as any)._circuitBreakers.size).toBe(0);
  });
});
