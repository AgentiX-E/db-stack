/**
 * OutboxStore — Durable LMDB-backed outbox for cross-DC replication.
 *
 * Design principles (from sqlvec-db OutboxManager, stripped to essentials):
 *   1. Entries are written BEFORE returning to caller (crash-safe, WAL consistency)
 *   2. O(1) ACK/delivery tracking via msgId → index in separate databases
 *   3. At-least-once delivery: retry with dedup on the receiving side
 *   4. Dead letter queue: entries exceeding maxRetries (default: 3)
 *   5. Backpressure detection via LMDB map utilization (>80% triggers warning)
 *
 * Storage layout
 * --------------
 * All indexes live in ONE LMDB environment (`outbox.lmdb`) as named
 * sub-databases:
 *
 *   main        entry:<seq>          → OutboxEntry
 *   pending     pending:entry:<seq>  → seq            (FIFO delivery queue)
 *   delivery    delivered:<id>       → deliveredAt    (O(1) dedup / ACK)
 *   seq         seq                  → last sequence number
 *   dead-letter dlq:<id>             → OutboxEntry + deadAt
 *   msgid-seq   <entryId|msgId>      → seq            (reverse index for O(1) ACK)
 *
 * The previous layout opened six independent `lmdb` environments. Each
 * environment commits and fsyncs on its own, so a single `add()` performed
 * three separate write transactions (main / pending / reverse index) plus the
 * sequence bump — roughly 4 fsyncs per entry — and, worse, a crash between
 * them could leave an entry present in `main` but absent from `pending`
 * (durably persisted yet invisible to the delivery loop). One environment plus
 * one `transactionSync` per operation makes the write atomic across every
 * index and reduces it to a single fsync.
 *
 * Differences from sqlvec-db OutboxManager (more complex, per-target DC indices):
 *   - Federation OutboxStore is simpler: flat pending queue, no per-DC index
 *   - Multi-DC routing is handled at the MultiLeaderReplication layer, not in the store
 *   - No per-peer outbox work partitioning — the store is a shared durable queue
 */

import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry, OutboxEntryInput, OutboxStatus } from '../interfaces/outbox/OutboxEntry';
import type { OutboxStats } from '../interfaces/types';
import { open, type Database, type RootDatabase } from 'lmdb';
import * as path from 'path';
import * as fs from 'fs';

export interface OutboxStoreConfig {
  /** Path to the LMDB data directory */
  dataDir: string;
  /** Entry TTL (ms) before auto-housekeeping — default 14 days */
  ttlMs?: number;
  /** Max retries before moving to dead letter queue — default 3 */
  maxRetries?: number;
  /** Dead letter TTL (ms) before auto-cleanup — default 7 days */
  deadLetterTtlMs?: number;
  /** Main LMDB map size — default 1GB */
  mapSize?: number;
}

/** An outbox entry a target gave up on, with the moment it was parked. */
export type DeadLetterEntry = OutboxEntry & { deadAt?: number };
export class OutboxStore implements IOutboxStore {
  /** Single LMDB environment — every index below is a named sub-database. */
  private readonly root: RootDatabase;
  /** Main entry storage: entry:<seq> → OutboxEntry */
  private readonly mainDb: Database<OutboxEntry, string>;
  /** O(1) delivery index: delivered:<id> → timestamp */
  private readonly deliveryDb: Database<number, string>;
  /** Sequence counter database */
  private readonly seqDb: Database<number, string>;
  /** Dead letter queue: dlq:<id> → OutboxEntry */
  private readonly deadLetterDb: Database<DeadLetterEntry, string>;
  /** Pending index for O(1) sorted fetch: pending:entry:<seq> → seq */
  private readonly pendingDb: Database<number, string>;
  /** entryId → seq and msgId → seq reverse index for O(1) ACK lookup */
  private readonly msgIdToSeqDb: Database<number, string>;

  private readonly ttlMs: number;
  private readonly maxRetries: number;
  private readonly deadLetterTtlMs: number;
  private readonly mapSize: number;

  constructor(config: OutboxStoreConfig) {
    this.ttlMs = config.ttlMs ?? 14 * 24 * 60 * 60 * 1000;
    this.maxRetries = config.maxRetries ?? 3;
    this.deadLetterTtlMs = config.deadLetterTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.mapSize = config.mapSize ?? 1024 * 1024 * 1024;

    fs.mkdirSync(config.dataDir, { recursive: true });

    this.root = open({
      path: path.join(config.dataDir, 'outbox.lmdb'),
      mapSize: this.mapSize,
    });

    this.mainDb = this.root.openDB({ name: 'main' }) as Database<OutboxEntry, string>;
    this.deliveryDb = this.root.openDB({ name: 'delivery' }) as Database<number, string>;
    this.seqDb = this.root.openDB({ name: 'seq' }) as Database<number, string>;
    this.deadLetterDb = this.root.openDB({ name: 'dead-letter' }) as Database<DeadLetterEntry, string>;
    this.pendingDb = this.root.openDB({ name: 'pending' }) as Database<number, string>;
    this.msgIdToSeqDb = this.root.openDB({ name: 'msgid-seq' }) as Database<number, string>;
  }

  /**
   * Add a new outbox entry.
   * The entry is persisted to LMDB before the promise resolves (crash-safe).
   *
   * The write is a single transaction covering the entry, its pending-queue
   * slot and the reverse index, so an entry can never be durable in one index
   * and missing from another. Callers that need to amortise the commit cost
   * over many entries should use `addBatch()`.
   */
  async add(entry: OutboxEntryInput): Promise<OutboxEntry> {
    return this._insert([entry])[0]!;
  }

  /** Persist N entries atomically in a single LMDB write transaction. */
  private _insert(partials: OutboxEntryInput[]): OutboxEntry[] {
    const created: OutboxEntry[] = [];

    this.root.transactionSync(() => {
      let seq = this._readSeq();
      const now = Date.now();
      for (const partial of partials) {
        seq += 1;
        const id = `entry:${seq}`;
        const full: OutboxEntry = {
          ...partial,
          id,
          status: 'pending',
          createdAt: partial.createdAt ?? now,
          lastAttemptAt: null,
          attemptCount: 0,
          lastError: null,
        };

        this.mainDb.putSync(id, full);
        this.pendingDb.putSync(`pending:${id}`, seq);
        this._indexById(full, seq);
        created.push(full);
      }
      this.seqDb.putSync('seq', seq);
    });

    return created;
  }

  /**
   * Record both the entry id and (when present) the caller-visible message id
   * in the reverse index, so an ACK by either identifier stays O(1).
   */
  private _indexById(entry: OutboxEntry, seq: number): void {
    this.msgIdToSeqDb.putSync(entry.id, seq);
    const msgId = entry.msgId;
    if (typeof msgId === 'string' && msgId.length > 0) {
      this.msgIdToSeqDb.putSync(msgId, seq);
    }
  }

  /**
   * Add a batch of outbox entries in a single LMDB write transaction.
   *
   * D3 optimization: reduces LMDB transaction overhead by batching N entries
   * into one write transaction. Maintains same crash-safe guarantees as add().
   *
   * @param entries — Array of partial entries to persist
   * @returns Array of created OutboxEntry with assigned IDs
   */
  addBatch(entries: OutboxEntryInput[]): OutboxEntry[] {
    if (entries.length === 0) return [];
    return this._insert(entries);
  }

  /**
   * Atomically fetch pending entries and flush them.
   * Combines fetchOldestPending + markDelivered into a single operation
   * for throughput optimization.
   *
   * @param count — Max entries to fetch and flush
   * @returns Array of flushed entries
   */
  fetchAndFlush(count: number): OutboxEntry[] {
    const entries = this.fetchOldestPendingSync(count);
    const flushed: OutboxEntry[] = [];

    this.root.transactionSync(() => {
      for (const entry of entries) {
        this.deliveryDb.putSync(`delivered:${entry.id}`, Date.now());
        entry.status = 'delivered';
        entry.lastAttemptAt = Date.now();
        this.mainDb.putSync(entry.id, entry);
        this.pendingDb.removeSync(`pending:${entry.id}`);
        flushed.push(entry);
      }
    });

    return flushed;
  }

  /**
   * Synchronous version of fetchOldestPending.
   * Used internally by fetchAndFlush for atomic batching.
   */
  private fetchOldestPendingSync(count: number): OutboxEntry[] {
    const entries: OutboxEntry[] = [];
    const range = this.pendingDb.getRange({
      start: 'pending:',
      end: 'pending:\xff',
    });

    for (const item of range) {
      if (entries.length >= count) break;
      const seq = item.value as number;
      const entryKey = `entry:${seq}`;
      const entry = this.mainDb.get(entryKey) as OutboxEntry | undefined;
      if (entry && entry.status === 'pending') {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Fetch the oldest pending entries.
   * Sorts by entry ID (lexicographic seq order) to maintain FIFO ordering.
   * Accepts an optional `limit` to cap the number of entries scanned from
   * the pending index, preventing unbounded memory usage for large queues.
   */
  async fetchOldestPending(count: number, limit?: number): Promise<OutboxEntry[]> {
    const entries: OutboxEntry[] = [];
    const range = this.pendingDb.getRange({
      start: 'pending:',
      end: 'pending:\xff',
    });
    let scanned = 0;

    for (const item of range) {
      if (entries.length >= count) break;
      if (limit !== undefined && scanned >= limit) break;
      scanned++;
      const seq = item.value as number;
      const entryKey = `entry:${seq}`;
      const entry = this.mainDb.get(entryKey) as OutboxEntry | undefined;
      if (entry && entry.status === 'pending') {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Mark an outbox entry as delivered (O(1) via deliveryDb index).
   * Also updates the main entry for backward compatibility.
   */
  async markDelivered(entryId: string): Promise<void> {
    this.root.transactionSync(() => {
      this.deliveryDb.putSync(`delivered:${entryId}`, Date.now());

      const seq = this.msgIdToSeqDb.get(entryId) as number | undefined;
      if (seq !== undefined) {
        const entryKey = `entry:${seq}`;
        const existing = this.mainDb.get(entryKey) as OutboxEntry | undefined;
        if (existing) {
          existing.status = 'delivered';
          existing.lastAttemptAt = Date.now();
          this.mainDb.putSync(entryKey, existing);
          this.pendingDb.removeSync(`pending:${entryKey}`);
          return;
        }
      }

      // Fallback: O(n) scan for entries written before the reverse index existed
      for (const item of this.mainDb.getRange({
        start: 'entry:',
        end: 'entry:\xff',
      })) {
        const entry = item.value as OutboxEntry;
        if (entry?.id === entryId) {
          entry.status = 'delivered';
          entry.lastAttemptAt = Date.now();
          this.mainDb.putSync(item.key as string, entry);
          this.pendingDb.removeSync(`pending:${item.key as string}`);
          return;
        }
      }
    });
  }

  /**
   * Check if an entry has been delivered (O(1) via deliveryDb index).
   */
  isDelivered(entryId: string): boolean {
    return this._readSync(this.deliveryDb, `delivered:${entryId}`) !== undefined;
  }

  /**
   * Get the count of currently pending entries.
   */
  async getPendingCount(): Promise<number> {
    let count = 0;
    for (const _ of this.pendingDb.getRange({
      start: 'pending:',
      end: 'pending:\xff',
    })) {
      count++;
    }
    return count;
  }

  /**
   * Get outbox store statistics.
   */
  async getStats(): Promise<OutboxStats> {
    const pendingCount = await this.getPendingCount();
    let deliveredCount = 0;
    for (const _ of this.deliveryDb.getRange({
      start: 'delivered:',
      end: 'delivered:\xff',
    })) {
      deliveredCount++;
    }
    const totalEntries = pendingCount + deliveredCount;

    // Find oldest pending timestamp
    let oldestPendingTimestamp: number | null = null;
    for (const item of this.pendingDb.getRange({
      start: 'pending:',
      end: 'pending:\xff',
      limit: 1,
    })) {
      const seq = item.value as number;
      const entry = this.mainDb.get(`entry:${seq}`) as OutboxEntry | undefined;
      if (entry) {
        oldestPendingTimestamp = entry.createdAt;
      }
    }

    return {
      totalEntries,
      pendingCount,
      deliveredCount,
      oldestPendingTimestamp,
    };
  }

  // ──────────────────────────────────────────
  //  Retry & Dead Letter (AC 40.4, 40.5)
  // ──────────────────────────────────────────

  /**
   * Mark an entry delivery attempt as failed.
   * Increments retry count. If maxRetries exceeded, moves to dead letter queue.
   * Returns true if the entry was moved to dead letter, false otherwise.
   */
  markFailed(entryId: string, error?: string): boolean {
    const seq = this.msgIdToSeqDb.get(entryId) as number | undefined;
    if (seq === undefined) {
      // Fallback scan
      for (const item of this.mainDb.getRange({
        start: 'entry:',
        end: 'entry:\xff',
      })) {
        const entry = item.value as OutboxEntry;
        if (entry?.id === entryId) {
          return this._markFailed(entry, item.key as string, error);
        }
      }
      return false;
    }

    const entryKey = `entry:${seq}`;
    const entry = this.mainDb.get(entryKey) as OutboxEntry | undefined;
    if (!entry) return false;

    return this._markFailed(entry, entryKey, error);
  }

  private _markFailed(entry: OutboxEntry, entryKey: string, error?: string): boolean {
    entry.attemptCount = (entry.attemptCount ?? 0) + 1;
    entry.lastAttemptAt = Date.now();
    entry.lastError = error ?? null;

    if (entry.attemptCount >= this.maxRetries) {
      // Move to dead letter queue
      this.deadLetterDb.putSync(`dlq:${entry.id}`, {
        ...entry,
        status: 'failed' as OutboxStatus,
        deadAt: Date.now(),
      });
      // Remove from main + pending + reverse index
      this.mainDb.removeSync(entryKey);
      this.pendingDb.removeSync(`pending:${entryKey}`);
      this.msgIdToSeqDb.removeSync(entry.id);
      const msgId = entry.msgId;
      if (typeof msgId === 'string' && msgId.length > 0) {
        this.msgIdToSeqDb.removeSync(msgId);
      }
      return true; // moved to dead letter
    }

    // Update in place
    this.mainDb.putSync(entryKey, entry);
    return false; // still pending
  }

  /**
   * Retry a dead letter entry by re-inserting it into the main queue.
   */
  retryDeadLetter(entryId: string): boolean {
    const deadKey = `dlq:${entryId}`;
    const deadEntry = this.deadLetterDb.get(deadKey) as DeadLetterEntry | undefined;
    if (!deadEntry) return false;

    this.root.transactionSync(() => {
      // Re-insert with fresh seq and reset counters
      const seq = this._readSeq() + 1;
      const newKey = `entry:${seq}`;
      const revived: OutboxEntry = {
        ...deadEntry,
        id: newKey,
        status: 'pending',
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: Date.now(),
      };

      this.mainDb.putSync(newKey, revived);
      this.pendingDb.putSync(`pending:${newKey}`, seq);
      this._indexById(revived, seq);
      this.seqDb.putSync('seq', seq);

      // Remove from dead letter
      this.deadLetterDb.removeSync(deadKey);
    });
    return true;
  }

  /**
   * Get all dead letter entries.
   */
  getDeadLetterEntries(): DeadLetterEntry[] {
    const entries: DeadLetterEntry[] = [];
    for (const item of this.deadLetterDb.getRange({
      start: 'dlq:',
      end: 'dlq:\xff',
    })) {
      entries.push(item.value as DeadLetterEntry);
    }
    return entries;
  }

  /**
   * Get dead letter stats.
   */
  getDeadLetterStats(): { count: number } {
    const entries = this.getDeadLetterEntries();
    return { count: entries.length };
  }

  // ──────────────────────────────────────────
  //  Backpressure (AC 41.4)
  // ──────────────────────────────────────────

  /**
   * Check if LMDB map utilization exceeds 80%.
   */
  isCapacityExceeded(): boolean {
    try {
      const stats = this.root.getStats() as unknown as {
        pageSize?: number;
        lastPageNumber?: number;
        mapSize?: number;
      };
      const pageSize = stats.pageSize || 4096;
      const usedBytes = stats.lastPageNumber ? stats.lastPageNumber * pageSize : 0;
      const mapSize = stats.mapSize || this.mapSize;
      return usedBytes / mapSize > 0.8;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────
  //  Housekeeping
  // ──────────────────────────────────────────

  /**
   * Remove entries older than ttlMs from the deliveryDb and dead letter queue.
   */
  housekeeping(): void {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    this.root.transactionSync(() => {
      // Clean up delivered entries
      for (const item of this.deliveryDb.getRange({
        start: 'delivered:',
        end: 'delivered:\xff',
      })) {
        const ts = item.value as number;
        if (ts < cutoff) {
          const entryId = (item.key as string).slice('delivered:'.length);
          this.deliveryDb.removeSync(item.key as string);
          // Clean up reverse index
          this.msgIdToSeqDb.removeSync(entryId);
        }
      }

      // Clean up dead letter entries
      const dlCutoff = now - this.deadLetterTtlMs;
      for (const item of this.deadLetterDb.getRange({
        start: 'dlq:',
        end: 'dlq:\xff',
      })) {
        const entry = item.value as DeadLetterEntry;
        if (entry.deadAt && entry.deadAt < dlCutoff) {
          this.deadLetterDb.removeSync(item.key as string);
        }
      }
    });
  }

  /**
   * Close the LMDB environment (all sub-databases included).
   */
  close(): void {
    this.root.close();
  }

  // ──────────────────────────────────────────
  //  Internal helpers
  // ──────────────────────────────────────────

  /** Current sequence number (call inside a write transaction). */
  private _readSeq(): number {
    return this._readSync(this.seqDb, 'seq') ?? 0;
  }

  /**
   * Read a key without awaiting.
   *
   * `lmdb` exposes `getSync` at runtime but does not declare it on `Database`,
   * so the call goes through a narrow structural type. The declared `get` is
   * used as a fallback (it returns the value directly for non-async reads).
   */
  private _readSync<T>(db: Database<T, string>, key: string): T | undefined {
    const sync = (db as unknown as { getSync?: (k: string) => T | undefined }).getSync;
    if (typeof sync === 'function') return sync.call(db, key);
    return db.get(key) as T | undefined;
  }
}
