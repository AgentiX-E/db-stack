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
}
