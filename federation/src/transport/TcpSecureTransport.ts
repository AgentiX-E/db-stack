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

/**
 * The envelope this gateway puts on the wire around a federation payload.
 *
 * Not `FederationEnvelope`: `@agentix-e/db-cluster` publishes a wire type of that name
 * whose ids are decimal strings and whose discriminator is a numeric `msgType`.
 * This one is the federation gateway's own frame — a text `type`, numeric `term`,
 * and an opaque payload — and exporting it under the cluster type's name would
 * hand a consumer the wrong shape for the wrong transport.
 */
export interface FederationEnvelope {
  type: string;
  term: number;
  from: string;
  to: string;
  /**
   * The incarnation of the sender: `Date.now()` at construction unless the
   * deployment names one. Absent on a frame from a build that predates this
   * field, which the receiver counts rather than refuses.
   */
  epoch?: number;
  payload: unknown;
}

type MessageHandler = (msg: FederationEnvelope) => void;

/** Structural subset of `RaftTcpTransport` this class relies on. */
export interface IRaftTransport {
  send(fromId: number, msgs: FederationEnvelope[]): Promise<void>;
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
  /**
   * Whether a frame would reach a live socket rather than an in-memory buffer.
   * Absent on doubles that have no sockets to inspect.
   */
  canReach?(peerId: number): boolean;
  /** Detach a handler installed with `onMessage`. */
  offMessage?(handler: MessageHandler): void;
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
  /**
   * The incarnation this node stamps on every frame. Defaults to `Date.now()` at
   * construction.
   *
   * Set it when the guarantee matters more than the default: a datacenter that is
   * rebuilt from a backup, or redeployed on a host whose clock is behind the one
   * it had, would otherwise take a number that reads as *older* to its peers and
   * have every frame refused. The number is a promise the deployment can keep;
   * the default is the best one available without asking.
   */
  epoch?: number;
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
  /**
   * The resolved peer list, computed once.
   *
   * Deriving it again on every reconnect meant re-running the wire-id rules —
   * which can now throw on a configuration that cannot be addressed — inside a
   * fire-and-forget path where the failure would surface as an unhandled
   * rejection rather than as the configuration error it is.
   */
  private readonly peers: Array<TcpSecureTransportPeer & { transportNodeId: number }>;
  private started = false;
  private _messagesSent = 0;
  private _messagesReceived = 0;
  private _bytesSent = 0;
  private _bytesReceived = 0;
  private _uptimeStart = 0;
  /** Reason the most recent `send()` was refused, for diagnostics. */
  private _lastSendError: string | null = null;
  /** The incarnation stamped on every frame this transport sends. */
  private readonly epoch: number;

  // ── Reconnection state ──
  private readonly _retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly _attemptCount = new Map<string, number>();
  private readonly _maxRetries = 5;

  constructor(config: TcpSecureTransportConfig) {
    this.config = config;
    this._uptimeStart = Date.now();
    this.epoch = config.epoch ?? Date.now();
    this.localId = requireNumericId(config.nodeId, config.transportNodeId, 'node');

    const peers = resolvePeers(config, this.localId);
    const clash = peers.find((peer) => peer.transportNodeId === this.localId);
    if (clash) {
      // Two nodes addressed by one wire id are one node as far as the transport
      // is concerned: every frame this node sends to that peer is addressed to
      // itself and dropped, and the peer's frames arrive here as if they were
      // local. Nothing reports it — `send()` returns true into a routing table
      // that has one entry where there should be two — so it has to be refused
      // while the configuration is still in someone's hands.
      throw new Error(
        `Wire id ${this.localId} names both this node (${config.nodeId}) and peer ${clash.nodeId}; ` +
          'give one of them an explicit transportNodeId',
      );
    }

    this.peers = peers;
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
   *
   * Returns a promise that settles when the attempt is over. It used to return
   * `void` while the work was asynchronous, which made every failure inside it
   * an unhandled rejection: `reconnect('typo')` looked like a call that did
   * nothing, and the transport's own guards were untestable because breaking
   * them produced no observable failure. Callers that only want to arm the
   * channel can ignore the promise; callers that want to know can await it.
   */
  reconnect(peerId: string): Promise<void> {
    return this._connectToPeer(peerId);
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
    const delay = retryDelayMs(attempt, baseMs, maxMs, this._maxRetries);

    // One lookup, one guard. The previous shape consulted `numericByLogical`
    // first and then searched `resolvePeers()` again, which made the `!peer`
    // branch unreachable — a second call to a pure function cannot disagree with
    // the first unless the config changed underneath it — while still allocating
    // a peer list on every reconnect.
    const peer = this.peers.find((p) => p.nodeId === peerId);
    if (!peer || typeof this.transport.register !== 'function') {
      return;
    }

    try {
      this.transport.register({
        id: peer.transportNodeId,
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

  /**
   * Stop the transport, detach the inbound bridge and clear all retry timers.
   *
   * The bridge is detached even when the transport was never started. It is
   * registered in the constructor, so an object that was built and then
   * destroyed without starting — a failed configuration, a test, a node that
   * shuts down during bootstrap — used to keep a handler on the inner transport
   * for as long as that transport lived, holding this instance with it. The
   * early return now covers only the inner `stop()`, which is the part that
   * needs a start to undo.
   */
  async stop(): Promise<void> {
    const wasStarted = this.started;
    this.started = false;
    this.unsubFromRaft();

    for (const timer of this._retryTimers.values()) clearTimeout(timer);
    this._retryTimers.clear();
    this._attemptCount.clear();

    if (!wasStarted) return;
    await this.transport.stop();
  }

  /** Send a single message to one peer. Returns false when undeliverable. */
  async send(msg: TransportMessage): Promise<boolean> {
    if (!this.started) {
      this._lastSendError = 'transport not started';
      return false;
    }

    const targetId = this.numericByLogical.get(msg.targetPeerId);
    if (targetId === undefined) {
      // An address that is not a configured peer used to be given a derived wire
      // id and handed to the transport, which either buffered it forever or sent
      // it to whatever node happened to hold that number. A message to an
      // unknown peer is a routing error and has to be reported as one.
      this._lastSendError = `peer ${msg.targetPeerId} is not a configured peer`;
      return false;
    }

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
    //
    // Prefer the transport's live check over its status snapshot. The snapshot
    // is refreshed by the pool's disconnect handler, so for up to a second after
    // a peer goes away it still lists that peer; `canReach` asks the socket.
    const reachable = this.transport.canReach
      ? this.transport.canReach(targetId)
      : (this.transport.getStatus?.()?.connectedPeers.includes(targetId) ?? true);
    const status = this.transport.canReach ? null : this.transport.getStatus?.();
    if ((status && !status.connectedPeers.includes(targetId)) || (this.transport.canReach && !reachable)) {
      this._lastSendError = `peer ${msg.targetPeerId} (${targetId}) not reachable`;
      // Arm the channel while refusing the message. The outbox retries the
      // delivery, and each retry has to be able to make the peer reachable
      // again; a refusal that only reports the failure leaves recovery to a
      // timer that may already have given up.
      this._connectToPeer(msg.targetPeerId);
      return false;
    }

    const raftMsg: FederationEnvelope = {
      type: 'federation_send',
      term: 1,
      from: String(this.localId),
      to: String(targetId),
      // On the header, not in the body: the epoch is a property of the frame that
      // carries a change, and a body is something a sender can choose to send.
      epoch: this.epoch,
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

  /** The incarnation this transport stamps on every frame it sends. */
  getEpoch(): number {
    return this.epoch;
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
        // A peer on a build that predates the field sends nothing here, and
        // `undefined` is the honest answer: this node cannot name that incarnation.
        sourceEpoch: typeof raftMsg.epoch === 'number' ? raftMsg.epoch : undefined,
      };

      for (const subscriber of this.messageHandlers) subscriber(inbound);
    };

    this.transport.onMessage(handler);
    return () => {
      // Detach from the inner emitter. The previous body was empty and its
      // comment claimed `RaftTcpTransport` cleared the handler set on stop() —
      // it does not, so a stopped transport kept this object alive through the
      // closure and a restarted one delivered every inbound message twice.
      this.transport.offMessage?.(handler);
    };
  }
}

/**
 * Delay before the next attempt to a peer whose last attempt was refused.
 *
 * `maxRetries` bounds the *fast* attempts, not the lifetime of the channel:
 * past the budget the interval is capped at `maxMs` rather than the
 * reconnection being abandoned, because a datacenter that is down is not a
 * datacenter that was deleted.
 *
 * Exported because the boundary is the interesting part — attempt `maxRetries`
 * still doubles, attempt `maxRetries + 1` is capped — and reaching it through
 * `setTimeout` meant timing a timer to assert a number.
 *
 * @internal
 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number, maxRetries: number): number {
  return attempt > maxRetries ? maxMs : Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
}

/**
 * Normalise the two accepted peer shapes into one list with numeric ids.
 *
 * A peer's wire id is derived from its logical id with the same function that
 * derives this node's, not from its position in the list. Position-based ids
 * were the source of a defect that made a documented configuration unusable:
 * `peers: [{ nodeId: 'dc-east' }]` gave the peer id 1 by position while this
 * node derived its own id from `'dc-west'`, which also fell back to 1 — so both
 * ends of a two-datacenter link claimed to be node 1, the routing table had one
 * entry for two nodes, and nothing ever connected. Deriving from the id makes
 * the two ends agree by construction, because both compute it from the same
 * input.
 */
function resolvePeers(
  config: TcpSecureTransportConfig,
  localId: number,
): Array<TcpSecureTransportPeer & { transportNodeId: number }> {
  // The legacy address list carries no identities, only positions, so both the
  // logical and the wire id are synthesised. Numbering by position alone made
  // `nodeId: 'node-1'` — the id this project's own tests use — collide with its
  // first peer, which the transport then treated as the same node. Synthetic
  // numbers skip the local one.
  let synthetic = 1;
  const nextSynthetic = (): number => {
    while (synthetic === localId) synthetic += 1;
    return synthetic++;
  };

  const peers: Array<TcpSecureTransportPeer & { transportNodeId: number }> =
    config.peers && config.peers.length > 0
      ? config.peers.map((peer) => ({
          ...peer,
          transportNodeId: requireNumericId(peer.nodeId, peer.transportNodeId, 'peer'),
        }))
      : (config.peerAddresses ?? []).map((address) => ({
          nodeId: `node-${nextSynthetic()}`,
          host: extractHost(address),
          port: extractPort(address),
          transportNodeId: synthetic - 1,
        }));

  const seen = new Map<number, string>();
  for (const peer of peers) {
    const owner = seen.get(peer.transportNodeId);
    if (owner !== undefined) {
      throw new Error(
        `Wire id ${peer.transportNodeId} names both peer ${owner} and peer ${peer.nodeId}; ` +
          'give one of them an explicit transportNodeId',
      );
    }
    seen.set(peer.transportNodeId, peer.nodeId);
  }

  return peers;
}

/**
 * Map a logical node id to the numeric id used on the wire, or `null` when the
 * id carries no number to take.
 *
 * The contract this replaces was a silent fallback to the constant 1: every
 * digit-free node id — `dc-west`, `eu-central`, `us-east` — became wire id 1, so
 * two datacenters configured exactly as the documentation shows both claimed to
 * be node 1, the routing table held one entry where there should have been two,
 * and nothing ever connected.
 *
 * Guessing is not the fix. `RaftTcpTransport._handleIncoming` derives the
 * identity of an inbound connection from the certificate's common name
 * (`raft-node-<id>`), which means the wire id is not a local choice — it is a
 * fact about the certificate, and any value chosen here that disagrees with it
 * produces a peer that cannot be reached and an error that blames the network.
 * Returning `null` lets the constructor refuse the configuration with the one
 * sentence the user needs: give this node a `transportNodeId` that matches its
 * certificate, or put the number in its id.
 */
function deriveNumericId(nodeId: string): number | null {
  const digits = nodeId.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  const parsed = parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The id, or the diagnosis. Never a guess that disagrees with the certificate. */
function requireNumericId(nodeId: string, explicit: number | undefined, role: string): number {
  if (explicit !== undefined) return explicit;
  const derived = deriveNumericId(nodeId);
  if (derived === null) {
    throw new Error(
      `${role} ${nodeId} has no number in its id, so its wire id cannot be derived; pass an explicit ` +
        'transportNodeId that matches the number in its certificate common name (raft-node-<n>)',
    );
  }
  return derived;
}

function extractHost(address: string): string {
  const [host] = address.split(':');
  return host && host.length > 0 ? host : '127.0.0.1';
}

function extractPort(address: string): number {
  const port = parseInt(address.split(':')[1] ?? '', 10);
  return Number.isNaN(port) ? 7000 : port;
}
