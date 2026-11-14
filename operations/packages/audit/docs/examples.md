# Examples

## Full Audit Lifecycle

```typescript
import { InMemoryAuditStore, JsonAuditExporter } from '@agentix-e/db-operations-audit';

const audit = new InMemoryAuditStore();
const exporter = new JsonAuditExporter(audit);

// Record operations
await audit.write({ operation: 'SCHEMA_MIGRATE', actor: 'deploy-bot', resource: 'migrations/v2', result: 'success', severity: 'info' });
await audit.write({ operation: 'TABLE_DROP', actor: 'admin', resource: 'data/old_reports', result: 'success', severity: 'warning' });

// Investigate an issue
const drops = await audit.query({ operation: 'TABLE_DROP', severity: 'warning' });
if (drops.length > 0) {
  console.log('Recent table drops:', drops.map(d => `${d.actor} dropped ${d.resource}`));
}

// Trace by operation
const mig = await audit.get(drops[0].id);
console.log(`Operation: ${mig?.operation}, Actor: ${mig?.actor}, Trace: ${mig?.traceId}`);
```

## CSV Exporter

```typescript
import type { IAuditExporter, ExportOptions, IAuditStore } from '@agentix-e/db-operations-audit';
import { writeFile } from 'node:fs/promises';

class CsvAuditExporter implements IAuditExporter {
  constructor(private store: IAuditStore) {}

  async exportToFile(outputPath: string, options: ExportOptions): Promise<number> {
    const entries = await this.store.query(options.filter ?? {});
    const headers = 'id,timestamp,operation,actor,resource,result,severity,traceId\n';
    const rows = entries.map(e =>
      `${e.id},${e.timestamp},${e.operation},${e.actor},${e.resource},${e.result},${e.severity},${e.traceId ?? ''}`
    ).join('\n');
    await writeFile(outputPath, headers + rows, 'utf-8');
    return entries.length;
  }

  async exportToString(options: ExportOptions): Promise<string> {
    const entries = await this.store.query(options.filter ?? {});
    const headers = 'id,timestamp,operation,actor,resource,result,severity,traceId\n';
    const rows = entries.map(e =>
      `${e.id},${e.timestamp},${e.operation},${e.actor},${e.resource},${e.result},${e.severity},${e.traceId ?? ''}`
    ).join('\n');
    return headers + rows;
  }
}
```
