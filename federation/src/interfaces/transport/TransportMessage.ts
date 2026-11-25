import type { IHLCTimestamp } from '../hlc/IHLCTimestamp';

export interface TransportMessage {
  /** Unique message ID (UUID or similar) */
  messageId: string;

  /** Source peer identifier */
  sourcePeerId: string;

  /** Target peer identifier (empty string for broadcast) */
  targetPeerId: string;

  /** Message payload as bytes */
  payload: Uint8Array;

  /** HLC timestamp for causal ordering */
  timestamp: IHLCTimestamp;

  /** Message creation timestamp (wall clock ms) */
  createdAt: number;

  /** Optional message type identifier */
  type?: string;

  /**
   * The incarnation of the node that produced this frame.
   *
   * Stamped by the transport, not by the sender of the change: which process a
   * frame came from is a property of the channel it left through, and a caller
   * that had to remember to stamp it would be a caller that can forget. Absent on
   * a frame from a build that predates the promise; see `IncarnationLedger` for
   * what the receiver does with each case.
   */
  sourceEpoch?: number;
}
