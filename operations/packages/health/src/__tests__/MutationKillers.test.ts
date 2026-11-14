/**
 * MutationKillers.test.ts — Targeted tests for health package mutation survivors.
 *
 * Survivors (7):
 *   - MUT_a115eb: ComponentProbe L47, Boolean true→false (?? chain fallback)
 *   - MUT_98c6b7: HealthOrchestrator L162, /→* (uptime floor division)
 *   - MUT_b1e5c7: HealthOrchestrator L178, ||→&& (allUnhealthy check)
 *   - MUT_aa07db: HealthOrchestrator L190, ||→&& (allUnhealthy check in getHealthStatus)
 *   - MUT_f2e398: HealthOrchestrator L202, /→* (uptime floor division)
 *   - MUT_5ebedc: HealthOrchestrator L212, -→+ (total - healthy in getSummary)
 *   - MUT_65a51e: HealthOrchestrator L235, false→true (_safeProbe error return)
 *
 * Strategy: exercise edge cases for each survivor, and refactor source-level
 * arithmetic equivalence by converting floor-division to named constants.
 *
 * Target: 74.1% → ≥95% mutation score.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HealthOrchestrator } from "../impl/HealthOrchestrator.js";
import { componentProbe } from "../impl/ComponentProbe.js";
import type { IHealthProbe } from "../interfaces/IHealthProbe.js";
import type { ProbeResult } from "@agentix-e/db-operations-core/types";

// ── Helpers ────────────────────────────────────────────────

function liveProbe(id: string, name: string, ok = true): IHealthProbe {
  return componentProbe(id, name, {
    liveness: () => ({ ok }),
    readiness: () => ({ ok, message: "ready" }),
    startup: () => ({ ok: true }),
  });
}

function failProbe(id: string, name: string): IHealthProbe {
  return componentProbe(id, name, {
    liveness: () => ({ ok: false, message: "liveness-fail" }),
    readiness: () => ({ ok: false, message: "readiness-fail" }),
    startup: () => ({ ok: false }),
  });
}

/** Probe with liveness passing but readiness failing — tests allUnhealthy discrimination. */
function degradedProbe(id: string, name: string): IHealthProbe {
  return componentProbe(id, name, {
    liveness: () => ({ ok: true }),
    readiness: () => ({ ok: false, message: "not-ready" }),
    startup: () => ({ ok: true }),
  });
}

// ── ComponentProbe ──────────────────────────────────────────

describe("H-M: ComponentProbe nullish coalescing chain", () => {
  it("H1: probe with all checks uses explicit functions", () => {
    const p = componentProbe("id", "name", {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false }),
      startup: () => ({ ok: true }),
    });
    expect(p.probeId).toBe("id");
    expect(p.componentName).toBe("name");
    expect(p.liveness().ok).toBe(true);
    expect(p.readiness().ok).toBe(false);
    expect(p.startup().ok).toBe(true);
  });

  it("H2: probe without readiness falls back to liveness", () => {
    const p = componentProbe("id", "name", {
      liveness: () => ({ ok: true }),
      startup: () => ({ ok: true }),
    });
    // readiness falls back to liveness
    expect(p.readiness().ok).toBe(true);
  });

  it("H3: probe without readiness and startup falls back to liveness", () => {
    const p = componentProbe("id", "name", {
      liveness: () => ({ ok: true }),
    });
    expect(p.readiness().ok).toBe(true);
    expect(p.startup().ok).toBe(true);
  });

  it("H4: probe with readiness but no startup falls back readiness→liveness", () => {
    const p = componentProbe("id", "name", {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: "not ready" }),
    });
    // startup falls back to readiness
    expect(p.startup().ok).toBe(false);
  });
});

// ── HealthOrchestrator ──────────────────────────────────────

describe("H-M: HealthOrchestrator edge cases", () => {
  let orch: HealthOrchestrator;

  beforeEach(() => {
    orch = new HealthOrchestrator();
  });

  it("H5: getComponentHealth returns entries with uptime seconds", async () => {
    orch.registerComponent(liveProbe("a", "A"));
    // Wait 50ms so elapsedMs > 0, making /→* mutation detectable.
    // If mutated to *1000, uptimeSeconds would jump to ~5ms*1000=5000, not ~0.
    await new Promise(r => setTimeout(r, 50));
    const results = orch.getComponentHealth();
    expect(results).toHaveLength(1);
    expect(results[0].componentId).toBe("a");
    expect(results[0].uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(results[0].uptimeSeconds).toBeLessThan(5); // far less than 5000
  });

  it("H6: getAggregateStatus with empty registry returns healthy", () => {
    const s = orch.getAggregateStatus();
    expect(s.status).toBe("healthy");
    expect(s.count).toBe(0);
  });

  it("H7: getAggregateStatus all healthy", () => {
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(liveProbe("b", "B"));
    const s = orch.getAggregateStatus();
    expect(s.status).toBe("healthy");
    expect(s.count).toBe(2);
  });

  it("H8: getAggregateStatus allUnhealthy path (|| chain)", () => {
    // L178: ||→&& mutant — testing the allUnhealthy every() check
    orch.registerComponent(failProbe("a", "A"));
    orch.registerComponent(failProbe("b", "B"));
    const s = orch.getAggregateStatus();
    expect(s.status).toBe("unhealthy");
    expect(s.count).toBe(2);
  });

  it("H9: getAggregateStatus degraded (partial failure)", () => {
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(failProbe("b", "B"));
    const s = orch.getAggregateStatus();
    expect(s.status).toBe("degraded");
  });

  // L178/L189: ||→&& mutant — allUnhealthy every() returns false when some are healthy
  it("H9b: getAggregateStatus — one unhealthy but not all unhealthy", () => {
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(degradedProbe("b", "B"));
    orch.registerComponent(failProbe("c", "C"));
    const s = orch.getAggregateStatus();
    // Component b has liveness ok → not allUnhealthy → status is degraded, not unhealthy
    expect(s.status).toBe("degraded");
  });

  it("H10: getHealthStatus uptimeSeconds is reasonable (kills L201 /→*)", async () => {
    orch.registerComponent(liveProbe("a", "A"));
    // Wait 100ms to ensure systemElapsedMs is well above 0.
    // If /→*, uptimeSeconds = ~100ms * 1000 = 100000, not ~0.
    await new Promise(r => setTimeout(r, 100));
    const status = orch.getHealthStatus();
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.uptimeSeconds).toBeLessThan(10);
    expect(typeof status.uptimeSeconds).toBe("number");
    expect(Number.isFinite(status.uptimeSeconds)).toBe(true);
  });

  it("H11: getHealthStatus allUnhealthy via total>0 && every()", () => {
    // L190: ||→&& mutant in allUnhealthy every() check
    orch.registerComponent(failProbe("a", "A"));
    orch.registerComponent(failProbe("b", "B"));
    const s = orch.getHealthStatus();
    expect(s.status).toBe("unhealthy");
  });

  it("H12: getHealthStatus empty registry", () => {
    const s = orch.getHealthStatus();
    expect(s.status).toBe("healthy");
    expect(s.components).toHaveLength(0);
    expect(s.lastError).toBe(null);
  });

  it("H13: getSummary builds failing component count (L212 -→+)", () => {
    // L212: const failing = total - healthy;
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(liveProbe("b", "B"));
    orch.registerComponent(failProbe("c", "C"));
    const summary = orch.getSummary();
    expect(summary).toContain("degraded");
    expect(summary).toContain("2/3 healthy");
    expect(summary).toContain("Failing: 1");
  });

  it("H14: getSummary all healthy", () => {
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(liveProbe("b", "B"));
    const summary = orch.getSummary();
    expect(summary).toContain("healthy");
    expect(summary).toContain("2/2 healthy");
    expect(summary).not.toContain("Failing:");
  });

  it("H15: _safeProbe catches errors and returns ok:false (L235 false→true)", () => {
    // L235: _safeProbe returns { ok: false } on exception
    // We trigger this by registering a probe that throws
    const throwingProbe: IHealthProbe = componentProbe("bomb", "Bomb", {
      liveness: () => {
        throw new Error("kaboom");
      },
    });
    orch.registerComponent(throwingProbe);
    const results = orch.getComponentHealth();
    expect(results).toHaveLength(1);
    // The error is swallowed and we get ok:false
    expect(results[0].liveness.ok).toBe(false);
  });

  it("H16: isStartupComplete returns boolean after register", () => {
    orch.registerComponent(liveProbe("a", "A"));
    // Startup-complete flag is tracked internally; verify it exists as boolean
    const started = orch.isStartupComplete();
    expect(typeof started).toBe("boolean");
  });

  it("H17: startup() with all probes passing — triggers _startupComplete = true", () => {
    // L138-142: errors.length === 0 branches set _startupComplete = true
    orch.registerComponent(liveProbe("a", "A"));
    orch.registerComponent(liveProbe("b", "B"));
    const result = orch.startup();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // After successful startup, _startupComplete should be true
    expect(orch.isStartupComplete()).toBe(true);
  });

  it("H18: startup() with failing probes — _startupComplete stays false", () => {
    orch.registerComponent(failProbe("a", "A"));
    const result = orch.startup();
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(orch.isStartupComplete()).toBe(false);
  });

  it("H19: startup() subsequently returns ok when already completed", () => {
    orch.registerComponent(liveProbe("a", "A"));
    orch.startup(); // first call marks complete
    const result2 = orch.startup();
    expect(result2.ok).toBe(true);
  });

  // L199: lastError !== null check — if !==→===, find() picks wrong component
  it("H20: getHealthStatus lastError is null for healthy components", () => {
    orch.registerComponent(liveProbe("a", "A"));
    const s = orch.getHealthStatus();
    expect(s.lastError).toBe(null);
  });

  it("H20b: lastError propagates from failed liveness check", () => {
    // Errored liveness sets lastError — must propagate through find()
    const throwingProbe: IHealthProbe = componentProbe("err", "Err", {
      liveness: () => { throw new Error("BOOM"); },
    });
    orch.registerComponent(throwingProbe);
    // Trigger liveness check to store the error
    orch.liveness();
    const s = orch.getHealthStatus();
    // The error from the liveness check should be visible
    expect(s.lastError).not.toBe(null);
  });

  // ── L178, L189: ||→&& in allUnhealthy De Morgan check ──────

  it("H21: getAggregateStatus — liveness-only failure is degraded, not unhealthy (||→&& killer)", () => {
    // Component with liveness=true but readiness=false
    // Original: !(lives || ready) = !(true)=false → allUnhealthy=false → degraded
    // L178 mutant (||→&&): !(lives && ready) = !(false)=true → allUnhealthy=true → unhealthy
    const orc2 = new HealthOrchestrator();
    orc2.registerComponent({
      probeId: "half",
      componentName: "Half",
      liveness: () => ({ ok: true, type: "liveness" }),
      readiness: () => ({ ok: false, type: "readiness", message: "not ready" }),
    });
    const status = orc2.getAggregateStatus();
    expect(status.status).toBe("degraded");
  });

  it("H22: getHealthStatus — liveness-only failure is degraded (||→&& killer)", () => {
    const orc2 = new HealthOrchestrator();
    orc2.registerComponent({
      probeId: "half",
      componentName: "Half",
      liveness: () => ({ ok: true, type: "liveness" }),
      readiness: () => ({ ok: false, type: "readiness", message: "not ready" }),
    });
    const s = orc2.getHealthStatus();
    expect(s.status).toBe("degraded");
  });

  it("H23: getAggregateStatus — readiness-only failure is degraded (double-safe)", () => {
    const orc2 = new HealthOrchestrator();
    orc2.registerComponent({
      probeId: "half2",
      componentName: "Half2",
      liveness: () => ({ ok: false, type: "liveness", message: "dead" }),
      readiness: () => ({ ok: true, type: "readiness" }),
    });
    const status = orc2.getAggregateStatus();
    expect(status.status).toBe("degraded");
  });

  it("H24: getAggregateStatus — multiple components with one fully unhealthy, others healthy → degraded", () => {
    const orc2 = new HealthOrchestrator();
    // Component 1: fully unhealthy (liveness+readiness both fail)
    orc2.registerComponent({
      probeId: "dead",
      componentName: "Dead",
      liveness: () => ({ ok: false, type: "liveness", message: "dead" }),
      readiness: () => ({ ok: false, type: "readiness", message: "dead" }),
    });
    // Component 2: fully healthy
    orc2.registerComponent({
      probeId: "alive",
      componentName: "Alive",
      liveness: () => ({ ok: true, type: "liveness" }),
      readiness: () => ({ ok: true, type: "readiness" }),
    });
    const status = orc2.getAggregateStatus();
    expect(status.status).toBe("degraded");
  });

  it("H25: registerComponent defaults critical to true (L47 true→false killer)", () => {
    const orc = new HealthOrchestrator();
    // Register without specifying critical — defaults to true via ?? true
    orc.registerComponent({
      probeId: "def-critical",
      componentName: "DefaultCritical",
      liveness: () => ({ ok: false, type: "liveness", message: "failing" }),
      readiness: () => ({ ok: false, type: "readiness", message: "failing" }),
    });
    // If critical defaults to false (mutated), the failing component
    // would NOT make the overall status "unhealthy"
    const s = orc.getHealthStatus();
    // With only one component and it's failing, status must be unhealthy
    // (critical=true is the gate)
    expect(s.status).toBe("unhealthy");
  });
});
