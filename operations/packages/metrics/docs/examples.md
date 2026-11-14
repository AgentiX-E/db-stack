# Examples

## Pool Utilization Monitoring

```typescript
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';

class ConnectionPool {
  private metrics = new MetricsRegistry();

  constructor(private poolId: string) {}

  acquire() {
    this.metrics.gauge('pool_active', { pool: this.poolId }).inc();
    return this.poolAcquire();
  }

  release() {
    this.metrics.gauge('pool_active', { pool: this.poolId }).dec();
    this.poolRelease();
  }

  recordWait(ms: number) {
    this.metrics.histogram('pool_wait_ms', { pool: this.poolId }).observe(ms);
  }

  getUtilization() {
    return this.metrics.snapshot();
  }
}
```

## Latency Breakdown per Operation

```typescript
interface OperationMetrics {
  count: ICounter;
  errors: ICounter;
  latency: IHistogram;
}

function createOperationMetrics(registry: MetricsRegistry, operation: string): OperationMetrics {
  return {
    count: registry.counter('ops_total', { operation }),
    errors: registry.counter('ops_errors_total', { operation }),
    latency: registry.histogram('ops_duration_ms', { operation }, [1, 10, 50, 200, 1000, 5000]),
  };
}

export class QueryEngine {
  private metrics = new MetricsRegistry();
  private readonly ops: Map<string, OperationMetrics> = new Map();

  execute(operation: string) {
    const opMetrics = this.getOrCreateMetrics(operation);
    const start = performance.now();

    try {
      // ... execute operation ...
      opMetrics.count.inc();
    } catch (err) {
      opMetrics.errors.inc();
      throw err;
    } finally {
      opMetrics.latency.observe(performance.now() - start);
    }
  }

  private getOrCreateMetrics(operation: string): OperationMetrics {
    if (!this.ops.has(operation)) {
      this.ops.set(operation, createOperationMetrics(this.metrics, operation));
    }
    return this.ops.get(operation)!;
  }

  getSnapshot() {
    return this.metrics.snapshot();
  }
}
```

## Multi-Database Metrics Aggregation

```typescript
import { MetricsRegistry } from '@agentix-e/db-operations-metrics';

// One registry per database engine
const sqliteMetrics = new MetricsRegistry();
const pgMetrics = new MetricsRegistry();

// Same metric names, different label values
sqliteMetrics.counter('connections_total', { engine: 'sqlite' }).incBy(5);
pgMetrics.counter('connections_total', { engine: 'postgres' }).incBy(12);

// Later — aggregate into one view
function aggregateSnapshots(...registries: MetricsRegistry[]) {
  return registries.flatMap(r => r.snapshot().points);
}
```
