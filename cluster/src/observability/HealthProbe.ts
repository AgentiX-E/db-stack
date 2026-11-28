/**
 * HealthProbe — K8s-compatible health checks for db-cluster.
 *
 * I13 invariant (OBS3): Every cluster node exposes liveness/readiness.
 *
 * Liveness: event loop responsive, no fatal errors
 * Readiness: Raft group active, leader known, peers connected
 * Startup:  all internal state machines initialized
 *
 * @module db-cluster/observability
 */

/** Result of a single health probe. */
export interface ProbeResult {
  ok: boolean;
  reason?: string;
  latencyMs: number;
}

/** Aggregated health status. */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  probes: Record<string, ProbeResult>;
}

/** One listener failure routed to the health verdict (C-04). */
export interface ListenerFailure {
  source: string;
  error?: unknown;
  at: number;
}

/**
 * HealthProbe registry — aggregates multiple IHealthProbe instances.
 */
export class HealthProbe {
  private readonly _probes: Map<string, () => ProbeResult> = new Map();
  private _fatalErrors = 0;
  private _startupComplete = false;
  private readonly _listenerFailures: ListenerFailure[] = [];

  register(name: string, probe: () => ProbeResult): void {
    this._probes.set(name, probe);
  }

  markStartupComplete(): void {
    this._startupComplete = true;
  }

  recordFatalError(): void {
    this._fatalErrors++;
  }

  /**
   * Record a failure a listener swallowed (C-04). Kept distinct from a fatal
   * error: a broken observer degrades readiness — the node should not take new
   * work until its health signals are trustworthy — but it does not mean the
   * process is dead, so liveness stays honest.
   */
  recordListenerFailure(source: string, error?: unknown, at: number = Date.now()): void {
    this._listenerFailures.push({ source, error, at });
  }

  /** The listener failures recorded so far, newest last. */
  get listenerFailures(): readonly ListenerFailure[] {
    return this._listenerFailures;
  }

  /** Liveness: is the process alive? (no I/O) */
  liveness(): ProbeResult {
    const t0 = performance.now();
    if (this._fatalErrors > 0) {
      return { ok: false, reason: `${this._fatalErrors} fatal errors`, latencyMs: performance.now() - t0 };
    }
    return { ok: true, latencyMs: performance.now() - t0 };
  }

  /** Readiness: can we serve requests? */
  readiness(): ProbeResult {
    const t0 = performance.now();
    if (!this._startupComplete) {
      return { ok: false, reason: 'startup not complete', latencyMs: performance.now() - t0 };
    }
    const results: Record<string, ProbeResult> = {};
    let allOk = true;
    for (const [name, probe] of this._probes) {
      const r = probe();
      results[name] = r;
      if (!r.ok) allOk = false;
    }
    const problems: string[] = [];
    if (!allOk) {
      const failed = Object.entries(results)
        .filter(([, r]) => !r.ok)
        .map(([n]) => n)
        .join(', ');
      problems.push(`unhealthy probes: ${failed}`);
    }
    if (this._listenerFailures.length > 0) {
      // Name each distinct source: a readiness that says "a listener failed"
      // spends an operator's time finding which one. The sources are exactly what
      // the reporter was told, so the verdict stays engine-agnostic.
      const sources = [...new Set(this._listenerFailures.map((f) => f.source))].join(', ');
      problems.push(`swallowed listener failures: ${sources}`);
    }
    if (problems.length > 0) {
      return { ok: false, reason: problems.join('; '), latencyMs: performance.now() - t0 };
    }
    return { ok: true, latencyMs: performance.now() - t0 };
  }

  /** Startup: is initialization complete? */
  startup(): ProbeResult {
    const t0 = performance.now();
    return {
      ok: this._startupComplete,
      reason: this._startupComplete ? undefined : 'initializing',
      latencyMs: performance.now() - t0,
    };
  }

  /** Full health status JSON (for /health endpoint). */
  fullStatus(): HealthStatus {
    const probeResults: Record<string, ProbeResult> = {
      liveness: this.liveness(),
      readiness: this.readiness(),
      startup: this.startup(),
    };
    const allOk = Object.values(probeResults).every((r) => r.ok);
    return {
      status: allOk ? 'healthy' : 'degraded',
      probes: probeResults,
    };
  }
}
