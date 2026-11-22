# @agentix-e/db-node

**Everything a single database node needs — 20 modules, 3 148 test cases in 155 files, every
coverage dimension at or above 95 %.**

Twenty modules that operate on **one node**, in one package. A probe probes its own
process, a breaker trips on its own call site, an audit store appends to its own
directory, a PITR chain restores its own snapshot — none of them needs to know how
many nodes exist, and that is the property that decides what lives here.

```bash
npm install @agentix-e/db-node
```

```ts
import { KeyManager } from '@agentix-e/db-node/security';
import { FileAuditStore } from '@agentix-e/db-node/audit';
import * as node from '@agentix-e/db-node';

node.health.HealthOrchestrator;
```

## Modules

| Module | What it is | Cases |
| --- | --- | --- |
| [`core`](./src/core/) | The shared base: 40+ types and the provider registry. | 550 |
| [`audit`](./src/audit/) | Append-only audit log: crash-safe segments, a hash chain per writer, rotation, export, query, verification. | 309 |
| [`auth`](./src/auth/) | Authentication interfaces. Interfaces only — `security` implements them. | 32 |
| [`autoscaler`](./src/autoscaler/) | Scaling decisions from multi-dimensional metrics. | 167 |
| [`autotuner`](./src/autotuner/) | Tuning recommendations for engine parameters. | 27 |
| [`backup`](./src/backup/) | Real capture, digests, bucket confirmation, a durable inventory, chains, PITR. | 295 |
| [`chaosengine`](./src/chaosengine/) | Fault definitions and the scenario runner. | 128 |
| [`circuitbreaker`](./src/circuitbreaker/) | Breaker state per call site. | 15 |
| [`configwatcher`](./src/configwatcher/) | Configuration watching and change notification. | 107 |
| [`health`](./src/health/) | Liveness, readiness and startup probes. | 78 |
| [`logger`](./src/logger/) | The `ILogger` port and an in-memory implementation. | 55 |
| [`maintenance`](./src/maintenance/) | VACUUM / ANALYZE / REINDEX scheduling. | 382 |
| [`memoryguard`](./src/memoryguard/) | Heap-pressure guard. | 13 |
| [`metrics`](./src/metrics/) | Counters, gauges and histograms. | 38 |
| [`monitor`](./src/monitor/) | Slow-query, connection-pool and deadlock detection. | 129 |
| [`observability`](./src/observability/) | W3C trace context and spans. | 44 |
| [`otel`](./src/otel/) | The OpenTelemetry bridge. | 16 |
| [`rollingupgrade`](./src/rollingupgrade/) | Upgrade plans, batching and health gating. | 121 |
| [`security`](./src/security/) | TLS, RBAC and encryption at rest — the implementation of `auth`. | 629 |
| [`slacollector`](./src/slacollector/) | SLA event collection. | 13 |

**Total: `pnpm coverage` reports 155 files and 3 148 tests, 0 failures** (`test:unit`: 136 files /
2 816; `test:integration`: 19 files / 332). Each row above is that module's contribution, so the
column adds up to the total. `pnpm check:test-counts` reads the runner's JSON report and fails when
any of these numbers disagrees with it — a number in prose has no compiler, so this gate is that
compiler.

## Quality

| Measure | Result |
| --- | --- |
| Coverage — lines / statements / functions / branches | 99.48 % / 99.48 % / 99.87 % / 98.61 %, every file gated at 95 % |
| Mutation — sixteen files in four modules, gate at 86 | each mutant read against the tests the report attributes to it; the score and the survivor arguments are in [`docs/maturity.md`](../docs/maturity.md) |
| Published surface | 22 entry points, 375 exports, 69 documents, and `pnpm check:docs-api` fails if a documented symbol is not exported |

The sixteen mutated files — in `backup`, `audit`, `security` and `maintenance` — are the ones
that decide what gets deleted, whether a backup can be restored, which key material survives at
all, which key a blob was sealed with, whether a compliance window passed, whether evidence is
tamper-evident, and when a maintenance window runs. The other sixteen modules have unit,
integration and coverage gates but no mutant measures their assertions — a selection rule, not an
oversight, published in [`docs/maturity.md`](../docs/maturity.md) §5.

## What is not here

Anything that has to reason about a *set* of nodes. Which node is removed first,
how many may be down at once without losing quorum, what a fault on node 3 means
for the leader — all of that lives in
[`@agentix-e/db-cluster`](../cluster), and the modules above expose the
data those decisions are computed from (`ScalingPolicy.minNodes`,
`RollingUpgradePlan.nodes`) rather than the decisions themselves.

Two consequences worth knowing:

- `autoscaler` produces a `ScaleAction` whose `targetCount` is the count *it*
  believes in. Applying it to a live group is `ClusterScalingExecutor`'s job,
  because only that side can see how many members actually exist.
- `rollingupgrade` batches the node list it is given, in the order it is given.
  Ordering that list so the leader goes last and no batch costs quorum is
  `ClusterRolloutPlanner`'s job.

If you need a single-datacenter cluster, install
[`@agentix-e/db-cluster`](../cluster) instead — it depends on this package, so one
install brings both. If you need cross-datacenter replication, install
[`@agentix-e/db-federation`](../federation), which depends on both.

## Documentation

Each module has its own `docs/` directory — `docs/<module>/README.md`,
`docs/<module>/api/*.md`, `docs/<module>/architecture.md`. The module's own page is
the one to read first: it states what the module decides and what it deliberately
does not.

```bash
npm test              # 155 files, 3 148 tests
npm run coverage      # writes coverage/test-report.json, the file check:test-counts reads
```

## Licence

MIT
