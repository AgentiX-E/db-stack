/**
 * A partition a test can turn on and off, over whatever transport a node has.
 *
 * Isolating a node in-process used to mean stopping it, which is not a partition: a
 * stopped node is a dead node, and a cluster's reaction to a dead node (its sockets
 * close, sends fail with ECONNREFUSED) is a different fault from a network that
 * silently drops packets. This wrapper models the silent one.
 *
 * A blocked send does not reject. It answers with a refusal of the request's own
 * kind at term 0, which is the closest in-process shape of a packet that vanished:
 * raft-core's replication path is written for answers, and a thrown error inside a
 * heartbeat loop is a different event from silence. Getting the *kind* right matters
 * — answering a `RequestVote` with an `AppendEntries` message is not a dropped
 * message, it is a malformed one that only reads as a rejection by accident.
 *
 * Inbound requests from a blocked peer are refused the same way, so isolation is
 * symmetric: a node that cannot be reached cannot answer either. Half-open isolation
 * is the shape that makes a "partitioned" follower keep up with its leader.
 */
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';

export interface PartitionStats {
  /** Outbound requests handed to the wrapped transport. */
  forwarded: number;
  /** Outbound requests refused because the peer is blocked. */
  blocked: number;
  /** Inbound requests delivered to the registered handler. */
  delivered: number;
  /** Inbound requests refused because the sender is blocked. */
  refused: number;
}

/** The reply a dropped request gets: same kind, term 0, no success. */
export function refusal(request: RPCMessage): RPCMessage {
  switch (request.type) {
    case 'RequestVote':
      return { type: 'RequestVote', direction: 'response', payload: { term: 0, voteGranted: false } };
    case 'InstallSnapshot':
      return { type: 'InstallSnapshot', direction: 'response', payload: { term: 0, success: false } };
    default:
      return { type: 'AppendEntries', direction: 'response', payload: { term: 0, success: false } };
  }
}

export class PartitionTransport implements Transport {
  private readonly inner: Transport;
  private readonly blockedPeers = new Set<number>();
  private isolateAll = false;
  private stats: PartitionStats = { forwarded: 0, blocked: 0, delivered: 0, refused: 0 };

  constructor(inner: Transport) {
    this.inner = inner;
    if (inner.addPeer) this.addPeer = (peerId, address) => inner.addPeer!(peerId, address);
    if (inner.removePeer) this.removePeer = (peerId) => inner.removePeer!(peerId);
  }

  /** The wrapped transport, so a chain of wrappers can be walked. */
  get underlying(): Transport {
    return this.inner;
  }

  /** Block every peer when called with no argument, or the listed ones. */
  isolate(peers?: number[]): void {
    if (!peers || peers.length === 0) {
      this.isolateAll = true;
      return;
    }
    for (const peer of peers) this.blockedPeers.add(peer);
  }

  /** Restore both directions. */
  heal(): void {
    this.isolateAll = false;
    this.blockedPeers.clear();
  }

  /** Whether `peerId` (or every peer, when omitted) is currently blocked. */
  isIsolated(peerId?: number): boolean {
    if (this.isolateAll) return true;
    return peerId !== undefined && this.blockedPeers.has(peerId);
  }

  /** The blocked peers, in ascending order. Empty when everything is blocked. */
  get blocked(): number[] {
    return [...this.blockedPeers].sort((a, b) => a - b);
  }

  getStats(): PartitionStats {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  isStarted(): boolean {
    return this.inner.isStarted();
  }

  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    if (this.isIsolated(Number(peerId))) {
      this.stats.blocked++;
      return refusal(message);
    }
    this.stats.forwarded++;
    return this.inner.send(peerId, message);
  }

  onMessage(handler: MessageHandler): void {
    this.inner.onMessage(async (from: NodeId, message: RPCMessage) => {
      if (this.isIsolated(Number(from))) {
        this.stats.refused++;
        return refusal(message);
      }
      this.stats.delivered++;
      return handler(from, message);
    });
  }

  /** Present only while the wrapped transport supports it, as raft-core expects. */
  declare addPeer?: (peerId: NodeId, address: string) => Promise<void>;

  /** Present only while the wrapped transport supports it. */
  declare removePeer?: (peerId: NodeId) => void;
}
