import type { TransportMessage } from "./TransportMessage";
import type { InboundMessage } from "./InboundMessage";
import type { PeerInfo, TransportStats } from "../types";

export interface ITransport {
  /**
   * Send a message to a specific peer.
   * Returns true if the message was successfully enqueued for delivery.
   */
  send(message: TransportMessage): Promise<boolean>;

  /**
   * Broadcast a message to all connected peers.
   * Returns the number of peers the message was sent to.
   */
  broadcast(message: TransportMessage): Promise<number>;

  /**
   * Register a callback for incoming messages.
   * Returns a function to unsubscribe the callback.
   */
  onMessage(callback: (message: InboundMessage) => void): () => void;

  /**
   * Get the list of currently connected peers.
   */
  getConnectedPeers(): PeerInfo[];

  /**
   * Get transport layer statistics.
   */
  getStats(): TransportStats;
}
