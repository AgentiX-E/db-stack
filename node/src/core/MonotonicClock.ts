/**
 * MonotonicClock — an epoch-anchored clock whose reading cannot move backwards.
 *
 * Uptime is a duration: `now - start`. `Date.now()` is not a duration source —
 * an NTP correction or a VM migration can step it backwards, turning a healthy
 * process's uptime into a negative number. This seam clamps the reading to a
 * high-water mark so every duration stays non-negative, while remaining in the
 * epoch-millisecond domain that health status consumers expect.
 *
 * The source is injected so the clamp is testable without sleeping or touching
 * the host clock. The module knows nothing about stores or engines: it is a
 * generic callback, so any engine can use it. It mirrors the cluster package's
 * copy deliberately — the two packages stay dependency-independent.
 *
 * @module @agentix-e/db-node/core
 */

/** A clock whose `now()` never decreases, in the epoch-millisecond domain. */
export interface MonotonicClock {
  now(): number;
}

/** Options that let a caller supply its own clock to a duration. */
export interface MonotonicClockOptions {
  /** Epoch source; defaults to the host clock. */
  clock?: MonotonicClock;
}

/**
 * Wrap an epoch source so its reading never moves backwards. The first read
 * anchors the watermark; a later value is used only when it exceeds it.
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
