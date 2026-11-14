/**
 * ICDCSink — Change Data Capture (CDC) sink interface.
 *
 * A CDC sink consumes change events emitted by the federation layer.
 * Implementations can write to external systems, message queues, or
 * in-memory stores for testing.
 */

/**
 * A single change event captured from the data layer.
 */
export interface CDCEvent {
  /** Unique event identifier */
  id: string;
  /** Type of change */
  type: 'insert' | 'update' | 'delete';
  /** Table or collection name */
  table: string;
  /** Primary key of the changed record */
  key: string;
  /** The changed data (full record for insert/update, keys-only for delete) */
  data: Record<string, unknown>;
  /** HLC wall time when the change was captured */
  timestamp: bigint;
}

/**
 * CDC sink interface.
 */
export interface ICDCSink {
  /** Human-readable name of this sink */
  readonly name: string;

  /**
   * Connect to the sink destination.
   * Must be called before emit().
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the sink destination.
   * After disconnect, emit() will throw.
   */
  disconnect(): Promise<void>;

  /**
   * Emit change events to the sink.
   *
   * @param events - The events to emit
   */
  emit(events: CDCEvent[]): Promise<void>;
}
