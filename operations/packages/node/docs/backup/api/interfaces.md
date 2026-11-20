# Backup Package API

## Interfaces

### `IBackupManager`

| Method | Return |
|---|---|
| `createBackup(options)` | `Promise<BackupResult>` |
| `listBackups(options?)` | `Promise<BackupMetadata[]>` |
| `getBackup(snapshotId)` | `Promise<BackupMetadata \| null>` |
| `deleteBackup(snapshotId)` | `Promise<boolean>` |
| `restoreFromSnapshot(snapshotId, options?)` | `Promise<RestoreResult>` |
| `pitr(target, options?)` | `Promise<RestoreResult>` |
| `prune()` | `Promise<number>` |

### `IPITRManager`

| Method | Return |
|---|---|
| `getCurrentLSN()` | `Promise<string>` |
| `getCurrentTimestamp()` | `Promise<string>` |
| `archiveCurrentWal()` | `Promise<void>` |
| `resolveTarget(target)` | `Promise<{ snapshotId, walEndLsn, approxTime }>` |
| `isEnabled()` | `boolean` |

### `IStorageBackend`

| Method | Return |
|---|---|
| `name` (property) | `string` |
| `upload(sourcePath, destKey)` | `Promise<void>` |
| `download(sourceKey, destPath)` | `Promise<void>` |
| `list(prefix)` | `Promise<Array<{ key, size, lastModified }>>` |
| `delete(key)` | `Promise<void>` |
| `health()` | `Promise<{ ok, message? }>` |
| `getUsageBytes()` | `Promise<number>` |

### `IBackupRetentionPolicy`

| Method | Return |
|---|---|
| `evaluate(snapshots)` | `BackupMetadata[]` |
| `getConfig()` | `RetentionPolicy` |
| `updateConfig(config)` | `void` |

## Implementations

- **`InMemoryBackupManager`** — Injected storage + retention. Map-based metadata store.
- **`InMemoryPITRManager`** — Simulated WAL LSN tracking.
- **`InMemoryStorageBackend`** — Map<string, Buffer> blob storage.
- **`RetentionPolicyEvaluator`** — ISO-8601 duration parsing, configurable rules.
