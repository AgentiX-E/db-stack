# Observability Package API

## Interfaces

### `IDistributedTracer`

| Method | Return | Description |
|---|---|---|
| `startSpan(name, options?)` | `{ spanId, end }` | Start a span, returns ID and end function |
| `getCurrentSpan()` | `{ traceId, spanId } \| undefined` | Active span context |
| `getCompletedSpans()` | `Span[]` | All completed spans |
| `clearCompletedSpans()` | `void` | Clear after export |
| `inject(carrier)` | `void` | Inject W3C Trace Context |
| `extract(carrier)` | `{ traceId, parentSpanId } \| undefined` | Extract W3C Trace Context |

### `ITelemetryExporter`

| Method | Return |
|---|---|
| `export(spans)` | `Promise<void>` |
| `isConnected()` | `boolean` |
| `getFormat()` | `TelemetryExportFormat` |
| `shutdown()` | `Promise<void>` |

## Types

### `Span`

| Field | Type |
|---|---|
| `spanId` | `string` |
| `parentSpanId?` | `string` |
| `traceId` | `string` |
| `name` | `string` |
| `startTime` | `number` |
| `endTime?` | `number` |
| `attributes` | `Record<string, string \| number \| boolean>` |
| `status` | `'ok' \| 'error'` |
| `errorMessage?` | `string` |

## Implementations

- **`InMemoryDistributedTracer`** — Full tracer with parent/child tracking, W3C propagation.
- **`InMemoryTelemetryExporter`** — Captures exported spans in batch list. Test helper: `getExported()`.
