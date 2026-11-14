# Examples

## Scheduler Integration

```typescript
import { InMemoryMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';
import type { IMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';

class MaintenanceScheduler {
  constructor(private executor: IMaintenanceExecutor) {}

  async dailyMaintenance() {
    console.log('[Scheduler] Starting daily maintenance...');

    // 1. Update statistics (always safe)
    const analyze = await this.executor.analyze({ target: '*' });
    console.log(`  ${analyze.message} (${analyze.durationMs}ms)`);

    // 2. Check if VACUUM is needed
    const stats = await this.executor.getStorageStats('*');
    if (stats.deadRowCount > 100_000 || stats.freeSpaceRatio > 0.2) {
      const vacuum = await this.executor.vacuum({ target: '*', full: false });
      console.log(`  ${vacuum.message} (${vacuum.durationMs}ms)`);
    } else {
      console.log('  VACUUM not needed');
    }

    // 3. Check and fix fragmentation
    const frags = await this.executor.getIndexFragmentation('*');
    for (const f of frags) {
      if (f.fragmentationRatio > 0.3) {
        const reindex = await this.executor.reindex({ target: f.indexName });
        console.log(`  ${reindex.message}`);
      }
    }
  }

  async weeklyFullMaintenance() {
    console.log('[Scheduler] Starting full maintenance...');
    const result = await this.executor.vacuum({ target: '*', full: true, timeoutMs: 30_000 });
    console.log(`  ${result.message}`);
  }
}

// Usage
const scheduler = new MaintenanceScheduler(new InMemoryMaintenanceExecutor());
await scheduler.dailyMaintenance();
```

## Dry-Run Previews

```typescript
// Always preview before running
const executor = new InMemoryMaintenanceExecutor();

const preview = await executor.vacuum({ target: '*', dryRun: true });
console.log(`Would run: ${preview.message}`);

// Only execute if conditions are right
const stats = await executor.getStorageStats('*');
if (stats.deadRowCount > 50_000) {
  const real = await executor.vacuum({ target: '*', full: false });
  console.log(`Executed: ${real.message} (${real.durationMs}ms)`);
}
```
