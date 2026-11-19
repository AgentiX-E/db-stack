# Query routing and schema federation

Two concerns that look like one: *where does this query go* and *do all the shards
agree on what the schema is*. They are separate classes because a query can be
routed perfectly across shards whose schemas disagree, and that is exactly the case
that must be visible rather than hidden.

```ts
import { FederatedQueryRouter, SchemaFederator } from "@agentix-e/db-operations-federation";
```

## `FederatedQueryRouter`

```ts
const router = new FederatedQueryRouter();
router.registerNode({
  id: "eu-1",
  host: "eu-1.internal",
  port: 5432,
  role: "primary",
  health: "healthy",
  shardIds: ["shard-a"],
  weight: 1,
  capabilities: ["read", "write"],
  region: "eu",
});
router.setRoutingPolicy({ strategy: "cost_based", skipUnhealthy: true, maxRetries: 2 });

const plan = router.planQuery({
  id: "q-1",
  sql: "SELECT * FROM orders WHERE id = $1",
  intent: "read",
  consistency: "read_your_writes",
  targetShards: ["shard-a"],
  params: { id: 42 },
  timeoutMs: 2_000,
});

const result = await router.executePlan(plan, executor);
```

| Member | Contract |
|---|---|
| `registerNode(node)` / `deregisterNode(id)` | The node inventory: `id`, `host`, `port`, `role`, `health`, `shardIds`, `weight`, `capabilities`, `region`, optional `load` |
| `updateNodeLoad(id, load)` / `updateNodeHealth(id, health)` | What the strategies decide from |
| `setRoutingPolicy(policy)` | Partial. The current policy is merged with what you pass |
| `planQuery(query)` | Assignments without executing. `strategy` and `estimatedCost` are recorded on the plan, which is what makes a routing decision explainable after the fact |
| `executeQuery(query, executor)` | Plans and runs |
| `executePlan(plan, executor)` | Runs a plan you already have — the path a retry takes, so a retry does not re-plan onto the same failing node |
| `mergeResults(results)` | Combine per-node results into one `FederatedResult` |
| `getFailoverHistory()` | Every node that was skipped or failed over, with the reason |
| `computeNodeScore(node, threshold?)` | The score a strategy ranks by. Exposed so a routing decision can be reproduced without executing anything |

### Strategies

`round_robin`, `least_connections`, `weighted`, `geo_affinity`, `cost_based`,
`leader_only`.

`consistency` decides how much the plan may spread: `strong` restricts writes to a
leader, `read_your_writes` requires the assignment that can see the caller's last
write, `eventual` may go anywhere healthy. `skipUnhealthy` and `geoAffinity` in the
`RoutingPolicy` narrow the candidate set before the strategy ranks it.

### Execute through a callback

`NodeExecutor` is the seam; this package never opens a connection. The router
decides, the executor runs, and a deployment that already has a pool passes a
function that uses it.

## `SchemaFederator`

```ts
const federator = new SchemaFederator();
federator.registerShard(await federator.captureSnapshot("shard-a"));

const drifts = await federator.detectAllDrifts();
for (const drift of drifts) {
  const repair = federator.planRepair(drift);
  if (repair.action !== "mark_resolved") await federator.executeRepair(repair);
}
```

| Member | Contract |
|---|---|
| `captureSnapshot(shardId)` / `registerShard(snapshot)` / `getSnapshot(id)` | The schema inventory, with a checksum per snapshot |
| `compareShards(a, b)` | Drift between two shards, from the recorded snapshots |
| `compareAgainstReference(shardId)` | Drift against the configured reference — the mode a nightly check uses |
| `detectAllDrifts()` | Every shard against the reference |
| `getDrift(id)` / `getActiveDrifts()` / `getDriftsForShard(id)` / `getDriftHistory()` | Read views. `getActiveDrifts` excludes resolved entries |
| `planRepair(drift)` | The repair a drift calls for, without performing it |
| `executeRepair(repair)` | Perform it and return the outcome |
| `autoRepair()` | Plan and execute for every repairable drift. Returns the ones it attempted |
| `resolveManually(driftId, resolution)` | Mark a drift resolved with a reason, when the repair is a decision rather than an action |
| `startCoordinatedMigration(plan, mode?, verify?)` | Roll a migration across shards as one operation |

### Drift types

`version_mismatch`, `missing_migration`, `extra_migration`, `checksum_divergence`,
`order_divergence`, `migration_state_mismatch`, each with a severity of `info`,
`warning` or `critical`.

The distinction that matters: `version_mismatch` is *two shards at different
versions*; `checksum_divergence` is *two shards at the same version with different
content*. The second one is the dangerous one, because every version-based check
says the shards agree.

### Repair actions

`apply`, `rollback`, `reorder`, `resync`, `mark_resolved`, `force_version`.

`mark_resolved` exists because not every drift is a defect — a shard intentionally
ahead of the fleet is a drift with a reason. Recording the reason is the difference
between an exception list and an unread report.

### Coordinated migration

`startCoordinatedMigration(plan, mode, verify)` rolls a `MigrationPlan` out in one
of four `CoordinationMode`s — `all`, `canary`, `batched`, `manual` — capturing a
pre-apply snapshot, verifying after each step, and rolling back automatically when
verification fails. `CoordinationState` reports where it is; `verify: false` is for
the case where the migration is not verifiable and a human is watching.

## Reference strategies

`primary`, `majority`, `latest`, `canonical`: which shard the others are compared
against. `majority` is the default a fleet wants — comparing everything to a
hand-picked shard makes that shard's drift the definition of correct.
