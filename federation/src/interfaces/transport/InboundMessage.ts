import type { TransportMessage } from './TransportMessage';

/**
 * An inbound message that has been received from the transport layer.
 * Extends TransportMessage with reception metadata.
 */
export interface InboundMessage extends TransportMessage {
  /** Timestamp when the message was received (wall clock ms) */
  receivedAt: number;

  /** Round-trip latency in ms (if available) */
  rttMs?: number;
}
