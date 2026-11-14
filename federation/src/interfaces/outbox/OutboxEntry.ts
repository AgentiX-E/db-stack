import type { IHLCTimestamp } from '../hlc/IHLCTimestamp';

export interface OutboxEntry {
  /** Unique entry ID */
  id: string;

  /** Target peer(s) to deliver to */
  targetPeerIds: string[];

  /** Message payload as bytes */
  payload: Uint8Array;

  /** HLC timestamp for ordering */
  timestamp: IHLCTimestamp;

  /** Message type identifier */
  type: string;

  /** Status of the entry */
  status: OutboxStatus;

  /** When the entry was created (wall clock ms) */
  createdAt: number;

  /** When the entry was last attempted (wall clock ms) */
  lastAttemptAt: number | null;

  /** Number of delivery attempts so far */
  attemptCount: number;

  /** Error message from last failed attempt */
  lastError: string | null;
}

export type OutboxStatus = 'pending' | 'delivered' | 'failed';
