import type { OutboxEntry, OutboxEntryInput } from './OutboxEntry';
import type { OutboxStats } from '../types';

export interface IOutboxStore {
  /**
   * Add a new outbox entry.
   * Returns the created entry with its assigned ID.
   */
  add(entry: OutboxEntryInput): Promise<OutboxEntry>;

  /**
   * Add a batch of outbox entries in a single LMDB transaction.
   * Returns array of created entries with assigned IDs.
   * D3 optimization: up to 5x throughput vs serial add().
   */
  addBatch?(entries: OutboxEntryInput[]): OutboxEntry[];

  /**
   * Fetch the oldest pending entries (for delivery attempt).
   * Limited by count parameter. Optionally limit the iteration to prevent
   * unbounded memory usage for large pending queues.
   */
  fetchOldestPending(count: number, limit?: number): Promise<OutboxEntry[]>;

  /**
   * Mark an outbox entry as delivered.
   */
  markDelivered(entryId: string): Promise<void>;

  /**
   * Atomically fetch pending entries and flush them.
   * Combines fetchOldestPending + markDelivered in a single LMDB transaction.
   */
  fetchAndFlush?(count: number): OutboxEntry[];

  /**
   * Get the count of currently pending entries.
   */
  getPendingCount(): Promise<number>;

  /**
   * Mark an entry delivery attempt as failed.
   * Increments retry count. Returns true if the entry was moved to the dead
   * letter queue (max retries exceeded), false if still pending retry.
   */
  markFailed(entryId: string, error?: string): boolean;

  /**
   * Per-target backlog: entries still owed, and when the oldest was created.
   *
   * The creation time of the oldest entry is the only honest definition of
   * replication lag; a channel with an empty queue has none, however long ago
   * its last successful delivery was.
   */
  getPendingStats(): Record<string, { count: number; oldestCreatedAt: number | null }>;

  /**
   * Every dead lettered entry, newest last.
   *
   * The recovery scan needs to know whether the queue is non-empty before it
   * asks each target; `getDeadLetterStats().count` would do, but the entries
   * are what an operator wants to look at when they are not empty.
   */
  getDeadLetterEntries(): Array<OutboxEntry & { deadAt?: number }>;

  /**
   * Revive dead letters, optionally only those owed to one target.
   * Returns how many were revived.
   */
  retryDeadLetters(targetPeerId?: string): number;

  /**
   * Prune delivered and dead-lettered entries past their TTL.
   * Returns what it removed, because a silent prune is a silent loss.
   */
  housekeeping(): { delivered: number; deadLettered: number };

  /**
   * Get outbox store statistics.
   */
  getStats(): OutboxStats | Promise<OutboxStats>;
}
