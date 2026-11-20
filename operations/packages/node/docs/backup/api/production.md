# Production pieces

Four things a deployment needs that the interfaces do not describe: how a backup
is verified, where it is stored, which snapshots depend on which, and how a
retention duration is written.

## Verification

### `BackupVerifier`

Computes a SHA-256 over a backup and compares it bit-exactly against what the
manifest claims.

```ts
import { BackupVerifier } from "@agentix-e/db-operations-node/backup";

const verifier = new BackupVerifier();
const result = await verifier.verify(snapshot.snapshotId, bytes, {
  expectedChecksum: snapshot.checksum,
});

if (!result.valid) throw new Error(`backup ${snapshot.snapshotId}: ${result.error}`);
```

| Member | Contract |
|---|---|
| `verify(backupId, data, options?)` | Hashes `data` in pieces and compares the digest. `valid` is false when the checksum differs, and `error` says so. Remembers the digest so `getStoredChecksum(backupId)` can answer later |
| `verifyStream(data, options?)` | The same over an `AsyncIterable<Buffer>`, so a backup larger than memory is never held in it. `chunkCount` is the number of pieces the iterable produced |
| `calculateChecksum(data)` | The digest alone, when a caller wants to store it |

`VerifyOptions`:

| Field | Default | Meaning |
|---|---|---|
| `expectedChecksum` | — | Hex SHA-256. Compared bit-exactly when supplied; omitting it makes this a checksum computation rather than a verification |
| `chunkSize` | 64 KB | Size of the pieces the digest is updated with. It changes how many `hash.update` calls a verification makes and therefore `chunkCount` — **not** the digest, because SHA-256 over a byte sequence does not depend on where the sequence was cut. A non-positive or fractional value is refused |

`VerifyResult` carries `valid`, `computedChecksum`, the expected value when one was
supplied, `totalSize`, `chunkCount`, `durationMs` and `error`.

There is no `cleanup` option. One was declared — *"whether temporary data is
deleted after verification"* — and read by no branch, because nothing here creates
temporary data. It was deleted rather than documented: a flag the caller can set
and cannot observe is a promise about a mechanism that does not exist.

## Storage

### `S3StorageBackend`

An `IStorageBackend` over AWS S3 or anything that speaks its API (MinIO, Ceph,
DigitalOcean Spaces).

```ts
const backend = new S3StorageBackend({
  bucket: "db-backups",
  region: "eu-central-1",
  endpoint: "http://minio.internal:9000",
  forcePathStyle: true,       // required for MinIO
  sse: "kms",
  sseKmsKeyId: "alias/db-backups",
});
```

`S3StorageBackendConfig`:

| Field | Default | Meaning |
|---|---|---|
| `bucket` | — | Required |
| `region` | — | Required by the SDK even for MinIO |
| `endpoint` | AWS | Point at an S3-compatible store |
| `accessKeyId` / `secretAccessKey` | SDK chain | Omit to use the ambient credentials (instance role, `AWS_PROFILE`) |
| `keyPrefix` | — | Prefix every object, e.g. `"backups/production/"` |
| `multipartThreshold` | 10 MB | Above this a backup is uploaded in parts |
| `partSize` | 5 MB | Part size; S3 requires ≥ 5 MB for all but the last |
| `sse` | — | `"s3"`, `"kms"` or `"c"` |
| `sseKmsKeyId` | — | Required when `sse` is `"kms"` |
| `sseCustomerKey` | — | Base64 key, required when `sse` is `"c"` |
| `forcePathStyle` | `false` | Required for MinIO |
| connect/request timeouts | SDK | Milliseconds |

A multipart upload is aborted on failure rather than left incomplete: an
incomplete upload is billed storage that no listing shows and no restore can use.

**The SDK is an optional peer.** `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`
are in `peerDependencies` with `optional: true`, because a deployment that backs
up to a filesystem should not carry them, and because the umbrella entry point
re-exports this module: a static import would have made both mandatory for every
consumer of `@agentix-e/db-operations-node`. Install them where the backup target
runs:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

The import is resolved on first use, so constructing the backend costs nothing and
never touches the SDK. A request made without it is refused with a message naming
both packages and that command — `health()` returns `{ ok: false }` with the same
sentence rather than throwing, so a readiness probe reports the missing peer the
way it reports any other unreachable target.

## The backup chain

An incremental stores only what changed since the snapshot named by
`parentSnapshotId`, so it is replayable only on top of that snapshot — which is in
turn replayable only on top of its own parent. Three pure functions over an
inventory keep that true. They are functions rather than manager methods because
they must agree with what a *policy* does, and because malformed metadata (a
self-reference, a cycle, a parent that was never stored) has to be testable
without concurrency in the way.

### `newestCompletedSnapshot(inventory)`

The snapshot an incremental created now should extend, or `null` when the
inventory holds no completed snapshot. Ties go to the later entry, so a directory
listing is a deterministic answer rather than a filesystem-order answer.

### `dependentsOf(inventory, snapshotId)`

Every snapshot that cannot be replayed without `snapshotId`, transitively —
including snapshots that reach it through a chain that passes through a snapshot
already deleted. A delete must cascade over this set: deleting a base and leaving
its incrementals behind produces bytes that are listed, billed and impossible to
replay.

### `unrestorableReason(inventory, snapshot)`

`null` when the snapshot can be replayed; otherwise the sentence that says why:

| Situation | Reason |
|---|---|
| The chain cycles | `parent chain of snapshot X is cyclic at Y` |
| A parent is not in the inventory | `base snapshot Y of incremental X is missing` |
| The root of the chain is not a full snapshot | `incremental snapshot X has no full snapshot at the root of its chain` |

`inventory` is a `ReadonlyMap<string, BackupMetadata>` here and a plain array in
the other two, which is not an inconsistency: a restore has already loaded the
metadata it will walk, and a delete is deciding what to load.

## Duration syntax

### `parseDurationToMs(duration)`

The values `RetentionPolicy.keepRecent` and `RetentionPolicy.minAge` accept:

| Form | Example | Meaning |
|---|---|---|
| ISO-8601 duration | `"P7D"`, `"PT1H"`, `"P1DT2H3M4S"` | Days, hours, minutes, seconds |
| A bare number | `"48"` | Hours. Kept for the form that shipped first |

Two earlier behaviours are gone on purpose: a silent `0` for input it could not
parse — a retention policy that quietly became "keep nothing" — and acceptance of
strings that look like durations and are not (`"1D"`, `"P1W"`, `"PT"`). Both now
throw, and `RetentionPolicyEvaluator` names the field:

```
RetentionPolicy.keepRecent is "1D", which is not a duration: "1D" has no duration component
```

Weeks are not accepted: `P1W` is a legal ISO-8601 duration and matches nothing here.
One spelling for one quantity is worth more than two, and the error names the field,
so a policy written with `P1W` fails at construction rather than at the first sweep.
