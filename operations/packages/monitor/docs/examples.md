# Examples

## Full Monitoring Setup

```typescript
import {
  InMemorySlowQueryRecorder,
  InMemoryAlertRuleManager,
  InMemoryConnectionMonitor,
  InMemoryDeadlockDetector,
  InMemoryResourceQuotaManager,
} from '@agentix-e/db-operations-monitor';

class DatabaseMonitor {
  readonly slowQueries = new InMemorySlowQueryRecorder(100);
  readonly alerts = new InMemoryAlertRuleManager();
  readonly connections = new InMemoryConnectionMonitor();
  readonly deadlocks = new InMemoryDeadlockDetector();
  readonly quotas = new InMemoryResourceQuotaManager();

  async setupDefaultAlerts() {
    await this.alerts.createRule({
      name: 'High Query Latency',
      metric: 'p99_latency_ms',
      condition: 'gt',
      threshold: 1000,
      durationMs: 60_000,
      severity: 'warning',
      enabled: true,
    });

    await this.alerts.createRule({
      name: 'Connection Pool Exhaustion',
      metric: 'pool_utilization',
      condition: 'gt',
      threshold: 0.9,
      durationMs: 30_000,
      severity: 'critical',
      enabled: true,
    });
  }

  reportQuery(query: string, durationMs: number, database: string) {
    this.slowQueries.record({
      query,
      durationMs,
      timestamp: new Date(),
      database,
    });
  }

  async evaluateAlerts(): Promise<string[]> {
    const patterns = await this.slowQueries.analyzePatterns();
    const snapshot: Record<string, number> = {
      p99_latency_ms: Math.max(...patterns.map(p => p.averageDurationMs)),
      pool_utilization: (await this.connections.getPoolUtilization()).active / 100,
    };
    return this.alerts.evaluateSnapshot(snapshot).map(a => a.message);
  }
}
```

## Slow Query Pattern Analysis

```typescript
const recorder = new InMemorySlowQueryRecorder(50);

// Simulate some queries
for (let i = 0; i < 10; i++) {
  await recorder.record({
    query: 'SELECT * FROM orders WHERE user_id = ?',
    durationMs: 150 + Math.random() * 100,
    timestamp: new Date(),
    database: 'main',
    user: 'app1',
  });
}

for (let i = 0; i < 3; i++) {
  await recorder.record({
    query: 'SELECT * FROM users WHERE id = ?',
    durationMs: 2000 + Math.random() * 500, // slow!
    timestamp: new Date(),
    database: 'main',
  });
}

const patterns = await recorder.analyzePatterns();
for (const p of patterns) {
  console.log(`${p.pattern.substring(0, 50)}...`);
  console.log(`  Avg: ${p.averageDurationMs}ms, Count: ${p.count}`);
}

// Find anomalies (queries with much higher than average latency)
const anomalies = patterns.filter(p => p.averageDurationMs > 1000);
if (anomalies.length > 0) {
  console.log('Anomalous patterns detected!');
}
```

## Quota Enforcement

```typescript
const quotas = new InMemoryResourceQuotaManager();

// Set quota for read-only role
await quotas.setQuota('readonly', {
  cpuLimit: 50,
  memoryLimitMB: 4096,
  connectionLimit: 10,
  queryRateLimit: 100,
});

// Simulate usage
quotas.setRoleUsage('readonly', {
  cpu: 30,
  memoryMB: 2000,
  connections: 8,
  queryRate: 50,
});

// Check
const result = await quotas.checkQuota('readonly');
console.log(result); // { allowed: true }

// Increase usage
quotas.setRoleUsage('readonly', { connections: 15 });

const result2 = await quotas.checkQuota('readonly');
console.log(result2); // { allowed: false, reason: 'Connection limit exceeded: 15 > 10' }
```
