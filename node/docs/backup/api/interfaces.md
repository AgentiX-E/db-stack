# Backup package API

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

`deleteBackup` and `prune` remove **sets**: naming a base removes every snapshot that cannot be replayed
without it, and `prune()` answers with the count that actually went.

### `IBackupSource`

The engine port — the one thing the middleware cannot implement for a database.

| Member | Return |
|---|---|
| `name` (property) | `string` |
| `capture(destination)` | `Promise<SnapshotCapture>` |
| `restore(source)` | `Promise<void>` |

`capture` must produce a consistent cut (quiesced, or taken from the engine's own snapshot) and must not
resolve with a partial artefact. `restore` replaces the engine's state and, when it rejects, leaves that
state unknown — so the caller restores again rather than assuming the previous contents survived.

`SnapshotCapture` is `{ bytes, files, facts? }`. `facts` is where an engine records `lsn` or a schema
version; `targetLsn` PITR is resolved by comparing them.

### `IPITRManager`

The continuous-archiving port. `BackupManager` performs PITR against the snapshots it holds; a deployment
that wants WAL replay supplies an implementation of this alongside its archive.

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

`list` is not decorative: `createBackup` reads it after `upload` and refuses to record a snapshot the
bucket does not list at the size that was sent.

### `IBackupRetentionPolicy`

| Method | Return |
|---|---|
| `evaluate(snapshots)` | `BackupMetadata[]` |
| `getConfig()` | `RetentionPolicy` |
| `updateConfig(config)` | `void` |

`RetentionPolicyEvaluator` adds `evaluateWithOutcome(snapshots)` →
`{ toDelete, unreclaimedBytes }`, because a policy that cannot meet `maxTotalBytes` without breaking a
floor has to say so rather than silently return fewer deletions.

## Implementations

- **`BackupManager`** — capture → digest → upload → confirm → `completed`. Injected source, storage and
  retention, all positional.
- **`DirectoryBackupSource`** — the reference `IBackupSource`; `name` is `DIRECTORY_SOURCE_NAME`.
- **`InMemoryStorageBackend`** — `Map<string, Buffer>` blobs, for tests and for a node with no bucket.
- **`S3StorageBackend`** — S3 through optional peer dependencies, resolved on first use.
- **`RetentionPolicyEvaluator`** — ISO-8601 durations via `parseDurationToMs`, set-aware rules.
- **`BackupVerifier`** — digest verification over a buffer or a stream, for the scheduled drill.

## Format and helper functions

| Export | Purpose |
|---|---|
| `ARTIFACT_MAGIC`, `ARTIFACT_VERSION` | `"DBDIR1"` and `1` — the container's identity |
| `MAX_MANIFEST_BYTES` | 64 MiB ceiling on a manifest a reader will assemble |
| `writeDirectoryArtifact`, `readDirectoryArtifact` | Capture and restore a tree through the container |
| `hashFile` | `{ sha256, size }` for one file |
| `safeJoin` | Refuses `..` and absolute manifest paths |
| `assertUnchanged` | The second half of the two-pass capture |
| `compareLsn` | `segment/offset` hex ordering, not string ordering |
| `expandDeletions`, `dependentsOf` | Turn a delete list into a set list |
| `newestCompletedSnapshot`, `unrestorableReason` | Parent selection and chain refusal |
| `reason`, `removeQuietly` | One sentence for any thrown value; a cleanup that cannot mask it |

## What is no longer published

`InMemoryBackupManager` and `InMemoryPITRManager` were removed rather than deprecated. The first
recorded `sizeBytes: 1024` after a timer and answered a restore without touching anything; the second
returned a recovery point it invented. A package that ships a simulator under the name "backup" is a
package whose documents are about its interfaces.
