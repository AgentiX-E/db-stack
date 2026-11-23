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
import { ConnectionPool, type PeerConnection } from './ConnectionPool';
import type { CircuitBreakerMetric } from '../opt/CircuitBreaker';
import { MessageCompressor } from '../helpers/MessageCompressor';
import { getErrorMessage } from '../helpers/errorUtils';
import { CompressionConfig } from '../../interfaces/types';

import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';
const logger = pino({ level: process.env.VITEST === 'true' ? 'silent' : resolveLogLevel() });

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

/**
 * How many frames the transport will hold for one unreachable peer.
 *
 * The pool used to carry a capped queue (1024 per peer) that nothing ever filled;
 * the transport carried an uncapped one that is the only one actually used. A
 * peer that stays unreachable while a leader keeps proposing therefore grew this
 * buffer without limit — the cap moved to where the writing happens rather than
 * being deleted with the queue it belonged to.
 */
const MAX_PENDING_FRAMES_PER_PEER = 1024;

/**
 * How many times a peer's pending batch is retried on a freshly dialled socket
 * before its frames are given up.
 *
 * One failure is a dead socket: the batch goes back in the buffer and the
 * connection is closed so the pool dials again. A socket that keeps accepting
 * the dial and rejecting the write is not a transient failure, and retrying it
 * forever is a loop that keeps a victim's frames in memory for the process's
 * lifetime. Three attempts is the point where "the peer will not take these" is
 * a fact; the frames are then counted and discarded in the open.
 */
const MAX_FLUSH_ATTEMPTS = 3;

/**
 * Bytes in front of every payload: the big-endian length the frame was cut to.
 *
 * Named because it is the one number in the reader that is not the data's: it is
 * what makes a buffer of `n` bytes hold at most `n / 4` frames, which is the bound
 * {@link splitFrames} walks to.
 */
const FRAME_HEADER_BYTES = 4;

/** Emitted when frames are discarded because they could not be delivered. */
export interface FramesDroppedEvent {
  peerId: number;
  count: number;
  /** `buffer-full` — the peer's queue hit {@link MAX_PENDING_FRAMES_PER_PEER}; `flush-failed` — {@link MAX_FLUSH_ATTEMPTS} writes on fresh sockets all failed. */
  reason: 'buffer-full' | 'flush-failed';
  /** The oldest frame's first bytes, for a log line that can be matched to a message. */
  head: string;
}

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
  /** Consecutive failed flush attempts per peer; reset by a write that succeeds. */
  private _flushAttempts: Map<number, number> = new Map();
  /**
   * Peers that already have a flush link waiting on their send queue.
   *
   * A backlog can be created from three places — a frame that arrives with no
   * connection, a frame that must wait behind a backlog, and a batch whose socket
   * died — and each of them wants the backlog drained as soon as a connection is
   * there. Without this set, one frame behind a full queue would add one flush
   * link, and a thousand frames would add a thousand links that each find nothing
   * to write. See {@link _scheduleFlush}.
   */
  private _flushScheduled: Set<number> = new Set();
  /**
   * The tail of each peer's send queue: frames are compressed and written one at
   * a time, in the order they were submitted. See {@link _sendFrame}.
   */
  private _sendChains: Map<number, Promise<void>> = new Map();
  /**
   * The tail of each peer's receive queue: chunks are decoded one at a time, in
   * arrival order. See {@link _processData}.
   */
  private _processChains: Map<number, Promise<void>> = new Map();
  /** Frames discarded because they could not be delivered. Monotonic. */
  private _droppedFrames = 0;
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
   * Forget a peer: stop routing to it, stop dialling it, close its socket.
   *
   * The counterpart of {@link register}. Without it a node removed from the raft
   * configuration stayed in `_registeredNodes`, so `send()` kept encoding frames
   * for it — cheap, but the pool also kept reconnecting, which is a removed member
   * being dialled forever. Registering self is refused: a node that unregisters
   * itself is asking the wrong object.
   */
  unregister(nodeId: number): void {
    if (nodeId === this.config.node.id) return;
    const known = this._registeredNodes.delete(nodeId);
    this._pendingMessages.delete(nodeId);
    this._flushAttempts.delete(nodeId);
    this._buffers.delete(`peer:${nodeId}`);
    this.pool?.removeNode(nodeId);
    if (known) logger.info(`[RaftTcpTransport] Unregistered peer ${nodeId}`);
  }

  /**
   * Wait until a dial to `peerId` succeeds, bounded by `timeoutMs`.
   *
   * `send()` is deliberately non-blocking, so "the peer was added" and "there is a
   * socket to it" are different facts and only the second one means the node can be
   * replicated to. A membership change has to answer the second: adding a member
   * whose address nobody can reach commits a configuration with a member that will
   * never receive an entry.
   *
   * Connection failures are retried inside the budget because a joining node may
   * still be binding its listener when the leader is told to add it.
   */
  async awaitPeerConnection(peerId: number, timeoutMs: number): Promise<boolean> {
    if (!this.pool) return false;
    return this._awaitConnection(peerId, Date.now() + Math.max(0, timeoutMs));
  }

  /**
   * One attempt to dial `peerId`, then a sleep for what is left of the budget.
   *
   * One deadline serves every attempt, and each step either answers or moves it
   * closer — the step is data (the clock) rather than a counter, so there is no
   * update expression for an edit to reverse. That is the difference from the
   * `for (;;)` this replaces, whose emptied body spun the process with no timer
   * left to interrupt it (P3-75). A stopped transport answers `false` on the next
   * step rather than sleeping through a budget it can no longer spend.
   */
  private async _awaitConnection(peerId: number, deadline: number): Promise<boolean> {
    const pool = this.pool;
    if (!pool || this._stopped) return false;
    try {
      const conn = await pool.getConnection(peerId);
      if (conn.connected) return true;
    } catch {
      // Refused, timed out, or circuit-open: all mean "no socket yet", and the
      // next step is the retry the budget allows.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    return this._awaitConnection(peerId, deadline);
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
      // Re-emit for observers, but only when somebody is listening: EventEmitter
      // throws on an 'error' with no handler, so an unobserved listen failure
      // (EADDRINUSE on a busy machine) used to escape as an uncaught exception
      // while `start()` was already rejecting with the same error.
      if (this.listenerCount('error') > 0) this.emit('error', err);
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
      this._flushPending(peerId, conn);
    };

    // 5. Initiate connections to all peers eagerly but non-blocking.
    //    TLS connections on localhost take ~50-200ms. By starting them here
    //    asynchronously, they should be ready by the first heartbeat tick.
    //    Simultaneous connect is handled by `ConnectionPool.onIncoming`, which
    //    *replaces* the pool's entry for the peer with the incoming connection and
    //    closes the superseded outgoing one — it does not reject the incoming.
    //    A TLS socket is bidirectional, so the surviving connection carries both
    //    directions and nothing is lost by the swap; a probe of eight consecutive
    //    both-ways dials delivered every message in both directions (p50 ~0-1 ms,
    //    worst 23 ms). This comment used to claim the opposite behaviour, which is
    //    not what the pool does.
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

    // A stopped transport has no socket left that could flush these, and a
    // restart is Raft's to re-drive: keeping a peer's queue across a stop is a
    // hold on memory with no schedule to release it. Counters are kept — they
    // are a record of what happened, not state to resume from.
    this._pendingMessages.clear();
    this._flushAttempts.clear();
    this._flushScheduled.clear();
    // Queued links still run; they find no pool and drop their frame, which is
    // the same answer every other path gives once the transport is stopped.
    this._sendChains.clear();
    this._processChains.clear();

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

  /** Remove a handler registered with `onMessage`. */
  offMessage(handler: MessageHandler): void {
    this.off('message', handler);
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

  /**
   * Snapshot of the transport's own counters.
   *
   * `bufferedFrames` is per peer and shrinks as connections come back;
   * `droppedFrames` only grows. The second number is the one a deployment has to
   * watch: a dropped Raft frame is a message the leader believes it sent, and
   * nothing else in the process records that it did not arrive.
   */
  getStatus(): {
    connectedPeers: number[];
    totalPeers: number;
    started: boolean;
    bufferedFrames: Record<number, number>;
    droppedFrames: number;
  } {
    const bufferedFrames: Record<number, number> = {};
    for (const [peerId, frames] of this._pendingMessages) {
      bufferedFrames[peerId] = frames.length;
    }
    return {
      connectedPeers: this.pool?.connectedPeers ?? [],
      totalPeers: this._registeredNodes.size - 1, // Exclude self
      started: this._started,
      bufferedFrames,
      droppedFrames: this._droppedFrames,
    };
  }

  /**
   * Whether a frame written right now would reach a live socket rather than a
   * buffer.
   *
   * `send()` is deliberately non-blocking: with no connection it pushes the
   * frame into `_pendingMessages` and returns, because blocking the Raft tick on
   * network I/O costs an election. That is right for Raft and wrong for an
   * application that needs to know whether a message left the process — the
   * federation outbox marks an entry delivered on `true`, so "buffered" reported
   * as "delivered" loses the message the moment the peer does not come back.
   *
   * Distinguishes the two by looking at the live connection, not at the last
   * status snapshot: a peer that has gone away is still listed in
   * `connectedPeers` until the pool's own event handler runs, which is up to a
   * second later, and that second is exactly when the message is lost.
   */
  canReach(peerId: number): boolean {
    if (this._stopped || !this.pool) return false;
    const conn = this.pool.tryGetConnection(peerId);
    if (!conn || !conn.connected || conn.destroyed) return false;
    const socket = conn.socket;
    if (socket === null || socket.destroyed || !socket.writable) return false;
    // A socket exists from the moment `connect()` is called, which is well
    // before the handshake decides whether the peer is who it claims to be. A
    // connection whose certificate the CA rejected is not a way to reach anyone,
    // and reporting it as one sends the message to a socket that is about to be
    // destroyed.
    return socket.authorized === true;
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
   * Drop the pending frame buffer for a peer.
   *
   * Called from `_doSendFrame` when the pool is gone (e.g. `stop()` during the
   * async compression callback). Prevents unbounded memory growth under burst.
   *
   * Dropping is the correct behaviour here and only here: the transport is
   * stopping, so there is no connection left that could ever flush these frames.
   */
  private _drainPending(peerId: number): void {
    this._pendingMessages.delete(peerId);
  }

  /**
   * Append a frame to a peer's pending buffer, enforcing the per-peer cap.
   *
   * The newest frame wins: when the buffer is full the oldest one is discarded.
   * A peer 1024 frames behind is either gone or will be caught up by the leader
   * resending what it needs; keeping the frames it has already missed while
   * refusing the current term would be the worse choice. Every discard is
   * counted and emitted, because a dropped Raft frame is a fact the cluster
   * cannot see and an operator has to.
   */
  private _bufferFrame(peerId: number, frame: Buffer): void {
    let queue = this._pendingMessages.get(peerId);
    if (!queue) {
      queue = [];
      this._pendingMessages.set(peerId, queue);
    }
    if (queue.length >= MAX_PENDING_FRAMES_PER_PEER) {
      const evicted = queue.shift();
      if (evicted) this._dropFrames(peerId, [evicted], 'buffer-full');
    }
    queue.push(frame);
  }

  /**
   * Put frames back at the head of a peer's buffer, oldest first.
   *
   * Used when a flush fails part-way: the frames that never reached the socket
   * are older than anything buffered since, so they keep their order. The cap
   * still keeps the newest frames, the same rule `_bufferFrame` applies, because
   * the newest are the ones a Raft peer is waiting on.
   */
  private _prependFrames(peerId: number, frames: Buffer[]): void {
    const queue = this._pendingMessages.get(peerId) ?? [];
    const merged = [...frames, ...queue];
    const overflow = merged.length - MAX_PENDING_FRAMES_PER_PEER;
    if (overflow > 0) {
      this._dropFrames(peerId, merged.slice(0, overflow), 'buffer-full');
      merged.splice(0, overflow);
    }
    this._pendingMessages.set(peerId, merged);
  }

  /** Count discarded frames and say so; a silent drop is a message lost in the dark. */
  private _dropFrames(peerId: number, frames: Buffer[], reason: FramesDroppedEvent['reason']): void {
    this._droppedFrames += frames.length;
    const head = frames[0]!.subarray(0, 8).toString('hex');
    logger.warn(`[RaftTcpTransport] Dropped ${frames.length} frame(s) for peer ${peerId} (${reason}, head=${head})`);
    this.emit('frames-dropped', { peerId, count: frames.length, reason, head } satisfies FramesDroppedEvent);
  }

  /**
   * Take a peer's buffered frames and hand them to the peer's queue.
   *
   * The batch is taken and cleared synchronously and *written* later, on its turn
   * in the queue — a flush used to write inline from `onConnectionCreated`, which
   * put it in front of a frame that was still waiting for the compressor. Taking
   * the frames now and writing them later is what lets a frame submitted after
   * this point wait behind them.
   *
   * A rejection during the write used to destroy the frames: the buffer was
   * deleted before the loop, so a write failure closed the socket and the entries
   * the leader had proposed before the handshake completed were gone with no
   * record. Re-buffering them and closing the socket turns that into a retry — the
   * pool's close handler schedules the dial, `onConnectionCreated` fires again,
   * and the batch goes out over the new socket. Retries are bounded by
   * {@link MAX_FLUSH_ATTEMPTS} so a peer that accepts dials and refuses writes
   * cannot pin one victim's frames forever. See {@link _writeBatch}.
   */
  private _flushPending(peerId: number, conn: PeerConnection | null = null): void {
    const queued = this._pendingMessages.get(peerId);
    if (!queued || queued.length === 0) return;
    // Taken and cleared synchronously: from here the batch belongs to one link of
    // the peer's queue, and a frame submitted after this point has to wait behind
    // it. Clearing later would let the buffer be appended to while the batch was
    // being written, which is the same overtake in a smaller window.
    this._pendingMessages.delete(peerId);
    this._enqueueSend(peerId, () => this._writeBatch(peerId, queued, conn));
  }

  /**
   * Write one batch of buffered frames to the peer's current connection.
   *
   * The connection is resolved when the batch's turn comes, not when the flush was
   * requested: between the two a replacement can land, and the socket this batch
   * was handed may be the one the pool just closed. Writing to that one is the
   * failure a transport cannot see afterwards — the kernel accepts the bytes and
   * the peer never reads them — so a batch whose connection is gone goes back to
   * the front of the buffer and waits for the next connection to be announced.
   *
   * Writes are issued in order and the first rejection ends the batch: once a
   * socket rejects one write the frames after it would land on the same dead
   * socket, so they are re-buffered rather than written and lost. The failure
   * budget is per batch, not per frame: it is cleared only when every frame of one
   * batch reached the socket. Clearing it on the first successful write let a peer
   * that fails every other frame retry forever.
   */
  private async _writeBatch(peerId: number, batch: Buffer[], fallback: PeerConnection | null): Promise<void> {
    const conn = this._resolveWriteConnection(peerId, fallback);
    if (!conn) {
      this._prependFrames(peerId, batch);
      return;
    }

    let failed = false;
    let settled = 0;
    const onWritten = (): void => {
      settled += 1;
      if (settled === batch.length && !failed) this._flushAttempts.delete(peerId);
    };
    batch.forEach((frame, index) => {
      void conn.write(frame).then(onWritten, (err: unknown) => {
        settled += 1;
        if (failed) return; // One verdict per batch.
        failed = true;
        const attempts = (this._flushAttempts.get(peerId) ?? 0) + 1;
        this._flushAttempts.set(peerId, attempts);
        const undelivered = batch.slice(index);
        logger.warn(
          `[RaftTcpTransport] Flush to peer ${peerId} failed at frame ${index}/${batch.length} ` +
            `(attempt ${attempts}/${MAX_FLUSH_ATTEMPTS}): ${String(err)}`,
        );
        if (attempts >= MAX_FLUSH_ATTEMPTS) {
          this._flushAttempts.delete(peerId);
          this._dropFrames(peerId, undelivered, 'flush-failed');
        } else {
          this._prependFrames(peerId, undelivered);
        }
        conn.close();
      });
    });
  }

  /**
   * The socket a batch should be written to right now.
   *
   * With a pool, the pool's answer is the only one that counts: a connection the
   * pool has replaced is a connection whose writes the peer may never read, and
   * `null` means "wait for the next announcement" rather than "use the one you
   * were given". Without a pool there is nothing to resolve — the caller's socket
   * is the only one in existence (the shutdown and unit paths).
   */
  private _resolveWriteConnection(peerId: number, fallback: PeerConnection | null): PeerConnection | null {
    if (!this.pool) return fallback;
    return this.pool.tryGetConnection(peerId);
  }

  /**
   * Ask for the peer's buffer to be drained as soon as its queue reaches the front.
   *
   * The flush is a link in the same per-peer queue every frame goes through, so
   * the frames buffered before it are written before it and the frames submitted
   * after it are written after it. Doing the flush inline — which is what the
   * buffer used to do — put it in front of a frame that was still being
   * compressed, and that frame then arrived last.
   */
  private _scheduleFlush(peerId: number): void {
    if (this._flushScheduled.has(peerId)) return;
    this._flushScheduled.add(peerId);
    this._enqueueSend(peerId, () => {
      this._flushScheduled.delete(peerId);
      if (!this.pool) {
        this._drainPending(peerId);
        return;
      }
      // The batch resolves its own connection when its turn comes; the pool's
      // answer here would be a snapshot of it.
      this._flushPending(peerId);
    });
  }

  /**
   * Append a link to a peer's send queue.
   *
   * Every write this class performs for a peer goes through here once it has a
   * reason to be ordered — a frame in flight, or a backlog. Links run one at a
   * time in the order they were appended. The tail is stored already-settled: a
   * rejection would leave every later frame for this peer unwritten. Neither half
   * rejects — a failed compression falls back to the uncompressed payload and a
   * failed write is re-buffered — but a queue that can be poisoned by one frame is
   * a queue that will be.
   *
   * One entry per peer, dropped once its queue drains, so a transport that talked
   * to a thousand peers and then to none holds no frames.
   */
  private _enqueueSend(peerId: number, task: () => Promise<void> | void): void {
    const previous = this._sendChains.get(peerId) ?? Promise.resolve();
    const link = previous.then(task);
    const settled = link.catch(() => undefined);
    this._sendChains.set(peerId, settled);
    void settled.then(() => {
      if (this._sendChains.get(peerId) === settled) this._sendChains.delete(peerId);
    });
  }

  /**
   * Whether a frame submitted now has a queued predecessor to wait for.
   *
   * Only the queue is asked. A backlog in the buffer needs no gate here, because
   * the write path itself refuses to overtake one: `_doSendFrame` appends to the
   * buffer whenever it finds frames in it, and a frame appended at the tail is
   * behind everything already there by construction. The queue is the one thing
   * that cannot be ordered by appending — its head is a frame that has not been
   * written yet but was submitted earlier.
   */
  private _mustQueue(peerId: number): boolean {
    return this._sendChains.has(peerId);
  }

  /**
   * Fire-and-forget frame delivery, in submission order.
   *
   * 1) Compress the payload (async, outside the WASM queue critical path).
   * 2) Delegate to _doSendFrame for the actual connection lookup + write.
   *    NEVER blocks the caller on TLS handshake or socket write.
   *
   * The two halves are queued **per peer** and in the order the frames were
   * handed over, because zstd runs on libuv's thread pool: `compress()` resolves
   * when a worker is free rather than when it was asked. Writing the frame inside
   * that callback made the wire order the *completion* order, and a frame handed
   * over first could be read last. A framed stream carries one promise about
   * order — first in, first read — and both layers above this one act on it: Raft
   * asks a follower to append after an index it has not sent yet, and the CDC
   * consumer applies changes in arrival order, so an overtaking frame becomes a
   * change applied out of order in another datacenter. Observed on a loaded CI
   * runner as `1,2,3,5,4,6,7,3,5,4,…` — reordered *and* duplicated.
   *
   * One chain per peer, and each link does both halves: the write is the part
   * that has to be ordered, so it cannot be in a second queue that the
   * compressor's callbacks enter in their own order. Peers never wait for each
   * other — this is a per-peer queue, not a global lock.
   *
   * A frame the compressor would pass through untouched — compression off, or a
   * payload under the threshold, which is most Raft frames — and that has nothing
   * older to wait behind takes no queue at all: there is no async step to reorder
   * anything and no predecessor to overtake, so the write stays exactly where it
   * was. The queue exists for the defect and is absent everywhere the defect
   * could not be. {@link _mustQueue} is the other half of that sentence: a frame
   * with a reason to be ordered joins the queue even when its payload is small,
   * because the frame it would overtake is not the one being compressed.
   */
  private _sendFrame(peerId: number, frame: Buffer, isHeartbeat: boolean): void {
    if (!this.pool) throw new Error('Transport not started');

    const payload = frame.subarray(4); // Strip 4-byte length header for compression
    const needsCompression = this._compressionEnabled && payload.length >= this._compressor.getThreshold();

    if (!needsCompression && !this._mustQueue(peerId)) {
      this._writeFrame(peerId, payload, isHeartbeat);
      return;
    }

    this._enqueueSend(peerId, () => this._compressAndWrite(peerId, payload, isHeartbeat, needsCompression));
  }

  /**
   * One link of a peer's send queue: compress if the payload needs it, then write.
   *
   * A frame that joined the queue for order alone skips the compression step. It
   * is here because something older was in flight, not because of its size, and
   * compressing it would make the queue longer without making the wire smaller.
   */
  private async _compressAndWrite(
    peerId: number,
    payload: Buffer,
    isHeartbeat: boolean,
    needsCompression: boolean,
  ): Promise<void> {
    let compressedPayload: Buffer = payload;
    if (needsCompression) {
      try {
        compressedPayload = await this._compressor.compress(payload);
      } catch (err: unknown) {
        // The frame still has to go out: the peer decides whether it is compressed
        // from the magic bytes rather than from a flag the two sides have to agree
        // on, so an uncompressed frame is a frame the peer understands.
        console.warn('[RaftTcpTransport] Compression failed, sending uncompressed:', err);
        compressedPayload = payload;
      }
    }
    this._writeFrame(peerId, compressedPayload, isHeartbeat);
  }

  /** Prefix the four-byte length header and hand the frame to the write path. */
  private _writeFrame(peerId: number, payload: Buffer, isHeartbeat: boolean): void {
    if (!this.pool) {
      this._drainPending(peerId);
      return; // Transport stopped during async compression
    }
    const newHeader = Buffer.alloc(4);
    newHeader.writeUInt32BE(payload.length, 0);
    this._doSendFrame(peerId, Buffer.concat([newHeader, payload]), isHeartbeat);
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

    // An older frame is still waiting for delivery. Writing this one now would put
    // it in the peer's hands before its predecessor, and everything above this
    // layer acts on arrival order, so it takes its place in the buffer instead and
    // the buffer is drained first.
    if ((this._pendingMessages.get(peerId)?.length ?? 0) > 0) {
      if (isHeartbeat) return; // State, not an event; the next one is newer.
      this._bufferFrame(peerId, frame);
      this._scheduleFlush(peerId);
      return;
    }

    const conn = this.pool.tryGetConnection(peerId);
    if (!conn) {
      if (isHeartbeat) return; // Idempotent — drop.
      // Buffer critical messages (Append, Vote, PreVote etc.) for delivery
      // when the connection is re-established (flushed in onConnectionCreated).
      this._bufferFrame(peerId, frame);
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
      // The frame did not reach the peer. A warning and nothing else is the one
      // recovery that cannot work: the entry is in the leader's log, its
      // predecessor is on the wire, and the follower will never be told about it.
      // It goes back to the front of the buffer — older than anything buffered
      // since — and the next connection drains it in order. The socket's own
      // close/error events handle cleanup (_onDisconnect → _scheduleRetry); this
      // path never force-closes, because that triggers a cascade where both sides
      // destroy the same socket at once.
      console.warn('[RaftTcpTransport] Frame write failed, re-buffering:', err);
      if (isHeartbeat) return;
      this._prependFrames(peerId, [frame]);
      this._scheduleFlush(peerId);
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
      this.pool
        .onIncoming(peerId, socket)
        .then((conn) => {
          if (!conn) {
            socket.destroy();
            return;
          }
        })
        .catch((err) => {
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

  /**
   * Decode the frames in one chunk of a peer's stream, after any chunk before it.
   *
   * `data` events on one socket are delivered one after another, but this method
   * awaits — zstd decompression runs on libuv's thread pool — and an `await`
   * inside a handler that the event loop calls again is a re-entrant handler. Two
   * chunks in flight meant two loops reading the same per-peer accumulation
   * buffer: the second one took a frame the first had not finished with, decoded
   * that frame ahead of its predecessor, and the run that produced the inversion
   * in the CDC suite delivered 91 messages for the 40 that were sent.
   *
   * So the chunks of a peer are queued, and each one decodes only once the chunk
   * before it is fully decoded. Peers stay independent: a slow decompression for
   * one peer does not hold another peer's frames.
   *
   * Returns the promise for this chunk, so a caller that wants to know when the
   * frame has been emitted still can.
   */
  private _processData(peerId: number, data: Buffer): Promise<void> {
    const previous = this._processChains.get(peerId) ?? Promise.resolve();
    const link = previous.then(() => this._drainFrames(peerId, data));
    // The queue is stored already-settled so one undecodable chunk cannot stop
    // the peer's stream, and the caller still receives the real rejection.
    const settled = link.catch(() => undefined);
    this._processChains.set(peerId, settled);
    void settled.then(() => {
      if (this._processChains.get(peerId) === settled) this._processChains.delete(peerId);
    });
    return link;
  }

  /** The body of one queue link: append the chunk, then decode every whole frame in it. */
  private async _drainFrames(peerId: number, data: Buffer): Promise<void> {
    // Use a static buffer for accumulation
    const bufKey = `peer:${peerId}`;
    const accumulated = Buffer.concat([this._buffers.get(bufKey) || Buffer.alloc(0), data]);
    // The split happens before the first decode, and the remainder is stored before
    // it too: a frame whose payload fails to decode is still consumed, which is
    // what the loop this replaces did — it advanced the buffer and then decoded.
    const { frames, rest } = splitFrames(accumulated);
    this._buffers.set(bufKey, rest);

    for (const frame of frames) {
      const payloadLen = frame.length - FRAME_HEADER_BYTES;

      // Special: empty frame (heartbeat)
      if (payloadLen === 0) {
        this.emit('heartbeat', { from: peerId });
        continue;
      }

      // Decode message
      try {
        let payload = frame.subarray(FRAME_HEADER_BYTES);

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

/**
 * The whole frames at the head of `buffer`, and the bytes that are not one yet.
 *
 * The walk is bounded by the bytes rather than by a cursor: a frame carries at
 * least its four-byte header, so a buffer of `n` bytes holds at most `n / 4` of
 * them, and that count is arithmetic — it is known before the first frame is
 * read and cannot be moved by anything the walk does. What this replaces was
 * `while (true) { … accumulated = accumulated.subarray(frameLen); }`, where the
 * two halves of that step are each other's only check: `4 - payloadLen` makes
 * `subarray` clamp to zero for any payload longer than three bytes, so the buffer
 * never shrinks and the loop never ends — a synchronous spin inside a socket
 * handler, which is a silence in the report rather than a failed test (P3-75).
 *
 * Past the point where the work is done the slots are no-ops, so a buffer holding
 * one 64 kB frame pays sixteen thousand empty calls, not sixteen thousand slices.
 */
function splitFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;
  Array.from({ length: Math.floor(buffer.length / FRAME_HEADER_BYTES) }, () => {
    if (offset + FRAME_HEADER_BYTES > buffer.length) return;
    const frameLen = FRAME_HEADER_BYTES + buffer.readUInt32BE(offset);
    if (offset + frameLen > buffer.length) return;
    frames.push(buffer.subarray(offset, offset + frameLen));
    offset += frameLen;
  });
  return { frames, rest: buffer.subarray(offset) };
}
