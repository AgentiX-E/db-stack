/**
 * Idempotent write coordinator — a retry of the same msgId returns the first
 * attempt's result rather than becoming a second write.
 *
 * The middleware carries msgId through the log and deduplicates at the receiver,
 * but a retry that arrived before the first apply saw no answer, and two
 * in-flight callers of one msgId could both execute. This module gives the
 * write side a bounded, expiring memory of completed results and funnels every
 * write through it:
 *
 *   - a completed msgId replays its stored result (no second write);
 *   - concurrent callers of the same msgId share one execution;
 *   - a failed execution is not remembered, so the next caller may retry;
 *   - entries expire after a window derived from P3-83 (`deriveRetention().dedupMs`)
 *     and are evicted FIFO at capacity.
 *
 * The window is injected as a number so this package never imports federation
 * or any engine. The write itself is a caller-supplied callback, so the
 * coordinator works for any storage or consensus implementation.
 *
 * @module @agentix-e/db-cluster/idempotency
 */

/** A completed write remembered by msgId. */
export interface IdempotencyRecord<Result> {
  readonly msgId: string;
  readonly result: Result;
  /** The Raft position (or any engine marker) the first write committed at. */
  readonly position: number;
  readonly recordedAt: number;
}

export interface IdempotencyTableOptions {
  /** How long a completed result is remembered, in ms. P3-83's dedupMs. */
  readonly windowMs: number;
  /** Injectable clock for deterministic expiry. Defaults to Date.now. */
  readonly now?: () => number;
  /** Maximum live entries; the oldest is evicted at capacity. Default 100_000. */
  readonly maxEntries?: number;
}

/**
 * Bounded, expiring memory of completed results.
 *
 * Expiry is checked on read (`get`/`has`) and swept in bulk by `sweep()`. An
 * entry at exactly `recordedAt + windowMs` is expired, so a zero window never
 * remembers anything and Infinity never forgets.
 */
export class IdempotencyTable<Result> {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, IdempotencyRecord<Result>>();
  private evictedCount = 0;

  constructor(options: IdempotencyTableOptions) {
    if (!Number.isFinite(options.windowMs) && options.windowMs !== Number.POSITIVE_INFINITY) {
      throw new RangeError('windowMs must be a non-negative duration or Infinity');
    }
    if (options.windowMs < 0) {
      throw new RangeError('windowMs must be a non-negative duration or Infinity');
    }
    const max = options.maxEntries ?? 100_000;
    if (!Number.isInteger(max) || max <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.maxEntries = max;
  }

  private assertMsgId(msgId: string): void {
    if (typeof msgId !== 'string' || msgId.trim() === '') {
      throw new Error('msgId must be a non-empty string');
    }
  }

  private isExpired(record: IdempotencyRecord<Result>): boolean {
    return this.now() - record.recordedAt >= this.windowMs;
  }

  /** The live record for an id, or undefined if unseen or expired. */
  get(msgId: string): IdempotencyRecord<Result> | undefined {
    const record = this.entries.get(msgId);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.entries.delete(msgId);
      return undefined;
    }
    return record;
  }

  /** Whether a live record exists. Does not extend the window. */
  has(msgId: string): boolean {
    return this.get(msgId) !== undefined;
  }

  /** Remember a completed result, refreshing its timestamp and result. */
  put(msgId: string, result: Result, position: number): IdempotencyRecord<Result> {
    this.assertMsgId(msgId);
    if (!this.entries.has(msgId) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.evictedCount += 1;
      }
    }
    const record: IdempotencyRecord<Result> = { msgId, result, position, recordedAt: this.now() };
    this.entries.set(msgId, record);
    return record;
  }

  /** Remove an id. Returns false when it was absent. */
  delete(msgId: string): boolean {
    return this.entries.delete(msgId);
  }

  /** Remove every expired entry, returning how many were removed. */
  sweep(): number {
    let removed = 0;
    for (const [id, record] of this.entries) {
      if (this.isExpired(record)) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of live entries (expired-but-unread entries still count). */
  get size(): number {
    return this.entries.size;
  }

  stats(): { size: number; evicted: number; capacity: number; windowMs: number } {
    return { size: this.entries.size, evicted: this.evictedCount, capacity: this.maxEntries, windowMs: this.windowMs };
  }
}

/** The result of one idempotent write. */
export interface IdempotentOutcome<Result> {
  readonly msgId: string;
  readonly result: Result;
  /** True when the result came from memory rather than a fresh execution. */
  readonly replayed: boolean;
  /** How many times the write callback actually ran for this call. */
  readonly attempts: number;
  /** The position recorded on the first successful write. */
  readonly position: number;
}

export interface IdempotentWriteCoordinatorOptions<Result> {
  readonly table: IdempotencyTable<Result>;
}

/**
 * Funnels writes through an idempotency table.
 *
 * A completed msgId replays; a concurrent msgId shares the in-flight promise;
 * a failed execution is removed from the in-flight set and rethrows, leaving
 * the next caller free to try again.
 */
export class IdempotentWriteCoordinator<Result> {
  private readonly table: IdempotencyTable<Result>;
  private readonly _inFlight = new Map<string, Promise<Result>>();

  constructor(options: IdempotentWriteCoordinatorOptions<Result>) {
    this.table = options.table;
  }

  /** Number of writes currently executing. */
  inFlight(): number {
    return this._inFlight.size;
  }

  async execute(msgId: string, write: () => Promise<Result>, position: number): Promise<IdempotentOutcome<Result>> {
    if (typeof msgId !== 'string' || msgId.trim() === '') {
      throw new Error('msgId must be a non-empty string');
    }

    const completed = this.table.get(msgId);
    if (completed) {
      return { msgId, result: completed.result, replayed: true, attempts: 0, position: completed.position };
    }

    const shared = this._inFlight.get(msgId);
    if (shared) {
      const result = await shared;
      const record = this.table.get(msgId);
      return {
        msgId,
        result,
        replayed: true,
        attempts: 0,
        position: record?.position ?? position,
      };
    }

    const execution = (async () => write())();
    this._inFlight.set(msgId, execution);
    try {
      const result = await execution;
      this.table.put(msgId, result, position);
      return { msgId, result, replayed: false, attempts: 1, position };
    } finally {
      this._inFlight.delete(msgId);
    }
  }
}
