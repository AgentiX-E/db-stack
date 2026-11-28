/**
 * ComponentProbe tests — CP1 through CP7.
 *
 * Covers componentProbe factory function with fallback behavior
 * for readiness and startup when not provided.
 */

import { describe, it, expect } from 'vitest';
import { componentProbe } from '../impl/ComponentProbe.js';

const ok = { ok: true as const };
const notOk = { ok: false as const, message: 'fail' };
const warnOk = { ok: true as const, message: 'warning state' };

describe('CP: ComponentProbe factory', () => {
  // ── CP1: Basic probe with only liveness ──────────────

  it('CP1: probe with only liveness uses liveness as fallback for all checks', async () => {
    const probe = componentProbe('db', 'Database', {
      liveness: () => ok,
    });
    expect(probe.probeId).toBe('db');
    expect(probe.componentName).toBe('Database');
    expect(await probe.liveness()).toEqual(ok);
    expect(await probe.readiness()).toEqual(ok); // fallback to liveness
    expect(await probe.startup()).toEqual(ok); // fallback to liveness
  });

  // ── CP2: Probe with liveness + readiness ─────────────

  it('CP2: probe with liveness+readiness uses readiness as startup fallback', async () => {
    const probe = componentProbe('cache', 'Cache', {
      liveness: () => ok,
      readiness: () => notOk,
    });
    expect(await probe.liveness()).toEqual(ok);
    expect(await probe.readiness()).toEqual(notOk);
    expect(await probe.startup()).toEqual(notOk); // fallback to readiness
  });

  // ── CP3: Probe with all three checks specified ───────

  it('CP3: probe with all three checks uses explicit startup', async () => {
    const probe = componentProbe('queue', 'Queue', {
      liveness: () => ok,
      readiness: () => notOk,
      startup: () => warnOk,
    });
    expect(await probe.liveness()).toEqual(ok);
    expect(await probe.readiness()).toEqual(notOk);
    expect(await probe.startup()).toEqual(warnOk); // not fallback
  });

  // ── CP4: Failing liveness propagates ─────────────────

  it('CP4: failing liveness is returned correctly', async () => {
    const probe = componentProbe('disk', 'Disk', {
      liveness: () => notOk,
    });
    expect(await probe.liveness()).toEqual(notOk);
    expect((await probe.readiness()).ok).toBe(false);
    expect((await probe.startup()).ok).toBe(false);
  });

  // ── CP5: Probe identities are independent ─────────────

  it('CP5: multiple probes are independent', async () => {
    const a = componentProbe('a', 'Alpha', { liveness: () => ok });
    const b = componentProbe('b', 'Beta', { liveness: () => notOk });

    expect(a.probeId).toBe('a');
    expect(b.probeId).toBe('b');
    expect((await a.liveness()).ok).toBe(true);
    expect((await b.liveness()).ok).toBe(false);
  });

  // ── CP6: Probe result with extra metadata ─────────────

  it('CP6: probe result can carry extra metadata fields', async () => {
    const probe = componentProbe('custom', 'Custom', {
      liveness: () => ({
        ok: true,
        message: 'all good',
        details: { uptime: 1234 },
      }),
    });
    const result = await probe.liveness();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('all good');
    expect(result.details).toHaveProperty('uptime', 1234);
  });

  // ── CP7: Only readiness provided still falls back liveness to readiness ──

  it('CP7: readiness without liveness (typed) falls back correctly', async () => {
    // TypeScript ensures liveness is required, but verify the fallback chain
    const probe = componentProbe('svc', 'Service', {
      liveness: () => ({ ok: true, message: 'live' }),
      readiness: () => ({ ok: false, message: 'not ready' }),
    });
    // readiness explicitly provided → notOk
    expect((await probe.readiness()).ok).toBe(false);
    // liveness → explicitly provided → ok
    expect((await probe.liveness()).ok).toBe(true);
    // startup → fallback to readiness → notOk
    expect((await probe.startup()).ok).toBe(false);
  });
});
