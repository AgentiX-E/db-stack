# ADR-001: Interface-First, Engine-Agnostic Architecture

**Status**: Accepted  
**Date**: 2026-07-26  
**Deciders**: Lambertyan

## Context

Agentix-E develops multiple database engines (sqlvec-db, graphvec-db, and future
engines). Each engine needs operational capabilities: health checks, backup/restore,
monitoring, security, audit, metrics, logging, maintenance, auth, and observability.

Without a shared framework, each engine implements these from scratch — with
incompatible APIs, inconsistent error handling, and duplicated testing.

## Decision

We adopted an **interface-first, engine-agnostic architecture** with three layers:

```
Interfaces (canonical contracts) → General Implementations → Engine Adapters
```

### Layer 1: Interfaces (in `packages/*/src/interfaces/`)

Every operational concern is defined as a TypeScript interface with:
- Explicit method signatures with typed parameters and returns
- Typed error contracts (what errors can each method throw)
- Engine-agnostic primitives (no sqlvec, graphvec, or engine-specific types)
- Composable — small interfaces combine into larger orchestrators

Example: `IHealthProbe` → `IComponentRegistrar` → `IHealthOrchestrator`

### Layer 2: General Implementations (in `packages/*/src/impl/`)

Implementations that work with any engine via dependency injection:
- `HealthOrchestrator` — aggregates probes from a `ProviderRegistry`
- `MetricsRegistry` — stores counters/gauges/histograms, exports via reporters
- `FileAuditStore` — writes audit events to files regardless of engine

### Layer 3: Engine Adapters (in `packages/*/src/adapters/`)

Engine-specific adapters that bridge the generic interface to engine internals:
- `SqlVecSlowQueryRecorder` — extracts slow query info from sqlvec-db internals
- `GraphVecDeadlockDetector` — monitors graph traversal deadlocks
- `NoopSlowQueryRecorder` — no-op for testing

## Consequences

### Positive
- One implementation serves all engines
- New engines only need adapters, not full implementations
- Consistent API surface across all engines
- Isolated testing — each interface can be tested with mocks
- Zero engine dependencies in the operations framework

### Negative
- Some generality overhead (adapters vs. direct engine calls)
- Interface evolution requires careful versioning
- Initial adapter development cost for each new engine

## Alternatives Considered

### Per-engine implementations (no shared framework)
- **Pro**: No abstraction overhead, simpler code per engine
- **Con**: Duplicated effort for 12+ operational concerns × 2+ engines
- **Verdict**: Rejected — unsustainable at scale

### Mono-repo with shared code (not interface-first)
- **Pro**: Code sharing without strict interfaces
- **Con**: Tight coupling between engines and operations, hard to test
- **Verdict**: Rejected — interfaces provide better contracts and testability

## References
- [DESIGN.md](../../DESIGN.md) — Complete package architecture
- [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — Layer diagrams
