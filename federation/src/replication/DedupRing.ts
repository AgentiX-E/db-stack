/**
 * DedupRing — In-flight message deduplication with ring buffer eviction.
 *
 * At-least-once delivery requires the receiver to detect and discard duplicate
 * messages. DedupRing provides O(1) lookups for recently-seen message IDs,
 * with automatic eviction by TTL (entries older than ttlMs are purged).
 *
 * Design:
 *   - Internal Set for O(1) contains/put/delete
 *   - FIFO queue for ring-based capacity eviction
 *   - Periodic sweep removes entries past TTL
 *   - Thread-safe: all operations are synchronous, no async overhead
 *   - Bounded memory: old entries naturally fall out within ttlMs
 *
 * Usage:
 *   const ring = new DedupRing({ ttlMs: 60_000 });
 *   if (!ring.contains(msgId)) {
 *     ring.put(msgId);
 *     // process message
 *   } else {
 *     // skip duplicate
 *   }
 */

export interface DedupRingConfig {
  /** TTL for entries before eviction (ms) — default 60_000 (1 minute) */
  ttlMs?: number;
  /** Max capacity — default 100_000 entries */
  maxCapacity?: number;
  /** Node ID for ownership tagging (optional) */
  nodeId?: string;
}

interface DedupEntry {
  id: string;
  addedAt: number;
}

export class DedupRing {
  private readonly ttlMs: number;
  private readonly maxCapacity: number;
  private readonly nodeId: string;

  /** O(1) ID membership check with metadata */
  private readonly map = new Map<string, DedupEntry>();
  /** FIFO queue for ring-based eviction when at capacity */
  private readonly queue: string[] = [];

  /** Stats */
  private _totalSeen = 0;
  private _totalDeduped = 0;
  private _totalEvicted = 0;
  private _lastSweepAt = 0;

  constructor(config?: DedupRingConfig) {
    this.ttlMs = config?.ttlMs ?? 60_000;
    this.maxCapacity = config?.maxCapacity ?? 100_000;
    this.nodeId = config?.nodeId ?? "anon";
  }

  /**
   * Check if a message ID is in the ring (duplicate).
   */
  contains(msgId: string): boolean {
    this.sweepIfDue();
    return this.map.has(msgId);
  }

  /**
   * Insert a message ID. Returns true if accepted, false if already present.
   */
  put(msgId: string): boolean {
    this.sweepIfDue();

    if (this.map.has(msgId)) {
      this._totalDeduped++;
      return false;
    }

    // Enforce capacity — evict oldest entry (FIFO)
    if (this.map.size >= this.maxCapacity && this.queue.length > 0) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.map.delete(oldest);
        this._totalEvicted++;
      }
    }

    const entry: DedupEntry = { id: msgId, addedAt: Date.now() };
    this.map.set(msgId, entry);
    this.queue.push(msgId);
    this._totalSeen++;
    return true;
  }

  /**
   * Remove a message ID. O(1) map delete; queue cleanup is O(n) but rarely called.
   * Returns true if the ID existed and was removed, false otherwise.
   */
  delete(msgId: string): boolean {
    if (!this.map.has(msgId)) return false;
    this.map.delete(msgId);
    // Queue is lazily cleaned — the entry remains in the queue but will be
    // skipped during sweep() or eviction. This keeps the common path O(1).
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
    this.queue.length = 0;
  }

  /**
   * Current size of the ring.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Statistics.
   */
  getStats(): {
    size: number;
    totalSeen: number;
    totalDeduped: number;
    totalEvicted: number;
    capacity: number;
  } {
    return {
      size: this.map.size,
      totalSeen: this._totalSeen,
      totalDeduped: this._totalDeduped,
      totalEvicted: this._totalEvicted,
      capacity: this.maxCapacity,
    };
  }

  /**
   * Sweep expired entries.
   * Called automatically on contains/put if last sweep was > ttlMs/10 ago.
   */
  sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    let swept = 0;

    for (const [msgId, entry] of this.map) {
      if (entry.addedAt < cutoff) {
        this.map.delete(msgId);
        swept++;
      }
    }

    // Rebuild queue to remove evicted/stale entries
    if (swept > 0) {
      let wi = 0;
      for (let ri = 0; ri < this.queue.length; ri++) {
        if (this.map.has(this.queue[ri]!)) {
          this.queue[wi++] = this.queue[ri]!;
        }
      }
      this.queue.length = wi;
    }

    this._totalEvicted += swept;
    this._lastSweepAt = Date.now();
  }

  /** Sweep only if enough time has passed since last sweep */
  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this._lastSweepAt > this.ttlMs / 10) {
      this.sweep();
    }
  }
}
