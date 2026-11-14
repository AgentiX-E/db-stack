# ADR-004: Federation Pipeline — Stage-Based Processing

| Field       | Value                                                   |
|-------------|---------------------------------------------------------|
| **Status**  | accepted                                                |
| **Date**    | 2026-08-02                                              |
| **Author**  | Lambertyan <lambertyan@agentix-e.ai>                    |
| **Supersedes** | —                                                    |
| **Superseded by** | —                                                |

## Context

Cross-cluster data replication involves multiple processing stages:
extract from outbox, serialize, transmit, deserialize, deduplicate,
reorder, apply, verify. A monolithic pipeline couples all stages,
making it hard to:
- Add new stages (e.g., encryption, compression, schema translation)
- Monitor stage-level throughput and latency
- Handle stage-specific failures (transient network vs permanent schema
  mismatch)
- Test stages in isolation

## Decision

Implement a **composable, stage-based pipeline** with:

1. **Pipeline interface**: `IFederationStage<TIn, TOut>` with:
   - `process(batch: TIn[]): Promise<TOut[]>` — batch processing
   - `name: string` — stage identifier for metrics
   - `onError(error, batch): ErrorAction` — per-stage error policy
     (retry, skip, abort, dead-letter)

2. **Standard stages** (composable in any order):
   ```
   Extract → Serialize → Compress → Transmit → Decompress →
   Deserialize → Deduplicate → Reorder → Validate → Apply → Verify
   ```

3. **PipelineBuilder** for declarative composition:
   ```typescript
   const pipeline = new PipelineBuilder()
     .stage(new ExtractStage(outboxStore))
     .stage(new SerializeStage(jsonCodec))
     .stage(new CompressStage({ algorithm: 'lz4' }))
     .stage(new TransmitStage(transport))
     .stage(new DedupStage(dedupRing))
     .stage(new ReorderStage({ window: 1000 }))
     .stage(new ApplyStage(targetDb))
     .build();
   ```

4. **Metrics per stage**: Each stage exports counters (processed,
   succeeded, failed, skipped) and histograms (batch_latency_ms,
   item_latency_ms). The pipeline aggregates these for dashboard.

5. **Error action matrix**:

   | Error Type            | Action     | Rationale                              |
   |-----------------------|------------|----------------------------------------|
   | Network timeout       | retry (3×) | Transient                              |
   | Schema mismatch       | dead-letter| Requires operator intervention         |
   | Checksum failure      | abort      | Data corruption — stop the pipeline   |
   | Dedup ring overflow   | skip (log) | Non-critical; ring is best-effort      |

## Consequences

### Positive

- Stages are independently testable with mock inputs/outputs.
- Pipeline can be reconfigured at runtime (add compression for
  slow links, remove for local clusters).
- Stage-level metrics give granular visibility into bottlenecks.
- Error policies are declarative and consistent.

### Negative

- Each stage adds a buffer copy, increasing memory pressure for large
  batches. Mitigated by streaming where possible (TransmitStage uses
  chunked transfer).
- PipelineBuilder adds indirection; a typo in stage ordering
  (e.g., Dedup before Deserialize) is a runtime error, not compile-time.
  Mitigated by runtime validation at build().
- ~200 lines of pipeline infrastructure for 5 production stages.

### Undone Work

- Dynamic stage insertion/removal at runtime (currently requires
  pipeline rebuild).
- Backpressure from slow stages to fast stages (currently fixed-size
  buffers with drop-oldest policy).
- Stage-level circuit breakers (stop processing if error rate exceeds
  threshold).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Monolithic sync loop (single function) | Inflexible; hard to test, monitor, or extend |
| Event-driven with message queue (RabbitMQ/Kafka) | Infrastructure dependency; violates embeddability |
| RxJS/observable pipeline | Too heavy for an embedded library; pipeline is synchronous batch processing, not async streaming |
| Linear chain only (no builder) | Error-prone; ordering bugs in manual composition would be silent |

## References

- ADR-001: Outbox-Before-Send Pattern
- ADR-002: Exactly-Once Deduplication via DedupRing
- ADR-003: Cross-Repository Outbox Synchronization
- Hohpe, G., & Woolf, B. (2003). "Enterprise Integration Patterns." — Pipes and Filters pattern.
- `src/pipeline/PipelineBuilder.ts`
- `src/__tests__/performance/cross-repo-performance.test.ts` — I11 pipeline stress tests
