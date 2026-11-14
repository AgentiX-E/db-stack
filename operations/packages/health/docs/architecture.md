# Architecture

## Position in the Framework

The health package is the **first layer of operational abstraction** built on top of `core`. It provides the health-check vocabulary used by higher-level packages like `monitor` and `observability`.

```
┌─────────────────────────────────────────────────────────┐
│                  db-operations-health                    │
│  ┌─────────────┐ ┌──────────────────┐ ┌────────────┐   │
│  │ IHealthProbe │ │ IComponentRegis- │ │ HealthOrch │   │
│  │ (Interface) │ │ trar (Interface) │ │ (Impl)     │   │
│  └─────────────┘ └──────────────────┘ └────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │         componentProbe() — Factory                │   │
│  └──────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                    Dependencies                          │
│              @agentix-e/db-operations-core               │
└─────────────────────────────────────────────────────────┘
```

## Design Principles

1. **K8s probe semantics** — The three probe types (liveness, readiness, startup) follow Kubernetes conventions exactly. This allows drop-in use with `httpGet` and `exec` probes.

2. **Aggregation over inheritance** — Rather than each component implementing its own health endpoint, components register probes with the orchestrator, which provides a single API for all health checks.

3. **Fast path isolation** — `liveness()` must be extremely fast and side-effect-free. The orchestrator runs it first to catch critical failures quickly before doing deeper checks.

4. **Functional simplicity** — The `componentProbe()` factory makes it trivial to create probes without writing a class, lowering the barrier to comprehensive health monitoring.

## Health Check Flow

```
K8s / HTTP Probe
        │
        ▼
HealthOrchestrator
   ┌────────────┐
   │ liveness() │──► For each probe: probe.liveness()
   └────────────┘       ┌─ ok? → next probe
                        └─ fail? → collect error
   ┌─────────────┐
   │ readiness() │──► For each probe: probe.readiness()
   └─────────────┘       (also includes liveness checks)
   ┌────────────┐
   │ startup()  │──► For each probe: probe.startup()
   └────────────┘       (also includes readiness checks)
                        ┌─ all ok → mark startupComplete
                        └─ any fail → return errors
```

## Status Aggregation Logic

```
Aggregate Status = f(componentHealth):
  total = components.length
  allHealthy = every component has ok liveness AND ok readiness
  allUnhealthy = every component has failed liveness OR failed readiness

  total === 0         → 'healthy'
  allUnhealthy        → 'unhealthy'
  allHealthy          → 'healthy'
  otherwise           → 'degraded'
```
