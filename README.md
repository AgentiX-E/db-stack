# AgentiX-E db-stack

One monorepo for the three layers of the AgentiX-E database platform:

| Package | Directory | Role |
|---------|-----------|------|
| `@agentix-e/db-cluster` | `cluster/` | Raft consensus, sharding, HA/fencing, WAL + PITR, transport (mTLS) |
| `@agentix-e/db-federation` | `federation/` | Cross-datacenter replication: CDC, outbox, conflict resolution, anti-entropy |
| `@agentix-e/db-operations` | `operations/` | Engine-agnostic operations framework — 21 packages (health, backup, metrics, security, …) |
| `@agentix-e/db-stack-e2e` | `e2e/` | End-to-end acceptance suites + benchmarks (private, not published) |

The layers depend in one direction only:

```
operations  ←──  federation  ←──  cluster
   (ops)          (multi-DC)        (consensus)
```

`cluster` knows nothing about federation or operations. `federation` embeds `cluster`'s
transport to move bytes between datacenters. `operations` is engine-agnostic and is
consumed by applications, not by the other two at runtime.

## Quick start

```bash
corepack enable
pnpm install

pnpm build          # tsc for every package, then an ESM-specifier codemod
pnpm typecheck      # tsc --noEmit per package
pnpm test           # unit + integration suites (turbo)
pnpm coverage       # v8 coverage per package
pnpm coverage:gate  # fails unless EVERY dimension is ≥ 95% in EVERY package
pnpm e2e            # real multi-process clusters over mutual TLS
pnpm bench:real     # YCSB workloads against a real 3-node cluster
```

## Usage

```ts
// Consensus
import { RaftAdapter, RaftTcpTransport, SqliteStorage } from '@agentix-e/db-cluster';

// Cross-cluster replication
import { FederationManager, MultiLeaderReplication, OutboxStore, TcpSecureTransport }
  from '@agentix-e/db-federation';

// Operations framework
import { health, backup, metrics } from '@agentix-e/db-operations';
```

The `@agentix-e/db-cluster/testing` entry ships the integration harness
(`TestCluster`, certificate generation, a linearizability checker) so downstream
packages can build real clusters in their own tests instead of copying internals.

## Documentation

| Start here | What it covers |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Empty directory → 3-node mTLS cluster → a replicated write, in 15 minutes |
| [docs/concepts.md](docs/concepts.md) | The mental model: consensus groups, shards, federation, guarantees |
| [docs/architecture.md](docs/architecture.md) | High-level architecture and component inventory |
| [docs/user-guide/cluster.md](docs/user-guide/cluster.md) | Consensus, sharding, snapshots, HA/fencing, sessions, watch, PITR |
| [docs/user-guide/federation.md](docs/user-guide/federation.md) | CDC, outbox, conflict resolution, anti-entropy, topology |
| [docs/user-guide/operations.md](docs/user-guide/operations.md) | The 21 engine-agnostic operations packages |
| [docs/user-guide/engine-adapters.md](docs/user-guide/engine-adapters.md) | Plugging **your** database engine into the middleware |
| [docs/user-guide/production-runbook.md](docs/user-guide/production-runbook.md) | Certificates, capacity, monitoring, failure handling, DR |
| [docs/maturity.md](docs/maturity.md) | Feature-by-feature verification matrix, measured coverage, and the gaps |
| [docs/glossary.md](docs/glossary.md) | Every term, defined as this project uses it |

Internal artefacts — product whitepaper, detailed technical design, ADRs, roadmap, audit
and progress reports — live in the companion repository
[`AgentiX-E/db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs).

## Repository layout

```
cluster/
  src/consensus/      RaftAdapter, groups, joint consensus, snapshots, sessions, watch
  src/consensus/transport/  RaftTcpTransport (TLS 1.3 + mTLS), batching, compression
  src/consensus/storage/    SQLite WAL, log compaction, snapshot storage
  src/ha/             failover detection/coordination, fencing, consistency verification
  src/shard/          strategies, reshard planning, online migration
  src/testing/        published test harness
  src/__tests__/      unit · integration · chaos · boundary · linearizability · soak
  tla/                TLA+ specs (JointConsensus, LogReplication)
  bench/              YCSB harnesses

federation/
  src/replication/    CDC, outbox, dedup, anti-entropy, conflict resolution
  src/transport/      TcpSecureTransport (mTLS) + in-process transport
  src/core/           FederationManager, split-brain detection, schema evolution
  src/__tests__/      unit · integration · chaos · performance

operations/
  packages/*/         21 independently publishable packages
  src/index.ts        umbrella entry (namespaced re-exports)

e2e/
  harness/            process harness + node/gateway entry points
  tests/              real TLS cluster suite, cross-cluster sync suite
  bench/              YCSB against a real cluster

docs/                 external documentation (see the table above)
```

No internal design notes, iteration logs or audit reports are kept in this repository:
they belong to `db-stack-docs`, so what ships alongside the code is exactly what a user of
the packages needs.

## Testing philosophy

* **Real, not simulated.** Cluster tests spawn OS processes that speak TLS 1.3 with
  mutual certificate verification. Federation tests run two independent clusters and
  replicate between them over a real TLS link. A node that is killed is a real process
  that dies; a certificate signed by a foreign CA is really rejected.
* **Coverage is a floor, per dimension.** Lines, statements, functions and branches are
  each gated at ≥ 95% per package, and implementation directories are *not* excluded
  from measurement.
* **No skipped suites in the gate.** Soak (`test:soak`) and micro-benchmark suites are
  the only ones outside the pull-request gate; they run on a schedule
  (`.github/workflows/benchmark.yml`) because they need wall-clock time, not because
  they are failing.

## Benchmarks and authoritative measures

| Measure | Tool | Where |
|---------|------|-------|
| Throughput / latency percentiles | **YCSB** core workloads A–F against a real 3-node cluster | `e2e/bench/real-ycsb.ts`, nightly workflow |
| Linearizability of concurrent histories | Wing & Gong / Knossos-style checker (`LinearizabilityChecker`) | `cluster/src/testing`, chaos suites |
| Consensus safety | **TLA+** specs for joint consensus and log replication | `cluster/tla/` |
| Crash/partition behaviour | Jepsen-style chaos harness (partitions, drops, leader kills) | `cluster/src/__tests__/chaos`, `federation/src/__tests__/chaos` |
| Package consumability | import every published entry point from `dist` in plain Node | `scripts/check-package.mjs` |

## CI

`.github/workflows/ci.yml` runs, on every push and pull request:

typecheck (per package) → unit (per package) → integration (per package) →
coverage (per package, 95% per dimension) → coverage gate (all packages) →
E2E (real TLS clusters) → packaging check → security (SCA + secret scan).

`.github/workflows/benchmark.yml` runs nightly: YCSB against a real cluster and the
long-term stability soak.

## Licence

MIT — see [LICENSE](./LICENSE).
