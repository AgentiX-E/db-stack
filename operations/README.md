# db-operations — Unified Database Operations Framework

**A production-grade, engine-agnostic operations abstraction layer — 3 packages, 3 239 test
cases in 154 files, every coverage dimension at or above 95 %.**

**Mutation score:** 98.03 % across seventeen files — the thirteen that decide what gets deleted,
whether a backup can be restored, which key material survives at all, which key a blob was sealed
with, whether a compliance window passed, whether evidence is tamper-evident, and when a maintenance
window runs, plus the four cluster assemblers that decide what a majority is, which member leaves,
which batch runs and which partition is emitted — `backupChain.ts` 100 %, `cron.ts` 100 %,
`RetentionPolicyEvaluator.ts` 100 %, `DurableFileSystem.ts` 100 %, `quorum.ts` 100 %,
`ClusterScalingExecutor.ts` 100 %, `RaftFaultTranslator.ts` 100 %, `KeyRotationManager.ts` 99.16 %,
`MaintenanceWindowScheduler.ts` 99.03 %, `InMemoryBackupManager.ts` 98.94 %,
`EnvelopeEncryptionProvider.ts` 98.18 %, `AES256GCMEncryptionProvider.ts` 97.53 %,
`RotationAuditor.ts` 97.52 %, `FileAuditStore.ts` 96.83 %, `AuditLogManager.ts` 96.44 %,
`KeyManager.ts` 94.12 %, `ClusterRolloutPlanner.ts` 94.03 %; gate at 86.

Of the 3 562 judged mutants, 70 are not kills and every one has an answer: 67 survived (each with an
argument in `docs/maturity.md`, grouped into families where one property explains several) and 3 no
test reaches. The 48 `Timeout` verdicts are replayed one by one, because there is no score that
answers "did a test object" for a run that stopped. The replay is
`node operations/scripts/resolve-timeouts.mjs --target operations --record`; the record it writes,
`mutation/timeouts.json`, is a cache that CI consults with `pnpm check:mutation-timeouts` — a known
abort is answered from it, an unknown one is replayed on the spot, and the build fails only if a suite
passes an abort, which would mean the score counted a detection nobody made.

Run it yourself with
`pnpm --filter @agentix-e/db-operations run test:mutation`.

Replace ad-hoc `ops/` directories with a canonical interface suite that every database
engine implements via adapters.

Package: `@agentix-e/db-operations`  
Version: 2.0.0  
License: MIT

---

## Quick Start

```bash
npm install @agentix-e/db-operations
```

```typescript
import { ProviderRegistry, token } from '@agentix-e/db-operations-node/core';
import type { ILogger } from '@agentix-e/db-operations-node/logger';
import { InMemoryLogger } from '@agentix-e/db-operations-node/logger';
import { HealthOrchestrator, componentProbe } from '@agentix-e/db-operations-node/health';
import { MetricsRegistry } from '@agentix-e/db-operations-node/metrics';
import {
  InMemoryBackupManager,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-operations-node/backup';

// 1. One registry, keyed by interface token rather than by class name.
const registry = new ProviderRegistry();
const ILoggerToken = token<ILogger>('ILogger');
registry.register(ILoggerToken, new InMemoryLogger('quick-start'));
const logger = registry.get<ILogger>(ILoggerToken);

// 2. Health: K8s-style probes built from plain functions.
const health = new HealthOrchestrator();
health.registerComponent(
  componentProbe('storage', 'Block storage', {
    liveness: () => ({ ok: true }),
    readiness: () => ({ ok: true, message: 'fsync p99 1.2 ms' }),
  }),
);
const readiness = health.readiness();

// 3. Metrics: series come from the registry, so one snapshot holds every
//    series this process exported.
const metrics = new MetricsRegistry();
metrics.counter('db_writes_total', { db: 'primary' }).inc();
metrics.histogram('db_query_seconds').observe(0.004);
const snapshot = metrics.snapshot();

// 4. Backups: a manager is a storage backend plus a retention policy — both are
//    interfaces, so the S3 backend swaps in without touching this code.
const backups = new InMemoryBackupManager(
  new InMemoryStorageBackend(),
  new RetentionPolicyEvaluator({
    maxFullSnapshots: 24,
    maxTotalBytes: 64 * 1024 ** 3,
    keepRecent: 'P7D',
  }),
);
const created = await backups.createBackup({ type: 'full' });

logger.info('operations ready', {
  ready: readiness.ok,
  series: snapshot.points.length,
  snapshotId: created.snapshot?.snapshotId,
});
```

---

## Why db-operations?

Every database engine needs: health checks, backup/restore, monitoring, security,
audit, metrics, logging, maintenance, auth, and observability.

Without a shared framework, each engine implements these from scratch — with
incompatible APIs, inconsistent error handling, and duplicated testing effort.

**db-operations solves this** with an interface-first, composable, pluggable
architecture that three packages deliver as a cohesive whole.

### Design Principles

1. **Engine-Agnostic Core** — Zero dependency on any engine type. Operations are defined
   in terms of abstract primitives (storage, topology, query workload).

2. **Interface-First Design** — Interfaces are stable contracts. Implementations are
   adapters that bridge the generic interface and engine-specific internals.

3. **Composability** — Small, focused interfaces compose into higher-level orchestration
   (e.g., `IHealthProbe` + `IComponentRegistrar` = `IHealthOrchestrator`).

4. **Pluggability** — Every interface can have multiple implementations:
   - `SqlVecXxxAdapter` — bridges to sqlvec-db
   - `GraphVecXxxAdapter` — bridges to graphvec-db
   - `NoopXxx` — no-op fallback for testing

5. **Production-Grade Everywhere** — Every interface includes error types,
   observability hooks, and capacity/state inspection methods.

---

## Packages

Three packages, split by the question each one answers.

| Package | Status | Tests | Description |
|---------|--------|-------|-------------|
| [`node`](./packages/node/) | ✅ | 2951 | Twenty modules whose implementation never needs to know how many nodes exist |
| [`cluster`](./packages/cluster/) | ✅ | 76 | Multi-node assembly: scaling against a live member set, rollout order, fault realisation |
| [`federation`](./packages/federation/) | ✅ | 212 | Cross-datacenter binding: `FederatedNode`, `FederatedQueryRouter` |

**Total: `pnpm coverage` reports 154 files and 3 239 tests, 0 failures** (`test:unit`: 135 files /
2 908; `test:integration`: 19 files / 331). Each row above is that package's contribution, so the
column adds up to the total. `pnpm check:test-counts` reads the runner's JSON report and fails when
any of these numbers disagrees with it — the table before iteration 54 had drifted by an order of
magnitude in both directions, and nothing compared it to a test run.

### What is in `node`

| Module | What it is |
|--------|-----------|
| `core` | Base types, provider registry, error hierarchy |
| `health` | Component probes, orchestration, K8s-style liveness |
| `logger` | Structured logging with levels, child loggers, backends |
| `metrics` | Counters, gauges, histograms with label support |
| `monitor` | Slow queries, deadlock detection, alerts, resource quotas |
| `backup` | Backup orchestration, PITR, retention policies, S3 backend |
| `maintenance` | VACUUM, ANALYZE, REINDEX scheduling |
| `auth` | Authentication providers and credential management (interfaces) |
| `security` | TLS, encryption, RBAC, rate limiting, compliance — implements `auth` |
| `audit` | Append-only audit trails with rotation and export |
| `observability` | Distributed tracing (W3C TraceContext), telemetry |
| `otel` | OpenTelemetry bridge for metrics and traces |
| `autotuner` | Automatic parameter tuning based on workload analysis |
| `autoscaler` | Scaling decisions from multi-dimensional metrics |
| `chaosengine` | Fault definitions and the chaos experiment runner |
| `circuitbreaker` | Circuit breaker pattern for external dependencies |
| `configwatcher` | Runtime configuration reload and validation |
| `memoryguard` | Memory pressure monitoring and GC optimisation |
| `rollingupgrade` | Upgrade plans, batching and health gating |
| `slacollector` | SLA metric collection and violation detection |

---

## Package Architecture

```
db-operations/
├── packages/
│   ├── node/              # @agentix-e/db-operations-node — 20 modules
│   │   └── src/
│   │       ├── core/      # Base types, provider registry, DI tokens
│   │       ├── health/    # Health probes (K8s-style liveness + deep readiness)
│   │       ├── metrics/   # Prometheus-style counters, gauges, histograms
│   │       ├── logger/    # Structured logging with trace context
│   │       ├── monitor/   # Slow query, deadlock, connection pool, alerts
│   │       ├── backup/    # Backup orchestration, PITR, S3 storage
│   │       ├── maintenance/   # VACUUM, ANALYZE, REINDEX scheduling
│   │       ├── auth/      # Authentication interfaces
│   │       ├── security/  # TLS, encryption, RBAC, rate limiting
│   │       ├── audit/     # Append-only audit trails with export
│   │       ├── observability/ # Distributed tracing (W3C TraceContext)
│   │       ├── otel/      # OpenTelemetry metrics/traces bridge
│   │       ├── autotuner/ # Workload-based auto-tuning
│   │       ├── autoscaler/# Scaling decisions
│   │       ├── chaosengine/   # Fault definitions and scenario runner
│   │       ├── circuitbreaker/ # Breaker state per call site
│   │       ├── configwatcher/  # Runtime config reload
│   │       ├── memoryguard/    # Memory pressure monitoring
│   │       ├── rollingupgrade/ # Upgrade plans and batching
│   │       └── slacollector/   # SLA metric tracking
│   ├── cluster/           # @agentix-e/db-operations-cluster — multi-node assembly
│   │   └── src/
│   │       ├── interfaces/    # ClusterMember, IClusterTopology
│   │       ├── membership/    # majority arithmetic, reference topology
│   │       ├── scaling/       # scale a decision against a live member set
│   │       ├── rollout/       # sequence an upgrade without losing quorum
│   │       └── chaos/         # realise a fault through IChaosTransport
│   └── federation/        # @agentix-e/db-operations-federation — cross-DC binding
├── docs/
│   ├── DESIGN.md
│   ├── ARCHITECTURE.md
│   ├── getting-started.md
│   └── testing.md
└── package.json
```

### Adapter Pattern

Each engine provides adapter implementations. These live inside the `monitor`
module but have zero engine dependency — they accept engine-specific config at
construction time:

```
packages/node/src/monitor/
  interfaces/     ← canonical interfaces (no engine deps)
  impl/           ← general-purpose implementations
  adapters/
    sqlvec/       ← SqlVecSlowQueryRecorder, SqlVecDeadlockDetector
    graphvec/     ← GraphVecSlowQueryRecorder, GraphVecDeadlockDetector
    noop/         ← NoopSlowQueryRecorder (testing)
```

---

## Interface Categories

| Category | Interfaces | Coverage |
|----------|-----------|----------|
| Health | IHealthProbe, IComponentRegistrar, IHealthOrchestrator | ✅ |
| Metrics | IMetricsRegistry, ICounter, IHistogram, IGauge | ✅ |
| Logger | ILogger, ITraceContextProvider | ✅ |
| Backup | IBackupManager, IPITRManager, IBackupScheduler, IStorageBackend, IBackupRetentionPolicy | ✅ |
| Migration | IMigrationProvider, IMigrationExecutor | Planned |
| Audit | IAuditStore, IAuditExporter | ✅ |
| Security | ITLSManager, ICertMonitor, IEncryptionManager, IRBACProvider, IRateLimiter | ✅ |
| Monitoring | ISlowQueryRecorder, IDeadlockDetector, IConnectionMonitor, IAlertRuleManager, IResourceQuotaManager | ✅ |
| Maintenance | IMaintenanceExecutor (VACUUM, ANALYZE, REINDEX) | ✅ |
| Observability | IDistributedTracer, ITelemetryExporter | ✅ |
| Scheduling | IScheduler | Planned |
| Config | IRuntimeConfigProvider | Planned |

---

## Testing

```bash
npm test              # 154 files, 3 239 tests
npm run test:mutation # Stryker over the thirteen modules that decide deletion, durability and timing
npm run bench         # Performance benchmarks
npm run bench:ycsb    # YCSB-style benchmarks
npm run typecheck     # TypeScript strict type checking
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
