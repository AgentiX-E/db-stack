import type { TransportMessage } from './TransportMessage';
import type { InboundMessage } from './InboundMessage';
import type { PeerInfo, TransportStats } from '../types';

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

  /**
   * The incarnation this transport stamps on every frame it sends.
   *
   * Optional because a transport that does not have one is exactly the case the
   * receiver has to handle: a peer that cannot name its incarnation is counted
   * (`epochless`) rather than refused. A composition root reports this rather
   * than inventing a second number, so the epoch on the wire and the epoch in a
   * status page cannot disagree.
   */
  getEpoch?(): number;
}
