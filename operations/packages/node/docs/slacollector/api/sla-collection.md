# SLA collection

Records observations against thresholds and answers the two questions an SLA
report asks: *what fraction of samples met the threshold*, and *when did they
not*.

```ts
import { InMemorySLACollector } from "@agentix-e/db-operations-node/slacollector";

const sla = new InMemorySLACollector();
sla.record({ timestamp: new Date(), metric: "query_p99_ms", value: 41, threshold: 50 });

sla.getSLACompliance();                 // Map { "query_p99_ms" => 100 }
sla.getViolations(since);               // the samples that missed
```

## `ISLACollector`

`InMemorySLACollector` is the only implementation, and it is complete rather than
a fixture: recording a sample and counting violations needs no external system, and
the retention question is answered by the caller (see below).

| Member | Contract |
|---|---|
| `record(event)` | Stores one sample. `violated` is computed, never supplied: `value > threshold` |
| `getSLACompliance(since?)` | `Map<metric, percentage>` over the samples at or after `since`. A metric with no samples in the window does not appear — nothing was observed is not the same as 100 % |
| `getViolations(since?)` | The samples that missed, in insertion order |
| `getUptime(since?)` | Percentage of samples with no violation, across every metric. An empty window reports **100** — the same value `getSLACompliance` would compute for a metric it has seen, and the one a report expects for a quiet period |
| `SLAEvent` | `{ timestamp, metric, value, threshold, violated }` |

Two details that decide whether the number means anything:

- **Violation is strict.** `value > threshold` — a sample exactly at the threshold
  passes, which is what an SLO stated as "p99 under 50 ms" means.
- **Compliance is per metric, not global.** A collector that averaged across
  metrics would report a healthy database whose one violated metric is averaged
  away by the nine that are fine.

## Storage

The events are held in an array. This is a *collector*, not a time-series
database: a deployment that needs a retention window either prunes by passing
`since` to every read, or drains `getViolations()` into its metrics pipeline and
constructs a fresh collector. There is no eviction policy here, because a policy
that silently dropped samples would make the compliance percentage describe a
window nobody declared.
