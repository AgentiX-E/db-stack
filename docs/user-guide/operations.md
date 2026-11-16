# Operations guide

`@agentix-e/db-operations` is an **engine-agnostic operations framework**: 21 independently
publishable packages that give every database the same operational surface — health,
backup, metrics, security, maintenance, upgrades — without tying your application to one
vendor's admin API.

```bash
npm install @agentix-e/db-operations
# or install only what you need
npm install @agentix-e/db-operations-health @agentix-e/db-operations-metrics
```

---

## 1. The provider registry is the seam

Every package resolves its dependencies through typed tokens rather than constructors:

```ts
import { ProviderRegistry, token } from "@agentix-e/db-operations-core";
import { HealthOrchestrator } from "@agentix-e/db-operations-health";
import { InMemoryLogger, type ILogger } from "@agentix-e/db-operations-logger";

const registry = new ProviderRegistry();
registry.register(
  token<ILogger>("ILogger"),
  new InMemoryLogger({ level: "info" }),
);

const health = new HealthOrchestrator({ registry });
await health.runAllChecks();
```

Why this matters: the same code runs in tests, staging and production with different
implementations, and swapping a database engine means registering different providers —
not editing call sites.

---

## 2. Package map

| Package          | What it gives you                                                        | Key entry points                                                                                              |
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
| `chaosengine`    | Fault injection for your own test suites                                 | fault schedules                                                                                               |
| `backup`         | Full/incremental backup abstractions, integrity verification             | `BackupManager`, `S3StorageBackend`, `InMemoryStorageBackend`, `BackupVerifier`                               |
| `maintenance`    | VACUUM/ANALYZE/REINDEX windows and scheduling                            | `MaintenanceWindowScheduler`                                                                                  |
| `security`       | TLS, key management, encryption at rest, RBAC, rate limiting, compliance | `KeyManager`, `KeyRotationManager`, `EnvelopeEncryptionProvider`, `AES256GCMEncryptionProvider`, `RBACEngine` |
| `auth`           | Authentication providers and session tokens                              | provider interfaces, JWT/static providers                                                                     |
| `audit`          | Tamper-evident audit log, export, query                                  | `InMemoryAuditStore`, `FileAuditStore`, `JsonAuditExporter`                                                   |
| `autoscaler`     | Reactive + predictive scaling decisions                                  | `AutoScaler`, `PredictiveScalingEngine`                                                                       |
| `autotuner`      | Configuration tuning from observed load                                  | `AutoTunerWorker`                                                                                             |
| `configwatcher`  | Live configuration reload with validation                                | watchers, validators                                                                                          |
| `rollingupgrade` | Quorum-safe rolling upgrade orchestration                                | `RollingUpgradeOrchestrator`                                                                                  |
| `slacollector`   | SLI recording and SLO/error-budget computation                           | `SLACollector`                                                                                                |
| `federation`     | Cross-cluster schema federation and query planning                       | schema registry, query planner                                                                                |

---

## 3. Recipes

### 3.1 Health that distinguishes liveness from readiness

```ts
import {
  HealthOrchestrator,
  ComponentProbe,
} from "@agentix-e/db-operations-health";

const health = new HealthOrchestrator({ registry });

health.register(
  "storage",
  new ComponentProbe({
    liveness: async () => (await storage.ping()) === "ok",
    readiness: async () => (await storage.replicaLagMs()) < 5_000,
  }),
);

const status = await health.runAllChecks();
// { status: 'healthy' | 'degraded' | 'unhealthy', components: {...} }
```

A failing **liveness** probe means "restart me". A failing **readiness** probe means "stop
sending traffic". Wiring both to the same check is the most common way to turn a slow
replica into a restart loop.

### 3.2 Metrics

```ts
import {
  MetricsRegistry,
  Counter,
  Histogram,
} from "@agentix-e/db-operations-metrics";

const registry = new MetricsRegistry();
const writes = new Counter({
  name: "db_writes_total",
  help: "Committed writes",
});
const latency = new Histogram({
  name: "db_write_seconds",
  buckets: [0.001, 0.005, 0.02, 0.1],
});

registry.register(writes);
registry.register(latency);
writes.inc();
latency.observe(0.004);
const text = registry.toPrometheusText();
```

### 3.3 Backup with verification

```ts
import {
  BackupManager,
  S3StorageBackend,
  BackupVerifier,
} from "@agentix-e/db-operations-backup";

const backups = new BackupManager({
  storage: new S3StorageBackend({ bucket: "db-backups", region: "eu-west-1" }),
  engine: myEngineBackupAdapter,
});

const manifest = await backups.create({ label: "nightly" });
const report = await new BackupVerifier().verifyStream(
  await backups.openStream(manifest.id),
);
if (!report.passed)
  throw new Error(`backup ${manifest.id} failed verification: ${report.error}`);
```

Verify on creation **and** on a schedule — a backup that was never restored is a hypothesis,
not a backup.

#### Retention: floors are floors

```ts
import { RetentionPolicyEvaluator } from "@agentix-e/db-operations-backup";

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

Four rules apply, in this order: keep the newest `maxFullSnapshots` full snapshots (incremental
snapshots are never promoted into a full's slot), remove nothing younger than `keepRecent`,
remove only what is at least `minAge` old, then remove the oldest still-removable snapshots until
the total fits under `maxTotalBytes`.

`keepRecent` and `minAge` are **prohibitions, not preferences**. That matters when they conflict
with the byte ceiling: the floors win, and the difference is reported as `unreclaimedBytes`. The
alternative — deleting a one-hour-old backup to satisfy a size limit — is how a retention policy
turns into data loss.

Durations are read as ISO-8601 (`P7D`, `PT1H`, `PT30M`, `PT30S`, `P1DT2H3M4S`) or as a plain
number of hours (`"48"`). Anything else throws where the policy is written, in the constructor or
in `updateConfig`, because a floor that silently means zero protects nothing.

`evaluate()` is the interface method and returns the delete list alone; `evaluateWithOutcome()`
adds the report.

### 3.4 Encryption at rest with rotation

```ts
import {
  KeyManager,
  EnvelopeEncryptionProvider,
  KeyRotationManager,
} from "@agentix-e/db-operations-security";

const keys = new KeyManager({ provider: "file", path: "/etc/db/keys" });
const encryption = new EnvelopeEncryptionProvider({ keyManager: keys });
const rotation = new KeyRotationManager({ keyManager: keys, maxAgeDays: 90 });
await rotation.rotateIfDue();
```

Envelope encryption keeps the data key separate from the master key, so rotation rewraps
data keys instead of rewriting the database.

### 3.5 Audit trail

```ts
import { FileAuditStore } from "@agentix-e/db-operations-audit";

// `dataDir` is the directory, not a file: the store rotates within it
// (audit-YYYYMMDD-0001.ndjson, then .ndjson.gz) and creates it if absent.
const audit = new FileAuditStore({
  dataDir: "/var/log/db",
  maxAgeMs: 24 * 60 * 60 * 1000,
});

await audit.write({
  operation: "config.update",
  actor: "alice",
  resource: "replica-set",
  result: "success",
  severity: "info",
  details: { setting: "max_connections", from: 100, to: 200 },
});

const recent = await audit.query({ actor: "alice", limit: 50 });

// Rotation compresses the previous segment in the background. `close()` waits for
// it, so a shutdown never leaves a half-written archive behind.
await audit.close();
```

`query()`, `get()` and `count()` read archived (`.ndjson.gz`) segments as well as the
active one, so rotation does not make history disappear from the API — the entries stay
on disk and stay readable. The scan is bounded by `maxScanLines` (default 10 000) across
all segments in filename order, which is chronological; raise it if you query a long
retention window, and use `pruneOlderThan()` to bound the directory instead of letting
the scan bound your history.

A segment that cannot be decoded is skipped rather than aborting the query: a damaged
archive costs you those entries, not the whole trail. A segment being archived is counted
once — the archive wins over the original that is about to be removed.

Audit entries are hash-chained; tampering with an earlier record breaks verification of
everything after it. `close()` is optional on `IAuditStore` — in-memory stores have
nothing to drain — but a file-backed store should be closed before the directory it owns
is moved or deleted.

### 3.6 Rolling upgrade

```ts
import { RollingUpgradeOrchestrator } from "@agentix-e/db-operations-rollingupgrade";

const upgrade = new RollingUpgradeOrchestrator({
  cluster,
  targetVersion: "1.2.0",
  maxUnavailable: 1,
});
await upgrade.run();
```

The orchestrator refuses to proceed if it would lose quorum, gates each step on health, and
aborts (rather than continuing) on the first unhealthy node.

### 3.7 Maintenance windows

```ts
import { MaintenanceWindowScheduler } from "@agentix-e/db-operations-maintenance";

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
