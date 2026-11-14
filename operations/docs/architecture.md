# db-operations Architecture

## Overview

db-operations is a monorepo of 11 packages that provide a unified, engine-agnostic operations layer for database systems. It sits between application code and database engines (sqlvec-db, graphvec-db), translating generic operational commands into engine-specific implementations.

## Layers

```
┌────────────────────────────────────────────────────┐
│                  Consumer                            │
│  (application, orchestrator, operator dashboard)    │
├────────────────────────────────────────────────────┤
│           db-operations Interfaces                   │
│  IHealthProbe  │  IBackupManager  │  IAuditStore    │
│  ISlowQuery    │  ITracer         │  IRateLimiter   │
│  ... (15+ interfaces)                               │
├────────────────────────────────────────────────────┤
│           db-operations InMemory Impls               │
│  (testing, development, low-volume)                  │
├────────────────────────────────────────────────────┤
│              Adapter Layer                            │
│  SqlVecAdapter(engine) → GraphVecAdapter(engine)     │
├────────────────────────────────────────────────────┤
│              Database Engines                         │
│  sqlvec-db     │  graphvec-db    │  others (future)  │
└────────────────────────────────────────────────────┘
```

## Package Dependency Graph

```
        ┌─────────┐
        │  core   │ ◄── foundation (types, provider)
        └────┬────┘
             │
   ┌─────────┼─────────┬──────────┬──────────┐
   ▼         ▼         ▼          ▼          ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌──────────┐
│health│ │logger│ │auth  │ │backup  │ │observa-  │
└──────┘ └──────┘ └──────┘ └────────┘ │bility    │
                                       └──────────┘
   │         │         │          │          │
   │         │         ├──────────┤          │
   ▼         ▼         ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌──────────┐ ┌───────────┐
│metric│ │monitor │ │security  │ │maintenance │
└──────┘ └────────┘ └──────────┘ └───────────┘
   │         │         │
   └─────────┴─────────┘
             │
             ▼
        ┌───────┐
        │ audit │
        └───────┘
```

## Interface Categories

### Observability (read)
| Interface | Responsibility | Output |
|-----------|---------------|--------|
| `IHealthProbe` | Component health | HealthStatus |
| `IComponentRegistrar` | Component lifecycle | Registration |
| `IHealthOrchestrator` | Aggregate health | CompositeStatus |
| `ISlowQueryRecorder` | Slow query capture | QueryEntry[] |
| `IConnectionMonitor` | Connection pool | PoolState |
| `IMetricsRegistry` | Counters/gauges/histograms | MetricPoint[] |
| `ILogger` | Structured logging | LogEntry[] |

### Control (write)
| Interface | Responsibility | Output |
|-----------|---------------|--------|
| `IBackupManager` | Backup create/restore/prune | BackupResult |
| `IPITRManager` | Point-in-time recovery | PITRResult |
| `IMaintenanceExecutor` | VACUUM/ANALYZE/REINDEX | MaintenanceResult |
| `IAuditStore` | Immutable audit log | AuditEntry[] |
| `IAuditExporter` | Audit log export | ExportResult |

### Security
| Interface | Responsibility | Output |
|-----------|---------------|--------|
| `IAuthProvider` | Authentication | AuthResult |
| `ITLSManager` | TLS config | TLSConfig |
| `ICertMonitor` | Cert lifecycle | CertStatus |
| `IEncryptionManager` | Encrypt/decrypt | EncryptionResult |
| `IRBACProvider` | Role-based access | PermissionResult |
| `IRateLimiter` | Request throttling | RateLimitResult |
| `ISecurityCompliance` | Compliance checks | ComplianceReport |
| `ISCIMSyncProvider` | User/group sync | SyncResult |

### Monitoring & Alerts
| Interface | Responsibility | Output |
|-----------|---------------|--------|
| `IAlertRuleManager` | Alert rules | AlertStatus |
| `IResourceQuotaManager` | Resource limits | QuotaStatus |
| `IDeadlockDetector` | Deadlock detection | DeadlockReport |

### Observability (distributed)
| Interface | Responsibility | Output |
|-----------|---------------|--------|
| `IDistributedTracer` | Trace context | Span |
| `ITelemetryExporter` | Export telemetry | ExportResult |

## Adapter Pattern

Every interface in db-operations is designed to have multiple implementations:

```typescript
// Interface defined in canonical location
interface IBackupManager {
  createBackup(type: BackupType, options?: BackupOptions): Promise<BackupResult>;
  listBackups(filter?: BackupFilter): Promise<BackupMetadata[]>;
  restoreBackup(snapshotId: string): Promise<RestoreResult>;
}

// InMemory implementation (testing/development)
class InMemoryBackupManager implements IBackupManager { /* Map-based storage */ }

// Noop implementation (production fallback)
class NoopBackupManager implements IBackupManager { /* returns NotImplemented */ }

// SqlVec adapter (bridges to sqlvec-db internals)
class SqlVecBackupAdapter implements IBackupManager { /* delegates to sqlvec-db */ }

// GraphVec adapter (bridges to graphvec-db internals)
class GraphVecBackupAdapter implements IBackupManager { /* delegates to graphvec-db */ }
```

## Provider Registry

The `ProviderRegistry` is the IoC container that ties implementations to consumers:

```typescript
const registry = new ProviderRegistry();

// Register implementations
registry.register(token<IHealthProbe>('IHealthProbe'), new ComponentProbe(registry));
registry.register(token<IEncryptionManager>('IEncryptionManager'), new InMemoryEncryptionManager());

// Consume in composed services
class HealthOrchestrator {
  constructor(registry: IProviderRegistry) {
    this.probe = registry.get(token<IComponentRegistrar>('IComponentRegistrar'));
  }
}
```

## Design Decisions

### Why not a single mega-interface?
Each operational concern has distinct lifecycles, error modes, and configuration surfaces. Monolithic interfaces create coupling and make partial implementations impossible.

### Why InMemory implementations?
InMemory impls serve as:
1. **Reference implementations** — contract compliance examples
2. **Test doubles** — fast, deterministic, no external deps
3. **Development path** — prototype with InMemory, replace with adapter later
4. **Benchmark baseline** — pure in-memory ops define the performance floor

### Why ProviderRegistry instead of DI container?
ProviderRegistry is intentionally minimal — just register/resolve with priorities and lifecycle hooks. Adding a full DI container (typedi, inversify) would introduce runtime deps and configuration complexity that isn't needed.

## Testing Strategy

See [testing strategy](./testing.md) for the full 7-dimension test framework.
