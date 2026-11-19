# @agentix-e/db-operations-rollingupgrade

**Replace a version across a fleet without dropping queries — batches, canary, health gates, automatic rollback.**

The orchestration is the feature; the restart itself is a callback you supply. It decides *when* and *whether to continue*, which is the part with the failure modes.

---

## Features

- **Four batch strategies** — fixed size, percentage, one by one, all at once
- **Canary phase** — configurable fraction, bake time (floor of 10 s), required checks, automatic promotion
- **Five rollback triggers** — first failure, batch threshold, canary failure, SLO degradation, manual only
- **Graceful drain** — wait for in-flight requests, then a connection drain, then a force-kill
- **Pause at batch boundaries** — never mid-batch
- **Injectable clock** — `sleep` is a parameter, so a test does not wait out a bake time

---

## Installation

```bash
npm install @agentix-e/db-operations-rollingupgrade
```

---

## Quick Start

```typescript
import { RollingUpgradeOrchestrator } from '@agentix-e/db-operations-rollingupgrade';

const upgrade = new RollingUpgradeOrchestrator();
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
});
```

---

## API Reference

### `RollingUpgradeOrchestrator`

| Member | Return | Description |
|---|---|---|
| `constructor(opts?)` | — | `{ minBakeMs?, sleep? }` |
| `execute(plan)` | `Promise<RollingUpgradeStats>` | Runs the plan; throws on an invalid plan before touching anything |
| `registerHealthCheck(name, fn)` | `void` | A named check that gates promotion |
| `getPhase()` | `UpgradePhase` | `idle` … `rolling` … `completed` / `failed` / `aborted` / `paused` |
| `getBatches()` | `UpgradeBatch[]` | Batch and per-node state |
| `getEvents()` | `RollingUpgradeEvent[]` | The audit trail |
| `getStats()` | `RollingUpgradeStats \| null` | Aggregate counts |
| `pause()` / `resume()` | `Promise<void>` | Takes effect at a batch boundary |
| `rollback()` | `Promise<RollingUpgradeStats>` | Return upgraded nodes to the previous version |

### `RollingUpgradePlan`

| Field | Meaning |
|---|---|
| `batchStrategy` | `fixed_size`, `percentage`, `one_by_one`, `all_at_once` |
| `canary` | `CanaryConfig`; omit for no canary phase |
| `rollbackTrigger` | Which failure stops the run |
| `batchFailureThreshold` | Fraction a batch may fail, for `on_batch_threshold` |
| `drain` | `timeoutMs`, `waitForInflight`, `connectionDrainMs` |
| `healthCheckNames` | Which registered checks gate promotion |
| `maxDurationMs` | Abort the whole run past this |

---

## Documentation

- [`docs/api/rolling-upgrade.md`](docs/api/rolling-upgrade.md) — the per-batch order of operations, why the canary bake time has a floor, and what a drain timeout does instead of giving up

---

## License

MIT
