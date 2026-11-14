# Getting Started with db-operations

## Installation

```bash
npm install @agentix-e/db-operations-core
npm install @agentix-e/db-operations-health
npm install @agentix-e/db-operations-backup
# ... etc for each package you need
```

## Minimal Setup (3 minutes)

### 1. Provider Registry

```typescript
import { ProviderRegistry, token } from '@agentix-e/db-operations-core';

const registry = new ProviderRegistry();
```

### 2. Register Services

```typescript
import { InMemoryLogger } from '@agentix-e/db-operations-logger';
import { HealthOrchestrator, ComponentProbe } from '@agentix-e/db-operations-health';
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';

const ILogger = token<ILogger>('ILogger');
registry.register(ILogger, new InMemoryLogger({ level: 'info' }));
registry.register(token('HealthOrchestrator'), new HealthOrchestrator(registry));
registry.register(token('MetricsRegistry'), new MetricsRegistry());
```

### 3. Use Services

```typescript
// Health check
const orchestrator = registry.get<HealthOrchestrator>(token('HealthOrchestrator'));
await orchestrator.registerComponent('database-1', probe);
const status = await orchestrator.evaluateComponentHealth('database-1');

// Backup
import { InMemoryBackupManager, InMemoryStorageBackend } from '@agentix-e/db-operations-backup';
const backup = new InMemoryBackupManager(new InMemoryStorageBackend());
const result = await backup.createBackup('full');
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
    this.logger = new InMemoryLogger({ level: 'debug' });
    this.metrics = new MetricsRegistry();
    this.backup = new InMemoryBackupManager(new InMemoryStorageBackend());
    this.monitor = new InMemoryDeadlockDetector();
    this.audit = new InMemoryAuditStore();
    this.health = new HealthOrchestrator(new ProviderRegistry());
  }
}
```

### Custom adapter skeleton

```typescript
import type { IBackupManager, BackupType, BackupResult } from '@agentix-e/db-operations-core/types';

class MyDatabaseBackupAdapter implements IBackupManager {
  async createBackup(type: BackupType): Promise<BackupResult> {
    // Bridge to your custom database backup API
    return { snapshotId: '...', type, state: 'completed', ... };
  }
  // ...
}
```

## Next Steps

- See each package's README for specific API docs
- Read the [architecture doc](./docs/architecture.md) for design details
- Check the [testing strategy](./docs/testing.md) to understand test coverage
