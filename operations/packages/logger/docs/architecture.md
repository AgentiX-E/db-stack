# Architecture

## Position in the Framework

The logger package is a **cross-cutting concern** — it is used by all other packages for structured logging. It builds on `core` for shared type definitions.

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-logger                    │
│  ┌──────────────────┐ ┌──────────────────────────────┐  │
│  │     ILogger      │ │  ITraceContextProvider        │  │
│  │ (Interface)      │ │  (Interface)                  │  │
│  └──────────────────┘ └──────────────────────────────┘  │
│  ┌──────────────┐ ┌─────────────────────────────────┐   │
│  │ InMemoryLogr │ │ NoopLogger                      │   │
│  │ (Impl)       │ │ (Impl/Fallback)                 │   │
│  └──────────────┘ └─────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Pino-compatible API** — The method signatures mirror Pino's API, making it easy to swap in Pino or Winston as a production backend.

2. **Structured first** — All log entries carry structured context. This enables machine-parseable logging for centralized log systems (ELK, Loki, DataDog).

3. **Testability as a first-class concern** — `InMemoryLogger` is not an afterthought; it's a primary implementation designed specifically for test assertions. Every other package's tests use it.

4. **Context propagation** — `child()` enables creating loggers with pre-bound context, avoiding repetitive parameter passing. This is essential for tracing across async boundaries.

## Logger Method Dispatch

The `error()` and `fatal()` methods have complex overloads that handle:

```
error(msg: string)
error(err: Error, msg?: string)
error(context: Record<string, unknown>, msg: string)
error(context: Record<string, unknown>, err: Error, msg?: string)
```

Detection logic:
- `1 arg` → string or Error (auto-extracts stack)
- `2 args` → checks if first is Error (err, msg), Record (context, msg), or Record + Error (context, err)
- `3 args` → (context, err, msg)
