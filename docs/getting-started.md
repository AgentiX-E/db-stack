# Getting started

This guide takes you from an empty directory to a **three-node Raft cluster speaking
mutual TLS**, with a value replicated through consensus and read back from every node.
It takes about fifteen minutes and uses only published entry points.

If you would rather read the model first, start with [concepts.md](concepts.md).

---

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Node.js ≥ 20.11 | The packages are ESM-only and use `node:test`-era APIs |
| A POSIX shell | The examples use `openssl`-free certificate generation, but the tooling assumes POSIX paths |
| Ability to listen on three loopback ports | The nodes talk over real TCP sockets, not memory |

```bash
mkdir dbstack-demo && cd dbstack-demo
npm init -y
npm pkg set type=module
npm install @agentix-e/db-cluster
```

The cluster package has one native dependency (`better-sqlite3`, used for the durable
Raft log). If your platform has no prebuilt binary, install a C toolchain first.

---

## 2. Generate certificates

Consensus traffic is authenticated in **both** directions: a node proves its identity and
verifies the identity of its peer. For a local walkthrough, generate a throwaway CA and
one certificate per node with the harness that ships in the package:

```js
// make-certs.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateClusterCerts } from '@agentix-e/db-cluster/testing';

const certs = generateClusterCerts(3);
mkdirSync('certs', { recursive: true });
writeFileSync('certs/ca.pem', certs.caPem);
certs.nodes.forEach((bundle, i) => {
  writeFileSync(`certs/node-${i + 1}.pem`, bundle.cert);
  writeFileSync(`certs/node-${i + 1}.key`, bundle.key);
});
console.log('wrote certs/ for 3 nodes');
```

```bash
node make-certs.mjs
```

> In production you do **not** use this helper. You issue certificates from your own PKI,
> with the node identifier in the certificate CN/SAN (`raft-node-<id>` by default). See the
> [production runbook](user-guide/production-runbook.md#certificates).

---

## 3. Start one node

A node is a `RaftAdapter` plus a durable log. The only application code you write is the
**apply callback**, which receives every committed entry in log order:

```js
// node.mjs
import { readFileSync } from 'node:fs';
import { RaftAdapter } from '@agentix-e/db-cluster';

const id = Number(process.argv[2]);
const port = Number(process.argv[3]);
const peers = [
  { id: 1, host: '127.0.0.1', port: 7001 },
  { id: 2, host: '127.0.0.1', port: 7002 },
  { id: 3, host: '127.0.0.1', port: 7003 },
];

const state = new Map();

const adapter = new RaftAdapter({
  id,
  peers: peers.map((p) => p.id),
  electionTick: 10,
  heartbeatTick: 3,
  tickIntervalMs: 50,
  storagePath: `./data/node-${id}/raft.db`,
  snapshotInterval: 1000, // default 200; raise it only if snapshot cost outweighs restart time
  preVote: true,
  checkQuorum: true,
});

await adapter.init(
  // Called once per committed entry, in index order, on every node.
  (data) => {
    const { key, value } = JSON.parse(data);
    state.set(key, value);
  },
  {
    node: { id, host: '127.0.0.1', port },
    peers,
    tls: {
      cert: readFileSync(`certs/node-${id}.pem`),
      key: readFileSync(`certs/node-${id}.key`),
      ca: readFileSync('certs/ca.pem'),
    },
  },
);

console.log(`node ${id} listening on ${port}`);
```

Start all three in separate terminals (separate processes on purpose — that is what a
real deployment looks like):

```bash
node node.mjs 1 7001
node node.mjs 2 7002
node node.mjs 3 7003
```

Within a few hundred milliseconds one of them is elected leader. There is no
configuration flag for "which node is leader" — that is the point of consensus.

---

## 4. Write through consensus

Only the leader accepts writes; a follower refuses and tells you who the leader is. The
write is not acknowledged until a majority has persisted it:

```js
// write.mjs
import { readFileSync } from 'node:fs';
import { RaftAdapter } from '@agentix-e/db-cluster';

const adapter = new RaftAdapter({ /* same config as node.mjs for node 1 */ });
await adapter.init(apply, transport);   // same arguments as above

if (!(await adapter.isLeader())) {
  console.log(`not the leader; current leader is node ${await adapter.getLeader()}`);
} else {
  const { index, term } = await adapter.propose(JSON.stringify({ key: 'greeting', value: 'hello' }));
  console.log(`committed at index ${index}, term ${term}`);
}
```

`propose()` resolves **after** the entry is committed *and* applied locally. That is a
stronger guarantee than "durably replicated": when the promise resolves, your apply
callback has already run on the leader.

Prefer to open a long-lived client connection and retry against the leader instead of
starting a node per write — see the [cluster guide](user-guide/cluster.md#writing).

---

## 5. Read it back

A read that must not return stale data is a **read barrier**: it round-trips through the
leader's quorum before answering.

```js
await adapter.readBarrier();          // wait until this node has applied the leader's commit index
const status = await adapter.getStatus();
console.log(status.commitIndex, status.appliedIndex);
```

Reading from a follower after `readBarrier()` is safe if the follower is in the same
term as the leader; reading without a barrier is a *stale read* by definition, which is
often exactly what you want for a dashboard and never what you want for a balance.

---

## 6. What just happened

```
client ──propose──▶ leader ──append + fsync──▶ SQLite WAL
                       │
                       ├──AppendEntries (TLS 1.3, mTLS)──▶ follower 2 ──fsync──▶ ack
                       └──AppendEntries (TLS 1.3, mTLS)──▶ follower 3 ──fsync──▶ ack
                       │
                  majority (2/3) ──▶ commit ──▶ apply callback ──▶ promise resolves
```

Kill the leader (`Ctrl-C`) and repeat step 4 against another node: a new leader is
elected, the log is intact, and the value you wrote is still there.

---

## 7. Where to go next

| Goal | Next document |
|---|---|
| Split data across many shards with online resharding | [Cluster guide → sharding](user-guide/cluster.md#sharding) |
| Replicate a cluster to a second datacenter | [Federation guide](user-guide/federation.md) |
| Add health checks, backups, metrics, audit | [Operations guide](user-guide/operations.md) |
| Back the cluster with **your** storage engine instead of SQLite | [Engine adapters](user-guide/engine-adapters.md) |
| Put this in production | [Production runbook](user-guide/production-runbook.md) |
| Run the acceptance suites yourself | `pnpm e2e` in the repository — real processes, real TLS |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| All nodes log `handshake failure` | Certificate CN/SAN does not match `raft-node-<id>` | Re-issue with the expected identity, or set `tls.verify` explicitly |
| No leader after 30 s | Ports unreachable between nodes, or `peers` lists an id that is not running | Check `peers` and firewall rules; a node cannot win an election alone |
| `propose()` hangs | You are proposing on a follower | Check `isLeader()` / `getLeader()` and retry against the leader |
| `SQLITE_CANTOPEN` | `storagePath` directory does not exist | `mkdir -p` the parent directory (the adapter does not create it) |
| Data grows without bound | Snapshots disabled | Set `snapshotInterval` and `maxLogEntries` (see [log compaction](user-guide/cluster.md#log-compaction-and-snapshots)) |
