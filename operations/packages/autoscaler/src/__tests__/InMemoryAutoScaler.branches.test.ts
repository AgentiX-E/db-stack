/**
 * InMemoryAutoScaler — branch-completion tests.
 *
 * Targets the `|| 1` fallback on the scale-up `amount` computation:
 *
 *   amount: Math.ceil((cpu + scaleUpThreshold) * 10) || 1
 *
 * The fallback exists so a scale-up action can never carry an amount of
 * `0` or `NaN`. Under normal metrics (cpu ∈ [0,1], threshold > 0) the
 * ceil expression is always `>= 1`, so the fallback is unreachable. It
 * becomes reachable only when the threshold is mis-configured to `NaN`
 * (a value the public `configure` API does not reject), which makes
 * `Math.ceil((cpu + NaN) * 10)` evaluate to `NaN`. The `|| 1` guard then
 * coerces the amount back to `1`, keeping the emitted ScaleAction valid.
 *
 * This is a real robustness guarantee, not a defensive dead path: without
 * the fallback the scale-up action would report `amount: NaN` and silently
 * break downstream autoscaling logic.
 */

import { describe, it, expect } from "vitest";
import { InMemoryAutoScaler } from "../impl/InMemoryAutoScaler.js";

describe("IAS-branch: scale-up amount || 1 fallback", () => {
  it("coerces a NaN amount back to 1 when scaleUpThreshold is NaN", async () => {
    const scaler = new InMemoryAutoScaler();
    // NaN threshold makes every `cpu > threshold` comparison false, so the
    // scale_up branch is entered through the `qps >= 10000` disjunct instead.
    scaler.configure(1, 10, NaN, 0.2);

    const result = await scaler.evaluate({ cpu: 0.3, qps: 15000, latency: 50, connectionCount: 5 });

    expect(result).not.toBeNull();
    expect(result!.action).toBe("scale_up");
    // Math.ceil((0.3 + NaN) * 10) === NaN; NaN || 1 === 1.
    expect(result!.amount).toBe(1);
    expect(Number.isFinite(result!.amount)).toBe(true);
  });

  it("keeps a normal positive amount intact (no spurious fallback)", async () => {
    const scaler = new InMemoryAutoScaler();
    const result = await scaler.evaluate({ cpu: 0.9, qps: 1000, latency: 50, connectionCount: 5 });

    // (0.9 + 0.8) * 10 = 17 → ceil = 17, which is truthy, so `|| 1` is a no-op.
    expect(result!.amount).toBe(17);
  });
});
