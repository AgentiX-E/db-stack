# db-operations — Unified Database Operations Framework

## Design Philosophy

db-operations is the **single abstraction layer** for all operational concerns across
Agentix-E's database engines (sqlvec-db, graphvec-db, and future engines).

It replaces the ad-hoc `ops/` directories in each project with a canonical,
engine-agnostic interface suite that both engines can implement via adapters.

### Guiding Principles

1. **Engine-Agnostic Core** — Zero dependency on any engine type. Operations are
   defined in terms of abstract primitives (storage, topology, query workload).

2. **Interface-First Design** — Interfaces are stable contracts. Implementations
   are adapters that bridge the gap between the generic interface and the
   engine-specific internals.

3. **Composability** — Small, focused interfaces compose into higher-level
   orchestration (e.g., `IHealthProbe` + `IComponentRegistrar` = `IHealthOrchestrator`).

4. **Pluggability** — Every interface can have multiple implementations:
   - `SqlVecXxxAdapter(sqlvec-internals)` — bridges to sqlvec-db
   - `GraphVecXxxAdapter(graphvec-internals)` — bridges to graphvec-db
   - `NoopXxx()` — no-op fallback for testing

5. **Production-Grade Everywhere** — Every interface includes error types,
   observability hooks, and capacity/state inspection methods.

### Package Architecture

```
db-operations/                    # Monorepo root
├── packages/
│   ├── core/                    # Base types, providers, registry
│   │   ├── src/
│   │   │   ├── types.ts          # Canonical type definitions
│   │   │   ├── provider.ts       # Provider pattern (IProviderRegistry)
│   │   │   ├── index.ts
│   │   │   └── __tests__/
│   │   └── ...
│   ├── health/                  # ✅ Health probes (K8s-style + deep)
│   │   ├── src/
│   │   │   ├── interfaces/       # IHealthProbe, IComponentRegistrar, IHealthOrchestrator
│   │   │   ├── impl/             # HealthOrchestrator, ComponentProbe
│   │   │   ├── index.ts
│   │   │   └── __tests__/
│   │   └── ...
│   ├── metrics/                 # Metrics registry + exporters (interface + impl)
│   ├── logger/                  # Structured logging with trace context (interface + NoopLogger)
│   ├── backup/                  # Backup + PITR abstraction (interface only)
│   ├── migration/               # Schema migration framework (interface only)
│   ├── audit/                   # Audit log + export (interface only)
│   ├── security/                # TLS cert monitor, encryption, RBAC, rate limit (interface only)
│   ├── monitor/                 # Slow query, deadlock, connection pool, alert rules, resource quota
│   ├── maintenance/             # VACUUM, ANALYZE, REINDEX (interface only)
│   ├── import-export/           # Batch import/export (interface only — planned)
│   ├── replication/             # Cross-DC replication monitoring (interface only — planned)
│   ├── observability/           # Distributed tracing, telemetry (interface only)
│   ├── scheduling/              # Cron/scheduler for periodic ops tasks (planned)
│   └── config/                  # Runtime config management (planned)
└── package.json
```

### Interface Categories

| Category | Interfaces | Existing in sqlvec-db | Existing in graphvec-db |
|----------|-----------|----------------------|------------------------|
| **Health** | IHealthProbe, IComponentRegistrar, IHealthOrchestrator | HealthCheckServer | Health class (K8s probes) |
| **Metrics** | IMetricsRegistry, ICounter, IHistogram, IGauge | PinoLogger + RaftMetrics + RouteMetrics | Metrics class + OTelMetrics |
| **Logger** | ILogger, ITraceContextProvider | PinoLogger | Logger class |
| **Backup** | IBackupManager, IPITRManager, IBackupScheduler, IStorageBackend, IBackupRetentionPolicy | PITRManager, PITRWriter, PITRReader, ContinuousWalArchiver, ParallelBackup | IncrementalBackupManager |
| **Migration** | IMigrationProvider, IMigrationExecutor | (via SQL schema migration) | (none yet) |
| **Audit** | IAuditStore, IAuditExporter | AuditLogger | AuditLog, AuditExporter |
| **Security** | ITLSManager, ICertMonitor, IEncryptionManager, IRBACProvider, IRateLimiter, ISCIMSyncProvider | (TLS via db-cluster) | CertMonitor, SecurityAuditor |
| **Monitoring** | ISlowQueryRecorder, IDeadlockDetector, IConnectionMonitor, IAlertRuleManager, IResourceQuotaManager | SlowQueryRecorder, DeadlockDetector | QuerySlowLog, AlertRules, ResourceQuota |
| **Maintenance** | IMaintenanceExecutor (VACUUM, ANALYZE, REINDEX) | OpsCommands | (none directly) |
| **Import/Export** | IBatchImporter, IBatchExporter | (via pgwire COPY) | Importer, BatchIO |
| **Replication** | IReplicationLagMonitor | ReplicationLagMonitor | (via consensus-provider) |
| **Observability** | IDistributedTracer, ITelemetryExporter | DistributedTracer | (via OTel) |
| **Scheduling** | IScheduler | (none) | (none) |
| **Config** | IRuntimeConfigProvider | (env-based) | (env-based) |

### Adapter Pattern

Each engine provides adapter implementations:

```
db-operations/packages/monitor/src/
  interfaces/     ← canonical interfaces (no engine deps)
  impl/           ← general-purpose implementations (e.g., MetricsRegistry)
  adapters/
    sqlvec/       ← SqlVecSlowQueryRecorder, SqlVecDeadlockDetector
    graphvec/     ← GraphVecSlowQueryRecorder, GraphVecDeadlockDetector
    noop/         ← NoopSlowQueryRecorder for testing
```

Adapters live inside db-operations because:
1. They have zero engine dependency — they accept engine-specific config at
   construction time
2. They can be tested standalone with mocks
3. They form the complete "batteries included" package

---

## Iteration 1: Core Types + Provider Registry ✅ (146 tests)

**Status: COMPLETE** — d1dd564 pushed

### Scope

| Package | Files | Tests | Acceptance Criteria |
|---------|-------|-------|-------------------|
| core | types.ts, provider.ts, index.ts | 22 | All canonical types defined; ProviderRegistry supports register/resolve/unregister with lifecycle |
| health | IHealthProbe, IComponentRegistrar, IHealthOrchestrator, HealthOrchestrator, ComponentProbe | 23 | Liveness/readiness/startup probes; aggregate health status; component registration |
| logger | ILogger, ITraceContextProvider, NoopLogger | — | Interface compiles; NoopLogger.silently.discards |
| metrics | IMetricsRegistry, ICounter, IGauge, IHistogram, MetricsRegistry | — | Interface compiles; MetricsRegistry round-trips counter/gauge/histogram via snapshot() |
| backup | IBackupManager, IPITRManager, IStorageBackend, IBackupRetentionPolicy | 31 | All interfaces compile; test contracts defined |
| maintenance | IMaintenanceExecutor | — | Interface compiles; VACUUM/ANALYZE/REINDEX/REBUILD options types defined |
| audit | IAuditStore, IAuditExporter | — | Interface compiles; write/query/export/filter types defined |
| security | ITLSManager, ICertMonitor, IEncryptionManager, IRBACProvider, IRateLimiter, ISCIMSyncProvider, ISecurityCompliance | — | Interface compiles; 7 security interfaces |
| observability | IDistributedTracer, ITelemetryExporter | — | Interface compiles; W3C trace context span model |
| auth | (existing) | 32 | Unchanged |
| monitor | (existing) | 38 | Unchanged |

### Test Methodology

- **Unit tests**: Vitest v1.6.1 with isolate per-test-file
- **Implementation tests**: Real HealthOrchestrator instance, mock probes, direct assertion
- **Provider pattern tests**: Register → resolve → unregister → register → resolve multiple
- **Lifecycle tests**: start/stop idempotency, start-with-pending → auto-initialize, start-over-clean
- **Coverage**: 146 tests across 5 test files

### Test Plan (core)

```typescript
// AC 1.1: ProviderRegistry instantiation
it('creates empty registry')
it('resolves registered provider')
it('resolves with priority (higher wins)')
it('throws ProviderNotFoundError for unknown token')

// AC 1.2: Lifecycle management
it('starts all registered providers')
it('stops all registered providers')
it('idempotent start/stop (safe to call multiple times)')
it('start-with-pending: auto-initializes if stop called before start')
it('start-over-clean: re-initializes after start-stop-start')
it('respects priority order on start')
it('respects reverse priority on stop')
it('starts only applicable providers when startOnly was given')
```

### Test Plan (health)

```typescript
// AC 2.1: Component registration
it('registers and retrieves a component')
it('unregisters a component')
it('throws on duplicate registration')
it('registers functional probe (callback-based)')

// AC 2.2: Liveness probe
it('returns ok when all probes pass')
it('returns failed when a probe fails')
it('catches thrown errors from probes')
it('returns ok when no components registered')

// AC 2.3: Readiness probe
it('returns ok when all probes pass liveness + readiness')
it('fails when readiness fails even if liveness passes')

// AC 2.4: Startup probe
it('returns ok when all probes complete startup')
it('caches startup result after first call')

// AC 2.5: Aggregate health status
it('returns healthy when all components pass')
it('returns degraded when at least one component fails')
it('returns unhealthy when all components fail')
it('includes uptime')
it('returns per-component health with probe results')
```

---

## Iteration 2: Monitoring Interfaces + Implementations

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| monitor | InMemorySlowQueryRecorder impl + tests | +2 impl + 1 test | 15 |
| monitor | InMemoryDeadlockDetector impl + tests | +2 impl + 1 test | 18 |
| monitor | InMemoryConnectionMonitor impl + tests | +1 impl + 1 test | 12 |
| monitor | InMemoryAlertRuleManager impl + tests | +1 impl + 1 test | 16 |
| monitor | InMemoryResourceQuotaManager impl + tests | +1 impl + 1 test | 14 |
| monitor | package.json update, index.ts re-export | +0 | — |
| metrics | MetricsRegistry full tests | +1 test | 20 |
| logger | InMemoryLogger impl + tests | +1 impl + 1 test | 20 |
| maintenance | NoopMaintenanceExecutor impl + tests | +1 impl + 1 test | 10 |

### Design

#### InMemorySlowQueryRecorder

```
State:
  - entries: SlowQueryEntry[] (circular buffer, max 1000)
  - thresholdMs: number
  - count: number

record(query, durationMs, context):
  if durationMs >= thresholdMs:
    push { query, durationMs, timestamp: now, actor, shardId, completed }

getRecentSlowQueries(limit):
  return entries.slice(-limit)

setThreshold(ms): thresholdMs = ms
clear(): entries = []; count = 0
```

#### InMemoryDeadlockDetector

```
State:
  - waitFor: Map<txId, Set<resourceId>> (transaction waits for resources)
  - acquired: Map<txId, Set<resourceId>> (transactions holding locks)
  - deadlocks: DeadlockEvent[] (history)
  - TIMEOUT_MS: 5000

reportLockWait(txId, resourceId):
  waitFor.set(txId, waitFor.get(txId) ?? new Set()).add(resourceId)
  detect() // eager detection

reportLockAcquired(txId, resourceId):
  acquired.set(txId, acquired.get(txId) ?? new Set()).add(resourceId)
  waitFor.get(txId)?.delete(resourceId)

reportLockTimeout(txId, resourceId):
  resolve(txId) as timeout
  record deadlock event

detect() → DeadlockEvent[]:
  Build dependency graph from waitFor/acquired
  DFS cycle detection
  For each cycle: record event, break by victim selection (oldest tx)
```

#### InMemoryConnectionMonitor

```
State:
  - poolStats: Map<poolId, { active, idle, waiting, maxSize }>
  - totalOpened: number

reportConnectionOpened(poolId):
  poolStats[poolId] ??= { active:0, idle:0, waiting:0, maxSize:100 }
  poolStats[poolId].active++
  totalOpened++

reportConnectionClosed(poolId):
  poolStats[poolId].active--

reportConnectionWaiting(poolId):
  poolStats[poolId].waiting++

getPoolStatus():
  return poolStats.entries.map → { total: active+idle, active, idle, waiting, maxSize, utilization }
```

#### InMemoryAlertRuleManager

```
State:
  - rules: Map<ruleId, RuleEntry>
  - history: Map<ruleId, number> (last triggered value timestamp)

evaluate(snapshot):
  for each enabled rule:
    extract value from snapshot by rule.condition
    if value >= rule.threshold → triggered
    return [{ rule, value }]

setRuleEnabled(id, enabled):
  rules.get(id).enabled = enabled
```

#### ResourceQuotaManager

```
State:
  - maxMemoryMB: number
  - maxQueriesPerSec: number
  - maxConnections: number

checkResource(usage):
  if usage.memoryMB > maxMemoryMB → { allowed: false, reason: 'memory' }
  if usage.queriesPerSec > maxQueriesPerSec → { allowed: false, reason: 'qps' }
  else → { allowed: true }

getUtilization():
  return { memoryBytes, memoryUtilization, queriesPerSec, ... }
```

#### InMemoryLogger

```
State:
  - entries: LogEntry[] (retained for test assertions)
  - maxEntries: number (default 100)

child(bindings): returns new InMemoryLogger with merged bindings
trace/debug/info/warn/error/fatal(msg): push LogEntry
getEntries(): LogEntry[]
clear(): entries = []
getByLevel(level): LogEntry[] filtered
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| M1 | SlowQueryRecorder records queries above threshold | record() + getRecentSlowQueries() has entry |
| M2 | SlowQueryRecorder ignores queries below threshold | entry not present in list |
| M3 | SlowQueryRecorder respects max entries (circular buffer) | old entries evicted |
| M4 | SlowQueryRecorder threshold can be changed at runtime | setThreshold() affects subsequent records |
| M5 | DeadlockDetector detects simple 2-node cycle | A→B→A detected |
| M6 | DeadlockDetector detects complex N-node cycle | A→B→C→A detected |
| M7 | DeadlockDetector no false positive on linear wait chain | A→B→C (no cycle) = no deadlock |
| M8 | DeadlockDetector detects timeouts | reportLockTimeout() → deadlock event |
| M9 | ConnectionMonitor tracks open/close round-trip | opened+1, closed-1, totalOpened+1 |
| M10 | ConnectionMonitor utilization ratio | active/maxSize matches |
| M11 | AlertRuleManager evaluate returns triggered rules | condition value ≥ threshold |
| M12 | AlertRuleManager evaluates all enabled rules | rule.enabled = false → skipped |
| M13 | ResourceQuotaManager blocks over-limit | memory > maxMemoryMB → denied |
| M14 | ResourceQuotaManager allows under-limit | memory < maxMemoryMB → allowed |
| M15 | InMemoryLogger retains entries for assertion | info('hello') → getEntries() has 'hello' |
| M16 | InMemoryLogger child inherits bindings | child({ component: 'X' }) → entry context includes component |
| M17 | InMemoryLogger respects max capacity | exceeds maxEntries = oldest evicted |
| M18 | MetricsRegistry counter/gauge/histogram snapshot | snapshot() returns points matching inc/observe |

### Test Plan

```typescript
// M1-M4: InMemorySlowQueryRecorder
it('records query above threshold')
it('ignores query below threshold')
it('evicts oldest when exceeding max entries')
it('setThreshold changes which queries are recorded')
it('total count returned by getSlowQueryCount')
it('clear() resets all entries')

// M5-M8: InMemoryDeadlockDetector
it('detects 2-node deadlock A→B→A')
it('detects 3-node deadlock A→B→C→A')
it('no false positive on linear chain A→B→C')
it('resolves deadlock by victim selection')
it('removes deadlock nodes from wait-for graph after resolution')
it('reports lock timeout as deadlock event')
it('tracks total deadlock count')

// M9-M10: InMemoryConnectionMonitor
it('tracks open → close round-trip')
it('tracks waiting connections')
it('utilization ratio calculation')
it('returned PoolStatus includes all fields')
it('clears on restart')

// M11-M12: InMemoryAlertRuleManager
it('evaluates rule threshold')
it('skips disabled rules')
it('addRule + removeRule lifecycle')
it('setRuleEnabled toggles')
it('evaluate with empty rules returns empty')
it('evaluate with no matching snapshot key')

// M13-M14: InMemoryResourceQuotaManager
it('allows under memory limit')
it('blocks over memory limit')
it('allows under query rate limit')
it('blocks over query rate limit')
it('updateConfig changes limits at runtime')
it('getConfig returns current limits')

// M15-M17: InMemoryLogger
it('retains entries for assertion')
it('child logger inherits bindings')
it('child logger add own bindings')
it('child logger entries merged context')
it('info/error/warn all log with correct level')
it('error accepts Error object')
it('respects max entries capacity')
it('clear() resets entries')
it('fatal level log entry')

// M18: MetricsRegistry tests
it('counter inc increments by 1')
it('counter incBy increments by n')
it('counter snapshot includes label pairs')
it('gauge set/inc/dec round-trip')
it('gauge add with negative works')
it('histogram observe increases count and sum')
it('histogram getQuantile returns approximate value')
it('multiple metrics with different labels are separate')
it('snapshot includes timestamp')
```

---

## Iteration 3: Backup + PITR Implementation

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| backup | InMemoryBackupManager impl + tests | +2 impl + 1 test | 20 |
| backup | InMemoryPITRManager impl + tests | +1 impl | 6 |
| backup | InMemoryStorageBackend impl + tests | +2 impl + 1 test | 12 |
| backup | RetentionPolicyEvaluator impl + tests | +1 impl | 10 |

### Design

#### InMemoryBackupManager

```
State:
  - snapshots: Map<snapshotId, BackupMetadata>
  - storage: IStorageBackend
  - retention: IBackupRetentionPolicy

createBackup(options):
  id = ulid()
  snapshot = { snapshotId: id, ...options, state: 'in-progress' }
  simulate backup work (store metadata + increment metadata)
  snapshot.state = 'completed'
  return { success: true, snapshot }

listBackups(options):
  filter by type, limit, newerThan
  return matched snapshots sorted by createdAt desc

restoreFromSnapshot(snapshotId, options):
  if !snapshots.has(snapshotId) → return { success: false, error: 'not found' }
  return { success: true, durationMs, recoveryPoint: snapshotId }

prune():
  deletable = retention.evaluate(allSnapshots)
  for each: storage.delete(snapshot.location); snapshots.delete(id)
  return deletable.length
```

#### InMemoryPITRManager

```
State:
  - walLsn: string (simulated)
  - enabled: boolean

getCurrentLSN(): return walLsn
getCurrentTimestamp(): return ISO-8601 now
archiveCurrentWal(): simulate WAL archive
resolveTarget(target): return { snapshotId, walEndLsn, approxTime }
```

#### InMemoryStorageBackend

```
State:
  - objects: Map<key, Buffer>
  - name: 'in-memory'

upload(sourcePath, destKey):
  read file, store as Buffer in map

download(sourceKey, destPath): extract from map, write to file

list(prefix): filter keys by prefix, return with size + lastModified
```

#### RetentionPolicyEvaluator

```
evaluate(snapshots):
  sort by createdAt desc
  keep first maxFullSnapshots
  for remaining:
    calculate total bytes
    if total exceeds maxTotalBytes → mark for deletion
    if minAge specified and snapshot.age > minAge → mark for deletion
    keepRecent overrides (never delete snapshots within keepRecent window)
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| B1 | createBackup returns snapshot with unique ID | snapshotId is non-empty string |
| B2 | createBackup with type=full creates full metadata | snapshot.type === 'full' |
| B3 | createBackup with type=incremental with parent | parentSnapshotId is set |
| B4 | listBackups returns all when no filter | length matches count |
| B5 | listBackups filters by type | only matching types returned |
| B6 | listBackups filters by newerThan | only recent returned |
| B7 | listBackups respects limit | returns ≤ limit items |
| B8 | getBackup by ID returns metadata | match by snapshotId |
| B9 | getBackup with unknown ID returns null | not found |
| B10 | restoreFromSnapshot success path | success=true, duration > 0 |
| B11 | restoreFromSnapshot with unknown ID fails | success=false, error set |
| B12 | deleteBackup removes from list | listBackups no longer contains it |
| B13 | prune respects retention policy | correct count deleted |
| B14 | PITR getCurrentLSN returns string | non-empty |
| B15 | PITR resolveTarget returns valid plan | snapshotId + walEndLsn set |
| B16 | StorageBackend upload + download round-trip | data matches original |
| B17 | StorageBackend list returns correct count | matches number of uploads |
| B18 | StorageBackend health returns ok | accessible |
| B19 | RetentionPolicy maxFullSnapshots enforced | excess deleted |
| B20 | RetentionPolicy keepRecent prevents deletion | within window not pruned |

---

## Iteration 4: Security Implementation

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| security | InMemoryTLSManager impl + tests | +1 impl + 1 test | 8 |
| security | InMemoryCertMonitor impl + tests | +1 impl | 8 |
| security | InMemoryEncryptionManager impl + tests | +1 impl | 10 |
| security | InMemoryRBACProvider impl + tests | +1 impl | 12 |
| security | InMemoryRateLimiter impl + tests | +1 impl | 10 |
| security | InMemorySCIMSyncProvider impl + tests | +1 impl | 6 |
| security | InMemorySecurityCompliance impl + tests | +1 impl | 8 |

### Design

#### InMemoryTLSManager

```
State:
  - config: TLSConfig | null
  - certInfo: CertInfo | null

loadConfig(config):
  validate paths exist, parse cert meta
  certInfo = { subject, issuer, serialNumber, validFrom, validTo, daysRemaining, ... }

getCertInfo(): return certInfo
reloadCerts(): re-read from config path
```

#### InMemoryCertMonitor

```
State:
  - intervalHandle: timer
  - expiryStatus: Map<string, { level, cert }>
  - callbacks: Set<Function>

start(intervalMs): schedule periodic check
stop(): clear timer, clear status
getExpiryStatus(): return entries
onWarning(cb): register callback, return unsubscribe
autoRenew(): simulate ACME, return success
```

#### InMemoryEncryptionManager

```
State:
  - config: EncryptionConfig | null
  - key: Buffer
  - keyVersion: number

encrypt(plaintext):
  return plaintext XOR key (simulated AES-GCM for testing)

decrypt(ciphertext):
  return ciphertext XOR key (simulated)

rotateKey(): generate new key, increment version
```

#### InMemoryRBACProvider

```
State:
  - roles: Map<string, Permission[]>
  - assignments: Map<string, string[]> (identity → role names)

registerRole(role):
  roles.set(role.name, role.permissions)

hasPermission(identity, permission):
  role permissions for identity
  if any role includes the permission → true

getPermissions(identity):
  union of all role permissions
```

#### InMemoryRateLimiter

```
State:
  - windows: Map<key, { count, windowStart }>

check(key, config):
  if windows.has(key):
    if windows[key].count >= config.maxRequests → { allowed: false }
    else → increment, { allowed: true }
  else → create window, { allowed: true }
  return with remaining + resetMs
```

#### InMemorySCIMSyncProvider

```
State:
  - lastSync: Date | null
  - simulated users: string[]

syncUsers(): return { added: N, updated: 0, removed: 0 }
fullResync(): force full sync
getLastSyncTime(): return lastSync
```

#### InMemorySecurityCompliance

```
State:
  - checks: SecurityCheck[]
  - categories: string[]

runChecks():
  run all registered checks
  return passed/failed list

runCategory(category):
  filter by category
  return results

getScore():
  PASS = 1, WARN = 0.5, FAIL = 0
  score = sum / count * 100
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| S1 | TLSManager loadConfig sets cert info | getCertInfo returns valid CertInfo |
| S2 | TLSManager reloadCerts re-reads config | cert metadata updated |
| S3 | CertMonitor start triggers periodic check | onWarning fires |
| S4 | CertMonitor stop clears timer | no further checks |
| S5 | EncryptionManager encrypt/decrypt round-trip | decrypt(encrypt(X)) === X |
| S6 | EncryptionManager isEnabled reflects config | returns boolean |
| S7 | RBACProvider permission check | hasPermission returns true/false |
| S8 | RBACProvider role registration | getRoles includes new role |
| S9 | RateLimiter blocks over limit | allowed=false after maxRequests |
| S10 | RateLimiter allows under limit | allowed=true |
| S11 | RateLimiter resets after window | check after windowMs → allowed=true |
| S12 | SCIMSyncProvider syncUsers returns counts | added > 0 |
| S13 | SCIMSyncProvider getLastSyncTime | returns Date after sync |
| S14 | SecurityCompliance runChecks returns checks | non-empty array |
| S15 | SecurityCompliance runCategory filters | only matching category |
| S16 | SecurityCompliance getScore returns 0-100 | numeric score |

---

## Iteration 5: Observability Implementation

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| observability | InMemoryDistributedTracer impl + tests | +1 impl + 1 test | 18 |
| observability | InMemoryTelemetryExporter impl + tests | +1 impl | 8 |

### Design

#### InMemoryDistributedTracer

```
State:
  - spans: Span[] (completed)
  - active: Map<spanId, Span> (in-flight)
  - currentSpanId: string | null

startSpan(name, options):
  spanId = nanoid()
  traceId = options.traceId ?? (current?.traceId ?? nanoid())
  parentSpanId = options.parentSpanId ?? currentSpanId
  span = { spanId, traceId, parentSpanId, name, startTime: now(), attributes, status: 'ok' }
  active.set(spanId, span)
  currentSpanId = spanId
  return {
    spanId,
    end: (status, error?) => {
      span.endTime = now()
      span.status = status ?? 'ok'
      span.errorMessage = error
      active.delete(spanId)
      spans.push(span)
      currentSpanId = parentSpanId ?? null
    }
  }

getCurrentSpan():
  if !currentSpanId → undefined
  active.get(currentSpanId) → { traceId, spanId }

inject(carrier):
  current = getCurrentSpan()
  if current:
    carrier['traceparent'] = `00-${current.traceId}-${current.spanId}-01`

extract(carrier):
  if 'traceparent' in carrier:
    parse traceparent → { traceId, parentSpanId }
```

#### InMemoryTelemetryExporter

```
State:
  - exported: Span[][]
  - connected: boolean

export(spans):
  exported.push([...spans])

isConnected(): return connected
getFormat(): return 'json'
shutdown(): connected = false
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| O1 | startSpan creates span with unique ID | spanId non-empty, unique per call |
| O2 | end span records duration | endTime >= startTime |
| O3 | nested spans parent-child correctly | child.parentSpanId === parent.spanId |
| O4 | sibling spans have same traceId | same traceId, different spanId |
| O5 | getCurrentSpan returns active span | during span → returns; after end → undefined |
| O6 | inject creates W3C traceparent | `00-{traceId}-{spanId}-01` format |
| O7 | extract parses W3C traceparent | { traceId, parentSpanId } |
| O8 | exporter.export receives spans | exported.length increments |
| O9 | exporter.shutdown marks disconnected | isConnected() = false after shutdown |

---

## Iteration 6: Audit Implementation

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| audit | InMemoryAuditStore impl + tests | +1 impl + 1 test | 16 |
| audit | JsonAuditExporter impl + tests | +1 impl | 8 |

### Design

#### InMemoryAuditStore

```
State:
  - entries: Map<id, AuditEntry>
  - arr: AuditEntry[] (ordered)

write(options):
  id = ulid()
  entry = { id, timestamp: now(), ...options }
  entries.set(id, entry)
  arr.push(entry)
  return id

query(filter):
  filtered = arr.filter(match filter)
  apply offset + limit
  return filtered

get(id): return entries.get(id) ?? null

count(filter):
  if filter → filtered.length else arr.length

pruneOlderThan(timestamp):
  before = arr.length
  arr = arr.filter(e => new Date(e.timestamp) >= timestamp)
  removed = before - arr.length
  for each removed: entries.delete(id)
  return removed
```

#### JsonAuditExporter

```
exportToFile(outputPath, options):
  entries = await store.query(options.filter ?? {})
  format entries as JSON array
  write to outputPath
  return entries.length

exportToString(options):
  entries = await store.query(options.filter ?? {})
  return JSON.stringify(entries, null, 2)
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| A1 | write returns non-empty ID | string length > 0 |
| A2 | get returns matching entry | match by ID |
| A3 | get with unknown ID returns null | not found |
| A4 | query without filter returns all | count matches write count |
| A5 | query filters by operation | only matching operation |
| A6 | query filters by actor | only matching actor |
| A7 | query respects limit | returns ≤ limit |
| A8 | query respects offset | skips first N |
| A9 | pruneOlderThan removes old entries | count decreases |
| A10 | exporter.exportToFile creates file | file exists, non-empty |
| A11 | exporter.exportToString returns JSON | valid JSON array |

---

## Iteration 7: Maintenance Implementation

**Status: PENDING**

### Scope

| Package | Deliverable | Files | Est. Tests |
|---------|-------------|-------|------------|
| maintenance | NoopMaintenanceExecutor impl + tests | +1 impl + 1 test | 10 |
| maintenance | InMemoryMaintenanceExecutor impl + tests | +1 impl | 12 |

### Design

#### InMemoryMaintenanceExecutor

```
State:
  - simulated storage: StorageStats
  - simulated fragmentation: IndexFragmentation[]
  - opsLog: MaintenanceResult[]

vacuum(options):
  if options.dryRun → return { success: true, operation: 'VACUUM', dryRun: true }
  simulate compaction: freeSpaceRatio decreases
  log result
  return MaintenanceResult

analyze(options):
  simulate stats update
  return MaintenanceResult

reindex(options):
  simulate index rebuild
  return MaintenanceResult

getStorageStats(target): return simulated storage stats
getIndexFragmentation(target): return simulated fragmentation
getAutoVacuumStatus(): return { enabled, threshold }
```

### Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| MT1 | vacuum dry run returns success without side effects | dryRun=true, no change to storage stats |
| MT2 | vacuum full reduces free space ratio | freeSpaceRatio decreases |
| MT3 | vacuum with target applies only to target | target field in result |
| MT4 | analyze returns valid result | success=true, operation='ANALYZE' |
| MT5 | reindex returns valid result | success=true, operation='REINDEX' |
| MT6 | reindex sets target correctly | target matches input |
| MT7 | getStorageStats returns valid stats | all fields populated |
| MT8 | getIndexFragmentation returns array | non-empty |
| MT9 | getAutoVacuumStatus returns config | enabled boolean |
| MT10 | operation duration > 0 | durationMs >= 0 |

---

## Overall Test Summary

| Iteration | Packages | Est. Tests | New Files |
|-----------|----------|-----------|-----------|
| 1 (Done) | core, health, logger, metrics, backup, maintenance, audit, security, observability | 146 | 44 |
| 2 | monitor (5 impls), metrics tests, logger tests, maintenance tests | ~125 | 15 |
| 3 | backup (4 impls) | ~48 | 6 |
| 4 | security (7 impls) | ~62 | 8 |
| 5 | observability (2 impls) | ~26 | 4 |
| 6 | audit (2 impls) | ~24 | 4 |
| 7 | maintenance (2 impls