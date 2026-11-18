/**
 * Records the moment a *real* transport completed a round trip with a peer.
 *
 * This is the only honest evidence that a leader still has a majority: the peer's
 * transport answered. The placement is therefore part of the contract, not a
 * detail — this wrapper must be the **innermost** one, the one touching the sockets.
 * Anywhere further out, a fault injection layer that answers a dropped message with
 * a fabricated reply would look exactly like a healthy peer, and a partitioned
 * leader would keep claiming a quorum it had just lost.
 *
 * `send` is observed only after the inner promise resolves: a rejected send is a
 * message that did not arrive, which is precisely the event that must not be
 * recorded as contact.
 */
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';

export class ObservedTransport implements Transport {
  private readonly inner: Transport;
  private readonly observe: (peerId: number) => void;

  constructor(inner: Transport, observe: (peerId: number) => void) {
    this.inner = inner;
    this.observe = observe;
    if (inner.addPeer) this.addPeer = (peerId, address) => inner.addPeer!(peerId, address);
    if (inner.removePeer) this.removePeer = (peerId) => inner.removePeer!(peerId);
  }

  /** The wrapped transport, so a chain of wrappers can be walked. */
  get underlying(): Transport {
    return this.inner;
  }

  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    const answer = await this.inner.send(peerId, message);
    const peer = Number(peerId);
    // raft-core identifies peers by string; membership is numeric. A peer id that is
    // not a number is not a member of any cluster, and dropping it keeps an
    // unexpected id from inflating a majority.
    if (Number.isFinite(peer)) {
      try {
        this.observe(peer);
      } catch {
        // Bookkeeping must never fail a completed RPC: turning a healthy round trip
        // into a transport failure would be a strictly worse outcome than a missed
        // observation, and the caller's callback is the bug, not the message.
      }
    }
    return answer;
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

  onMessage(handler: MessageHandler): void {
    this.inner.onMessage(handler);
  }

  /**
   * Present only while the wrapped transport supports it, because raft-core branches
   * on whether the method exists: a wrapper that always defines it converts "this
   * transport cannot add peers" into a failed start.
   */
  declare addPeer?: (peerId: NodeId, address: string) => Promise<void>;

  /** Present only while the wrapped transport supports it. */
  declare removePeer?: (peerId: NodeId) => void;
}
