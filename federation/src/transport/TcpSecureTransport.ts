/**
 * TcpSecureTransport — mTLS-secured TCP transport implementing `ITransport`.
 *
 * Wraps db-cluster's `RaftTcpTransport` (TLS 1.3 + mutual certificate
 * verification) so federation traffic between datacenters is encrypted and
 * authenticated at the wire level.
 *
 * Identity model
 * --------------
 * Federation speaks in *logical* peer ids (`"dc-east-1"`), while the Raft
 * transport needs *numeric* ids. This class owns that mapping:
 *
 *   - `nodeId`                   logical id of this node
 *   - `transportNodeId`          numeric id on the wire (default: digits of nodeId, else 1)
 *   - `peers[].nodeId`           logical id of a remote node
 *   - `peers[].transportNodeId`  numeric id (default: index + 1)
 *
 * `listen` defaults to 127.0.0.1:0 — the kernel picks a free port and the real
 * port is exposed via `getLocalAddress()`. Deriving the local address from a
 * peer address (the previous behaviour) made co-located nodes collide on one
 * port and never bind a listener of their own.
 */

import type { ITransport } from '../interfaces/transport/ITransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { PeerInfo, TransportStats } from '../interfaces/types';
import { RaftTcpTransport } from '@agentix-e/db-cluster';
import { makeHLC } from '../hlc/HLC';
import type { RaftTcpTransportConfig } from '@agentix-e/db-cluster';

// ── Raft message shape used on the wire ──

interface RaftMessage {
  type: string;
  term: number;
  from: string;
  to: string;
  payload: unknown;
}

type MessageHandler = (msg: RaftMessage) => void;

/** Structural subset of `RaftTcpTransport` this class relies on. */
interface IRaftTransport {
  send(fromId: number, msgs: RaftMessage[]): Promise<void>;
  register?(node: { id: number; host: string; port: number }): void;
  onMessage: (handler: MessageHandler) => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Numeric ids (or `{ nodeId }` records) of peers with a live connection. */
  getConnectedPeers?(): Array<number | { nodeId?: string | number; peerId?: string }>;
  getStatus?(): {
    connectedPeers: number[];
    totalPeers: number;
    started: boolean;
  };
  getBoundPort?(): number;
}

export interface TcpSecureTransportPeer {
  /** Logical peer id (e.g. `"dc-west-1"`). */
  nodeId: string;
  host: string;
  port: number;
  /** Numeric id on the wire. Defaults to the peer's position + 1. */
  transportNodeId?: number;
}

export interface TcpSecureTransportConfig {
  /** Local node identity. */
  nodeId: string;
  /** Numeric wire id for this node. Defaults to the digits in `nodeId`, else 1. */
  transportNodeId?: number;
  /** Local listen address. Defaults to `127.0.0.1:0` (ephemeral port). */
  listen?: { host: string; port: number };
  /** Peers, including their TLS-reachable addresses. */
  peers?: TcpSecureTransportPeer[];
  /**
   * Legacy address list (`"host:port"`). Peer numeric ids are assigned as
   * index + 1 and logical ids default to `node-<index+1>`.
   */
  peerAddresses?: string[];
  /** TLS material: node certificate, private key, and the CA to verify peers. */
  tls: {
    cert: string | Buffer;
    key: string | Buffer;
    ca: string | Buffer;
  };
  /** Connection timeout in ms (default 5000). */
  connectTimeoutMs?: number;
  /** Initial retry interval in ms for reconnection (default 100). */
  initialRetryMs?: number;
  /** Max retry interval in ms (default 30000). */
  maxRetryMs?: number;
  /** Test seam: inject a pre-built Raft transport instead of opening sockets. */
  _transportOverride?: IRaftTransport;
}

export class TcpSecureTransport implements ITransport {
  private readonly config: TcpSecureTransportConfig;
  private readonly transport: IRaftTransport;
  private readonly messageHandlers = new Set<(msg: InboundMessage) => void>();
  private readonly unsubFromRaft: () => void;
  private readonly localId: number;
  /** numeric wire id → logical peer id */
  private readonly logicalByNumeric = new Map<number, string>();
  /** logical peer id → numeric wire id */
  private readonly numericByLogical = new Map<string, number>();
  private started = false;
  private _messagesSent = 0;
  private _messagesReceived = 0;
  private _bytesSent = 0;
  private _bytesReceived = 0;
  private _uptimeStart = 0;
  /** Reason the most recent `send()` was refused, for diagnostics. */
  private _lastSendError: string | null = null;

  // ── Reconnection state ──
  private readonly _retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly _attemptCount = new Map<string, number>();
  private readonly _maxRetries = 5;

  constructor(config: TcpSecureTransportConfig) {
    this.config = config;
    this._uptimeStart = Date.now();
    this.localId = config.transportNodeId ?? deriveNumericId(config.nodeId);

    const peers = resolvePeers(config);
    for (const peer of peers) {
      this.logicalByNumeric.set(peer.transportNodeId, peer.nodeId);
      this.numericByLogical.set(peer.nodeId, peer.transportNodeId);
    }

    if (config._transportOverride) {
      this.transport = config._transportOverride;
    } else {
      const raftConfig: RaftTcpTransportConfig = {
        node: {
          id: this.localId,
          host: config.listen?.host ?? '127.0.0.1',
          port: config.listen?.port ?? 0,
        },
        peers: peers.map((p) => ({
          id: p.transportNodeId,
          host: p.host,
          port: p.port,
        })),
        tls: { cert: config.tls.cert, key: config.tls.key, ca: config.tls.ca },
        connectTimeoutMs: config.connectTimeoutMs ?? 5000,
        initialRetryMs: config.initialRetryMs ?? 100,
        maxRetryMs: config.maxRetryMs ?? 30000,
      };
      this.transport = new RaftTcpTransport(raftConfig) as unknown as IRaftTransport;
    }

    this.unsubFromRaft = this.setupMessageBridge();
  }

  /**
   * Initiate (or re-initiate) a connection to a given peer, with exponential
   * backoff on failure.
   */
  reconnect(peerId: string): void {
    this._connectToPeer(peerId);
  }

  private async _connectToPeer(peerId: string): Promise<void> {
    const existing = this._retryTimers.get(peerId);
    if (existing) {
      clearTimeout(existing);
      this._retryTimers.delete(peerId);
    }

    const attempt = (this._attemptCount.get(peerId) ?? 0) + 1;
    this._attemptCount.set(peerId, attempt);

    const baseMs = this.config.initialRetryMs ?? 100;
    const maxMs = this.config.maxRetryMs ?? 30000;
    // `_maxRetries` bounds the *fast* attempts, not the lifetime of the channel.
    // It used to end reconnection outright, so a datacenter that was down for
    // longer than the fast backoff budget (~3 s at the defaults) never came back
    // without a process restart — the outbox kept the entries and had no way to
    // deliver them. Past the budget the interval is capped instead of abandoned.
    const delay = attempt > this._maxRetries ? maxMs : Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);

    const numericId = this.numericByLogical.get(peerId);
    if (numericId === undefined || typeof this.transport.register !== 'function') {
      return;
    }

    const peer = resolvePeers(this.config).find((p) => p.nodeId === peerId);
    if (!peer) return;

    try {
      this.transport.register({
        id: numericId,
        host: peer.host,
        port: peer.port,
      });
      this._attemptCount.set(peerId, 0);
    } catch {
      const timer = setTimeout(() => {
        this._retryTimers.delete(peerId);
        this._connectToPeer(peerId);
      }, delay);
      this._retryTimers.set(peerId, timer);
    }
  }

  /** Start listening and accept inbound mTLS connections. */
  async start(): Promise<void> {
    if (this.started) return;
    this._uptimeStart = Date.now();
    await this.transport.start();
    this.started = true;
  }

  /** Stop the transport and clear all retry timers. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubFromRaft();

    for (const timer of this._retryTimers.values()) clearTimeout(timer);
    this._retryTimers.clear();
    this._attemptCount.clear();

    await this.transport.stop();
  }

  /** Send a single message to one peer. Returns false when undeliverable. */
  async send(msg: TransportMessage): Promise<boolean> {
    if (!this.started) {
      this._lastSendError = 'transport not started';
      return false;
    }

    const targetId = this.numericByLogical.get(msg.targetPeerId) ?? deriveNumericId(msg.targetPeerId);

    // Delivery confirmation, part of the at-least-once contract.
    //
    // `RaftTcpTransport.send()` is fire-and-forget: with no live socket it
    // buffers the frame in memory and resolves successfully. Reporting that as
    // a delivered message made the outbox drop entries addressed to an
    // unreachable DC (they were marked delivered and never replayed). Refuse
    // the send instead, so the outbox keeps the entry and retries with
    // backoff; the receiver's DedupRing keeps the retries idempotent.
    //
    // Only transports that expose a typed numeric peer list can be checked —
    // injected test doubles have no `getStatus()` and skip the guard.
    const status = this.transport.getStatus?.();
    if (status && !status.connectedPeers.includes(targetId)) {
      this._lastSendError = `peer ${msg.targetPeerId} (${targetId}) not connected`;
      // Arm the channel while refusing the message. The outbox retries the
      // delivery, and each retry has to be able to make the peer reachable
      // again; a refusal that only reports the failure leaves recovery to a
      // timer that may already have given up.
      this._connectToPeer(msg.targetPeerId);
      return false;
    }

    const raftMsg: RaftMessage = {
      type: 'federation_send',
      term: 1,
      from: String(this.localId),
      to: String(targetId),
      payload: {
        messageId: msg.messageId,
        sourcePeerId: msg.sourcePeerId,
        // The HLC wall clock is a BigInt; JSON.stringify throws on BigInt, and
        // the frame is JSON-encoded on the wire. Encode it losslessly as a
        // string and restore it in the receive bridge.
        timestamp: {
          wallTime: msg.timestamp.wallTime.toString(),
          logical: msg.timestamp.logical,
          nodeId: msg.timestamp.nodeId,
        },
        payload: Array.from(msg.payload),
        type: msg.type,
      },
    };

    try {
      await this.transport.send(this.localId, [raftMsg]);
      this._messagesSent++;
      this._bytesSent += msg.payload.byteLength;
      this._attemptCount.set(msg.targetPeerId, 0);
      return true;
    } catch (err: unknown) {
      this._lastSendError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this._connectToPeer(msg.targetPeerId);
      return false;
    }
  }

  /** Fan a message out to every currently connected peer. */
  async broadcast(msg: TransportMessage): Promise<number> {
    const peers = this.getConnectedPeers();
    if (peers.length === 0) return 0;

    const results = await Promise.allSettled(peers.map((peer) => this.send({ ...msg, targetPeerId: peer.peerId })));
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(callback: (msg: InboundMessage) => void): () => void {
    this.messageHandlers.add(callback);
    return () => {
      this.messageHandlers.delete(callback);
    };
  }

  /** Peers with a live TLS connection, in logical id space. */
  getConnectedPeers(): PeerInfo[] {
    // Prefer the transport's dedicated accessor (numeric ids in production,
    // arbitrary records in test doubles); fall back to the status snapshot.
    const raw = this.transport.getConnectedPeers?.() ?? this.transport.getStatus?.().connectedPeers ?? [];

    return raw.map((peer) => {
      const peerId = this._toLogicalId(peer);
      return {
        peerId,
        address: '',
        connectedAt: this._uptimeStart,
        latencyMs: 0,
        nodeId: peerId,
      } as PeerInfo & { nodeId: string };
    });
  }

  /** Normalise a numeric wire id or a `{ nodeId }` record into a logical id. */
  private _toLogicalId(peer: number | { nodeId?: string | number; peerId?: string }): string {
    if (typeof peer === 'number') {
      return this.logicalByNumeric.get(peer) ?? String(peer);
    }
    const explicit = peer.peerId ?? peer.nodeId;
    if (explicit === undefined) return '';
    const asString = String(explicit);
    // A record carrying a numeric wire id still needs the logical mapping.
    const asNumber = Number(asString);
    if (/^\d+$/.test(asString) && this.logicalByNumeric.has(asNumber)) {
      return this.logicalByNumeric.get(asNumber)!;
    }
    return asString;
  }

  /** Reason the most recent `send()` was refused (null when it succeeded). */
  getLastSendError(): string | null {
    return this._lastSendError;
  }

  /** Address this node is actually listening on (port resolved after start). */
  getLocalAddress(): { host: string; port: number } {
    return {
      host: this.config.listen?.host ?? '127.0.0.1',
      port: this.transport.getBoundPort?.() ?? this.config.listen?.port ?? 0,
    };
  }

  getStats(): TransportStats {
    return {
      peersConnected: this.getConnectedPeers().length,
      messagesSent: this._messagesSent,
      messagesReceived: this._messagesReceived,
      bytesSent: this._bytesSent,
      bytesReceived: this._bytesReceived,
      uptimeMs: Date.now() - this._uptimeStart,
    };
  }

  /** Stop and drop all subscribers. */
  destroy(): void {
    void this.stop();
    this.messageHandlers.clear();
  }

  private setupMessageBridge(): () => void {
    const handler: MessageHandler = (raftMsg) => {
      this._messagesReceived++;
      const payload = raftMsg.payload as Record<string, unknown>;
      const bytes = payload?.payload;

      this._bytesReceived += Array.isArray(bytes) ? bytes.length : 0;

      const wireTimestamp = payload?.timestamp as
        { wallTime?: string | number; logical?: number; nodeId?: string } | undefined;

      const inbound: InboundMessage = {
        messageId: String(payload?.messageId ?? ''),
        sourcePeerId: String(payload?.sourcePeerId ?? raftMsg.from),
        targetPeerId: String(raftMsg.to),
        timestamp: makeHLC(
          BigInt(wireTimestamp?.wallTime ?? 0),
          Number(wireTimestamp?.logical ?? 0),
          String(wireTimestamp?.nodeId ?? raftMsg.from),
        ),
        payload: Array.isArray(bytes) ? new Uint8Array(bytes as number[]) : new Uint8Array(),
        createdAt: Date.now(),
        receivedAt: Date.now(),
        type: String(payload?.type ?? raftMsg.type),
      };

      for (const subscriber of this.messageHandlers) subscriber(inbound);
    };

    this.transport.onMessage(handler);
    return () => {
      // RaftTcpTransport clears its handler set on stop().
    };
  }
}

/** Normalise the two accepted peer shapes into one list with numeric ids. */
function resolvePeers(config: TcpSecureTransportConfig): Array<TcpSecureTransportPeer & { transportNodeId: number }> {
  if (config.peers && config.peers.length > 0) {
    return config.peers.map((peer, index) => ({
      ...peer,
      transportNodeId: peer.transportNodeId ?? index + 1,
    }));
  }

  return (config.peerAddresses ?? []).map((address, index) => ({
    nodeId: `node-${index + 1}`,
    host: extractHost(address),
    port: extractPort(address),
    transportNodeId: index + 1,
  }));
}

function deriveNumericId(nodeId: string): number {
  const digits = nodeId.replace(/[^0-9]/g, '');
  const parsed = parseInt(digits, 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

function extractHost(address: string): string {
  const [host] = address.split(':');
  return host && host.length > 0 ? host : '127.0.0.1';
}

function extractPort(address: string): number {
  const port = parseInt(address.split(':')[1] ?? '', 10);
  return Number.isNaN(port) ? 7000 : port;
}
