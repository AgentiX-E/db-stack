# @agentix-e/db-operations-memoryguard

**Admission control for memory pressure: refuse to start work that would take the process down with it.**

A single question — *is there room to do this?* — asked before a maintenance operation that allocates: a VACUUM, a reindex, a full-table export. It exists so those operations can decline instead of becoming the outage.

---

## Features

- **Ratio-based admission** — `heapUsed / heapTotal` against a configurable threshold (default 0.9)
- **A `null` return, not a throw** — a refusal is a normal outcome, so callers can branch on it without a `try`
- **Live statistics** — `getStats()` reads `process.memoryUsage()` at call time
- **Zero dependencies** — it measures the process it runs in, and nothing else

---

## Installation

```bash
npm install @agentix-e/db-operations-memoryguard
```

---

## Quick Start

```typescript
import { InMemoryMemoryGuard } from '@agentix-e/db-operations-memoryguard';

const guard = new InMemoryMemoryGuard();
guard.configure(0.85);

const result = await guard.protect(() => reindex('orders'));
if (result === null) {
  logger.warn('reindex skipped: heap above 85%', guard.getStats());
}
```

---

## API Reference

### `IMemoryGuard`

| Member | Return | Description |
|---|---|---|
| `configure(threshold)` | `void` | Fraction of `heapUsed / heapTotal` above which work is refused |
| `getStats()` | `MemoryStats` | `heapUsed`, `heapTotal`, `external`, `rss`, `threshold` |
| `isHealthy()` | `boolean` | Whether the ratio is below the threshold |
| `protect(fn)` | `Promise<T \| null>` | Runs `fn` when healthy; returns `null` **without running it** when not |

### `MemoryStats`

| Field | Meaning |
|---|---|
| `heapUsed` / `heapTotal` | V8's own heap accounting, in bytes |
| `external` | Memory held by C++ objects bound to JavaScript |
| `rss` | Resident set size |
| `threshold` | The configured ratio, echoed for logging |

---

## Documentation

- [`docs/api/memory-guard.md`](docs/api/memory-guard.md) — what the ratio does and does not see (native memory, cgroup limits), and why `--max-old-space-size` matters in a container

---

## License

MIT
