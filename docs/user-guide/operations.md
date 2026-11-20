# Operations guide

`@agentix-e/db-operations` is an **engine-agnostic operations framework**: three packages
that give every database the same operational surface — health, backup, metrics, security,
maintenance, upgrades — without tying your application to one vendor's admin API.

```bash
npm install @agentix-e/db-operations
# or install only what you need
npm install @agentix-e/db-operations-node
```

---

## 1. The provider registry is the seam

Every package resolves its dependencies through typed tokens rather than constructors:

```ts
import { ProviderRegistry, token } from "@agentix-e/db-operations-node/core";
import { HealthOrchestrator } from "@agentix-e/db-operations-node/health";
import { InMemoryLogger, type ILogger } from "@agentix-e/db-operations-node/logger";

const registry = new ProviderRegistry();
registry.register(token<ILogger>("ILogger"), new InMemoryLogger("operations"));

const health = new HealthOrchestrator();
health.registerFunctional("storage", "Storage", {
  liveness: () => ({ ok: true }),
  readiness: () => ({ ok: true }),
});
health.readiness();
```

Why this matters: the same code runs in tests, staging and production with different
implementations, and swapping a database engine means registering different providers —
not editing call sites.

---

## 2. Package map

Three packages, and the split is by a question rather than by domain: **does the code need
to know how many nodes exist?**

- `@agentix-e/db-operations-node` — no. Twenty modules, one process each.
- `@agentix-e/db-operations-cluster` — yes. A member set, a leader, a majority.
- `@agentix-e/db-operations-federation` — a set of *datacenters*.

### 2.1 `@agentix-e/db-operations-node` — twenty modules

Import the module, not the package root: `@agentix-e/db-operations-node/audit`.

| Module           | What it gives you                                                        | Key entry points                                                                                              |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `core`           | Registry, tokens, lifecycle, shared types                                | `ProviderRegistry`, `token`, `LifecyclePhase`                                                                 |
| `logger`         | Structured logs with trace context                                       | `InMemoryLogger`, `PinoLogger`, `NoopLogger`                                                                  |
| `observability`  | Distributed tracing, W3C trace context                                   | `InMemoryDistributedTracer`, `W3CTraceContext`                                                                |
| `otel`           | OpenTelemetry bridge                                                     | exporters, span processors                                                                                    |
| `health`         | Liveness/readiness probes and orchestration                              | `HealthOrchestrator`, `ComponentProbe`                                                                        |
| `monitor`        | Slow queries, deadlocks, connections, alerts, quotas                     | monitors + alert manager                                                                                      |
| `metrics`        | Counter, gauge, histogram, registry                                      | `MetricsRegistry`, `Counter`, `Histogram`                                                                     |
| `circuitbreaker` | Failure isolation with half-open probing                                 | breaker factory, state listeners                                                                              |
| `memoryguard`    | Heap pressure detection and shedding                                     | guard policies                                                                                                |
| `chaosengine`    | Fault definitions for your own test suites                               | fault schedules                                                                                               |
| `backup`         | Full/incremental backup abstractions, integrity verification             | `BackupManager`, `S3StorageBackend`, `InMemoryStorageBackend`, `BackupVerifier`                               |
| `maintenance`    | VACUUM/ANALYZE/REINDEX windows and scheduling                            | `MaintenanceWindowScheduler`                                                                                  |
| `security`       | TLS, key management, encryption at rest, RBAC, rate limiting, compliance | `KeyManager`, `KeyRotationManager`, `EnvelopeEncryptionProvider`, `AES256GCMEncryptionProvider`, `RBACEngine` |
| `auth`           | Authentication interfaces — `security` implements them                   | provider interfaces, JWT/static providers                                                                     |
| `audit`          | Append-only audit log: crash-safe segments, rotation, export, query      | `InMemoryAuditStore`, `FileAuditStore`, `JsonAuditExporter`                                                   |
| `autoscaler`     | Reactive + predictive scaling decisions                                  | `AutoScaler`, `PredictiveScalingEngine`                                                                       |
| `autotuner`      | Configuration tuning from observed load                                  | `AutoTunerWorker`                                                                                             |
| `configwatcher`  | Live configuration reload with validation                                | watchers, validators                                                                                          |
| `rollingupgrade` | Upgrade plans, batching and health gating                                | `RollingUpgradeOrchestrator`                                                                                  |
| `slacollector`   | SLI recording and SLO/error-budget computation                           | `SLACollector`                                                                                                |

### 2.2 `@agentix-e/db-operations-cluster` — the multi-node half

| Export                   | The question it answers                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `ClusterScalingExecutor` | A scaler said "five nodes". What does the cluster actually have, and which members leave? |
| `ClusterRolloutPlanner`  | Which batch runs first, and does the group still commit while it does?                    |
| `RaftFaultTranslator`    | A fault says "partition `n1`". Which transports does that mean, in which direction?       |
| `InMemoryClusterTopology`| The reference `IClusterTopology` for a fixed member set.                                  |
| `quorumOf`, `tolerableFailures`, `holdsQuorumOf` | Majority arithmetic, in one place.                              |

`autoscaler` and `rollingupgrade` produce *decisions*; the two assemblers above apply them
to a live member set. That separation is why the node modules can be used by a single-node
deployment without dragging a consensus system in, and why a cluster deployment does not
reimplement quorum arithmetic per caller.

The protection lives in the executor, not in the decision. A caller that reads
`ScaleAction.targetCount` and removes members itself gets none of it: no quorum floor, no
leader exclusion, no learner-first order, no "already absent" accounting. If you have a
cluster, apply the action through `ClusterScalingExecutor`; if you have one node, there is
nothing to remove.

### 2.3 `@agentix-e/db-operations-federation` — cross-datacenter

| Export                 | What it gives you                                    |
| ---------------------- | ---------------------------------------------------- |
| `FederatedNode`        | A node bound to shard ids and roles across DCs       |
| `FederatedQueryRouter` | Fan-out query planning over federated shards         |
| schema federation      | Migration descriptors and plans shared across DCs    |

---

## 3. Recipes

### 3.1 Health that distinguishes liveness from readiness

```ts
import {
  HealthOrchestrator,
  componentProbe,
} from "@agentix-e/db-operations-node/health";

const health = new HealthOrchestrator();

health.registerComponent(
  componentProbe("storage", "Storage", {
    liveness: () => ({ ok: storage.isEventLoopResponsive() }),
    readiness: () => {
      const lag = storage.replicaLagMs();
      return { ok: lag < 5_000, message: `replica lag ${lag} ms` };
    },
  }),
);

health.liveness();        // { ok: true, errors: [] }
health.readiness();       // { ok: false, errors: ["storage: replica lag 8 200 ms"] }
health.getHealthStatus(); // structured, for a dashboard
```

A failing **liveness** probe means "restart me". A failing **readiness** probe means "stop
sending traffic". Wiring both to the same check is the most common way to turn a slow
replica into a restart loop.

`IHealthProbe` is **synchronous** — `liveness()`, `readiness()` and `startup()` return a
`ProbeResult`, not a promise. That is a deliberate constraint, not an oversight: a probe that
awaits is a probe that can hang, and a liveness check that blocks on I/O is the failure it was
supposed to detect. A component whose readiness genuinely needs a round trip keeps the answer in
a field an in-process sample updates, and the probe reads the field.

### 3.2 Metrics

```ts
import { MetricsRegistry } from "@agentix-e/db-operations-node/metrics";

const metrics = new MetricsRegistry();
const writes = metrics.counter("db_writes_total", { db: "orders" });
const latency = metrics.histogram("db_write_seconds", { db: "orders" }, [0.001, 0.005, 0.02, 0.1]);

writes.inc();
latency.observe(0.004);

const snapshot = metrics.snapshot(); // what the Prometheus exporter publishes
```

Metrics are created *by the registry*, not passed to it: `counter`, `gauge` and `histogram` take
a name, an optional label set and — for histograms — bucket bounds, and return a handle. A second
call with the same name and the same labels returns the same counter, so a component does not have
to thread a handle through its own constructor to record a metric.

### 3.3 Backup with verification

```ts
import {
  InMemoryBackupManager,
  RetentionPolicyEvaluator,
  S3StorageBackend,
  BackupVerifier,
} from "@agentix-e/db-operations-node/backup";

const backups = new InMemoryBackupManager(
  new S3StorageBackend({ bucket: "db-backups", region: "eu-west-1" }),
  new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 5e11, keepRecent: "P7D" }),
);

const result = await backups.createBackup({ type: "full" });
if (!result.success) throw new Error(result.error);

const metadata = await backups.getBackup(result.snapshot!.snapshotId);
const report = await new BackupVerifier().verifyStream(await openStream(metadata!));
if (!report.valid)
  throw new Error(`backup ${metadata!.snapshotId} failed verification: ${report.error}`);
```

The manager takes its two collaborators **positionally** — a storage backend and a retention
policy — rather than a configuration object, because both are interfaces with more than one
implementation and neither has a sensible default: a manager that quietly backed up to memory
would be a manager whose backups are gone at the next restart.

Verify on creation **and** on a schedule — a backup that was never restored is a hypothesis,
not a backup.

#### The S3 backend needs two optional peers

`S3StorageBackend` speaks S3 through `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`, which are
optional peer dependencies of the package rather than dependencies of it:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

That is why the snippet above imports and constructs the backend without them being installed
anywhere in the other twelve storage paths. The import is resolved on first use, so constructing a
backend resolves nothing; the first request without the SDK is refused with a message that names
both packages, and `health()` reports the same sentence as `{ ok: false }` so a readiness probe
fails for the reason a reader can act on.

#### Retention: floors are floors

```ts
import { RetentionPolicyEvaluator } from "@agentix-e/db-operations-node/backup";

const retention = new RetentionPolicyEvaluator({
  maxFullSnapshots: 7,
  keepRecent: "P7D",     // never remove anything younger than a week
  minAge: "PT1H",        // and never remove a snapshot during its first hour
  maxTotalBytes: 500_000_000_000,
});

const { toDelete, unreclaimedBytes } = retention.evaluateWithOutcome(inventory);
for (const snapshot of toDelete) await backups.delete(snapshot.snapshotId);
if (unreclaimedBytes > 0) {
  // The floors forbid getting under the ceiling. This is a fact about the
  // deployment, not a bug in the evaluator: raise the limit, shorten a floor,
  // or add storage.
  logger.warn("retention could not meet maxTotalBytes", { unreclaimedBytes });
}
```

Four rules apply, in this order: keep the newest `maxFullSnapshots` **sets**, remove no set
containing anything younger than `keepRecent`, remove only sets whose every member is at least
`minAge` old, then remove whole sets, oldest base first, until the total fits under
`maxTotalBytes`.

#### Retention: a chain is the unit, not a snapshot

Incrementals are chained through `parentSnapshotId`: an incremental holds only what changed since
its parent, so it can be replayed only on top of its whole chain. Retention therefore groups the
inventory into **sets** — a base plus every incremental that reaches it — and keeps or removes a
set whole.

That is not a detail of the implementation, it is the difference between a delete list and a data
loss plan. Pruning snapshots one at a time does two things, both wrong:

- it deletes a base and leaves its incrementals behind: bytes that are listed, counted against
  the quota, and impossible to restore;
- it stops as soon as the ceiling is met, so "reclaimed 250 GB" can mean "250 GB gone and 50 GB of
  it was the only copy that could still be read".

```ts
// Set A: base (3 days old) + incremental (1 hour old). Set B: base (2 hours old).
// 250 bytes on disk, 130 allowed.
const { toDelete } = new RetentionPolicyEvaluator({
  maxFullSnapshots: 7,
  maxTotalBytes: 130,
}).evaluateWithOutcome(inventory);
// toDelete = [base-a, inc-a] — set A leaves as a unit, set B stays restorable.
```

Three consequences worth knowing:

- **`maxFullSnapshots` counts sets.** The name is kept for compatibility; the meaning is "how many
  restorable backups to keep". A set's age is the age of its base, because a delta is only as new
  as the chain it can be replayed on.
- **A floor on one member protects the whole set.** If a set contains anything younger than
  `keepRecent`, the set stays — keeping the incremental and deleting its base would be the same
  bug as above.
- **An unreadable timestamp is not an expiry date.** A snapshot whose `createdAt` cannot be parsed
  is skipped by every removal rule, and the bytes it holds are reported in `unreclaimedBytes`.
  Retention may not delete what it cannot date.

Pass the **complete** inventory. A snapshot whose `parent` is absent from the list it was given is
treated as a set of its own rather than as an orphan to delete, so filtering the list cannot turn
into a delete order — but a filtered list also cannot tell a chain from three unrelated snapshots.

`evaluate()` is the interface method and returns the delete list alone; `evaluateWithOutcome()`
adds the report.

`keepRecent` and `minAge` are **prohibitions, not preferences**. That matters when they conflict
with the byte ceiling: the floors win, and the difference is reported as `unreclaimedBytes`. The
alternative — deleting a one-hour-old backup to satisfy a size limit — is how a retention policy
turns into data loss.

Durations are read as ISO-8601 (`P7D`, `PT1H`, `PT30M`, `PT30S`, `P1DT2H3M4S`) or as a plain
number of hours (`"48"`). Anything else throws where the policy is written, in the constructor or
in `updateConfig`, because a floor that silently means zero protects nothing.

The store keeps the same invariant from its side. `createBackup({ type: "incremental" })` records
the completed snapshot it extends in `parentSnapshotId`; `deleteBackup(id)` cascades to every
snapshot that cannot be replayed without `id`; and `restoreFromSnapshot(id)` refuses a chain whose
base is gone, naming the missing link instead of reporting success. That last check matters even
with a chain-aware policy, because `IBackupRetentionPolicy` is an injection point — a caller's own
policy can still return a base.

The chain primitives are exported, so an adapter for a store that is not this manager can answer the
same questions:

```ts
import { dependentsOf, unrestorableReason } from "@agentix-e/db-operations-node/backup";

// What would I lose if I deleted this snapshot?
const dependents = dependentsOf(inventory, snapshotId);

// Can this snapshot be replayed, and if not, which link is missing?
const reason = unrestorableReason(new Map(inventory.map((s) => [s.snapshotId, s])), snapshot);
if (reason !== null) logger.error("snapshot is unrestorable", { snapshotId, reason });
```

The chain primitives are exported, so an adapter for a store that is not this manager can answer the
same questions:

```ts
import { dependentsOf, unrestorableReason } from "@agentix-e/db-operations-node/backup";

// What would I lose if I deleted this snapshot?
const dependents = dependentsOf(inventory, snapshotId);

// Can this snapshot be replayed, and if not, which link is missing?
const reason = unrestorableReason(new Map(inventory.map((s) => [s.snapshotId, s])), snapshot);
if (reason !== null) logger.error("snapshot is unrestorable", { snapshotId, reason });
```

`evaluate()` is the interface method and returns the delete list alone; `evaluateWithOutcome()`
adds the report.

### 3.4 Encryption at rest with rotation

```ts
import {
  KeyManager,
  EnvelopeEncryptionProvider,
  KeyRotationManager,
} from "@agentix-e/db-operations-node/security";

const keys = new KeyManager({ masterSecret: process.env.DB_MASTER_SECRET! });
const encryption = new EnvelopeEncryptionProvider({
  keyManager: { masterSecret: process.env.DB_MASTER_SECRET! },
  encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
});

const rotation = new KeyRotationManager(encryption, keys, {
  // The one thing the manager cannot supply: where the blobs are. A callback, so
  // the manager stays engine-agnostic — it drives policy and crypto, not storage.
  reEncryptSource: async (policyId, newVersion) => rowsNotYetOn(newVersion),
});

rotation.registerPolicy({
  id: "dek-90d",
  name: "Data key, ninety days",
  trigger: { kind: "time", maxAgeMs: 90 * 24 * 60 * 60 * 1000 },
  reEncrypt: true,
  reEncryptBatchSize: 256,
  maxKeyVersions: 5,
  priority: "normal",
  enabled: true,
});

rotation.startScheduler();          // checks every five minutes
// ...
await rotation.emergencyRotate("dek-90d", "key found in a log");
```

`startScheduler()` owns an interval, and the interval is `unref`'d: a running
scheduler never keeps your process alive. `stopScheduler()` clears it.

**What a rotation promises, and what it records.** `checkPolicies()` returns the policies
that are due, ordered by `priority` — `critical` first — because a tick that can rotate one
key should rotate the one that leaked. `rotate()` then reports exactly what happened:

| Field | Meaning |
| --- | --- |
| `fromVersion` / `toVersion` | The key versions either side of the rotation. A **failed** rotation reports `toVersion === fromVersion`: it creates no key, so it names none. |
| `success` / `error` | Whether the KMS rotated the key. A re-encryption that fails afterwards does not un-rotate it. |
| `reEncryption` | `not-requested` (the policy does not ask), `completed`, `deferred` (**the key rotated and the data did not**) or `failed` (the source was there and broke). |
| `reEncryptedCount` | Blobs rewritten and verified to round-trip. |
| `retiredVersion` | The version that fell out of the `maxKeyVersions` window, when the `KeyManager` still holds it. Keys are not deleted — decryption still needs them — so this is a report, not an action. |

`deferred` is the state worth knowing about: it is a rotation that succeeded and left data
on the old key. `reEncrypt(policyId, blobs)` drives it manually, and
`pendingReEncryptions` says whether another pass is owed (`1`) or the source was exhausted
(`0`). `reEncryptBatchSize` bounds one pass, so a rotation can migrate a slice instead of
the whole database.

The source yields `Buffer` for a blob to migrate and `null` for a blob it already knows is
on the current key — it is the only component that knows the per-blob key version.
`reEncrypt` wipes the plaintext it decrypted on every exit, including the failure paths.

**Triggers.** `time`, `count`, `volume`, `schedule`, `manual` and `compromise`. `count` and
`volume` are fed by `recordEncryption(policyId, bytes)`; calling it for a policy that is not
registered yet is a no-op, so startup order does not matter. A `compromise` policy is due
**until it has been rotated once**: an emergency rotation that stayed "always due" made the
scheduler rotate the key on every tick for the life of the process.

`query()`, `get()` and `count()` read archived (`.ndjson.gz`) segments as well as the active
one, so rotation does not make history disappear from the API — the entries stay on disk and
stay readable. A segment that cannot be decoded is skipped rather than aborting the query: a
damaged archive costs you those entries, not the whole trail. A segment being archived is
counted once — the archive wins over the original that is about to be removed.

**An archive is published, not written in place.** Compression writes `<segment>.ndjson.gz.part` and
renames it, because the rule that an archive wins over its original is only sound if an archive that
exists is complete. Written in place, the archive existed and was half-written for the whole duration
of a gzip — a second, on a fifty-megabyte segment — while the complete original beside it was
suppressed by it: `get(id)` answered "no entry" for an entry on the disk, for as long as the
compression ran. A `.part` is not a segment by any rule the store applies — it is not read, not
adopted as the active segment, not expired — and one left behind by a killed process is removed the
next time a store opens the directory.

**A page is not a fact.** `maxScanLines` (default 10 000) bounds what `query()` returns,
because the budget exists to keep a grep-shaped read cheap. It does not bound what `get()` or
`count()` *look up*:

```ts
await audit.query({ actor: "alice" });            // at most 100 (default limit), oldest first
await audit.query({ actor: "alice", limit: 500 }); // at most 500
await audit.count({ actor: "alice" });            // every match, whatever the page size
await audit.count({ actor: "alice", offset: 900 }); // still every match: paging is not selection
await audit.get(entryId);                         // found, even if it is past the budget
```

A count that inherited the default page reported at most one hundred matches for any filter,
and an id lookup that inherited the budget answered "not found" for entries that existed.
Both are the kind of wrong that is not recoverable in an audit report.

**Reading through a port.** Every entry the store reports is read through
`segmentReader`, so segments can live somewhere other than the local filesystem — and so the I/O a
scan performs can be accounted for, which is the promise `maxScanLines` actually makes:

```ts
const audit = new FileAuditStore({
  dataDir: "/var/lib/db/audit",
  maxScanLines: 5_000,
  // Same contract as the default: text, or null when the segment has none.
  // Throwing means the same thing, so a port that fails is a segment with no
  // entries rather than a failed query.
  segmentReader: (path, compressed) => readText(path, compressed),
});

audit.query({ actor: "alice" });   // reads one segment, not the whole trail
audit.count({ actor: "alice" });   // reads the trail: a count is a fact, not a page
```

A capped scan stops **reading** when the budget is spent, not merely stops collecting: a page that
paid for the history it did not return would be a grep that decompresses ninety archives to show
ten lines.

**An id is a promise about a power cut.** `write()` resolves only after three things have
happened, in this order:

1. **append** — the line is in the file (still in the page cache, which a crash does not lose but a
   power cut does);
2. **sync the file** — the data is on the medium;
3. **sync the directory** — once per segment, after its first line, so that the *name* is on the
   medium too. A name is a directory entry; step 2 does not touch it, so without step 3 a power cut
   can leave the entries written and unreachable.

If any step fails, `write()` rejects. That is the whole contract, and it is the reason the store no
longer says `/* fsync best-effort */`: a write path whose failure mode is "pretend it worked" is the
one component in the system that cannot be trusted about what happened. A caller can retry a
rejection; it cannot retry a lie.

```ts
const id = await audit.write({ operation: "DROP TABLE", actor: "alice", resource: "orders", result: "success" });
// When this resolves, the entry survives a power loss. When it rejects, it does not.
```

**One line, one append.** There is no temporary file and no `rename`: an append-only trail does not
need whole-file replacement, and paying for it on every line meant rewriting the segment to add a
line to it. Measured over 2 000 lines of 524 bytes, writing to a real filesystem:

| | Bytes written | Wall time |
|---|---:|---:|
| Read the segment, rewrite it via a scratch file, rename it into place | **1 000 MiB** (1 000× the payload) | 22.3 s |
| Append the line | **1.0 MiB** (1.0× the payload) | 20.0 s |

The wall time is the `fsync`: 2 000 bare `append`+`fsync` pairs with no store at all take 20.8 s on
the same runner, so the store now adds nothing measurable above the durability it provides.

**One flush acknowledges a turn's worth of writes.** A file sync covers every byte appended before
it, so writers that arrive together need only one of them. The append stays synchronous — `O_APPEND`
puts each line where its caller wrote it — and the sync moved to the end of the event-loop turn.
Measured on the same runner, 500 entries each:

| Callers | `fsync` calls | Throughput |
|---|---:|---:|
| one at a time | 500 | 101 entries/s |
| 10 in flight, continuously | 50 | 981 entries/s |
| a burst of 500 at once | 1 | 20 646 entries/s |

A caller who waits for one write before issuing the next pays exactly what it paid before, so the
serial figure is unchanged — the gain belongs to concurrency, and a service that handles a hundred
requests at once no longer pays a hundred round trips to the disk to record a hundred events. The
acknowledgement still never runs ahead of the sync: a line appended *while* a flush is in progress
belongs to the next flush, not to the one that has already started.

**A rejected write may still be in the trail.** The append happens before the sync, and a failed
`fsync` cannot be undone by truncating — that is a second write with its own failure mode, and the
segment may hold another process's bytes. So the guarantee is *at-least-once* across a failure, never
at-most-once: when `write()` rejects, retry with a fresh id rather than assuming the entry is absent,
and reconcile duplicates downstream if that matters to your compliance statement.

**A segment has one writer, and the name is claimed before it is written to.** The append is an
`O_APPEND` write, which the kernel places at the end of the file, so there is no window in which one
writer's line can overwrite another's. The recipe this replaced read the segment, concatenated and
renamed, so two writers lost each other's lines in proportion to how busy the trail was — and both
were writing the same scratch path, so one of them could fail outright while the other renamed
underneath it.

Two processes appending to one *trail* is supported. A *segment* is a unit of rotation, so what happens
to one that two live processes share is worth knowing, because it is what the file names mean:

| Situation | What happens |
|---|---|
| Two processes start together on an empty directory | Each claims a different segment name (`O_CREAT \| O_EXCL`, retried by re-scanning), so neither can write into the other's file. |
| A process starts while another is writing | It continues the newest open segment rather than starting a new one — that is what makes a restart a continuation instead of a gap. Two *live* processes can therefore share that segment until one of them rotates. |
| One process rotates a segment the other is still appending to | The archive is **not published** while the segment is growing: the compression checks the segment's identity and its length before the rename, so an archive of a prefix never exists. The plain segment stays as the only name, and every line in it stays readable. |
| One process archives a segment another has adopted | The archive is published, and the adopting process's line is not hidden by it: after every append — before the caller is acknowledged — a store compares its file with the archive of its own name and repairs the disagreement. Nothing is lost and nothing is counted twice. |

**A name and its archive are two views of one segment, and the store keeps them agreeing.** Every
reader prefers an archive over the plain file of the same name — correctly, because between the
rename and the unlink both hold the same entries — so the two views have to be reconciled by what
they *hold*, not by who owns them. The comparison is on the bytes, because bytes are the only
evidence that survives a crash: a pid is meaningless on another host and racy on a shared mount, and
a lease file would answer "who meant to own this name" when the question is "what does this name
hold". Four answers, and each has one repair:

| The two views | What the store does |
|---|---|
| The plain file starts with the archive and is longer | The archive is a prefix and adds nothing: it is removed, so the file stops being hidden. |
| The archive starts with the plain file, or they are identical | The plain file carries nothing of its own: it is removed (at rest) or abandoned for a new segment (while writing). |
| Neither contains the other | Both carry unique entries: the plain file is renamed to a segment name of its own, so a reader sees both. |
| The archive exists but cannot be read | It hides a segment while contributing nothing: it is removed. |

The repair runs in two places, and both are needed. Before a store adopts a name it sweeps the whole
directory, because the process that could have repaired a crashed writer's segment is gone. And after
every append, before the acknowledgement, so that an entry is acknowledged only once its name is a
name a reader reads. What is left is a window of microseconds — an archive published between that
check and the sync that acknowledges the line — which the next append or the next start repairs;
closing it entirely would need a lock, and the entry is never lost, only briefly out of view.

So the rule to deploy by is no longer "one writer per trail". A fan-in of short-lived processes works,
two long-lived services on one directory work, and a crashed writer's segment is repaired by the store
that comes after it. What does *not* change is the cost: a shared directory is a shared disk, and two
services rotating the same trail also prune the same files.


**A crash leaves at most one unreadable line — and it cannot swallow the next one.** A process killed
between the write and its newline leaves a fragment. Readers skip an unparsable line, so the fragment
costs nothing on its own; what it must not do is fuse to the next append. The store asks the
filesystem once per segment whether the segment ends mid-line and, if it does, starts the next line
with a newline. The fragment stays a fragment, and the entry that follows it is readable.

**The write side is a port too.** `fileSystem` takes `append`, `syncFile`, `syncDirectory` and
`needsSeparator`; the default is the local POSIX recipe. Supplying one puts the trail on another
medium without losing queries, and — the reason it is four named operations rather than a `fs` handle
— makes the order assertable, which is the only part of "crash-safe" a test can see without a crash:

```ts
const audit = new FileAuditStore({
  dataDir: "/var/lib/db/audit",
  fileSystem: {
    append: (path, data) => objectStore.append(path, data),
    syncFile: (path) => objectStore.commit(path),        // must be durable on return
    syncDirectory: () => {},                             // S3 has no directory entries
    needsSeparator: (path) => objectStore.endsWithNewline(path),
  },
});
```

An implementation that returns without doing the work has moved the durability claim into its own
documentation. Whatever is supplied must be durable when it returns; if it is not, the store's
promise is only as good as the port.

**What a crash can still take.** The kill a test can perform (`SIGKILL`) shows that an acknowledged
line is in the file; it does not show that the line reached the medium, because the page cache
outlives the process and only a power cut empties it. The `fsync` half is therefore asserted by order
and by failure propagation inside the process, and the process half by killing real writers. No
runner provides a power cut, so the last sentence of the guarantee is documented rather than tested.

**Damage is scoped to the file.** A segment that cannot be read — a truncated archive, an
unmounted volume, a port that throws — contributes no entries and does not stop the scan. There is
no separate "unreadable" state: an unreadable segment is an empty one, which is why the store has
one rule here instead of two branches that say the same thing.

**Retention.** `retentionDays` (default 90) is enforced when a segment closes: rotation sweeps
closed segments whose last write is older than the window. `0` disables the sweep instead of
meaning "keep nothing" — retention that deletes evidence on construction is a footgun, and a
caller who wants to prune chooses when:

```ts
await audit.pruneOlderThan(new Date(Date.now() - 30 * 24 * 3600 * 1000));
```

The window is the segment's modification time, and a segment whose date **cannot be read is left
alone**: a failed `stat` is an I/O error, and turning one into a deletion converts a transient fault
into permanent loss of the evidence. It stays until the next sweep, which is the next rotation. The
comparison is strict at the boundary as well — a segment whose last write is exactly `retentionDays`
ago is still inside the window.

`pruneOlderThan` deletes only names this store could have produced (`<prefix>-YYYYMMDD-NNNN.ndjson`
and its `.gz`), never the segment it is appending to, and it reports the number of files that
actually went: each file is removed in isolation, so one unreadable segment does not abandon
the rest of the sweep. "Older than" is strict — a file last written exactly at the cutoff
stays.

`close()` is optional on `IAuditStore` — in-memory stores have nothing to drain — but a
file-backed store should be closed before the directory it owns is moved or deleted: it waits
for the background compression of the last rotated segment.

#### What the key material itself guarantees

A key manager is judged by the questions it can answer when something has already gone wrong,
so the rules below are contracts rather than conveniences:

| Question | Answer |
| --- | --- |
| What does `keyLength` size? | The **data** key: 16, 24 or 32 bytes. The key-encryption key that wraps it is always 32 bytes, because the wrapping cipher is fixed. `keyLength: 16` used to size both, and every wrap then failed with `Invalid key length`. |
| Can one version number mean two keys? | No. `loadKey()` of a version already held with the same material is a no-op; with different material it throws. A silent replacement made v1 name the restored key *and* the local one, and blobs written under the first became unreadable with no error at load time. |
| Does `zeroize()` reset the numbering? | No. Versions continue from the highest ever issued, because the old keys are still in ciphertext headers, exports and backups. Reissuing v1 after a wipe is how two different keys end up sharing a name. |
| Who owns the bytes `getKey()` returns? | The caller — they are a copy. Zeroizing what you were handed is hygiene; it must not zeroize the key the process is using. |
| When is a version spent? | Only when a key exists. `generateKey()` wraps first and increments after, so a KEK that cannot be derived leaves the numbering untouched instead of skipping a number. |
| What order does `exportWrappedKeys()` return? | Ascending version, whatever order the keys were loaded in, each one re-wrapped with a fresh nonce. Export is a replayable transfer format, not a dump. |
| What does `initialize()` do to versions? | Nothing. `EnvelopeEncryptionProvider` mints its first version on the first `encrypt()`, so a backup can be imported into a fresh process *before* anything is written — which is the only order that works. |
| What does `canDecryptVersion(v)` answer? | Whether the manager holds `v`. Not whether the cipher is initialized: `hasKeyVersion(v) || isEnabled()` answered "yes" for every number, including versions that never existed. |

Two configurations are refused at construction rather than at the first write, because both are
programming errors and both used to surface as a `crypto` message: an empty `masterSecret` (PBKDF2
will derive 256 bits from nothing and every instance would share them), and a `keyLength` that the
configured `algorithm` cannot use (`aes-256-gcm` needs 32 bytes).

#### What a write costs, and what a blob may ask for

Envelope encryption wraps a data key per blob, and wrapping derives the key-encryption key with
PBKDF2 — 600 000 iterations by default, roughly 100 ms of CPU. Doing that per write is a
correctness-shaped bug with a cost-shaped symptom: the process re-derives a key it derived a
moment earlier. The derivation is now cached per `(salt, iterations)` pair, and the counter is
public:

```ts
const encryption = new EnvelopeEncryptionProvider({
  keyManager: { masterSecret: secret },
  encryption: { algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" },
});
await encryption.initialize({ algorithm: "aes-256-gcm", keyDerivation: "pbkdf2" });

for (const row of rows) await encryption.encrypt(row);

encryption.keyDerivationCount; // 1 — not rows.length
```

The cache holds the **derived key**, never the wrapped blob: reusing one wrapped key across many
ciphertexts would put the same key and the same IV in every header. `zeroize()` empties it, because
a cached wrapping key is key material by any reading of the word.

The same header that carries the salt also carries the iteration count, so a blob chooses how much
CPU the reader spends on it. That is a decision data does not get to make: `unwrapKey()` refuses a
work factor above `MAX_DERIVATION_ITERATIONS` (10 000 000) or a salt outside 16–64 bytes, before
deriving anything. The cache is bounded for the same reason (`MAX_CACHED_KEKS`, 64) — a header
field that selects a cache entry is a header field that can fill memory.

**Writers that arrive together.** Concurrent `encrypt()` calls share one key activation, so eight
first writes mint one version, not eight. The version travels with the key it names, so a
`rotateKey()` landing between two writes cannot produce a header that names the new version over a
payload sealed with the old one. And a `zeroize()` that lands while a key is being minted discards
the mint: the write fails with `zeroized while a data key was being minted` instead of being served
by a key that was born after the wipe.

### 3.5 Audit trail: what retention is allowed to delete

```ts
import { AuditLogManager } from "@agentix-e/db-operations-node/security";

const audit = new AuditLogManager({
  logFilePath: "/var/lib/db/audit.jsonl",
  retention: { maxEvents: 100_000, maxAgeMs: 90 * 24 * 3600 * 1000, minRetain: 1_000 },
  autoStart: true, // flush every 10 s; the interval is unref'd
});

await audit.log({
  category: "data_access",
  severity: "info",
  action: "SELECT",
  message: "read 12 rows from public.orders",
  actor: { id: "alice", ip: "10.0.0.7" },
  resource: { type: "table", id: "public.orders" },
  success: true,
});

const integrity = await audit.verifyIntegrity();
// { valid: true, errors: [], truncated: null }
```

An audit trail has two jobs that pull in opposite directions: keep the window bounded, and
prove nobody touched it. A hash chain cannot lose its first event and stay a chain — the
survivor that followed it hashes a parent nothing in the trail computes. Retention is allowed
to delete, so the deletion is **recorded**:

```ts
await audit.prune(30 * 24 * 3600 * 1000); // keep 30 days

const after = await audit.verifyIntegrity();
// {
//   valid: true,
//   errors: [],
//   truncated: { removedEvents: 41_000, lastRemovedSeq: 41_000, lastRemovedHash: "9f2c…", at: … },
// }
```

| Field | Meaning |
| --- | --- |
| `valid` | Every retained event hashes to its recorded hash and chains onto its predecessor. |
| `truncated` | `null` until retention removes something; then how many events went, the sequence number and hash of the newest removed one, and when. The retained chain verifies **from that hash**, so the policy that deleted them is not reported as an attacker. |
| `errors` | One message per finding, in chain order: `seq gap at index N`, `chain broken at seq N`, `hash mismatch at seq N`. A gap *inside* the retained window is tampering and stays reported as one. |

**Retention removes a prefix, never a hole.** `prune(olderThanMs)` walks from the oldest event
and stops at the first one that is not older than the cutoff; the ceiling in `maxEvents`
removes from the front. Deleting an event in the middle would leave a gap no anchor can
describe, so a clock that jumped backwards stops the sweep instead of punching through it.
"Older than" is strict: an event whose timestamp equals the cutoff stays.

| Option | Default | `0` means | Applies |
| --- | --- | --- | --- |
| `maxEvents` | `1_000_000` | no ceiling | on `flush()`, from the head |
| `maxAgeMs` | 90 days | no age limit | on `flush()`, from the head |
| `minRetain` | `1_000` | — | floor for both rules and for `prune()` |

**The file is evidence, the window is memory.** `flush()` appends to the JSONL trail and only
then applies retention to the in-memory window. The file is never rewritten, because rewriting
a hash-chained file invalidates the hashes it contains — so an event that is too old for the
window is still on disk and still chainable. Trim the file with your own retention if your
regulator requires it, and keep the `truncated` records with it.

Two more answers that are easy to get wrong: a **negative `limit` returns no rows** (not "all
but the last"), a **negative `offset`** is read from the start, and both are clamped rather
than silently reinterpreted.

`destroy()` clears the auto-flush interval and flushes what is buffered. The interval is
`unref`'d, so enabling `autoStart` never keeps your process alive.

#### Compliance reports that can only pass on checks that ran

```ts
import { RotationAuditor } from "@agentix-e/db-operations-node/security";

const auditor = new RotationAuditor();
rotation.on("rotation", (event) => auditor.record(event));

const report = auditor.generateReport("PCI-DSS");
// { pass: false, findings: ["PCI-DSS 3.6.4: key rotation interval may exceed 1 year"], … }
```

- **A framework with no checks fails.** `PCI-DSS`, `SOC2` and `HIPAA` have checks;
  anything else returns `pass: false` with a finding naming it. A report that passes because
  nothing was verified is worse than no report.
- **`record()` refuses an event that describes two outcomes at once** — `success` with an
  `error`, failure without one, success with no completion time, or success that moved no
  version. Refusing consumes no sequence number, so the trail stays contiguous.
- **`oldestActiveKeyCreatedAt`** is the completion of the earliest *successful* rotation, and
  `null` when nothing succeeded. A failed rotation created no key, so it cannot date one.
- **`importJSONL()` verifies before it adopts.** Each line is checked for sequence number,
  `prevHash` linkage, self-contradiction and its own hash, and *nothing* is imported until
  every line passes — a half-imported chain is a chain that lies about what it contains. It
  also refuses to splice a second chain onto a live one: a chain has one genesis.
- **`verify()` separates two kinds of wrong.** `chainBroken` means the hashes or the numbering
  are broken; `valid: false` with `chainBroken: false` is a clock that went backwards, which is
  a finding about the producer, not about the storage.
- `recent(0)` returns nothing — `slice(-0)` is `slice(0)`, so "the last zero entries" used to
  return every entry.

### 3.6 Rolling upgrade

```ts
import { RollingUpgradeOrchestrator } from "@agentix-e/db-operations-node/rollingupgrade";

const upgrade = new RollingUpgradeOrchestrator({ minBakeMs: 30_000 });
const stats = await upgrade.execute({
  id: "upgrade-2026-11-19",
  name: "1.1.3 → 1.2.0",
  targetVersion: "1.2.0",
  nodes: ["node-a", "node-b", "node-c"],
  batchStrategy: "fixed_size",
  batchSize: 1,
  rollbackTrigger: "on_first_failure",
  healthCheckNames: ["storage", "replication"],
});

upgrade.getBatches(); // what ran, in order
upgrade.getEvents(); // and why each step did
```

The orchestrator refuses to proceed if it would lose quorum, gates each step on health, and
aborts (rather than continuing) on the first unhealthy node. The constructor takes only the
canary bake time and a sleep function — the plan is the argument to `execute`, because a
long-lived orchestrator runs more than one upgrade.

### 3.7 Maintenance windows

```ts
import { MaintenanceWindowScheduler } from "@agentix-e/db-operations-node/maintenance";

const scheduler = new MaintenanceWindowScheduler();
scheduler.registerWindow({
  id: "nightly-vacuum",
  name: "Nightly vacuum",
  operationType: "VACUUM",
  targets: ["orders"],
  owner: "dba",
  recurrence: "weekly",
  startTime: "23:00", // UTC, always
  daysOfWeek: ["sun", "wed"],
  priority: 5,
  maxDurationMin: 90,
  requiresApproval: false,
});

const upcoming = scheduler.getUpcomingOccurrences(Date.now(), Date.now() + 7 * 86_400_000);
```

Two rules matter when you read `upcoming`:

- **All times are UTC.** `startTime`, `daysOfWeek`, `daysOfMonth` and `cronExpression`
  are interpreted in UTC, never in the host's local zone. A window described as `23:00`
  fires at 23:00 UTC.
- **An occurrence is reported by its start, in `[fromMs, toMs)`.** A window that began
  before `fromMs` is not in the result even if its `maxDurationMin` has not elapsed yet;
  use `getWindowInstances()` to see windows already in progress. Projection is idempotent,
  so re-running it does not create duplicate instances.

Supported recurrences are `once` (`at`), `daily` (`startTime`), `weekly` (`startTime` +
`daysOfWeek`), `monthly` (`startTime` + `daysOfMonth`, clamped to the last day of short
months) and `cron` (`cronExpression`). `detectConflicts(fromMs, toMs)` projects the same
occurrences and reports overlaps, with a `split` / `defer` / `coexist` recommendation
derived from the two windows' priorities.

#### Conflicts are about runs, not windows

A conflict names the two **occurrences** that would overlap, in `conflictingSides`, together with
their instances and intervals; `conflictingWindowIds` and `description` (both intervals in
ISO-8601) are there for the operator. `resolveConflict()` touches exactly those instances:

| Strategy      | Effect                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| `defer_lower` | cancels the conflicting run of the lower-priority window                     |
| `defer_newer` | cancels the later-starting conflicting run                                   |
| `allow_both`  | changes nothing                                                              |

Two runs of the **same** window can conflict: a window whose `maxDurationMin` exceeds its
recurrence period starts its next run before the previous one finished, and that is the one
overlap a scheduler can still prevent. Equal priorities under `defer_lower` are a no-op — there is
no lower window, which is what the `split` recommendation is asking a human to do. A `pending`
run is never cancelled by a strategy: it is waiting for an approver, and a resolution is not that
approver.

#### Cron: five fields, and what a malformed one means

`cronExpression` takes the standard five fields — `minute hour day-of-month month day-of-week` —
in UTC. The grammar is its own module (`parseCron` / `parseCronField` are exported), so you can
check an expression before you register a window:

```ts
import { parseCron } from "@agentix-e/db-operations-node/maintenance";

parseCron("*/15 0-6 * * 1-5").minutes; // Set { 0, 15, 30, 45 }
parseCron("0 3 * *"); // throws: expected 5 fields
```

| Form        | Meaning                                              | Malformed becomes                       |
| ----------- | ---------------------------------------------------- | --------------------------------------- |
| `*`         | every value in the field                             | —                                       |
| `a`         | one value                                            | outside `min..max` → names nothing      |
| `a-b`       | inclusive, clamped to the field's real range         | `b < a`, or a missing bound → nothing   |
| `*/n`, `a/n`, `a-b/n` | the range walked by `n`, clamped per value | `n` ≤ 0 or not a number → nothing       |
| `a,b,c`     | union of any of the above                            | —                                       |

A field that names nothing produces a window that never fires; it does not throw. That is
deliberate: `"0 3 30 2 *"` is 30 February — the expression is well-formed and the date never
exists — and a scheduler that raised on it would fail at registration for a reason only the
calendar knows. A field *count* below five is the one error, because `"0 3 * *"` is not a
schedule. A sixth field is ignored rather than misread (dialects that have a year put it last).

The stride stays anchored where the expression puts it: `0-5/2` in `daysOfMonth` walks 0, 2, 4
and then drops 0, because day zero does not exist — it does not quietly start at 1.

> **Operational bound.** A cron projection scans minute by minute and stops after 100 000
> minutes (~69 days). Ask for a range wider than that and you get the occurrences inside the
> first 100 000 minutes, not an error. Every other recurrence computes its occurrences
> directly and has no such limit.

#### The lifecycle of a run

```ts
const [run] = scheduler.getUpcomingOccurrences(Date.now(), Date.now() + 3_600_000);
scheduler.startWindow(run.instanceId); // scheduled|approved -> in_progress
scheduler.completeWindow(run.instanceId); // -> completed, actualEnd stamped
// or: scheduler.failWindow(run.instanceId, "lock timeout");
```

| State           | Entered by                                  | Counted as active by `getStats()` |
| --------------- | ------------------------------------------- | --------------------------------- |
| `pending`       | projection of a window with `requiresApproval` | no (it is in `pendingApprovals`) |
| `scheduled`     | projection of a window without approval      | yes                               |
| `approved`      | `approveWindow(id, who)`                     | no                                |
| `in_progress`   | `startWindow(id)`                            | yes                               |
| `force_override`| `forceStart(windowId)`                        | yes                               |
| `completed`     | `completeWindow(id)`                         | no                                |
| `failed`        | `failWindow(id, reason)`                      | no                                |
| `cancelled`     | `cancelWindow(id, reason)` or a resolution      | no                                |

`startWindow` refuses a `pending` run: `requiresApproval` exists so that a person decides before
the database is taken offline, and starting without that decision would make the flag advisory.
`startWindow`, `completeWindow` and `failWindow` are on `IMaintenanceScheduler`, not just on the
implementation, because the executor — the component that knows a run began or ended — is typed
against the interface.


Resolving a conflict at 03:00 does not touch the same window's run next month. `getStats()` reports
`conflictsDetected` and `conflictsResolved`; both were hardcoded to `0` before 1.3.0, so a
dashboard built on them showed a quiet cluster during a conflict storm.

A schedule that cannot name a real time or a real day is **malformed, not reinterpreted**:
`startTime` must be an integer hour `0..23` and an integer minute `0..59`, and
`daysOfMonth` entries must be `1..31`. Anything else produces no occurrences and throws
nothing — `'25:00'` will not quietly run at 01:00 the next day, and a `0` day-of-month
will not fire on the previous month's last day. Registering is permissive so a
configuration can be edited into shape; ask `getUpcomingOccurrences()` to see what it
actually schedules.

Pausing and resuming dependent resources both confirm through a callback, and both await
it:

```ts
await scheduler.requestPause({
  instanceId,
  resources: ["orders"],
  pauseAt: Date.now(),
  resumeAt: Date.now() + 3_600_000,
  onPaused: (resource) => drain(resource),
  onResume: (resource) => warm(resource),
});

await scheduler.requestResume({
  instanceId,
  resources: ["orders"],
  resumeAt: Date.now(),
  onResume: (resource) => warm(resource),
});
```

The first rejecting callback aborts the rest and rejects the call, so a resource that
refuses to come back is reported rather than skipped.

---

## 4. Operational checklist

| Concern                 | Check                                     | Tool                 |
| ----------------------- | ----------------------------------------- | -------------------- |
| Is it up?               | Liveness endpoint                         | `health`             |
| Should it take traffic? | Readiness endpoint                        | `health`             |
| Is it fast?             | p99 latency, slow-query list              | `metrics`, `monitor` |
| Is it correct?          | Backup verification, audit chain          | `backup`, `audit`    |
| Is it secure?           | Certificate expiry, key age, RBAC denials | `security`           |
| Is it within budget?    | SLO burn rate                             | `slacollector`       |
| Can I upgrade it?       | Quorum-safe sequencing                    | `rollingupgrade`     |

---

## 5. Testing your integration

Every package ships deterministic in-memory implementations (`InMemoryLogger`,
`InMemoryAuditStore`, `InMemoryStorageBackend`, `InMemoryEncryptionManager`, …) so your
tests need no external service. They are real implementations of the interfaces, not
mocks — the same contract tests that run against the S3 backend run against the in-memory
one.
