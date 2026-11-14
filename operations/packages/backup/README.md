# @agentix-e/db-operations-backup

**Backup orchestration, point-in-time recovery (PITR), pluggable storage backends, and retention policy evaluation for database engines.**

This package provides a complete backup and restore abstraction. Components can create snapshots (full/incremental/logical), restore from any snapshot, perform point-in-time recovery to a specific timestamp or LSN, store backup data on any backend (local FS, S3, GCS, etc.), and prune old backups according to configurable retention policies.

---

## Features

- **Backup orchestration** — Create, list, get, delete, and restore from backup snapshots
- **Point-in-time recovery** — Resolve targets by timestamp or WAL/LSN position, archive WAL segments
- **Pluggable storage** — `IStorageBackend` abstraction supports any storage (local, S3, GCS, Azure Blob)
- **Retention policy** — Configurable rules for max full snapshots, max total size, min age, and keep-recent window
- **All in-memory** — All implementations work in-memory for testing and simulation

---

## Installation

```bash
npm install @agentix-e/db-operations-backup
```

---

## Quick Start

```typescript
import {
  InMemoryBackupManager,
  InMemoryStorageBackend,
  InMemoryPITRManager,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-operations-backup';

// Create storage, retention, and backup manager
const storage = new InMemoryStorageBackend();
const retention = new RetentionPolicyEvaluator({
  maxFullSnapshots: 3,
  maxTotalBytes: 1_073_741_824, // 1 GB
  minAge: 'P1D',                 // 1 day
  keepRecent: 'P7D',             // keep 7 days regardless
});
const backup = new InMemoryBackupManager(storage, retention);

// Create a full backup
const result = await backup.createBackup({ type: 'full', tags: { env: 'prod' } });
console.log(`Created snapshot: ${result.snapshot?.snapshotId}`);

// List all backups
const backups = await backup.listBackups({ type: 'full' });
console.log(`${backups.length} full backup(s) available`);

// Restore from a specific snapshot
const restoreResult = await backup.restoreFromSnapshot(result.snapshot!.snapshotId);
console.log(`Restore ${restoreResult.success ? 'succeeded' : 'failed'}`);
```

---

## API Reference

### Interfaces

#### `IBackupManager`

Top-level backup orchestration.

| Method | Return | Description |
|---|---|---|
| `createBackup(options)` | `Promise<BackupResult>` | Create a backup snapshot |
| `listBackups(options?)` | `Promise<BackupMetadata[]>` | List available snapshots |
| `getBackup(snapshotId)` | `Promise<BackupMetadata \| null>` | Get snapshot metadata |
| `deleteBackup(snapshotId)` | `Promise<boolean>` | Delete a snapshot |
| `restoreFromSnapshot(snapshotId, options?)` | `Promise<RestoreResult>` | Restore from a snapshot |
| `pitr(target, options?)` | `Promise<RestoreResult>` | Point-in-time recovery |
| `prune()` | `Promise<number>` | Prune old backups per retention policy |

#### `IPITRManager`

Point-in-time recovery manager.

| Method | Return | Description |
|---|---|---|
| `getCurrentLSN()` | `Promise<string>` | Get current WAL position |
| `getCurrentTimestamp()` | `Promise<string>` | Get current WAL timestamp |
| `archiveCurrentWal()` | `Promise<void>` | Archive current WAL segment |
| `resolveTarget(target)` | `Promise<{ snapshotId, walEndLsn, approxTime }>` | Resolve PITR target |
| `isEnabled()` | `boolean` | Check if PITR is operational |

#### `IStorageBackend`

Pluggable storage backend.

| Method | Return | Description |
|---|---|---|
| `name` | `string` (property) | Backend identifier |
| `upload(sourcePath, destKey)` | `Promise<void>` | Upload file to storage |
| `download(sourceKey, destPath)` | `Promise<void>` | Download file from storage |
| `list(prefix)` | `Promise<Array<{ key, size, lastModified }>>` | List objects with prefix |
| `delete(key)` | `Promise<void>` | Delete an object |
| `health()` | `Promise<{ ok, message? }>` | Check backend accessibility |
| `getUsageBytes()` | `Promise<number>` | Get total storage usage |

#### `IBackupRetentionPolicy`

Retention policy evaluation.

| Method | Return | Description |
|---|---|---|
| `evaluate(snapshots)` | `BackupMetadata[]` | Return snapshots to delete |
| `getConfig()` | `RetentionPolicy` | Get policy configuration |
| `updateConfig(config)` | `void` | Update policy at runtime |

### Types

| Type | Fields |
|---|---|
| `CreateBackupOptions` | `type: SnapshotType, tags?, timeoutMs?` |
| `ListBackupsOptions` | `type?, limit?, newerThan?` |
| `RestoreOptions` | `shardIds?, skipVerification?, timeoutMs?` |

---

## Implementations

### `InMemoryBackupManager`

Implements `IBackupManager`. Uses injected `IStorageBackend` and `IBackupRetentionPolicy`. Stores snapshot metadata in a `Map<string, BackupMetadata>`.

- Creates unique snapshot IDs (`snap-{timestamp}-{seq}`)
- Simulates async work delay on backup creation
- Restore always succeeds for registered snapshots

### `InMemoryPITRManager`

Implements `IPITRManager`. Tracks a simulated WAL LSN string. All operations are no-op/simulated.

**Constructor:** `new InMemoryPITRManager(walLsn?, enabled?)`

### `InMemoryStorageBackend`

Implements `IStorageBackend`. Stores blobs in a `Map<string, Buffer>`. Supports `upload` (reads from filesystem for testing) and `download` (writes to filesystem).

**Important:** `upload()` requires a real file path — it reads via `fs.readFile`. For pure in-memory testing, use `list()` and direct writes to the map.

### `RetentionPolicyEvaluator`

Implements `IBackupRetentionPolicy`. Configurable retention rules:
1. Keep first `maxFullSnapshots` full snapshots (newest first)
2. Skip snapshots younger than `keepRecent`
3. Skip snapshots newer than `minAge`
4. Enforce `maxTotalBytes` by deleting oldest snapshots

Supports ISO-8601 duration strings (`P7D`, `PT1H`, `PT30M`, `PT30S`) with a fallback to plain hours.

---

## Usage Examples

### Full Backup Rotation

```typescript
import {
  InMemoryBackupManager,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-operations-backup';

const storage = new InMemoryStorageBackend();
const retention = new RetentionPolicyEvaluator({
  maxFullSnapshots: 3,
  maxTotalBytes: 500_000_000, // 500 MB
});
const backupMgr = new InMemoryBackupManager(storage, retention);

// Create several backups
for (let i = 0; i < 5; i++) {
  await backupMgr.createBackup({ type: 'full' });
  await sleep(10); // ensure different timestamps
}

// Prune old backups
const pruned = await backupMgr.prune();
console.log(`Pruned ${pruned} backup(s)`);

// Check remaining
const remaining = await backupMgr.listBackups();
console.log(`${remaining.length} backup(s) remaining`);
```

### Point-in-Time Recovery

```typescript
import { InMemoryBackupManager, InMemoryStorageBackend, RetentionPolicyEvaluator, InMemoryPITRManager } from '@agentix-e/db-operations-backup';

const storage = new InMemoryStorageBackend();
const retention = new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1e9 });
const backupMgr = new InMemoryBackupManager(storage, retention);
const pitr = new InMemoryPITRManager('0/1A2B3C', true);

// Perform PITR to a specific time
const result = await backupMgr.pitr({
  targetTime: '2026-07-12T10:00:00Z',
});
console.log(result); // { success: true, durationMs: 20, recoveryPoint: '2026-07-12T10:00:00Z' }
```

---

## Testing

```bash
cd packages/backup
npm test
npm run test:watch
```

---

## Dependencies

- `pino` (`^9.0.0`) — Logging (runtime dependency)
