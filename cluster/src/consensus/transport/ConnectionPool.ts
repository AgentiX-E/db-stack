/**
 * ConnectionPool — mTLS TCP connection pool for Raft peer communication
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  DEPRECATION NOTICE  ⚠️                                    ║
 * ║  This module handles Raft peer-to-peer mTLS connections, NOT   ║
 * ║  SQL/connection pool management.                               ║
 * ║                                                                  ║
 * ║  For SQL connection pooling, use:                               ║
 * ║    src/pool/ConnectionPoolWrapper.ts  (facade)                   ║
 * ║    src/pool/SqlVecConnectionPool.ts    (implementation)          ║
 * ║    src/pool/PoolModeRouter.ts          (pool mode routing)       ║
 * ║                                                                  ║
 * ║  This Raft pool module will be consolidated into                ║
 * ║  src/consensus/ in a future refactor with a unified interface.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Manages outgoing connections to Raft peers with:
 * - mTLS (TLS 1.3 with mutual certificate authentication)
 * - Exponential backoff reconnection with 30% jitter
 * - Connection health monitoring (heartbeat, idle timeout)
 *
 * It owns sockets and nothing else. Frames, buffering and the decision of what
 * to do when a peer is unreachable belong to `RaftTcpTransport`, which is the
 * only writer: the pool used to carry a second send path (`sendTo` /
 * `broadcast`, JSON-framed, with its own pending queue) that no deployment
 * called and that would have produced frames the peer's `MessageCodec` cannot
 * decode. Two ways to send is one way to be wrong about which one ran.
 *
 * Usage:
 *   const pool = new ConnectionPool(config);
 *   const conn = await pool.getConnection(peerId);
 *   conn.write(frame);                       // frame built by the transport
 *   pool.onIncoming(peerId, serverSocket);
 *   await pool.stop();
 */

import tls from 'node:tls';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Mutex } from 'async-mutex';

import { PeerCircuitBreakerWrapper, PeerCircuitBreakerOptions, CircuitBreakerMetric } from '../opt/CircuitBreaker';

import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';
const logger = pino({ level: process.env.VITEST === 'true' ? 'silent' : resolveLogLevel() });

// ──────────────────────────────────────────
//  Types & Interfaces
// ──────────────────────────────────────────

export interface PeerInfo {
  id: number;
  host: string;
  port: number;
}

export interface PeerTlsVerifyOptions {
  /** CN prefix allowlist. Verifies the certificate CN starts with any of these prefixes.
   *  Default: ["raft-node-"], validates CN === "raft-node-{peerId}".
   *  Set ["*"] or empty array to skip CN check. */
  allowedCNPrefixes?: string[];
  /** SAN DNS entry prefix allowlist. Verifies SAN contains a DNS: entry starting with this prefix.
   *  Default: ["raft-node-"], requires SAN to contain "DNS:raft-node-{peerId}". */
  allowedSANPrefixes?: string[];
  /** Whether to skip ext_key_usage check. Set true to accept certs without extKeyUsage.
   *  Node.js v24+ maps extKeyUsage OID to OID strings instead of friendly names,
   *  when false (default), matches both friendly names and OID strings. */
  skipExtKeyUsageCheck?: boolean;
}

export interface ConnectionPoolConfig {
  nodeId: number;
  peers: Array<PeerInfo>;
  tls: {
    cert: Buffer | string;
    key: Buffer | string;
    ca: Buffer | string;
    /** Certificate identity verification options (optional). Defaults to backward-compatible behavior. */
    verify?: PeerTlsVerifyOptions;
  };
  connectTimeoutMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
  backoffFactor?: number;
  keepAliveMs?: number;
  /** Circuit breaker configuration (optional). */
  circuitBreaker?: PeerCircuitBreakerOptions;
  /** Max consecutive retry attempts before opening the circuit breaker (default: 10). */
  maxRetries?: number;
  /** Time in ms before the circuit breaker auto-resets after being opened (default: 60000). */
  circuitResetTimeoutMs?: number;
}

// ──────────────────────────────────────────
//  Default constants
// ──────────────────────────────────────────

const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_INITIAL_RETRY = 100;
const DEFAULT_MAX_RETRY = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_KEEPALIVE = 15_000;
const HEALTH_CHECK_INTERVAL = 5000;
const IDLE_TIMEOUT = 30_000;

// ──────────────────────────────────────────
//  Write lock helper: ensures serialized
//  writes on a single TLSSocket
// ──────────────────────────────────────────

class WriteLock {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

// ──────────────────────────────────────────
//  PeerConnection — wraps a single TLSSocket
// ──────────────────────────────────────────

export class PeerConnection extends EventEmitter {
  public readonly peerId: number;
  public readonly connectionEpoch: number;
  public lastRx: number = 0;
  public lastTx: number = 0;

  private _socket: tls.TLSSocket | null = null;
  private _writeLock = new WriteLock();
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _destroyed = false;

  constructor(peerId: number, socket: tls.TLSSocket, epoch: number = 0) {
    super();
    this.peerId = peerId;
    this.connectionEpoch = epoch;
    this._attachSocket(socket);
  }

  // ──────────────────────────────────────
  //  Public accessors
  // ──────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get socket(): tls.TLSSocket | null {
    return this._socket;
  }

  // ──────────────────────────────────────
  //  Socket attachment
  // ──────────────────────────────────────

  private _attachSocket(socket: tls.TLSSocket): void {
    this._socket = socket;
    this._connected = true;
    this._destroyed = false;
    this.lastRx = Date.now();
    this.lastTx = Date.now();

    // Wire up data handler
    socket.on('data', (data: Buffer) => {
      this.lastRx = Date.now();
      // Heartbeat frame (length=0) has no data; just a keepalive
      if (data.length > 0) {
        this.emit('data', data);
      }
    });

    socket.on('close', () => {
      this._connected = false;
      this._socket = null;
      this._stopHealthCheck();
      this.emit('close');
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
    });

    socket.on('end', () => {
      this._connected = false;
    });

    // Start health monitoring
    this._startHealthCheck();
  }

  /**
   * Replace the underlying socket after a reconnect.
   * Preserves the peerId and event listeners, but attaches a new socket.
   */
  replaceSocket(socket: tls.TLSSocket): void {
    // Clean old socket
    if (this._socket) {
      this._socket.removeAllListeners('data');
      this._socket.removeAllListeners('close');
      this._socket.removeAllListeners('error');
      this._socket.removeAllListeners('end');
    }
    this._attachSocket(socket);
  }

  // ──────────────────────────────────────
  //  Write — serialized via lock
  // ──────────────────────────────────────

  async write(data: Buffer): Promise<void> {
    if (!this._socket || !this._connected) {
      throw new Error(`PeerConnection(${this.peerId}): not connected`);
    }
    await this._writeLock.acquire();
    try {
      if (!this._socket || !this._connected) {
        throw new Error(`PeerConnection(${this.peerId}): connection lost during write`);
      }
      return new Promise<void>((resolve, reject) => {
        this._socket!.write(data, (err?: Error | null) => {
          if (err) {
            reject(err);
          } else {
            this.lastTx = Date.now();
            resolve();
          }
        });
      });
    } finally {
      this._writeLock.release();
    }
  }

  // ──────────────────────────────────────
  //  Heartbeat (empty frame)
  // ──────────────────────────────────────

  async sendHeartbeat(): Promise<void> {
    if (!this._socket || !this._connected) return;
    // Send empty buffer as heartbeat (length=0 frame in the protocol)
    try {
      await this.write(Buffer.alloc(0));
    } catch {
      // Swallow heartbeat errors
    }
  }

  // ──────────────────────────────────────
  //  Health monitoring
  // ──────────────────────────────────────

  private _startHealthCheck(): void {
    this._stopHealthCheck();
    this._healthTimer = setInterval(() => {
      this._checkHealth();
    }, HEALTH_CHECK_INTERVAL);
  }

  private _stopHealthCheck(): void {
    if (this._healthTimer !== null) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  private _checkHealth(): void {
    if (!this._socket || !this._connected) return;

    const now = Date.now();
    const idleTime = now - Math.max(this.lastRx, this.lastTx);

    if (idleTime > IDLE_TIMEOUT) {
      // Idle too long — close connection (will trigger reconnect)
      this.emit('idle-timeout');
      this.close();
      return;
    }

    // If idle more than half the threshold, send heartbeat
    if (idleTime > IDLE_TIMEOUT / 2) {
      this.sendHeartbeat().catch((err: unknown) => {
        console.warn('[ConnectionPool] Heartbeat send failed:', err);
      });
    }
  }

  // ──────────────────────────────────────
  //  Close
  // ──────────────────────────────────────

  close(): void {
    this._stopHealthCheck();
    this._connected = false;
    this._destroyed = true;
    if (this._socket) {
      try {
        this._socket.end();
        this._socket.destroy();
      } catch {
        // Ignore close errors
      }
      this._socket = null;
    }
    this.emit('close');
  }
}

// ──────────────────────────────────────────
//  Backoff calculator
// ──────────────────────────────────────────

function computeBackoff(attempt: number, initial: number, max: number, factor: number): number {
  const base = Math.min(initial * Math.pow(factor, attempt), max);
  // 30% jitter: multiply by random [0.7, 1.3]
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.round(base * jitter);
}

// ──────────────────────────────────────────
//  Certificate validation
// ──────────────────────────────────────────

function validatePeerCert(socket: tls.TLSSocket, expectedPeerId: number, verifyOpts?: PeerTlsVerifyOptions): boolean {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.subject) return false;

  const cnPrefixes = verifyOpts?.allowedCNPrefixes?.length ? verifyOpts.allowedCNPrefixes : [`raft-node-`];
  const cnStrict = !cnPrefixes.includes('*');

  if (cnStrict) {
    const cn = cert.subject.CN || '';
    const cnMatch = cnPrefixes.some((prefix: string) => cn === `${prefix}${expectedPeerId}`);
    if (!cnMatch) return false;
  }

  // Verify certificate is not expired
  const now = new Date();
  if (cert.valid_from && new Date(cert.valid_from) > now) return false;
  if (cert.valid_to && new Date(cert.valid_to) < now) return false;

  // Check Subject Alternative Name (SAN) if present
  const sanPrefixes = verifyOpts?.allowedSANPrefixes?.length ? verifyOpts.allowedSANPrefixes : [`raft-node-`];
  const sanStrict = !sanPrefixes.includes('*');
  if (sanStrict) {
    const sans = cert.subjectaltname;
    if (sans) {
      const sanEntries = sans.split(/,\s*/);
      const sanMatch = sanEntries.some((entry: string) => {
        const trimmed = entry.trim();
        if (!trimmed.startsWith('DNS:')) return false;
        const dnsName = trimmed.slice(4);
        return sanPrefixes.some((prefix: string) => dnsName === `${prefix}${expectedPeerId}`);
      });
      if (!sanMatch) return false;
    }
  }

  // Check key usage / extended key usage
  if (cert.ext_key_usage && !verifyOpts?.skipExtKeyUsageCheck) {
    const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
    const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
    const hasServerAuth = cert.ext_key_usage.some((ku: string) => ku === 'serverAuth' || ku === OID_SERVER_AUTH);
    const hasClientAuth = cert.ext_key_usage.some((ku: string) => ku === 'clientAuth' || ku === OID_CLIENT_AUTH);
    if (!hasServerAuth && !hasClientAuth) return false;
  }

  return true;
}

// ──────────────────────────────────────────
//  ConnectionPool
// ──────────────────────────────────────────

export class ConnectionPool {
  /**
   * Optional callback invoked for every created PeerConnection (incoming or outgoing).
   * The callback can attach data/event listeners to the connection.
   * Used by RaftTcpTransport to set up _processData on both outgoing and incoming connections.
   */
  public onConnectionCreated: ((peerId: number, conn: PeerConnection) => void) | null = null;
  private config: Required<ConnectionPoolConfig>;
  /** Mutex to prevent concurrent access to the _connections map. */
  private _connMutex = new Mutex();
  private _connections: Map<number, PeerConnection> = new Map();
  private _incoming: Map<number, PeerConnection> = new Map(); // Latch for incoming
  private _retryTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private _retryAttempts: Map<number, number> = new Map();
  private _stopped = false;
  private _connecting: Set<number> = new Set(); // Currently connecting peers
  private _peerInfo: Map<number, PeerInfo> = new Map();
  /** Per-peer monotonically increasing connection epoch. Only connections with
   *  a higher epoch can replace an existing connection. */
  private _connectionEpoch: Map<number, number> = new Map();
  /** Tracks connections that have been superseded (replaced by incoming).
   *  When the old connection's close event fires, _onDisconnect checks this
   *  map and skips deletion, preventing the new connection from being removed. */
  private _supersededBy: Map<number, boolean> = new Map();

  // D3: Circuit breaker per peer
  private _circuitBreakers: Map<number, PeerCircuitBreakerWrapper> = new Map();

  // P7: DNS TTL cache — caches resolved addresses to avoid DNS lookup on every reconnect.
  // Maps hostname → { address: string, expiry: number }
  // TTL is 300 seconds (5 minutes) to balance freshness vs. lookup cost.
  private _dnsCache: Map<string, { address: string; expiry: number }> = new Map();
  private static readonly DNS_CACHE_TTL_MS = 300_000;

  private _tlsOptions: {
    cert: Buffer;
    key: Buffer;
    ca: Buffer;
  };

  constructor(config: ConnectionPoolConfig) {
    // Fill defaults
    this.config = {
      nodeId: config.nodeId,
      peers: config.peers,
      tls: config.tls,
      connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT,
      initialRetryMs: config.initialRetryMs ?? DEFAULT_INITIAL_RETRY,
      maxRetryMs: config.maxRetryMs ?? DEFAULT_MAX_RETRY,
      backoffFactor: config.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
      keepAliveMs: config.keepAliveMs ?? DEFAULT_KEEPALIVE,
      circuitBreaker: config.circuitBreaker ?? {},
      maxRetries: config.maxRetries ?? 10,
      circuitResetTimeoutMs: config.circuitResetTimeoutMs ?? 60000,
    };

    // Resolve cert/key/ca to Buffer
    this._tlsOptions = {
      cert: typeof config.tls.cert === 'string' ? Buffer.from(config.tls.cert) : config.tls.cert,
      key: typeof config.tls.key === 'string' ? Buffer.from(config.tls.key) : config.tls.key,
      ca: typeof config.tls.ca === 'string' ? Buffer.from(config.tls.ca) : config.tls.ca,
    };

    // Build peer info map
    for (const peer of config.peers) {
      this._peerInfo.set(peer.id, peer);
    }

    // D3: Initialize circuit breakers for each peer
    for (const peer of config.peers) {
      this._circuitBreakers.set(peer.id, new PeerCircuitBreakerWrapper(peer.id, this.config.circuitBreaker));
    }
  }

  // ──────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────

  /**
   * Dynamically add a peer to the connection pool, or refresh one already known.
   * Initiates an mTLS connection to the peer on best-effort basis.
   * Calling it for a known peer is idempotent but not inert: it re-arms the
   * connection when the peer has none. See the note below.
   */
  addNode(peer: PeerInfo): void {
    const known = this._peerInfo.has(peer.id);

    // Refresh rather than ignore. Re-registering a peer is how a caller says
    // "this peer should be reachable again" — the federation transport calls it
    // on every send it has to refuse. Returning early for a known peer meant a
    // channel that had lost its socket could not be re-armed by the only code
    // that knew the socket was missing, so it stayed down until the process
    // restarted. `getConnection` is a no-op when a live connection exists.
    this._peerInfo.set(peer.id, peer);

    // Create circuit breaker if not exists
    if (!this._circuitBreakers.has(peer.id)) {
      this._circuitBreakers.set(peer.id, new PeerCircuitBreakerWrapper(peer.id, this.config.circuitBreaker));
    }

    // Initiate connection (pool handles retry/backoff internally)
    if (!this._stopped) {
      this.getConnection(peer.id).catch((err: unknown) => {
        console.warn('[ConnectionPool] Init connection failed for peer', peer.id, ':', err);
      });
    }

    if (known) logger.debug(`[ConnectionPool] Re-registered peer ${peer.id} (${peer.host}:${peer.port})`);
    else logger.info(`[ConnectionPool] Added peer ${peer.id} (${peer.host}:${peer.port})`);
  }

  /**
   * Forget a peer completely: stop retrying it and close its socket.
   *
   * `addNode` alone cannot undo a peer. A removed cluster member that stayed in
   * the pool kept its retry loop, so a node that left the configuration went on
   * being dialled — and, worse, the next `addNode` of a *different* node with the
   * same id would inherit the dead peer's backoff and circuit state.
   *
   * Idempotent: removing a peer that was never added is not an error, because the
   * caller (a raft configuration change) can be retried and the pool is not the
   * authority on who is a member.
   */
  removeNode(peerId: number): void {
    const known = this._peerInfo.delete(peerId);
    const timer = this._retryTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this._retryTimers.delete(peerId);
    }
    this._retryAttempts.delete(peerId);
    this._circuitBreakers.delete(peerId);

    const connection = this._connections.get(peerId) ?? this._incoming.get(peerId);
    this._connections.delete(peerId);
    this._incoming.delete(peerId);
    try {
      connection?.close();
    } catch {
      // A socket that is already gone is the state we are asking for. This runs on
      // the membership path, where a throw would turn a successful removal into a
      // failed one.
    }

    if (known) logger.info(`[ConnectionPool] Removed peer ${peerId}`);
  }

  /**
   * Get or create a connection to the given peer.
   * If the connection is lost, it automatically reconnects
   * with exponential backoff.
   */
  async getConnection(peerId: number): Promise<PeerConnection> {
    if (this._stopped) {
      throw new Error('ConnectionPool is stopped');
    }

    // D3: Circuit breaker — fast fail if circuit is OPEN
    const cb = this._circuitBreakers.get(peerId);
    if (cb?.isOpen) {
      throw new Error(`ConnectionPool: circuit breaker OPEN for peer ${peerId} (fast fail)`);
    }

    // Check existing connection — atomic under mutex
    const existing = await this._connMutex.runExclusive(async () => {
      return this._connections.get(peerId);
    });
    if (existing && existing.connected) {
      return existing;
    }

    // If we already have an incoming connection, return it
    const incoming = this._incoming.get(peerId);
    if (incoming && incoming.connected) {
      await this._connMutex.runExclusive(async () => {
        this._connections.set(peerId, incoming);
        this._incoming.delete(peerId);
      });
      return incoming;
    }

    // Don't start a duplicate connect
    if (this._connecting.has(peerId)) {
      // Wait for the existing connection to complete
      return this._waitForConnection(peerId);
    }

    return this._connect(peerId);
  }

  /**
   * Non-blocking connection lookup. Returns null if no connection is available
   * (no outgoing, no incoming). Used by RaftTcpTransport._sendFrame to safely
   * drop Raft heartbeats when the transport is still establishing — avoids
   * blocking the WASM queue on TLS handshake.
   */
  tryGetConnection(peerId: number): PeerConnection | null {
    // Check outgoing connection
    const existing = this._connections.get(peerId);
    if (existing && existing.connected) {
      return existing;
    }
    // Check incoming latch
    const incoming = this._incoming.get(peerId);
    if (incoming && incoming.connected) {
      this._connections.set(peerId, incoming);
      this._incoming.delete(peerId);
      return incoming;
    }
    return null;
  }

  /**
   * Register an incoming connection from the TLS server.
   * The connection is already mTLS-authenticated.
   * Validates the peer certificate CN.
   */
  async onIncoming(peerId: number, socket: tls.TLSSocket): Promise<PeerConnection | null> {
    if (this._stopped) return null;

    // Validate peer certificate
    if (!validatePeerCert(socket, peerId, this.config.tls.verify)) {
      socket.destroy();
      return null;
    }

    // A pair of nodes must converge on ONE socket, and both sides must agree which.
    //
    // A node with a configured peer dials it, and every node dials every peer, so
    // both ends of a pair open a socket at the same time. Adopting the incoming
    // unconditionally and closing the outgoing meant the two ends could disagree —
    // each holding the socket the other had just closed — and a write on that
    // socket was accepted by the kernel and never delivered. A message lost that
    // way is invisible to Raft, which waits for a reply that cannot come.
    //
    // The tie-break is the node id: the higher id yields. The lower id keeps the
    // connection it opened and rejects the peer's attempt; the higher id adopts
    // the incoming one and closes its own. Both ends then hold the same socket,
    // which is bidirectional, so a reply (VoteResp and friends) travels back over
    // it — the case the old code was trying to protect by replacing.
    let existing: PeerConnection | undefined;
    await this._connMutex.runExclusive(async () => {
      existing = this._connections.get(peerId);
    });

    if (existing && existing.connected && this.config.nodeId < peerId) {
      socket.destroy();
      return null;
    }
    const newEpoch = (this._connectionEpoch.get(peerId) || 0) + 1;
    this._connectionEpoch.set(peerId, newEpoch);

    const conn = new PeerConnection(peerId, socket, newEpoch);
    await this._connMutex.runExclusive(async () => {
      this._connections.set(peerId, conn);
    });

    // Close the superseded connection (if any). Its 'close' handler detects
    // that _connections[peerId] !== this connection and does NOT trigger
    // _onDisconnect, so the new connection stays in the pool.
    if (existing && existing.connected) {
      existing.close();
    }

    // Notify RaftTcpTransport to set up data listener (bidirectional)
    this.onConnectionCreated?.(peerId, conn);

    // Wire up peer events
    conn.on('close', () => {
      if (this._connections.get(peerId) === conn) {
        this._onDisconnect(peerId);
      }
    });

    conn.on('error', (err: Error) => {
      logger.error(`[ConnectionPool] Connection error (peer ${peerId}): ${err.message}`);
    });

    conn.on('idle-timeout', () => {
      if (this._connections.get(peerId) === conn) {
        this._onDisconnect(peerId);
      }
    });

    return conn;
  }

  /**
   * Mark a connection for health check ASAP.
   */
  markStale(peerId: number): void {
    const conn = this._connections.get(peerId);
    if (conn) {
      conn.emit('stale');
    }
  }

  /**
   * Stop the pool: close all connections and cancel retries.
   */
  async stop(): Promise<void> {
    this._stopped = true;

    // Cancel all retry timers
    for (const [peerId, timer] of this._retryTimers) {
      clearTimeout(timer);
      this._retryTimers.delete(peerId);
    }

    // Close all connections — atomic under mutex
    let localConnections: Array<[number, PeerConnection]> = [];
    await this._connMutex.runExclusive(async () => {
      localConnections = [...this._connections];
      this._connections.clear();
    });
    const closePromises: Array<Promise<void>> = [];
    for (const [peerId, conn] of localConnections) {
      closePromises.push(
        new Promise<void>((resolve) => {
          conn.once('close', () => resolve());
          conn.close();
          // Timeout safety
          setTimeout(() => resolve(), 1000);
        }),
      );
    }
    await Promise.allSettled(closePromises);
    this._incoming.clear();
    this._retryAttempts.clear();
    this._connecting.clear();

    // D3: Shut down all circuit breakers
    for (const [, breaker] of this._circuitBreakers) {
      breaker.shutdown();
    }
    this._circuitBreakers.clear();
  }

  /**
   * Get current connection count (for metrics).
   */
  get connectionCount(): number {
    return this._connections.size;
  }

  /**
   * Get list of connected peer IDs.
   */
  get connectedPeers(): number[] {
    const result: number[] = [];
    for (const [id, conn] of this._connections) {
      if (conn.connected) result.push(id);
    }
    return result;
  }

  /**
   * Collect structured metrics from all circuit breakers.
   * Returns an array of CircuitBreakerMetric suitable for Prometheus exposure.
   */
  getCircuitBreakerMetrics(): CircuitBreakerMetric[] {
    const metrics: CircuitBreakerMetric[] = [];
    for (const [, breaker] of this._circuitBreakers) {
      metrics.push(breaker.getMetrics());
    }
    return metrics;
  }

  // ──────────────────────────────────────────
  //  Internal — connection management
  // ──────────────────────────────────────────

  private async _connect(peerId: number): Promise<PeerConnection> {
    const peer = this._peerInfo.get(peerId);
    if (!peer) {
      throw new Error(`Unknown peer id: ${peerId}`);
    }

    this._connecting.add(peerId);

    const attempt = this._retryAttempts.get(peerId) || 0;
    const backoff = computeBackoff(
      attempt,
      this.config.initialRetryMs,
      this.config.maxRetryMs,
      this.config.backoffFactor,
    );

    // D3: Wrap connection attempt in circuit breaker
    const cb = this._circuitBreakers.get(peerId);

    try {
      const socket = await this._createTLSSocket(peer);

      if (this._stopped) {
        socket.destroy();
        this._connecting.delete(peerId);
        throw new Error('ConnectionPool is stopped');
      }

      // Validate peer certificate
      if (!validatePeerCert(socket, peerId, this.config.tls.verify)) {
        socket.destroy();
        this._connecting.delete(peerId);
        throw new Error(`Peer certificate validation failed for peer ${peerId}: CN mismatch or expired`);
      }

      // Create connection with epoch
      const newEpoch = (this._connectionEpoch.get(peerId) || 0) + 1;
      const conn = new PeerConnection(peerId, socket, newEpoch);

      // A dial that was already in flight when the peer was removed must not
      // resurrect it: the configuration no longer contains this member, and a
      // socket registered for it would keep a removed node's link open until the
      // next idle timeout. `_peerInfo` is the record of who belongs here.
      if (!this._peerInfo.has(peerId)) {
        socket.destroy();
        this._connecting.delete(peerId);
        throw new Error(`Peer ${peerId} was removed while connecting`);
      }

      // A dial can finish after the peer's own dial was accepted, so check under
      // the mutex instead of overwriting: adopting the entry that is already
      // there keeps both ends on one socket, and the losing socket is destroyed
      // rather than left open with its handlers attached to nothing.
      const superseded = await this._connMutex.runExclusive(async () => {
        const active = this._connections.get(peerId);
        if (active && active.connected) return active;
        this._connectionEpoch.set(peerId, newEpoch);
        this._connections.set(peerId, conn);
        return undefined;
      });

      if (superseded) {
        socket.destroy();
        this._connecting.delete(peerId);
        logger.debug(`[ConnectionPool] Discarded a duplicate dial to peer ${peerId}`);
        return superseded;
      }

      // Notify RaftTcpTransport to set up data listener (bidirectional)
      this.onConnectionCreated?.(peerId, conn);

      // Wire up events
      conn.on('close', async () => {
        // Only disconnect if this exact connection is still the active one.
        // A retry or incoming supersession may have replaced it with a newer
        // connection; deleting the replacement would break the pool.
        const active = await this._connMutex.runExclusive(async () => {
          return this._connections.get(peerId);
        });
        if (active === conn) {
          this._onDisconnect(peerId);
        }
      });

      conn.on('error', (err: Error) => {
        logger.error(`[ConnectionPool] Connection error (peer ${peerId}): ${err.message}`);
      });

      conn.on('idle-timeout', () => {
        logger.error(`[ConnectionPool] Idle timeout (peer ${peerId})`);
        this._onDisconnect(peerId);
      });

      // D3: Reset circuit breaker on successful connection
      if (cb) {
        cb.close(); // Move back to closed state
      }

      // Reset retry count on successful connection
      this._retryAttempts.delete(peerId);
      this._connecting.delete(peerId);

      return conn;
    } catch (err) {
      this._connecting.delete(peerId);

      // D3: Report failure to circuit breaker (will open after threshold)
      if (cb) {
        // Fire a failing action through the circuit breaker to count errors
        try {
          await cb.fire(async () => {
            throw err;
          });
        } catch {
          // Expected — the action always fails
        }
      }

      // Schedule retry with exponential backoff
      this._scheduleRetry(peerId, backoff);

      throw err;
    }
  }

  /**
   * Resolve a hostname to an IP address, using a TTL cache to avoid
   * DNS lookup on every reconnect attempt.
   *
   * Caches resolved IPv4 addresses for 5 minutes by default.
   * If resolution fails, falls back to using the hostname directly
   * (which lets the OS/TCP stack handle resolution).
   */
  private async _resolveHost(host: string): Promise<string> {
    const cached = this._dnsCache.get(host);
    if (cached && Date.now() < cached.expiry) {
      return cached.address;
    }

    try {
      const { address } = await dns.promises.lookup(host, { family: 4 });
      this._dnsCache.set(host, {
        address,
        expiry: Date.now() + ConnectionPool.DNS_CACHE_TTL_MS,
      });
      return address;
    } catch {
      // Resolution failed — use hostname directly (fallback)
      return host;
    }
  }

  private _createTLSSocket(peer: PeerInfo): Promise<tls.TLSSocket> {
    return new Promise<tls.TLSSocket>(async (resolve, reject) => {
      // P7: Use cached DNS resolution to avoid DNS lookup on every reconnect
      const resolvedHost = await this._resolveHost(peer.host);
      if (resolvedHost !== peer.host) {
        logger.debug(`[ConnectionPool] Resolved ${peer.host} → ${resolvedHost} for peer ${peer.id}`);
      }

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${peer.host}:${peer.port} (${this.config.connectTimeoutMs}ms)`));
      }, this.config.connectTimeoutMs);

      const socket = tls.connect(
        {
          host: resolvedHost,
          servername: peer.host, // SNI needs the original hostname
          port: peer.port,
          cert: this._tlsOptions.cert,
          key: this._tlsOptions.key,
          ca: this._tlsOptions.ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384',
          ecdhCurve: 'prime256v1:secp384r1',
          checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => {
            // Read verify options from config; default to backward-compatible
            const verifyOpts = this.config.tls.verify || {};

            // ── 1. CN matching ──────────────────────────────────────
            // Default: CN === "raft-node-{peer.id}"
            const cnPrefixes = verifyOpts.allowedCNPrefixes?.length ? verifyOpts.allowedCNPrefixes : [`raft-node-`];
            const cnStrict = !cnPrefixes.includes('*');
            if (cnStrict) {
              const cn = cert.subject?.CN || '';
              // With prefix list: check CN starts with any prefix
              const cnMatch = cnPrefixes.some((prefix: string) => cn === `${prefix}${peer.id}`);
              if (!cnMatch) {
                return new Error(
                  `Certificate CN "${cn}" does not match any expected CN ` +
                    `(prefixes: ${JSON.stringify(cnPrefixes)}, peer.id: ${peer.id})`,
                );
              }
            }

            // ── 2. SAN matching ──────────────────────────────────────
            // Default: SAN contains "DNS:raft-node-{peer.id}"
            const sanPrefixes = verifyOpts.allowedSANPrefixes?.length ? verifyOpts.allowedSANPrefixes : [`raft-node-`];
            const sanStrict = !sanPrefixes.includes('*');
            if (sanStrict) {
              const sans = cert.subjectaltname;
              if (sans) {
                const sanEntries = sans.split(/,\s*/);
                const sanMatch = sanEntries.some((entry: string) => {
                  const trimmed = entry.trim();
                  // Only check DNS: entries
                  if (!trimmed.startsWith('DNS:')) return false;
                  const dnsName = trimmed.slice(4); // strip "DNS:" prefix
                  // Default: dnsName === "raft-node-{peer.id}"
                  return sanPrefixes.some((prefix: string) => dnsName === `${prefix}${peer.id}`);
                });
                if (!sanMatch) {
                  return new Error(
                    `Certificate SAN entries [${sans}] do not contain expected ` +
                      `"DNS:{prefix}{peer.id}" (prefixes: ${JSON.stringify(sanPrefixes)}, peer.id: ${peer.id})`,
                  );
                }
              }
            }

            // ── 3. extKeyUsage check ──────────────────────────
            if (cert.ext_key_usage && !verifyOpts.skipExtKeyUsageCheck) {
              // Compatible with friendly names (old Node) and OID strings (Node v24+)
              const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
              const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
              const hasServerAuth = cert.ext_key_usage.some(
                (ku: string) => ku === 'serverAuth' || ku === OID_SERVER_AUTH,
              );
              const hasClientAuth = cert.ext_key_usage.some(
                (ku: string) => ku === 'clientAuth' || ku === OID_CLIENT_AUTH,
              );
              if (!hasServerAuth && !hasClientAuth) {
                return new Error(
                  `Certificate extended key usage [${cert.ext_key_usage}] lacks ` +
                    `serverAuth (${OID_SERVER_AUTH}) / clientAuth (${OID_CLIENT_AUTH})`,
                );
              }
            }

            // ── 4. Hostname ──────────────────────────────────────
            if (hostname && hostname !== peer.host && !hostname.endsWith(peer.host)) {
              return new Error(`Certificate hostname "${hostname}" does not match peer host "${peer.host}"`);
            }

            return undefined; // Identity verified
          },
        },
        () => {
          clearTimeout(timeout);
          if (!socket.authorized) {
            reject(new Error(`TLS authorization failed: ${socket.authorizationError || 'unknown'}`));
            return;
          }
          resolve(socket);
        },
      );

      socket.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private _scheduleRetry(peerId: number, backoffMs: number): void {
    if (this._stopped) return;
    // A peer the pool no longer holds has no connection to restore. Retrying it
    // would dial an address the configuration has already removed, once per backoff
    // step, for the life of the process.
    if (!this._peerInfo.has(peerId)) return;

    // Cancel existing retry timer
    const existing = this._retryTimers.get(peerId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this._retryTimers.delete(peerId);

      if (this._stopped) return;

      // Increment attempt count
      const attempt = (this._retryAttempts.get(peerId) || 0) + 1;
      this._retryAttempts.set(peerId, attempt);

      // 3c: Max retries check → open circuit breaker instead of retrying
      if (attempt >= this.config.maxRetries) {
        this._openCircuitBreakerForPeer(peerId, attempt);
        return;
      }

      // Retry connection
      this._connect(peerId).catch((err: unknown) => {
        console.warn('[ConnectionPool] Retry connect failed for peer', peerId, ':', err);
      });
    }, backoffMs);

    this._retryTimers.set(peerId, timer);
  }

  /**
   * Open the circuit breaker for a peer after exceeding maxRetries.
   * Schedules an auto-reset after circuitResetTimeoutMs.
   */
  private _openCircuitBreakerForPeer(peerId: number, attempt: number): void {
    const cb = this._circuitBreakers.get(peerId);
    if (cb) {
      cb.open();
      logger.warn(`[ConnectionPool] Circuit breaker OPEN for peer ${peerId} after ${attempt} consecutive failures`);
    }
    // Schedule auto-reset after circuitResetTimeoutMs
    setTimeout(() => {
      if (this._stopped) return;
      const resetCb = this._circuitBreakers.get(peerId);
      if (resetCb) {
        resetCb.close();
        logger.info(`[ConnectionPool] Circuit breaker RESET for peer ${peerId}`);
      }
      this._retryAttempts.delete(peerId);
      // Closing the breaker only makes `getConnection()` willing to try again;
      // it does not try. Without re-arming here, a peer that was unreachable for
      // longer than the retry budget stayed unreachable — the breaker's job is
      // to stop hammering a dead peer, not to end the relationship with it.
      const active = this._connections.get(peerId);
      if (!active || !active.connected) {
        this._scheduleRetry(peerId, 0);
      }
    }, this.config.circuitResetTimeoutMs);
  }

  private async _onDisconnect(peerId: number): Promise<void> {
    let hasIncoming = false;
    await this._connMutex.runExclusive(async () => {
      const conn = this._connections.get(peerId);
      if (conn) {
        this._connections.delete(peerId);
      }

      // Check incoming latch for a fresh connection
      const incoming = this._incoming.get(peerId);
      if (incoming && incoming.connected) {
        this._connections.set(peerId, incoming);
        this._incoming.delete(peerId);
        hasIncoming = true;
      }
    });

    if (hasIncoming) {
      return;
    }

    if (!this._stopped) {
      // Schedule reconnect
      const attempt = this._retryAttempts.get(peerId) || 0;
      const backoff = computeBackoff(
        attempt,
        this.config.initialRetryMs,
        this.config.maxRetryMs,
        this.config.backoffFactor,
      );
      this._scheduleRetry(peerId, backoff);
    }
  }

  /**
   * Wait for an in-progress connection attempt to complete.
   */
  private _waitForConnection(peerId: number): Promise<PeerConnection> {
    return new Promise<PeerConnection>((resolve, reject) => {
      const check = async () => {
        const conn = await this._connMutex.runExclusive(async () => {
          return this._connections.get(peerId);
        });
        if (conn && conn.connected) {
          resolve(conn);
          return;
        }
        if (!this._connecting.has(peerId)) {
          // Connection attempt failed or stopped
          const lastConn = await this._connMutex.runExclusive(async () => {
            return this._connections.get(peerId);
          });
          if (lastConn && lastConn.connected) {
            resolve(lastConn);
          } else {
            // Start a new connection attempt
            this._connect(peerId).then(resolve).catch(reject);
          }
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
}

// ──────────────────────────────────────────
//  Frame encoding / decoding
// ──────────────────────────────────────────

/**
 * Encode a message as a length-prefixed frame.
 * Frame format: [4-byte length][data]
 */
export function encodeFrame(data: Buffer): Buffer {
  const len = data.length;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(len, 0);
  return Buffer.concat([header, data]);
}

/**
 * Decode a length-prefixed frame.
 * Returns the data buffer and remaining buffer, or null if incomplete.
 */
export function decodeFrame(buffer: Buffer): { data: Buffer; remaining: Buffer } | null {
  if (buffer.length < 4) return null;
  const len = buffer.readUInt32BE(0);
  const totalLen = 4 + len;
  if (buffer.length < totalLen) return null;
  return {
    data: buffer.subarray(4, totalLen),
    remaining: buffer.subarray(totalLen),
  };
}
