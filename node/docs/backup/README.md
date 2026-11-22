# @agentix-e/db-node/backup

**Backup orchestration that moves bytes, verifies them against the bucket, and refuses to call a restore successful before checking the digest.**

This package is the durability half of a single database node: take a consistent cut of an engine,
write it as an artefact the middleware can verify, upload it, confirm the bucket holds it, keep or
prune whole chains, and put it back — downloading, verifying, and only then handing the file to the
engine.

---

## What a backup is here

Five steps, and each of them exists because skipping it is a failure mode that a green test cannot
see:

```
  source.capture(staging)             a consistent cut, as one file on disk
          │
          ├─ stat + digest            what the bucket is about to hold
          ▼
  storage.upload(staging, key)        the bytes leave this machine
          │
          ├─ storage.list(key)        the bucket says it has them, at that size
          ▼
  storage.upload(record, recordKey)   the snapshot gets a name in the bucket
          │
          ├─ storage.list(recordKey)  and the bucket answers for that too
          ▼
  state = completed                   only now is a snapshot a snapshot
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

A confirmation the bucket does not give is **undone**: the artefact, and the record if it was written,
are deleted before the failure is returned. A caller told `success: false` must not be able to find a
snapshot afterwards — an answer and a bucket that disagree is worse than a retry.

---

## Where the snapshot list comes from

The bucket. Not this instance's memory.

```
  backups/inventory/snap-mwqdj2y-4-9c9fd229.json    one immutable record per snapshot
  backups/full/snap-mwqdj2y-4-9c9fd229.artifact     the bytes the record names
```

Every public method starts by listing that directory, so `listBackups()`, `getBackup()`, `prune()` and
`restoreFromSnapshot()` are answers about the bucket rather than about what this process remembers
doing. The read is single-flight — a burst of concurrent calls costs one listing — and it reconciles
in both directions: a record that is gone is a snapshot that is gone (wherever it was deleted from),
and a record this instance has never seen is a snapshot another worker took. A record rewritten in
place is noticed too, because the listing's own `size` and `lastModified` are compared against what was
read.

This is what makes a backup outlive the process that took it. The class this package shipped before
iteration 63 kept its snapshots in a `Map`, so a restarted manager answered `not found` for a snapshot
the same binary had written an hour earlier — the artefact verified, the digest verified, and nothing
could name either.

One record per snapshot, rather than one manifest for the bucket, because a manifest is a
read-modify-write: two workers taking backups at the same time would each read it, each add their
entry, and the second write would erase the first. A key derived from the snapshot id cannot collide,
and a record is never rewritten.

### The record format

One JSON object, `INVENTORY_FORMAT` (`db-node/backup/inventory/v1`), read and written by
`parseRecord` and `serializeRecord`:

```json
{
  "format": "db-node/backup/inventory/v1",
  "snapshot": {
    "snapshotId": "snap-mwqdj2y-4-9c9fd229",
    "type": "full",
    "state": "completed",
    "createdAt": "2026-11-21T12:20:43.987Z",
    "completedAt": "2026-11-21T12:20:43.988Z",
    "sizeBytes": 4096,
    "fileCount": 2,
    "location": "backups/full/snap-mwqdj2y-4-9c9fd229.artifact",
    "checksum": "017338cd…",
    "facts": { "dir.files": "2", "dir.bytes": "17" }
  }
}
```

`inventoryKey(prefix, id)` and `inventoryPrefix(prefix)` are how the name is built, so a script that
has to read a bucket without this package does not have to guess. `parseRecord` validates field by
field — every field is used by some decision (`facts` by `targetLsn`, `createdAt` by `targetTime`,
`location` by a restore) — and refuses a record whose `snapshotId` disagrees with the key it came
from.

A record that cannot be read is **reported, not thrown**: one damaged kilobyte must not stop every
backup in the deployment. `manager.inventoryProblems()` answers `InventoryProblem[]` — `{ key, reason }`
— the reason being the reader's own words, and the snapshot it described is simply not in the listing:
it cannot be restored, and pretending otherwise is how an operator plans a recovery around a snapshot
that is not there. The reader raises `InventoryRecordError`, which carries the key it was reading and
the field that failed, so the message an operator sees is the message they can act on.

Records are not signed. They carry the artefact's SHA-256, so a corrupted record makes a restore fail
the digest check rather than succeed against the wrong bytes; an actor who can rewrite the record can
also rewrite the digest. Same limit as the audit trail's chain, stated rather than implied.

---

## The bytes no record names

Deleting a snapshot removes the record first and the artefact second, on purpose: a record whose
artefact is gone is a listing entry that cannot be restored, and the listing is what a recovery is
planned from. The price of that order is the state this section is about — a delete that fails between
the two steps leaves an object no record names. It is invisible to `listBackups()`, costs money, cannot
be restored, and until `reconcile()` existed it could only be found by listing the bucket by hand and
comparing it with the inventory.

`manager.reconcile()` is that comparison, and it answers three lists plus a count:

```ts
const report = await backups.reconcile();
// { orphaned: [...], inFlight: [...], missing: [...], reclaimed: 0 }
```

| Field | What it holds | What to do |
|---|---|---|
| `orphaned` | Objects under the prefix that no record names, older than the grace window | reclaim them, or leave them to a bucket lifecycle rule |
| `inFlight` | The same, younger than the grace window | nothing — this is a backup being taken |
| `missing` | Records whose artefact the bucket does not hold | look at them: a listing that names a snapshot nobody can restore |
| `reclaimed` | How many objects were deleted — `0` unless `reclaim: true` | reconcile with what the bucket now holds |

The split between `orphaned` and `inFlight` is the whole safety argument. `createBackup()` uploads the
artefact and *then* writes its record, so for the length of one confirmation there is an object that
nothing names — and it is the backup the caller is waiting for. Age is the only thing that separates the
two states: `RECONCILE_GRACE_MS` (ten minutes) is longer than any confirmation and far shorter than a
retention cycle. `{ graceMs }` overrides it, and an object whose `lastModified` cannot be parsed is
treated as in flight — an age that cannot be read is not a verdict about age. The age is measured
against the manager's own clock, the one `createBackup()` stamped the record with, so an object exactly
`graceMs` old is garbage and one a millisecond younger is still a backup being taken.

The report is about **this** manager's prefix and nothing else: a bucket shared with another deployment
— a second cluster, a warehouse of restored copies — keeps its objects out of the report, and out of
`reclaim`'s reach.

**Nothing is deleted unless `reclaim: true` is passed.** That default is the point: a listing can be
stale — a bucket behind a cache, a replica that has not caught up — and a stale listing makes a record
look absent. An object that merely *looks* unnamed is one delete away from being a backup nobody has.
With `reclaim: true`, only `orphaned` is touched, one key at a time; a delete that fails leaves the
object for the next run, and `reclaimed` counts what is actually gone rather than what was named.

**A record names its artefact two ways, and both are honoured.** The `location` it carries is what a
restore downloads, so an object under the prefix whose name is not one this build writes — a bucket
migrated from an earlier version, artefacts copied under another suffix — is protected by the record
that points at it. The id in the record's *key* is the second way, and it needs no parsing at all:
that is what protects the artefact of a record this process could not read, because a damaged record is
a snapshot an operator has to be able to look at rather than a licence to delete bytes. `artifactIdOf`
reads an id out of a name of the shape `backups/full/<id>.artifact`; an object whose name is not one
this package writes and which no record points at is reported with `snapshotId: null` rather than
guessed at.

Both halves of the report are sorted by key — code-unit order, the same on every machine and in every
locale — so two runs against two backends that hold the same objects produce the same report, and a
diff of two reconciles shows what changed rather than what the listing order happened to be.

---

## Quick start

```ts
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-node/backup';

const backups = new BackupManager(
  new DirectoryBackupSource('/var/lib/db/data'), // the engine side: how a cut is taken
  new InMemoryStorageBackend(), // the bucket
  new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1_073_741_824 }),
);

const result = await backups.createBackup({ type: 'full', tags: { env: 'prod' } });
if (!result.success) throw new Error(result.error);

const metadata = await backups.getBackup(result.snapshot!.snapshotId);
console.log(`${metadata!.snapshotId}: ${metadata!.sizeBytes} bytes, ${metadata!.fileCount} files`);

const listed = await backups.listBackups({ type: 'full' });
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

| Option    | Default            | Meaning                                                                     |
| --------- | ------------------ | --------------------------------------------------------------------------- |
| `prefix`  | `"backups"`        | Key prefix inside the bucket; the key is `${prefix}/${type}/${id}.artifact` |
| `workDir` | `os.tmpdir()`      | Where the artefact is staged before upload and after download               |
| `clock`   | `() => new Date()` | Injectable so a test can name a timestamp instead of racing one             |

| Method                              | Return                            | Description                                                                 |
| ----------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `createBackup(options)`             | `Promise<BackupResult>`           | Capture → digest → upload → confirm                                         |
| `listBackups(options?)`             | `Promise<BackupMetadata[]>`       | Newest first; filter by `type`, `newerThan`, `limit`                        |
| `getBackup(snapshotId)`             | `Promise<BackupMetadata \| null>` | Metadata, or `null`                                                         |
| `deleteBackup(snapshotId)`          | `Promise<boolean>`                | Delete a snapshot **and every snapshot that cannot be replayed without it** |
| `restoreFromSnapshot(id, options?)` | `Promise<RestoreResult>`          | Chain check → download → size → digest → engine                             |
| `pitr(target, options?)`            | `Promise<RestoreResult>`          | Resolve `snapshotId` / `targetTime` / `targetLsn`, then restore             |
| `prune()`                           | `Promise<number>`                 | Apply the retention policy; returns what was actually deleted               |

`workDir` is a real requirement, not a detail: the capture is written in full before a byte leaves
the machine, so a 200 GB database needs 200 GB of scratch space on the node taking the backup.

### `IBackupSource` — the one port the middleware cannot supply

Everything that is the same for every engine is in `BackupManager`. What differs is how a consistent
cut is taken and how it is put back:

| Member                 | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `name`                 | Stable identifier for logs, metrics and error messages                                 |
| `whole`                | `true` when every artefact this source captures is a complete copy of the engine        |
| `capture(destination)` | Write a **consistent** cut to `destination`; report `bytes`, `files`, optional `facts` |
| `restore(source)`      | **Replace** the engine's state with the verified artefact                              |
| `restoreChain(chain)`  | **Rebuild** the engine's state from every artefact in `chain`, oldest first            |

`capture` must not resolve with a partial artefact: the manager uploads exactly the file it named, so
a capture that resolves with half a database is a backup that cannot be restored. `restore` must
replace rather than merge — a merge leaves keys the snapshot never had, which is how a restored
replica diverges from the cluster it is about to rejoin — and a rejection means the engine's state is
unknown, so the caller must restore again rather than assume it still holds what it held before.

**A source must say which of the two things it is**, and the manager will not guess:

| Declaration            | What the manager does with a chain of three              |
| ---------------------- | -------------------------------------------------------- |
| `whole: true`          | Downloads and verifies the **newest** artefact, restores |
| `restoreChain` defined | Downloads and verifies **all three**, hands over a chain |
| neither                | Refuses, naming the count and the source                 |

The third row is the point of the table. A source that declares nothing may be capturing deltas, and
handing it the newest artefact would write a fragment over a data directory and then report success —
the one failure mode that looks like a recovery. A refusal is what that source can act on. If a
source declares both, `whole` wins: a whole-capture engine needs no chain, and the ones above it are
history.

`restoreChain` receives paths that have already been downloaded and verified, in **genealogical**
order — base first, the target last — and never a skipped link, because a skipped delta is a state
that never existed. It is optional and mandatory only for a source that captures deltas.

### `DirectoryBackupSource`

The reference `IBackupSource`, over one directory tree. Its `name` is `DIRECTORY_SOURCE_NAME`
(`"directory"`). It reports `facts` of `dir.files` and `dir.bytes` — the two numbers an operator
compares between backups, because a file count that fell is a table that stopped being included and
it is invisible in every other field.

It is deliberately not clever: no incremental capture, no hard links, no compression. Each of those
is a decision that belongs to the engine, which knows which pages changed and which files are
derivable. What this class must be is _correct_.

Because every capture is the whole tree, it declares `whole: true` — so a restore of the newest
snapshot of a three-snapshot chain downloads one artefact, not three. That is a statement about this
class rather than a default: an engine whose `capture` writes a delta has to say so by defining
`restoreChain` instead, and a source that says neither is refused a chain by name.

### `IStorageBackend`

| Method                          | Return                                        | Description                |
| ------------------------------- | --------------------------------------------- | -------------------------- |
| `name`                          | `string` (property)                           | Backend identifier         |
| `upload(sourcePath, destKey)`   | `Promise<void>`                               | Upload a file              |
| `download(sourceKey, destPath)` | `Promise<void>`                               | Download a file            |
| `list(prefix)`                  | `Promise<Array<{ key, size, lastModified }>>` | List objects with a prefix |
| `delete(key)`                   | `Promise<void>`                               | Delete an object           |
| `health()`                      | `Promise<{ ok, message? }>`                   | Accessibility probe        |
| `getUsageBytes()`               | `Promise<number>`                             | Total usage                |

Three backends ship: `InMemoryStorageBackend` keeps blobs in a `Map<string, Buffer>` (tests and
simulation — its objects are gone when the process is), `FileSystemStorageBackend` is a directory
(an NFS mount, a SAN volume, a backup host's disk), and `S3StorageBackend` speaks S3 through the
optional peers `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` (see
[`api/production.md`](./api/production.md)).

`FileSystemStorageBackend` writes every object to `<key>${PARTIAL_SUFFIX}` and renames it into place,
so an object either exists whole or does not exist — a process killed mid-copy leaves a file `list`
does not return, rather than an object at the right key with the wrong length. Every key goes through
`safeJoin`, which refuses `..` and absolute paths: a bucket is an interface, and the next
implementation of it may be handed anything. Its root is resolved at construction, so a relative one
cannot be re-interpreted against a `process.cwd()` that another part of the process changed.

`list` is load-bearing for `createBackup`, which uses it to confirm the object it just uploaded. A
backend whose `list` returns a stale or paginated view will produce backups that fail their
confirmation, which is the correct outcome: the manager refuses to record a snapshot the bucket
cannot answer for.

### `IBackupRetentionPolicy` and `RetentionPolicyEvaluator`

| Member                           | Return                           | Description                                       |
| -------------------------------- | -------------------------------- | ------------------------------------------------- |
| `evaluate(snapshots)`            | `BackupMetadata[]`               | The snapshots to delete                           |
| `evaluateWithOutcome(snapshots)` | `{ toDelete, unreclaimedBytes }` | The same, plus what the floors forbade reclaiming |
| `getConfig()`                    | `RetentionPolicy`                | Current configuration                             |
| `updateConfig(config)`           | `void`                           | Change it at runtime                              |

Four rules apply in order: keep the newest `maxFullSnapshots` **sets**, remove no set containing
anything younger than `keepRecent`, remove only sets whose every member is at least `minAge` old,
then remove whole sets, oldest base first, until the total fits under `maxTotalBytes`.
`parseDurationToMs` reads ISO-8601 durations (`P7D`, `PT1H`) and falls back to plain hours.

### `BackupVerifier`

A standalone verifier over a stream, for the scheduled drill that runs against a backup the manager
did not just create. `createBackup` hashes what it uploads, but "the bytes are what they were" and
"the engine can restore them" are two claims, and only a rehearsal tests the second.

### Types

| Type                   | Fields                                         |
| ---------------------- | ---------------------------------------------- |
| `CreateBackupOptions`  | `type: SnapshotType`, `tags?`, `timeoutMs?`    |
| `ListBackupsOptions`   | `type?`, `limit?`, `newerThan?`                |
| `RestoreOptions`       | `shardIds?`, `skipVerification?`, `timeoutMs?` |
| `SnapshotCapture`      | `bytes`, `files`, `facts?`                     |
| `BackupManagerOptions` | `prefix?`, `workDir?`, `clock?`                |
| `ArtifactManifest`     | `version`, `dirs`, `files`, `totalBytes`       |
| `ArtifactEntry`        | `path`, `size`, `sha256`                       |
| `CaptureOutcome`       | `bytes`, `files`, `sourceBytes`, `manifest`    |
| `RestoreOutcome`       | `files`, `bytes`, `dirs`                       |

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

| Export                   | Meaning                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `ARTIFACT_MAGIC`         | `"DBDIR1"`, the first line of every artefact                                   |
| `ARTIFACT_VERSION`       | `1`, stored in the manifest as well as the magic                               |
| `MAX_MANIFEST_BYTES`     | 64 MiB ceiling on the manifest a reader will assemble; a parameter of the read |
| `writeDirectoryArtifact` | Capture a tree to a path — returns a `CaptureOutcome`                          |
| `readDirectoryArtifact`  | Restore a path into a tree — returns a `RestoreOutcome`                        |
| `hashFile`               | `{ sha256, size }` for one file                                                |
| `safeJoin`               | Where a manifest path is allowed to land                                       |
| `assertUnchanged`        | The second half of the two-pass capture                                        |

`safeJoin` is not defensive decoration. A manifest is data from a bucket, and a bucket is not a
trusted channel: an attacker who can upload a backup can put `../../etc/cron.d/x` in it, and a restore
that joined it blindly would write outside the engine's directory — which turns "restore this backup"
into "run this code". Absolute paths and any `..` segment are refused before a byte is written.
`MAX_MANIFEST_BYTES` exists for the same class of input: a corrupt header fails the read instead of
becoming an allocation.

---

## Restore, in the order the checks happen

```
chain check      is every snapshot this one needs still here, and with what?
                 └─ a chain of N reaching a source that declares neither
                    a whole capture nor a chain replay is refused here, by name
download         every artefact the plan needs is in workDir, none near the engine
size check       does each one match the length the metadata recorded?
digest check     does each one match the SHA-256 the metadata recorded?  (skipVerification opts out)
source.restore   only now does the engine see anything — one artefact, or the whole chain
```

Every check that can be made against the metadata happens **before** the engine is touched, because
the one thing a rejected restore must not have done is replace half of a healthy database with half of
a corrupt artefact.

### A chain is replayed, not assumed away

An incremental can be replayed only on top of its whole chain. The inventory has always been able to
say which ancestors those are; what `restoreFromSnapshot` did with that answer was hand the source a
**single** artefact and call it a restore. For the reference source that is correct — a directory
capture is a whole tree, so the newest artefact is a complete state — and for a source that captures
deltas it is a fragment written over a data directory, reported as a success. That is the one failure
mode worse than a refusal, because it looks like a recovery.

`resolveChain` answers both questions in one walk — *may this be replayed*, and *with what* — so the
check and the replay cannot disagree about which set of artefacts is being discussed. Then the source
decides the shape:

| Source                 | What a chain of three becomes                                       |
| ---------------------- | ------------------------------------------------------------------- |
| `whole: true`          | one artefact downloaded, verified and restored                      |
| `restoreChain` defined | all three downloaded, verified and handed over oldest first          |
| neither                | `success: false`, naming the count and the source                   |

`artefacts` in the result says how many were downloaded and verified, so a caller can see whether it
had one file to apply or three.

The order is genealogical, not alphabetical and not whatever order the bucket listed: the walk starts
at the target and collects parents, so the delivered chain is base → delta → delta → target. `pitr`
reaches the same code by construction, because both of its answers end in `restoreFromSnapshot` — the
replay lives in one place rather than in each caller.

A refusal here is not a defect in the chain: the chain is fine, and a source that can act on it will
be handed it. The refusal says which capability is missing, which is the only thing a deployment can
change.

---

## Point-in-time recovery

Three ways to name a target, each answered by a comparison rather than an invention:

| Target       | Resolves to                                                                |
| ------------ | -------------------------------------------------------------------------- |
| `snapshotId` | That snapshot                                                              |
| `targetTime` | The newest completed snapshot taken at or before it                        |
| `targetLsn`  | The newest completed snapshot whose recorded `lsn` fact is at or before it |

`recoveryPoint` in the result is the position **reached**, not the target that was asked for. A caller
who wanted 12:30 and got 12:27 has to be able to see that in the answer.

**"Newest" is not "first in the listing".** Two incrementals taken inside one millisecond share a
`createdAt`, and two snapshots that recorded the same `lsn` are exactly as close; a plain sort decides
those by the order the bucket happened to return, which puts the *older* candidate first — so a target
would resolve to the base of a chain whose head is also at that instant, and be reported as the
recovery point. Ties are broken by **depth** (how many artefacts it takes to replay the snapshot), and
then by id so the answer is total and does not depend on the listing at all.

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
  followed by a recompute. An administrator who can rewrite the artefact _and_ the metadata defeats
  it, and that limit is stated here rather than implied away.
- **No sweep for orphaned objects.** Deleting a snapshot removes its record first and its artefact
  second, so a delete that fails half way leaves bytes no record names. That is deliberate — the
  alternative is a listing entry that cannot be restored — and reclaiming those bytes is a bucket
  lifecycle rule's job, not a manager's. A record whose object is gone is the opposite case and is
  caught at restore time by the size and digest checks.
- **No streaming capture.** An artefact is written whole before a byte leaves the machine, because the
  digest has to exist before the upload does. `workDir` therefore needs room for one artefact.

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
