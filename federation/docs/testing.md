# Testing harnesses

`@agentix-e/db-federation/testing` publishes the instrument this package is
verified with: a fault injector that wraps any `ICDCSink` and makes it misbehave
on command.

It ships because of what the package promises. Ordered delivery, one `emit()` per
change, a refusal that is retried and then recorded — none of those is
checkable from the outside by reading the code. A consumer needs a way to make
their own sink refuse and see what the middleware does about it. That is what
`CDCFailureInjector` is for.

Nothing here is on the replication path. Import it in a test suite, never in a
service.

```ts
import { CDCFailureInjector } from '@agentix-e/db-federation/testing';
```

## `CDCFailureInjector`

Wraps a sink, forwards every call, and injects the faults it is configured with.

```typescript
class CDCFailureInjector implements ICDCSink {
  constructor(sink: ICDCSink, failures: Partial<FailureConfig>[]);
  readonly name: string;
  readonly connected: boolean;
  readonly failureCount: number;
  readonly totalEmits: number;
  injectedBy(type: FailureType): number;
  reset(): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  emit(events: CDCSinkEvent[]): Promise<void>;
}
```

A typical use is one line in front of a real sink:

```ts
const sink = new WebhookSink(url);
const injector = new CDCFailureInjector(sink, [{ type: 'connection_drop', failEveryN: 3, maxFailures: 2, on: 'emit' }]);
```

### `FailureConfig`

Each entry configures one fault. Every field has a default, so a partial object
is enough.

| Field         | Default             | Meaning                                                                           |
| ------------- | ------------------- | --------------------------------------------------------------------------------- |
| `type`        | `'connection_drop'` | Which fault to inject.                                                            |
| `probability` | `0.1`               | Chance per attempt when `failEveryN` is 0.                                        |
| `latencyMs`   | `100`               | Delay added by a `latency_spike`.                                                 |
| `failEveryN`  | `0`                 | Fire on every N-th `emit()` call, deterministically. `0` means use `probability`. |
| `maxFailures` | `-1`                | Injections this entry may make. `-1` is unlimited.                                |
| `on`          | `'both'`            | Where a `connection_drop` fires: `'connect'`, `'emit'` or `'both'`.               |

Three of these need saying out loud, because they are the ones a reader guesses
wrong:

- **`maxFailures` is per entry.** A `latency_spike` with `maxFailures: 1` spends
  its own budget and nothing else. An earlier version kept one counter for the
  whole injector and compared it against each entry's limit, so a latency spike
  exhausted a `connection_drop` configured beside it and the drop never fired —
  a suite asserting "exactly-once under connection drops" measured an injector
  that never dropped a connection.
- **`failEveryN` counts `emit()` calls and never `connect()`.** It is how you
  say "fail the first write" deterministically. It cannot say "fail the
  handshake"; `probability` is the only control that reaches `connect()`, by
  design — an every-N rule that also counted connects would fire on a call the
  N was not chosen for.
- **`on` applies to `connection_drop` only.** The other four faults are observed
  at `emit()` by definition. Setting `on` on one of them is an error rather than
  a field that is silently ignored.

### `FailureType`

| Type               | What the caller sees                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `connection_drop`  | `connect()` or `emit()` rejects; the injector marks itself disconnected.                                |
| `latency_spike`    | The call takes `latencyMs` longer, then behaves normally.                                               |
| `partial_emit`     | Half the batch reaches the sink, then `emit()` rejects. Requires at least two events.                   |
| `duplicate_inject` | The batch is delivered twice. `emit()` resolves — a consumer that only retries on failure never learns. |
| `reorder_inject`   | The batch is delivered in reverse. `emit()` resolves. Requires at least two events.                     |

`partial_emit` and `reorder_inject` need a batch of two or more. `CDCSubscriptionPump`
emits one change at a time, so neither can fire through it; they are for a sink
driven by `CDCSinkResolver`, which batches. The injector does not spend an
entry's budget when the guard refuses, so the fault is still available to the
next batch-shaped caller.

### What it refuses

The constructor throws rather than accepting a configuration that cannot mean
anything:

- a `probability` outside `[0, 1]`, a negative or fractional `failEveryN`, a
  `maxFailures` below `-1`, or a negative `latencyMs`;
- `on` on a type that has no choice of injection point;
- two entries for the same fault. `connection_drop` at `'connect'` and at
  `'emit'` are different faults and may coexist; two `duplicate_inject` entries
  are the same fault twice, and the second could never fire.

## Measurement

`failureCount` is what the injector has injected, across every entry.
`injectedBy(type)` splits it, which is what a per-entry budget is measured
against. `totalEmits` counts `emit()` calls including the ones that failed.

`reset()` re-arms every budget and clears both counters. The configuration
stays, so a test can run the same fault profile against a second workload.

A fault the instrument did not inject is not counted: an emit that fails because
the injector is disconnected, or a `partial_emit` that could not fire because the
batch had one event, leaves `failureCount` where it was. The count answers "how
many faults did I fire", not "how many calls failed".

## Checking a delivery guarantee with it

```ts
const sink = new InMemoryCDCSink('measured');
const injector = new CDCFailureInjector(sink, [{ type: 'connection_drop', failEveryN: 1, maxFailures: 1, on: 'emit' }]);

const pump = new CDCSubscriptionPump({
  engine,
  registry,
  resolveSink: () => new CDCSinkResolver(injector, { healthCheckIntervalMs: 0 }),
});
await pump.start();
```

One change is appended; the first write is refused; the resolver reconnects; the
pump retries; the change arrives at `sink` exactly once, in LSN order, and
`pump.getStatus().delivered` is 1 while `injector.injectedBy('connection_drop')`
is 1. That is the whole delivery contract in one assertion, and it is the shape
the pump's own suite uses.
