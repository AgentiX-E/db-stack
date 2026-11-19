# @agentix-e/db-operations-federation

**Route queries across shards, and keep the shards' schemas from drifting apart.**

Two concerns that look like one: *where does this query go*, and *do all the shards agree on what the schema is*. They are separate classes because a query can be routed perfectly across shards whose schemas disagree — and that is the case that must be visible rather than hidden.

> This is the **operations-domain** federation package: query routing and schema federation over shards you already run. Cross-datacentre replication lives in `@agentix-e/db-federation`.

---

## Features

- **Six routing strategies** — round robin, least connections, weighted, geo affinity, cost based, leader only
- **Explainable plans** — `planQuery()` returns assignments with the strategy and estimated cost that produced them
- **Failover history** — every node skipped or failed over, with the reason
- **Six drift types** — including the one version checks cannot see: same version, different checksum
- **Six repair actions** — apply, rollback, reorder, resync, mark resolved, force version
- **Coordinated migration** — `all`, `canary`, `batched`, `manual`, with pre-apply snapshot, verification and automatic rollback

---

## Installation

```bash
npm install @agentix-e/db-operations-federation
```

---

## Quick Start

```typescript
import { FederatedQueryRouter, SchemaFederator } from '@agentix-e/db-operations-federation';

const router = new FederatedQueryRouter();
router.registerNode({
  id: 'eu-1', host: 'eu-1.internal', port: 5432,
  role: 'primary', health: 'healthy',
  shardIds: ['shard-a'], weight: 1,
  capabilities: ['read', 'write'], region: 'eu',
});
router.setRoutingPolicy({ strategy: 'cost_based', skipUnhealthy: true, maxRetries: 2 });

const plan = router.planQuery({
  id: 'q-1', sql: 'SELECT * FROM orders WHERE id = $1',
  intent: 'read', consistency: 'read_your_writes',
  targetShards: ['shard-a'], params: { id: 42 }, timeoutMs: 2_000,
});

const result = await router.executePlan(plan, executor);
```

---

## API Reference

### `FederatedQueryRouter`

| Member | Return | Description |
|---|---|---|
| `registerNode(node)` / `deregisterNode(id)` | `void` | The node inventory |
| `updateNodeLoad(id, load)` / `updateNodeHealth(id, health)` | `void` | What strategies decide from |
| `setRoutingPolicy(policy)` | `void` | Partial; merged with the current policy |
| `planQuery(query)` | `QueryPlan` | Assignments without executing |
| `executeQuery(query, executor)` / `executePlan(plan, executor)` | `Promise<FederatedResult>` | Plan and run / run a plan |
| `mergeResults(results)` | `FederatedResult` | Combine per-node results |
| `getFailoverHistory()` | `FailoverEvent[]` | Why a node was skipped |
| `computeNodeScore(node, threshold?)` | `number` | The ranking score, exposed for reproduction |

### `SchemaFederator`

| Member | Return | Description |
|---|---|---|
| `captureSnapshot(shardId)` / `registerShard(snapshot)` | `Promise<SchemaSnapshot>` / `void` | The schema inventory |
| `compareShards(a, b)` / `compareAgainstReference(shardId)` | `SchemaDrift[]` | Drift between two / against the reference |
| `detectAllDrifts()` | `Promise<SchemaDrift[]>` | Every shard against the reference |
| `planRepair(drift)` / `executeRepair(repair)` | `DriftRepair` | Decide, then act |
| `autoRepair()` | `Promise<DriftRepair[]>` | Plan and execute for every repairable drift |
| `startCoordinatedMigration(plan, mode?, verify?)` | `CoordinatedMigration` | Roll a migration out as one operation |

---

## Documentation

- [`docs/api/federation.md`](docs/api/federation.md) — the strategies, the drift types (and why `checksum_divergence` is the dangerous one), the repair actions, and the reference-shard strategies

---

## License

MIT
