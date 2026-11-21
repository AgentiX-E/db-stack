# Getting started

## Installation

```bash
npm install @agentix-e/db-node
```

That is the whole install for a single node. If you need a single-datacenter cluster or
cross-datacenter replication, install [`@agentix-e/db-cluster`](../cluster) or
[`@agentix-e/db-federation`](../federation) instead: each depends on the one below it, so
one install brings the stack with it.

Which version is running is the question a `package.json` answers, so this package does
not publish a second constant that claims to know. An earlier revision did — under an
umbrella that has since been removed — and nothing compared it to the manifest, so it
said `1.1.0` while the manifest said `1.11.3`.

## Minimal Setup (3 minutes)

### 1. Provider Registry

```typescript
import { ProviderRegistry, token } from '@agentix-e/db-node/core';

const registry = new ProviderRegistry();
```

### 2. Register Services

```typescript
import type { ILogger } from '@agentix-e/db-node/logger';
import { InMemoryLogger } from '@agentix-e/db-node/logger';
import { HealthOrchestrator, componentProbe } from '@agentix-e/db-node/health';
import { MetricsRegistry } from '@agentix-e/db-node/metrics';

// Services that a caller looks up *by interface* go in the registry.
const ILoggerToken = token<ILogger>('ILogger');
registry.register(ILoggerToken, new InMemoryLogger('getting-started'));

// Health and metrics own their own state and are used directly; putting them in
// the registry buys a lookup nobody performs.
const health = new HealthOrchestrator();
const metrics = new MetricsRegistry();
```

`InMemoryLogger` takes `(component: string, maxEntries = 100)`, not an options
object — a snippet that passed `{ level: 'info' }` type-checked in the reader's
head for two releases and nowhere else.

### 3. Use Services

```typescript
// Health check: register a probe, then ask for readiness.
health.registerComponent(
  componentProbe('database-1', 'Primary database', {
    liveness: () => ({ ok: true }),
    readiness: () => ({ ok: true, message: 'replication lag 12 ms' }),
  }),
);
const readiness = health.readiness(); // { ok: boolean, errors: string[] }
const components = health.getComponentHealth(); // per-component detail

// Backup: a manager is where the bytes come from, where they go, and what to keep.
import {
  BackupManager,
  DirectoryBackupSource,
  InMemoryStorageBackend,
  RetentionPolicyEvaluator,
} from '@agentix-e/db-node/backup';

const backup = new BackupManager(
  new DirectoryBackupSource('/var/lib/db/data'),
  new InMemoryStorageBackend(),
  new RetentionPolicyEvaluator({ maxFullSnapshots: 24, maxTotalBytes: 64 * 1024 ** 3 }),
);
const result = await backup.createBackup({ type: 'full' });
```

## Common Patterns

### Set up all services at once

```typescript
class DatabaseOperations {
  public readonly health: IHealthOrchestrator;
  public readonly logger: ILogger;
  public readonly metrics: IMetricsRegistry;
  public readonly backup: IBackupManager;
  public readonly monitor: IDeadlockDetector;
  public readonly audit: IAuditStore;

  constructor() {
    this.logger = new InMemoryLogger('operations');
    this.metrics = new MetricsRegistry();
    this.backup = new BackupManager(
      new DirectoryBackupSource('/var/lib/db/data'),
      new InMemoryStorageBackend(),
      new RetentionPolicyEvaluator({ maxFullSnapshots: 24, maxTotalBytes: 64 * 1024 ** 3 }),
    );
    this.monitor = new InMemoryDeadlockDetector();
    this.audit = new InMemoryAuditStore();
    this.health = new HealthOrchestrator();
  }
}
```

### Custom adapter skeleton

```typescript
import type { IBackupManager, CreateBackupOptions } from '@agentix-e/db-node/backup';
import type { BackupResult } from '@agentix-e/db-node/core/types';

class MyDatabaseBackupAdapter implements IBackupManager {
  async createBackup(options: CreateBackupOptions): Promise<BackupResult> {
    // Bridge to your custom database backup API
    const snapshot = await myEngine.snapshot(options.type);
    return {
      success: true,
      snapshot: {
        snapshotId: snapshot.id,
        type: options.type,
        state: 'completed',
        createdAt: snapshot.startedAt,
        completedAt: snapshot.finishedAt,
        sizeBytes: snapshot.sizeBytes,
        fileCount: snapshot.files.length,
        location: `s3://backups/${snapshot.id}`,
      },
    };
  }

  // listBackups / getBackup / deleteBackup / restoreFromSnapshot / pitr / prune …
}
```

`IBackupManager` is defined by the `backup` package, not by `core`; `core` owns the
shapes (`BackupResult`, `BackupMetadata`, `SnapshotType`). An earlier version of
this snippet imported both from `@agentix-e/db-node/core/types`, named a
`BackupType` that exists nowhere, and returned `{ snapshotId, type, state }` where
the real shape is `{ success, snapshot }` — three errors a reader would have
discovered only after wiring their first adapter.

## Next Steps

- See each package's README for specific API docs
- Read the [architecture doc](../../docs/architecture.md) for design details
- Read the [operations guide](../../docs/user-guide/operations.md) for the three packages
