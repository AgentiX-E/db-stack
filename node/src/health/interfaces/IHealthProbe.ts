/**
 * IHealthProbe — K8s-style health probe interface.
 *
 * Three probe types as defined by Kubernetes:
 * - `liveness()`: Is the component alive? Restart if fails.
 * - `readiness()`: Is the component ready to serve? Remove from Service if fails.
 * - `startup()`: Has the component completed initialization? Delays liveness checks.
 *
 * Every component in the database engine implements this interface.
 * The orchestrator aggregates them into a unified HealthStatus.
 *
 * A probe may answer synchronously or asynchronously. Readiness in particular
 * exists to answer a question about a dependency, and a dependency is reached
 * over I/O; declaring that answer as `ProbeResult` alone made such a probe
 * impossible to express. The orchestrator awaits either shape, so an engine
 * adapter can keep its in-process checks synchronous and let the one check that
 * needs a round trip return a promise. A promise is not a licence to block:
 * liveness stays < 10 ms and readiness < 100 ms including the awaited work.
 *
 * @module @agentix-e/db-node/health/interfaces
 */

import type { ProbeResult } from '../../core/types.js';

/** Either shape a probe is allowed to answer with. */
export type ProbeAnswer = ProbeResult | Promise<ProbeResult>;

/**
 * Health probe interface.
 *
 * Implementations should be:
 * - Fast (< 10ms for liveness, < 100ms for readiness)
 * - Idempotent
 * - Safe to call concurrently
 * - Non-blocking in liveness: no network I/O, even through a promise
 */
export interface IHealthProbe {
  /** Unique probe identifier. */
  readonly probeId: string;

  /** Human-readable component name. */
  readonly componentName: string;

  /**
   * Liveness probe — is the component alive?
   *
   * Should only check in-process state:
   * - Is the thread/event loop responsive?
   * - Is there a fatal error?
   *
   * Must complete quickly (< 10ms). No I/O, no network calls. Implementations
   * that need no I/O may answer with a `ProbeResult` directly.
   */
  liveness(): ProbeAnswer;

  /**
   * Readiness probe — can the component serve requests?
   *
   * Checks deeper than liveness:
   * - Dependencies available (storage, peers)
   * - Leader elected (for Raft-based components)
   * - Resources not exhausted
   *
   * May do I/O and may answer with a promise, but must settle within its
   * timeout (< 100ms). The orchestrator awaits the answer before it decides.
   */
  readiness(): ProbeAnswer;

  /**
   * Startup probe — has the component finished initialization?
   *
   * Used by K8s to delay liveness/readiness checks during slow startup.
   * Returns ok:true after the first successful readiness check.
   */
  startup(): ProbeAnswer;
}
