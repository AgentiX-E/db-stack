# db-stack documentation

This directory is the **external** documentation set: everything a user, evaluator or
integrator needs in order to adopt the stack. Internal artefacts — the product
whitepaper, the detailed technical design, the roadmap, audit reports and iteration
logs — live in the companion repository [`AgentiX-E/db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs).

## Reading paths

Pick the path that matches what you are doing.

| If you want to…                                          | Read, in this order                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Run a cluster in 15 minutes                              | [Getting started](getting-started.md) → [Cluster guide](user-guide/cluster.md)      |
| Understand the model before writing code                 | [Concepts](concepts.md) → [Architecture](architecture.md) → [Glossary](glossary.md) |
| Replicate between two datacenters                        | [Federation guide](user-guide/federation.md)                                        |
| Operate the database (health, backup, metrics, security) | [Operations guide](user-guide/operations.md)                                        |
| Plug in **your own** database engine                     | [Engine adapters](user-guide/engine-adapters.md)                                    |
| Run it in production                                     | [Production runbook](user-guide/production-runbook.md)                              |
| Decide whether it is mature enough for my use case       | [Maturity and coverage](maturity.md)                                                |
| Look up a term                                           | [Glossary](glossary.md)                                                             |

## The three layers in one picture

```
┌──────────────────────────────────────────────────────────────────────┐
│  your application                                                    │
└───────────────┬───────────────────────────────────────────────────────┘
┌───────────────▼───────────────────────────────────────────────────────┐
│                       @agentix-e/db-federation                       │
│  CDC · outbox · conflict resolution · anti-entropy                   │
│  federated identity · cross-cluster query and schema                 │
└───────────────┬───────────────────────────────────────────────────────┘
               │
┌───────────────▼───────────────────────────────────────────────────────┐
│                        @agentix-e/db-cluster                         │
│  Raft consensus per shard · mTLS transport · WAL + snapshots         │
│  sharding · HA/fencing · PITR · membership · rollout · chaos         │
└───────────────┬───────────────────────────────────────────────────────┘
               │
┌───────────────▼───────────────────────────────────────────────────────┐
│                          @agentix-e/db-node                          │
│  core · health · backup · metrics · security · auth · audit          │
│  logger · observability · otel · maintenance · autoscaler · …        │
│  twenty modules, every one about a single process                    │
└──────────────────────────────────────────────────────────────────────┘
```

Dependencies point one way only: `node ← cluster ← federation`. A single-node
deployment installs `db-node` and never loads the other two.

## Documentation inventory

| Document                                                             | Audience                  | What it answers                                                    |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| [getting-started.md](getting-started.md)                             | first-time user           | How do I get a working 3-node cluster and replicate a row?         |
| [concepts.md](concepts.md)                                           | engineer, architect       | What are the moving parts and the guarantees they give?            |
| [architecture.md](architecture.md)                                   | architect, reviewer       | How is the stack built and why is it built that way?               |
| [glossary.md](glossary.md)                                           | everyone                  | What does _joint consensus_, _outbox_, _fencing_, _HLC_ mean here? |
| [user-guide/cluster.md](user-guide/cluster.md)                       | backend engineer          | Consensus, sharding, snapshots, PITR, sessions, watch              |
| [user-guide/federation.md](user-guide/federation.md)                 | backend engineer          | Cross-DC replication, conflict resolution, anti-entropy            |
| [user-guide/operations.md](user-guide/operations.md)                 | SRE / platform            | Health, backup, metrics, security, maintenance, upgrades           |
| [user-guide/engine-adapters.md](user-guide/engine-adapters.md)       | database vendor, platform | Which contract must my engine implement?                           |
| [user-guide/production-runbook.md](user-guide/production-runbook.md) | on-call                   | Certificates, capacity, monitoring, failure handling, upgrades     |
| [maturity.md](maturity.md)                                           | evaluator, architect      | What is verified, how, with which numbers — and what is **not**    |

Each published package also ships its own `README.md` and `CHANGELOG.md`; those are the
closest thing to per-symbol API reference. The cluster package additionally documents
its public surface in [`cluster/docs/api-reference.md`](../cluster/docs/api-reference.md).

## Versioning and support

| Package                    | Version | Node    | Module format  |
| -------------------------- | ------- | ------- | -------------- |
| `@agentix-e/db-node`       | 1.0.0   | ≥ 20.11 | ESM (NodeNext) |
| `@agentix-e/db-cluster`    | 2.0.0   | ≥ 20.11 | ESM (NodeNext) |
| `@agentix-e/db-federation` | 1.2.0   | ≥ 20.11 | ESM (NodeNext) |

The three are versioned independently: they ship on their own cadence, and a change to
`cluster` does not force a release of `node`.

The cluster package publishes a **conformance suite** in its `/testing` entry point
(`runEngineConformance`). It is the executable form of the storage-engine contract: an engine
author runs it against a candidate adapter instead of inferring the requirements from the
middleware's behaviour. Federation's capture, outbox and transport contracts are documented
in [engine adapters](user-guide/engine-adapters.md) and exercised by the federation suites,
but are not yet published as a reusable suite — that gap is tracked in the roadmap.

All packages are MIT licensed. The stack has no runtime dependency on any specific
database engine: SQLite is the default _reference_ storage for the Raft log, and every
engine-facing seam is an interface you can implement (see
[engine adapters](user-guide/engine-adapters.md)).
