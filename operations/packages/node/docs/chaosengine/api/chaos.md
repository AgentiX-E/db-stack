# Chaos engineering

Fault injection is only useful if it is *reproducible*, and reproducibility is the
difference between the two engines in this package:

| Class | What it is |
|---|---|
| `InMemoryChaosEngine` | The v0.1 reference: it records faults and the callbacks registered against them. Nothing is actually broken |
| `ChaosEngineV2` | Injects into live transports, runs declarative scenarios with invariant checks, and is deterministic under a seed |

```ts
import { ChaosEngineV2 } from "@agentix-e/db-operations-node/chaosengine";

const chaos = new ChaosEngineV2();          // no configuration: the seed belongs to the scenario
await chaos.start([transportA, transportB, transportC]);

await chaos.inject({ type: "latency-injection", targets: ["a"], durationMs: 5_000, config: { ms: 250 } });
await chaos.healAll();
```

## `ChaosEngineV2`

| Member | Contract |
|---|---|
| `start(transports)` | Registers the transports that may be faulted. Injection before `start` is refused |
| `stop()` | Stops the engine and heals what it injected |
| `inject(fault)` | Injects one fault and returns its id. Time-bounded faults auto-resolve after `durationMs`; `0` means manual |
| `injectMany(faults)` | Injects a set atomically from the caller's point of view — a partially-applied set is not a state this leaves behind |
| `resolve(faultId)` / `healAll()` | Undo one fault / undo all of them |
| `getActiveFaults()` / `getHistory()` | What is broken now / everything that ever was |
| `getAllTransportStats()` | Per-transport `ChaosTransportStats`: sent, lost, delayed, partitioned, average latency, connected peers |
| `runScenario(scenario, checker)` | Runs a scenario and verifies its invariants |
| `onFaultInjected` / `onFaultResolved` / `onStepCompleted` / `onScenarioCompleted` | Lifecycle callbacks. Each returns an unsubscribe function |

## The transport seam

`IChaosTransport` is what makes this engine-independent. A repository supplies one
adapter per node and the engine never learns what it is attacking:

```ts
interface IChaosTransport {
  transportId: string;
  isolate(peerIds: string[]): void;
  heal(peerIds: string[]): void;
  healAll(): void;
  setMessageLoss(rate: number): void;   // 0–1
  setLatency(ms: number): void;
  stop(): Promise<void>;                // simulate a crash
  start(): Promise<void>;               // come back
}
```

A transport that cannot express a fault type (a shard id that has no wire) is
expected to answer with a no-op rather than a throw: a scenario that names a
target the deployment does not have is a configuration mistake to report in
`getAllTransportStats()`, not a reason to abandon the run.

## Fault types

`network-partition`, `node-crash`, `message-loss`, `latency-injection`,
`clock-skew`, `resource-pressure`, `leadership-flap`, `cascading-failure`.

`ChaosFaultV2` is `{ faultId?, type, targets, durationMs, config, description? }`,
where `config` is fault-specific — `{ ms: 250 }` for latency, `{ rate: 0.1 }` for
loss, `{ skewMs: 500 }` for clock skew.

## Scenarios

```ts
const result = await chaos.runScenario(
  {
    name: "leader flap during write",
    description: "a write must not be lost when leadership moves",
    seed: 7,
    maxDurationMs: 30_000,
    steps: [
      { name: "warm", fault: { type: "latency-injection", targets: ["a"], durationMs: 1_000, config: { ms: 5 } }, waitMs: 100 },
      { name: "flap", fault: { type: "leadership-flap", targets: ["a"], durationMs: 3_000, config: {} }, waitMs: 5_000, invariants: ["no-data-loss"] },
    ],
  },
  myInvariantChecker,
);
```

`ScenarioRunResult` reports `passed`, `stepsExecuted` / `totalSteps`,
`invariantResults`, `faultHistory` and `errors`. A step's invariants are checked
**during** its duration, not after — an invariant that only holds at the end is not
the invariant a user cares about.

`seed` is the reproducibility contract: the same seed produces the same fault
sequence, which is what makes a scenario that failed last night re-runnable this
morning.

## `SeededRNG`

The PRNG behind that contract: Mulberry32, seeded, with `next()`, `pick(arr)`,
`pickN(arr, n)` and `shuffle(arr)`.

```ts
const rng = new SeededRNG(42);
rng.next();                 // deterministic in [0, 1)
```

It is exported because a scenario's own decisions — which node to hit first, which
shard to skew — should come from the same stream as the engine's. Two generators
seeded from the same number and advanced in different orders are two different
sequences, and a scenario that mixes them is not replayable.
