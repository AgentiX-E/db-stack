/**
 * IChangeLogReader — the read end of a durable change log.
 *
 * This is the seam between *where changes are recorded* and *what the
 * federation layer does with them*. Everything above it (`WalTailCDCEngine`,
 * `ExactlyOnceCDCPipeline`, the outbox, the cross-DC transport) is engine
 * agnostic; everything below it is the deployment's own log: a PostgreSQL
 * logical-replication slot, a MySQL binlog position, a Kafka topic offset, or
 * the file log this package ships (`FileChangeLog`).
 *
 * Why a port and not an `ICDCEngine` implementation per vendor: an engine that
 * decodes a vendor's WAL has to own *polling, resumption and backpressure* as
 * well, and those three behaviours are the ones worth testing once. A reader
 * that only answers "what came after this position" can be exercised with a
 * file, with a fake, or with a real database, and the tail engine on top of it
 * is tested exactly once.
 *
 * Two properties the contract requires and every implementation must hold:
 *
 *   1. **Order.** `readAfter(x, n)` returns records in strictly increasing
 *      `lsn` order, and none whose `lsn` is `<= x`. A caller resumes by
 *      passing the last `lsn` it processed; it must never see it again.
 *   2. **Durability before visibility.** A record is only ever returned after
 *      it is durable in the underlying log. A record that was acknowledged to
 *      a writer and then lost in a crash is the one failure mode this seam
 *      exists to rule out: the pipeline's checkpoint advances past it, and no
 *      later poll will bring it back.
 */

import type { CDCChangeEvent } from './ICDCManager';

/**
 * One committed change, as it sits in the log.
 *
 * Deliberately close to `CDCChangeEvent` and not identical to it: the log
 * carries the writer's commit time (`committedAt`, epoch milliseconds) and no
 * clock of its own, because a log written by another process cannot borrow a
 * timestamp from this one. `WalTailCDCEngine` turns the two representations
 * into each other and stamps the HLC it owns.
 */
export interface ChangeLogRecord {
  /**
   * Position in the log, ordered and lexicographically comparable.
   *
   * The shape is the implementation's to choose; the *ordering* is the
   * contract. `compareLsn()` understands the `high/low` hexadecimal form used
   * by PostgreSQL and by `FileChangeLog` and is what the shipped code paths
   * use.
   */
  lsn: string;
  /** Table the change belongs to */
  table: string;
  /** What happened to the row */
  operation: 'insert' | 'update' | 'delete';
  /** Row image before the change, or null when the engine did not capture it */
  oldValues: Record<string, unknown> | null;
  /** Row image after the change, or null for a delete */
  newValues: Record<string, unknown> | null;
  /** Transaction the change belongs to, as the writer named it */
  txId: string;
  /** Writer's commit time, epoch milliseconds */
  committedAt: number;
}

export interface IChangeLogReader {
  /**
   * Records strictly after `afterLsn`, in order, at most `limit`.
   *
   * `afterLsn === null` means "from the beginning of what the log still
   * holds", which is what a consumer with no checkpoint reads. `limit` must be
   * a positive integer: a limit of zero would make a polling consumer spin
   * forever without progress and look like an idle log.
   */
  readAfter(afterLsn: string | null, limit: number): Promise<ChangeLogRecord[]>;

  /**
   * The newest position the log holds, or null when it holds nothing.
   *
   * Used to answer "am I caught up" without reading a batch, and by tests that
   * wait for a writer rather than sleeping.
   */
  head(): Promise<string | null>;
}

/** Order two LSNs of the `high/low` hexadecimal shape (`0/0000001F`). */
export function compareLsn(a: string, b: string): number {
  const left = parseLsn(a);
  const right = parseLsn(b);
  if (left.high !== right.high) return left.high < right.high ? -1 : 1;
  if (left.low !== right.low) return left.low < right.low ? -1 : 1;
  return 0;
}

/**
 * Parse `high/low` into two numbers.
 *
 * The low word is compared as a `bigint` because it does not have to fit in
 * 53 bits: PostgreSQL hands out values like `0/1A2B3C4D5E` after a few days of
 * write traffic, and a `Number()` round-trip would make two neighbouring
 * positions compare equal — a checkpoint that cannot tell "before" from
 * "after" silently skips the record in between.
 */
export function parseLsn(lsn: string): { high: bigint; low: bigint } {
  const slash = lsn.indexOf('/');
  if (slash <= 0) {
    throw new Error(`LSN "${lsn}" is not in the high/low form (e.g. 0/0000001F)`);
  }
  const high = lsn.slice(0, slash);
  const low = lsn.slice(slash + 1);
  if (!/^[0-9A-Fa-f]+$/.test(high) || !/^[0-9A-Fa-f]+$/.test(low)) {
    throw new Error(`LSN "${lsn}" is not hexadecimal in the high/low form`);
  }
  return { high: BigInt(`0x${high}`), low: BigInt(`0x${low}`) };
}

/** Format a sequence number as an LSN with the high word pinned to zero. */
export function formatLsn(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`LSN sequence must be a non-negative integer, got ${String(sequence)}`);
  }
  return `0/${sequence.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Convert a `ChangeLogRecord` into the event shape the CDC layer consumes. */
export function recordToChangeEvent(record: ChangeLogRecord, timestamp: CDCChangeEvent['timestamp']): CDCChangeEvent {
  return {
    lsn: record.lsn,
    timestamp,
    tableName: record.table,
    operation: record.operation,
    oldValues: record.oldValues,
    newValues: record.newValues,
    txId: record.txId,
  };
}
