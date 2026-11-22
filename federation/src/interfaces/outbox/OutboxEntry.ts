import type { IHLCTimestamp } from '../hlc/IHLCTimestamp';

export interface OutboxEntry {
  /** Unique entry ID */
  id: string;

  /**
   * Caller-visible message ID.
   *
   * The store indexes it alongside `id` so an ACK can arrive under either
   * name (see `OutboxStore._indexById`). Optional: entries written without one
   * are addressable by `id` only.
   */
  msgId?: string;

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

  /**
   * When this entry first failed, which is what the retry window is measured
   * from — not `createdAt`, because an entry that waited a minute in a queue
   * behind a busy peer has not spent that minute failing.
   *
   * Absent on entries written before the field existed; the store fills it in
   * on the first failure it records.
   */
  firstFailedAt?: number | null;

  /**
   * The earliest moment the pump may try this entry again.
   *
   * A retry loop that fires on every pump tick is not a retry budget, it is a
   * busy loop: at a 20 ms interval a peer that is down for a second is asked
   * fifty times. The backoff grows the wait per attempt, capped, and this field
   * is where the answer lives so the queue can stay FIFO while it waits.
   */
  nextAttemptAt?: number | null;
}

export type OutboxStatus = 'pending' | 'delivered' | 'failed';

/**
 * Input accepted by `add()` / `addBatch()`.
 *
 * The store assigns `id`, always writes a fresh entry with status `pending`,
 * zeroed attempt tracking and no error, and defaults `createdAt` to "now", so
 * none of those fields are part of the caller's contract.
 */
export type OutboxEntryInput = Omit<
  OutboxEntry,
  'id' | 'status' | 'createdAt' | 'lastAttemptAt' | 'attemptCount' | 'lastError' | 'firstFailedAt' | 'nextAttemptAt'
> & {
  /** Overrides the store-assigned creation timestamp (defaults to now). */
  createdAt?: number;
};
