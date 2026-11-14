import { LogEntry, OperationResult, SnapshotMeta } from '../types';

/**
 * Write-Ahead Log storage for durable, append-only log persistence.
 * Entries are written to LMDB for fast local access.
 */
export interface IWalStorage {
  /**
   * Append a single log entry. Returns the index assigned.
   */
  append(entry: Omit<LogEntry, 'index' | 'timestamp'>): Promise<OperationResult<number>>;

  /**
   * Append multiple log entries atomically.
   */
  appendBatch(entries: Omit<LogEntry, 'index' | 'timestamp'>[]): Promise<OperationResult<number[]>>;

  /**
   * Read a single entry by index.
   */
  read(index: number): Promise<OperationResult<LogEntry | null>>;

  /**
   * Read entries from `startIndex` to `endIndex` (exclusive).
   */
  readRange(startIndex: number, endIndex: number): Promise<OperationResult<LogEntry[]>>;

  /**
   * Get the last (highest index) entry in the log.
   */
  lastEntry(): Promise<OperationResult<LogEntry | null>>;

  /**
   * Get the current log length (number of entries).
   */
  length(): Promise<OperationResult<number>>;

  /**
   * Truncate the log to keep entries up to and including `lastIndex`.
   * Entries after `lastIndex` are discarded.
   */
  truncate(lastIndex: number): Promise<OperationResult>;

  /**
   * Delete all entries from index `start` onward.
   */
  deleteFrom(start: number): Promise<OperationResult>;

  /**
   * Store snapshot metadata.
   */
  storeSnapshot(meta: SnapshotMeta): Promise<OperationResult>;

  /**
   * Retrieve the latest snapshot metadata.
   */
  latestSnapshot(): Promise<OperationResult<SnapshotMeta | null>>;

  /**
   * Close the WAL and release resources.
   */
  close(): Promise<void>;
}
