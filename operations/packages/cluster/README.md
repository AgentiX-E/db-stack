# @agentix-e/db-operations-cluster

The multi-node half of the operations layer. Every module in
`@agentix-e/db-operations-node` answers a question about one process; this package
answers questions about a *set* of them, which is why it needs a member list, a
leader and a majority rule and the node package does not.

```bash
npm install @agentix-e/db-operations-cluster
```

| Export | The question it answers |
| --- | --- |
| `ClusterScalingExecutor` | A scaler said "five nodes". How many does the cluster actually have, and which members leave? |
| `ClusterRolloutPlanner` | Which batch goes first, and does the group still commit while it runs? |
| `RaftFaultTranslator` | A fault says "partition `n1` from the rest". What has to be called, on which transports, in which direction? |
| `InMemoryClusterTopology` | The reference `IClusterTopology` for a fixed member set. |
| `quorumOf`, `tolerableFailures`, `holdsQuorumOf`, … | Majority arithmetic, in one place, so it stops being re-derived per caller. |

## Why a separate package

The split is not organisational. Each of the three assemblers below has to know
something the node-local packages deliberately do not:

- **Who is a voter.** A learner runs the same code and does not count towards
  quorum, so "how many may be down at once" is not `length - 1`.
- **Who is leading.** `leadership-flap` names no node — it means "the one that is
  leading now". Only the cluster knows which one that is.
- **How many may be down at once.** A rolling upgrade that drains three of five
  voters has taken the group's ability to commit with it.

Putting any of that in the node package would make a circuit breaker depend on a
membership system, which is the dependency this workspace exists to avoid.

## Quick start

```ts
import {
  ClusterRolloutPlanner,
  ClusterScalingExecutor,
  InMemoryClusterTopology,
} from '@agentix-e/db-operations-cluster';

const topology = new InMemoryClusterTopology({
  members: [
    { id: 'db-1', role: 'leader' },
    { id: 'db-2', role: 'follower', zone: 'eu-west-1a' },
    { id: 'db-3', role: 'follower', zone: 'eu-west-1b' },
  ],
});

const executor = new ClusterScalingExecutor({ topology, minNodes: 3, maxNodes: 9 });
const outcome = await executor.apply(decision); // a ScaleAction from @agentix-e/db-operations-node/autoscaler

const rollout = new ClusterRolloutPlanner().plan({
  nodes: ['db-2', 'db-3', 'db-1'],
  members: await topology.members(),
  batchStrategy: 'one_by_one',
});
```

## The rule this package is built around

> A plan is an opinion. The member set is the fact.

Everything here reads the topology first and computes from what exists. A
`ScaleAction` carries the count the *scaler* believes in, and that number drifts
the moment anything else changes the membership; a `RollingUpgradePlan` carries the
order an operator typed, and that order is a list rather than a sequence. Both are
inputs. Neither is applied verbatim.

## Documentation

- [`docs/api-reference.md`](./docs/api-reference.md) — every export, with the
  behaviour that is not in the signature.
- [`docs/architecture.md`](./docs/architecture.md) — the taxonomy: node-local,
  cluster-assembled, federation-bound.

## Licence

MIT
