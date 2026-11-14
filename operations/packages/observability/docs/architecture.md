# Architecture

## Position in the Framework

The observability package provides the **distributed tracing layer** — the highest-level observability abstraction, consuming spans from any component that uses the tracer.

```
┌─────────────────────────────────────────────────────────┐
│              db-operations-observability                 │
│  ┌─────────────────────────────────────────────────┐    │
│  │              IDistributedTracer                  │    │
│  │  startSpan | getCurrentSpan | completed | inject │    │
│  │  extract | clearCompletedSpans                  │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │             ITelemetryExporter                    │    │
│  │      export | isConnected | getFormat | shutdown │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌──────────────┐ ┌──────────────────────────────┐      │
│  │ InMemory     │ │ InMemoryTelemetryExporter    │      │
│  │ Tracer       │ │                              │      │
│  └──────────────┘ └──────────────────────────────┘      │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Span Lifecycle

```
startSpan(name, options)
  │
  ▼
Create Span with:
  - New spanId
  - Parent spanId (from current active span)
  - Trace ID (from parent or new)
  - startTime = now
  - status = 'ok'
  │
  ▼
Set as current active span
  │
  ▼
Return { spanId, end(status?, error?) }
  │
  ▼
[Caller does work]
  │
  ▼
end('ok' | 'error')
  │
  ▼
Record endTime
Move from active to completed
Restore parent as active (if any)
```

## W3C Trace Context Format

```
traceparent header format: 00-{traceId}-{spanId}-01

Where:
  - 00          = version
  - traceId     = 32 hex chars (UUID)
  - spanId      = 32 hex chars (UUID)
  - 01          = trace flags (01 = sampled)
```

## Span Attributes Convention

| Key | Value Type | Description |
|---|---|---|
| `db.name` | `string` | Database name |
| `db.operation` | `string` | Operation type (query, migrate, backup) |
| `db.statement` | `string` | SQL or command text |
| `shard.id` | `string` | Shard identifier |
| `user` | `string` | Authenticated user |
| `error.type` | `string` | Error type or code |
