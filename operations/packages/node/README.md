# @agentix-e/db-operations-node

Twenty modules that operate on **one node**, in one package. A probe probes its own
process, a breaker trips on its own call site, an audit store appends to its own
directory, a PITR chain restores its own snapshot — none of them needs to know how
many nodes exist, and that is the property that decides what lives here.

```bash
npm install @agentix-e/db-operations-node
```

```ts
import { KeyManager } from '@agentix-e/db-operations-node/security';
import { FileAuditStore } from '@agentix-e/db-operations-node/audit';
import * as node from '@agentix-e/db-operations-node';

node.health.HealthOrchestrator;
```

## Modules

| Subpath | What it is |
| --- | --- |
| `core` | The shared base: 40+ types and the provider registry. |
| `audit` | Append-only audit log: crash-safe segments, rotation, export, query. |
| `auth` | Authentication interfaces. Interfaces only — `security` implements them. |
| `autoscaler` | Scaling decisions from multi-dimensional metrics. |
| `autotuner` | Tuning recommendations for engine parameters. |
| `backup` | PITR, WAL-LSN bookkeeping and snapshot chains. |
| `chaosengine` | Fault definitions and the scenario runner. |
| `circuitbreaker` | Breaker state per call site. |
| `configwatcher` | Configuration watching and change notification. |
| `health` | Liveness, readiness and startup probes. |
| `logger` | The `ILogger` port and an in-memory implementation. |
| `maintenance` | VACUUM / ANALYZE / REINDEX scheduling. |
| `memoryguard` | Heap-pressure guard. |
| `metrics` | Counters, gauges and histograms. |
| `monitor` | Slow-query, connection-pool and deadlock detection. |
| `observability` | W3C trace context and spans. |
| `otel` | The OpenTelemetry bridge. |
| `rollingupgrade` | Upgrade plans, batching and health gating. |
| `security` | TLS, RBAC and encryption at rest — the implementation of `auth`. |
| `slacollector` | SLA event collection. |

## What is not here

Anything that has to reason about a *set* of nodes. Which node is removed first,
how many may be down at once without losing quorum, what a fault on node 3 means
for the leader — all of that lives in
[`@agentix-e/db-operations-cluster`](../cluster), and the modules above expose the
data those decisions are computed from (`ScalingPolicy.minNodes`,
`RollingUpgradePlan.nodes`) rather than the decisions themselves.

Two consequences worth knowing:

- `autoscaler` produces a `ScaleAction` whose `targetCount` is the count *it*
  believes in. Applying it to a live group is `ClusterScalingExecutor`'s job,
  because only that side can see how many members actually exist.
- `rollingupgrade` batches the node list it is given, in the order it is given.
  Ordering that list so the leader goes last and no batch costs quorum is
  `ClusterRolloutPlanner`'s job.

## Documentation

Each module has its own `docs/` directory — `docs/<module>/README.md`,
`docs/<module>/api/*.md`, `docs/<module>/architecture.md`. The module's own page is
the one to read first: it states what the module decides and what it deliberately
does not.

## Licence

MIT
