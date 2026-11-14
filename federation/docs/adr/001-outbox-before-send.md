# ADR-001: Outbox-Before-Send Pattern for Cross-DC Replication

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

Cross-DC replication requires durability guarantees even during network partitions
and DC outages. If the CDC pipeline reads from the source and sends directly to
the target without persisting, a crash or network failure could lose events.

We need:
1. Every captured change to be persisted before acking to the source
2. At-least-once delivery to handle retransmission
3. Exactly-once delivery at the consumer

## Decision

We implemented the **outbox-before-send pattern**:

```
Source DB  →  CDCEngine  →  OutboxStore (LMDB persist)  →  Pump  →  Transport  →  DedupRing  →  Target DB
                                                       (batch pull)    (retry)     (exactly-once)
```

1. **CDCEngine** captures changes and writes them to **OutboxStore** (LMDB) immediately.
2. **OutboxStore** persists each change before returning control. Changes are
   written in batches for performance.
3. **Pump** reads batches from OutboxStore and sends them via Transport.
4. **Transport** delivers each message with retry on failure.
5. **DedupRing** at the consumer filters duplicates by `messageId`, achieving
   exactly-once delivery.

### Crash Recovery

On restart, the pipeline:
1. Loads the last checkpoint (last confirmed LSN per table) from disk
2. Replays OutboxStore entries after the checkpoint
3. DedupRing re-initializes from the checkpoint state

## Consequences

### Positive
- Zero data loss on crash — everything is persisted before sending
- Exactly-once delivery at consumer via DedupRing
- LMDB provides ACID durability for the outbox
- Checkpoint enables fast restart without full replay

### Negative
- LMDB adds filesystem dependency (outbox data directory)
- Write amplification: every change is written twice (source + outbox)
- Batch pump adds latency (~500ms default) vs. immediate send

## Alternatives Considered

### Direct send (no outbox)
- **Pro**: Lower latency, simpler code
- **Con**: Data loss on crash or network partition
- **Verdict**: Rejected — durability is non-negotiable

### Kafka as outbox
- **Pro**: Established, scalable, multi-consumer
- **Con**: Adds external dependency, heavy for embedded npm package
- **Verdict**: Rejected — LMDB is embeddable, zero-config, ACID

## References
- [Microsoft Transactional Outbox Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/transactional-outbox)
- Implementation: `ExactlyOnceCDCPipeline`, `OutboxStore`, `DedupRing`
