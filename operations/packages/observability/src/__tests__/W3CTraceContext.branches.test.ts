/**
 * W3CTraceContext — branch-completion tests.
 *
 * Targets the remaining uncovered paths:
 *   - the ISpan.getSpanId() accessor (never exercised by the existing suite)
 *   - end(status, errorMessage) with an explicit errorMessage, covering the
 *     `if (errorMessage !== undefined)` true branch
 *   - end() with an explicitly-undefined status/errorMessage (the false branch
 *     of both `!== undefined` guards), confirming default values are preserved
 */

import { describe, it, expect } from "vitest";
import { W3CTraceContextProvider } from "../impl/W3CTraceContext.js";

describe("W3CTC-branch: span accessor and end() optional args", () => {
  it("child span exposes its own spanId via getSpanId", () => {
    const ctx = new W3CTraceContextProvider();
    const span = ctx.createChildSpan("op");

    const viaAccessor = span.getSpanId();
    // getSpanId must return the 16-hex span id and match the traceparent's span segment.
    expect(viaAccessor).toMatch(/^[0-9a-f]{16}$/);
    expect(span.getTraceParent()).toContain(viaAccessor);
  });

  it("end(status, errorMessage) records the explicit errorMessage", () => {
    const ctx = new W3CTraceContextProvider();
    const span = ctx.createChildSpan("failing");
    span.end("error", "socket hang up");

    const [data] = ctx.flush();
    expect(data.status).toBe("error");
    expect(data.errorMessage).toBe("socket hang up");
  });

  it("end() with undefined args preserves defaults and clears active span", () => {
    const ctx = new W3CTraceContextProvider();
    const span = ctx.createChildSpan("no-status");

    // Explicitly-undefined status/errorMessage must not override defaults.
    span.end(undefined, undefined);

    const [data] = ctx.flush();
    expect(data.status).toBe("ok");
    expect(data.errorMessage).toBeUndefined();
    // The child is no longer active after end().
    expect(ctx.getActiveSpans()).toHaveLength(0);
  });
});
