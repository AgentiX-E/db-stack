/**
 * BatchedRaftTransport — Adapter for @maboke123/raft-core Transport interface
 *
 * Wraps RaftTcpTransport (message routing by msg.to) into request-response mode.
 *
 * Adds requestId at wire level to match requests to responses. Serializes as JSON Buffer,
 * Uses RaftTcpTransport.sendToPeer() to send directly to target peer.
 */

import { RaftTcpTransport, RaftTcpTransportConfig } from './RaftTcpTransport';
import type { Transport, MessageHandler, RPCMessage } from '@maboke123/raft-core';
import { MessageCodec } from './MessageCodec.js';

let _reqIdCounter = 0;
function nextRequestId(): string {
  return `${process.pid}-${++_reqIdCounter}`;
}

interface PendingEntry {
  resolve: (msg: RPCMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One snapshot chunk on the wire: where it starts and whether it is the last. */
interface SnapshotChunk {
  offset: number;
  done: boolean;
}

/** The snapshot transfer currently allowed to use a peer's link. */
interface SnapshotTransfer {
  offset: number;
  lastChunkAt: number;
}

/**
 * Reads the chunk coordinates out of an `InstallSnapshot` request.
 *
 * Returns `null` for anything else, including a malformed payload, so a message
 * that is not a snapshot chunk can never accidentally take part in the
 * single-flight rule below.
 */
function readSnapshotChunk(message: RPCMessage): SnapshotChunk | null {
  if ((message as { type?: unknown })?.type !== 'InstallSnapshot') return null;
  const payload = (message as { payload?: { offset?: unknown; done?: unknown } }).payload;
  if (!payload || typeof payload.offset !== 'number' || typeof payload.done !== 'boolean') return null;
  return { offset: payload.offset, done: payload.done };
}

/*
 * Frames are built by `MessageCodec`, not here.
 *
 * This file used to carry its own copy of the 5-byte header and its own
 * `JSON.stringify`, which meant a fix to one framer did not reach the other —
 * and the copy here is the one that carries `InstallSnapshot` chunks, whose
 * `data` is raw bytes. See `MessageCodec` for why JSON framing silently emptied
 * them.
 */

/**
 * What a transport has actually done, per peer.
 *
 * A peer that never answers looks identical to a peer that answers "no": both
 * leave the leader's `nextIndex` where it was, and neither is visible from the
 * cluster's own state. The counters separate them — `timedOut` and `failed` mean
 * nothing came back, `answered` means something did.
 */
export interface TransportPeerStats {
  /** Requests written to the wire. */
  sent: number;
  /** Requests that came back with a response. */
  answered: number;
  /** Requests that were still unanswered when the request timeout fired. */
  timedOut: number;
  /** Requests whose send threw before an answer could arrive. */
  failed: number;
  /** AppendEntries answers that said "my log matches yours". */
  accepted: number;
  /** AppendEntries answers that said "it does not" - the only signal that moves `nextIndex`. */
  rejected: number;
  /** Answers of any other kind, so the three counters always add up to `answered`. */
  other: number;
  /** Answer types as they arrived, for the case where a name is not what it looks like. */
  byType: Record<string, number>;
}

/**
 * Split a `host:port` transport address, or answer `null` when it is not one.
 *
 * Membership changes carry an address as a string (`RaftNode.addServer(nodeId,
 * address)`), and the transport needs a host and a port. Parsing is strict on
 * purpose: a silent fallback to a default port would dial a different node than the
 * one the operator named, which is worse than refusing the change.
 *
 * IPv6 literals are accepted in the bracketed form (`[::1]:7000`), because that is
 * the only form in which the last colon is not ambiguous.
 */
function parsePeerAddress(address: string): { host: string; port: number } | null {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0) return null;
  const rawHost = trimmed.slice(0, separator);
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const port = Number(trimmed.slice(separator + 1));
  if (host.length === 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export class BatchedRaftTransport implements Transport {
  private transport: RaftTcpTransport;

  /** Per-peer counters; see {@link TransportPeerStats}. */
  private readonly stats = new Map<string, TransportPeerStats>();
  private handler: MessageHandler | null = null;
  private pendingMap = new Map<string, PendingEntry>();
  private started = false;
  readonly requestTimeoutMs: number;

  /**
   * The one snapshot transfer allowed to be in flight per peer.
   *
   * raft-core issues `sendSnapshot` from the heartbeat loop, which does not
   * await its peers (`for (const peer of allPeers) this.sendAppendEntries(peer)`),
   * and it does not guard a transfer that is already running. Two transfers to
   * the same peer therefore interleave on the wire, and the follower resets its
   * chunk assembly on *every* `offset === 0` — so transfer B's first chunk wipes
   * out transfer A's progress, A's next chunk arrives at an offset the receiver
   * no longer expects, both are answered `success: false`, and the next heartbeat
   * starts the same race again. Snapshots larger than raft-core's fixed 256 KiB
   * chunk size then *never* install: there is no interleaving-free window to
   * succeed in. Smaller snapshots hide the defect, because a single-chunk
   * transfer has no assembly state to lose.
   *
   * Only the first chunk of a competing transfer is refused (`offset === 0`):
   * chunks that continue the accepted transfer are the traffic we want, and the
   * refusal is cheap for raft-core — it aborts that transfer and retries on the
   * next heartbeat, by which time the accepted one has usually finished.
   */
  private snapshotTransfers = new Map<number, SnapshotTransfer>();

  /** How long a transfer may go without a chunk before its claim goes stale. */
  private readonly snapshotTransferLeaseMs: number;

  constructor(config: RaftTcpTransportConfig, requestTimeoutMs = 15000) {
    this.transport = new RaftTcpTransport(config);
    this.requestTimeoutMs = requestTimeoutMs;
    // One chunk's round trip is bounded by `requestTimeoutMs`, so a transfer that
    // has not sent a chunk in twice that has been abandoned (its leader stepped
    // down, or the caller threw between chunks). Without an expiry a single
    // abandoned claim would block snapshots to that peer for the process's life.
    this.snapshotTransferLeaseMs = 2 * requestTimeoutMs;
  }

  get underlying(): RaftTcpTransport {
    return this.transport;
  }

  async addPeer(peerId: string, address: string): Promise<void> {
    const id = Number(peerId);
    if (!Number.isInteger(id) || id <= 0) {
      // raft-core identifies peers by string; a non-numeric id cannot be a member of
      // this cluster, whose membership is numeric. Registering it would dial an
      // address that no frame can ever carry a sane id for.
      console.warn(`[BatchedRaftTransport] Ignoring peer with non-numeric id ${JSON.stringify(peerId)}`);
      return;
    }
    const parsed = parsePeerAddress(address);
    if (!parsed) {
      console.warn(`[BatchedRaftTransport] Ignoring peer ${id}: address ${JSON.stringify(address)} is not host:port`);
      return;
    }
    this.transport.register({ id, host: parsed.host, port: parsed.port });
  }

  removePeer(peerId: string): void {
    const id = Number(peerId);
    if (!Number.isInteger(id) || id <= 0) return;
    this.transport.unregister(id);
  }

  /**
   * Whether a socket to `peerId` exists within `timeoutMs`.
   *
   * The membership decision, separated from {@link addPeer}: raft-core calls
   * `addPeer` without awaiting it and from a hook that would turn a rejection into
   * an unhandled one, so registration must never fail. Whether a node can actually
   * be replicated to is a different question, asked by the adapter before it
   * commits a configuration that names the node.
   */
  async awaitPeer(peerId: string, timeoutMs: number): Promise<boolean> {
    const id = Number(peerId);
    if (!Number.isInteger(id) || id <= 0) return false;
    return this.transport.awaitPeerConnection(id, timeoutMs);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.transport.on('message', (msg: any, fromPeerId: string) => {
      this.onIncoming(msg, fromPeerId);
    });
    await this.transport.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const [, entry] of this.pendingMap) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Transport stopped'));
    }
    this.pendingMap.clear();
    this.snapshotTransfers.clear();
    await this.transport.stop();
  }

  isStarted(): boolean {
    return this.started;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Counters for one peer, created on first use. */
  private statsFor(peerId: string): TransportPeerStats {
    let entry = this.stats.get(peerId);
    if (!entry) {
      entry = {
        sent: 0,
        answered: 0,
        timedOut: 0,
        failed: 0,
        accepted: 0,
        rejected: 0,
        other: 0,
        byType: {},
      };
      this.stats.set(peerId, entry);
    }
    return entry;
  }

  /** What this transport has done per peer. Safe to call at any time. */
  getStats(): Record<string, TransportPeerStats> {
    const out: Record<string, TransportPeerStats> = {};
    for (const [peer, entry] of this.stats) out[peer] = { ...entry };
    return out;
  }

  /** Send RPC request and wait for response. */
  async send(peerId: string, message: RPCMessage): Promise<RPCMessage> {
    const requestId = nextRequestId();
    const counts = this.statsFor(peerId);
    counts.sent += 1;
    const peerNumId = parseInt(peerId, 10);
    if (isNaN(peerNumId)) throw new Error(`Invalid peer id: ${peerId}`);

    const chunk = readSnapshotChunk(message);
    if (chunk) this.claimSnapshotTransfer(peerNumId, chunk);

    let answered = false;
    try {
      const response = await this.sendFrame(peerNumId, requestId, message);
      answered = true;
      counts.answered += 1;
      return response;
    } catch (err) {
      if (err instanceof Error && err.message.includes('request timeout')) counts.timedOut += 1;
      else counts.failed += 1;
      throw err;
    } finally {
      if (chunk) this.settleSnapshotTransfer(peerNumId, chunk, answered);
    }
  }

  /** One request-response round trip; separated from `send` so `send` can bracket it. */
  private sendFrame(peerNumId: number, requestId: string, message: RPCMessage): Promise<RPCMessage> {
    return new Promise<RPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMap.delete(requestId);
        reject(new Error(`Raft transport request timeout: ${message.type} to ${peerNumId}`));
      }, this.requestTimeoutMs);

      this.pendingMap.set(requestId, { resolve, reject, timer });

      // Build wire frame: { requestId, msg }
      const frame = MessageCodec.encode({ requestId, msg: message });
      this.transport.sendToPeer(peerNumId, frame);
    });
  }

  /**
   * Take the peer's snapshot slot for `chunk`, or refuse a competing transfer.
   *
   * Throws for a second `offset === 0` chunk while a live transfer holds the
   * slot: forwarding it would reset the receiver's assembly and destroy the
   * transfer already in progress, so failing this one fast is the only outcome
   * that leaves the peer able to catch up at all.
   */
  private claimSnapshotTransfer(peer: number, chunk: SnapshotChunk): void {
    const now = Date.now();
    const active = this.snapshotTransfers.get(peer);

    if (active && now - active.lastChunkAt <= this.snapshotTransferLeaseMs) {
      if (chunk.offset === 0) {
        throw new Error(
          `Refusing to start a second snapshot transfer to peer ${peer}: one is already in progress ` +
            `(offset ${active.offset}, last chunk ${now - active.lastChunkAt}ms ago). ` +
            'Overlapping transfers reset the receiver chunk assembly and both abort, so a snapshot ' +
            'larger than one chunk could never install.',
        );
      }
      active.offset = chunk.offset;
      active.lastChunkAt = now;
      return;
    }

    this.snapshotTransfers.set(peer, { offset: chunk.offset, lastChunkAt: now });
  }

  /**
   * Release the peer's slot when the transfer ended, or on failure.
   *
   * A failed chunk means the accepted transfer is over — raft-core aborts the
   * whole transfer on a failed response or a thrown send — so the next attempt
   * must be free to start from offset 0 immediately.
   */
  private settleSnapshotTransfer(peer: number, chunk: SnapshotChunk, answered: boolean): void {
    if (chunk.done || !answered) {
      this.snapshotTransfers.delete(peer);
    }
  }

  async waitForConnections(): Promise<void> {
    await this.transport.waitForConnections();
  }

  /** Handle inbound messages */
  private onIncoming(wireMsg: any, fromPeerId: string): void {
    if (!this.started) return;

    const requestId = wireMsg?.requestId;
    const inner = requestId ? wireMsg.msg : wireMsg;

    // Response direction: match pending request
    if (requestId && inner?.direction === 'response') {
      const pending = this.pendingMap.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMap.delete(requestId);
        const counts = this.statsFor(fromPeerId);
        const kind = String(inner?.type ?? 'none');
        counts.byType[kind] = (counts.byType[kind] ?? 0) + 1;
        if (inner?.type === 'AppendEntries' && inner.direction === 'response') {
          const payload = (inner as { payload?: { success?: boolean; matchIndex?: number } }).payload;
          if (payload?.success) counts.accepted += 1;
          else counts.rejected += 1;
        } else {
          counts.other += 1;
        }
        pending.resolve(inner);
      }
      return;
    }

    // Request direction: forward to handler
    if (!this.handler) return;

    this.handler(fromPeerId, inner)
      .then((response: RPCMessage) => {
        if (!response || !this.started) return;

        const respRequestId = requestId || nextRequestId();
        const respPeerNumId = parseInt(fromPeerId, 10);
        if (isNaN(respPeerNumId)) return;

        const frame = MessageCodec.encode({ requestId: respRequestId, msg: response });
        this.transport.sendToPeer(respPeerNumId, frame);
      })
      .catch((err: unknown) => {
        console.warn('[BatchedRaftTransport] Handler error:', err);
      });
  }
}
