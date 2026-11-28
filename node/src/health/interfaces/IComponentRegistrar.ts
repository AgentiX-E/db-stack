/**
 * IComponentRegistrar — Component lifecycle registration interface.
 *
 * Allows components to dynamically register/unregister themselves
 * with the health orchestration system. Components that are started
 * and stopped at runtime (e.g., shards, connections) can use this.
 *
 * @module @agentix-e/db-node/health/interfaces
 */

import type { IHealthProbe, ProbeAnswer } from './IHealthProbe.js';
import type { ComponentHealth } from '../../core/types.js';

/**
 * Component registration for health orchestration.
 */
export interface IComponentRegistrar {
  /**
   * Register a component's health probe.
   *
   * @param probe - Health probe implementation.
   * @param options - Optional registration metadata.
   */
  registerComponent(probe: IHealthProbe, options?: ComponentRegistrationOptions): void;

  /**
   * Register a component by supplying its probe functions directly.
   *
   * The convenience path for callers that have three closures rather than an
   * `IHealthProbe` implementation — which is every engine adapter, every
   * service and every test harness in this repository. It was implemented on
   * `HealthOrchestrator` and used everywhere, but declared on no interface, so
   * a consumer holding an `IHealthOrchestrator` could not see it and every
   * fixture had to name the concrete class instead.
   */
  registerFunctional(
    probeId: string,
    componentName: string,
    checks: FunctionalChecks,
    options?: ComponentRegistrationOptions,
  ): void;

  /**
   * Unregister a component by its probeId.
   */
  unregisterComponent(probeId: string): void;

  /**
   * Check if a component is registered.
   */
  hasComponent(probeId: string): boolean;

  /**
   * Get the health of all registered components.
   */
  getComponentHealth(): Promise<ComponentHealth[]>;

  /**
   * Get the summary health of all components (aggregate status).
   *
   * Returns:
   * - 'healthy' if all components report healthy
   * - 'degraded' if some components report warning or one is unhealthy
   * - 'unhealthy' if all components are unhealthy
   */
  getAggregateStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    count: number;
  }>;
}

export interface ComponentRegistrationOptions {
  /** Optional metadata key-value pairs. */
  metadata?: Record<string, string>;
  /** Whether the component is critical (failure degrades overall status). */
  critical?: boolean;
}

/** The result a probe function returns. */
export interface FunctionalCheckResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * The probe functions a component supplies when it registers by function
 * reference rather than by implementing `IHealthProbe`. Any of the three may
 * return a promise; the orchestrator awaits it before aggregating a verdict.
 */
export interface FunctionalChecks {
  liveness: () => ProbeAnswer;
  readiness?: () => ProbeAnswer;
  startup?: () => ProbeAnswer;
}
