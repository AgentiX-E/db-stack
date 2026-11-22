# Migrating from 1.x package names to 2.0

`@agentix-e/db-operations-<module>` is finished. **No further release will be published under any of
those names.** The last version that exists stays installed and installable, and it receives no fixes —
not a security patch, not a bug fix, not a version bump. This page is the whole migration, and it is
four lines of work: one dependency, one import prefix, once.

## What changed

| Before | After |
| --- | --- |
| `@agentix-e/db-operations` | nothing — the umbrella re-exported every module and a version constant, and both are gone |
| `@agentix-e/db-operations-core` | `@agentix-e/db-node/core` |
| `@agentix-e/db-operations-audit` | `@agentix-e/db-node/audit` |
| `@agentix-e/db-operations-auth` | `@agentix-e/db-node/auth` |
| `@agentix-e/db-operations-autoscaler` | `@agentix-e/db-node/autoscaler` |
| `@agentix-e/db-operations-autotuner` | `@agentix-e/db-node/autotuner` |
| `@agentix-e/db-operations-backup` | `@agentix-e/db-node/backup` |
| `@agentix-e/db-operations-chaosengine` | `@agentix-e/db-node/chaosengine` |
| `@agentix-e/db-operations-circuitbreaker` | `@agentix-e/db-node/circuitbreaker` |
| `@agentix-e/db-operations-configwatcher` | `@agentix-e/db-node/configwatcher` |
| `@agentix-e/db-operations-health` | `@agentix-e/db-node/health` |
| `@agentix-e/db-operations-logger` | `@agentix-e/db-node/logger` |
| `@agentix-e/db-operations-maintenance` | `@agentix-e/db-node/maintenance` |
| `@agentix-e/db-operations-memoryguard` | `@agentix-e/db-node/memoryguard` |
| `@agentix-e/db-operations-metrics` | `@agentix-e/db-node/metrics` |
| `@agentix-e/db-operations-monitor` | `@agentix-e/db-node/monitor` |
| `@agentix-e/db-operations-observability` | `@agentix-e/db-node/observability` |
| `@agentix-e/db-operations-otel` | `@agentix-e/db-node/otel` |
| `@agentix-e/db-operations-rollingupgrade` | `@agentix-e/db-node/rollingupgrade` |
| `@agentix-e/db-operations-security` | `@agentix-e/db-node/security` |
| `@agentix-e/db-operations-slacollector` | `@agentix-e/db-node/slacollector` |

The module keeps its name, so the edit is the same everywhere:

```diff
-import { AuditTrail } from '@agentix-e/db-operations-audit';
+import { AuditTrail } from '@agentix-e/db-node/audit';
```

and in `package.json`, twenty dependencies become one:

```diff
-  "@agentix-e/db-operations-audit": "^1.11.3",
-  "@agentix-e/db-operations-backup": "^1.11.3",
+  "@agentix-e/db-node": "^2.0.0",
```

## Two things did move

A name that maps one-to-one is the easy half. Two categories were **not** only renamed — they are
different packages now, because they decide something about a group of nodes rather than about one, and
that is a boundary rather than a topic:

- **`@agentix-e/db-cluster`** owns membership arithmetic, scale-down, rollout order and Raft fault
  translation: `ClusterScalingExecutor` applies a `ScaleAction`, `ClusterRolloutPlanner` orders one, and
  `RaftFaultTranslator` maps a partition into the events the consensus engine raises. `autoscaler` and
  `rollingupgrade` remain in `@agentix-e/db-node`, because they produce a `ScaleAction` and a
  `RollingUpgradePlan` — data about a group is not authority over one — and the two classes that turn
  those into members added and members removed live where the authority is.
- **`@agentix-e/db-federation`** owns federated identity, cross-cluster query routing, repair, and the
  change-data-capture path: the change log reader, the exactly-once pipeline, the subscription pump and
  the TLS transport between datacenters.

Consult the [user guide](./README.md) for each package's entry points; the [glossary](./glossary.md)
names the concepts, and `architecture.md` states why the split falls where it does.

## What this page is checked against

`pnpm check:legacy-names` reads this table, and fails when it disagrees with the workspace: a retired
name with no row, a row naming a subpath `@agentix-e/db-node` does not export, or a source file in this
repository that still imports an old name. The gate exists because a migration page is prose, and prose
about a package list goes stale the first time a module moves.
