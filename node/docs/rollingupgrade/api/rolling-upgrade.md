# Rolling upgrade

Replacing a version across a fleet without dropping queries. The orchestration is
the feature; the actual restart is a callback you supply.

```ts
import { RollingUpgradeOrchestrator } from "@agentix-e/db-node/rollingupgrade";

const upgrade = new RollingUpgradeOrchestrator();
upgrade.registerHealthCheck("availability", async (nodeId) => checkNode(nodeId));

const stats = await upgrade.execute({
  id: "v2-rollout",
  name: "Upgrade to 2.0.0",
  targetVersion: "2.0.0",
  nodes: ["n1", "n2", "n3", "n4"],
  batchStrategy: "fixed_size",
  batchSize: 1,
  rollbackTrigger: "on_first_failure",
  healthCheckNames: ["availability"],
  drain: { timeoutMs: 30_000, waitForInflight: true, connectionDrainMs: 5_000 },
});
```

## `RollingUpgradeOrchestrator`

| Member | Contract |
|---|---|
| `constructor(opts?)` | `{ minBakeMs?, sleep? }`. `sleep` is injectable so a test does not wait out a bake time |
| `execute(plan)` | Runs the plan and returns `RollingUpgradeStats`. Throws when the plan is invalid, before anything is touched |
| `registerHealthCheck(name, fn)` | A named check. `plan.healthCheckNames` selects which ones gate a batch |
| `getPhase()` | Where it is: `idle`, `validating`, `canary`, `rolling`, `health_checking`, `completing`, `rolling_back`, `completed`, `failed`, `aborted` or `paused` |
| `getBatches()` | Batch and per-node state: `pending`, `draining`, `upgrading`, `health_check`, `completed`, `failed`, `rolled_back` |
| `getEvents()` | The audit trail, in order |
| `getStats()` | Aggregate counts, or `null` before a run |
| `pause()` / `resume()` | Pause takes effect at a **batch boundary**, never mid-batch — a half-drained batch is the one state this cannot leave behind |
| `rollback()` | Return every upgraded node to the previous version and report what it did |

## The plan

| Field | Meaning |
|---|---|
| `batchStrategy` | `fixed_size`, `percentage`, `one_by_one` or `all_at_once` |
| `batchSize` | Used by `fixed_size` and `percentage` |
| `canary` | `CanaryConfig`: fraction, bake time, required checks, `maxCanaryNodes`, `autoPromote`. Omit it for no canary phase |
| `rollbackTrigger` | `on_first_failure`, `on_batch_threshold`, `on_canary_failure`, `on_degradation`, `manual_only` |
| `batchFailureThreshold` | Fraction of a batch that may fail, for `on_batch_threshold` |
| `drain` | `timeoutMs`, `waitForInflight`, `connectionDrainMs`. Defaults: 30 s, wait, 5 s |
| `healthCheckNames` | Which registered checks gate promotion |
| `maxDurationMs` | Abort the whole run past this |

`CanaryConfig.bakeTimeMs` has a **floor of 10 s**. A canary that is promoted faster
than a health check window has not measured anything; the floor is the difference
between a canary and a batch of size one.

## Order of operations, per batch

```
drain ──▶ upgrade ──▶ health_check ──▶ promote
  │           │              │
  │           │              └─ fail ──▶ rollback trigger
  │           └─ fail ─────────────────▶ rollback trigger
  └─ timeout ──────────────────────────▶ force-kill, then upgrade
```

`drain` waits for in-flight requests before `connectionDrainMs` elapses, so a
restart is not a dropped query. A drain that times out does not abandon the node:
it force-kills and upgrades, because a node that will not drain is a node that will
never come back.

## What it does not do

It does not restart anything. `registerHealthCheck` is how it observes, and the
restart itself belongs to whatever owns the process — a `systemd` unit, a
Kubernetes rollout, a shell script. The orchestrator decides **when** and **whether
to continue**, which is the part that has the failure modes.
