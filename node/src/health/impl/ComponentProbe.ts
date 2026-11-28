/**
 * ComponentProbe — A concrete IHealthProbe that wraps simple check functions.
 *
 * For components that don't need a full class, this allows creating a
 * health probe from three simple function callbacks.
 *
 * @module @agentix-e/db-node/health/impl
 */

import type { IHealthProbe, ProbeAnswer } from '../interfaces/IHealthProbe.js';

/**
 * Create an IHealthProbe from simple function callbacks.
 *
 * @example
 * ```ts
 * const probe = componentProbe('disk', 'Disk Monitor', {
 *   liveness: () => ({ ok: true }),
 *   readiness: async () => {
 *     const free = await diskFreeMb();
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
    liveness: () => ProbeAnswer;
    readiness?: () => ProbeAnswer;
    startup?: () => ProbeAnswer;
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
