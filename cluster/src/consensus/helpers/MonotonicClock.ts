/**
 * MonotonicClock — an epoch-anchored clock whose reading cannot move backwards.
 *
 * Fencing and lease decisions subtract two timestamps: `now - lastHeartbeat`
 * and `now - lastQuorumAck`. Under a normal clock that difference is a duration.
 * When the host clock steps backwards — an NTP correction, a VM migration, a
 * manual adjustment — the difference goes negative, and a comparison like
 * `elapsed > leaseMs` never becomes true. The consequence is not a cosmetic
 * number: a partitioned leader is never fenced and keeps accepting writes, and
 * a lease that no longer has quorum is served as a linearizable read.
 *
 * The fix clamps the reading rather than replacing the epoch domain. Callers
 * still hand `onQuorumHeartbeatAck` an epoch timestamp and status consumers
 * still read epoch milliseconds; only the clock that produces `now()` is made
 * monotonic. That keeps every existing timestamp contract intact while making
 * every duration non-negative.
 *
 * The source is injected so the clamp can be tested without sleeping or moving
 * the host clock. A deployment may pass any epoch source; the default is the
 * host clock. This module knows nothing about Raft, engines or stores — it is a
 * generic callback seam, so every engine can use it unchanged.
 *
 * @module @agentix-e/db-cluster/consensus/helpers
 */

/** A clock whose `now()` never decreases, in the epoch-millisecond domain. */
export interface MonotonicClock {
  now(): number;
}

/** Options that let a caller supply its own clock to a consensus decision. */
export interface MonotonicClockOptions {
  /** Epoch source; defaults to the host clock. */
  clock?: MonotonicClock;
}

/**
 * Wrap an epoch source so its reading never moves backwards.
 *
 * The first read anchors the high-water mark. Each later read returns the
 * source value only when it exceeds that mark; a backwards step or an equal
 * value returns the mark instead. Time therefore resumes exactly where the
 * source passes its own previous maximum — never before.
 */
export function createMonotonicClock(source: () => number = Date.now): MonotonicClock {
  let watermark = source();
  return {
    now(): number {
      const observed = source();
      watermark = observed > watermark ? observed : watermark;
      return watermark;
    },
  };
}
