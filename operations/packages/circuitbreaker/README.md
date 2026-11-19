# @agentix-e/db-operations-circuitbreaker

**A three-state circuit breaker for a database dependency, so a failing backend fails fast instead of queueing.**

One class and one interface. The package exists so that *should this call be attempted at all* is a decision with a state machine behind it, rather than a `try`/`catch` that retries until the timeout budget is gone.

---

## Features

- **Three-state machine** — `closed` → `open` → `half-open` → `closed`, with independent failure and success thresholds
- **Immediate rejection while open** — no queueing, no hidden timeout; the caller learns in microseconds
- **Optional fallback** — a second function the open state can run instead of refusing
- **Manual reporting** — `onSuccess()` / `onFailure()` for work the breaker did not run itself
- **Engine-agnostic** — the breaker knows nothing about what it protects

---

## Installation

```bash
npm install @agentix-e/db-operations-circuitbreaker
```

---

## Quick Start

```typescript
import { InMemoryCircuitBreaker } from '@agentix-e/db-operations-circuitbreaker';

const breaker = new InMemoryCircuitBreaker('orders-db', {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30_000,
});

const rows = await breaker.call(
  () => pool.query('SELECT * FROM orders'),
  () => cachedOrders(),           // runs while the circuit is open
);
```

---

## API Reference

### `CircuitBreakerConfig`

| Field | Default | Meaning |
|---|---|---|
| `failureThreshold` | 5 | Consecutive failures that open the circuit |
| `successThreshold` | 2 | Consecutive successes in half-open that close it again |
| `timeoutMs` | 30 000 | How long the circuit stays open before one trial request is allowed |

### `InMemoryCircuitBreaker`

| Member | Return | Description |
|---|---|---|
| `constructor(name, config?)` | — | `name` is the identity a log line carries |
| `getState()` | `CircuitState` | `'closed'`, `'open'` or `'half-open'` |
| `call(fn, fallback?)` | `Promise<T>` | Runs `fn` through the breaker; rejects immediately while open |
| `onSuccess()` / `onFailure()` | `void` | Report an outcome for work the breaker did not run |
| `reset()` | `void` | Back to `closed` with every counter cleared |

---

## Documentation

- [`docs/api/circuit-breaker.md`](docs/api/circuit-breaker.md) — the state machine, the counter semantics, and what the package deliberately does not do (no timeout, no bulkhead, no retry)

---

## Dependencies

None. The package has no runtime dependency, which is the point: a breaker that needs a dependency has to be protected from it.

---

## License

MIT
