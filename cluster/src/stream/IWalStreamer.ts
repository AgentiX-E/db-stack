/**
 * IWalStreamer — WAL Streaming interface.
 *
 * Converts Raft write-ahead log entries into structured stream events
 * that can be consumed by downstream systems (CDC, audit, replication).
 *
 * Key capabilities:
 *   - Tail: real-time streaming of new entries as they are appended
 *   - Replay: historical range replay from a start index
 *   - Filter: subscribe to specific command types or data patterns
 *   - Catch-up: auto-resume from last acknowledged position
 */

import type { LogEntry } from "../interfaces/types";
import type { IWalStorage } from "../interfaces/wal/IWalStorage";

/**
 * A structured event emitted from the WAL stream.
 * Wraps the raw LogEntry with stream-level metadata.
 */
export interface StreamEvent {
  /** Monotonically increasing stream sequence number */
  sequence: number;
  /** The original Raft log entry */
  entry: LogEntry;
  /** Wall-clock time when the event was emitted into the stream */
  emittedAt: number;
  /** The shard/group this event belongs to */
  groupId: string;
}

/**
 * Filters applied to WAL streaming subscriptions.
 * All filters are AND-combined; empty/undefined = no filter.
 */
export interface StreamFilter {
  /** Only emit events with these command types */
  commands?: string[];
  /** Only emit events where entry.data matches this predicate (injected at subscribe time) */
  dataMatch?: (data: unknown) => boolean;
  /** Minimum term to emit */
  minTerm?: number;
  /** Skip entries before this index (for catch-up) */
  fromIndex?: number;
}

/**
 * Acknowledgment from a subscriber, used for at-least-once delivery.
 */
export interface StreamAck {
  /** Subscriber ID */
  subscriberId: string;
  /** Last successfully processed sequence number */
  sequence: number;
  /** Last successfully processed Raft index */
  entryIndex: number;
}

/**
 * Subscription handle returned when subscribing to the WAL stream.
 */
export interface StreamSubscription {
  /** Unique subscription identifier */
  id: string;
  /** The filter applied to this subscription */
  filter: StreamFilter;
  /** Whether the subscription is active */
  active: boolean;
  /** Total events emitted to this subscription */
  eventsEmitted: number;
  /** Last acknowledged sequence */
  lastAckedSequence: number;
}

/**
 * Callback invoked for each matching StreamEvent.
 * Return a Promise — the streamer waits for it before advancing (backpressure).
 */
export type StreamHandler = (event: StreamEvent) => Promise<void>;

/**
 * Optional WAL streaming configuration.
 */
export interface WalStreamConfig {
  /** Maximum events buffered per subscriber before backpressure applies. Default: 1000 */
  maxBufferSize: number;
  /** Polling interval for new entries during tail (ms). Default: 100 */
  pollIntervalMs: number;
  /** Maximum replay batch size (entries per fetch). Default: 500 */
  replayBatchSize: number;
  /** If true, emit full entry data; if false, emit only metadata. Default: true */
  emitData: boolean;
}

// ── IWalStreamer ───────────────────────────────────────────

export interface IWalStreamer {
  // ── Lifecycle ─────────────────────────────────────────────

  /** Initialize the streamer with a WAL storage backend and optional config. */
  init(storage: IWalStorage, config?: Partial<WalStreamConfig>): Promise<void>;

  /** Start streaming (begin tailing new entries). */
  start(): Promise<void>;

  /** Stop streaming and close all subscriptions. */
  stop(): Promise<void>;

  /** Whether the streamer is currently active. */
  readonly active: boolean;

  // ── Subscription ───────────────────────────────────────────

  /**
   * Subscribe to the WAL stream with an optional filter.
   * Returns a subscription handle that can be used to unsubscribe or query status.
   */
  subscribe(
    subscriberId: string,
    handler: StreamHandler,
    filter?: StreamFilter,
  ): Promise<StreamSubscription>;

  /**
   * Unsubscribe and release resources for a subscription.
   */
  unsubscribe(subscriptionId: string): Promise<void>;

  // ── Replay ────────────────────────────────────────────────

  /**
   * Replay historical entries from `fromIndex` (inclusive) to `toIndex` (inclusive).
   * Events are delivered to the provided handler directly (bypasses subscriptions).
   * Returns total events replayed.
   */
  replay(
    fromIndex: number,
    toIndex: number,
    handler: StreamHandler,
    filter?: StreamFilter,
  ): Promise<number>;

  // ── Position Tracking ─────────────────────────────────────

  /**
   * Acknowledge that a subscriber has processed up to a given sequence/entry.
   * Used for at-least-once delivery and catch-up resume.
   */
  ack(ack: StreamAck): Promise<void>;

  /**
   * Get the current stream position (highest sequence number emitted).
   */
  getPosition(): Promise<{ sequence: number; entryIndex: number }>;

  /**
   * Get the lag (unacknowledged events) for a subscriber.
   */
  getLag(subscriberId: string): Promise<number>;

  /**
   * Get all active subscriptions.
   */
  getSubscriptions(): Promise<StreamSubscription[]>;

  // ── Catch-up ──────────────────────────────────────────────

  /**
   * Determine the catch-up range: from the subscriber's last ack position
   * to the current end of the WAL. Returns the range and replays it
   * through the subscriber's handler.
   */
  catchUp(subscriberId: string): Promise<number>;
}
