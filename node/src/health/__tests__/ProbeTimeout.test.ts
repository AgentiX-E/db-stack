/**
 * ProbeTimeout — the contract that a probe which never answers is a failure,
 * not a health endpoint that hangs forever.
 *
 * IHealthProbe documents readiness as "must settle within its timeout (<100ms)",
 * but the orchestrator used to `await` the answer with no deadline. A dependency
 * that never replied therefore kept liveness, readiness and every structured
 * view pending — the exact failure mode a liveness probe exists to detect. Every
 * case here drives a real deferred that only settles when the test says so, so
 * a passing case is evidence that the deadline, not the test, produced the
 * verdict. The timer is injected where the deadline itself is under test, which
 * is the engine-agnostic seam a deployment uses to supply its own clock.
 *
 * @module @agentix-e/db-node/health/__tests__
 */

import { describe, expect, it } from 'vitest';

import type { ProbeAnswer } from '../interfaces/IHealthProbe.js';
import { HealthOrchestrator } from '../impl/HealthOrchestrator.js';
import { settleWithin, ProbeTimeoutError, type ProbeTimer } from '../impl/ProbeTimeout.js';

/** A deferred that never settles unless the test resolves it. */
function never(): Promise<never> {
  return new Promise<never>(() => {});
}

/** Guard so a regression fails fast instead of waiting for Vitest's own timeout. */
async function within<T>(work: Promise<T>, ms = 1500): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error('the health view hung')), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(handle!);
  }
}

describe('ProbeTimeout — node health orchestrator', () => {
  it('PT.1 — a never-settling liveness probe becomes a named failure and later probes still run', async () => {
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 20 });
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => never(),
      readiness: () => never(),
    });
    orchestrator.registerFunctional('ok', 'Ok', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });

    const verdict = await within(orchestrator.liveness());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain('hung');
    expect(verdict.errors[0]).toContain('timed out');
    expect(verdict.errors[0]).toContain('20ms');
  });

  it('PT.2 — a timed-out readiness probe is named and a healthy peer is still checked', async () => {
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 20 });
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => ({ ok: true }),
      readiness: () => never(),
    });
    orchestrator.registerFunctional('down', 'Down', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: 'refused connections' }),
    });

    const verdict = await within(orchestrator.readiness());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toHaveLength(2);
    expect(verdict.errors[0]).toContain('hung');
    expect(verdict.errors[0]).toContain('timed out');
    expect(verdict.errors[1]).toContain('refused connections');
  });

  it('PT.3 — a timed-out startup probe does not mark startup complete', async () => {
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 20 });
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
      startup: () => never(),
    });

    const verdict = await within(orchestrator.startup());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toContain('timed out');
    expect(orchestrator.isStartupComplete()).toBe(false);
  });

  it('PT.4 — a probe that settles inside the budget is not reported as timed out', async () => {
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 100 });
    orchestrator.registerFunctional('slow-but-in-time', 'Slow', {
      liveness: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      },
      readiness: () => ({ ok: true }),
    });

    expect(await within(orchestrator.liveness())).toEqual({ ok: true, errors: [] });
  });

  it('PT.5 — structured views never hang on a deferred answer', async () => {
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 20 });
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => never(),
      readiness: () => never(),
    });

    const components = await within(orchestrator.getComponentHealth());
    expect(components[0]!.liveness.ok).toBe(false);
    expect(components[0]!.readiness.ok).toBe(false);
    expect(components[0]!.liveness.message).toContain('timed out');

    const aggregate = await within(orchestrator.getAggregateStatus());
    expect(aggregate.status).toBe('unhealthy');

    const status = await within(orchestrator.getHealthStatus());
    expect(status.status).toBe('unhealthy');

    const summary = await within(orchestrator.getSummary());
    expect(summary).toContain('Failing: 1 component(s)');
  });

  it('PT.6 — the default deadline matches the documented readiness budget', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => never(),
    });

    const verdict = await within(orchestrator.liveness(), 3000);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toContain('100ms');
  });

  it('PT.7 — a deployment can supply its own timer for the deadline', async () => {
    const timer = new ManualTimer();
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 50, timer });
    orchestrator.registerFunctional('hung', 'Hung', {
      liveness: () => never(),
    });

    const pending = orchestrator.liveness();
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]!.ms).toBe(50);
    expect(timer.cleared).toHaveLength(0);
    timer.fire();
    const verdict = await within(pending);
    expect(verdict.ok).toBe(false);
    expect(timer.cleared).toHaveLength(1);
  });

  it('PT.8 — a deferred that rejects after the deadline is not an unhandled rejection', async () => {
    let rejectLate: (reason?: unknown) => void = () => {};
    const late: ProbeAnswer = new Promise((_, reject) => {
      rejectLate = reject;
    });
    const orchestrator = new HealthOrchestrator({ probeTimeoutMs: 20 });
    orchestrator.registerFunctional('late', 'Late', {
      liveness: () => late,
    });

    const verdict = await within(orchestrator.liveness());
    expect(verdict.ok).toBe(false);
    rejectLate(new Error('too late'));
    await new Promise((r) => setTimeout(r, 30));
    expect(verdict.errors[0]).toContain('timed out');
  });
});

describe('settleWithin — engine-agnostic deadline primitive', () => {
  it('SW.1 — returns the value when work settles before the deadline', async () => {
    await expect(settleWithin(() => Promise.resolve(7), 100)).resolves.toBe(7);
  });

  it('SW.2 — returns a synchronous value without needing a tick', async () => {
    await expect(settleWithin(() => 42, 100)).resolves.toBe(42);
  });

  it('SW.3 — rejects with ProbeTimeoutError carrying the budget', async () => {
    await expect(settleWithin(() => never(), 33)).rejects.toMatchObject({
      name: 'ProbeTimeoutError',
      timeoutMs: 33,
      message: expect.stringContaining('33ms'),
    });
  });

  it("SW.4 — propagates the work's own rejection unchanged", async () => {
    const boom = new Error('boom');
    await expect(settleWithin(() => Promise.reject(boom), 100)).rejects.toBe(boom);
  });

  it('SW.5 — clears the handle when work settles first', async () => {
    const timer = new ManualTimer();
    await settleWithin(() => 1, 100, timer);
    expect(timer.cleared).toHaveLength(1);
  });

  it('SW.6 — clears the handle when the deadline wins', async () => {
    const timer = new ManualTimer();
    const pending = settleWithin(() => never(), 100, timer);
    timer.fire();
    await expect(pending).rejects.toBeInstanceOf(ProbeTimeoutError);
    expect(timer.cleared).toHaveLength(1);
  });
});

/** Deterministic timer: the deadline fires when the test says, not on the wall clock. */
class ManualTimer implements ProbeTimer {
  readonly scheduled: { fn: () => void; ms: number }[] = [];
  readonly cleared: unknown[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fn, ms };
    this.scheduled.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle);
  }

  fire(): void {
    for (const entry of this.scheduled) entry.fn();
  }
}
