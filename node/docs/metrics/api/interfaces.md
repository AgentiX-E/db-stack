# Metrics Package API

## Interfaces

### `ICounter`

| Method | Return | Description |
|---|---|---|
| `inc()` | `void` | Increment by 1 |
| `incBy(value)` | `void` | Increment by value (≥0) |
| `reset()` | `void` | Reset to zero |
| `get()` | `number` | Current value |

### `IGauge`

| Method | Return |
|---|---|
| `set(value)` | `void` |
| `inc()` | `void` |
| `dec()` | `void` |
| `add(value)` | `void` |
| `get()` | `number` |

### `IHistogram`

| Method | Return |
|---|---|
| `observe(value)` | `void` |
| `getCount()` | `number` |
| `getSum()` | `number` |
| `getQuantile(p)` | `number \| undefined` |
| `reset()` | `void` |

### `IMetricsRegistry`

| Method | Return |
|---|---|
| `counter(name, labels?)` | `ICounter` |
| `gauge(name, labels?)` | `IGauge` |
| `histogram(name, labels?, buckets?)` | `IHistogram` |
| `snapshot()` | `MetricsSnapshot` |

## Implementations

- **`MetricsRegistry`** — In-memory registry. Singleton metric instances per name+labels.
