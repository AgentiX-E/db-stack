# Health Package API

## Interfaces

### `IHealthProbe`

| Method | Return |
|---|---|
| `liveness()` | `ProbeResult` |
| `readiness()` | `ProbeResult` |
| `startup()` | `ProbeResult` |
| `probeId` (property) | `string` |
| `componentName` (property) | `string` |

### `IComponentRegistrar`

| Method | Return |
|---|---|
| `registerComponent(probe, options?)` | `void` |
| `unregisterComponent(probeId)` | `void` |
| `hasComponent(probeId)` | `boolean` |
| `getComponentHealth()` | `ComponentHealth[]` |
| `getAggregateStatus()` | `{ status, count }` |

### `IHealthOrchestrator` (extends `IComponentRegistrar`)

| Method | Return |
|---|---|
| `liveness()` | `{ ok, errors }` |
| `readiness()` | `{ ok, errors }` |
| `startup()` | `{ ok, errors }` |
| `getHealthStatus()` | `HealthStatus` |
| `getSummary()` | `string` |

## Implementations

- **`HealthOrchestrator`** — Full orchestrator with component registry and functional probe registration via `registerFunctional()`
- **`componentProbe()`** — Factory creating `IHealthProbe` from callback functions
