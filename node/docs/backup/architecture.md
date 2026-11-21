# Architecture

## Position in the framework

`backup` is the **durability** module of a single node. It depends on `core` for the snapshot types and
on nothing else in the package: a backup manager that needed the health registry and the metric registry
to take a backup would be a manager nobody could run during an incident.

```
┌──────────────────────────────────────────────────────────────┐
│                     db-node/backup                           │
│                                                              │
│   BackupManager ────────► IBackupSource         (engine port)│
│        │      ──────────► IStorageBackend       (the bucket) │
│        │      ──────────► IBackupRetentionPolicy (what stays)│
│        │                                                     │
│        ├─ backupArtifact   DBDIR1 container it wrote itself  │
│        ├─ backupChain      sets: a base and what reaches it  │
│        └─ BackupVerifier   the scheduled drill               │
├──────────────────────────────────────────────────────────────┤
│  Dependencies: @agentix-e/db-node/core (types), pino          │
│  Optional peers: @aws-sdk/client-s3, @aws-sdk/lib-storage     │
└──────────────────────────────────────────────────────────────┘
```

## Why the engine is a port and the rest is not

A `pg_basebackup`, a SQLite `VACUUM INTO`, an LSM checkpoint and a `cp -a` of a data directory have
almost nothing in common — except that each produces a cut of some state, and each can be told to
replace that state with one. That is exactly `IBackupSource`, and it is the only part of a backup the
middleware cannot supply.

Everything around it _is_ the same for every engine, and putting it here is the whole reason this module
exists:

- the artefact's container format and per-file digests,
- the confirmation that the bucket lists what was uploaded,
- the chain rules that make an incremental restorable or refuse it,
- the retention rules that treat a chain as one unit,
- the failure taxonomy an operator triages.

An engine that reimplemented those would get them subtly wrong in the same three places every time: it
would trust `upload` resolving, it would delete a base and keep its deltas, and it would call a restore
successful without checking the digest.

## The lifecycle, as it actually is

```
createBackup
  capture ──► stat vs reported bytes ──► sha256 ──► upload ──► list(key)? size?
          ──► write record ──► list(record)? size? ──► completed
     │
     └─ any failure ──► success: false; anything uploaded is taken back

restoreFromSnapshot
  inventory ──► chain ──► download ──► size ──► digest ──► source.restore
```

`BackupMetadata.state` is `pending | in-progress | completed | failed | expired`. `in-progress` is the
state of the object the manager is building; a `BackupManager` never stores it, so `listBackups()` cannot
show a snapshot that is still being written.

There is no `verifying`/`verified` state, and that is a decision rather than an omission: verification is
not a phase a snapshot passes through once. It is a claim that decays — the object can be corrupted in
the bucket a year later — so it is an operation (`BackupVerifier`) run on a schedule, not a flag stored
at creation time.

## The inventory: one record per snapshot, in the bucket

```
backups/inventory/<snapshotId>.json   immutable, one per snapshot
backups/<type>/<snapshotId>.artifact  the bytes the record names
```

The manager holds a `Map` of what it has read, and the map is a **cache of a listing**, not the
inventory. Every public method starts with one listing of the record prefix (single-flight, so a
concurrent burst shares it) and reconciles both ways: a record that is gone takes its snapshot with
it, and a record the instance has never seen is added. A snapshot whose record is missing from the
listing is therefore gone after a delete that happened in another process, and one taken by another
worker appears without a restart.

Why per-snapshot records instead of one bucket manifest:

- **a manifest is a read-modify-write.** Two workers reading it, each adding an entry, and the second
  write erases the first — a lost snapshot under a green test.
- **a key derived from the id cannot collide**, and nothing ever rewrites a record, so the listing's
  `size` and `lastModified` are also a version: a record changed in place is detected by comparing them
  against what was last read, and re-read.

The two failures are handled in opposite directions on purpose:

| Failure                     | Answer                                                                      | Why                                                                                  |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| record present, object gone | restore refuses at the size check                                           | a listing entry that cannot be restored is caught at the only moment it matters      |
| record unreadable           | `inventoryProblems()` reports `{ key, reason }`, the snapshot is not listed | one damaged kilobyte must not stop every backup; an operator needs to see it         |
| object present, no record   | invisible                                                                   | bytes are not a backup until something says they are; a lifecycle rule reclaims them |

The record is written **after** the artefact and confirmed the same way. That ordering is the whole
difference between "a crash leaves nothing announced" and "a crash leaves a snapshot that cannot be
restored": in the window between the two uploads, a killed process leaves an artefact no listing
mentions, which is the state a person can clean up.

## Retention: why the unit is a set

```
inventory:    [base-a, inc-a1, inc-a2, base-b]
policy names: [base-a]
expandDeletions → [base-a, inc-a1, inc-a2]     one unit, removed together
prune() returns 3                              what was deleted, not what was named
```

A policy that could return `[base-a]` and have the manager delete only that would produce bytes that are
listed, billed, and impossible to replay. The expansion lives in one function so that `deleteBackup` and
`prune` cannot disagree about it.

Age is a property of the **base**, because a delta is only as new as the chain it can be replayed on. A
floor on any member protects the whole set: keeping an incremental and deleting its base is the same bug
as above, one step later.

## The artefact format

`DBDIR1` — magic line, JSON manifest, then the bytes. Three properties carry the weight:

1. **Manifest first**, so a truncated file is refused at the size it claims rather than discovered as a
   file that ends early.
2. **Per-file digests**, so corruption is localised to a path an operator can name.
3. **Two-pass capture** (hash, then copy-and-rehash), so a moving target fails the capture instead of
   producing an artefact that restores a state no moment ever held.

Two inputs are treated as hostile: a manifest path (`safeJoin` refuses absolute paths and any `..`) and a
manifest length (`MAX_MANIFEST_BYTES` caps the assembly, because a bucket can return something that is
not a manifest at all).

## Failure taxonomy

| Where                   | What the operator reads                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| capture                 | `<source> → <key>: <reason from the engine>`                              |
| size disagreement       | `directory reported 4096 bytes but wrote 31`                              |
| upload / confirmation   | `the bucket does not list <key> after the upload`                         |
| wrong size in bucket    | `the bucket lists <key> at 12 bytes, 4096 were uploaded`                  |
| restore, missing base   | `incremental <id> cannot be replayed: its base <id> is gone`              |
| restore, corrupt        | `the artefact does not match the snapshot's digest (a1b2c3… ≠ d4e5f6…)`   |
| pitr, no target         | `the target names neither a time nor an LSN`                              |
| pitr, nothing before it | `no snapshot at or before LSN 16/10 (3 completed snapshot(s) considered)` |

Each names the step and the object, because the reader has to choose between retrying, freeing space and
calling the storage team — and "backup failed" answers none of those.
