/**
 * Logger overload regression tests — LOG1 through LOG10.
 *
 * Verifies that all InMemoryLogger overload patterns work correctly after
 * the _log() method fix. The original implementation had a bug where
 * calling info("message", {extra}) treated the string as context and
 * the object as message — a complete semantic reversal.
 *
 * Overloads tested:
 *   1. Single string: log("message")
 *   2. Context + message: log({ctx}, "message")
 *   3. String + extra object: log("message", {extra}) — the bug scenario
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryLogger } from "../impl/InMemoryLogger.js";

describe("LOG: Logger overload correctness", () => {
  let logger: InMemoryLogger;

  beforeEach(() => {
    logger = new InMemoryLogger("test-component");
  });

  // ── LOG1: Single string message ─────────────────────────────

  it("LOG1: info(msg) stores message correctly", () => {
    logger.info("single-message");
    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("single-message");
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.component).toBe("test-component");
  });

  // ── LOG2: Context + message (two-arg overload) ──────────────

  it("LOG2: info(context, msg) stores message and context correctly", () => {
    logger.info({ userId: "u1", requestId: "req-1" }, "operation-started");
    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("operation-started");
    expect(entries[0]!.context).toMatchObject({ userId: "u1", requestId: "req-1" });
  });

  // ── LOG3: String + extra object (the bug scenario) ──────────

  it("LOG3: info(msg, extraObj) treats string as message, object as context", () => {
    // This is the bug scenario: TS resolves to info(msg: string) overload,
    // but runtime passes both args. Before fix, _log would swap them.
    (logger as any).info("user-login", { sessionId: "abc-123" });
    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("user-login");
    expect(entries[0]!.context).toMatchObject({ sessionId: "abc-123" });
  });

  // ── LOG4: Single string message across levels ───────────────

  it("LOG4: all levels store single-string messages correctly", () => {
    logger.trace("trace-msg");
    logger.debug("debug-msg");
    logger.info("info-msg");
    logger.warn("warn-msg");
    logger.error("error-msg");
    logger.fatal("fatal-msg");

    const entries = logger.getEntries();
    expect(entries.length).toBe(6);
    expect(entries.map((e) => e.message)).toEqual([
      "trace-msg", "debug-msg", "info-msg", "warn-msg", "error-msg", "fatal-msg",
    ]);
    expect(entries.map((e) => e.level)).toEqual([
      "trace", "debug", "info", "warn", "error", "fatal",
    ]);
  });

  // ── LOG5: Context+message across levels ─────────────────────

  it("LOG5: all levels store context+message correctly", () => {
    logger.trace({ a: 1 }, "trace-ctx");
    logger.debug({ a: 2 }, "debug-ctx");
    logger.info({ a: 3 }, "info-ctx");
    logger.warn({ a: 4 }, "warn-ctx");

    const entries = logger.getEntries();
    expect(entries.length).toBe(4);
    expect(entries[0]!.message).toBe("trace-ctx");
    expect(entries[1]!.message).toBe("debug-ctx");
    expect(entries[2]!.message).toBe("info-ctx");
    expect(entries[3]!.message).toBe("warn-ctx");
  });

  // ── LOG6: error(Error) overload ─────────────────────────────

  it("LOG6: error(err) stores error details", () => {
    const err = new Error("connection-refused");
    logger.error(err);

    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("connection-refused");
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.error).toBeDefined();
    expect(entries[0]!.error!.name).toBe("Error");
  });

  // ── LOG7: error(context, err) overload ───────────────────────

  it("LOG7: error(context, err) stores context and error", () => {
    const err = new TypeError("bad-type");
    logger.error({ operation: "parse" }, err);

    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("bad-type");
    expect(entries[0]!.context).toMatchObject({ operation: "parse" });
    expect(entries[0]!.error!.name).toBe("TypeError");
  });

  // ── LOG8: error(context, err, msg) overload ──────────────────

  it("LOG8: error(context, err, msg) stores all three", () => {
    const err = new Error("db-error");
    logger.error({ table: "users" }, err, "write-failed");

    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("write-failed");
    expect(entries[0]!.context).toMatchObject({ table: "users" });
    expect(entries[0]!.error).toBeDefined();
  });

  // ── LOG9: child logger inherits context ─────────────────────

  it("LOG9: child logger inherits parent context bindings", () => {
    const child = logger.child({ service: "auth" });
    child.info("child-message");

    const entries = (child as InMemoryLogger).getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("child-message");
    expect(entries[0]!.context).toMatchObject({ service: "auth" });
  });

  // ── LOG10: Empty context object handled correctly ────────────

  it("LOG10: empty context object does not corrupt message", () => {
    logger.info({}, "message-with-empty-ctx");

    const entries = logger.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe("message-with-empty-ctx");
    expect(entries[0]!.context).toBeDefined();
  });

  // ── LOG11: getEntries returns a copy (not reference) ─────────

  it("LOG11: getEntries returns a defensive copy", () => {
    logger.info("original");
    const entries1 = logger.getEntries();
    const entries2 = logger.getEntries();

    entries1.push({
      level: "info",
      message: "mutated",
      timestamp: new Date().toISOString(),
      component: "test",
    });

    expect(entries1.length).toBe(2); // mutated
    expect(entries2.length).toBe(1); // not affected
  });

  // ── LOG12: By-level filtering ───────────────────────────────

  it("LOG12: getByLevel filters entries by log level", () => {
    logger.info("i1");
    logger.warn("w1");
    logger.info("i2");
    logger.error("e1");

    expect(logger.getByLevel("info").length).toBe(2);
    expect(logger.getByLevel("warn").length).toBe(1);
    expect(logger.getByLevel("error").length).toBe(1);
    expect(logger.getByLevel("debug").length).toBe(0);
  });

  // ── LOG13: Max capacity eviction ────────────────────────────

  it("LOG13: max capacity evicts oldest entries first", () => {
    const capped = new InMemoryLogger("capped", 3);
    capped.info("first");
    capped.info("second");
    capped.info("third");
    capped.info("fourth"); // should evict "first"

    const entries = capped.getEntries();
    expect(entries.length).toBe(3);
    expect(entries[0]!.message).toBe("second"); // "first" evicted
    expect(entries[1]!.message).toBe("third");
    expect(entries[2]!.message).toBe("fourth");
  });

  // ── LOG14: clear() removes all entries ──────────────────────

  it("LOG14: clear() removes all entries", () => {
    logger.info("a");
    logger.info("b");
    expect(logger.getEntries().length).toBe(2);

    logger.clear();
    expect(logger.getEntries().length).toBe(0);
  });

  // ── LOG15: TypeScript overloads compile correctly ────────────

  it("LOG15: TypeScript overloads resolve to correct runtime behavior", () => {
    // Verify that TS overload resolution matches runtime behavior
    // after the fix. 1-arg => message, 2-arg with object first => context+msg

    // 1-arg string → message
    logger.info("plain");

    // 2-arg with context object → context + message
    logger.info({ key: "val" }, "ctx-first");

    // getEntries should have both with correct message fields
    const entries = logger.getEntries();
    expect(entries.length).toBe(2);
    expect(entries[0]!.message).toBe("plain");
    expect(entries[0]!.context).toEqual({});
    expect(entries[1]!.message).toBe("ctx-first");
    expect(entries[1]!.context).toMatchObject({ key: "val" });
  });
});
