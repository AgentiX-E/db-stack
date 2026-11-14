# ADR-006: Observability Architecture — Logging, Metrics, Health

| Field       | Value                                                   |
|-------------|---------------------------------------------------------|
| **Status**  | accepted                                                |
| **Date**    | 2026-08-02                                              |
| **Author**  | Lambertyan <lambertyan@agentix-e.ai>                    |
| **Supersedes** | —                                                    |
| **Superseded by** | —                                                |

## Context

db-cluster operates as an embedded engine with no external monitoring
by default. Host applications need visibility into:

- **Logs**: structured, leveled, with distributed trace context
- **Metrics**: Raft state (leader changes, commit latency, log size),
  connection counts, throughput
- **Health**: K8s-compatible liveness/readiness/startup probes

We faced a choice: depend on heavy observability frameworks
(OpenTelemetry SDK, prom-client) or build minimal in-process adapters.

## Decision

Build **lightweight, zero-dependency observability adapters** in
`src/observability/`:

1. **LoggingAdapter** — wraps `pino` (the sole external dep, already
   used by host apps) via the `ILogger` interface. Supports:
   - W3C trace context via `AsyncLocalStorage` (no OpenTelemetry dep)
   - Child loggers for component-level scoping
   - All standard levels: trace, debug, info, warn, error, fatal

2. **RaftMetricsCollector** — in-process metrics registry with:
   - `Counter` for monotonic values (proposals_committed, leader_changes)
   - `Gauge` for point-in-time (active_connections, log_bytes)
   - `Histogram` for distributions (commit_latency_ms, apply_latency_ms)
   - `snapshot()` returns a JSON-serializable snapshot
   - `toPrometheusText()` exports OpenMetrics-compatible text format
   - **NOT** using `prom-client` — avoids native addon dependency and
     complex registry management

3. **HealthProbe** — K8s probe pattern:
   - `liveness()` — "should this process be restarted?" (checks event
     loop health, deadlock detector)
   - `readiness()` — "can this process serve traffic?" (checks raft
     leader status, quorum health)
   - `startup()` — "has initialization completed?" (checks bootstrap
     completion)

## Consequences

### Positive

- Host applications get structured observability with zero new
  dependencies beyond pino.
- Prometheus text export is compatible with any metrics scraper
  (Prometheus, VictoriaMetrics, Grafana Agent).
- Health probes are directly consumable by K8s `httpGet` probes.
- AsyncLocalStorage trace context propagation works across `await`
  boundaries with no code changes to existing logic.

### Negative

- Not OpenTelemetry-compliant out of the box. Applications requiring
  OTLP export to Jaeger/Zipkin must add a translation layer.
- Metrics collector is in-memory only — no persistence across restarts.
  Acceptable for embedded usage where host app manages persistence.
- Histogram buckets are manually configured, not auto-adaptive.

### Undone Work

- OTLP export shim for trace spans (currently only trace context, not
  full span export).
- Metric cardinality limits to prevent label explosion.
- Health probe for shard-level granularity (currently cluster-scoped).

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Full OpenTelemetry SDK integration | Adds ~15 transitive dependencies; complex setup; most host apps bring their own telemetry |
| prom-client (npm) | Native addon causes build failures on some platforms; registry management is global and conflict-prone |
| No observability — rely on host app | Unacceptable; embedded engines must self-report health and metrics for production operations |
| Console-only logging with user-provided logger injection | Rejected — too fragile; users forget to inject; structured logging with trace context requires framework support |

## References

- ADR-001: Raft Core Implementation
- ADR-004: Joint Consensus
- W3C Trace Context: https://www.w3.org/TR/trace-context/
- Kubernetes Pod Lifecycle: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes
- `src/observability/LoggingAdapter.ts`
- `src/observability/RaftMetricsCollector.ts`
- `src/observability/HealthProbe.ts`
- `src/__tests__/unit/observability.test.ts` — 28 tests
