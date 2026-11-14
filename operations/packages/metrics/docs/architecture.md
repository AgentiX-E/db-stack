# Architecture

## Position in the Framework

The metrics package provides **observability primitives** used by higher-level packages like `monitor` and `observability`. It depends on `core` for shared metric types.

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-metrics                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐     │
│  │ ICounter │ │  IGauge  │ │   IHistogram          │     │
│  └──────────┘ └──────────┘ └──────────────────────┘     │
│  ┌──────────────────────────────────────────────────┐    │
│  │             IMetricsRegistry                      │    │
│  │   counter() | gauge() | histogram() | snapshot() │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │             MetricsRegistry (Impl)                │    │
│  └──────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Prometheus-compatible semantics** — Counters cannot decrement, gauges are up/down, histograms measure distributions. Familiar to anyone who uses Prometheus.

2. **Dimensional labels** — Metric name + label pairs uniquely identify a metric instance. `counter('queries', { db: 'main' })` and `counter('queries', { db: 'shard1' })` are separate counters.

3. **Singleton per key** — Calling `counter('name', labels)` twice with the same arguments returns the same instance, enabling safe concurrent access from different parts of the codebase.

4. **Snapshot isolation** — `snapshot()` returns a point-in-time copy, not a live reference. Snapshots are safe to serialize or cache.

## Label Canonicalization

Labels are sorted alphabetically and serialized to a canonical string for key derivation:

```
Labels: { "db": "main", "host": "node1" }
→ Canonical key: "db=main,host=node1"
→ Map key: "queries_total:db=main,host=node1"
```

This ensures deterministic key derivation regardless of insertion order.

## Snapshot Format

When `snapshot()` is called:

- **Counters** → One `MetricPoint` with type `'counter'`, current value, labels, and timestamp
- **Gauges** → One `MetricPoint` with type `'gauge'`
- **Histograms** → Two `MetricPoint` entries (both typed `'gauge'`):
  - `<name>_count` — Number of observations
  - `<name>_sum` — Sum of observed values
