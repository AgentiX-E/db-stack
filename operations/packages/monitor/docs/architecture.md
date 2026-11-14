# Architecture

## Position in the Framework

The monitor package is one of the most feature-rich operational packages. It depends on `core` for shared types and is used by `observability` for alert/health aggregation.

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-monitor                   │
│  ┌────────────┐ ┌────────────┐ ┌───────────────────┐    │
│  │ Slow Query │ │ Connection │ │ Deadlock Detector │    │
│  │ Recorder   │ │ Monitor    │ │                   │    │
│  └────────────┘ └────────────┘ └───────────────────┘    │
│  ┌────────────┐ ┌──────────────────┐ ┌──────────────┐   │
│  │ Alert Rule │ │ Resource Quota   │ │ Health Check │   │
│  │ Manager    │ │ Manager          │ │              │   │
│  └────────────┘ └──────────────────┘ └──────────────┘   │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Separation of concerns** — Each monitoring capability (slow queries, alerts, deadlocks, connections, quotas) is a standalone module with its own interface and implementation. They don't depend on each other.

2. **In-memory by default** — All implementations store state in memory, making this package immediately useful for testing, development, and single-process deployments without requiring external databases or services.

3. **Eager detection** — The deadlock detector runs cycle detection eagerly when `detectDeadlocks()` is called, not on a timer. This gives the caller full control over detection timing.

4. **Snapshot-based evaluation** — The alert rule engine evaluates rules against a flat `Record<string, number>` snapshot, decoupling metric collection from rule evaluation.

## Deadlock Detection Algorithm

```
reportLockWait(tx1, resource-b)
reportLockAcquired(tx2, resource-b)
reportLockWait(tx2, resource-a)
reportLockAcquired(tx1, resource-a)

detectDeadlocks():
  1. Build graph: for each (waitingTx, [resourcesWanted])
     - For each resource, find holding transactions
     - Edge: waitingTx → holderTx
  2. Result: tx1 → tx2, tx2 → tx1 (cycle detected)
  3. Choose victim: oldest transaction in cycle
  4. Remove victim from wait-for graph
  5. Notify callbacks
```

## Resource Quota Evaluation

```
checkQuota(roleId):
  entry = quotas.get(roleId)
  if not found → allowed (no quota = no limit)
  
  for each dimension in [cpu, memory_mb, connections, query_rate]:
    if usage > limit → return { allowed: false, reason }
  
  return { allowed: true }
```
