/**
 * MonotonicUptime — uptime must never report a negative number of seconds.
 *
 * HealthOrchestrator measured uptime as `Date.now() - startTime`. A wall-clock
 * step backwards (NTP, VM migration, manual adjustment) made that difference
 * negative, and `Math.trunc` published a negative `uptimeSeconds` to every
 * dashboard and summary — a number that cannot describe an uptime at all.
 * The clock is injected here so the regression is deterministic.
 *
 * @module @agentix-e/db-node/health/__tests__
 */

import { describe, expect, it } from 'vitest';

import { HealthOrchestrator } from '../impl/HealthOrchestrator.js';

describe('HealthOrchestrator — uptime survives a backwards clock step', () => {
  it('MU.1 — system uptime is never negative after the wall clock steps back', async () => {
    let t = 100_000;
    const clock = { now: () => t };
    const orchestrator = new HealthOrchestrator({ clock });
    orchestrator.registerFunctional('ok', 'Ok', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });

    t = 200_000; // 100 s of life
    const before = await orchestrator.getHealthStatus();
    expect(before.uptimeSeconds).toBe(100);

    t = 150_000; // NTP steps the wall clock back 50 s
    const after = await orchestrator.getHealthStatus();
    expect(after.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(after.uptimeSeconds).toBe(100); // watermark held
  });

  it('MU.2 — component uptime is never negative after a backwards step', async () => {
    let t = 500;
    const clock = { now: () => t };
    const orchestrator = new HealthOrchestrator({ clock });
    orchestrator.registerFunctional('ok', 'Ok', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });

    t = 4_500; // 4 s since registration
    const before = await orchestrator.getComponentHealth();
    expect(before[0]!.uptimeSeconds).toBe(4);

    t = 1_000; // step back
    const after = await orchestrator.getComponentHealth();
    expect(after[0]!.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(after[0]!.uptimeSeconds).toBe(4);
  });
});
