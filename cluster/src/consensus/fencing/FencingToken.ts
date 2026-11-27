/**
 * FencingToken — the only fact an old primary cannot argue with.
 *
 * A node's belief about its own partition is assembled from the messages it
 * receives, and a partitioned leader still receives some. `isInMajority()` is
 * therefore evidence about the network, not about the storage: it says what this
 * node thinks, and the old primary thinks it is fine. The place an old primary is
 * actually stopped is the resource it writes to, and the only thing that resource
 * can compare is a number the quorum issued.
 *
 * A token is the quorum's log position at the moment it was granted: the term,
 * and the index it had committed in that term. The pair orders totally, and it
 * never goes backwards, because a term never goes backwards and an index inside a
 * term only grows. A resource that remembers the highest token it has accepted
 * therefore refuses everyone from before it — including a leader whose own lease
 * logic, its own clock, and its own peers all still say it is the leader.
 *
 * Where the two mechanisms differ, and why both are kept:
 *
 *   - `FencingManager`'s lease answers *"should I stop?"*. It is a local decision
 *     taken from elapsed time and it fails open on a node that has heard nothing
 *     (an untracked shard is admitted). It is cheap and it catches the common case
 *     of a leader isolated from its peers.
 *   - A token answers *"may the resource still accept me?"*. It is decided at the
 *     resource from durable state and it fails closed. It catches the case the
 *     lease cannot: a node whose lease is intact because it can still hear one
 *     peer, but whose term the quorum has already left behind.
 *
 * This module is engine-agnostic on purpose: nothing here knows what a shard, a
 * socket or a table is. An engine calls `admit()` before committing a write and
 * does whatever its failure model requires when the answer is no.
 */

/** A position in the quorum's log, minted when the right to write was granted. */
export interface FencingToken {
  /** Raft term the quorum was in. A higher term always outranks a lower one. */
  readonly term: number;
  /** Log index committed in that term. Ordering inside one term. */
  readonly index: number;
}

/** Why a resource refused a write. */
export type WriteRefusalReason = 'stale-token' | 'missing-token';

/** The resource layer's answer to a single write attempt. */
export interface WriteAdmission {
  /** Whether the write may be committed. */
  admitted: boolean;
  /** Present only when `admitted` is false. */
  reason?: WriteRefusalReason;
  /**
   * What the decision was, in words an operator can read. Always present, on
   * admission as well as refusal, because the string a resource logs when it says
   * yes is the only record of which position it said yes to.
   */
  detail: string;
  /** The token presented, or null when none was. */
  token: FencingToken | null;
  /** The highest token the resource has accepted, after this decision. */
  highest: FencingToken | null;
}

/** Construction options for {@link FencingTokenGuard}. */
export interface FencingTokenGuardOptions {
  /**
   * Refuse writes that carry no token. Default `true`: a resource that cannot
   * tell whether a writer is current must not assume it is. Set to `false` only
   * for an engine that has no way to carry a token yet — it restores the
   * pre-token behaviour of admitting untokened writes.
   */
  requireToken?: boolean;
  /**
   * Highest token already seen, recovered from durable state. A resource that
   * restarts with an empty memory would re-admit the old primary's writes after
   * a crash, which is the one moment the token exists to cover.
   */
  initial?: FencingToken | null;
}

/** An observer told about every refusal, for logging and alerting. */
export type FencingRefusalObserver = (admission: WriteAdmission) => void;

/**
 * Mint a token from a term and a committed index.
 *
 * Throws `RangeError` for anything that is not a non-negative safe integer: a
 * fractional or unsafe coordinate would make the ordering non-total, and a token
 * whose order is ambiguous is worse than no token at all.
 */
export function mintFencingToken(term: number, index: number): FencingToken {
  assertCoordinate(term, 'term');
  assertCoordinate(index, 'index');
  return Object.freeze({ term, index });
}

/**
 * Total order over tokens: term first, then index.
 *
 * Returns a negative number when `a` precedes `b`, zero when they are the same
 * position, and a positive number when `a` follows `b`.
 *
 * Written as four comparisons rather than "compare the difference", because a
 * difference can overflow into a wrong sign for coordinates near the safe-integer
 * limit, and because each of the four is a separate claim a test can disagree
 * with. An early-return pair also keeps the equality case reachable: a `<=` here
 * and a `>=` there would each answer -1 and 1 for two tokens that are the same
 * position, which is the one answer a fence must never give.
 */
export function compareFencingTokens(a: FencingToken, b: FencingToken): -1 | 0 | 1 {
  if (a.term < b.term) return -1;
  if (a.term > b.term) return 1;
  if (a.index < b.index) return -1;
  if (a.index > b.index) return 1;
  return 0;
}

/** Render a token in the form that travels on the wire and into logs. */
export function formatFencingToken(token: FencingToken): string {
  return `${token.term}/${token.index}`;
}

/**
 * Parse the wire form back into a token.
 *
 * Throws `TypeError` for anything that is not exactly two unsigned decimal
 * coordinates separated by one slash, and `RangeError` when a coordinate cannot
 * be represented exactly. Leading zeros are refused so that one position has one
 * spelling.
 */
export function parseFencingToken(raw: string): FencingToken {
  if (typeof raw !== 'string') {
    throw new TypeError(`a fencing token must be a string, received ${typeof raw}`);
  }
  const parts = raw.split('/');
  if (parts.length !== 2) {
    throw new TypeError(`a fencing token is "term/index", received ${JSON.stringify(raw)}`);
  }
  const rawTerm = parts[0]!;
  const rawIndex = parts[1]!;
  if (!UNSIGNED_DECIMAL.test(rawTerm) || !UNSIGNED_DECIMAL.test(rawIndex)) {
    throw new TypeError(`a fencing token is "term/index" in unsigned decimals, received ${JSON.stringify(raw)}`);
  }
  return mintFencingToken(Number(rawTerm), Number(rawIndex));
}

/** Canonical unsigned decimal: no sign, no fraction, no redundant leading zeros. */
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;

function assertCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`a fencing token's ${name} must be a non-negative safe integer, received ${String(value)}`);
  }
}

/**
 * The resource layer's memory of how far the right to write has advanced.
 *
 * One guard instance belongs to one write target — a shard, a table, a file, a
 * bucket. It is deliberately synchronous and free of I/O: the engine calls it on
 * the write path, so it must be cheap, and its state must be the engine's own
 * durable state, not a copy the middleware keeps. `initial` is how an engine
 * hands that state back after a restart.
 */
export class FencingTokenGuard {
  private _highest: FencingToken | null;
  private _refusals = 0;
  private readonly _observers = new Set<FencingRefusalObserver>();
  private readonly _requireToken: boolean;

  constructor(options: FencingTokenGuardOptions = {}) {
    this._requireToken = options.requireToken ?? true;
    this._highest = options.initial ? normalize(options.initial) : null;
  }

  /**
   * Decide whether a write may be committed.
   *
   * - no token and `requireToken` → refused as `missing-token` (fail-closed)
   * - no token and `!requireToken` → admitted, highest unchanged (compatibility)
   * - token below the highest already accepted → refused as `stale-token`
   * - token equal to the highest → admitted, because a retry is not a usurper
   * - token above the highest → admitted, and the highest advances
   *
   * @param token - The token the writer presented, if it has one
   * @param context - Free-form caller context (a table, a key, a request id) that
   *   is echoed into the refusal detail so an operator can see who was refused
   */
  admit(token?: FencingToken | null, context?: string): WriteAdmission {
    if (token === undefined || token === null) {
      if (this._requireToken) {
        return this._refuse({
          admitted: false,
          reason: 'missing-token',
          detail: describe('no token presented', context),
          token: null,
        });
      }
      return {
        admitted: true,
        detail: describe('admitted without a token (token admission is optional for this resource)', context),
        token: null,
        highest: this._highest,
      };
    }

    const presented = normalize(token);
    const highest = this._highest;
    if (highest && compareFencingTokens(presented, highest) < 0) {
      return this._refuse({
        admitted: false,
        reason: 'stale-token',
        detail: describe(
          `token ${formatFencingToken(presented)} is behind ${formatFencingToken(highest)}, which this resource has already accepted`,
          context,
        ),
        token: presented,
      });
    }

    // Past the stale check the presented token is at or above the highest, so
    // recording it is the only correct answer — and writing it unconditionally
    // keeps the "is it greater?" question from becoming a second decision that
    // could disagree with the first.
    this._highest = presented;
    return {
      admitted: true,
      detail: describe(`admitted at ${formatFencingToken(presented)}`, context),
      token: presented,
      highest: this._highest,
    };
  }

  /**
   * Record a position without admitting a write.
   *
   * For the case where the resource learns that the right to write has moved on —
   * a new leader announced, a peer's token observed in replicated state — before
   * that leader's own write arrives. Only ever raises the highest.
   *
   * @returns whether the observation advanced the resource's floor, so a caller
   *   can tell "the world moved on" from "this is the position I already hold"
   */
  observe(token: FencingToken): boolean {
    const observed = normalize(token);
    const highest = this._highest;
    if (highest === null || compareFencingTokens(observed, highest) > 0) {
      this._highest = observed;
      return true;
    }
    return false;
  }

  /** The highest token this resource has accepted or observed. */
  getHighest(): FencingToken | null {
    return this._highest;
  }

  /** How many writes this resource has refused since construction. */
  getRefusalCount(): number {
    return this._refusals;
  }

  /**
   * Subscribe to refusals. Returns the unsubscribe function.
   *
   * Observers are for logging and alerting only: a throwing observer must not
   * turn a decision into a different one, so its errors are swallowed.
   */
  onRefused(observer: FencingRefusalObserver): () => void {
    this._observers.add(observer);
    return () => {
      this._observers.delete(observer);
    };
  }

  /** Forget the highest token, or seed it with a new one. Refusal count is kept. */
  reset(token: FencingToken | null = null): void {
    this._highest = token ? normalize(token) : null;
  }

  private _refuse(decision: Omit<WriteAdmission, 'highest'>): WriteAdmission {
    this._refusals++;
    const decided: WriteAdmission = { ...decision, highest: this._highest };
    for (const observer of this._observers) {
      try {
        observer(decided);
      } catch {
        // An observer that throws is a broken observer, not a reason to admit.
      }
    }
    return decided;
  }
}

function normalize(token: FencingToken): FencingToken {
  return mintFencingToken(token.term, token.index);
}

function describe(statement: string, context?: string): string {
  return context ? `${statement} (${context})` : statement;
}
