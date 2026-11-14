# @agentix-e/db-operations-core

**Core types, provider registry, and base interfaces for the db-operations framework.**

This package provides the foundational building blocks that all other db-operations packages depend on: a complete set of engine-agnostic type definitions for backup, health, metrics, audit, security, monitoring, maintenance, logging, and observability operations, plus a generic provider registry for runtime-switchable implementations.

---

## Features

- **Canonical type definitions** — Over 40+ types covering backup, health, metrics, audit, monitoring, security, maintenance, replication, and schema migration
- **Provider registry** (Service Locator pattern) — Register, look up, and manage typed providers via `InterfaceToken<T>`
- **Lifecycle management** — Orchestrate `start()` / `stop()` across all registered providers
- **Engine-agnostic** — All types are domain abstractions (e.g., `BackupMetadata`, `HealthStatus`, `ProbeResult`) without any SQL/NoSQL/Graph engine dependencies
- **Priority-based conflict resolution** — Higher-priority providers override lower-priority ones for the same token
- **Lazy initialization** — Providers can be created on first access via the registry

---

## Installation

```bash
npm install @agentix-e/db-operations-core
```

---

## Quick Start

```typescript
import { token, ProviderRegistry } from '@agentix-e/db-operations-core';

// 1. Define an interface token
const IHealthProbe = token<IHealthProbe>('health.probe');

// 2. Create a registry and register providers
const registry = new ProviderRegistry();
registry.register(IHealthProbe, myProbeImpl, {
  engineType: 'sqlvec',
  priority: 10,
  name: 'sqlvec-health-probe',
});

// 3. Look up and use the provider
const probe = registry.get(IHealthProbe);
console.log(probe.liveness());

// 4. Start/stop lifecycle-managed providers
await registry.start();
// ... use the system ...
await registry.stop();
```

---

## API Reference

### Types (`@agentix-e/db-operations-core/types`)

| Type | Description |
|---|---|
| `EngineType` | `'sqlvec'` \| `'graphvec'` \| `'custom'` |
| `LifecyclePhase` | `'created'` \| `'starting'` \| `'started'` \| `'stopping'` \| `'stopped'` \| `'failed'` |
| `ProbeResult` | `{ ok: boolean; message?: string; details?: Record<string, unknown> }` |
| `ComponentHealth` | Composite health for a registered component (liveness + readiness + uptime) |
| `HealthStatus` | Aggregate health with `'healthy'` \| `'degraded'` \| `'unhealthy'` status |
| `MetricType` | `'counter'` \| `'gauge'` \| `'histogram'` \| `'summary'` |
| `MetricLabel` | `{ key: string; value: string }` |
| `MetricPoint` | A single metric datapoint with labels and timestamp |
| `MetricsSnapshot` | Full snapshot of all current metrics |
| `SnapshotType` | `'full'` \| `'incremental'` \| `'logical'` |
| `SnapshotState` | Full lifecycle of a backup snapshot |
| `BackupMetadata` | Metadata for a backup snapshot |
| `BackupResult` | Backup operation result |
| `RestoreResult` | Restore operation result |
| `PITRTarget` | Point-in-time recovery target specification |
| `RetentionPolicy` | Backup retention policy configuration |
| `AuditSeverity` | `'info'` \| `'warning'` \| `'error'` \| `'critical'` |
| `AuditEntry` | Canonical audit log entry |
| `CertInfo` | TLS certificate metadata |
| `CertWarningLevel` | `'ok'` \| `'warning'` \| `'critical'` \| `'expired'` |
| `SecurityCheck` | Security compliance check result |
| `ConnectionPoolStatus` | Connection pool utilization |
| `ResourceUsageSnapshot` | Full resource usage snapshot |
| `SlowQueryEntry` | Slow query record |
| `DeadlockEvent` | Deadlock detection event |
| `AlertSeverity` | `'info'` \| `'warning'` \| `'critical'` |
| `AlertRule` | Alert rule configuration |
| `MaintenanceOp` | `'VACUUM'` \| `'ANALYZE'` \| `'REINDEX'` \| `'REBUILD'` |
| `MaintenanceResult` | Maintenance operation result |
| `StorageStats` | Database storage statistics |
| `IndexFragmentation` | Index fragmentation report |
| `ImportExportFormat` | `'csv'` \| `'jsonl'` \| `'ndjson'` \| `'json-array'` |
| `ImportResult` | Import operation result |
| `ExportResult` | Export operation result |
| `LagLevel` | Replication lag classification |
| `ReplicationTargetStatus` | Per-target replication status |
| `ReplicationStatus` | Aggregate replication status |
| `MigrationState` | Migration execution state |
| `MigrationDescriptor` | Single migration step |
| `MigrationPlan` | Ordered migration plan |

### Provider Registry (`@agentix-e/db-operations-core`)

#### `InterfaceToken<T>`

A unique symbol-based token for looking up providers by interface type.

- **`namespace: string`** — Human-readable namespace for debugging
- **`toString()`** — Returns `InterfaceToken(namespace)`

#### `token<T>(namespace: string): InterfaceToken<T>`

Helper to create a typed `InterfaceToken`.

#### `ProviderRegistry`

Central provider registry with lifecycle management.

| Method | Signature | Description |
|---|---|---|
| `register` | `<T>(iface, instance, options?)` | Register a provider under an interface token |
| `has` | `<T>(iface)` | Check if a registration exists |
| `get` | `<T>(iface)` | Get highest-priority registered instance (throws `ProviderNotFoundError` if missing) |
| `getAll` | `<T>(iface)` | Get all registered instances, ordered by priority (desc) |
| `unregister` | `<T>(iface)` | Remove all registrations for a token |
| `clear` | `()` | Clear all registrations |
| `registerAll` | `(registrations[])` | Register multiple providers in one call |
| `start` | `async ()` | Start all lifecycle-managed providers |
| `stop` | `async ()` | Stop all lifecycle-managed providers |
| `phase` | property | Get current lifecycle phase |
| `getSummary` | `()` | Get summary of all registered providers |

#### `IProviderLifecycle`

Provider lifecycle contract. Optional for registered instances.

| Method | Signature | Description |
|---|---|---|
| `start()` | `async` | Start the provider (idempotent) |
| `stop()` | `async` | Stop the provider (idempotent) |
| `getHealth()` | `()` | Health check, returns `null` if healthy |

#### Error Classes

| Class | Description |
|---|---|
| `ProviderNotFoundError` | Thrown when `get()` is called for an unregistered token |
| `ProviderStartError` | Thrown with `failures[]` when one or more providers fail to start |
| `ProviderStopError` | Thrown with `failures[]` when one or more providers fail to stop |

---

## Implementation

This package is **pure types and abstractions** — there are no implementation classes. The only concrete runtime component is the `ProviderRegistry` which manages provider instances. Engine-specific implementations live in their respective packages (e.g., `@agentix-e/db-operations-health`, `@agentix-e/db-operations-backup`).

---

## Usage Examples

### Registering a Provider

```typescript
import { token, ProviderRegistry } from '@agentix-e/db-operations-core';
import type { IHealthProbe } from '@agentix-e/db-operations-health';

const registry = new ProviderRegistry();
registry.register(
  token<IHealthProbe>('health.probe'),
  myHealthProbe,
  { engineType: 'sqlvec', priority: 10, name: 'sqlvec-probe' },
);
```

### Lifecycle Orchestration

```typescript
const registry = new ProviderRegistry();

// Register lifecycle-managed providers
registry.register(providerTokenA, providerA);
registry.register(providerTokenB, providerB);

// Start all providers
await registry.start();
console.log(registry.phase); // 'started'

// Stop all providers (reverse order)
await registry.stop();
console.log(registry.phase); // 'stopped'
```

### Error Handling

```typescript
try {
  const probe = registry.get(token<IHealthProbe>('health.probe'));
} catch (err) {
  if (err instanceof ProviderNotFoundError) {
    console.error('Health probe not configured:', err.message);
  }
}
```

---

## Testing

```bash
cd packages/core
npm test        # Run unit tests
npm run test:watch  # Watch mode
```

---

## Dependencies

None. This package is the foundation of the framework.
