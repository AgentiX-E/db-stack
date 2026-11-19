/**
 * CDCFailureInjector — controlled faults for anything that implements
 * `ICDCSink`.
 *
 * It ships from `@agentix-e/db-federation/testing` rather than the package root
 * because it is an instrument, not a capability: it sits in front of a sink the
 * deployment already has, and nothing on the replication path constructs one.
 * It is published because the claims this package makes — ordered delivery, one
 * `emit()` per change, a refusal that is retried and then recorded — are only
 * checkable by a consumer who can make a sink misbehave on purpose.
 *
 * Four things it used to get wrong, each of which made a fault test pass for the
 * wrong reason:
 *
 *   - `maxFailures` was a *global* counter compared against a *per-entry*
 *     limit. A `latency_spike` with `maxFailures: 1` spent the budget, and a
 *     `connection_drop` configured beside it never fired at all — a suite
 *     asserting "exactly-once under connection drops" measured an injector that
 *     never dropped a connection. The budget is now per entry.
 *   - Two entries of the same type were accepted, and `find()` returned the
 *     first: the second was silently dead. It is now rejected at construction,
 *     because a configuration that can never take effect is a test that
 *     measures nothing.
 *   - `disconnect()` swallowed the wrapped sink's error in an empty `catch`.
 *     For a fault injector, hiding a fault is the one thing it must not do: the
 *     error now propagates.
 *   - `connection_drop` could not distinguish "fails to connect" from "connects
 *     and then fails to write". Both matter, and a sink that accepts a
 *     connection and refuses every write is the more interesting of the two.
 *     `on` names the point.
 */

import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

// ── Types ──────────────────────────────────────────────────

export type FailureType = 'connection_drop' | 'partial_emit' | 'latency_spike' | 'duplicate_inject' | 'reorder_inject';

/**
 * Where a `connection_drop` may fire.
 *
 * Only `connection_drop` reads this: the other four are observed by definition
 * at `emit()`. A value set on any other type is rejected rather than ignored.
 */
export type InjectionPoint = 'connect' | 'emit' | 'both';

export interface FailureConfig {
  /** What to inject. */
  type: FailureType;
  /**
   * Chance per attempt when `failEveryN` is 0. Default: 0.1
   *
   * One draw per configured entry per attempt — not one per injection point —
   * so two entries at 0.1 each leave a 19 % chance that at least one fires.
   */
  probability: number;
  /** Added latency when a `latency_spike` fires. Default: 100 */
  latencyMs: number;
  /**
   * Fire on every N-th `emit()` call, deterministically. Default: 0 (random)
   *
   * Counts calls, not successes, and never applies to `connect()`: a
   * deterministic "fail the first write" is `failEveryN: 1, on: 'emit'`.
   */
  failEveryN: number;
  /**
   * Injections this entry may make. Default: -1 (unlimited)
   *
   * Counted per entry. `reset()` re-arms it.
   */
  maxFailures: number;
  /** Where a `connection_drop` fires. Default: `'both'` */
  on: InjectionPoint;
}

const DEFAULT_FAILURE: FailureConfig = {
  type: 'connection_drop',
  probability: 0.1,
  latencyMs: 100,
  failEveryN: 0,
  maxFailures: -1,
  on: 'both',
};

/** One configured fault, with the count that governs its own budget. */
interface Entry {
  readonly config: FailureConfig;
  injected: number;
}

// ── Validation ─────────────────────────────────────────────

/**
 * The key that makes two entries the same fault.
 *
 * A `connection_drop` on `connect` and one on `emit` are different faults and
 * may coexist; two `connection_drop`s on `both` are the same fault twice, and
 * one of them could never fire.
 */
function keyOf(config: FailureConfig): string {
  return config.type === 'connection_drop' ? `${config.type}:${config.on}` : config.type;
}

function normalise(failures: Partial<FailureConfig>[]): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (const partial of failures) {
    const config = { ...DEFAULT_FAILURE, ...partial };

    if (!Number.isFinite(config.probability) || config.probability < 0 || config.probability > 1) {
      throw new Error(`${config.type}: probability must be within [0, 1], got ${String(config.probability)}`);
    }
    if (!Number.isInteger(config.failEveryN) || config.failEveryN < 0) {
      throw new Error(`${config.type}: failEveryN must be a non-negative integer, got ${String(config.failEveryN)}`);
    }
    if (!Number.isInteger(config.maxFailures) || config.maxFailures < -1) {
      throw new Error(`${config.type}: maxFailures must be -1 or greater, got ${String(config.maxFailures)}`);
    }
    if (!Number.isFinite(config.latencyMs) || config.latencyMs < 0) {
      throw new Error(`${config.type}: latencyMs must be non-negative, got ${String(config.latencyMs)}`);
    }
    if (config.type !== 'connection_drop' && partial.on !== undefined) {
      throw new Error(`${config.type}: 'on' applies to connection_drop only; this type is observed at emit()`);
    }

    const key = keyOf(config);
    if (seen.has(key)) {
      throw new Error(
        `${key}: configured twice; the second entry could never fire, so it is refused rather than ignored`,
      );
    }
    seen.add(key);
    entries.push({ config, injected: 0 });
  }

  return entries;
}

// ── CDCFailureInjector ─────────────────────────────────────

/**
 * Wraps an `ICDCSink` and injects the faults it is configured with.
 *
 * Every injection is counted by the entry that made it, so `failureCount`
 * answers "how many faults did this instrument fire" and each entry's own
 * budget is spent only by itself.
 */
export class CDCFailureInjector implements ICDCSink {
  readonly name: string;

  private readonly sink: ICDCSink;
  private readonly entries: Entry[];
  private _connected = false;
  private emitCount = 0;

  constructor(sink: ICDCSink, failures: Partial<FailureConfig>[]) {
    this.sink = sink;
    this.name = `failure-${sink.name}`;
    this.entries = normalise(failures);
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(): Promise<void> {
    const drop = this._entry('connection_drop', 'connect');
    if (drop && this._shouldFail(drop, 'connect')) {
      drop.injected += 1;
      throw new Error(`${this.name}: injected connection failure`);
    }
    await this.sink.connect();
    this._connected = true;
  }

  /**
   * Releases the connection and lets the wrapped sink's error through.
   *
   * It used to be swallowed as "best-effort", which is the caller's policy to
   * choose, not the instrument's to assume.
   */
  async disconnect(): Promise<void> {
    this._connected = false;
    await this.sink.disconnect();
  }

  // ── Emit ─────────────────────────────────────────────────

  async emit(events: CDCSinkEvent[]): Promise<void> {
    if (!this._connected) throw new Error(`${this.name}: not connected`);

    this.emitCount++;

    const latency = this._entry('latency_spike', 'emit');
    if (latency && this._shouldFail(latency, 'emit')) {
      latency.injected += 1;
      await this._delay(latency.config.latencyMs);
    }

    const partial = this._entry('partial_emit', 'emit');
    if (partial && this._shouldFail(partial, 'emit') && events.length > 1) {
      partial.injected += 1;
      // Half the batch lands, then the call fails: the caller must retry the
      // whole batch, and the sink sees the first half twice. That is the point.
      const half = Math.ceil(events.length / 2);
      await this.sink.emit(events.slice(0, half));
      throw new Error(`${this.name}: injected partial emit failure at event ${half}`);
    }

    const reorder = this._entry('reorder_inject', 'emit');
    if (reorder && this._shouldFail(reorder, 'emit') && events.length >= 2) {
      reorder.injected += 1;
      // Reversed and reported as success: a consumer that only retries on
      // failure never learns, which is what makes this fault worth having.
      await this.sink.emit([...events].reverse());
      return;
    }

    const duplicate = this._entry('duplicate_inject', 'emit');
    if (duplicate && this._shouldFail(duplicate, 'emit')) {
      duplicate.injected += 1;
      await this.sink.emit(events);
      await this.sink.emit(events);
      return;
    }

    const drop = this._entry('connection_drop', 'emit');
    if (drop && this._shouldFail(drop, 'emit')) {
      drop.injected += 1;
      this._connected = false;
      throw new Error(`${this.name}: injected connection drop during emit`);
    }

    await this.sink.emit(events);
  }

  // ── Stats ─────────────────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  /** Faults this instrument has injected, across every entry. */
  get failureCount(): number {
    return this.entries.reduce((sum, entry) => sum + entry.injected, 0);
  }

  /** `emit()` calls made, including the ones that failed. */
  get totalEmits(): number {
    return this.emitCount;
  }

  /** Faults injected by one type, which is what a per-entry budget governs. */
  injectedBy(type: FailureType): number {
    return this.entries.filter((entry) => entry.config.type === type).reduce((sum, entry) => sum + entry.injected, 0);
  }

  /** Re-arms every budget and clears the counters. The configuration stays. */
  reset(): void {
    for (const entry of this.entries) entry.injected = 0;
    this.emitCount = 0;
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * The entry that governs `type` at `point`.
   *
   * `on` decides only for `connection_drop`; every other type is observed at
   * `emit()`, which is why `normalise` refuses an `on` on those types.
   */
  private _entry(type: FailureType, point: 'connect' | 'emit'): Entry | undefined {
    return this.entries.find(
      (entry) =>
        entry.config.type === type &&
        (point === 'connect' ? entry.config.on !== 'emit' : entry.config.on !== 'connect'),
    );
  }

  private _shouldFail(entry: Entry, point: 'connect' | 'emit'): boolean {
    const { config } = entry;

    if (config.maxFailures >= 0 && entry.injected >= config.maxFailures) return false;

    // Every-N is deterministic and counts emit() calls. `connect()` is not an
    // emit, so an every-N entry never fires there — `probability` is the only
    // way to make a connection fail before it is established.
    if (config.failEveryN > 0) {
      return point === 'emit' && this.emitCount > 0 && this.emitCount % config.failEveryN === 0;
    }

    return Math.random() < config.probability;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
