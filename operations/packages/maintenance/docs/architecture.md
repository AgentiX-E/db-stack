# Architecture

## Position in the Framework

The maintenance package provides **database health operations** that keep storage efficient and query performance optimal. It depends on `core` for shared maintenance types.

```
┌─────────────────────────────────────────────────────────┐
│               db-operations-maintenance                  │
│  ┌─────────────────────────────────────────────────┐    │
│  │              IMaintenanceExecutor                 │    │
│  │  vacuum | analyze | reindex | getStorageStats    │    │
│  │  getIndexFragmentation | getAutoVacuumStatus     │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌────────────────────┐ ┌──────────────────────────┐    │
│  │ InMemoryExecutor   │ │ NoopExecutor (Fallback)  │    │
│  └────────────────────┘ └──────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Engine-agnostic operations** — VACUUM, ANALYZE, and REINDEX are universal database concepts. The interface defines the *what*, not the *how*.

2. **Safety-first** — All operations support `dryRun` to preview before executing. This prevents accidental long-running operations in production.

3. **Simulation for testing** — `InMemoryMaintenanceExecutor` is not a mock; it simulates real behavior (compaction, fragmentation reduction, dead row reclamation) with configurable initial state.

## Operation Effects (InMemory)

```
VACUUM (incremental):
  freeSpaceRatio -= 0.25
  deadRowCount -= 140,000

VACUUM (full):
  (same as incremental PLUS)
  pageCount *= 0.85
  fileSizeBytes = pageCount * pageSize

REINDEX (per index):
  fragmentationRatio *= 0.1
  pageCount *= 0.7
```
