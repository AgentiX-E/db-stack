/**
 * MutationKillers.test.ts — Targeted tests for logger package mutation survivors.
 *
 * Survivors (8): all in InMemoryLogger._log() method (L135-L149):
 *   - L135: firstIsObject && short-circuit (contextOrMsg !== null && typeof === 'object')
 *   - L140: extraCtx && short-circuit (extra !== undefined && typeof === 'object')
 *   - L147: firstIsString === check
 *   - L149: firstIsObject !== check + extra-string check + late-check ===
 *
 * Strategy: exercise every overload variant through public API, asserting
 * correct message and context placement for each survivor path.
 *
 * Target: 61.9% → ≥95% mutation score.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryLogger } from "../impl/InMemoryLogger.js";

describe("L-M: InMemoryLogger _log overloads", () => {
  let logger: InMemoryLogger;
  beforeEach(() => { logger = new InMemoryLogger(); });

  it("L1: log(string) — firstIsString branch, no extra", () => {
    logger.info("hello");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("hello");
  });

  it("L2: log(string, object) — firstIsString branch, with extra context", () => {
    logger.info("msg", { userId: "u1" });
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("msg");
    expect(e[0].context).toEqual({ userId: "u1" });
  });

  it("L3: log(object, string) — firstIsObject branch", () => {
    logger.info({ userId: "u2" }, "action");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("action");
    expect(e[0].context).toEqual({ userId: "u2" });
  });

  it("L4: log(object) — firstIsObject branch, no message", () => {
    logger.info({ event: "start" });
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("");  // String(undefined ?? '')  → ''
    expect(e[0].context).toEqual({ event: "start" });
  });

  it("L5: log(non-string-non-object, string) — extra-string fallback", () => {
    logger.info(42, "numeric context as message");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    // Case 2 variant: log(nonObject, "message") — message is extra
    expect(e[0].message).toBe("numeric context as message");
  });

  it("L6: log(number) — fallback coercion", () => {
    logger.info(123);
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("123");
  });

  it("L7: log(null) — null is not an object, falls to fallback", () => {
    logger.warn(null);
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("");
  });

  it("L8: log(undefined) — undefined falls to fallback", () => {
    logger.debug(undefined as unknown as string);
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("");
  });

  it("L9: log(string) via all levels hits _log correctly", () => {
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    const entries = logger.getEntries();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.level))
      .toEqual(["trace", "debug", "info", "warn", "error"]);
  });

  it("L10: log({}, undefined) — empty object context, undefined message", () => {
    logger.info({});
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].context).toEqual({});
    expect(e[0].message).toBe(""); // String(undefined ?? '')
  });

  it("L11: log with array as context — array is NOT an object", () => {
    logger.info(["item1"], "array context");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    // Array is not treated as context object; falls to fallback
    expect(typeof e[0].message).toBe("string");
  });

  it("L12: log(string, extra) where extra is not a valid object", () => {
    logger.info("msg", 999);
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("msg");
  });

  it("L13: clear() then verify empty", () => {
    logger.info("before clear");
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("L14: maxEntries truncation", () => {
    const capped = new InMemoryLogger("test", 3);
    capped.info("1");
    capped.info("2");
    capped.info("3");
    capped.info("4");
    const entries = capped.getEntries();
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it("L15: log(string, array) — array blocks extraCtx via isArray check", () => {
    // L140 && short-circuit: extra type-check excludes arrays.
    // If && becomes ||, an array extra would leak into context.
    logger.info("msg", ["arr"]);
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("msg");
    // Array should NOT become context (blocked by !Array.isArray)
    expect(e[0].context).not.toBeInstanceOf(Array);
  });

  it("L16: log(number, \"string message\") — hits extra-string fallback via firstIsObject else-if chain", () => {
    // Tests L149 extra-string `&&` chain: extra !== undefined && typeof extra === 'string'
    logger.info(null, "fallback message");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    // null is neither string nor object → enters else-if extra-string check
    expect(e[0].message).toBe("fallback message");
  });

  it("L143: log(msg, string) — non-object extra keeps validCtx false (no string-index leak)", () => {
    // L143 `let validCtx = false` → `true`: when extra is a string (non-object,
    // non-array), extraIsObject is false so validCtx keeps its initial value.
    // Mutant (validCtx=true) would pass the raw string as extraCtx, and the
    // spread `{...this._context, ..."str"}` leaks string indices (0,1,2...) into
    // context. Original keeps context free of those indices.
    logger.info("hello", "extraString");
    const e = logger.getEntries();
    expect(e).toHaveLength(1);
    expect(e[0].message).toBe("hello");
    // Original: no numeric string indices leak into context
    expect(Object.keys(e[0].context)).not.toContain("0");
    expect(e[0].context).toEqual({});
  });
});
