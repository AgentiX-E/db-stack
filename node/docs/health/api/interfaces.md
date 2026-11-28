# Health Package API

## Interfaces

### `IHealthProbe`

| Method | Return |
|---|---|
| `liveness()` | `ProbeResult` |
| `readiness()` | `ProbeResult` |
| `startup()` | `ProbeResult` |
| `probeId` (property) | `string` |
| `componentName` (property) | `string` |

### `IComponentRegistrar`

| Method | Return |
|---|---|
| `registerComponent(probe, options?)` | `void` |
| `unregisterComponent(probeId)` | `void` |
| `hasComponent(probeId)` | `boolean` |
| `getComponentHealth()` | `ComponentHealth[]` |
| `getAggregateStatus()` | `{ status, count }` |

### `IHealthOrchestrator` (extends `IComponentRegistrar`)

| Method | Return |
|---|---|
| `liveness()` | `{ ok, errors }` |
| `readiness()` | `{ ok, errors }` |
| `startup()` | `{ ok, errors }` |
| `getHealthStatus()` | `HealthStatus` |
| `getSummary()` | `string` |

## Implementations

- **`HealthOrchestrator`** — Full orchestrator with component registry and functional probe registration via `registerFunctional()`
- **`componentProbe()`** — Factory creating `IHealthProbe` from callback functions

## Deadlines

A probe may answer with a promise, and a promise can stay pending for ever.
Every awaited answer is therefore bounded by a deadline so a stalled dependency
becomes a named failure instead of a health endpoint that never replies.

```typescript
const DEFAULT_PROBE_TIMEOUT_MS: number; // 100, the readiness budget

interface HealthOrchestratorOptions {
  probeTimeoutMs?: number; // default: DEFAULT_PROBE_TIMEOUT_MS
  timer?: ProbeTimer;
  clock?: MonotonicClock;
}

interface ProbeTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;
}

function settleWithin<T>(
  work: () => T | Promise<T>,
  timeoutMs: number,
  timer?: ProbeTimer,
): Promise<T>;
```

`HealthOrchestrator` accepts `HealthOrchestratorOptions` in its constructor;
the default budget is `DEFAULT_PROBE_TIMEOUT_MS` (100 ms). `ProbeTimer` is the
engine-agnostic clock seam — inject a virtual or monotonic clock in place of
the host timers (exported as `systemTimer`). `settleWithin` is the same deadline
primitive used internally, exposed for adapters that need to bound their own
awaited answers; on expiry it rejects with a `ProbeTimeoutError` naming the
budget, and a losing answer's late rejection is consumed rather than surfacing
as an unhandled rejection.

Uptime is a duration and must never go negative after an NTP or VM clock step.
The `clock` option is a `MonotonicClock` — an epoch-anchored, non-decreasing
clock. `createMonotonicClock` wraps any epoch source with the clamp; the host
clock is the default, and a deployment may inject its own. Both are exported
from the `core` subpath.
