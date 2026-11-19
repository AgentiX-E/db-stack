/**
 * I25 — B3 CDC Hardening: CDCSink Resolver.
 *
 * Adds production hardenings to ICDCSink:
 *   - Connection retry with exponential backoff
 *   - Batch emit with configurable limits
 *   - Error propagation with typed failure modes
 *   - Health checks and liveness probes
 */

import type { ICDCSink, CDCSinkEvent } from '../interfaces/replication/ICDCSink';

// ── Types ──────────────────────────────────────────────────

export type RetryStrategy = 'fixed' | 'exponential' | 'none';

export interface CDCSinkResolverConfig {
  /** Name of the underlying sink */
  name?: string;
  /** Maximum connection retries. Default: 5 */
  maxRetries: number;
  /** Base delay between retries (ms). Default: 100 */
  retryBaseMs: number;
  /** Maximum delay between retries (ms). Default: 30_000 */
  retryMaxMs: number;
  /** Retry strategy. Default: "exponential" */
  retryStrategy: RetryStrategy;
  /** Maximum events per emit batch. Excess is split. Default: 1000 */
  maxBatchSize: number;
  /** Health check interval (ms). 0 disables. Default: 30_000 */
  healthCheckIntervalMs: number;
}

export interface ResolverHealth {
  connected: boolean;
  lastEmitTimestamp: number | null;
  totalEmitted: number;
  totalFailures: number;
  consecutiveFailures: number;
  uptimeMs: number;
}

export type SinkFailureMode =
  | { type: 'connection_lost' }
  | { type: 'emit_failed'; batchSize: number }
  | { type: 'retry_exhausted'; attempts: number };

export interface FailureEvent {
  mode: SinkFailureMode;
  timestamp: number;
  error: string;
}

const DEFAULT_CONFIG: CDCSinkResolverConfig = {
  maxRetries: 5,
  retryBaseMs: 100,
  retryMaxMs: 30_000,
  retryStrategy: 'exponential',
  maxBatchSize: 1000,
  healthCheckIntervalMs: 30_000,
};

// ── CDCSinkResolver ────────────────────────────────────────

export class CDCSinkResolver implements ICDCSink {
  readonly name: string;

  private readonly sink: ICDCSink;
  private readonly config: CDCSinkResolverConfig;
  private _connected = false;
  private totalEmitted = 0;
  private totalFailures = 0;
  private consecutiveFailures = 0;
  private lastEmitTimestamp: number | null = null;
  private startTime = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthListeners = new Set<(health: ResolverHealth) => void>();
  private failureListeners = new Set<(event: FailureEvent) => void>();

  constructor(sink: ICDCSink, config: Partial<CDCSinkResolverConfig> = {}) {
    this.sink = sink;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = config.name ?? `resolver-${sink.name}`;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(): Promise<void> {
    this.startTime = Date.now();
    await this._connectWithRetry();
    if (this.config.healthCheckIntervalMs > 0) {
      this._startHealthChecks();
    }
  }

  async disconnect(): Promise<void> {
    this._stopHealthChecks();
    // Marked disconnected before the await, not after: a sink that refuses to
    // release the connection has still left this resolver unable to write
    // through it, and the old ordering meant the flag was only cleared on the
    // path that succeeded. The error now reaches the caller for the same reason
    // it does in `emit()` — "best effort" is the caller's policy to choose.
    this._connected = false;
    await this.sink.disconnect();
  }

  // ── Emit ─────────────────────────────────────────────────

  async emit(events: CDCSinkEvent[]): Promise<void> {
    if (!this._connected) throw new Error(`${this.name}: cannot emit when disconnected`);

    if (events.length === 0) return;

    // Split large batches
    const batches = this._splitBatches(events);

    for (const batch of batches) {
      try {
        await this.sink.emit(batch);
        this._onEmitSuccess(batch.length);
      } catch (error) {
        // A refused batch aborts the rest of this call and the caller retries
        // the whole input: `_handleEmitFailure` never resolves, which is why it
        // is typed `Promise<never>` and returned rather than awaited.
        return this._handleEmitFailure(batch.length, error);
      }
    }
  }

  // ── Health ────────────────────────────────────────────────

  getHealth(): ResolverHealth {
    return {
      connected: this._connected,
      lastEmitTimestamp: this.lastEmitTimestamp,
      totalEmitted: this.totalEmitted,
      totalFailures: this.totalFailures,
      consecutiveFailures: this.consecutiveFailures,
      uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
    };
  }

  onHealthChange(callback: (health: ResolverHealth) => void): () => void {
    this.healthListeners.add(callback);
    return () => {
      this.healthListeners.delete(callback);
    };
  }

  onFailure(callback: (event: FailureEvent) => void): () => void {
    this.failureListeners.add(callback);
    return () => {
      this.failureListeners.delete(callback);
    };
  }

  /** Check if connected (liveness probe). */
  get connected(): boolean {
    return this._connected;
  }

  // ── Internal: Connection retry ────────────────────────────

  private async _connectWithRetry(): Promise<void> {
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      try {
        await this.sink.connect();
        this._connected = true;
        this._publishHealth();
        return;
      } catch (error) {
        attempt++;
        if (attempt >= this.config.maxRetries) {
          this._notifyFailure(
            {
              type: 'retry_exhausted',
              attempts: attempt,
            },
            error,
          );
          throw new Error(`${this.name}: connection failed after ${attempt} attempts: ${String(error)}`);
        }

        const delay = this._computeBackoff(attempt);
        await this._delay(delay);
      }
    }
  }

  private async _handleEmitFailure(batchSize: number, error: unknown): Promise<never> {
    this.totalFailures++;
    this.consecutiveFailures++;
    this._notifyFailure({ type: 'emit_failed', batchSize }, error);

    // A sink that refused a batch has to be reported as refused, always. This
    // branch used to `return`, which let `emit()` continue to the next batch and
    // resolve normally — a refusal that a caller could not observe, in the one
    // place whose whole purpose is to make failures observable. It is reachable
    // when `disconnect()` lands while an emit is in flight.
    if (!this._connected) throw error;

    this._connected = false;
    try {
      await this._connectWithRetry();
    } catch {
      this._notifyFailure({ type: 'connection_lost' }, error);
      throw error;
    }

    // Reconnected, but the failed batch was still refused: the caller decides
    // whether to retry it, so the refusal leaves through the same door.
    throw error;
  }

  private _onEmitSuccess(count: number): void {
    this.totalEmitted += count;
    this.consecutiveFailures = 0;
    this.lastEmitTimestamp = Date.now();
    this._publishHealth();
  }

  // ── Internal: Batching ────────────────────────────────────

  private _splitBatches(events: CDCSinkEvent[]): CDCSinkEvent[][] {
    const max = this.config.maxBatchSize;
    if (events.length <= max) return [events];

    const batches: CDCSinkEvent[][] = [];
    for (let i = 0; i < events.length; i += max) {
      batches.push(events.slice(i, i + max));
    }
    return batches;
  }

  // ── Internal: Backoff ─────────────────────────────────────

  private _computeBackoff(attempt: number): number {
    switch (this.config.retryStrategy) {
      case 'none':
        return 0;
      case 'fixed':
        return this.config.retryBaseMs;
      case 'exponential':
      default:
        return Math.min(this.config.retryBaseMs * Math.pow(2, attempt - 1), this.config.retryMaxMs);
    }
  }

  // ── Internal: Health checks ───────────────────────────────

  private _startHealthChecks(): void {
    this.healthTimer = setInterval(() => {
      void this._runHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }

  private _stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async _runHealthCheck(): Promise<void> {
    // Simple liveness: try a no-op emit
    try {
      // If connected, try a 0-event emit to verify the connection
      if (this._connected) {
        await this.sink.emit([]);
      }
      this.consecutiveFailures = 0;
    } catch {
      this.consecutiveFailures++;
    }
    this._publishHealth();
  }

  private _publishHealth(): void {
    const health = this.getHealth();
    for (const listener of this.healthListeners) {
      try {
        listener(health);
      } catch {
        /* noop */
      }
    }
  }

  private _notifyFailure(mode: SinkFailureMode, error: unknown): void {
    const event: FailureEvent = {
      mode,
      timestamp: Date.now(),
      error: String(error),
    };
    for (const listener of this.failureListeners) {
      try {
        listener(event);
      } catch {
        /* noop */
      }
    }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
