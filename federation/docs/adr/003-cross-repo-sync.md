# ADR-003: Cross-Repository Outbox Synchronization

| Field       | Value                                                   |
|-------------|---------------------------------------------------------|
| **Status**  | accepted                                                |
| **Date**    | 2026-08-02                                              |
| **Author**  | Lambertyan <lambertyan@agentix-e.ai>                    |
| **Supersedes** | ADR-001 (outbox-before-send)                          |
| **Superseded by** | —                                                |

## Context

db-federation must synchronize data changes across clusters that may
operate on different database engines (SQLite, PostgreSQL, MySQL). The
core challenge is:

1. **Exactly-once delivery**: a change written to cluster A must arrive
   at cluster B exactly once — no loss, no duplication.
2. **Ordering**: changes from a single logical stream must be applied
   in causal order at the destination.
3. **Resilience**: if cluster B is offline for hours, cluster A's
   outbox must buffer and replay without unbounded growth.

ADR-001 established the outbox-before-send pattern. This ADR extends it
to the cross-repository (multi-engine, multi-schema) case.

## Decision

Implement a **session-based outbox with deduplication rings**:

1. **OutboxStore** (per-session): Each federation session maintains an
   outbox table in the source cluster's database. Every mutation
   writes to both the data table and the outbox in a single
   transaction (outbox-before-send pattern).

2. **SessionManager** orchestrates per-cluster sessions with:
   - W3C traceId propagation for end-to-end tracing across clusters
   - Heartbeat-based health monitoring
   - Automatic session recovery on cluster restart

3. **DedupRing**: A fixed-size ring buffer (default 10K entries)
   tracking recently-applied change IDs. Before applying an incoming
   change, the federation layer checks the DedupRing. If the change ID
   is present, it's a duplicate → skip. This provides O(1) dedup
   without unbounded storage.

4. **HLC (Hybrid Logical Clock)** for causal ordering:
   - Every change is stamped with `{ wallClock, logicalCounter }`.
   - Causal ordering is determined by HLC comparison.
   - Changes are buffered and reordered at the destination if they
     arrive out of order, up to a configurable reorder window.

5. **BackupVerifier**: Periodic checksum comparison between source and
   destination clusters to detect silent data corruption or divergence.

## Consequences

### Positive

- Engine-agnostic: works with any database that supports transactions.
- DedupRing provides bounded-memory deduplication (no unbounded log).
- HLC-based ordering works without synchronized clocks (only monotonic
  wall clock + causality tracking).
- SessionManager recovery enables zero-data-loss failover.

### Negative

- Outbox tables add write amplification: every mutation writes to data
  table + outbox table = 2x writes at the source.
- Reorder window introduces latency jitter: if a change arrives with
  HLC gap > reorder window, it's immediately applied (possible
  reordering).
- DedupRing is lossy for entries that age out. If a duplicate arrives
  after the entry has been evicted from the ring, it will be applied
  twice. Mitigated by sizing the ring to 10× the expected duplication
  window.

### Undone Work

- Cross-session deduplication (currently per-session DedupRing).
- Outbox compaction for long-running sessions to prevent unbounded
  table growth.
- Conflict resolution for concurrent writes to the same key at
  different clusters (currently last-write-wins based on HLC).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| CDC (Change Data Capture) via WAL/tail | Engine-specific; SQLite WAL and PostgreSQL WAL have incompatible formats |
| Two-phase commit (2PC) across clusters | Blocks on network partitions; violates availability requirements |
| Event sourcing with Kafka | Adds infrastructure dependency; defeats embeddability |
| Bloom filter for dedup | False positives cause data loss; DedupRing is exact within its window |

## References

- ADR-001: Outbox-Before-Send Pattern
- ADR-002: Exactly-Once Deduplication via DedupRing
- Kulkarni, S., et al. "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases." (HLC paper)
- `src/outbox/OutboxStore.ts`
- `src/dedup/DedupRing.ts`
- `src/hlc/HLC.ts`
- `src/__tests__/integration/cross-repo-end-to-end.test.ts` — 13 tests
