# @agentix-e/db-node/backup

**Backup orchestration that moves bytes, verifies them against the bucket, and refuses to call a restore successful before checking the digest.**

This package is the durability half of a single database node: take a consistent cut of an engine,
write it as an artefact the middleware can verify, upload it, confirm the bucket holds it, keep or
prune whole chains, and put it back — downloading, verifying, and only then handing the file to the
engine.

---

## What a backup is here

Four steps, and each of them exists because skipping it is a failure mode that a green test cannot
see:

```
  source.capture(staging)      a consistent cut, as one file on disk
          │
          ├─ stat + digest     what the bucket is about to hold
          ▼
  storage.upload(staging,key)  the bytes leave this machine
          │
          ├─ storage.list(key) the bucket says it has them, at that size
          ▼
  state = completed            only now is a snapshot a snapshot
```

`createBackup` resolves `success: true` **only after the bucket lists the object it just uploaded at
the size it reported**. Capture, digest and upload can each pass while the artefact is wrong — a
truncated upload is still a `200` from the storage service — so the confirmation is the step that
makes "the backup exists" a statement about the bucket rather than about the caller's intent.

A failed backup leaves **no metadata behind**. `listBackups()` never shows a snapshot that cannot be
restored, because a listing is what a recovery is planned from.

`sizeBytes` is a measurement, not a placeholder: it is the length of the artefact that was hashed and
uploaded. `fileCount` is what the source captured. `checksum` is the artefact's SHA-256. `facts`
carries what the engine said about the cut (`lsn`, `dir.files`, `dir.bytes`).

---

## Quick start

```ts
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from "@agentix-e/db-node/backup";

const backups = new BackupManager(
  new DirectoryBackupSource("/var/lib/db/data"), // the engine side: how a cut is taken
  new InMemoryStorageBackend(),                  // the bucket
  new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1_073_741_824 }),
);

const result = await backups.createBackup({ type: "full", tags: { env: "prod" } });
if (!result.success) throw new Error(result.error);

const metadata = await backups.getBackup(result.snapshot!.snapshotId);
console.log(`${metadata!.snapshotId}: ${metadata!.sizeBytes} bytes, ${metadata!.fileCount} files`);

const listed = await backups.listBackups({ type: "full" });
console.log(`${listed.length} full backup(s) available`);

const restored = await backups.restoreFromSnapshot(result.snapshot!.snapshotId);
if (!restored.success) throw new Error(restored.error);
```

The three collaborators are **positional and required** — where the bytes come from, where they go,
and what to keep. Each is an interface with more than one implementation and none has a sensible
default: a manager that quietly backed up to memory would be a manager whose backups are gone at the
next restart, and one that invented a retention policy would delete evidence nobody asked it to
delete.

---

## API Reference

### `BackupManager`

Implements `IBackupManager` — orchestration over an `IBackupSource`, an `IStorageBackend` and an
`IBackupRetentionPolicy`.

**Constructor:** `new BackupManager(source, storage, retention, options?)`

| Option | Default | Meaning |
|---|---|---|
| `prefix` | `"backups"` | Key prefix inside the bucket; the key is `${prefix}/${type}/${id}.artifact` |
| `workDir` | `os.tmpdir()` | Where the artefact is staged before upload and after download |
| `clock` | `() => new Date()` | Injectable so a test can name a timestamp instead of racing one |

| Method | Return | Description |
|---|---|---|
| `createBackup(options)` | `Promise<BackupResult>` | Capture → digest → upload → confirm |
| `listBackups(options?)` | `Promise<BackupMetadata[]>` | Newest first; filter by `type`, `newerThan`, `limit` |
| `getBackup(snapshotId)` | `Promise<BackupMetadata \| null>` | Metadata, or `null` |
| `deleteBackup(snapshotId)` | `Promise<boolean>` | Delete a snapshot **and every snapshot that cannot be replayed without it** |
| `restoreFromSnapshot(id, options?)` | `Promise<RestoreResult>` | Chain check → download → size → digest → engine |
| `pitr(target, options?)` | `Promise<RestoreResult>` | Resolve `snapshotId` / `targetTime` / `targetLsn`, then restore |
| `prune()` | `Promise<number>` | Apply the retention policy; returns what was actually deleted |

`workDir` is a real requirement, not a detail: the capture is written in full before a byte leaves
the machine, so a 200 GB database needs 200 GB of scratch space on the node taking the backup.

### `IBackupSource` — the one port the middleware cannot supply

Everything that is the same for every engine is in `BackupManager`. What differs is how a consistent
cut is taken and how it is put back:

| Member | Meaning |
|---|---|
| `name` | Stable identifier for logs, metrics and error messages |
| `capture(destination)` | Write a **consistent** cut to `destination`; report `bytes`, `files`, optional `facts` |
| `restore(source)` | **Replace** the engine's state with the verified artefact |

`capture` must not resolve with a partial artefact: the manager uploads exactly the file it named, so
a capture that resolves with half a database is a backup that cannot be restored. `restore` must
replace rather than merge — a merge leaves keys the snapshot never had, which is how a restored
replica diverges from the cluster it is about to rejoin — and a rejection means the engine's state is
unknown, so the caller must restore again rather than assume it still holds what it held before.

### `DirectoryBackupSource`

The reference `IBackupSource`, over one directory tree. Its `name` is `DIRECTORY_SOURCE_NAME`
(`"directory"`). It reports `facts` of `dir.files` and `dir.bytes` — the two numbers an operator
compares between backups, because a file count that fell is a table that stopped being included and
it is invisible in every other field.

It is deliberately not clever: no incremental capture, no hard links, no compression. Each of those
is a decision that belongs to the engine, which knows which pages changed and which files are
derivable. What this class must be is *correct*.

### `IStorageBackend`

| Method | Return | Description |
|---|---|---|
| `name` | `string` (property) | Backend identifier |
| `upload(sourcePath, destKey)` | `Promise<void>` | Upload a file |
| `download(sourceKey, destPath)` | `Promise<void>` | Download a file |
| `list(prefix)` | `Promise<Array<{ key, size, lastModified }>>` | List objects with a prefix |
| `delete(key)` | `Promise<void>` | Delete an object |
| `health()` | `Promise<{ ok, message? }>` | Accessibility probe |
| `getUsageBytes()` | `Promise<number>` | Total usage |

`InMemoryStorageBackend` keeps blobs in a `Map<string, Buffer>`; `S3StorageBackend` speaks S3 through
the optional peers `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` (see
[`api/production.md`](./api/production.md)).

`list` is load-bearing for `createBackup`, which uses it to confirm the object it just uploaded. A
backend whose `list` returns a stale or paginated view will produce backups that fail their
confirmation, which is the correct outcome: the manager refuses to record a snapshot the bucket
cannot answer for.

### `IBackupRetentionPolicy` and `RetentionPolicyEvaluator`

| Member | Return | Description |
|---|---|---|
| `evaluate(snapshots)` | `BackupMetadata[]` | The snapshots to delete |
| `evaluateWithOutcome(snapshots)` | `{ toDelete, unreclaimedBytes }` | The same, plus what the floors forbade reclaiming |
| `getConfig()` | `RetentionPolicy` | Current configuration |
| `updateConfig(config)` | `void` | Change it at runtime |

Four rules apply in order: keep the newest `maxFullSnapshots` **sets**, remove no set containing
anything younger than `keepRecent`, remove only sets whose every member is at least `minAge` old,
then remove whole sets, oldest base first, until the total fits under `maxTotalBytes`.
`parseDurationToMs` reads ISO-8601 durations (`P7D`, `PT1H`) and falls back to plain hours.

### `BackupVerifier`

A standalone verifier over a stream, for the scheduled drill that runs against a backup the manager
did not just create. `createBackup` hashes what it uploads, but "the bytes are what they were" and
"the engine can restore them" are two claims, and only a rehearsal tests the second.

### Types

| Type | Fields |
|---|---|
| `CreateBackupOptions` | `type: SnapshotType`, `tags?`, `timeoutMs?` |
| `ListBackupsOptions` | `type?`, `limit?`, `newerThan?` |
| `RestoreOptions` | `shardIds?`, `skipVerification?`, `timeoutMs?` |
| `SnapshotCapture` | `bytes`, `files`, `facts?` |
| `BackupManagerOptions` | `prefix?`, `workDir?`, `clock?` |
| `ArtifactManifest` | `version`, `dirs`, `files`, `totalBytes` |
| `ArtifactEntry` | `path`, `size`, `sha256` |
| `CaptureOutcome` | `bytes`, `files`, `sourceBytes`, `manifest` |
| `RestoreOutcome` | `files`, `bytes`, `dirs` |

---

## The artefact: `DBDIR1`

A backup is a file that has to survive a trip through a bucket, a tape and a decade. "The engine's own
format" is not something the middleware can verify, so a directory capture writes a container the
package can read:

```
DBDIR1\n
{"version":1,"dirs":["wal"],"files":[{"path":"wal/000001","size":12,"sha256":"…"}],"totalBytes":12}\n
<file 1 bytes><file 2 bytes>…
```

`dirs` lists subdirectories only — the root is implied — and both lists are sorted, so two captures of
one unchanged tree produce one manifest.

Three properties, each of which is why a line of this format looks the way it does:

1. **The manifest comes first.** A reader knows what the rest of the file must contain before reading
   any of it, so a truncated artefact is refused at the size it claims rather than discovered as a
   file that ends early.
2. **Every file carries its own digest.** A restore recomputes it while writing and refuses the file
   it is on, not the whole backup: "row 3 of this table is wrong" is an answer an operator can act
   on.
3. **The capture hashes twice** — once to build the manifest, once while copying. A file that changed
   in between was an engine that was not quiesced, and the capture fails instead of producing an
   artefact that restores a state no moment ever held.

The published pieces are the format's whole contract:

| Export | Meaning |
|---|---|
| `ARTIFACT_MAGIC` | `"DBDIR1"`, the first line of every artefact |
| `ARTIFACT_VERSION` | `1`, stored in the manifest as well as the magic |
| `MAX_MANIFEST_BYTES` | 64 MiB ceiling on the manifest a reader will assemble; a parameter of the read |
| `writeDirectoryArtifact` | Capture a tree to a path — returns a `CaptureOutcome` |
| `readDirectoryArtifact` | Restore a path into a tree — returns a `RestoreOutcome` |
| `hashFile` | `{ sha256, size }` for one file |
| `safeJoin` | Where a manifest path is allowed to land |
| `assertUnchanged` | The second half of the two-pass capture |

`safeJoin` is not defensive decoration. A manifest is data from a bucket, and a bucket is not a
trusted channel: an attacker who can upload a backup can put `../../etc/cron.d/x` in it, and a restore
that joined it blindly would write outside the engine's directory — which turns "restore this backup"
into "run this code". Absolute paths and any `..` segment are refused before a byte is written.
`MAX_MANIFEST_BYTES` exists for the same class of input: a corrupt header fails the read instead of
becoming an allocation.

---

## Restore, in the order the checks happen

```
chain check      is every snapshot this one needs still here?
download         the artefact is in workDir, not yet near the engine
size check       does it match the length the metadata recorded?
digest check     does it match the SHA-256 the metadata recorded?  (skipVerification opts out)
source.restore   only now does the engine see anything
```

Every check that can be made against the metadata happens **before** the engine is touched, because
the one thing a rejected restore must not have done is replace half of a healthy database with half of
a corrupt artefact.

An incremental can be replayed only on top of its whole chain, so a restore whose base is gone reports
`success: false` and names the missing link. `unrestorableReason` is the decision, `dependentsOf` is
the reverse lookup it uses, and `newestCompletedSnapshot` is how `createBackup` picks the parent of a
new incremental.

---

## Point-in-time recovery

Three ways to name a target, each answered by a comparison rather than an invention:

| Target | Resolves to |
|---|---|
| `snapshotId` | That snapshot |
| `targetTime` | The newest completed snapshot taken at or before it |
| `targetLsn` | The newest completed snapshot whose recorded `lsn` fact is at or before it |

`recoveryPoint` in the result is the position **reached**, not the target that was asked for. A caller
who wanted 12:30 and got 12:27 has to be able to see that in the answer.

A target that names nothing is refused: an empty `pitr({})` returns
`{ success: false, error: "the target names neither a time nor an LSN" }` rather than a recovery point
that was never compared to anything. An engine that records no `lsn` fact cannot satisfy `targetLsn`,
and saying so is the correct answer.

`compareLsn` parses `segment/offset` in hex, which is how PostgreSQL writes LSNs and how most engines
that speak "LSN" inherited the shape. Comparing those as strings puts `16/9` after `16/10`, and a
point-in-time target that resolves to the wrong snapshot is a restore to the wrong minute. Anything
without that shape falls back to string comparison, which is at least a total order.

---

## Retention: the unit is a chain, not a snapshot

Incrementals are chained through `parentSnapshotId`. Retention groups the inventory into **sets** — a
base plus every incremental that reaches it — and keeps or removes a set whole.

Pruning one snapshot at a time does two things, both wrong:

- it deletes a base and leaves its incrementals behind: bytes that are listed, counted against the
  quota, and impossible to restore;
- it stops as soon as the ceiling is met, so "reclaimed 250 GB" can mean "250 GB gone and 50 GB of it
  was the only copy that could still be read".

`expandDeletions(inventory, ids)` is the one place that turns a delete list into a set list; it keeps
the input order, skips a name it does not hold rather than throwing (a caller that raced another
delete gets the deletion it asked for), and both `deleteBackup` and `prune` go through it. `prune()`
returns **what was actually deleted**, so a policy that names a base and leaves its deltas reports two
and not one.

---

## Failure messages, and the two helpers that make them honest

Every failure names the step: `directory → backups/full/snap-…: the bucket lists … at 12 bytes, 4096
were uploaded`. The operator reading it has to choose between retrying, freeing space and calling the
storage team, and "backup failed" answers none of those.

`reason(error)` is one sentence for any thrown value. `removeQuietly(path)` deletes a staging file and
forgets its failure: staging files are removed in a `finally`, and a failure to remove one must not
replace the error already travelling to the caller — the operator needs the reason the backup failed,
not the reason the cleanup did.

Both are published as **functions** rather than inline blocks, and that is the point: a branch that
cannot be executed is a branch nobody checked, so each is a unit a test can reach with a real
filesystem it controls.

---

## What this package does not do

- **No incremental capture of an engine.** The chain and its retention are here; deciding which pages
  changed is the engine's job, behind `IBackupSource`.
- **No WAL archiving.** `IPITRManager` names the port; a deployment that wants continuous archiving
  supplies the archive and the `lsn` fact that makes `targetLsn` resolvable.
- **No encryption at rest.** Backups are bytes; put them in an encrypted bucket or have the source
  encrypt the artefact. A half-encrypted format nobody can verify is worse than either.
- **No unkeyed digest presented as a signature.** The artefact's SHA-256 detects an edit that was not
  followed by a recompute. An administrator who can rewrite the artefact *and* the metadata defeats
  it, and that limit is stated here rather than implied away.

---

## Testing

```bash
cd node
npx vitest run src/backup            # the module's own suite
pnpm coverage                        # whole package, per-dimension gates
```

---

## Dependencies

- `pino` (`^9.0.0`) — logging (runtime)
- `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` — **optional peers**, resolved on first use by
  `S3StorageBackend`
