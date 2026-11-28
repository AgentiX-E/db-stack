/**
 * ProbeTimeout — an engine-agnostic deadline around a health answer.
 *
 * IHealthProbe promises a fast answer: liveness under 10 ms, readiness under
 * 100 ms. A promise, however, can stay pending for ever — a peer that never
 * replies, a lock that is never released, a socket with no deadline. The old
 * orchestrator awaited such an answer with no boundary, so one stalled probe
 * held liveness, readiness and every structured view open: the health endpoint
 * reported nothing at all, which is the one state a liveness check must never
 * be in.
 *
 * This module supplies the boundary as a callback, not a policy. It knows
 * nothing about stores, sockets or engines: a caller hands it a thunk, a budget
 * in milliseconds and — optionally — its own timer. The default timer uses the
 * host clock; a deployment with a virtual or monotonic clock supplies its own.
 * On expiry the answer becomes a named `ProbeTimeoutError`, so the caller can
 * report *which* probe stalled rather than a bare "unhealthy".
 *
 * @module @agentix-e/db-node/health/impl
 */

/** Minimal clock a caller can inject in place of the host timers. */
export interface ProbeTimer {
  /** Schedule `fn` after `ms` milliseconds; the returned handle is opaque. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancel a handle previously returned by {@link ProbeTimer.setTimeout}. */
  clearTimeout(handle: unknown): void;
}

/** The host clock, used when a caller does not inject one. */
export const systemTimer: ProbeTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The budget an answer may not exceed. Named so the verdict can say why. */
export class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`probe timed out after ${timeoutMs}ms`);
    this.name = 'ProbeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race one answer against a deadline.
 *
 * Both a synchronous value and a promise are accepted: `Promise.resolve().then`
 * normalises them and turns a synchronous throw into a rejection, so a broken
 * probe reaches the caller's `catch` the same way a rejected promise does.
 * The timer handle is always cleared — if the answer wins, the deadline must
 * not keep an event-loop handle alive; if the deadline wins, clearing it is
 * harmless and keeps the two paths symmetric. A late rejection from an answer
 * that lost the race is consumed by `Promise.race` and cannot surface as an
 * unhandled rejection.
 */
export async function settleWithin<T>(
  work: () => T | Promise<T>,
  timeoutMs: number,
  timer: ProbeTimer = systemTimer,
): Promise<T> {
  let handle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = timer.setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    timer.clearTimeout(handle);
  }
}
