# @agentix-e/db-operations-logger

**Structured logger interface with trace context propagation for database engine operations.**

This package provides a pino-like logging interface (`ILogger`) with multiple severity levels, structured context, child logger creation, and trace ID correlation. It ships with two implementations: an in-memory logger for testing, and a no-op logger for fallback scenarios.

---

## Features

- **Structured log entries** — Every log entry is a typed `LogEntry` object with level, message, timestamp, component, and context
- **Multiple severity levels** — `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- **Error object support** — `error()` and `fatal()` accept `Error` objects with automatic stack trace extraction
- **Child loggers** — Create loggers with pre-bound context via `child(bindings)`
- **Trace context propagation** — `ITraceContextProvider` for distributed tracing correlation
- **In-memory implementation** — Store entries for test assertions with level filtering and capacity-limited eviction
- **Noop fallback** — Static singleton that discards all output without overhead

---

## Installation

```bash
npm install @agentix-e/db-operations-logger
```

---

## Quick Start

```typescript
import { InMemoryLogger } from '@agentix-e/db-operations-logger';

const logger = new InMemoryLogger('my-component');

logger.info('Server started');
logger.info({ port: 3000, host: '0.0.0.0' }, 'Listening');
logger.error(new Error('ECONNREFUSED'), 'Connection failed');

// Inspect logged entries
const entries = logger.getEntries();
console.log(entries[0].level); // 'info'
console.log(entries[0].message); // 'Server started'
```

---

## API Reference

### Interfaces

#### `ILogger`

Structured logger interface.

| Method | Signature | Description |
|---|---|---|
| `child` | `(bindings) => ILogger` | Create child logger with pre-bound context |
| `trace` | `(msg)` or `(context, msg)` | Log at trace level |
| `debug` | `(msg)` or `(context, msg)` | Log at debug level |
| `info` | `(msg)` or `(context, msg)` | Log at info level |
| `warn` | `(msg)` or `(context, msg)` | Log at warn level |
| `error` | `(msg)`, `(err, msg?)`, `(context, msg)`, `(context, err, msg?)` | Log at error level |
| `fatal` | `(msg)`, `(err, msg?)`, `(context, msg)`, `(context, err, msg?)` | Log at fatal level |

**Overload patterns for `error()` and `fatal()`:**

| Pattern | Example |
|---|---|
| Simple message | `logger.error('Failed')` |
| Error + message | `logger.error(new Error('timeout'), 'Request failed')` |
| Context + message | `logger.error({ requestId }, 'Failed')` |
| Context + error | `logger.error({ requestId }, new Error(), 'msg')` |

#### `ITraceContextProvider`

Trace context carrier for async operation correlation.

| Method | Signature | Description |
|---|---|---|
| `getTraceId` | `() => string \| undefined` | Get current trace ID |
| `withTrace` | `<T>(traceId, fn) => T` | Run within a trace context |
| `withTraceAsync` | `<T>(traceId, fn) => Promise<T>` | Run async within a trace context |

### Types

#### `LogLevel`

```typescript
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
```

#### `LogEntry`

```typescript
interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  component: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string; name?: string };
  traceId?: string;
}
```

---

## Implementations

### `InMemoryLogger`

Logs to an in-memory array. Supports capacity-limited eviction, level filtering, and clear.

**Constructor:**
```typescript
new InMemoryLogger(component?: string, maxEntries?: number)
```
- `component` — Default `'default'`. Label for all entries.
- `maxEntries` — Default `100`. Oldest entries are evicted when exceeded.

**Additional methods:**
| Method | Description |
|---|---|
| `getEntries()` | Get all log entries |
| `getByLevel(level)` | Filter entries by severity |
| `clear()` | Clear all entries |

### `NoopLogger`

Silently discards all log messages. Use as a fallback logger.

```typescript
import { NoopLogger } from '@agentix-e/db-operations-logger';

const logger = NoopLogger.INSTANCE;
// or
const logger = new NoopLogger();
```

---

## Usage Examples

### Child Logger with Context

```typescript
const rootLogger = new InMemoryLogger('app');
const requestLogger = rootLogger.child({ requestId: 'req-123' });
const userLogger = requestLogger.child({ userId: 'user-456' });

userLogger.info('Processing payment');
// Creates entry: { ..., context: { requestId: 'req-123', userId: 'user-456' } }
```

### Test Assertion with InMemoryLogger

```typescript
const logger = new InMemoryLogger('test');

// Simulate some operations
logger.info('Operation A completed');
logger.warn({ retries: 3 }, 'Operation B slow');

// Assertions
const warns = logger.getByLevel('warn');
expect(warns).toHaveLength(1);
expect(warns[0].context?.retries).toBe(3);

// Clear between tests
logger.clear();
```

### Trace Context Propagation

```typescript
import type { ITraceContextProvider } from '@agentix-e/db-operations-logger';

class TraceContext implements ITraceContextProvider {
  private traceId: string | undefined;

  getTraceId(): string | undefined { return this.traceId; }

  withTrace<T>(traceId: string, fn: () => T): T {
    const prev = this.traceId;
    this.traceId = traceId;
    try { return fn(); } finally { this.traceId = prev; }
  }

  async withTraceAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.traceId;
    this.traceId = traceId;
    try { return await fn(); } finally { this.traceId = prev; }
  }
}
```

---

## Testing

```bash
cd packages/logger
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Core type definitions
