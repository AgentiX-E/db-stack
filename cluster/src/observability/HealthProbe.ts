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

/**
 * HealthProbe registry — aggregates multiple IHealthProbe instances.
 */
export class HealthProbe {
  private readonly _probes: Map<string, () => ProbeResult> = new Map();
  private _fatalErrors = 0;
  private _startupComplete = false;

  register(name: string, probe: () => ProbeResult): void {
    this._probes.set(name, probe);
  }

  markStartupComplete(): void {
    this._startupComplete = true;
  }

  recordFatalError(): void {
    this._fatalErrors++;
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
    if (!allOk) {
      const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([n]) => n).join(', ');
      return { ok: false, reason: `unhealthy probes: ${failed}`, latencyMs: performance.now() - t0 };
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
    const allOk = Object.values(probeResults).every(r => r.ok);
    return {
      status: allOk ? 'healthy' : 'degraded',
      probes: probeResults,
    };
  }
}
