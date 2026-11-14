/**
 * RaftTcpTransport — TCP + mTLS transport layer for @maboke123/raft-core
 *
 * Implements the Raft transport interface used by RaftGroupManager:
 *   send(fromId: number, msgs: RaftMessage[]): Promise<void>
 *   register?(node: { id: number; host: string; port: number }): void
 *
 * Internally uses:
 *   - TLS server (incoming connections)
 *   - ConnectionPool (outgoing connections with mTLS + backoff)
 *   - MessageCodec (JSON frame serialization)
 *
 * Messages use wire format verified with @maboke123/raft-core WASM:
 *   - entries[i].data = base64 string (not Uint8Array)
 *   - entries[i].entryType (not "type")
 *   - All u64 fields = strings (e.g. "1" not 1)
 *   - Frame: [4-byte BE uint32 length][JSON payload]
 */

import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { MessageCodec, type RaftMessage } from './MessageCodec';
import { ConnectionPool } from './ConnectionPool';
import type { CircuitBreakerMetric } from '../opt/CircuitBreaker';
import { MessageCompressor } from '../helpers/MessageCompressor';
import { getErrorMessage } from '../helpers/errorUtils';
import { CompressionConfig } from '../../interfaces/types';

import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';
const logger = pino({ level: process.env.VITEST === 'true' ? 'silent' : (resolveLogLevel()) });

// ──────────────────────────────────────────
//  Types
// ──────────────────────────────────────────

export interface RaftNodeConfig {
  id: number;
  host: string;
  port: number;
}

export interface RaftTcpTransportConfig {
  /** local node info */
  node: RaftNodeConfig;
  /** peer node list */
  peers: RaftNodeConfig[];
  /** mTLS certificates */
  tls: {
    cert: Buffer | string;
    key: Buffer | string;
    ca: Buffer | string;
    /** certificate identity verification options. defaults to backward-compatible value if omitted (raft-node-{id} CN/SAN). */
    verify?: import('./ConnectionPool').PeerTlsVerifyOptions;
  };
  /** connection timeout (ms, default 5000) */
  connectTimeoutMs?: number;
  /** initial retry interval (ms, default 100) */
  initialRetryMs?: number;
  /** max retry interval (ms, default 30000) */
  maxRetryMs?: number;
  /** Message compression configuration (optional). */
  compression?: CompressionConfig;
}

export type MessageHandler = (msg: RaftMessage) => void;

// ──────────────────────────────────────────
//  RaftTcpTransport
// ──────────────────────────────────────────

export class RaftTcpTransport extends EventEmitter {
  private config: RaftTcpTransportConfig;
  private pool: ConnectionPool | null = null;
  private server: tls.Server | null = null;
  private _started = false;
  private _stopped = false;
  private _registeredNodes: Map<number, RaftNodeConfig> = new Map();

  /**
   * accumulation buffer for reading complete frames from incoming socket
   * keyed by peerId (from TLS socket)
   */
  private _buffers: Map<string, Buffer> = new Map();
  private _pendingMessages: Map<number, Buffer[]> = new Map();
  private _outstandingReconnects: Set<number> = new Set();
  private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  // D2: Message compression
  private _compressor: MessageCompressor;
  private _compressionEnabled: boolean;

  constructor(config: RaftTcpTransportConfig) {
    super();
    this.config = config;

    // D2: Initialize message compressor
    const compConfig = config.compression ?? { enabled: true, threshold: 1024, level: 3 };
    this._compressionEnabled = compConfig.enabled;
    this._compressor = new MessageCompressor({
      threshold: compConfig.threshold ?? 1024,
      level: compConfig.level ?? 3,
    });

    // Register self by default
    this._registeredNodes.set(config.node.id, config.node);

    // Register all peers from config
    for (const peer of config.peers) {
      this._registeredNodes.set(peer.id, peer);
    }
  }

  // ──────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────

  /**
   * Register a Raft peer. Called by RaftGroupManager when
   * a new node joins the cluster. If the connection pool is
   * running, initiates a connection to the new peer.
   */
  register(node: RaftNodeConfig): void {
    this._registeredNodes.set(node.id, node);
    if (this.pool) {
      this.pool.addNode({ id: node.id, host: node.host, port: node.port });
    }
  }

  /**
   * Start physical transport layer: start TLS server + initialize ConnectionPool.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._stopped = false;

    // ── mTLS Enforcement ──
    // Validate all required mTLS fields are present
    const tlsConfig = this.config.tls;
    if (!tlsConfig.cert || (typeof tlsConfig.cert === 'string' && tlsConfig.cert.trim().length === 0)) {
      throw new Error(
        '[RaftTcpTransport] mTLS is REQUIRED for TCP transport. ' + 'Provide a valid `tls.cert` (PEM certificate).',
      );
    }
    if (!tlsConfig.key || (typeof tlsConfig.key === 'string' && tlsConfig.key.trim().length === 0)) {
      throw new Error(
        '[RaftTcpTransport] mTLS is REQUIRED for TCP transport. ' + 'Provide a valid `tls.key` (PEM private key).',
      );
    }
    if (!tlsConfig.ca || (typeof tlsConfig.ca === 'string' && tlsConfig.ca.trim().length === 0)) {
      throw new Error(
        '[RaftTcpTransport] mTLS is REQUIRED for TCP transport. ' +
          'Provide a valid `tls.ca` (PEM CA certificate for peer verification).',
      );
    }

    // 1. Start TLS server for incoming connections
    this.server = tls.createServer({
      cert: this.config.tls.cert,
      key: this.config.tls.key,
      ca: this.config.tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384',
      ecdhCurve: 'prime256v1:secp384r1',
    });

    this.server.on('secureConnection', (socket) => {
      this._handleIncoming(socket);
    });

    this.server.on('error', (err) => {
      this.emit('error', err);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.node.port, this.config.node.host, () => {
        // Update config with actual bound port (important when port=0 auto-assign)
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.config.node.port = addr.port;
        }
        resolve();
      });
      this.server!.once('error', reject);
    });

    // 2. Build peer list for ConnectionPool (exclude self)
    const peerList = this._getPeerList();

    // 3. Initialize ConnectionPool
    this.pool = new ConnectionPool({
      nodeId: this.config.node.id,
      peers: peerList,
      tls: this.config.tls,
      connectTimeoutMs: this.config.connectTimeoutMs ?? 5000,
      initialRetryMs: this.config.initialRetryMs ?? 100,
      maxRetryMs: this.config.maxRetryMs ?? 30000,
    });

    // 4. Register connection callback for bidirectional data handling.
    //    Without this, outgoing connections (created by _connect) do not have
    //    data listeners — PeerConnection emits 'data' events but nobody listens.
    //    Incoming connections (via _handleIncoming) set up data listeners correctly,
    //    but TCP sockets are bidirectional: the OUTGOING socket also receives data.
    this.pool.onConnectionCreated = (peerId: number, conn) => {
      // Remove any existing data listener to avoid duplicates
      conn.removeAllListeners('data');
      // CRITICAL: Clear the per-peer frame buffer when a connection is
      // (re-)established.  Without this, stale data left by a previous
      // connection (e.g. after idle-timeout → retry) gets concatenated
      // with the new data stream.  The first 4 bytes of stale data are
      // interpreted as a frame length, producing garbage and never
      // emitting 'message' events — Raft consensus silently dies.
      this._buffers.delete(`peer:${peerId}`);
      conn.on('data', (data: Buffer) => {
        this._processData(peerId, data).catch((err) => {
          this.emit('decode-error', { peerId, error: err });
        });
      });

      // ── Flush pending messages ──
      // When a connection becomes available (first connection or reconnect),
      // immediately send any critical messages that were buffered while the
      // connection was being established. This ensures entries proposed before
      // the TLS handshake completes are delivered without waiting for the next
      // tick cycle.
      const pending = this._pendingMessages.get(peerId);
      if (pending && pending.length > 0) {
        this._pendingMessages.delete(peerId);
        for (const buf of pending) {
          conn.write(buf).catch((err: unknown) => {
            console.warn('[RaftTcpTransport] Write pending messages failed, closing connection:', err);
            conn.close();
          });
        }
      }
    };

    // 5. Initiate connections to all peers eagerly but non-blocking.
    //    TLS connections on localhost take ~50-200ms. By starting them here
    //    asynchronously, they should be ready by the first heartbeat tick.
    //    Simultaneous connect is handled by onIncoming: whichever side's
    //    connection completes first is used; the incoming from the other side
    //    is rejected without tearing down the established connection.
    for (const peer of peerList) {
      this._initiateConnection(peer.id).catch((err) => {
        this.emit('connect-error', { peerId: peer.id, error: err });
      });
    }

    // 6. Background connection health-check.  Every 500ms, check if any
    //    peer's outgoing connection is dead.  If so, re-establish it
    //    asynchronously.  This is a non-blocking background operation that
    //    competes with the WASM queue — it ensures connections are always
    //    available for _doSendFrame's tryGetConnection() even after a
    //    timeout or unexpected disconnect.  Without this, a dropped
    //    connection is only retried on explicit send failure (write error
    //    → socket close → _onDisconnect → _scheduleRetry), which has a
    //    delay of ~100ms+ (exponential backoff).  During that delay all
    //    heartbeats are silently dropped, causing follower timeouts.
    this._healthCheckTimer = setInterval(() => {
      if (this._stopped || !this.pool) return;
      for (const peer of peerList) {
        const conn = this.pool.tryGetConnection(peer.id);
        if (!conn) {
          // No live connection — kick off reconnect in the background.
          // The new connection's onConnectionCreated fires the data
          // listener and flushes _pendingMessages.
          this._initiateConnection(peer.id).catch((err: unknown) => {
            console.warn('[RaftTcpTransport] Health check reconnect failed for peer', peer.id, ':', err);
          });
        }
      }
    }, 500);
  }

  /**
   * Wait for all peer connections to be established.
   * Returns once all connections succeed or fail (does not throw).
   * Use before creating the RaftNode to ensure transport.send() is fast.
   */
  async waitForConnections(): Promise<void> {
    const peerList = this._getPeerList();
    if (peerList.length === 0) return;
    await Promise.allSettled(
      peerList.map((peer) => {
        if (!this.pool) return Promise.resolve();
        return this.pool.getConnection(peer.id).catch((err: unknown) => {
          console.warn('[RaftTcpTransport] Wait for connection failed for peer', peer.id, ':', err);
        });
      }),
    );
  }
  async stop(): Promise<void> {
    this._stopped = true;
    this._started = false;

    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }

    if (this.pool) {
      await this.pool.stop();
      this.pool = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        setTimeout(() => resolve(), 2000); // Force close after 2s
      });
      this.server = null;
    }
  }

  /**
   * Send Raft messages to all peers.
   * Core interface called by RaftGroupManager.
   *
   * @param fromId - sender node ID
   * @param msgs - message list from @maboke123/raft-core step()
   */
  async send(fromId: number, msgs: RaftMessage[]): Promise<void> {
    if (this._stopped || !this.pool) return;

    const peerMap = this._getPeerMap();

    // Group messages by target peer
    const byPeer = new Map<number, RaftMessage[]>();
    for (const msg of msgs) {
      const targetId = parseInt(msg.to, 10);
      if (targetId === fromId) continue; // Skip self

      // Map @maboke123/raft-core node IDs to connection peer IDs
      // Node IDs in @maboke123/raft-core are the same as our peer IDs
      const peerId = targetId;

      if (!byPeer.has(peerId)) {
        byPeer.set(peerId, []);
      }
      byPeer.get(peerId)!.push(msg);
    }

    // ── Non-blocking delivery ──
    // This method runs inside the WASM serialization queue.  Blocking the
    // queue on network I/O (even connection retry ~100ms) prevents the
    // leader from ticking — followers time out → higher-term campaign →
    // leader loss.  Instead: tryGetConnection() for instant delivery,
    // or buffer to _pendingMessages.  The ConnectionPool's onConnectionCreated
    // callback (in start() below) flushes buffered messages as soon as the
    // socket is ready.  Heartbeats are idempotent: drop silently if the
    // connection is down — the next tick (100ms) will retry.
    //
    // Write errors must NOT be silently swallowed (that leaves a dead
    // connection in the pool while heartbeats vanish into /dev/null).
    // _sendFrame → _doSendFrame handles write failures by emitting
    // 'connection-lost', which triggers ConnectionPool._onDisconnect +
    // _scheduleRetry (exponential backoff, ~50ms first retry).
    for (const [peerId, peerMsgs] of byPeer) {
      const peerConfig = peerMap.get(peerId);
      if (!peerConfig) continue;

      for (const msg of peerMsgs) {
        const frame = MessageCodec.encode(msg);
        const isHeartbeat = msg.msgType === 8 || msg.msgType === 9;
        this._sendFrame(peerId, frame, isHeartbeat);
      }
    }
  }

  /**
   * Send message directly to specified peer, bypassing `msg.to` routing.
   * For BatchedRaftTransport adaptation with @maboke123/raft-core.
   */
  sendToPeer(peerId: number, payload: Buffer): void {
    if (this._stopped || !this.pool) return;
    this._sendFrame(peerId, payload, false);
  }

  /**
   * Register message handler. Called for every complete Raft message.
   * @deprecated Use events: 'message' event instead.
   */
  onMessage(handler: MessageHandler): void {
    this.on('message', handler);
  }

  /**
   * Get current connection status (for monitoring)
   */
  /** Port the TLS server is bound to (resolved when configured with port 0). */
  getBoundPort(): number {
    return this.config.node.port;
  }

  /** Numeric ids of peers with a live mTLS connection. */
  getConnectedPeers(): number[] {
    return this.pool?.connectedPeers ?? [];
  }

  getStatus(): { connectedPeers: number[]; totalPeers: number; started: boolean } {
    return {
      connectedPeers: this.pool?.connectedPeers ?? [],
      totalPeers: this._registeredNodes.size - 1, // Exclude self
      started: this._started,
    };
  }

  /**
   * Collect circuit breaker metrics from the underlying ConnectionPool.
   */
  getCircuitBreakerMetrics(): CircuitBreakerMetric[] {
    if (!this.pool) return [];
    return this.pool.getCircuitBreakerMetrics();
  }

  // ──────────────────────────────────────────
  //  Internal
  // ──────────────────────────────────────────

  private _getPeerList(): Array<{ id: number; host: string; port: number }> {
    const list: Array<{ id: number; host: string; port: number }> = [];
    for (const [id, node] of this._registeredNodes) {
      if (id !== this.config.node.id) {
        list.push({ id, host: node.host, port: node.port });
      }
    }
    return list;
  }

  private _getPeerMap(): Map<number, RaftNodeConfig> {
    const map = new Map<number, RaftNodeConfig>();
    for (const [id, node] of this._registeredNodes) {
      if (id !== this.config.node.id) {
        map.set(id, node);
      }
    }
    return map;
  }

  /**
   * Fire-and-forget frame delivery.
   *
   * 1) Compress the payload (async, outside the WASM queue critical path).
   * 2) Delegate to _doSendFrame for the actual connection lookup + write.
   *    NEVER blocks the caller on TLS handshake or socket write.
   */
  /**
   * Guard: drainAndDrop the pending message buffer for a peer.
   * Called from _doSendFrame when pool is gone (e.g. stop() during async
   * compression callback). Prevents unbounded memory growth under burst.
   */
  private _drainPending(peerId: number): void {
    this._pendingMessages.delete(peerId);
  }

  /**
   * Fire-and-forget frame delivery.
   *
   * 1) Compress the payload (async, outside the WASM queue critical path).
   * 2) Delegate to _doSendFrame for the actual connection lookup + write.
   *    NEVER blocks the caller on TLS handshake or socket write.
   */
  private _sendFrame(peerId: number, frame: Buffer, isHeartbeat: boolean): void {
    if (!this.pool) throw new Error('Transport not started');

    const payload = frame.subarray(4); // Strip 4-byte length header for compression

    const sendIt = (compressedPayload: Buffer) => {
      if (!this.pool) {
        this._drainPending(peerId);
        return; // Transport stopped during async compression
      }
      const newHeader = Buffer.alloc(4);
      newHeader.writeUInt32BE(compressedPayload.length, 0);
      const newFrame = Buffer.concat([newHeader, compressedPayload]);
      this._doSendFrame(peerId, newFrame, isHeartbeat);
    };

    if (this._compressionEnabled) {
      this._compressor
        .compress(payload)
        .then(sendIt)
        .catch((err: unknown) => {
          console.warn('[RaftTcpTransport] Compression failed, sending uncompressed:', err);
          sendIt(payload);
        });
    } else {
      sendIt(payload);
    }
  }

  /**
   * One-way non-blocking write.
   *
   * - `tryGetConnection()` — synchronous, never blocks.
   * - If connected: write to socket.  Write failures emit 'connection-lost'
   *   (triggers ConnectionPool._onDisconnect → _scheduleRetry → reconnect).
   * - If not connected (down or still handshaking):
   *   * Heartbeats: dropped (idempotent, next tick at 100ms).
   *   * Critical: buffered in _pendingMessages, flushed when
   *     ConnectionPool.onConnectionCreated fires in start().
   */
  private _doSendFrame(peerId: number, frame: Buffer, isHeartbeat: boolean): void {
    if (!this.pool) {
      this._drainPending(peerId);
      return;
    }

    const conn = this.pool.tryGetConnection(peerId);
    if (!conn) {
      if (isHeartbeat) return; // Idempotent — drop.
      // Buffer critical messages (Append, Vote, PreVote etc.) for delivery
      // when the connection is re-established (flushed in onConnectionCreated).
      const pending = this._pendingMessages.get(peerId) || [];
      pending.push(frame);
      this._pendingMessages.set(peerId, pending);
      // Fire-and-forget reconnect — only if not already connecting
      if (!this._outstandingReconnects.has(peerId)) {
        this._outstandingReconnects.add(peerId);
        this._initiateConnection(peerId).finally(() => {
          this._outstandingReconnects.delete(peerId);
        });
      }
      return;
    }

    conn.write(frame).catch((err: unknown) => {
      // Write failed — socket's own close/error events handle cleanup
      // (_onDisconnect → _scheduleRetry).  Never force-close here: it
      // triggers a cascade where both sides simultaneously destroy the
      // same socket, duplicating reconnection effort.
      console.warn('[RaftTcpTransport] Frame write failed:', err);
    });
  }

  /**
   * Fire-and-forget connection initiation. The actual connection is established
   * asynchronously and will be available via tryGetConnection on subsequent calls.
   */
  private async _initiateConnection(peerId: number): Promise<void> {
    if (!this.pool || this._stopped) return;
    try {
      await this.pool.getConnection(peerId);
    } catch {
      // Connection attempt failed — will be retried on next heartbeat
    }
  }

  private _handleIncoming(socket: tls.TLSSocket): void {
    // Reject unauthorized certificates — Node.js TLS 1.3 with
    // rejectUnauthorized: true may still fire secureConnection even when
    // client cert fails CA-chain validation (socket.authorized === false).
    // Without this check, a peer with cert signed by a different CA would
    // be accepted and could participate in the Raft cluster.
    if (!socket.authorized) {
      socket.destroy();
      return;
    }

    // Extract peer ID from certificate CN: default "raft-node-{id}", configurable via verifyOpts
    const cert = socket.getPeerCertificate();
    if (!cert?.subject?.CN) {
      socket.destroy();
      return;
    }

    const cn = Array.isArray(cert.subject.CN) ? cert.subject.CN[0] : cert.subject.CN;
    const verifyOpts = this.config.tls.verify || {};
    const cnPrefixes = verifyOpts.allowedCNPrefixes?.length ? verifyOpts.allowedCNPrefixes : [`raft-node-`];

    let peerId: number | null = null;
    for (const prefix of cnPrefixes) {
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cnMatch = cn?.match(new RegExp(`^${escapedPrefix}(\\d+)$`));
      if (cnMatch) {
        peerId = parseInt(cnMatch![1]!, 10);
        break;
      }
    }

    if (peerId === null) {
      socket.destroy();
      return;
    }

    // Register this incoming connection with the connection pool
    if (this.pool) {
      this.pool.onIncoming(peerId, socket).then((conn) => {
        if (!conn) {
          socket.destroy();
          return;
        }
      }).catch((err) => {
        logger.error(`[RaftTcpTransport] onIncoming error: ${getErrorMessage(err)}`);
        socket.destroy();
      });

      // NOTE: Data listener is registered by `this.pool.onConnectionCreated`
      // which fires inside `onIncoming()` for BOTH incoming and outgoing
      // connections.  Do NOT add another `conn.on('data', ...)` here —
      // doing so creates TWO data listeners, each calling `_processData`
      // with the same data chunk, causing duplicate message processing
      // and corrupting the per-peer buffer in `_processData`.
    } else {
      // Pool not ready yet — store for later
      const id = `${peerId}:${socket.remoteAddress}:${socket.remotePort}`;
      this._buffers.set(id, Buffer.alloc(0));

      socket.on('data', (data: Buffer) => {
        const existing = this._buffers.get(id) || Buffer.alloc(0);
        this._buffers.set(id, Buffer.concat([existing, data]));
      });

      socket.on('close', () => {
        this._buffers.delete(id);
      });
    }
  }

  private async _processData(peerId: number, data: Buffer): Promise<void> {
    // Use a static buffer for accumulation
    const bufKey = `peer:${peerId}`;
    let accumulated = this._buffers.get(bufKey) || Buffer.alloc(0);
    accumulated = Buffer.concat([accumulated, data]);
    this._buffers.set(bufKey, accumulated);

    // Try to read frames
    while (true) {
      if (accumulated.length < 4) break; // Not enough for header

      const payloadLen = accumulated.readUInt32BE(0);
      const frameLen = 4 + payloadLen;

      if (accumulated.length < frameLen) break; // Need more data

      // Extract complete frame
      const frame = accumulated.subarray(0, frameLen);
      accumulated = accumulated.subarray(frameLen);
      this._buffers.set(bufKey, accumulated);

      // Special: empty frame (heartbeat)
      if (payloadLen === 0) {
        this.emit('heartbeat', { from: peerId });
        continue;
      }

      // Decode message
      try {
        let payload = frame.subarray(4);

        // D2: Decompress the payload if compressed
        if (this._compressionEnabled) {
          payload = await this._compressor.decompress(payload);
        }

        const msg = MessageCodec.decode(payload);
        // Ensure the message has the correct "from" field
        if (!msg.from || msg.from === '0') {
          msg.from = String(peerId);
        }
        this.emit('message', msg, String(peerId));
      } catch (err) {
        this.emit('decode-error', { peerId, error: err });
      }
    }
  }
}
