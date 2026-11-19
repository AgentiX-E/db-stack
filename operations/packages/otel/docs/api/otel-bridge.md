# OTel bridge

An in-process collector for the three OpenTelemetry signals — spans, metrics and
logs — behind one object. It is the seam a deployment uses to produce signals
without depending on an exporter during tests, and the place an adapter bridges
to a real OTel SDK.

```ts
import { InMemoryOTELBridge } from "@agentix-e/db-operations-otel";

const otel = new InMemoryOTELBridge();
const { spanId, end } = otel.startSpan("vacuum", { attributes: { table: "orders" } });

otel.recordMetric("vacuum_rows", 12_004);
otel.exportLog({ severity: "info", message: "vacuum finished", attributes: {}, spanId });
end("ok");

const spans = otel.getSpans();
await otel.shutdown();
```

## `InMemoryOTELBridge`

| Member | Contract |
|---|---|
| `startSpan(name, options?)` | Returns `{ spanId, end }`. The span is recorded immediately and finished by `end(status?)` |
| `recordMetric(name, value, labels?)` | Appends one point |
| `exportLog(log)` | Appends one record. The timestamp is added here, not accepted from the caller |
| `getSpans()` / `getMetrics()` / `getLogs()` | The buffers, as recorded |
| `shutdown()` | Marks the bridge shut. Subsequent `startSpan`/`recordMetric`/`exportLog` calls after shutdown are refused rather than buffered |
| `isShutdown()` | Whether it has been shut down |

Types: `OTSpan` (`spanId`, `traceId`, `parentSpanId?`, `name`, `startTime`,
`endTime?`, `attributes`, `status`), `OTMetric`, `OTLog`.

## Bridging to a real SDK

`IOTELBridge` is three methods wide on purpose. A deployment with the OpenTelemetry
SDK maps them one-to-one — `startSpan` → `tracer.startSpan`, `recordMetric` →
`meter.createCounter(...).add`, `exportLog` → the log SDK — and keeps the rest of
the framework calling this interface, so that nothing in `operations` depends on a
specific SDK version.

An `end()` that is never called leaves a span with no `endTime` in the buffer,
which is the correct representation of a span that never finished and is what makes
a leak visible in `getSpans()`. It is also the shape a caller should look for when
a trace appears truncated.

## What this is not

No sampling, no batching, no export. The buffers grow without bound; a process
that runs for a week should either drain them periodically or bridge to an SDK that
owns the window. This class exists so that the *producing* side of telemetry can be
written and tested without one.
