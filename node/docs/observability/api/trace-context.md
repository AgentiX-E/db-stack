# Trace context

`InMemoryDistributedTracer` records spans for one process. `W3CTraceContextProvider`
is the part that makes a trace cross a boundary: it produces and consumes the
`traceparent` header defined by [W3C Trace Context Level 2][spec], which is what
every other system in a modern stack already speaks.

[spec]: https://www.w3.org/TR/trace-context-2/

```ts
import { W3CTraceContextProvider } from "@agentix-e/db-node/observability";

const trace = new W3CTraceContextProvider();
const span = trace.createChildSpan("query", { table: "orders" });

await withRetries(() => runQuery(span), {
  onAttempt: () => span.addEvent("retry"),
});

span.end("ok");
```

## The header

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                │
             │  trace-id (32 hex)               span-id (16 hex)  flags
             version
```

`getTraceParent()` always emits version `00` and flags `01` (sampled), because this
provider has no sampler: every span it creates is recorded, and a `00` flag would
claim otherwise.

## `W3CTraceContextProvider`

| Member | Contract |
|---|---|
| `constructor(traceId?)` | Starts a trace. Without an id one is generated (16 random bytes) |
| `getTraceParent()` | The header for the *current* span |
| `getTraceId()` / `getSpanId()` | The current context, for logging |
| `createChildSpan(name, attributes?)` | Makes a span, records it, and makes it current. The parent's id is captured at this moment |
| `extract(traceParent)` | Adopt an inbound context. Throws when the header does not match `00-{32 hex}-{16 hex}-{2 hex}` |

### The current span is a stack

`createChildSpan` sets the new span as current; `ISpan.end()` restores the parent.
That is a **last-in-first-out** assumption, and it is worth stating because the
failure is silent: ending two spans out of order leaves the context pointing at a
span that has already ended, and every later span is a child of the wrong parent.
A caller that forks work must give each branch its own `W3CTraceContextProvider`,
which is why `extract` exists — a worker adopts the context it was handed instead
of sharing the producer's.

### `ISpan`

| Member | Contract |
|---|---|
| `getTraceParent()` / `getSpanId()` | This span's identity, independent of what is current |
| `end(status?, errorMessage?)` | Records the end time and restores the parent. **Idempotent**: a second call does nothing, so a `finally` block cannot double-close a span |
| `addEvent(name, attrs?)` | Appends a timestamped event |
| `setStatus(code, description?)` | Sets the outcome without ending the span. `end()` without a status keeps what this set |

### Reading spans out

| Member | Contract |
|---|---|
| `flush()` | Returns every span recorded so far and clears the buffer. Do not call it in a request path: it takes the spans a later exporter still needs |
| `getActiveSpans()` | The spans that have not ended |
| `spanCount()` | How many spans the buffer holds — cumulative, not concurrent |

## What this does not do

No sampling, no batch export, no baggage header, and no `tracestate` propagation.
It is the context object, not the tracer: the spans it produces are handed to an
`ITelemetryExporter` (or read with `flush()`), and a deployment that needs
sampling decides it before calling `createChildSpan`.

Version `00` is the only version accepted by `extract`. The specification reserves
the right to add versions, and a parser that accepted a future version by pattern
would be accepting a format it does not understand; refusing is the answer that
fails loudly instead of dropping fields.
