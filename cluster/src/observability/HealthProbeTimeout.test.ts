/**
 * HealthProbeTimeout — a peer probe that never answers degrades readiness.
 *
 * cluster's HealthProbe.readiness() used to `await` each registered probe with
 * no deadline. A Raft peer check that hung left readiness — and the /health
 * endpoint built on fullStatus() — pending, which is the one state a health
 * endpoint must never be in. These cases drive a real, unresolved deferred so
 * the verdict can only come from the deadline. The timer is injected so the
 * deadline is tested without sleeping on the wall clock, and that same seam is
 * what keeps the component engine-agnostic.
 *
 * @module db-cluster/observability
 */

import { describe, expect, it } from 'vitest';

import { HealthProbe } from './HealthProbe';

function never(): Promise<never> {
  return new Promise<never>(() => {});
}

async function within<T>(work: Promise<T>, ms = 1500): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error('readiness hung')), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(handle!);
  }
}

class ManualTimer {
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

describe('HealthProbe timeout — cluster', () => {
  it('TP.1 — a hung peer probe degrades readiness and names the probe', async () => {
    const health = new HealthProbe({ probeTimeoutMs: 20 });
    health.markStartupComplete();
    health.register('peer', () => never());

    const verdict = await within(health.readiness());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('peer');
    expect(verdict.reason).toContain('timed out');
  });

  it('TP.2 — later probes still run after one times out', async () => {
    const health = new HealthProbe({ probeTimeoutMs: 20 });
    health.markStartupComplete();
    health.register('hung', () => never());
    health.register('down', () => ({ ok: false, reason: 'closed', latencyMs: 0 }));

    const verdict = await within(health.readiness());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('hung');
    expect(verdict.reason).toContain('down (closed)');
  });

  it('TP.3 — a probe inside the budget keeps readiness healthy', async () => {
    const health = new HealthProbe({ probeTimeoutMs: 100 });
    health.markStartupComplete();
    health.register('fast', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, latencyMs: 5 };
    });

    expect((await within(health.readiness())).ok).toBe(true);
  });

  it('TP.4 — fullStatus never hangs on a deferred probe', async () => {
    const health = new HealthProbe({ probeTimeoutMs: 20 });
    health.markStartupComplete();
    health.register('hung', () => never());

    const status = await within(health.fullStatus());
    expect(status.probes.readiness?.ok).toBe(false);
    expect(status.probes.readiness?.reason).toContain('timed out');
  });

  it('TP.5 — a deployment can supply its own clock for the deadline', async () => {
    const timer = new ManualTimer();
    const health = new HealthProbe({ probeTimeoutMs: 50, timer });
    health.markStartupComplete();
    health.register('hung', () => never());

    const pending = health.readiness();
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]!.ms).toBe(50);
    timer.fire();
    const verdict = await within(pending);
    expect(verdict.ok).toBe(false);
    expect(timer.cleared).toHaveLength(1);
  });

  it('TP.6 — the default deadline matches the readiness contract', async () => {
    const health = new HealthProbe();
    health.markStartupComplete();
    health.register('hung', () => never());

    const verdict = await within(health.readiness(), 3000);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('100ms');
  });

  it('TP.7 — a non-Error rejection and a nameless failure are both reported by name', async () => {
    const health = new HealthProbe({ probeTimeoutMs: 100 });
    health.markStartupComplete();
    health.register('thrown-value', () => Promise.reject('a string is not an Error'));
    health.register('nameless', () => ({ ok: false, latencyMs: 0 }));

    const verdict = await within(health.readiness());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('a string is not an Error');
    expect(verdict.reason).toContain('nameless');
  });
});
