# db-operations — Unified Database Operations Framework

**A production-grade, engine-agnostic operations abstraction layer — 21 packages, 3 149 test
cases in 146 files, every coverage dimension at or above 95 %.**

**Mutation score:** 97.96 % across the thirteen modules that decide what gets deleted, whether a
backup can be restored, which key material survives at all, which key a blob was sealed with,
whether a compliance window passed, whether evidence is tamper-evident, and when a maintenance
window runs — `backupChain.ts` 100 %, `cron.ts` 100 %, `RetentionPolicyEvaluator.ts` 100 %,
`DurableFileSystem.ts` 100 %, `KeyRotationManager.ts` 99.16 %, `MaintenanceWindowScheduler.ts`
99.03 %, `InMemoryBackupManager.ts` 98.94 %, `AES256GCMEncryptionProvider.ts` 97.53 %,
`RotationAuditor.ts` 97.52 %, `EnvelopeEncryptionProvider.ts` 98.18 %, `FileAuditStore.ts`
96.97 %, `AuditLogManager.ts` 96.44 %, `KeyManager.ts` 94.12 %; gate at 86.

Of the 2 992 judged mutants, 102 are not kills and every one has an answer: 58 survived (each with
an argument in `docs/maturity.md` — sixteen families, no test can tell the versions apart), 41 are
`Timeout` verdicts that were replayed one by one (5 fail when asked again, 36 are loops no timer can
interrupt, **0 pass**), and 3 no test reaches. The replay is
`node operations/scripts/resolve-timeouts.mjs --target operations --record`; the record it writes,
`mutation/timeouts.json`, is checked against the report on every CI run by
`pnpm check:mutation-timeouts`, so an abort nobody read fails the build.

Run it yourself with
`pnpm --filter @agentix-e/db-operations run test:mutation`.

Replace ad-hoc `ops/` directories with a canonical interface suite that every database
engine implements via adapters.

Package: `@agentix-e/db-operations`  
Version: 1.11.3  
License: MIT

---

## Quick Start

```bash
npm install @agentix-e/db-operations
```

```typescript
import { ProviderRegistry, token } from '@agentix-e/db-operations-core';
import { HealthOrchestrator, ComponentProbe } from '@agentix-e/db-operations-health';
import { InMemoryLogger } from '@agentix-e/db-operations-logger';
import { MetricsRegistry, Counter, Histogram } from '@agentix-e/db-operations-metrics';
import { BackupManager, S3StorageBackend } from '@agentix-e/db-operations-backup';
import { AutoTunerWorker } from '@agentix-e/db-operations-autotuner';

// 1. Create provider registry
const registry = new ProviderRegistry();
const ILogger = token<ILogger>('ILogger');
registry.register(ILogger, new InMemoryLogger({ level: 'info' }));

// 2. Set up health checks
const health = new HealthOrchestrator({ registry });
health.register('storage', new ComponentProbe({ check: checkStorage }));
const status = await health.runAllChecks();

// 3. Export metrics
const metrics = new MetricsRegistry();
const writes = new Counter({ name: 'db_writes_total', help: 'Total writes' });
metrics.register(writes);

// 4. Schedule backups
const backup = new BackupManager({
  storage: new S3StorageBackend({ bucket: 'my-backups', region: 'us-east-1' }),
  schedule: { intervalMs: 3600_000, retentionCount: 24 },
});
await backup.start();
```

---

## Why db-operations?

Every database engine needs: health checks, backup/restore, monitoring, security,
audit, metrics, logging, maintenance, auth, and observability.

Without a shared framework, each engine implements these from scratch — with
incompatible APIs, inconsistent error handling, and duplicated testing effort.

**db-operations solves this** with an interface-first, composable, pluggable
architecture that 20 packages deliver as a cohesive whole.

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

| Package | Status | Tests | Description |
|---------|--------|-------|-------------|
| [`core`](./packages/core/) | ✅ | 22 | Base types, provider registry, error hierarchy |
| [`health`](./packages/health/) | ✅ | 23 | Component probes, orchestration, K8s-style liveness |
| [`logger`](./packages/logger/) | ✅ | 19 | Structured logging with levels, child loggers, backends |
| [`metrics`](./packages/metrics/) | ✅ | 21 | Counters, gauges, histograms with label support |
| [`monitor`](./packages/monitor/) | ✅ | 38 | Slow queries, deadlock detection, alerts, resource quotas |
| [`backup`](./packages/backup/) | ✅ | 30 | Backup orchestration, PITR, retention policies, S3 backend |
| [`maintenance`](./packages/maintenance/) | ✅ | 29 | VACUUM, ANALYZE, REINDEX scheduling |
| [`auth`](./packages/auth/) | ✅ | 32 | Authentication providers and credential management |
| [`security`](./packages/security/) | ✅ | 42 | TLS, encryption, RBAC, rate limiting, compliance |
| [`audit`](./packages/audit/) | ✅ | 20 | Immutable audit trails with export |
| [`observability`](./packages/observability/) | ✅ | 21 | Distributed tracing (W3C TraceContext), telemetry |
| [`otel`](./packages/otel/) | ✅ | 18 | OpenTelemetry bridge for metrics and traces |
| [`autotuner`](./packages/autotuner/) | ✅ | 15 | Automatic parameter tuning based on workload analysis |
| [`autoscaler`](./packages/autoscaler/) | ✅ | 12 | Dynamic resource scaling based on metrics |
| [`chaosengine`](./packages/chaosengine/) | ✅ | 14 | Fault injection and chaos experiment runner |
| [`circuitbreaker`](./packages/circuitbreaker/) | ✅ | 11 | Circuit breaker pattern for external dependencies |
| [`configwatcher`](./packages/configwatcher/) | ✅ | 10 | Runtime configuration reload and validation |
| [`memoryguard`](./packages/memoryguard/) | ✅ | 9 | Memory pressure monitoring and GC optimization |
| [`rollingupgrade`](./packages/rollingupgrade/) | ✅ | 16 | Zero-downtime rolling upgrades |
| [`slacollector`](./packages/slacollector/) | ✅ | 13 | SLA metric collection and violation detection |

**Total: `pnpm coverage` reports 128 files and 2 956 tests, 0 failures** (`test:unit`: 109 files /
2 625; `test:integration`: 19 files / 331). The per-package counts above are the units each
package contributes.

---

## Package Architecture

```
db-operations/
├── packages/
│   ├── core/              # Base types, provider registry, DI tokens
│   ├── health/            # Health probes (K8s-style liveness + deep readiness)
│   ├── metrics/           # Prometheus-style counters, gauges, histograms
│   ├── logger/            # Structured logging with trace context
│   ├── monitor/           # Slow query, deadlock, connection pool, alerts
│   ├── backup/            # Backup orchestration, PITR, S3 storage
│   ├── maintenance/       # VACUUM, ANALYZE, REINDEX scheduling
│   ├── auth/              # Authentication and credential management
│   ├── security/          # TLS, encryption, RBAC, rate limiting
│   ├── audit/             # Immutable audit trails with export
│   ├── observability/     # Distributed tracing (W3C TraceContext)
│   ├── otel/              # OpenTelemetry metrics/traces bridge
│   ├── autotuner/         # Workload-based auto-tuning
│   ├── autoscaler/        # Dynamic resource scaling
│   ├── chaosengine/       # Chaos experiment framework
│   ├── circuitbreaker/    # Circuit breaker for external deps
│   ├── configwatcher/     # Runtime config reload
│   ├── memoryguard/       # Memory pressure monitoring
│   ├── rollingupgrade/    # Zero-downtime upgrades
│   └── slacollector/      # SLA metric tracking
├── docs/
│   ├── DESIGN.md
│   ├── ARCHITECTURE.md
│   ├── getting-started.md
│   └── testing.md
└── package.json
```

### Adapter Pattern

Each engine provides adapter implementations. These live inside db-operations
but have zero engine dependency — they accept engine-specific config at
construction time:

```
packages/monitor/src/
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
npm test              # 146 files, 3 149 tests
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
