# Rolling upgrade

Replacing a version across a fleet without dropping queries. The orchestration is
the feature; the actual restart is a callback you supply.

```ts
import { RollingUpgradeOrchestrator } from '@agentix-e/db-node/rollingupgrade';

const upgrade = new RollingUpgradeOrchestrator({
  // How the fleet says which version it is running. This is the only evidence an
  // upgrade happened; a plan without one is refused.
  probe: {
    reportedVersion: async (nodeId) => readBuildVersion(await agent(nodeId)),
    requestUpgrade: async (nodeId, version) => restart(await agent(nodeId), version),
  },
});
upgrade.registerHealthCheck('availability', async (nodeId) => checkNode(nodeId));

const stats = await upgrade.execute({
  id: 'v2-rollout',
  name: 'Upgrade to 2.0.0',
  targetVersion: '2.0.0',
  nodes: ['n1', 'n2', 'n3', 'n4'],
  batchStrategy: 'fixed_size',
  batchSize: 1,
  rollbackTrigger: 'on_first_failure',
  healthCheckNames: ['availability'],
  drain: { timeoutMs: 30_000, waitForInflight: true, connectionDrainMs: 5_000 },
});
```

## `RollingUpgradeOrchestrator`

| Member                          | Contract                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor(opts?)`            | `{ minBakeMs?, sleep?, probe? }`. `sleep` is injectable so a test does not wait out a bake time; `probe` is what makes an upgrade observable          |
| `execute(plan)`                 | Runs the plan and returns `RollingUpgradeStats`. Throws when the plan is invalid, before anything is touched                                          |
| `registerHealthCheck(name, fn)` | A named check. `plan.healthCheckNames` selects which ones gate a batch                                                                                |
| `getPhase()`                    | Where it is: `idle`, `validating`, `canary`, `rolling`, `health_checking`, `completing`, `rolling_back`, `completed`, `failed`, `aborted` or `paused` |
| `getBatches()`                  | Batch and per-node state: `pending`, `draining`, `upgrading`, `health_check`, `completed`, `failed`, `rolled_back`                                    |
| `getEvents()`                   | The audit trail, in order                                                                                                                             |
| `getStats()`                    | Aggregate counts, or `null` before a run                                                                                                              |
| `pause()` / `resume()`          | Pause takes effect at a **batch boundary**, never mid-batch — a half-drained batch is the one state this cannot leave behind                          |
| `rollback()`                    | Return every upgraded node to the previous version and report what it did                                                                             |

## The plan

| Field                   | Meaning                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `batchStrategy`         | `fixed_size`, `percentage`, `one_by_one` or `all_at_once`                                                          |
| `batchSize`             | Used by `fixed_size` and `percentage`                                                                              |
| `canary`                | `CanaryConfig`: fraction, bake time, required checks, `maxCanaryNodes`, `autoPromote`. Omit it for no canary phase |
| `rollbackTrigger`       | `on_first_failure`, `on_batch_threshold`, `on_canary_failure`, `on_degradation`, `manual_only`                     |
| `batchFailureThreshold` | Fraction of a batch that may fail, for `on_batch_threshold`                                                        |
| `drain`                 | `timeoutMs`, `waitForInflight`, `connectionDrainMs`. Defaults: 30 s, wait, 5 s                                     |
| `healthCheckNames`      | Which registered checks gate promotion                                                                             |
| `maxDurationMs`         | Abort the whole run past this                                                                                      |
| `upgradeTimeoutMs`      | How long a node gets to report `targetVersion` (default 30 s)                                                      |
| `upgradePollIntervalMs` | Delay between version reads (default 250 ms)                                                                       |

`CanaryConfig.bakeTimeMs` has a **floor of 10 s**. A canary that is promoted faster
than a health check window has not measured anything; the floor is the difference
between a canary and a batch of size one.

## Order of operations, per batch

```
drain ──▶ upgrade ──▶ report? ──▶ health_check ──▶ promote
  │           │           │            │
  │           │           │            └─ fail ──▶ rollback trigger
  │           │           └─ no ──────────────────▶ rollback trigger
  │           └─ request fails ───────────────────▶ rollback trigger
  └─ timeout ────────────────────────────────────▶ force-kill, then upgrade
```

The `upgrade` step is a **wait**, not a sleep. The orchestrator asks the probe for
the target version and reads `reportedVersion` until the node answers with it, up
to `upgradeTimeoutMs`. A node that answers `null` — restarting, not yet serving —
is waited for; a node that answers the old version until the budget runs out is
**failed**, and the plan's rollback policy decides what happens next. The evidence
is recorded twice: `node_version_confirmed` in the event trail with the number of
polls it took, and `NodeUpgradeState.reportedVersion` on the node itself.

`drain` waits for in-flight requests before `connectionDrainMs` elapses, so a
restart is not a dropped query. A drain that times out does not abandon the node:
it force-kills and upgrades, because a node that will not drain is a node that will
never come back.

## What it does not do

It does not restart anything itself. `probe.requestUpgrade` is the request and
`probe.reportedVersion` is the answer; both belong to whatever owns the process —
a `systemd` unit, a Kubernetes rollout, a shell script. A probe with no
`requestUpgrade` is a valid probe: the caller whose deploy tool replaces processes
leaves it out and lets the version report be the evidence. The orchestrator decides
**when** and **whether to continue**, which is the part that has the failure modes.
