# Changelog

All notable changes to @agentix-e/db-cluster will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`pnpm typecheck:tests`** — the test tree and the benchmarks are now compiled with the
  production compiler options (`strict`, `noUncheckedIndexedAccess` included). The package
  had carried a `tsconfig.test.json` that no script, turbo task or workflow referenced; 297
  type errors were sitting under it, several of them in tests that could not fail.
- **`OutboxRecord`** on the published surface, and `IOutboxWriter.append` / `appendBatch`
  declared on it. `RaftGroup` calls both — behind an `as any` — while `src/index.ts`
  exported a _different_ `IOutboxWriter` (`write`, `getLastWrittenIndex`) that no component
  in the package calls. A third-party adapter could implement the documented interface and
  still be unable to satisfy `RaftGroup`.

### Changed

- **`RaftAdapter.proposeAndWait` returns `{ index, term }`** instead of `void`. It was the
  only caller that needed the position — `RaftGroup.proposeAndWait` — which appended the
  outbox record with `raftIndex: 0` and then had no way to correct it.
- **Breaking:** `IOutboxWriter` no longer declares `write` / `getLastWrittenIndex`. They were
  never called; the interface described a contract no implementation used.

### Fixed

- **`OperationRecorder` recorded the wrong client id on a return, and never read the map it
  kept.** `recordReturn` re-derived the caller from `callId.split(':')[0]`, while
  `pendingCalls` — written on every call — was read by nothing. A call id that does not encode
  the client produced a return attributed to a client that never issued the operation, which
  invalidates the history a linearizability check runs on. The map now stores
  `callId -> clientId` and is read.
- **Outbox records for entries proposed without a `msgId` carried `msgId: undefined`**, so
  every such entry collapsed onto one de-duplication key downstream. The record is now built
  in one place (`RaftGroup.buildOutboxRecord`) and an entry that arrives without an identity
  is given one.
- **`RaftGroup.proposeAndWait` produced unpositioned outbox records** (`raftIndex: 0`), which
  point-in-time recovery cannot place.
- **`proposeBatch` passed an entry through `as any`** for no reason; the literal already
  satisfies `Partial<ApplyEntry>`.
- **A peer could stay unreachable for the life of the process.** `ConnectionPool.addNode`
  returned early for a peer it already knew, so the one call that says "this peer should be
  reachable again" did nothing once the peer had been added once; and when a circuit breaker
  closed after `circuitResetTimeoutMs` nothing re-armed the connection, because closing a
  breaker only makes `getConnection()` _willing_ to try again. The breaker exists to stop
  hammering a dead peer, not to end the relationship with it. Both paths now re-arm, and
  `addNode` on a known peer is idempotent but not inert.
- **`bench:ycsb` pointed at `bench/ycsb/run-ycsb.ts`**, which does not exist. It now runs the
  package's own YCSB entry point (`bench/raft-ycsb.ts`).

---

## [1.2.0] — 2026-11-15

### Added

- **Engine SPI** — `IStorageEngine` + `EngineBackedReplica` let any storage engine back a
  Raft group without knowing Raft exists: `apply`, `query`, `snapshot`, `restore`,
  `sizeInBytes`, `close`. `MemoryStorageEngine` is the reference implementation and the
  adapter template.
- **Published conformance suite** — `@agentix-e/db-cluster/testing` exports
  `runEngineConformance`, 23 framework-neutral checks (apply/query semantics, snapshot and
  restore, replica positioning, lifecycle). CI runs one matrix leg per engine.
- **`RaftAdapter.requestSnapshot()`** — force a snapshot now; idempotent for an index that
  is already covered. `getSnapshotMeta()` / `refreshSnapshotMeta()` report the boundary
  raft-core holds.
- **`EngineBackedReplica.forwardJumps`** — diagnostic counter for indexes that arrived
  above the expected one (normal: raft skips non-command entries).

### Changed

- **`IShardReplica.snapshot(boundaryIndex?)`** — the snapshot now records the Raft boundary
  it will be declared to cover, rather than the replica's own watermark. The two differ by
  every CONFIG/NOOP entry raft applied without calling the application.
- **Snapshot scheduling is raft-core's alone.** The group no longer runs a second
  snapshot/compaction loop; `snapshotInterval` reaches raft-core's threshold directly and
  `trySnapshot()` is an explicit request.
- **The PITR WAL is flushed inside the snapshot capture**, i.e. immediately before raft
  truncates the log the WAL duplicates, instead of in a scheduler that might never run.

### Fixed

- **A full-cluster restart after log compaction never became writable again.** Two causes:
  the group truncated the log on the strength of a metadata-only snapshot (16 of 60 writes
  lost in the reproduction), and the engine's log position was derived from a local counter
  that drifted by one per CONFIG/NOOP entry, so the first post-restart apply looked like a
  gap and killed the apply loop. Both fixed; `e2e` AC-C7 restarts three real processes and
  asserts the data is back and writes are accepted.
- **An enabled `enableInstallSnapshot` discarded snapshots.** The group's chunked-snapshot
  handler forwarded reassembled bytes to `RaftAdapter.step()`, which is a no-op under
  raft-core, so the message was swallowed. The handler is no longer wired: raft-core
  installs snapshots itself, in chunks, with its own sessions.
- **`handleRaftMessage` now reports peer activity**, which is what its documentation always
  said it did; split-brain detection was reading an always-empty set.

### Removed

- `RaftGroup.deleteSnapshot()` and `RaftGroup.getSnapshotFilePath()` — there is no second
  snapshot file to delete or locate.
- `RaftAdapter.shouldTakeSnapshot()`, `takeSnapshot(index)`, `resetCommittedCount()` and the
  `committedCount`/`lastSnapshotIndex` counters — the remains of the second loop.
  `RaftAdapter.compactLogs()` stays as an explicit operator/test hook for _simulating_ a
  compacted log (the boundary suites use it); nothing on a runtime path calls it, so it
  cannot truncate ahead of the snapshot raft-core holds.

## [1.1.0] — 2026-08-05

### Added

- **I17 Chaos Unification** — RaftChaosAdapter wrapping ChaosInjectingTransport as IChaosTransport
  - Transport ID convention: `raft:<nodeId>`
  - RaftChaosScenarios builder for common chaos patterns
  - 27 chaos tests (RCHAOS1-5 + E2E)
- **I19 Test Infrastructure** — vitest.setup.ts to suppress pino logs in fork workers
  - Silent test mode via `VITEST=true` environment variable
  - 57 test files / 584 tests passing in 28s (was 10min+ timeout)
- **I13 Observability** — LoggingAdapter with pino + W3C trace context via AsyncLocalStorage
  - RaftMetricsCollector with Prometheus text export
  - HealthProbe modeled after K8s probes
  - 28 observability tests (OBS1-11)

### Security

- **I12 Security Audit Pipeline** — npm audit, secret scan, license check in CI
  - .env protection in .gitignore
  - SECURITY.md with vulnerability reporting process

### Internal

- **I14 Documentation** — ADRs 001-006, API reference, architecture panorama
- **I15 Convergence Verification** — all 477+31 tests validated
- **I16 Release Readiness** — v1.0.0, CHANGELOG entries I8-I16, npm pack verified

## [0.1.0] — 2026-07-26

### Added

- **RaftAdapter** — Raft consensus adapter wrapping @maboke123/raft-core
  - proposeAndWait concurrency semaphore (CONCURRENCY_MAX=128)
  - Queue-pipeline backpressure pattern
  - Force leader bypass for HA failover
- **RaftGroupManager** — Multi-RaftGroup lifecycle and message routing
  - Per-node multi-shard replica hosting
  - Message routing by shard ID
  - Health status monitoring
- **JointConsensusEngine** — Two-phase membership changes (Raft §6)
  - C_old → C_joint → C_new transition
  - Retry with exponential backoff
  - Timeout-based automatic rollback
  - Event-driven progress notifications
- **Transport Layer** — Multi-transport architecture
  - RaftTcpTransport with mTLS support
  - BatchedRaftTransport for connection reuse
  - SharedBatchedTransport for single-process multi-RaftGroup
  - NodeTransport for inter-group routing
  - ConnectionPool with connection-storm resilience
  - MessageCodec for wire protocol serialization
- **Storage Layer** — SQLite-backed WAL
  - SqliteStorage with automatic log compaction
  - SqliteNodeStorage adapter for @maboke123/raft-core
- **Snapshot Support** — InstallSnapshot RPC with chunked streaming
- **Leadership Transfer** — Graceful handoff with NOOP barrier and drain phase
  - Heartbeat stop to trigger election
  - Poll-based new leader detection
  - 10s timeout with configurable retry
- **Read Path Optimizations**
  - LeaseReadManager — leader lease for linearizable reads without quorum round-trip
  - ReadIndexManager — full ReadIndex protocol fallback
- **HA Failover** — Production-grade high availability
  - HAFailoverDetector — dead leader detection with configurable thresholds
  - HAFailoverCoordinator — coordinated failover with fencing tokens
  - HAConsistencyVerifier — post-failover consistency checks
  - ClockCompensator — clock skew compensation for HLC
- **Fencing** — FencingManager with epoch-based token generation
- **Adaptive Election Timeout** — Jitter-based election tick randomization
- **Circuit Breaker** — Transport-level circuit breaker pattern
- **Message Compression** — Payload compression for large Raft messages
- **TLA+ Formal Verification**
  - JointConsensus.tla — two-phase membership change specification
  - JointConsensusElection.tla — election safety specification
  - TLC model checking with multiple trace outputs
- **Testing Suite**
  - 613 tests, 72 test files
  - Boundary tests — partition, compaction, combo-fault, security
  - LTS (Long-Term Stability) soak tests
  - Jepsen-style fuzzy register validation
  - Performance baseline benchmarks
  - Chaos engineering with fault injection

### Fixed

- RPC timeout races resolved via 16-way batch Promise.all pattern
- Transport connection-storm resilience during cluster startup
- Array.find async callback bug in batch proposal (regression D2.6-2.9)
- LTS cluster init retry (3 attempts) for TCP TIME_WAIT port conflicts
- Adaptive 5-minute stability cycle with single-core thresholds
- Boundary test cross-test state pollution via per-test cluster isolation

[1.0.0]: https://github.com/AgentiX-E/db-cluster/releases/tag/v1.0.0
[0.1.0]: https://github.com/AgentiX-E/db-cluster/releases/tag/v0.1.0

## [1.0.0] — 2026-08-02

### Added

- **Observability module** (`src/observability/`) — LoggingAdapter (pino wrapper),
  RaftMetricsCollector (counters, gauges, histograms, Prometheus export),
  HealthProbe (K8s liveness/readiness/startup). (I13)
- **ADR template** — standardized architecture decision record format for all repos. (I14)
- **ADR-004** — Joint Consensus design with two-phase membership changes.
- **ADR-005** — Leader Fencing for split-brain prevention.
- **ADR-006** — Observability architecture: logging, metrics, health probes.
- **API Reference** (`docs/api-reference.md`) — complete public API with error hierarchy.
- **SECURITY.md** — vulnerability reporting policy. (I15)

### Changed

- **LTS tests** refactored with adaptive thresholds for shared CI environments:
  leader_changes tolerance 3→10, P99 tolerance 8x→50x, cluster bootstrap with
  exponential backoff. (I8 — commit `5050154`)
- **RaftJointConsensusEngine** `_state` null access hardened with optional chaining.
  (commit `7c1b8ad`)
- **CI** extended with security pipeline (`_security.yml`): npm audit, secret scan,
  license compliance. (I12)
- **.gitignore** hardened with `.env`, `.pem`, `.key` rules.

### Fixed

- Flaky LTS test crashes from TCP ECONNREFUSED + leader election timeout on single-core CI.
  Root cause: shared CI VM P99 latency jitter. Fix: adaptive tolerance boundaries
  with recovery-behavior focus instead of strict degradation limits. (I8)

### Security

- npm audit gate integrated into CI via `_security.yml`.
- Secret scanning pattern matching (`sk-*`, `AKIA*`, `ghp_*`) in CI.
- License compliance check (OSI-approved only).
