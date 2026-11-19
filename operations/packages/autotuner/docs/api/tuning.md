# Auto-tuning

Configuration parameters that should follow the load — `shared_buffers`,
`work_mem`, `max_connections` — are the ones an operator sets once and then leaves
alone while the workload changes underneath. This package produces recommendations
for them and, if you let it, applies the ones it is confident about.

```ts
import { InMemoryAutoTuner, AutoTunerWorker } from "@agentix-e/db-operations-autotuner";

const tuner = new InMemoryAutoTuner();
tuner.configure({ learningRate: 0.1, minConfidence: 0.7 });

const worker = new AutoTunerWorker(tuner, { analysisIntervalMs: 60_000, minConfidence: 0.75 });
worker.feedMetrics({ cpu: 0.78, qps: 3_100, latency: 42 });
worker.start();
```

## `IAutoTuner`

| Implementation | What it is |
|---|---|
| `InMemoryAutoTuner` | The reference tuner: three rules over CPU, latency and QPS, each producing a recommendation with a fixed confidence. It has no memory between calls, which is why the worker owns the smoothing and the cooldown |
| `AutoTunerWorker` | The loop around any `IAutoTuner` |

| Member | Contract |
|---|---|
| `configure(config)` | `{ learningRate, minConfidence }`. The learning rate scales how far a recommendation moves a parameter |
| `analyze(metrics)` | Recommendations for the current metrics, or an empty array. Each carries `parameter`, `currentValue`, `recommendedValue`, `confidence` and the `reason` |
| `apply(recommendation)` | Records that the recommendation was applied. It changes no database: the caller owns the write |
| `getHistory()` | Every recommendation produced so far |

## `AutoTunerWorker`

The loop around the tuner: it smooths the metrics it is fed, decides when an
analysis is due, and applies what clears the confidence bar.

| Member | Contract |
|---|---|
| `constructor(tuner, config?)` | Wraps a tuner; defaults are in the table below |
| `feedMetrics(raw)` | Adds a sample. It is smoothed into the running average, not used raw |
| `getSmoothedMetrics()` | The EMA over the window, which is what an analysis sees |
| `runAnalysis()` | Analyses now, ignoring the interval. Returns **what it applied** — a recommendation blocked by the cooldown or by `maxRecommendations` is not in the array |
| `start()` / `stop()` | The interval |
| `feedbackEffect(parameter, metrics)` | Records what the metrics looked like after a parameter changed. This is the only input that can tell the tuner whether its last recommendation helped |
| `getAppliedHistory()` | `AppliedRecommendation[]`: parameter, when, old and new value, and the metrics before |

`AutoTunerWorkerConfig`:

| Field | Default | Meaning |
|---|---|---|
| `analysisIntervalMs` | 60 000 | How often `start()` analyses |
| `smoothingAlpha` | 0.3 | EMA weight for a new sample. Lower is smoother and slower |
| `cooldownMs` | 300 000 | How long before the same parameter may be re-tuned. Changing a parameter and measuring it need to be separated by more than the measurement window |
| `maxRecommendations` | 3 | Cap per cycle. Moving five parameters at once makes the next measurement unattributable |
| `metricWindowSize` | 10 | Samples the smoothed value is computed over |
| `minConfidence` | 0.7 | Threshold for auto-apply |

### Why smoothing, a cooldown and a cap are all required

A recommendation is a change to a running system, and every one of them costs a
measurement. Smoothing stops a single spike from being a recommendation. The
cooldown stops the tuner from re-deciding before the previous decision has been
measured — the window between a change and its effect is the one interval that must
be longer than the analysis interval, or the tuner is reacting to its own last
change. The cap keeps the next measurement attributable to a small number of
changes.

Without `feedbackEffect` the tuner has no way to learn whether a recommendation
helped: `learningRate` scales the move, but the direction of the next move comes
from the metric it is fed, not from the outcome of the last one.

## Not covered

No persistence: the history lives in the process. A deployment that restarts the
worker loses the cooldown state and may re-apply a recommendation it applied a
minute ago — which is why `getAppliedHistory()` exists to be shipped somewhere
durable by the caller.
