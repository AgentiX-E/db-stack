/**
 * Retention windows — one derivation, from the shortest window outward.
 *
 * The outbox is governed by four durations, and they were four constants in
 * three files with nothing comparing them: a receiver remembered a message id
 * for 30 minutes (`DedupRing` in `FederationManager`), 10 in the CDC pipeline
 * and 1 by default; the sender retried an entry for 60 seconds from its first
 * failure; the dead-letter queue kept a parked entry for 7 days; the delivery
 * index was pruned at the entry TTL of 14 days.
 *
 * Each number is defensible on its own. What was not defensible is that no pair
 * of them had a stated relation, so a configuration could retry an entry for
 * longer than the peer remembered the message id that made the retry safe — and
 * the duplicate would be applied as a new change, silently, on the writing side
 * of a link nobody was watching.
 *
 * The derivation below fixes the order of the reasoning, not the numbers:
 *
 *     retryBackoffMax  ≤  retryWindow
 *     retryWindow + ackTimeout  ≤  dedup
 *     deliveryIndex  =  entryTtl
 *
 * Read from the inside out: one backoff must fit in the budget that schedules
 * it, and the receiver's memory of a message id must outlive every retry of it,
 * including the wait for the verdict of the last attempt.
 *
 * Two relations that look like they belong here do not, and saying why is part
 * of the derivation:
 *
 *   - The entry TTL is not a containment of the retry budget. `ttlMs` prunes
 *     the **delivered** markers and the dead-letter queue; a pending entry is
 *     never pruned by it, so an "entry TTL shorter than the budget" is a fast
 *     housekeeping cycle, not a lost change.
 *   - The dead-letter TTL is not a containment either. Its clock starts when an
 *     entry is parked, which is after the budget is spent, so the two durations
 *     are sequential rather than nested. What a *revive* can lose is a different
 *     question, and it is answered where a revive happens, not by pretending two
 *     sequential windows overlap.
 *
 * The delivery index is an equality by construction rather than a fifth knob:
 * it is pruned in the same pass as the entries, so it is reported as
 * `entryTtlMs` instead of being a number that can disagree with the fourth.
 *
 * Zero is meaningful in two places and it does not mean the same thing, which
 * is why the rules are written to say which:
 *
 *   - `retryWindowMs: 0` means "no budget": the first failure is past the
 *     deadline and the entry is dead-lettered at once (`OutboxStore` RB.7). A
 *     zero budget schedules no backoff, so the ceiling has nothing to fit in.
 *   - `dedupMs: 0` means "no receiver memory". Legal only when there is no
 *     retry budget to cover, because otherwise the first retry is a duplicate.
 *
 * `Infinity` is the other end and it is also a duration: no budget to spend, no
 * clock to run out. It is legal, and it is contagious in one direction — a
 * sender that never gives up retrying needs a receiver that never forgets,
 * because the alternative is the duplicate this module exists to prevent.
 *
 * @module @agentix-e/db-federation/storage
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The windows a caller may ask for. Every field is optional: an omitted one
 * comes from {@link DEFAULT_RETENTION}, so a caller states only what it means
 * to change.
 */
export interface RetentionRequest {
  /**
   * How long a receiver remembers a message id it has already applied.
   * Default 30 minutes.
   */
  dedupMs?: number;
  /**
   * How long a send may wait for the peer's verdict of one attempt. Default 0.
   *
   * Adds to the dedup requirement rather than to the retry budget: the wait is
   * inside a single attempt, so the peer must still recognise the message id
   * after the wait as well as after the retries.
   */
  ackTimeoutMs?: number;
  /**
   * How long an entry may keep failing before it is parked. Default 60 seconds.
   *
   * Measured from the **first** failure, not from creation: an entry that waits
   * in the queue for an hour and then fails once has not spent its budget.
   */
  retryWindowMs?: number;
  /** Ceiling on a single backoff. Default 2 seconds. */
  retryBackoffMaxMs?: number;
  /** How long a dead-lettered entry is kept. Default 7 days. */
  deadLetterTtlMs?: number;
  /** How long a pending or delivered entry is kept. Default 14 days. */
  entryTtlMs?: number;
}

/**
 * The windows a component actually runs with.
 *
 * Distinct from {@link RetentionRequest} because nothing here is optional: a
 * component that reports what it runs with must not be able to omit a number.
 */
export interface RetentionWindows {
  dedupMs: number;
  ackTimeoutMs: number;
  retryWindowMs: number;
  retryBackoffMaxMs: number;
  deadLetterTtlMs: number;
  entryTtlMs: number;
  /**
   * How long the delivery index remembers a delivered entry id.
   *
   * Not a configuration: the index is pruned in the same pass as the entries,
   * at `entryTtlMs`. It is reported because the containment "the delivery index
   * covers the retry budget" is otherwise an inference a reader has to make from
   * a `getRange` call inside `housekeeping()`.
   */
  deliveryIndexMs: number;
}

/** The rules, named so a refusal can be asserted by name rather than by prose. */
export type RetentionRule = 'window-not-a-duration' | 'retry-covers-backoff' | 'dedup-covers-retry';

/**
 * A configuration whose windows do not contain each other.
 *
 * Thrown from the constructor of the component that would run with them, before
 * it opens a single file: a window that cannot hold what it must hold is not a
 * runtime condition to be discovered under load, it is a configuration error
 * that makes every subsequent delivery lossy.
 */
export class RetentionViolation extends Error {
  constructor(
    readonly rule: RetentionRule,
    message: string,
  ) {
    super(`${rule}: ${message}`);
    this.name = 'RetentionViolation';
  }
}

/**
 * The windows the product ships with.
 *
 * Frozen because it is the fallback every component reads when a caller omits a
 * field: a mutable default is a global that one test can change for the next.
 */
export const DEFAULT_RETENTION: Readonly<RetentionWindows> = Object.freeze({
  dedupMs: 30 * MINUTE,
  ackTimeoutMs: 0,
  retryWindowMs: MINUTE,
  retryBackoffMaxMs: 2_000,
  deadLetterTtlMs: 7 * DAY,
  entryTtlMs: 14 * DAY,
  deliveryIndexMs: 14 * DAY,
});

/** Resolve one field against the defaults and refuse anything but a duration. */
function durationOf(field: keyof RetentionRequest, requested: number | undefined, fallback: number): number {
  const value = requested === undefined ? fallback : requested;
  // `Infinity` is a duration, and it means "no limit": no budget to spend, no
  // clock to run out. `NaN` and negatives are not durations, and they are
  // refused here rather than propagating into a comparison that silently
  // answers `false`.
  const unbounded = value === Number.POSITIVE_INFINITY;
  if (!unbounded && (!Number.isFinite(value) || value < 0)) {
    throw new RetentionViolation(
      'window-not-a-duration',
      `${field} is ${String(value)}; a retention window is a non-negative number of milliseconds, or Infinity for no limit`,
    );
  }
  return value;
}

/**
 * Resolve a request into the windows a component runs with.
 *
 * Pure: the same request always produces the same windows, which is what lets
 * the composition root derive once and hand the *numbers* to components that
 * cannot see each other.
 */
export function deriveRetention(request: RetentionRequest = {}): RetentionWindows {
  const retryWindowMs = durationOf('retryWindowMs', request.retryWindowMs, DEFAULT_RETENTION.retryWindowMs);
  const retryBackoffMaxMs = durationOf(
    'retryBackoffMaxMs',
    request.retryBackoffMaxMs,
    DEFAULT_RETENTION.retryBackoffMaxMs,
  );
  const deadLetterTtlMs = durationOf('deadLetterTtlMs', request.deadLetterTtlMs, DEFAULT_RETENTION.deadLetterTtlMs);
  const entryTtlMs = durationOf('entryTtlMs', request.entryTtlMs, DEFAULT_RETENTION.entryTtlMs);
  const dedupMs = durationOf('dedupMs', request.dedupMs, DEFAULT_RETENTION.dedupMs);
  const ackTimeoutMs = durationOf('ackTimeoutMs', request.ackTimeoutMs, DEFAULT_RETENTION.ackTimeoutMs);

  // From the inside out. The first relation that does not hold is the one that
  // explains the others: reporting the outermost would send a reader to fix the
  // window that happens to be widest rather than the one that was misconfigured.
  //
  // A zero budget schedules no backoff at all — the first failure is already
  // past a deadline of zero — so the ceiling has nothing to fit inside.
  if (retryWindowMs !== 0 && retryWindowMs < retryBackoffMaxMs) {
    throw new RetentionViolation(
      'retry-covers-backoff',
      `the retry budget is ${retryWindowMs} ms but one backoff may last ${retryBackoffMaxMs} ms, so the budget is spent sleeping past its own deadline`,
    );
  }

  if (dedupMs < retryWindowMs + ackTimeoutMs) {
    throw new RetentionViolation(
      'dedup-covers-retry',
      `the receiver forgets a message id after ${dedupMs} ms but the sender may retry it for ${retryWindowMs} ms and wait ${ackTimeoutMs} ms for each verdict, so a retry arrives as a new change`,
    );
  }

  return {
    dedupMs,
    ackTimeoutMs,
    retryWindowMs,
    retryBackoffMaxMs,
    deadLetterTtlMs,
    entryTtlMs,
    deliveryIndexMs: entryTtlMs,
  };
}
