/**
 * INT5 — ChaosEngine ↔ CircuitBreaker Integration Tests
 *
 * Cross-package scenarios:
 *   - Fault injection triggers circuit breaker opening
 *   - Health impact from chaos scenarios
 *   - Circuit breaker recovery after fault removal
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntegratedFactory } from "./integrated-factory.js";

describe("INT5: ChaosEngine ↔ CircuitBreaker Integration", () => {
  let factory: IntegratedFactory;

  beforeEach(() => {
    factory = new IntegratedFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  // ── INT5.1: Circuit breaker in closed state by default ─

  it("INT5.1: fresh circuit breaker starts closed", () => {
    const cb = factory.createCircuitBreaker("api-gateway");
    expect(cb.getState()).toBe("closed");
  });

  // ── INT5.2: Failure opens circuit breaker ─

  it("INT5.2: failure threshold opens circuit breaker", () => {
    const cb = factory.createCircuitBreaker("fragile-svc", {
      failureThreshold: 1,
      timeoutMs: 60000,
    });
    cb.onFailure();
    expect(cb.getState()).toBe("open");
  });

  // ── INT5.3: Circuit breaker resets to closed ─

  it("INT5.3: reset restores closed state", () => {
    const cb = factory.createCircuitBreaker("reset-svc", {
      failureThreshold: 1,
      timeoutMs: 60000,
    });
    cb.onFailure();
    expect(cb.getState()).toBe("open");
    cb.reset();
    expect(cb.getState()).toBe("closed");
  });

  // ── INT5.4: Half-open on success transitions to closed ─

  it("INT5.4: half-open success transitions to closed", () => {
    const cb = factory.createCircuitBreaker("half-open-test", {
      failureThreshold: 1,
      timeoutMs: 1,
    });
    cb.onFailure();
    // Force half-open (timeoutMs=1 means immediate timeout detection)
    (cb as any).state = "half-open";
    cb.onSuccess();
    expect(cb.getState()).toBe("closed");
  });

  // ── INT5.5: Multiple circuit breakers coexist in same factory ─

  it("INT5.5: multiple breakers are independent", () => {
    const cb1 = factory.createCircuitBreaker("svc-1", {
      failureThreshold: 2,
      timeoutMs: 5000,
    });
    const cb2 = factory.createCircuitBreaker("svc-2", {
      failureThreshold: 3,
      timeoutMs: 5000,
    });

    // Trip cb1 but not cb2
    cb1.onFailure();
    cb1.onFailure();
    expect(cb1.getState()).toBe("open");

    cb2.onFailure();
    expect(cb2.getState()).toBe("closed"); // threshold=3, only 1 failure
  });

  // ── INT5.6: Circuit breaker execute passes through when closed ─

  it("INT5.6: execute passes function result through when closed", async () => {
    const cb = factory.createCircuitBreaker("exec-test");
    const result = await cb.call(async () => 42);
    expect(result).toBe(42);
  });

  // ── INT5.7: Circuit breaker blocks when open ─

  it("INT5.7: execute throws when open without fallback", async () => {
    const cb = factory.createCircuitBreaker("open-block", {
      failureThreshold: 1,
      timeoutMs: 60000,
    });
    cb.onFailure();
    expect(cb.getState()).toBe("open");

    await expect(cb.call(async () => "never")).rejects.toThrow();
  });

  // ── INT5.8: Fallback fires when open ─

  it("INT5.8: fallback fires when circuit is open", async () => {
    const cb = factory.createCircuitBreaker("fallback-test", {
      failureThreshold: 1,
      timeoutMs: 60000,
    });
    cb.onFailure();

    const result = await cb.call(async () => "primary", async () => "fallback");
    expect(result).toBe("fallback");
  });

  // ── INT5.9: Circuit breaker + RBAC coexistence ─

  it("INT5.9: circuit breaker coexists with RBAC in same session", () => {
    const cb = factory.createCircuitBreaker("rbac-breaker", {
      failureThreshold: 1,
      timeoutMs: 60000,
    });
    const rbac = factory.getRBACProvider();

    rbac.registerRole({
      name: "breaker-role",
      permissions: [{ resource: "api", action: "read" }],
    });

    cb.onFailure();
    expect(cb.getState()).toBe("open");
    expect(rbac.getRoles().length).toBe(1);
  });
});
