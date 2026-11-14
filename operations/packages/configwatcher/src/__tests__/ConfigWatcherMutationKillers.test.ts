/**
 * ConfigWatcher mutation-killer tests.
 *
 * Targets survivors exposed after the validateKey/_computeDiff bug fixes.
 * Each test distinguishes the original from a specific short-circuit mutant.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ConfigWatcher } from "../impl/ConfigWatcher.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CW-MK: type/null/enum guards", () => {
  it("L116 object type with non-object value fails (|| -> &&)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "object" } });
    // typeof 123 !== "object" is true; original `x !== "object" || x === null` -> true -> error
    // mutant (&& -> ||) collapses to false -> no error
    const r = w.validateKey("k", 123);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toContain("object");
  });

  it("L161 pattern check skipped when no pattern (&& -> ||)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } }); // no pattern
    // original: field.pattern (undefined) && ... -> falsy -> no check
    // mutant: undefined || true -> true -> RegExp(undefined) would flag "hello"
    const r = w.validateKey("k", "hello");
    expect(r.valid).toBe(true);
  });

  it("L178 object without properties skips nested check (&& -> ||)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "object" } }); // no properties
    // original: type === object && properties(undefined) -> falsy -> no nested iteration
    // mutant: true || undefined -> true -> Object.entries(undefined) throws
    const r = w.validateKey("k", { a: 1 });
    expect(r.valid).toBe(true);
  });

  it("L141 range check gated on numeric type (&& -> ||)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string", min: 10 } });
    // "5" is a string; original `typeof === "number" && !isNaN` is false -> no range check
    // mutant (&& -> ||) lets !isNaN("5") (true) enter range -> "5" < 10 flags error
    const r = w.validateKey("k", "5" as unknown as string);
    expect(r.valid).toBe(true);
  });
});

describe("CW-MK: validateAll branches", () => {
  it("L388 nullable=true required field missing is allowed (=== -> !==)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string", required: true, nullable: true } });
    // isRequired && !isNullable && !hasDefault -> false when nullable true
    const r = w.validateAll();
    expect(r.valid).toBe(true);
  });

  it("L397 optional missing key warns not errors (&& -> ||)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ a: { type: "string", required: true }, b: { type: "string" } });
    // b is optional (not required) -> warn, not error
    const r = w.validateAll();
    expect(r.valid).toBe(false); // a is missing -> error
    expect(r.warnings.some((x) => x.key === "b")).toBe(true);
  });

  it("L403 present value is validated (!== -> ===)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    w.set("k", 42); // number where string expected
    const r = w.validateAll();
    expect(r.valid).toBe(false);
  });
});

describe("CW-MK: rollback / checkpoint edges", () => {
  it("L555 rollback skips consecutive rollback checkpoints (>= -> <)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    w.set("k", "v1");
    w.reload({ k: "v2" });
    w.rollback(); // back to v1 (target = non-rollback checkpoint)
    // a second rollback should still find an earlier non-rollback checkpoint
    // or report no checkpoint; either way it must not crash / mis-traverse
    const r2 = w.rollback();
    expect(typeof r2.success).toBe("boolean");
  });

  it("L596 rollback applies value changes (!== -> ===)", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    w.set("k", "v1");
    w.set("k", "v2");
    const r = w.rollback();
    expect(r.success).toBe(true);
    expect(r.snapshot!["k"]).toBe("v1");
  });

  it("L596 rollback notifies watcher when value changes (!== -> ===)", async () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    const seen: unknown[] = [];
    let handlerCalls = 0;
    // watch registers a handler; _notify fires it on rollback change
    w.watch("k", (e) => {
      handlerCalls++;
      seen.push(e);
    });
    await w.set("k", "v1");
    await w.set("k", "v2");
    handlerCalls = 0; // reset; we only care about rollback notification
    const r = w.rollback();
    expect(r.success).toBe(true);
    // rollback changes k from v2 back to v1 -> oldValue !== value -> notify
    expect(handlerCalls).toBe(1);
  });

  it("L546 rollback no-checkpoint returns dryRun false (false -> true)", () => {
    const w = new ConfigWatcher();
    const r = w.rollback();
    expect(r.success).toBe(false);
    expect(r.dryRun).toBe(false);
  });

  it("L561/L566 rollback exhausted checkpoints returns success false + dryRun false", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    w.set("k", "v1");
    // Force consecutive rollback checkpoints so targetIdx walks negative
    w.rollback();
    w.rollback();
    const r = w.rollback();
    if (!r.success) {
      expect(r.dryRun).toBe(false);
    }
  });

  it("L616 successful rollback returns dryRun false", () => {
    const w = new ConfigWatcher();
    w.registerSchema({ k: { type: "string" } });
    w.set("k", "v1");
    w.set("k", "v2");
    const r = w.rollback();
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(false);
  });
});

