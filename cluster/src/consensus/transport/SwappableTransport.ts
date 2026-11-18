/**
 * A transport whose inside can be replaced while a node keeps running.
 *
 * raft-core captures the `Transport` object it is constructed with. Replacing that
 * object afterwards — which is how fault injection and transport upgrades were
 * written — changes a field the library never reads again, so the new transport
 * receives nothing and the node quietly keeps using the old one. Measured on
 * 2026-11-18: a "partitioned" leader committed a write with every injector counter
 * at zero.
 *
 * This wrapper is the object raft-core holds from then on. `swap` re-points it, so a
 * change of transport is a change the library observes.
 *
 * Two details are the contract rather than the implementation:
 *
 * - **The inbound handler follows the swap.** raft-core registers exactly one
 *   message handler, once, at start. A seam that forwards sends but not the handler
 *   produces a node that answers nothing while looking correctly wired.
 * - **A swap does not stop the previous transport.** Installed transports are
 *   usually wrappers around the one they replace, so stopping it would kill the
 *   sockets the new chain depends on. Ownership stays with whoever installed it.
 */
import type { MessageHandler, NodeId, RPCMessage, Transport } from '@maboke123/raft-core';

export class SwappableTransport implements Transport {
  private inner: Transport | null;
  private handler: MessageHandler | null = null;

  constructor(inner: Transport | null) {
    this.inner = inner;
    this.syncCapabilities();
  }

  /**
   * Point every subsequent call at `next`.
   *
   * Nothing is started, stopped or closed here: the caller owns both transports.
   */
  swap(next: Transport | null): void {
    this.inner = next;
    if (next && this.handler) next.onMessage(this.handler);
    this.syncCapabilities();
  }

  /** The transport currently in use, or null when none is installed. */
  get underlying(): Transport | null {
    return this.inner;
  }

  async start(): Promise<void> {
    await this.requireInner('start').start();
  }

  async stop(): Promise<void> {
    // Stopping an empty seam is a no-op rather than an error: shutdown must be safe
    // from any state, including one in which init failed before installing anything.
    await this.inner?.stop();
  }

  isStarted(): boolean {
    return this.inner?.isStarted() ?? false;
  }

  async send(peerId: NodeId, message: RPCMessage): Promise<RPCMessage> {
    return this.requireInner('send').send(peerId, message);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
    this.inner?.onMessage(handler);
  }

  /**
   * Present only while the current transport supports it.
   *
   * `addPeer`/`removePeer` are optional in the transport interface, and raft-core
   * branches on whether the method exists. A wrapper that always defines it turns
   * "this transport cannot add peers" into a failing reconfiguration, and one that
   * silently ignores the call answers "added" for a peer nobody added. Declaring
   * absence as absence is the only version that keeps both callers honest.
   */
  declare addPeer?: (peerId: NodeId, address: string) => Promise<void>;

  /** Present only while the current transport supports it. */
  declare removePeer?: (peerId: NodeId) => void;

  /** Mirror the optional peer-management methods of the transport in use. */
  private syncCapabilities(): void {
    const inner = this.inner;
    if (inner?.addPeer) {
      this.addPeer = (peerId, address) => inner.addPeer!(peerId, address);
    } else {
      delete this.addPeer;
    }
    if (inner?.removePeer) {
      this.removePeer = (peerId) => inner.removePeer!(peerId);
    } else {
      delete this.removePeer;
    }
  }

  /** The transport in use, or a named error instead of a TypeError on null. */
  private requireInner(operation: string): Transport {
    if (!this.inner) {
      throw new Error(`SwappableTransport: no transport installed (${operation})`);
    }
    return this.inner;
  }
}
