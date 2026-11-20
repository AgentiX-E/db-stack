# Logger Package API

## Interfaces

### `ILogger`

| Method | Signatures |
|---|---|
| `child(bindings)` | `(bindings: Record<string, unknown>) => ILogger` |
| `trace()` | `(msg: string) \| (context, msg: string)` |
| `debug()` | `(msg: string) \| (context, msg: string)` |
| `info()` | `(msg: string) \| (context, msg: string)` |
| `warn()` | `(msg: string) \| (context, msg: string)` |
| `error()` | `(msg) \| (err, msg?) \| (context, msg) \| (context, err, msg?)` |
| `fatal()` | `(msg) \| (err, msg?) \| (context, msg) \| (context, err, msg?)` |

### `ITraceContextProvider`

| Method | Return |
|---|---|
| `getTraceId()` | `string \| undefined` |
| `withTrace(traceId, fn)` | `T` |
| `withTraceAsync(traceId, fn)` | `Promise<T>` |

## Types

- **`LogLevel`** — `'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'`
- **`LogEntry`** — `{ level, message, timestamp, component, context?, error?, traceId? }`

## Implementations

- **`InMemoryLogger`** — Constructor: `(component?, maxEntries?)`. Methods: `getEntries()`, `getByLevel(level)`, `clear()`
- **`NoopLogger`** — Static `INSTANCE` singleton. All methods are no-ops.
