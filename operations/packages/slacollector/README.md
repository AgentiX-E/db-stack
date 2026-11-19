# @agentix-e/db-operations-slacollector

**Record service-level observations against thresholds, then answer the two questions an SLA report asks.**

*What fraction of samples met the threshold*, and *when did they not*. Compliance is reported per metric, because an average across a violated metric and nine healthy ones hides the one that matters.

---

## Features

- **Computed violations** — `violated` is derived (`value > threshold`), never supplied by the caller
- **Per-metric compliance** — a `Map<metric, percentage>`, not one global number
- **Violation log** — the samples that missed, in insertion order
- **Windowed reads** — every query takes an optional `since`
- **Zero dependencies**

---

## Installation

```bash
npm install @agentix-e/db-operations-slacollector
```

---

## Quick Start

```typescript
import { InMemorySLACollector } from '@agentix-e/db-operations-slacollector';

const sla = new InMemorySLACollector();
sla.record({ timestamp: new Date(), metric: 'query_p99_ms', value: 41, threshold: 50 });
sla.record({ timestamp: new Date(), metric: 'query_p99_ms', value: 88, threshold: 50 });

sla.getSLACompliance();  // Map { 'query_p99_ms' => 50 }
sla.getViolations();     // the sample that recorded 88 ms
sla.getUptime();         // 50
```

---

## API Reference

### `ISLACollector`

| Member | Return | Description |
|---|---|---|
| `record(event)` | `void` | Stores one sample; computes `violated` |
| `getSLACompliance(since?)` | `Map<string, number>` | Percentage per metric. A metric with no samples in the window does not appear |
| `getViolations(since?)` | `SLAEvent[]` | The samples that missed, in insertion order |
| `getUptime(since?)` | `number` | Percentage of samples with no violation across every metric; `100` for an empty window |

### `SLAEvent`

| Field | Type |
|---|---|
| `timestamp` | `Date` |
| `metric` | `string` |
| `value` | `number` |
| `threshold` | `number` |
| `violated` | `boolean` (computed) |

---

## Documentation

- [`docs/api/sla-collection.md`](docs/api/sla-collection.md) — the strict-inequality rule, why compliance is per metric, and the retention decision left to the caller

---

## License

MIT
