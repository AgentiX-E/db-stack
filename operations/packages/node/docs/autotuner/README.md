# @agentix-e/db-operations-node/autotuner

**Recommend configuration changes from the metrics a database is actually serving, and apply the ones that clear a confidence bar.**

The parameters an operator sets once — `shared_buffers`, `work_mem`, `max_connections` — are the ones that stop matching the workload. This package produces recommendations for them and, behind a worker, applies them with a cooldown.

---

## Features

- **Recommendations with a reason** — each carries `parameter`, `currentValue`, `recommendedValue`, `confidence` and `reason`
- **Smoothing, cooldown and a cap** — the three guards that make a change measurable rather than a guess
- **Feedback loop** — `feedbackEffect()` records the metrics after a parameter changed
- **Applied history** — what changed, when, and from which value to which

---

## Installation

```bash
npm install @agentix-e/db-operations-node
```

---

## Quick Start

```typescript
import { InMemoryAutoTuner, AutoTunerWorker } from '@agentix-e/db-operations-node/autotuner';

const tuner = new InMemoryAutoTuner();
tuner.configure({ learningRate: 0.1, minConfidence: 0.7 });

const worker = new AutoTunerWorker(tuner, { analysisIntervalMs: 60_000, minConfidence: 0.75 });
worker.feedMetrics({ cpu: 0.78, qps: 3_100, latency: 42 });
worker.start();
```

---

## API Reference

### `IAutoTuner`

| Member | Return | Description |
|---|---|---|
| `configure(config)` | `void` | `{ learningRate, minConfidence }` |
| `analyze(metrics)` | `Promise<TuningRecommendation[]>` | Recommendations for the current metrics |
| `apply(recommendation)` | `Promise<void>` | Records that a recommendation was applied; the caller owns the database write |
| `getHistory()` | `TuningRecommendation[]` | Every recommendation produced |

### `AutoTunerWorker`

| Member | Return | Description |
|---|---|---|
| `constructor(tuner, config?)` | — | Wraps any `IAutoTuner` |
| `feedMetrics(raw)` | `void` | Adds a sample, smoothed into the running average |
| `getSmoothedMetrics()` | `AutoScalerMetrics` | The EMA over the window |
| `runAnalysis()` | `Promise<TuningRecommendation[]>` | Analyses now; **returns what it applied** |
| `start()` / `stop()` | `void` | The analysis interval |
| `feedbackEffect(parameter, metrics)` | `void` | Records the metrics after a change |
| `getAppliedHistory()` | `AppliedRecommendation[]` | Parameter, timestamp, old and new value, metrics before |

### `AutoTunerWorkerConfig`

| Field | Default | Meaning |
|---|---|---|
| `analysisIntervalMs` | 60 000 | How often `start()` analyses |
| `smoothingAlpha` | 0.3 | EMA weight for a new sample |
| `cooldownMs` | 300 000 | How long before the same parameter may be re-tuned |
| `maxRecommendations` | 3 | Cap per cycle |
| `metricWindowSize` | 10 | Samples the smoothed value is computed over |
| `minConfidence` | 0.7 | Threshold for auto-apply |

---

## Documentation

- [`docs/api/tuning.md`](docs/api/tuning.md) — why smoothing, a cooldown and a cap are all required, and what the worker loses on restart

---

## License

MIT
