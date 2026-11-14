# Architecture

## Position in the Framework

`@agentix-e/db-operations-core` is the **root dependency** of the entire db-operations framework. Every other package depends on it for shared type definitions and the provider registry pattern.

```
┌─────────────────────────────────────────────────────────┐
│                    db-operations-core                   │
│  ┌──────────────┬──────────────┬────────────────────┐   │
│  │  TypeDefs    │  Provider    │  Lifecycle         │   │
│  │  (All types) │  Registry    │  Management        │   │
│  └──────────────┴──────────────┴────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                    Layer Packages                        │
│  health  logger  metrics  backup  auth                  │
│  monitor maint.  security audit  observability          │
├─────────────────────────────────────────────────────────┤
│                    Application Layer                     │
│          (orchestrates via ProviderRegistry)              │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Engine-agnostic types** — All types are domain abstractions that apply equally to SQL, NoSQL, Graph, and in-memory engines. No `TableInfo` or `CollectionStats` — only generic constructs like `StorageStats` and `ConnectionPoolStatus`.

2. **Provider Registry as composition root** — Rather than hard-coding dependencies, packages register their implementations with the central `ProviderRegistry`. At startup, the application resolves all dependencies through the registry.

3. **Token-based lookup** — Each interface is identified by a unique `InterfaceToken<T>`. This provides both type safety and runtime diagnostic information.

4. **Priority-based overrides** — When multiple providers exist for the same token (e.g., a default and a custom health probe), the highest-priority one wins. This allows a clean override pattern.

## Type Organization

Types are grouped by domain in `types.ts`:

- **Health** — `ProbeResult`, `ComponentHealth`, `HealthStatus`
- **Metrics** — `MetricPoint`, `MetricLabel`, `MetricsSnapshot`
- **Backup** — `BackupMetadata`, `BackupResult`, `RestoreResult`, `PITRTarget`, `RetentionPolicy`, `SnapshotType`, `SnapshotState`
- **Audit** — `AuditEntry`, `AuditSeverity`
- **Security** — `CertInfo`, `CertWarningLevel`, `SecurityCheck`
- **Monitor** — `ConnectionPoolStatus`, `ResourceUsageSnapshot`, `SlowQueryEntry`, `DeadlockEvent`, `AlertRule`, `AlertSeverity`
- **Maintenance** — `MaintenanceResult`, `StorageStats`, `IndexFragmentation`
- **Data** — `ImportExportFormat`, `ImportResult`, `ExportResult`
- **Replication** — `ReplicationTargetStatus`, `ReplicationStatus`, `LagLevel`
- **Migration** — `MigrationDescriptor`, `MigrationPlan`, `MigrationState`
- **Engine/Lifecycle** — `EngineType`, `LifecyclePhase`

## Provider Registration Flow

```
Application Startup
        │
        ▼
Create ProviderRegistry
        │
        ▼
For each engine module:
  - Create provider instance(s)
  - registry.register(token, instance, { engineType, priority, name })
        │
        ▼
registry.registerAll([...])  // optional: bulk register
        │
        ▼
await registry.start()  // calls start() on all IProviderLifecycle instances
        │
        ▼
Application code uses registry.get<T>(token) to resolve dependencies
```

## Lifecycle Management

The registry tracks its own lifecycle phase (`created → starting → started → stopping → stopped → failed`). When `start()` is called, all registered providers that implement `IProviderLifecycle` are started in priority order. `stop()` stops them in reverse priority order. If any provider fails during start, a `ProviderStartError` is thrown with detailed failure info.
