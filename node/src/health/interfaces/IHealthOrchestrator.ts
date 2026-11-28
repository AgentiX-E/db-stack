/**
 * IHealthOrchestrator — Top-level health orchestration interface.
 *
 * Combines IComponentRegistrar and K8s probe APIs into a unified
 * interface that serves both internal consumers and external probes
 * (such as HTTP health check endpoints or K8s exec probes).
 *
 * @module @agentix-e/db-node/health/interfaces
 */

import type { HealthStatus } from '../../core/types.js';
import type { IComponentRegistrar } from './IComponentRegistrar.js';

/**
 * Health orchestrator.
 *
 * Key design points:
 * - `liveness()` runs all registered probes (fast). Returns PASS/FAIL.
 * - `readiness()` runs all registered probes + deeper checks. Returns PASS/FAIL.
 * - `getHealthStatus()` returns a structured HealthStatus for monitoring dashboards.
 * - `getSummary()` returns a concise status string suitable for logging or CLI.
 *
 * Every answer is awaited, because a probe may legitimately reach a dependency.
 * A caller that wants a Kubernetes exec probe must await the result as well;
 * the verdict is only as old as the answers it aggregated.
 */
export interface IHealthOrchestrator extends IComponentRegistrar {
  /**
   * K8s-style liveness check.
   * Fails if any registered component fails its liveness probe.
   */
  liveness(): Promise<{ ok: boolean; errors: string[] }>;

  /**
   * K8s-style readiness check.
   * Fails if any registered component fails its readiness probe.
   * Also fails if the overall status is 'unhealthy'.
   */
  readiness(): Promise<{ ok: boolean; errors: string[] }>;

  /**
   * K8s-style startup check.
   * Checks that all registered components have completed startup.
   */
  startup(): Promise<{ ok: boolean; errors: string[] }>;

  /**
   * Get structured health status with all component details.
   */
  getHealthStatus(): Promise<HealthStatus>;

  /**
   * Get a concise one-line summary string.
   */
  getSummary(): Promise<string>;
}
