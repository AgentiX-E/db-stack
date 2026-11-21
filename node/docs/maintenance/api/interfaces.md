# Maintenance Package API

## Interfaces

### `IMaintenanceExecutor`

| Method | Return |
|---|---|
| `vacuum(options)` | `Promise<MaintenanceResult>` |
| `analyze(options)` | `Promise<MaintenanceResult>` |
| `reindex(options)` | `Promise<MaintenanceResult>` |
| `getStorageStats(target)` | `Promise<StorageStats>` |
| `getIndexFragmentation(target)` | `Promise<IndexFragmentation[]>` |
| `getAutoVacuumStatus()` | `{ enabled, threshold }` |

## Options Types

### `VacuumOptions`

| Field | Type | Default |
|---|---|---|
| `target` | `string` | required |
| `full` | `boolean` | `false` |
| `dryRun` | `boolean` | `false` |
| `timeoutMs` | `number` | undefined |

### `AnalyzeOptions`

| Field | Type |
|---|---|
| `target` | `string` |
| `dryRun` | `boolean` |
| `timeoutMs` | `number` |

### `ReindexOptions`

| Field | Type | Default |
|---|---|---|
| `target` | `string` | required |
| `isTable` | `boolean` | `false` |
| `dryRun` | `boolean` | `false` |
| `timeoutMs` | `number` | undefined |

## Implementations

- **`InMemoryMaintenanceExecutor`** — Simulates storage compaction, fragmentation reduction. Configurable initial stats.
- **`NoopMaintenanceExecutor`** — Returns success with 0ms. Fixed/empty stats.
