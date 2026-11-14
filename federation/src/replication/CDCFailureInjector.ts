/**
 * I25 — B3 CDC Hardening: CDCFailureInjector.
 *
 * Controlled fault injection for CDC pipelines.
 * Supports:
 *   - Connection drop simulation
 *   - Partial emit failures
 *   - Latency injection
 *   - Duplicate event injection
 *   - Reorder injection (out-of-order events)
 */

import type { ICDCSink, CDCEvent } from "../interfaces/replication/ICDCSink";

// ── Types ──────────────────────────────────────────────────

export type FailureType =
  | "connection_drop"
  | "partial_emit"
  | "latency_spike"
  | "duplicate_inject"
  | "reorder_inject";

export interface FailureConfig {
  /** Type of failure to inject */
  type: FailureType;
  /** Probability of failure per operation (0-1). Default: 0.1 */
  probability: number;
  /** Additional latency to inject (ms). Default: 100 */
  latencyMs: number;
  /** Fail every N-th emit. 0 = random (probability-based). Default: 0 */
  failEveryN: number;
  /** Maximum number of failures to inject. -1 = unlimited. Default: -1 */
  maxFailures: number;
}

const DEFAULT_FAILURE: FailureConfig = {
  type: "connection_drop",
  probability: 0.1,
  latencyMs: 100,
  failEveryN: 0,
  maxFailures: -1,
};

// ── CDCFailureInjector ─────────────────────────────────────

/**
 * Wraps an ICDCSink and injects controlled failures for testing.
 * Used to verify exactly-once semantics, retry behavior, and
 * recovery under fault conditions.
 */
export class CDCFailureInjector implements ICDCSink {
  readonly name: string;

  private readonly sink: ICDCSink;
  private readonly failures: FailureConfig[];
  private _connected = false;
  private emitCount = 0;
  private injectedFailures = 0;

  constructor(sink: ICDCSink, failures: Partial<FailureConfig>[]) {
    this.sink = sink;
    this.name = `failure-${sink.name}`;
    this.failures = failures.map((f) => ({ ...DEFAULT_FAILURE, ...f }));
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(): Promise<void> {
    const connFail = this._shouldFail("connection_drop");
    if (connFail) {
      this._recordFailure();
      throw new Error(`${this.name}: injected connection failure`);
    }
    await this.sink.connect();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    try {
      await this.sink.disconnect();
    } catch {
      // Best-effort
    }
  }

  // ── Emit ─────────────────────────────────────────────────

  async emit(events: CDCEvent[]): Promise<void> {
    if (!this._connected) throw new Error(`${this.name}: not connected`);

    this.emitCount++;

    // Check for latency injection
    const latencyFail = this._getFailure("latency_spike");
    if (latencyFail && this._shouldFail("latency_spike")) {
      this._recordFailure();
      await this._delay(latencyFail.latencyMs);
    }

    // Check for partial emit failure
    const partialFail = this._getFailure("partial_emit");
    if (partialFail && this._shouldFail("partial_emit") && events.length > 1) {
      this._recordFailure();
      // Emit only the first half, then fail
      const half = Math.ceil(events.length / 2);
      await this.sink.emit(events.slice(0, half));
      throw new Error(`${this.name}: injected partial emit failure at event ${half}`);
    }

    // Check for reorder injection
    const reorderFail = this._getFailure("reorder_inject");
    if (reorderFail && this._shouldFail("reorder_inject") && events.length >= 2) {
      this._recordFailure();
      // Reverse the order of events
      await this.sink.emit([...events].reverse());
      return;
    }

    // Check for duplicate injection
    const dupFail = this._getFailure("duplicate_inject");
    if (dupFail && this._shouldFail("duplicate_inject")) {
      this._recordFailure();
      // Emit twice
      await this.sink.emit(events);
      await this.sink.emit(events);
      return;
    }

    // Check for connection drop during emit
    if (this._shouldFail("connection_drop")) {
      this._recordFailure();
      this._connected = false;
      throw new Error(`${this.name}: injected connection drop during emit`);
    }

    await this.sink.emit(events);
  }

  // ── Stats ─────────────────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  get failureCount(): number {
    return this.injectedFailures;
  }

  get totalEmits(): number {
    return this.emitCount;
  }

  /** Reset failure counters (does NOT reset the failure config). */
  reset(): void {
    this.injectedFailures = 0;
    this.emitCount = 0;
  }

  // ── Internal ─────────────────────────────────────────────

  private _getFailure(type: FailureType): FailureConfig | undefined {
    return this.failures.find((f) => f.type === type);
  }

  private _shouldFail(type: FailureType): boolean {
    const cfg = this._getFailure(type);
    if (!cfg) return false;

    // Check max failures exhausted
    if (cfg.maxFailures >= 0 && this.injectedFailures >= cfg.maxFailures) {
      return false;
    }

    // Deterministic every-N mode
    if (cfg.failEveryN > 0) {
      return this.emitCount > 0 && this.emitCount % cfg.failEveryN === 0;
    }

    // Probabilistic mode
    return Math.random() < cfg.probability;
  }

  private _recordFailure(): void {
    this.injectedFailures++;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
