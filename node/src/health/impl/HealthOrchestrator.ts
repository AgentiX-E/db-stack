/**
 * HealthOrchestrator — Concrete implementation of IHealthOrchestrator.
 *
 * Manages a registry of IHealthProbe instances and provides:
 * - Aggregate K8s-style probes (liveness, readiness, startup)
 * - Structured HealthStatus for monitoring dashboards
 * - Summary string for logging/CLI
 *
 * Thread-safe: reads/writes to the probe map are synchronized.
 *
 * @module @agentix-e/db-node/health/impl
 */

import type { IHealthOrchestrator } from '../interfaces/IHealthOrchestrator.js';
import type { IHealthProbe, ProbeAnswer } from '../interfaces/IHealthProbe.js';
import type { FunctionalChecks } from '../interfaces/IComponentRegistrar.js';
import type { ComponentHealth, ComponentRegistrationOptions, HealthStatus, ProbeResult } from '../../core/types.js';
import { componentProbe } from './ComponentProbe.js';

interface ProbeEntry {
  probe: IHealthProbe;
  registeredAt: number;
  critical: boolean;
  lastError: string | null;
}

/**
 * HealthOrchestrator — aggregates health probes and provides unified health API.
 */
export class HealthOrchestrator implements IHealthOrchestrator {
  private _probes = new Map<string, ProbeEntry>();
  private _startTime = Date.now();
  private _startupComplete = false;

  // ── Component Registration ─────────────────────────────────

  registerComponent(probe: IHealthProbe, options?: ComponentRegistrationOptions): void {
    this._probes.set(probe.probeId, {
      probe,
      registeredAt: Date.now(),
      critical: options?.critical ?? true,
      lastError: null,
    });
  }

  registerFunctional(
    probeId: string,
    componentName: string,
    checks: FunctionalChecks,
    options?: ComponentRegistrationOptions,
  ): void {
    this.registerComponent(
      componentProbe(probeId, componentName, {
        liveness: checks.liveness,
        readiness: checks.readiness,
        startup: checks.startup,
      }),
      options,
    );
  }

  unregisterComponent(probeId: string): void {
    this._probes.delete(probeId);
  }

  hasComponent(probeId: string): boolean {
    return this._probes.has(probeId);
  }

  // ── Probe Aggregation ──────────────────────────────────────

  async liveness(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    for (const [, entry] of this._probes) {
      try {
        const result = await this._answer(() => entry.probe.liveness());
        if (!result.ok) {
          errors.push(`[${entry.probe.probeId}] ${result.message ?? 'liveness failed'}`);
          entry.lastError = result.message ?? 'liveness failed';
        } else {
          entry.lastError = null;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${entry.probe.probeId}] liveness threw: ${msg}`);
        entry.lastError = msg;
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async readiness(): Promise<{ ok: boolean; errors: string[] }> {
    const { errors } = await this.liveness();
    for (const [, entry] of this._probes) {
      try {
        const result = await this._answer(() => entry.probe.readiness());
        if (!result.ok) {
          errors.push(`[${entry.probe.probeId}] ${result.message ?? 'readiness failed'}`);
          entry.lastError = result.message ?? 'readiness failed';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${entry.probe.probeId}] readiness threw: ${msg}`);
        entry.lastError = msg;
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async startup(): Promise<{ ok: boolean; errors: string[] }> {
    if (this._startupComplete) {
      return { ok: true, errors: [] };
    }

    const { errors } = await this.readiness();
    for (const [, entry] of this._probes) {
      try {
        const result = await this._answer(() => entry.probe.startup());
        if (!result.ok) {
          errors.push(`[${entry.probe.probeId}] ${result.message ?? 'startup not complete'}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${entry.probe.probeId}] startup threw: ${msg}`);
      }
    }

    if (errors.length === 0) {
      this._startupComplete = true;
    }

    return { ok: errors.length === 0, errors };
  }

  /** Returns whether startup checks have been completed. */
  isStartupComplete(): boolean {
    return this._startupComplete;
  }

  // ── Structured Health Status ───────────────────────────────

  async getComponentHealth(): Promise<ComponentHealth[]> {
    const results: ComponentHealth[] = [];
    for (const [, entry] of this._probes) {
      const livenessResult = await this._safeProbe(() => entry.probe.liveness());
      const readinessResult = await this._safeProbe(() => entry.probe.readiness());
      const elapsedMs = Date.now() - entry.registeredAt;
      const componentUptimeS = Math.trunc(elapsedMs / 1000);
      results.push({
        componentId: entry.probe.probeId,
        componentName: entry.probe.componentName,
        liveness: livenessResult,
        readiness: readinessResult,
        uptimeSeconds: componentUptimeS,
        lastError: entry.lastError,
      });
    }
    return results;
  }

  async getAggregateStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    count: number;
  }> {
    const components = await this.getComponentHealth();
    const total = components.length;
    if (total === 0) return { status: 'healthy', count: 0 };

    const healthy = components.filter((c) => c.liveness.ok && c.readiness.ok).length;
    const allUnhealthy = components.every((c) => !(c.liveness.ok || c.readiness.ok));

    if (allUnhealthy) return { status: 'unhealthy', count: total };
    if (healthy === total) return { status: 'healthy', count: total };
    return { status: 'degraded', count: total };
  }

  async getHealthStatus(): Promise<HealthStatus> {
    const components = await this.getComponentHealth();
    const total = components.length;
    const healthy = components.filter((c) => c.liveness.ok && c.readiness.ok).length;
    const allUnhealthy = total > 0 && components.every((c) => !(c.liveness.ok || c.readiness.ok));

    const status: 'healthy' | 'degraded' | 'unhealthy' =
      total === 0 ? 'healthy' : allUnhealthy ? 'unhealthy' : healthy === total ? 'healthy' : 'degraded';

    const errored = components.find((c) => c.lastError !== null);
    const lastError = errored ? errored.lastError : null;
    const systemElapsedMs = Date.now() - this._startTime;
    const systemUptimeS = Math.trunc(systemElapsedMs / 1000);

    return {
      status,
      uptimeSeconds: systemUptimeS,
      components,
      lastError,
    };
  }

  async getSummary(): Promise<string> {
    const status = await this.getHealthStatus();
    const total = status.components.length;
    const healthy = status.components.filter((c) => c.liveness.ok && c.readiness.ok).length;
    const failing = total - healthy;

    return [
      `Status: ${status.status}`,
      `Uptime: ${status.uptimeSeconds}s`,
      `Components: ${healthy}/${total} healthy`,
      failing > 0 ? `Failing: ${failing} component(s)` : '',
      status.lastError ? `Last error: ${status.lastError}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
  }

  // ── Private ────────────────────────────────────────────────

  private async _safeProbe(fn: () => ProbeAnswer): Promise<ProbeResult> {
    try {
      return await this._answer(fn);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run one probe and await whatever it answered with.
   *
   * A promise used to be refused by name, because the type said `ProbeResult`
   * and reading `undefined.ok` reported a healthy database as down. That fixed
   * the diagnosis but not the product: a readiness check that needs to reach
   * storage had no way to express itself. The type now admits either shape and
   * this method awaits it, so a thenable from another realm or a hand-written
   * deferred is handled the same way as a native promise — `await` is the only
   * judgement that does not depend on the object's origin. What is still
   * refused is an answer that is not a result at all: reporting `undefined` as
   * "unhealthy" hides a broken probe behind a verdict about the database.
   *
   * The probe is invoked through a thunk rather than passed as a value, so a
   * class probe that reads its own state keeps its receiver. Passing
   * `entry.probe.liveness` directly detached it, and every implementation that
   * touched a private field threw inside `_safeProbe` and reported the component
   * as unhealthy — the same silent verdict this method exists to stop.
   */
  private async _answer(fn: () => ProbeAnswer): Promise<ProbeResult> {
    const result = await fn();
    if (result === null || typeof result !== 'object' || typeof (result as ProbeResult).ok !== 'boolean') {
      throw new Error(
        'the probe returned a value that is not a ProbeResult: an answer must be an object with a boolean ok',
      );
    }
    return result;
  }
}
