/**
 * InMemoryOTELBridge — branch-completion tests.
 *
 * Targets the guard in the span `end` closure:
 *
 *   const s = this.active.get(spanId);
 *   if (!s) return;
 *
 * When `end()` is called a second time for the same span, the span has
 * already been removed from `active`, so `s` is undefined and the guard
 * returns early. This must not throw and must not double-record the span.
 */

import { describe, it, expect } from "vitest";
import { InMemoryOTELBridge } from "../impl/InMemoryOTELBridge.js";

describe("IOTEL-branch: idempotent span end", () => {
  it("calling end() twice records the span only once", () => {
    const otel = new InMemoryOTELBridge();
    const s = otel.startSpan("once");

    s.end("ok");
    // Second call finds no active span → early return without throwing.
    expect(() => s.end("error")).not.toThrow();

    const spans = otel.getSpans();
    expect(spans).toHaveLength(1);
    // Status remains 'ok' (first end) — the second call must be a no-op.
    expect(spans[0].status).toBe("ok");
  });
});
