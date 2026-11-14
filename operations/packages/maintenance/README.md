# @agentix-e/db-operations-maintenance

**Engine-agnostic database maintenance operations: VACUUM, ANALYZE, REINDEX, and storage statistics.**

This package defines a clean abstraction for database maintenance operations. Components can run VACUUM (space reclamation), ANALYZE (query statistics update), REINDEX (fragmentation reduction), and query storage stats — all without knowing whether the underlying engine is SQLite, PostgreSQL, or a graph engine.

---

## Features

- **Four maintenance operations** — `VACUUM`, `ANALYZE`, `REINDEX`, `REBUILD` with per-op options
- **Dry-run support** — Report what would happen without executing
- **Storage statistics** — Get file size, page counts, row counts, dead row counts, free space ratio
- **Index fragmentation reports** — Per-index page counts and fragmentation ratios
- **Auto-vacuum status** — Query whether auto-vacuum is enabled and its threshold
- **In-memory simulation** — Simulates storage compaction, dead row reclamation, fragmentation reduction
- **Noop fallback** — Returns fixed/empty results for testing or unconfigured systems

---

## Installation

```bash
npm install @agentix-e/db-operations-maintenance
```

---

## Quick Start

```typescript
import { InMemoryMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';

const executor = new InMemoryMaintenanceExecutor();

// Run VACUUM to reclaim storage
const result = await executor.vacuum({
  target: '*',
  full: false,
});
console.log(result.message); // "VACUUM completed on *"

// Run ANALYZE to update statistics
const analyzeResult = await executor.analyze({ target: '*' });
console.log(analyzeResult.message); // "ANALYZE completed on *"

// Check storage stats
const stats = await executor.getStorageStats('*');
console.log(`Free space ratio: ${stats.freeSpaceRatio}`); // 0.05 (after VACUUM reduced from 0.3)

// Check fragmentation
const frag = await executor.getIndexFragmentation('users');
frag.forEach(f => console.log(`${f.indexName}: ${(f.fragmentationRatio * 100).toFixed(1)}% fragmented`));
```

---

## API Reference

### Interfaces

#### `IMaintenanceExecutor`

| Method | Return | Description |
|---|---|---|
| `vacuum(options)` | `Promise<MaintenanceResult>` | Reclaim storage space |
| `analyze(options)` | `Promise<MaintenanceResult>` | Update query planner statistics |
| `reindex(options)` | `Promise<MaintenanceResult>` | Rebuild indexes to reduce fragmentation |
| `getStorageStats(target)` | `Promise<StorageStats>` | Get storage statistics |
| `getIndexFragmentation(target)` | `Promise<IndexFragmentation[]>` | Get fragmentation report |
| `getAutoVacuumStatus()` | `{ enabled, threshold }` | Get auto-vacuum status |

### Options Types

#### `VacuumOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `target` | `string` | required | Table or shard ID, `'*'` for all |
| `full` | `boolean` | `false` | Full rebuild vs incremental |
| `dryRun` | `boolean` | `false` | Report only, no execution |
| `timeoutMs` | `number` | — | Timeout in milliseconds |

#### `AnalyzeOptions`

| Field | Type | Description |
|---|---|---|
| `target` | `string` | Table or shard ID, `'*'` for all |
| `dryRun` | `boolean` | Report only |
| `timeoutMs` | `number` | Timeout |

#### `ReindexOptions`

| Field | Type | Description |
|---|---|---|
| `target` | `string` | Index name, table name, or `'*'` |
| `isTable` | `boolean` | If true, target is a table (rebuild all its indexes) |
| `dryRun` | `boolean` | Report only |
| `timeoutMs` | `number` | Timeout |

### Result Types

| Type | Key Fields |
|---|---|
| `MaintenanceResult` | `success, operation, target, message, durationMs, details?` |
| `StorageStats` | `fileSizeBytes, pageCount, pageSize, rowCount, deadRowCount, freeSpaceRatio` |
| `IndexFragmentation` | `indexName, tableName, pageCount, fragmentationRatio` |

---

## Implementations

### `InMemoryMaintenanceExecutor`

Simulates all operations with configurable initial state:

- **VACUUM** — Reduces `freeSpaceRatio` by 0.25, clears most dead rows. Full VACUUM also reduces page count by 15%.
- **ANALYZE** — Returns success with 5ms simulated duration.
- **REINDEX** — Reduces fragmentation ratio by 90% for matching targets, reduces page count by 30%.
- Tracks all operations in an `opsLog` array for inspection.

**Constructor:**
```typescript
new InMemoryMaintenanceExecutor(
  initialStats?: Partial<StorageStats>,
  initialFragmentation?: IndexFragmentation[],
  autoVacuumEnabled?: boolean,
  autoVacuumThreshold?: number,
)
```

### `NoopMaintenanceExecutor`

Returns success with 0ms duration for all operations. Empty/fixed storage stats and fragmentation. Use as a fallback where maintenance is not configured.

---

## Usage Examples

### Full Database Maintenance

```typescript
import { InMemoryMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';

async function runMaintenance(executor: IMaintenanceExecutor) {
  console.log('Starting maintenance...\n');

  // 1. Check current state
  const before = await executor.getStorageStats('*');
  console.log(`Before: ${before.deadRowCount} dead rows, ${(before.freeSpaceRatio * 100).toFixed(1)}% free space\n`);

  // 2. Dry-run to preview
  const dry = await executor.vacuum({ target: '*', dryRun: true });
  console.log(`[DRY-RUN] ${dry.message}`);

  // 3. Full VACUUM
  const vacResult = await executor.vacuum({ target: '*', full: true });
  console.log(vacResult.message);

  // 4. ANALYZE for fresh statistics
  const analyzeResult = await executor.analyze({ target: '*' });
  console.log(analyzeResult.message);

  // 5. REINDEX fragmented indexes
  const frags = await executor.getIndexFragmentation('*');
  for (const f of frags) {
    if (f.fragmentationRatio > 0.3) {
      const reindexResult = await executor.reindex({ target: f.indexName });
      console.log(`  ${reindexResult.message}`);   }
  }

  // 6. Check results
  const after = await executor.getStorageStats('*');
  console.log(`\nAfter: ${after.deadRowCount} dead rows, ${(after.freeSpaceRatio * 100).toFixed(1)}% free space`);
}
```

### Using the Noop Fallback

```typescript
import { NoopMaintenanceExecutor } from '@agentix-e/db-operations-maintenance';

// Safe to use anywhere — no real operations performed
const executor = new NoopMaintenanceExecutor();

const result = await executor.vacuum({ target: 'my_table' });
console.assert(result.success);
console.assert(result.durationMs === 0);
```

---

## Testing

```bash
cd packages/maintenance
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` (`^0.1.0`) — Provides `MaintenanceResult`, `StorageStats`, `IndexFragmentation`, `MaintenanceOp` types
