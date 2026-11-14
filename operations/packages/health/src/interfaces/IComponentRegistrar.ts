/**
 * IComponentRegistrar — Component lifecycle registration interface.
 *
 * Allows components to dynamically register/unregister themselves
 * with the health orchestration system. Components that are started
 * and stopped at runtime (e.g., shards, connections) can use this.
 *
 * @module @agentix-e/db-operations-health/interfaces
 */

import type { IHealthProbe } from './IHealthProbe.js';
import type { ComponentHealth } from '@agentix-e/db-operations-core/types';

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
  registerComponent(
    probe: IHealthProbe,
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
  getComponentHealth(): ComponentHealth[];

  /**
   * Get the summary health of all components (aggregate status).
   *
   * Returns:
   * - 'healthy' if all components report healthy
   * - 'degraded' if some components report warning or one is unhealthy
   * - 'unhealthy' if all components are unhealthy
   */
  getAggregateStatus(): { status: 'healthy' | 'degraded' | 'unhealthy'; count: number };
}

export interface ComponentRegistrationOptions {
  /** Optional metadata key-value pairs. */
  metadata?: Record<string, string>;
  /** Whether the component is critical (failure degrades overall status). */
  critical?: boolean;
}
