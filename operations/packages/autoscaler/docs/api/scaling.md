# Auto-scaling

Two implementations of `IAutoScaler`, and the difference between them is the
whole feature.

| Class | What it decides from |
|---|---|
| `InMemoryAutoScaler` | Two thresholds and a node range: `configure(min, max, scaleUpThreshold, scaleDownThreshold)`. Cooldowns are zero until a policy is registered, so `evaluate()` always reflects the current metrics |
| `PredictiveScalingEngine` | A `ScalingPolicy`: five metrics, strategies, independent cooldowns, an evaluation interval, and a linear-regression projection over recent samples |

`InMemoryAutoScaler` is the reference implementation a test can drive — *above
0.8, add a node* — and `PredictiveScalingEngine` is what a deployment runs.

```ts
import { PredictiveScalingEngine } from "@agentix-e/db-operations-autoscaler";

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

## `IAutoScaler`

| Member | Contract |
|---|---|
| `evaluate(metrics)` | A decision, or **`null` when no action is warranted** — inside the evaluation interval, inside a cooldown, or within targets. `null` is the common answer and not a failure |
| `forceScale(direction, amount, reason)` | Bypasses cooldown, limits and the interval. Records the action like any other, with the reason carried into it |
| `registerPolicy(policy)` / `getPolicy()` | One policy at a time. Registering replaces the previous one and resets the derived state |
| `getHistory()` | Every action with the metrics that produced it and the cooldown state after it |
| `getStats()` | Counts, current and peak node counts, average evaluation interval, prediction accuracy |
| `getCooldownState()` | `{ scaleUpUntil, scaleDownUntil, lastEvaluationAt }` as epoch ms |
| `reset()` | Clears history, counters and cooldowns |

## The policy

| Field | Meaning |
|---|---|
| `minNodes` / `maxNodes` | Hard bounds. `forceScale` is the only path past them |
| `cpuTarget` / `memoryTarget` / `qpsPerNode` / `latencyThresholdMs` / `connectionsPerNode` | Per-metric targets. A target that is omitted is not evaluated |
| `strategy` | `aggressive`, `conservative`, `cost_optimized` or `custom`. It decides how far past the target a metric must be before the scaler acts |
| `scaleUpCooldownMs` / `scaleDownCooldownMs` | Independent, because the cost of changing your mind is asymmetric: scaling up and back down twice in a minute is a loop, scaling down slowly is caution |
| `evaluationIntervalMs` | Minimum gap between decisions. Without it a metric that oscillates across the target produces one action per sample |
| `predictiveScaling` / `predictionWindow` | Project the trend over the last `predictionWindow` samples (minimum 3) rather than reacting to the current value |
| `overProvisionFactor` | How far past the computed target a scale-up lands. `1.2` adds 20 %, which is what stops a system from arriving at exactly the load it just left |

### Cooldowns are the oscillation guard

The failure this prevents is a real one: at `cpu: 0.66` with a target of `0.65`,
scaling out drops `cpu` to `0.34`, which is below the scale-down threshold, which
removes the node, which puts `cpu` back at `0.66`. Independent cooldowns make each
half of that loop cost a configured interval; `overProvisionFactor` makes the first
half land far enough below the target that the second does not fire immediately.
Neither is sufficient alone.

### What `predictiveScaling` does and does not claim

A linear regression over the window, evaluated at the next interval. It is not a
forecaster: it extends a straight line, so a metric that turns a corner is
predicted wrong, and `confidence` on the action is lower the noisier the window is.
A deployment whose load has a daily shape gets more from the interval and the
cooldown than from the projection.

## Applying a decision

`evaluate` returns a decision; it does not touch the database. `action.amount` is a
node count delta and `action.targetCount` is where the scaler believes it will end
up — a belief it maintains from `metrics.currentNodeCount` when supplied, and from
its own history otherwise. A caller that supplies `currentNodeCount` on every
sample keeps that belief true; one that does not is asking the scaler to remember,
which it does only for actions it took itself.
