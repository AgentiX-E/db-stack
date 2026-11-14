# Architecture

## Position in the Framework

The audit package provides **compliance-grade audit trails**. It's independent of other operational packages — the audit store is used cross-cutting by auth, security, and any service that needs to record operations.

```
┌─────────────────────────────────────────────────────────┐
│               db-operations-audit                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │                  IAuditStore                      │    │
│  │  write | query | get | count | pruneOlderThan    │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │                IAuditExporter                     │    │
│  │           exportToFile | exportToString          │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌────────────┐ ┌─────────────────────────────────┐     │
│  │ InMemory   │ │ JsonAuditExporter               │     │
│  │ AuditStore │ │ (Impl)                         │     │
│  └────────────┘ └─────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Immutable entries** — Once written, an audit entry is never modified. The only mutating operations are new writes, queries, and prunes.

2. **No business logic** — The audit store is a pure append/query/delete system. All business decisions (what to audit, when to prune) are made by the caller.

3. **Export decoupling** — `IAuditExporter` works with any `IAuditStore` implementation, enabling different export formats (JSON, CSV, NDJSON) through additional implementations.

## Query Performance

The `InMemoryAuditStore` performs sequential scans with O(n) complexity. For large audit trails (>10k entries), consider:
- Regular pruning to keep the store small
- Indexing on frequently filtered fields
- Replacing with a SQLite or database-backed implementation
