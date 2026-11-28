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

/** Either shape a registered probe may answer with. */
export type ProbeAnswer = ProbeResult | Promise<ProbeResult>;

/** Minimal clock a deployment can inject for the readiness deadline. */
export interface ProbeTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The readiness budget the node probe contract advertises (under 100 ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 100;

/** Engine-agnostic deadline options for the registry. */
export interface HealthProbeOptions {
  /** Maximum time a registered probe may take before it is named as timed out. */
  probeTimeoutMs?: number;
  /** Optional clock; defaults to the host timers. */
  timer?: ProbeTimer;
}

/**
 * Race a registered probe against a deadline, returning a named failed result
 * on expiry rather than leaving readiness pending for ever. The clock is a
 * callback so the registry stays engine-agnostic and the deadline is testable
 * without sleeping.
 */
async function withDeadline(
  probe: () => ProbeAnswer,
  timeoutMs: number,
  timer: ProbeTimer | undefined,
): Promise<ProbeResult> {
  const hostTimer: ProbeTimer = timer ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let handle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = hostTimer.setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(probe), deadline]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), latencyMs: 0 };
  } finally {
    hostTimer.clearTimeout(handle);
  }
}

/**
 * HealthProbe registry — aggregates multiple IHealthProbe instances.
 *
 * A registered probe may answer directly or await a dependency. Readiness is
 * the check that asks whether peers are reachable, so refusing a promise here
 * would make the one question that needs I/O impossible to put to the registry.
 * Every answer is bounded by a deadline: a peer that never replies degrades
 * readiness by name instead of holding the /health endpoint open for ever.
 */
export class HealthProbe {
  private readonly _probes: Map<string, () => ProbeAnswer> = new Map();
  private _fatalErrors = 0;
  private _startupComplete = false;
  private readonly _listenerFailures: ListenerFailure[] = [];
  private readonly _probeTimeoutMs: number;
  private readonly _timer: ProbeTimer | undefined;

  constructor(options: HealthProbeOptions = {}) {
    this._probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this._timer = options.timer;
  }

  register(name: string, probe: () => ProbeAnswer): void {
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
  async readiness(): Promise<ProbeResult> {
    const t0 = performance.now();
    if (!this._startupComplete) {
      return { ok: false, reason: 'startup not complete', latencyMs: performance.now() - t0 };
    }
    const results: Record<string, ProbeResult> = {};
    let allOk = true;
    for (const [name, probe] of this._probes) {
      const r = await withDeadline(probe, this._probeTimeoutMs, this._timer);
      results[name] = r;
      if (!r.ok) allOk = false;
    }
    const problems: string[] = [];
    if (!allOk) {
      // Name the reason as well as the probe: a verdict that says only "peer"
      // sends an operator to find out why, and the reason is already in hand.
      const failed = Object.entries(results)
        .filter(([, r]) => !r.ok)
        .map(([n, r]) => (r.reason === undefined ? n : `${n} (${r.reason})`))
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
  async fullStatus(): Promise<HealthStatus> {
    const probeResults: Record<string, ProbeResult> = {
      liveness: this.liveness(),
      readiness: await this.readiness(),
      startup: this.startup(),
    };
    const allOk = Object.values(probeResults).every((r) => r.ok);
    return {
      status: allOk ? 'healthy' : 'degraded',
      probes: probeResults,
    };
  }
}
