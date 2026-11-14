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
import { ProviderRegistry, token } from '@agentix-e/db-operations-core';
import { HealthOrchestrator } from '@agentix-e/db-operations-health';
import { InMemoryLogger, type ILogger } from '@agentix-e/db-operations-logger';

const registry = new ProviderRegistry();
registry.register(token<ILogger>('ILogger'), new InMemoryLogger({ level: 'info' }));

const health = new HealthOrchestrator({ registry });
await health.runAllChecks();
```

Why this matters: the same code runs in tests, staging and production with different
implementations, and swapping a database engine means registering different providers —
not editing call sites.

---

## 2. Package map

| Package | What it gives you | Key entry points |
|---|---|---|
| `core` | Registry, tokens, lifecycle, shared types | `ProviderRegistry`, `token`, `LifecyclePhase` |
| `logger` | Structured logs with trace context | `InMemoryLogger`, `PinoLogger`, `NoopLogger` |
| `observability` | Distributed tracing, W3C trace context | `InMemoryDistributedTracer`, `W3CTraceContext` |
| `otel` | OpenTelemetry bridge | exporters, span processors |
| `health` | Liveness/readiness probes and orchestration | `HealthOrchestrator`, `ComponentProbe` |
| `monitor` | Slow queries, deadlocks, connections, alerts, quotas | monitors + alert manager |
| `metrics` | Counter, gauge, histogram, registry | `MetricsRegistry`, `Counter`, `Histogram` |
| `circuitbreaker` | Failure isolation with half-open probing | breaker factory, state listeners |
| `memoryguard` | Heap pressure detection and shedding | guard policies |
| `chaosengine` | Fault injection for your own test suites | fault schedules |
| `backup` | Full/incremental backup abstractions, integrity verification | `BackupManager`, `S3StorageBackend`, `InMemoryStorageBackend`, `BackupVerifier` |
| `maintenance` | VACUUM/ANALYZE/REINDEX windows and scheduling | `MaintenanceWindowScheduler` |
| `security` | TLS, key management, encryption at rest, RBAC, rate limiting, compliance | `KeyManager`, `KeyRotationManager`, `EnvelopeEncryptionProvider`, `AES256GCMEncryptionProvider`, `RBACEngine` |
| `auth` | Authentication providers and session tokens | provider interfaces, JWT/static providers |
| `audit` | Tamper-evident audit log, export, query | `InMemoryAuditStore`, `FileAuditStore`, `JsonAuditExporter` |
| `autoscaler` | Reactive + predictive scaling decisions | `AutoScaler`, `PredictiveScalingEngine` |
| `autotuner` | Configuration tuning from observed load | `AutoTunerWorker` |
| `configwatcher` | Live configuration reload with validation | watchers, validators |
| `rollingupgrade` | Quorum-safe rolling upgrade orchestration | `RollingUpgradeOrchestrator` |
| `slacollector` | SLI recording and SLO/error-budget computation | `SLACollector` |
| `federation` | Cross-cluster schema federation and query planning | schema registry, query planner |

---

## 3. Recipes

### 3.1 Health that distinguishes liveness from readiness

```ts
import { HealthOrchestrator, ComponentProbe } from '@agentix-e/db-operations-health';

const health = new HealthOrchestrator({ registry });

health.register('storage', new ComponentProbe({
  liveness: async () => (await storage.ping()) === 'ok',
  readiness: async () => (await storage.replicaLagMs()) < 5_000,
}));

const status = await health.runAllChecks();
// { status: 'healthy' | 'degraded' | 'unhealthy', components: {...} }
```

A failing **liveness** probe means "restart me". A failing **readiness** probe means "stop
sending traffic". Wiring both to the same check is the most common way to turn a slow
replica into a restart loop.

### 3.2 Metrics

```ts
import { MetricsRegistry, Counter, Histogram } from '@agentix-e/db-operations-metrics';

const registry = new MetricsRegistry();
const writes = new Counter({ name: 'db_writes_total', help: 'Committed writes' });
const latency = new Histogram({ name: 'db_write_seconds', buckets: [0.001, 0.005, 0.02, 0.1] });

registry.register(writes); registry.register(latency);
writes.inc(); latency.observe(0.004);
const text = registry.toPrometheusText();
```

### 3.3 Backup with verification

```ts
import { BackupManager, S3StorageBackend, BackupVerifier } from '@agentix-e/db-operations-backup';

const backups = new BackupManager({
  storage: new S3StorageBackend({ bucket: 'db-backups', region: 'eu-west-1' }),
  engine: myEngineBackupAdapter,
});

const manifest = await backups.create({ label: 'nightly' });
const report = await new BackupVerifier().verifyStream(await backups.openStream(manifest.id));
if (!report.passed) throw new Error(`backup ${manifest.id} failed verification: ${report.error}`);
```

Verify on creation **and** on a schedule — a backup that was never restored is a hypothesis,
not a backup.

### 3.4 Encryption at rest with rotation

```ts
import { KeyManager, EnvelopeEncryptionProvider, KeyRotationManager } from '@agentix-e/db-operations-security';

const keys = new KeyManager({ provider: 'file', path: '/etc/db/keys' });
const encryption = new EnvelopeEncryptionProvider({ keyManager: keys });
const rotation = new KeyRotationManager({ keyManager: keys, maxAgeDays: 90 });
await rotation.rotateIfDue();
```

Envelope encryption keeps the data key separate from the master key, so rotation rewraps
data keys instead of rewriting the database.

### 3.5 Audit trail

```ts
import { FileAuditStore } from '@agentix-e/db-operations-audit';

const audit = new FileAuditStore({ path: '/var/log/db/audit.jsonl' });
await audit.append({ action: 'config.update', actor: { id: 'alice' }, resource: { id: 'replica-set' },
  severity: 'info', category: 'admin', message: 'increased max_connections' });
const page = await audit.query({ search: 'max_connections', sortBy: 'timestamp', sortDir: 'desc' });
```

Audit entries are hash-chained; tampering with an earlier record breaks verification of
everything after it.

### 3.6 Rolling upgrade

```ts
import { RollingUpgradeOrchestrator } from '@agentix-e/db-operations-rollingupgrade';

const upgrade = new RollingUpgradeOrchestrator({ cluster, targetVersion: '1.2.0', maxUnavailable: 1 });
await upgrade.run();
```

The orchestrator refuses to proceed if it would lose quorum, gates each step on health, and
aborts (rather than continuing) on the first unhealthy node.

---

## 4. Operational checklist

| Concern | Check | Tool |
|---|---|---|
| Is it up? | Liveness endpoint | `health` |
| Should it take traffic? | Readiness endpoint | `health` |
| Is it fast? | p99 latency, slow-query list | `metrics`, `monitor` |
| Is it correct? | Backup verification, audit chain | `backup`, `audit` |
| Is it secure? | Certificate expiry, key age, RBAC denials | `security` |
| Is it within budget? | SLO burn rate | `slacollector` |
| Can I upgrade it? | Quorum-safe sequencing | `rollingupgrade` |

---

## 5. Testing your integration

Every package ships deterministic in-memory implementations (`InMemoryLogger`,
`InMemoryAuditStore`, `InMemoryStorageBackend`, `InMemoryEncryptionManager`, …) so your
tests need no external service. They are real implementations of the interfaces, not
mocks — the same contract tests that run against the S3 backend run against the in-memory
one.
