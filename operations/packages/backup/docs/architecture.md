# Architecture

## Position in the Framework

The backup package provides **data durability** — creating, storing, and restoring database snapshots. It's independent of other operational packages except core.

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-backup                    │
│  ┌─────────────────────────────────────────────────┐    │
│  │              IBackupManager                       │    │
│  │  createBackup | listBackups | restoreFromSnapshot│    │
│  │  pitr | prune | deleteBackup                     │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐     │
│  │ IPITR    │ │ IStorage │ │ IBackupRetention      │     │
│  │ Manager  │ │ Backend  │ │ Policy                │     │
│  └──────────┘ └──────────┘ └──────────────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core (types)       │
│              pino (logging)                               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Composability** — `IBackupManager` orchestrates storage and retention as injected dependencies. This enables testing backup logic with `InMemoryStorageBackend` while using S3 in production.

2. **Snapshot lifecycle** — Each snapshot goes through a well-defined state machine: `pending → in-progress → completed → verifying → verified` (or `→ failed`).

3. **Retention as pluggable logic** — The `IBackupRetentionPolicy` interface allows custom retention strategies beyond the provided `RetentionPolicyEvaluator` (e.g., legal hold, compliance-based retention).

## Retention Policy Rules

```
evaluate(snapshots):
  1. Sort newest first
  2. Keep first maxFullSnapshots full snapshots
  3. For remaining candidates:
     a. Skip if keepRecent and age < keepRecent
     b. Skip if minAge and age < minAge
     c. Otherwise → mark for deletion
  4. Enforce maxTotalBytes:
     - Calculate total of remaining (non-deleted) snapshots
     - If > maxTotalBytes, delete oldest until under limit
  5. Return deletion candidates
```
