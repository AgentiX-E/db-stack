# @agentix-e/db-operations-node/autoscaler

**Decide how many nodes a database should be running, from five metrics, a policy and a cooldown.**

`evaluate(metrics)` returns a `ScaleAction` or `null`. It does not touch the database — applying the decision belongs to whatever owns the fleet.

---

## Features

- **Two implementations** — `InMemoryAutoScaler` (two thresholds) and `PredictiveScalingEngine` (a full `ScalingPolicy`)
- **Multi-metric targets** — CPU, memory, QPS per node, p95 latency, connections per node
- **Independent cooldowns** — scaling up and scaling down have separate windows, because the cost of changing your mind is asymmetric
- **Oscillation guard** — `overProvisionFactor` lands a scale-up far enough below the target that the inverse action does not fire immediately
- **Predictive mode** — a linear regression over the recent window, with a `confidence` on the action
- **Emergency override** — `forceScale()` bypasses cooldown, limits and the evaluation interval

---

## Installation

```bash
npm install @agentix-e/db-operations-node
```

---

## Quick Start

```typescript
import { PredictiveScalingEngine } from '@agentix-e/db-operations-node/autoscaler';

const scaler = new PredictiveScalingEngine({
  minNodes: 2,
  maxNodes: 12,
  cpuTarget: 0.65,
  predictiveScaling: true,
  overProvisionFactor: 1.2,
});

const action = await scaler.evaluate({
  cpu: 0.82,
  qps: 4_200,
  latencyP95: 63,
  connectionCount: 180,
  currentNodeCount: 4,
});

if (action) await applyTo(engine, action.amount, action.action);
```

---

## API Reference

### `IAutoScaler`

| Member | Return | Description |
|---|---|---|
| `evaluate(metrics)` | `Promise<ScaleAction \| null>` | A decision, or `null` when no action is warranted |
| `forceScale(direction, amount, reason)` | `Promise<ScaleAction>` | Bypasses cooldown and limits; recorded like any other action |
| `registerPolicy(policy)` / `getPolicy()` | `void` / `ScalingPolicy \| null` | One policy at a time |
| `getHistory()` | `ScalingEvent[]` | Every action with the metrics that produced it |
| `getStats()` | `ScalingStats` | Counts, current and peak node counts, average interval, prediction accuracy |
| `getCooldownState()` | `CooldownState` | Epoch ms for each boundary |
| `reset()` | `void` | Clears history, counters and cooldowns |

### `ScalingPolicy` — the fields that change behaviour

| Field | Meaning |
|---|---|
| `minNodes` / `maxNodes` | Hard bounds; only `forceScale` goes past them |
| `cpuTarget` / `memoryTarget` / `qpsPerNode` / `latencyThresholdMs` / `connectionsPerNode` | Per-metric targets; an omitted target is not evaluated |
| `strategy` | `aggressive`, `conservative`, `cost_optimized`, `custom` |
| `scaleUpCooldownMs` / `scaleDownCooldownMs` | Independent windows |
| `evaluationIntervalMs` | Minimum gap between decisions |
| `predictiveScaling` / `predictionWindow` | Project the trend over `predictionWindow` samples (minimum 3) |
| `overProvisionFactor` | How far past the computed target a scale-up lands |

---

## Documentation

- [`docs/api/scaling.md`](docs/api/scaling.md) — the oscillation failure the cooldown and the over-provision factor each prevent half of, and what `predictiveScaling` does not claim

---

## License

MIT
