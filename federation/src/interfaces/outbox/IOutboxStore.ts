import type { OutboxEntry } from './OutboxEntry';
import type { OutboxStats } from '../types';

export interface IOutboxStore {
  /**
   * Add a new outbox entry.
   * Returns the created entry with its assigned ID.
   */
  add(entry: Omit<OutboxEntry, 'id'>): Promise<OutboxEntry>;

  /**
   * Add a batch of outbox entries in a single LMDB transaction.
   * Returns array of created entries with assigned IDs.
   * D3 optimization: up to 5x throughput vs serial add().
   */
  addBatch?(entries: Array<Omit<OutboxEntry, 'id'>>): OutboxEntry[];

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
   * Get outbox store statistics.
   */
  getStats(): OutboxStats | Promise<OutboxStats>;
}
