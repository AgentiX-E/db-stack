/**
 * ICDCSink — Change Data Capture (CDC) sink interface.
 *
 * A CDC sink consumes change events emitted by the federation layer.
 * Implementations can write to external systems, message queues, or
 * in-memory stores for testing.
 *
 * The event a sink receives is `CDCSinkEvent`, not `CDCEvent`. The package used
 * to declare `CDCEvent` here and a *different* `CDCEvent` in `core/CDCManager`
 * (that one carrying `eventId`/`sourceDc`/`hlcTimestamp`), and neither could be
 * exported from the package root without the other disappearing: two shapes,
 * one name, which is the collision iteration 50 found between two classes both
 * called `CDCManager`. The sink side is named for where it lands now.
 */

/**
 * A single change event as it is handed to a sink.
 */
export interface CDCSinkEvent {
  /** Unique event identifier */
  id: string;
  /** Type of change */
  type: 'insert' | 'update' | 'delete';
  /** Table or collection name */
  table: string;
  /**
   * Primary key of the changed record.
   *
   * Empty when the producing engine's change event carried no key column:
   * `CDCChangeEvent` has `oldValues`/`newValues` and nothing that says which of
   * their fields identifies the row, so the default projection in
   * `CDCSubscriptionPump` does not guess. Supply `project` to derive one.
   */
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
   * Throw to refuse the batch. A sink that returns normally has accepted it;
   * `CDCSubscriptionPump` turns a throw into a retry and, once the retry budget
   * is spent, into a recorded failure — it never treats a refusal as success.
   *
   * @param events - The events to emit
   */
  emit(events: CDCSinkEvent[]): Promise<void>;
}
