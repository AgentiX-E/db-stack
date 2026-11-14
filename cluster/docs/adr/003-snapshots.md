# ADR-003: Snapshot and Log Compaction Strategy

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

Raft logs grow without bound. Without compaction:
- Disk usage grows linearly with write throughput
- Node restart replay time grows proportionally
- Storage cost increases over time

We need a strategy that:
1. Truncates committed entries safely
2. Preserves enough history for slow followers to catch up
3. Integrates with application-level snapshots

## Decision

We implemented a **snapshot-driven log compaction** strategy:

1. **Application triggers snapshots** — The storage engine calls `shouldTakeSnapshot()`
   after every N committed entries (configurable via `snapshotInterval`, default: 100).

2. **Snapshot includes full state** — The application serializes its state and stores
   it via the `applyHandler` callback. The snapshot metadata (lastIncludedIndex,
   lastIncludedTerm) is recorded.

3. **Log compaction** — After a snapshot is taken, `compactLogs(lastIncludedIndex)`
   truncates all Raft log entries up to and including that index.

4. **InstallSnapshot RPC** — Slow followers that need entries before
   `lastIncludedIndex` receive the full snapshot via chunked streaming
   (`InstallSnapshotHandler`, G17 extension).

### Key Design Choices

- **Application-owned snapshots** — db-cluster does not decide when or how to
  snapshot. The storage engine controls snapshot timing and format.
- **Snapshot interval vs. size** — Using count-based intervals (not size-based)
  provides predictable compaction frequency.
- **Graceful compaction failure** — If `compactLogs()` fails, we log a warning
  and continue. The next snapshot cycle will retry. No data loss.

## Consequences

### Positive
- Storage engine retains full control over snapshot format
- Predictable compaction frequency via count-based intervals
- Slow followers can catch up via InstallSnapshot (no log gap)
- Compaction failures are non-fatal

### Negative
- Snapshot format is opaque to db-cluster (can't validate consistency)
- InstallSnapshot adds complexity for chunked streaming
- Count-based intervals don't account for entry size variance

## Alternatives Considered

### Time-based compaction (every N seconds)
- **Pro**: Predictable I/O pattern
- **Con**: Under high write load, logs can grow large between compactions
- **Verdict**: Rejected — count-based is more predictable for storage pressure

### Size-based compaction (every N bytes)
- **Pro**: Direct disk space control
- **Con**: Requires tracking entry sizes, complex thresholds
- **Verdict**: Not implemented yet — could be added as an alternative interval mode

## References
- [ADR-001: Why @maboke123/raft-core](001-raft-core.md)
- [Raft Extended Paper §7](https://raft.github.io/raft.pdf) — Log Compaction
- Implementation: `RaftAdapter.shouldTakeSnapshot()`, `RaftAdapter.compactLogs()`, `InstallSnapshotHandler`
