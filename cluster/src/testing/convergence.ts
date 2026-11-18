/**
 * Convergence — waiting for something that is allowed to take time.
 *
 * Why this file exists
 * --------------------
 * Raft is an asynchronous protocol: a leader knows it is leader before anyone else
 * does. `becomeLeaderUnlocked` sets `state = Leader` and `currentLeader = self`,
 * then appends the no-op entry, then starts the heartbeat timer and sends the
 * first AppendEntries. `TestCluster.findLeader()` polls `isLeader()`, so it
 * resolves in that window — and a test that then reads `getLeader()` on all three
 * nodes is reading a property that is guaranteed **not** to have converged yet.
 *
 * CI run 44225232372 did exactly that and got `[ null, 2, null ]` where it wanted
 * `[ 2, 2, 2 ]`: the leader naming itself, the two followers still blank. The same
 * mistake appears elsewhere in the suite as `await sleep(2000)` with the comment
 * "give some time for leader info to propagate" — a guess standing in for a bound.
 *
 * What this module provides instead
 * ---------------------------------
 * `pollUntil` re-reads a property until the caller accepts it, and gives up only at
 * a deadline, reporting what it actually saw. `awaitAgreement` is the same thing for
 * the specific shape Raft needs: several nodes, one value. Neither waits by hoping,
 * and neither treats "not yet" as "never".
 *
 * Design decisions:
 *
 *   - **The deadline bounds waiting, not looking.** The first read happens even
 *     with a zero budget, because a check skipped for want of time reports "not
 *     converged" about a property nobody read.
 *   - **A read that starts inside the budget counts.** An RPC that returns after the
 *     deadline still answers the question that was asked inside it; discarding it
 *     would make the outcome depend on scheduler latency rather than on the cluster.
 *   - **A throwing read is retried, and remembered.** During an election a peer may
 *     legitimately not answer; that is not a reason to fail, but the reason must
 *     survive into the failure, or "timed out" hides a broken transport.
 *   - **Failures carry the observation.** `attempts=3 last observed: [null,2,null]`
 *     distinguishes a lagging follower from a cluster that never elected anyone.
 *   - **Time is injected.** Deadlines and back-off are the whole behaviour, so they
 *     are tested exactly, with a hand-advanced clock and a sleep that records
 *     instead of waiting.
 */

/** Default gap between reads, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 50;

/** How a wait behaves. */
export interface ConvergeOptions {
  /** Hard deadline. A property that has not converged by then is a failure. */
  timeoutMs: number;
  /** Gap between reads (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  intervalMs?: number;
  /** What is being waited for, named in the failure. */
  label?: string;
  /** Clock, injectable so deadline behaviour can be tested exactly. */
  now?: () => number;
  /** Sleep, injectable for the same reason. */
  sleep?: (ms: number) => Promise<void>;
}

/** A property that converged, and what it cost to see it. */
export interface ConvergeResult<T> {
  /** The accepted value. */
  value: T;
  /** Reads attempted, including the one that was accepted. */
  attempts: number;
  /** Milliseconds from the first read to acceptance. */
  elapsedMs: number;
}

/** What a failed wait knows. */
export interface ConvergenceFailure {
  /** The primitive that gave up. */
  kind: string;
  /** The caller's label, unquoted. */
  label: string;
  /** The budget that was spent. */
  timeoutMs: number;
  /** Reads attempted. */
  attempts: number;
  /** The last value read, or the last thrown error. */
  last: unknown;
  /** The last error thrown by a read, if any read threw. */
  lastError: unknown;
  /** What the caller was looking at, for the message. */
  detail: string;
}

/**
 * No property converged inside the budget.
 *
 * The message is the diagnostic: it names the label, the attempts, the budget and
 * the last observation, because a bare "timed out" cannot tell a lagging follower
 * from a transport that is down.
 */
export class ConvergenceTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly last: unknown;
  readonly lastError: unknown;

  constructor(failure: ConvergenceFailure) {
    const suffix = failure.lastError === undefined ? '' : ` last error: ${errorMessage(failure.lastError)}`;
    super(
      `${failure.kind}(${JSON.stringify(failure.label)}) gave up after ${failure.timeoutMs}ms ` +
        `(attempts=${failure.attempts}) ${failure.detail}${suffix}`,
    );
    this.name = 'ConvergenceTimeoutError';
    this.label = failure.label;
    this.timeoutMs = failure.timeoutMs;
    this.attempts = failure.attempts;
    this.last = failure.last;
    this.lastError = failure.lastError;
  }
}

/** How to wait for agreement. */
export interface AgreementOptions<T> extends ConvergeOptions {
  /** Whether a value is acceptable once every reader reports it. */
  require?: (value: T) => boolean;
  /**
   * How two readings are compared (default `Object.is`).
   *
   * The default is identity, which is what a group reporting a leader id or a term
   * needs. A reader that returns a record — `{ leader, term }` — has to say how two
   * records are the same, or every round will disagree by construction.
   */
  equal?: (left: T, right: T) => boolean;
}

/** Read a value until `accept` takes it, or fail at `timeoutMs`. */
export function pollUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: ConvergeOptions,
): Promise<ConvergeResult<T>> {
  return converge(read, accept, options, 'pollUntil', options.label ?? 'the condition');
}

/**
 * Read `reads` as a group until every reader reports the same acceptable value.
 *
 * This is the shape most cluster assertions actually want: "every node names the
 * same leader", "every node is in the same term". Agreement is a property of the
 * group as of a round, so the readers of a round are read concurrently — a
 * sequential read of three nodes observes three different moments and can call the
 * difference a fault.
 */
export function awaitAgreement<T>(
  reads: Array<() => Promise<T>>,
  options: AgreementOptions<T>,
): Promise<ConvergeResult<T[]>> {
  const read = async (): Promise<T[]> => {
    const settled = await Promise.allSettled(reads.map((each) => each()));
    // A round is only as good as its worst reader: a node that did not answer has
    // not agreed to anything, and its reason is worth more than the other values.
    const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    return settled.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
  };

  const same = options.equal ?? Object.is;
  const accept = (values: T[]): boolean => {
    if (values.length === 0) return false; // a group with no members cannot agree
    const [first, ...rest] = values as [T, ...T[]];
    if (options.require && !options.require(first)) return false;
    return rest.every((value) => same(value, first));
  };

  return converge(read, accept, options, 'awaitAgreement', options.label ?? 'the group to agree');
}

/** The one loop both primitives run. */
async function converge<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: ConvergeOptions,
  kind: string,
  label: string,
): Promise<ConvergeResult<T>> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const started = now();
  const deadline = started + options.timeoutMs;

  let attempts = 0;
  let last: unknown;
  let lastError: unknown;

  for (;;) {
    attempts += 1;
    try {
      const value = await read();
      if (accept(value)) return { value, attempts, elapsedMs: now() - started };
      last = value;
    } catch (err) {
      last = err;
      lastError = err;
    }

    // Checked after the read: a read that was started in time is answered in time.
    // Checked before the sleep: a wait cannot overrun its budget by an interval it
    // did not need.
    if (now() >= deadline) {
      throw new ConvergenceTimeoutError({
        kind,
        label,
        timeoutMs: options.timeoutMs,
        attempts,
        last,
        lastError,
        detail: `last observed: ${describe(last)}`,
      });
    }

    await sleep(intervalMs);
  }
}

/** One line describing a value, truncated so a large state dump stays readable. */
function describe(value: unknown): string {
  if (value instanceof Error) return errorMessage(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The message of a thrown value, whatever was thrown. */
function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  // A rejection is not always an Error: a transport can reject with a record
  // carrying `code` and `detail`, and rendering that as `[object Object]` throws
  // away the only diagnostic there was.
  if (typeof value === 'object' && value !== null) return describe(value);
  return String(value);
}
