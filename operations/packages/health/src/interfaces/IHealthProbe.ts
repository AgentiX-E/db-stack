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
 * @module @agentix-e/db-operations-health/interfaces
 */

import type { ProbeResult } from '@agentix-e/db-operations-core/types';

/**
 * Health probe interface.
 *
 * Implementations should be:
 * - Fast (< 10ms for liveness, < 100ms for readiness)
 * - Non-blocking (no network I/O in liveness)
 * - Idempotent
 * - Safe to call concurrently
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
   * Must complete quickly (< 10ms). No I/O, no network calls.
   */
  liveness(): ProbeResult;

  /**
   * Readiness probe — can the component serve requests?
   *
   * Checks deeper than liveness:
   * - Dependencies available (storage, peers)
   * - Leader elected (for Raft-based components)
   * - Resources not exhausted
   *
   * May do I/O but should have a timeout (< 100ms).
   */
  readiness(): ProbeResult;

  /**
   * Startup probe — has the component finished initialization?
   *
   * Used by K8s to delay liveness/readiness checks during slow startup.
   * Returns ok:true after the first successful readiness check.
   */
  startup(): ProbeResult;
}
