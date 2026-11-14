# @agentix-e/db-operations-monitor

**Database monitoring and alerting toolkit — slow query detection, connection pool monitoring, deadlock detection, alert rules, and resource quota management.**

This package provides the core monitoring capabilities for database engines: tracking slow queries, monitoring connection pools, detecting deadlocks via cycle detection, evaluating alert rules against metric snapshots, and enforcing resource quotas per role.

---

## Features

- **Slow query recording** — Circular-buffer storage with configurable threshold, pattern analysis, and anomaly detection
- **Connection pool monitoring** — Track open/close/waiting per pool, pool utilization, and exhaustion callbacks
- **Deadlock detection** — DFS cycle detection on wait-for graphs, automatic victim selection, callback-based notification
- **Alert rule engine** — Create/update/delete rules, evaluate against metric snapshots, silence support, severity levels
- **Resource quota enforcement** — Per-role limits on CPU, memory, connections, and query rate with usage tracking
- **All in-memory** — All implementations work in-memory, ideal for testing and single-process deployments

---

## Installation

```bash
npm install @agentix-e/db-operations-monitor
```

---

## Quick Start

```typescript
import { InMemorySlowQueryRecorder, InMemoryAlertRuleManager, InMemoryConnectionMonitor } from '@agentix-e/db-operations-monitor';

// 1. Track slow queries
const slowQuery = new InMemorySlowQueryRecorder(100); // threshold: 100ms
await slowQuery.record({ query: 'SELECT * FROM users', durationMs: 450, timestamp: new Date(), database: 'main' });
const patterns = await slowQuery.analyzePatterns();

// 2. Alert rules
const alertMgr = new InMemoryAlertRuleManager();
const ruleId = await alertMgr.createRule({
  name: 'High CPU',
  metric: 'cpu_percent',
  condition: 'gt',
  threshold: 90,
  severity: 'critical',
  enabled: true,
});
const alerts = alertMgr.evaluateSnapshot({ cpu_percent: 95 });
console.log(alerts[0].message); // "High CPU: 95 gt 90"

// 3. Connection monitoring
const connMon = new InMemoryConnectionMonitor();
connMon.reportConnectionOpened('pool-main');
connMon.reportConnectionOpened('pool-main');
connMon.reportConnectionClosed('pool-main');
console.log(await connMon.getPoolUtilization()); // { total: 2, active: 1, idle: 1, waiting: 0 }
```

---

## API Reference

### Interfaces

#### `ISlowQueryRecorder`

| Method | Return | Description |
|---|---|---|
| `record(query)` | `Promise<void>` | Record a slow query entry |
| `getSlowQueries(thresholdMs)` | `Promise<SlowQueryRecord[]>` | Get slow queries exceeding a threshold |
| `analyzePatterns()` | `Promise<QueryPattern[]>` | Analyze query patterns for anomalies |

#### `IAlertRuleManager`

| Method | Return | Description |
|---|---|---|
| `createRule(rule)` | `Promise<string>` | Create a new alert rule, returns rule ID |
| `updateRule(id, rule)` | `Promise<void>` | Update an existing rule |
| `deleteRule(id)` | `Promise<void>` | Delete a rule |
| `evaluate()` | `Promise<TriggeredAlert[]>` | Evaluate all rules |
| `silenceRule(id, durationMs)` | `Promise<void>` | Silence a rule for a duration |

#### `IHealthCheck`

| Method | Return | Description |
|---|---|---|
| `check()` | `Promise<HealthCheckResult>` | Perform health check |
| `getHistory(limit?)` | `Promise<HealthCheckResult[]>` | Get health check history |
| `registerComponent(name, checkFn)` | `void` | Register a health check component |

#### `IDeadlockDetector`

| Method | Return | Description |
|---|---|---|
| `start()` | `Promise<void>` | Start monitoring for deadlocks |
| `stop()` | `Promise<void>` | Stop monitoring |
| `onDeadlock(callback)` | `void` | Register deadlock callback |
| `getDeadlockHistory()` | `Promise<IDeadlockInfo[]>` | Get deadlock history |

#### `IConnectionMonitor`

| Method | Return | Description |
|---|---|---|
| `start()` | `Promise<void>` | Start monitoring connections |
| `stop()` | `Promise<void>` | Stop monitoring |
| `getConnections()` | `Promise<IConnectionInfo[]>` | Get all current connections |
| `getPoolUtilization()` | `Promise<{ total, active, idle, waiting }>` | Get pool utilization |
| `onExhaustion(callback)` | `void` | Pool exhaustion callback |

#### `IResourceQuotaManager`

| Method | Return | Description |
|---|---|---|
| `setQuota(roleId, quota)` | `Promise<void>` | Set quota for a role |
| `getQuota(roleId)` | `Promise<IResourceQuota \| null>` | Get quota for a role |
| `checkQuota(roleId)` | `Promise<{ allowed, reason? }>` | Check if role is within quota |
| `getUsage(roleId)` | `Promise<ResourceUsage>` | Get current resource usage |

### Types

| Type | Fields |
|---|---|
| `SlowQueryRecord` | `query, durationMs, timestamp, database, user?, rowsExamined?, rowsSent?` |
| `QueryPattern` | `pattern, averageDurationMs, count, lastSeen` |
| `AlertRule` | `id?, name, metric, condition, threshold, durationMs, severity, enabled` |
| `TriggeredAlert` | `ruleId, ruleName, severity, value, threshold, triggeredAt, message` |
| `IDeadlockInfo` | `cycle, victimTransaction, detectedAt` |
| `IConnectionInfo` | `id, user, database, state, query?, connectedAt, idleInTransaction` |
| `IResourceQuota` | `cpuLimit, memoryLimitMB, connectionLimit, queryRateLimit` |

---

## Implementations

### `InMemorySlowQueryRecorder`

Circular buffer (default 1000 entries). Queries below threshold are ignored. Supports pattern analysis by grouping identical queries.

- `getRecentSlowQueries(limit?)` — Get recent entries from buffer
- `getSlowQueryCount()` — Total count including evicted entries
- `setThreshold(ms)` / `getThreshold()` — Manage threshold at runtime
- `clear()` — Clear all entries and reset count

### `InMemoryAlertRuleManager`

Map-backed alert rule storage with `evaluateSnapshot(snapshot)` for evaluating rules against a metric-value map. Supports silence, enable/disable, and bulk operations.

- `addRule(rule)` / `removeRule(ruleId)` — First-class add/remove
- `getRules()` — Get all rules
- `setRuleEnabled(ruleId, enabled)` — Toggle rule state
- `evaluateSnapshot(snapshot: Record<string, number>)` — Evaluate against values
- `clearRules()` — Remove all rules

### `InMemoryConnectionMonitor`

Tracks connection pool state per pool ID. Supports open/close/waiting reports, pool utilization, and connection-level tracking.

- `addConnection(conn)` / `removeConnection(connId)` — Track individual connections
- `getPoolStatus()` — Status for all pools
- `getTotalOpened()` — Lifetime connection count
- `reset()` — Clear all state

### `InMemoryDeadlockDetector`

DFS-based cycle detection on a wait-for graph. Reports lock waits and acquires, detects cycles, selects oldest transaction as victim.

- `reportLockWait(txId, resourceId)` / `reportLockAcquired(txId, resourceId)` — Update wait-for graph
- `reportLockTimeout(txId, resourceId)` — Report timeout as deadlock
- `getRawDeadlockEvents()` — Get raw `DeadlockEvent[]`
- `getDeadlockCount()` — Total detected deadlocks

### `InMemoryResourceQuotaManager`

Per-role quota enforcement with usage tracking. Also maintains global resource limits.

- `updateConfig(config)` / `getConfig()` — Manage global limits
- `checkResource(usage)` — Check against global limits
- `getUtilization()` — Get `ResourceUsageSnapshot`
- `setUsage(usage)` / `setRoleUsage(roleId, usage)` — Set for testing
- `clear()` — Clear all quotas

---

## Usage Examples

### Deadlock Detection

```typescript
const detector = new InMemoryDeadlockDetector();

detector.onDeadlock((info) => {
  console.error(`Deadlock! Cycle: ${info.cycle.join(' → ')}`);
  console.error(`Victim: ${info.victimTransaction}`);
});

// Simulate a deadlock: Tx1 waits for resource held by Tx2, Tx2 waits for resource held by Tx1
detector.reportLockAcquired('tx1', 'resource-a');
detector.reportLockAcquired('tx2', 'resource-b');
detector.reportLockWait('tx1', 'resource-b');  // Tx1 wants resource-b (held by Tx2)
detector.reportLockWait('tx2', 'resource-a');  // Tx2 wants resource-a (held by Tx1)

// Trigger cycle detection
const events = detector.detectDeadlocks();
console.log(`Detected ${events.length} deadlock(s)`);
```

### Alert Rules with Snapshot Evaluation

```typescript
const rules = new InMemoryAlertRuleManager();

const cpuRule = await rules.createRule({
  name: 'High CPU',
  metric: 'cpu_percent',
  condition: 'gt',
  threshold: 90,
  severity: 'critical',
  enabled: true,
});

const memRule = await rules.createRule({
  name: 'High Memory',
  metric: 'memory_mb',
  condition: 'gte',
  threshold: 8000,
  severity: 'warning',
  enabled: true,
});

const snapshot = {
  cpu_percent: 95,
  memory_mb: 8192,
  connections: 42,
};

const alerts = rules.evaluateSnapshot(snapshot);
// alerts: [
//   { ruleName: 'High CPU', severity: 'critical', value: 95, threshold: 90 },
//   { ruleName: 'High Memory', severity: 'warning', value: 8192, threshold: 8000 }
// ]
```

### Connection Pool Monitoring

```typescript
const mon = new InMemoryConnectionMonitor();

// Track pool operations
mon.reportConnectionOpened('pool-write');
mon.reportConnectionOpened('pool-write');
mon.reportConnectionOpened('pool-read');

// Simulate waiting
mon.reportConnectionWaiting('pool-write');

const utilization = await mon.getPoolUtilization();
console.log(`Active: ${utilization.active}, Waiting: ${utilization.waiting}`);
```

---

## Testing

```bash
cd packages/monitor
npm test
npm run test:watch
```

---

## Dependencies

- `@agentix-e/db-operations-core` — Shared type definitions (BackupMetadata, DeadlockEvent, etc.)
