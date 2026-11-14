# Monitor Package API

## Interfaces

### `ISlowQueryRecorder`

| Method | Return |
|---|---|
| `record(query)` | `Promise<void>` |
| `getSlowQueries(thresholdMs)` | `Promise<SlowQueryRecord[]>` |
| `analyzePatterns()` | `Promise<QueryPattern[]>` |

### `IAlertRuleManager`

| Method | Return |
|---|---|
| `createRule(rule)` | `Promise<string>` |
| `updateRule(id, rule)` | `Promise<void>` |
| `deleteRule(id)` | `Promise<void>` |
| `evaluate()` | `Promise<TriggeredAlert[]>` |
| `silenceRule(id, durationMs)` | `Promise<void>` |

### `IHealthCheck`

| Method | Return |
|---|---|
| `check()` | `Promise<HealthCheckResult>` |
| `getHistory(limit?)` | `Promise<HealthCheckResult[]>` |
| `registerComponent(name, checkFn)` | `void` |

### `IDeadlockDetector`

| Method | Return |
|---|---|
| `start()` | `Promise<void>` |
| `stop()` | `Promise<void>` |
| `onDeadlock(callback)` | `void` |
| `getDeadlockHistory()` | `Promise<IDeadlockInfo[]>` |

### `IConnectionMonitor`

| Method | Return |
|---|---|
| `start()` | `Promise<void>` |
| `stop()` | `Promise<void>` |
| `getConnections()` | `Promise<IConnectionInfo[]>` |
| `getPoolUtilization()` | `Promise<{ total, active, idle, waiting }>` |
| `onExhaustion(callback)` | `void` |

### `IResourceQuotaManager`

| Method | Return |
|---|---|
| `setQuota(roleId, quota)` | `Promise<void>` |
| `getQuota(roleId)` | `Promise<IResourceQuota \| null>` |
| `checkQuota(roleId)` | `Promise<{ allowed, reason? }>` |
| `getUsage(roleId)` | `Promise<ResourceUsage>` |

## Implementations

- **`InMemorySlowQueryRecorder`** — Circular buffer (default 1000). Methods: `record`, `getRecentSlowQueries`, `getSlowQueryCount`, `setThreshold`, `getThreshold`, `clear`
- **`InMemoryAlertRuleManager`** — Map-backed. Methods: `createRule`, `updateRule`, `deleteRule`, `addRule`, `removeRule`, `getRules`, `setRuleEnabled`, `evaluateSnapshot`, `silenceRule`, `clearRules`
- **`InMemoryConnectionMonitor`** — Per-pool tracking. Methods: `reportConnectionOpened/Closed/Waiting`, `getPoolStatus`, `getTotalOpened`, `addConnection`, `removeConnection`, `reset`
- **`InMemoryDeadlockDetector`** — DFS cycle detection. Methods: `reportLockWait`, `reportLockAcquired`, `detectDeadlocks`, `getDeadlockCount`, `onDeadlock`
- **`InMemoryResourceQuotaManager`** — Per-role quotas. Methods: `setQuota`, `getQuota`, `checkQuota`, `getUsage`, `updateConfig`, `getConfig`, `checkResource`, `getUtilization`, `setUsage`, `setRoleUsage`, `clear`
