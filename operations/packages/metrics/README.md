# @agentix-e/db-operations-metrics

**Prometheus-inspired metrics registry with counter, gauge, and histogram primitives for database engine operations.**

This package provides an engine-agnostic metrics system where components can create and update metric primitives (counters, gauges, histograms) with dimensional labels, then export a full snapshot at any time. The in-memory implementation is suitable for both development and production use, with an API designed for easy adaptation to Prometheus client or OpenTelemetry backends.

---

## Features

- **Three metric primitives** — `ICounter` (monotonically increasing), `IGauge` (up/down values), `IHistogram` (distribution of values)
- **Dimensional labels** — All metrics support optional key-value label pairs for multi-dimensional analysis
- **Snapshot export** — `snapshot()` returns a `MetricsSnapshot` with all current values, labels, and timestamps
- **Collision-free naming** — Same metric name + labels returns the same instance (singleton per registry)
- **Testability** — Full `reset()` support on all primitives enabling clean test isolation
- **Quantile approximation** — Histograms provide approximate quantile calculations from observed values

---

## Installation

```bash
npm install @agentix-e/db-operations-metrics
```

---

## Quick Start

```typescript
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';

const metrics = new MetricsRegistry();

// Create and use a counter
const queryCount = metrics.counter('queries_total', { db: 'main' });
queryCount.inc();
queryCount.incBy(5);
console.log(queryCount.get()); // 6

// Create a gauge
const activeConns = metrics.gauge('connections_active');
activeConns.set(42);
activeConns.inc();
activeConns.dec();
console.log(activeConns.get()); // 42

// Create a histogram for latencies
const queryLatency = metrics.histogram('query_duration_ms', { db: 'main' }, [1, 5, 10, 50, 100]);
queryLatency.observe(3.5);
queryLatency.observe(12.0);
queryLatency.observe(45.2);
console.log(queryLatency.getCount()); // 3
console.log(queryLatency.getQuantile(0.5)); // ~12.0 (median)

// Export snapshot
const snapshot = metrics.snapshot();
console.log(`Captured ${snapshot.points.length} metric points`);
```

---

## API Reference

### Interfaces

#### `ICounter`

Monotonically increasing counter.

| Method | Return | Description |
|---|---|---|
| `inc()` | `void` | Increment by 1 |
| `incBy(value)` | `void` | Increment by an arbitrary non-negative value |
| `reset()` | `void` | Reset to zero |
| `get()` | `number` | Get current value |

**Throws:** `Error` if `incBy()` receives a negative value.

#### `IGauge`

Up/down gauge value.

| Method | Return | Description |
|---|---|---|
| `set(value)` | `void` | Set to an absolute value |
| `inc()` | `void` | Increment by 1 |
| `dec()` | `void` | Decrement by 1 |
| `add(value)` | `void` | Add arbitrary value (can be negative) |
| `get()` | `number` | Get current value |

#### `IHistogram`

Distribution of observed values.

| Method | Return | Description |
|---|---|---|
| `observe(value)` | `void` | Observe a value (adds to the distribution) |
| `getCount()` | `number` | Number of observations |
| `getSum()` | `number` | Sum of all observed values |
| `getQuantile(p)` | `number \| undefined` | Approximate quantile (0.0–1.0), returns `undefined` if no observations |
| `reset()` | `void` | Clear all observations |

#### `IMetricsRegistry`

Metrics registry — creates and manages metric instances.

| Method | Return | Description |
|---|---|---|
| `counter(name, labels?)` | `ICounter` | Create or retrieve a counter |
| `gauge(name, labels?)` | `IGauge` | Create or retrieve a gauge |
| `histogram(name, labels?, buckets?)` | `IHistogram` | Create or retrieve a histogram |
| `snapshot()` | `MetricsSnapshot` | Snapshot of all current values |

**Parameters:**
- `name` — Metric name in `snake_case` convention
- `labels` — Optional `Record<string, string>` for dimensional analysis
- `buckets` — Optional `number[]` for histogram bucket boundaries

---

## Implementation

### `MetricsRegistry`

In-memory implementation of `IMetricsRegistry`.

**Constructor:** No parameters.

**Implementation details:**
- Metrics are stored in internal `Map`s keyed by `name:canonicalLabels`
- Labels are canonicalized by sorting keys alphabetically
- `snapshot()` emits histogram count and sum as separate points (`<name>_count` and `<name>_sum`)
- **Not thread-optimized** for ultra-high throughput (>1M ops/s)

---

## Usage Examples

### Request-Level Metrics

```typescript
const metrics = new MetricsRegistry();

function handleRequest(method: string, path: string) {
  const timer = metrics.histogram('http_request_duration_ms', { method, path });
  const start = Date.now();

  try {
    // ... handle request ...
    metrics.counter('http_requests_total', { method, path, status: '200' }).inc();
  } catch (err) {
    metrics.counter('http_requests_total', { method, path, status: '500' }).inc();
  } finally {
    timer.observe(Date.now() - start);
  }
}
```

### Prometheus Export Adapter

```typescript
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';

export function snapshotToPrometheus(snapshot: MetricsSnapshot): string {
  let output = '';

  for (const point of snapshot.points) {
    const labels = point.labels.map(({ key, value }) => `${key}="${value}"`);
    const labelStr = labels.length > 0 ? `{${labels.join(',')}}` : '';
    output += `${point.name}${labelStr} ${point.value} ${point.timestamp}\n`;
  }

  return output;
}
```

---

## Testing

```bash
cd packages/metrics
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Provides `MetricsSnapshot`, `MetricPoint`, `MetricType` type definitions
