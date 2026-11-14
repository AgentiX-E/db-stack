# Iteration Index

| I | Topic | Repository | Tests | Coverage | Commit |
|:--|------|------|:--:|:--:|--------|
| I1-I7 | Foundation (Raft, outbox, pipeline, 20 packages) | all | ~1800 | ≥95% | — |
| I8 | Coverage boost + LTS flaky fix | db-cluster | 654 | ≥95% | `5050154` |
| I9 | Cross-repo stress resilience | db-federation | 13 new | ≥95% | `54eaf6e` |
| I10 | Unified CI/CD with dependency-gated triggers | db-federation | — | — | `8e58b9a` |
| I11 | Heavy-load performance & stress testing | db-federation | 6 new | ≥95% | `3bc15cb` |
| I12 | Security audit pipeline (3 repos) | all | — | — | `dc2b9cb` |
| I13 | Observability stack (logs + metrics + health + trace) | db-cluster + db-operations | 58 new | ≥95% | `e2707f8` / `ccc1a68` |
| I14 | Documentation system (ADRs, API ref, architecture) | all | — | — | `c3f8155` / `149e9ea` / `d7ca24d` |

## Test Totals

| Repository | Tests | Coverage |
|------------|:--:|:--:|
| db-cluster | 654 | ≥95% |
| db-federation | 434+ | ≥95% |
| db-operations | 1126 | ≥95% |
| **Total** | **~2214** | **≥95%** |

## ADR Inventory

| Repository | ADRs |
|------------|------|
| db-cluster | 001-raft-core, 002-transport, 003-snapshots, 004-joint-consensus, 005-leader-fencing, 006-observability |
| db-federation | 001-outbox-before-send, 002-exactly-once-dedup, 003-cross-repo-sync, 004-federation-pipeline |
| db-operations | 001-interface-first |

## Key Documents

- [Architecture Panorama](cross-repo-architecture.md) — Cross-repo topology, data flow, module map
- [db-cluster API Reference](../db-cluster/docs/api-reference.md)
- [db-federation API Reference](api-reference.md)
- [I10 CI/CD Pipeline](I10-CROSS-REPO-CI.md)
- [I12 Security Audit](I12-SECURITY-AUDIT.md)
- [I13 Observability](I13-OBSERVABILITY.md)

| I16 | Release readiness (v1.0.0) | all | 0 | — | `6c5fe0d` / `328aace` / `17c26b8` |

---

## v1.1.0 Iterations (I17–I20)

| Iteration | Description | Repo(s) | Tests | Coverage | Commit |
|-----------|-------------|---------|------:|----------|--------|
| I17 | Chaos Unification | db-operations + db-cluster + db-federation | 109 | ≥95% | `c71dccd` / `d8ff4e1` / `ad41b70` |
| I18 | Multi-Active Production Readiness (C1) | db-federation | 22 | ≥95% | `fedf4da` |
| I19 | Regression + Silent Test Mode | db-cluster + db-federation | 1091 | ≥95% | `6c4cfa2` / `6586493` |
| I20 | v1.1.0 Release | all | — | — | — |

### I17: Chaos Unification

Replaced ~2700 lines of duplicated fault-injection code with a single ChaosEngineV2
in db-operations + adapters in each sibling repo.

- **ChaosEngineV2** (468 lines) — declarative DAG scenarios, 8 fault types, SeededRNG
- **RaftChaosAdapter** — `raft:<nodeId>` transport convention, 27 tests
- **FederationChaosAdapter** — `federation:<dcId>:<nodeId>`, wildcard support, 34 tests

### I18: Multi-Active Production Readiness

Closed all 4 critical C1 gaps identified in code audit:
1. CDCManager (224 lines) — per-target CDCEngine workers, backpressure
2. DCSplitBrainDetector (324 lines) — HLC chain divergence heuristic, auto/manual recovery
3. ConflictResolver on write hot path in FederationManager.replicate()
4. AntiEntropy integration with localStore-backed DataProvider

### I19: Regression & Test Infrastructure

- db-cluster: vitest.setup.ts silences pino logs → 28s (was 10min+ timeout)
- db-federation: updated stub tests for I18 interfaces
- Full suite: 85 files / 1091 tests all passing

### I20: v1.1.0 Release

- All three repos bumped to v1.1.0
- CHANGELOG entries for I17-I20
- npm pack verified for all packages
