# ADR-002: Exactly-Once Delivery via DedupRing

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

The outbox-before-send pattern guarantees at-least-once delivery. However,
network retransmissions and consumer restarts can cause duplicate deliveries.
We need a mechanism to detect and filter duplicates, achieving exactly-once
semantics at the consumer.

## Decision

We implemented **DedupRing** — an in-memory ring buffer with configurable TTL
that tracks recently delivered message IDs.

### Design

```
DedupRing {
  ttlMs: number;           // How long an entry stays in the ring (default: 600s)
  put(msgId: string): void;  // Mark a message as delivered
  contains(msgId: string): boolean;  // Check if a message was already delivered
}
```

- **Ring buffer** internally for O(1) amortized put/contains
- **TTL-based expiration** — entries older than `ttlMs` are automatically evicted
- **Size bound** — ring capacity grows with insertion rate × ttlMs, never O(n²)

### Deduplication flow

```
Consumer receives message:
  1. dedup.contains(msgId)?  →  YES: drop, increment totalDeduped
  2. dedup.contains(msgId)?  →  NO: dedup.put(msgId), deliver to consumer
```

The put-before-deliver ordering ensures that a crash during delivery results
in a dropped message (at-most-once), which is acceptable because the sender
will retry, and the duplicate will be filtered.

### TTL rationale

- **Default: 600s** — Covers 99.9% of network retry windows (typical retry: 30s with
  exponential backoff to 300s max)
- **Configurable** — Users with high-latency DC links can increase TTL
- **Not infinite** — Unbounded dedup would grow memory without bound

## Consequences

### Positive
- Exactly-once delivery without persistent dedup storage
- O(1) put/contains operations
- Memory-bounded (grows with throughput × TTL, not total history)
- Crash-safe (at-most-once during crash recovery, then exactly-once)

### Negative
- TTL trade-off: very long partitions (>TTL) could produce duplicates
- In-memory only — not crash-recoverable (but acceptable: sender retries)
- Ring size is proportional to message rate, not configurable statically

## Alternatives Considered

### Persistent Bloom filter
- **Pro**: Survives crashes, smaller memory footprint
- **Con**: False positives (small but non-zero probability), more complex
- **Verdict**: Rejected — in-memory ring is simpler and sufficient for TTL-bounded dedup

### Sequence number based (incremental IDs)
- **Pro**: Trivial dedup, no storage needed
- **Con**: Requires monotonically increasing message IDs per partition
- **Verdict**: Not suitable — our messages cross multiple partitions and DCs

## References
- [ADR-001: Outbox-Before-Send Pattern](001-outbox-before-send.md)
- Implementation: `DedupRing.ts`, `src/__tests__/replication/DedupRing.test.ts`
