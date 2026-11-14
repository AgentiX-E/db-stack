# @agentix-e/db-operations-observability

**Distributed tracing and telemetry — create, manage, and export spans for database engine operations.**

This package provides a lightweight distributed tracing system for database engine operations. Components can create spans (the basic unit of tracing), nest them as parent-child, correlate with W3C Trace Context headers, and export completed spans to a telemetry backend. All implementations work in-memory, suitable for both testing and single-process deployments.

---

## Features

- **Distributed tracing** — Create spans with parent-child relationships for operation-level tracing
- **W3C Trace Context propagation** — Inject and extract `traceparent` headers for distributed systems
- **Span lifecycle management** — Start, end (with status), clear completed spans
- **Telemetry export** — Export spans to configurable backends (OTLP, Jaeger, Zipkin, console, JSON)
- **In-memory tracer** — Perfect for testing with full span inspection
- **In-memory exporter** — Capture exported spans for assertions

---

## Installation

```bash
npm install @agentix-e/db-operations-observability
```

---

## Quick Start

```typescript
import { InMemoryDistributedTracer, InMemoryTelemetryExporter } from '@agentix-e/db-operations-observability';

// Create tracer and exporter
const tracer = new InMemoryDistributedTracer();
const exporter = new InMemoryTelemetryExporter();

// Start a root span
const root = tracer.startSpan('query.execute', { attributes: { db: 'main', sql: 'SELECT *' } });

// Start a child span
const child = tracer.startSpan('storage.read', { attributes: { table: 'users' } });

// End both spans
child.end('ok');
root.end('ok');

// Export
const spans = tracer.getCompletedSpans();
console.log(`Completed ${spans.length} spans`);
console.log(`Trace ID: ${spans[0].traceId}`);
console.log(`Root span: ${spans[1].spanId} → child: ${spans[0].spanId}`);

// Export to external system
await exporter.export(spans);
console.log(`Exported ${exporter.getExported().length} batch(es)`);
```

---

## API Reference

### Interfaces

#### `IDistributedTracer`

| Method | Return | Description |
|---|---|---|
| `startSpan(name, options?)` | `{ spanId, end }` | Start a span; returns span ID and end function |
| `getCurrentSpan()` | `{ traceId, spanId } \| undefined` | Get active span context |
| `getCompletedSpans()` | `Span[]` | Get all completed spans |
| `clearCompletedSpans()` | `void` | Clear completed spans after export |
| `inject(carrier)` | `void` | Inject W3C trace context into headers |
| `extract(carrier)` | `{ traceId, parentSpanId } \| undefined` | Extract W3C trace context from headers |

#### `ITelemetryExporter`

| Method | Return | Description |
|---|---|---|
| `export(spans)` | `Promise<void>` | Export spans to external system |
| `isConnected()` | `boolean` | Check exporter connection |
| `getFormat()` | `TelemetryExportFormat` | Get export format |
| `shutdown()` | `Promise<void>` | Shutdown the exporter |

### Types

| Type | Fields |
|---|---|
| `Span` | `spanId, parentSpanId?, traceId, name, startTime, endTime?, attributes, status, errorMessage?` |
| `TelemetryExportFormat` | `'otlp' \| 'jaeger' \| 'zipkin' \| 'console' \| 'json'` |

---

## Implementations

### `InMemoryDistributedTracer`

Implements `IDistributedTracer`. Tracks active spans and completed spans in memory.

- **Span IDs:** Generated via `crypto.randomUUID()`
- **Trace IDs:** Generated via `crypto.randomUUID()`, or propagated from parent context
- **Parent relationship:** New spans inherit the current active span as parent
- **End function:** Closes the span, records duration, returns to parent span context
- **W3C Trace Context:** Format `00-{traceId}-{spanId}-01`

### `InMemoryTelemetryExporter`

Implements `ITelemetryExporter`. Captures exported spans in a list of batches.

**Methods (testing helpers):**
- `getExported()` — Returns all exported span batches (`Span[][]`)

---

## Usage Examples

### Nested Span Tracing

```typescript
import { InMemoryDistributedTracer } from '@agentix-e/db-operations-observability';

const tracer = new InMemoryDistributedTracer();

// Root span: a query execution
const querySpan = tracer.startSpan('query.execute', {
  attributes: { db: 'orders', sql: 'SELECT * FROM orders WHERE id = ?' },
});

// Child span: measure storage read time
const storageSpan = tracer.startSpan('storage.page_read', {
  attributes: { table: 'orders', page: '42' },
});
// ... simulate page read ...
storageSpan.end('ok');

// Another child: measure deserialization
const deserSpan = tracer.startSpan('deserialize.row', {
  attributes: { columns: '5' },
});
// ... simulate deserialization ...
deserSpan.end('ok');

// End root
querySpan.end('ok');

// Inspect
const spans = tracer.getCompletedSpans();
console.log(`Total spans: ${spans.length}`);
console.log(`All share trace ID: ${spans.every(s => s.traceId === spans[0].traceId)}`);
console.log(`Root duration: ${(spans[2].endTime! - spans[2].startTime)}ms`);
```

### W3C Trace Context Propagation

```typescript
// Service A (produces trace)
const tracerA = new InMemoryDistributedTracer();
const spanA = tracerA.startSpan('service-a.handle');

// Inject into HTTP headers
const headers: Record<string, string> = {};
tracerA.inject(headers);
console.log(headers['traceparent']); // "00-{traceId}-{spanId}-01"

spanA.end('ok');

// Service B (consumes trace context)
const tracerB = new InMemoryDistributedTracer();
const ctx = tracerB.extract(headers);
if (ctx) {
  // Continue the same trace
  const spanB = tracerB.startSpan('service-b.process', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
  });
  // ... do work ...
  spanB.end('ok');
}
```

### Export to External Backend

```typescript
class ConsoleTelemetryExporter implements ITelemetryExporter {
  private connected = true;

  async export(spans: Span[]): Promise<void> {
    for (const span of spans) {
      const duration = span.endTime ? span.endTime - span.startTime : -1;
      console.log(
        `[${span.status.toUpperCase()}] ${span.name} (${duration}ms) ` +
        `trace=${span.traceId} span=${span.spanId}`,
      );
      if (span.parentSpanId) {
        console.log(`  parent=${span.parentSpanId}`);
      }
    }
  }

  isConnected(): boolean { return this.connected; }
  getFormat(): TelemetryExportFormat { return 'console'; }
  async shutdown(): Promise<void> { this.connected = false; }
}
```

---

## Testing

```bash
cd packages/observability
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Core type definitions
