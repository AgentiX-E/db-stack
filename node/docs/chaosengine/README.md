# @agentix-e/db-node/chaosengine

**Inject faults into a live cluster through a transport seam, run declarative scenarios, and reproduce a failure from a seed.**

Fault injection is only useful if it is reproducible. `ChaosEngineV2` is deterministic under a scenario's `seed`; `InMemoryChaosEngine` is the v0.1 reference that records faults without breaking anything.

---

## Features

- **Eight fault types** — network partition, node crash, message loss, latency, clock skew, resource pressure, leadership flap, cascading failure
- **Transport-level injection** — `IChaosTransport` is the only thing the engine knows about the target
- **Scenarios with invariants** — a DAG of steps, each with the invariants to check *during* its duration
- **Deterministic replay** — `SeededRNG` (Mulberry32) makes the same seed produce the same sequence
- **Lifecycle callbacks** — injection, resolution, step and scenario events; each returns an unsubscribe function

---

## Installation

```bash
npm install @agentix-e/db-node
```

---

## Quick Start

```typescript
import { ChaosEngineV2 } from '@agentix-e/db-node/chaosengine';

const chaos = new ChaosEngineV2();
await chaos.start([transportA, transportB, transportC]);

await chaos.inject({
  type: 'latency-injection',
  targets: ['a'],
  durationMs: 5_000,
  config: { ms: 250 },
});

await chaos.healAll();
```

---

## API Reference

### `ChaosEngineV2`

| Member | Return | Description |
|---|---|---|
| `start(transports)` / `stop()` | `Promise<void>` | Registers the transports that may be faulted |
| `inject(fault)` | `Promise<string>` | Injects one fault, returns its id; `durationMs: 0` means manual resolve |
| `injectMany(faults)` | `Promise<string[]>` | Injects a set |
| `resolve(faultId)` / `healAll()` | `Promise<void>` | Undo one fault / all of them |
| `getActiveFaults()` / `getHistory()` | `ChaosFaultV2[]` | What is broken now / everything that ever was |
| `getAllTransportStats()` | `Map<string, ChaosTransportStats>` | Sent, lost, delayed, partitioned, latency, peers |
| `runScenario(scenario, checker)` | `Promise<ScenarioRunResult>` | Runs a scenario and verifies its invariants |

### `IChaosTransport`

| Member | Description |
|---|---|
| `transportId` | Unique id |
| `isolate(peerIds)` / `heal(peerIds)` / `healAll()` | Partition control |
| `setMessageLoss(rate)` | 0–1 |
| `setLatency(ms)` | Fixed delay |
| `stop()` / `start()` | Simulate a crash and come back |

### `ChaosScenario`

| Field | Meaning |
|---|---|
| `name` / `description` | What the scenario claims to test |
| `steps` | Ordered `ChaosScenarioStep[]` — `{ name, fault, waitMs, invariants? }` |
| `seed` | The reproducibility contract |
| `maxDurationMs` | Upper bound for the whole run |

---

## Documentation

- [`docs/api/chaos.md`](docs/api/chaos.md) — the fault types, the invariants, why invariants are checked during a step rather than after, and why a scenario's own decisions should draw from the same seeded stream

---

## License

MIT
