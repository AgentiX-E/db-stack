/**
 * ComponentProbe tests — CP1 through CP7.
 *
 * Covers componentProbe factory function with fallback behavior
 * for readiness and startup when not provided.
 */

import { describe, it, expect } from "vitest";
import { componentProbe } from "../impl/ComponentProbe.js";

const ok = { ok: true as const };
const notOk = { ok: false as const, message: "fail" };
const warnOk = { ok: true as const, message: "warning state" };

describe("CP: ComponentProbe factory", () => {
  // ── CP1: Basic probe with only liveness ──────────────

  it("CP1: probe with only liveness uses liveness as fallback for all checks", () => {
    const probe = componentProbe("db", "Database", {
      liveness: () => ok,
    });
    expect(probe.probeId).toBe("db");
    expect(probe.componentName).toBe("Database");
    expect(probe.liveness()).toEqual(ok);
    expect(probe.readiness()).toEqual(ok);   // fallback to liveness
    expect(probe.startup()).toEqual(ok);      // fallback to liveness
  });

  // ── CP2: Probe with liveness + readiness ─────────────

  it("CP2: probe with liveness+readiness uses readiness as startup fallback", () => {
    const probe = componentProbe("cache", "Cache", {
      liveness: () => ok,
      readiness: () => notOk,
    });
    expect(probe.liveness()).toEqual(ok);
    expect(probe.readiness()).toEqual(notOk);
    expect(probe.startup()).toEqual(notOk);  // fallback to readiness
  });

  // ── CP3: Probe with all three checks specified ───────

  it("CP3: probe with all three checks uses explicit startup", () => {
    const probe = componentProbe("queue", "Queue", {
      liveness: () => ok,
      readiness: () => notOk,
      startup: () => warnOk,
    });
    expect(probe.liveness()).toEqual(ok);
    expect(probe.readiness()).toEqual(notOk);
    expect(probe.startup()).toEqual(warnOk); // not fallback
  });

  // ── CP4: Failing liveness propagates ─────────────────

  it("CP4: failing liveness is returned correctly", () => {
    const probe = componentProbe("disk", "Disk", {
      liveness: () => notOk,
    });
    expect(probe.liveness()).toEqual(notOk);
    expect(probe.readiness().ok).toBe(false);
    expect(probe.startup().ok).toBe(false);
  });

  // ── CP5: Probe identities are independent ─────────────

  it("CP5: multiple probes are independent", () => {
    const a = componentProbe("a", "Alpha", { liveness: () => ok });
    const b = componentProbe("b", "Beta", { liveness: () => notOk });

    expect(a.probeId).toBe("a");
    expect(b.probeId).toBe("b");
    expect(a.liveness().ok).toBe(true);
    expect(b.liveness().ok).toBe(false);
  });

  // ── CP6: Probe result with extra metadata ─────────────

  it("CP6: probe result can carry extra metadata fields", () => {
    const probe = componentProbe("custom", "Custom", {
      liveness: () => ({ ok: true, message: "all good", metadata: { uptime: 1234 } }),
    });
    const result = probe.liveness() as any;
    expect(result.ok).toBe(true);
    expect(result.message).toBe("all good");
    expect(result.metadata.uptime).toBe(1234);
  });

  // ── CP7: Only readiness provided still falls back liveness to readiness ──

  it("CP7: readiness without liveness (typed) falls back correctly", () => {
    // TypeScript ensures liveness is required, but verify the fallback chain
    const probe = componentProbe("svc", "Service", {
      liveness: () => ({ ok: true, message: "live" }),
      readiness: () => ({ ok: false, message: "not ready" }),
    });
    // readiness explicitly provided → notOk
    expect(probe.readiness().ok).toBe(false);
    // liveness → explicitly provided → ok
    expect(probe.liveness().ok).toBe(true);
    // startup → fallback to readiness → notOk
    expect(probe.startup().ok).toBe(false);
  });
});
