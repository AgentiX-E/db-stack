# Circuit breaker

One class and one interface. The package exists so that *failing fast* is a
decision a caller makes explicitly, with a state machine behind it, instead of a
`try`/`catch` that retries until the timeout budget is gone.

```ts
import { InMemoryCircuitBreaker } from "@agentix-e/db-operations-circuitbreaker";

const breaker = new InMemoryCircuitBreaker("orders-db", {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30_000,
});

const rows = await breaker.call(
  () => pool.query("SELECT * FROM orders"),
  () => cached.orders(),           // optional fallback, called while open
);
```

## `InMemoryCircuitBreaker`

| Member | Contract |
|---|---|
| `constructor(name, config?)` | `name` is the identity a log line carries. Omitted fields take the defaults below |
| `getState()` | `'closed'`, `'open'` or `'half-open'` |
| `call(fn, fallback?)` | Runs `fn` through the breaker. While **open**, rejects immediately with `Circuit breaker 'name' is open` — or runs `fallback` when one was supplied |
| `onSuccess()` / `onFailure()` | Report an outcome for work the breaker did not run. Use these when the call is not a promise this class can wrap |
| `reset()` | Back to `closed` with every counter cleared. The escape hatch for an operator who has fixed the dependency |

`CircuitBreakerConfig`:

| Field | Default | Meaning |
|---|---|---|
| `failureThreshold` | 5 | Consecutive failures that open the circuit |
| `successThreshold` | 2 | Consecutive successes in half-open that close it again |
| `timeoutMs` | 30 000 | How long the circuit stays open before one trial request is allowed |

The state machine is the ordinary three-state one:

```
closed ──failureThreshold consecutive failures──▶ open
  ▲                                                │
  │                                       timeoutMs│
  └──successThreshold consecutive successes── half-open ◀┘
                                    │
                                    └──one failure──▶ open
```

Half-open admits **one** trial at a time; a second concurrent call is refused
rather than queued, because the point of the state is to test the dependency with
the smallest possible load. Counters reset on every transition — a success
recorded while open would otherwise count toward closing a circuit that never
reopened.

## Why `InMemory` is the whole implementation

The name describes the scope, not the quality: there is no in-process state a
circuit breaker could keep anywhere else. Persisting the state across processes
would make each replica share a verdict about a dependency it reached over its own
connection, which is a different feature with a different failure mode.

## Not covered

No per-request timeout, no bulkhead, no retry. A timeout belongs to the call, a
retry belongs to the caller that knows whether the operation is idempotent, and
this class answers one question: *should this call be attempted at all?*
