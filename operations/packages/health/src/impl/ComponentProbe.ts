/**
 * ComponentProbe — A concrete IHealthProbe that wraps simple check functions.
 *
 * For components that don't need a full class, this allows creating a
 * health probe from three simple function callbacks.
 *
 * @module @agentix-e/db-operations-health/impl
 */

import type { IHealthProbe } from '../interfaces/IHealthProbe.js';
import type { ProbeResult } from '@agentix-e/db-operations-core/types';

/**
 * Create an IHealthProbe from simple function callbacks.
 *
 * @example
 * ```ts
 * const probe = componentProbe('disk', 'Disk Monitor', {
 *   liveness: () => ({ ok: true }),
 *   readiness: () => {
 *     const free = checkDiskFree();
 *     return { ok: free > 100, message: `Disk free: ${free}MB` };
 *   },
 *   startup: () => ({ ok: true }),
 * });
 * ```
 */
export function componentProbe(
  probeId: string,
  componentName: string,
  checks: {
    liveness: () => ProbeResult;
    readiness?: () => ProbeResult;
    startup?: () => ProbeResult;
  },
): IHealthProbe {
  const live = checks.liveness;
  const ready = checks.readiness ? checks.readiness : live;
  const started = checks.startup ? checks.startup : ready;
  return {
    probeId,
    componentName,
    liveness: live,
    readiness: ready,
    startup: started,
  };
}
