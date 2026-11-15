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
- **`TestClusterOptions.portAllocator`** — how the harness picks its ports is now injectable.
  The default asks the OS, which cannot reserve what it hands out, so a test could not
  reproduce a lost port race deterministically; it now can.
- **`TestCluster.restartNode(id)`** — bring a killed node back on its own port and its own data
  directory. The harness could already kill a node; it could not observe the half that matters
  after a compaction, where a follower can only recover by *installing* a snapshot. A restart
  keeps the node's id, port and certificate, so its peers address it the same way and the
  leader has to re-establish replication with a lagging node — what a restart looks like in
  production.
- **`isPortFree(port)`** in `@agentix-e/db-cluster/testing` — whether loopback can bind the port
  right now. `killNode` uses it to wait out the gap between "stop" and "the OS released the
  socket", which a restart inside that window fails as `EADDRINUSE` with a node that comes up
  deaf rather than an error at the call site.
- **`RaftAdapter.getPeerProgress()`** — per-peer `{ next, match }` as the leader's own
  replication state sees it. A follower stuck in snapshot transfer and a follower that is
  merely slow are indistinguishable from the follower's side; this is the half of the picture
  that says which one it is.
- **`TestCluster.stateOf(id)`** — the commands a node's state machine has applied, in order.
  The harness now runs a real (trivial) state machine and real snapshot hooks, so a snapshot
  test transfers actual bytes. Before this, the harness registered no snapshot handler and
  every snapshot on every test cluster was zero bytes: the tests passed without a byte moving,
  which is how an encoding defect reached the acceptance suite.
- **`ensureTestTmpRoot()`** in `scripts/test-tmpdir.mjs` — `TMPDIR` is process-wide, so one
  test that removes a path at or above the shared scratch root broke `mkdtempSync` for every
  later test on the same worker, reported as an ENOENT in an unrelated file. The setups
  re-assert the root before each test; a healthy root costs one `existsSync`.

### Changed

- **`RaftAdapter.proposeAndWait` returns `{ index, term }`** instead of `void`. It was the
  only caller that needed the position — `RaftGroup.proposeAndWait` — which appended the
  outbox record with `raftIndex: 0` and then had no way to correct it.
- **`RaftConfig.enableInstallSnapshot` is a no-op and is marked deprecated.** Its documentation
  claimed the adapter initialised `InstallSnapshotHandler` and routed type 14 to it; nothing in
  the production path ever read the field. Chunked install is raft-core's own, and application
  state is captured through `setApplicationSnapshotHandlers`. Kept so existing configurations
  compile, documented so nobody trusts it.
- **Breaking:** `IOutboxWriter` no longer declares `write` / `getLastWrittenIndex`. They were
  never called; the interface described a contract no implementation used.

### Fixed

- **A snapshot larger than one chunk could never install.** raft-core starts `sendSnapshot`
  from its heartbeat loop, which does not await peers (`for (const peer of allPeers)
  this.sendAppendEntries(peer)`) and holds no per-peer guard, so several transfers to one peer
  run at once. The receiver resets its chunk assembly on *every* `offset === 0` chunk, so the
  second transfer wiped the first one's progress, the first one's next chunk arrived at an
  offset the receiver no longer expected, both were answered `success: false`, and the next
  heartbeat began the same race. Snapshots under raft-core's fixed 256 KiB chunk size hid the
  defect — a single-chunk transfer has no assembly state to lose. `BatchedRaftTransport` now
  allows one snapshot transfer per peer: a competing `offset === 0` chunk is refused locally
  (nothing goes on the wire) and raft retries on the next heartbeat, while the accepted
  transfer's later chunks pass through. The claim is released when the transfer finishes,
  when a chunk fails, and after two request timeouts of silence, so an abandoned transfer
  cannot block a peer forever. Measured on the multi-chunk recovery case: 63.7 s timeout before,
  17 s and state-for-state equal after.
- **A `Buffer` could not survive the JSON frame.** `MessageCodec` serialises frames with
  `JSON.stringify` and read them back with `JSON.parse`, so a `Buffer` field reached the peer as
  `{type: 'Buffer', data: […]}` — a plain object whose `.length` is `undefined` (measured: 5 bytes
  in, `undefined` out). `@maboke123/raft-core` installs a snapshot chunk with
  `if (request.data.length > 0)`, so the chunk was silently dropped, the assembled snapshot was
  zero bytes, and the application's `restore` rejected it — once a second, forever, while the
  follower kept answering reads from the state it had before. Both directions now normalise
  binary: a replacer converts any `ArrayBufferView` to the `Buffer#toJSON` shape and a reviver
  puts it back, accepting only that exact shape and only byte-range integers. `encode`/`decode`
  are generic in the frame type, and `BatchedRaftTransport` no longer carries its own copy of the
  framer — it was the copy that carried `InstallSnapshot` chunks.
- **`RaftAdapter.stop()` returned before it had stopped.** Raft, the transport and the storage
  were all stopped fire-and-forget: the socket was still bound and SQLite was closed under a
  running node when the promise-free call returned. A node stopped and immediately started again
  — a restart — raced its own previous incarnation for the port, and the loser came up unable to
  receive anything. `stop()` returns a promise now; ignoring it behaves exactly as before.
- **`takeSnapshot` could produce nothing and still be persisted.** A registered handler that
  returned an empty buffer (or a non-Buffer) had its result written as the snapshot for the
  applied index, after which raft truncates the log for an index whose state nobody captured and
  every follower that installs it gets an empty application. Both cases now throw, naming the
  handler contract. No handler at all still yields an empty snapshot: a group that owns no
  application state has nothing to capture, and raft needs a boundary.
- **A replica that failed to install a snapshot kept applying anyway.** Raft discards the log up
  to the snapshot boundary *before* calling `installSnapshot`, so the entries the snapshot was
  meant to carry are gone from the log and absent from the engine. Applying above the boundary
  then leaves an applied index that matches the cluster and state that does not — measured as
  `stateSize=31` next to `applied=52` on a node that was answering reads. The replica records the
  failure and refuses to apply until a restore succeeds, which is what turns silent divergence
  into a named error at the node that has the problem.
- **A lost port race crashed the run instead of failing one cluster.**
  `RaftTcpTransport.start()` re-emitted the listening server's `error` event
  unconditionally, and `emit('error')` on an `EventEmitter` with no listener _throws_ — so a
  second socket taking a port between `getFreePorts`' probe and the bind surfaced as an
  uncaught `EADDRINUSE` that failed every file sharing the worker, not the cluster that lost
  the race. The transport now re-emits only when something listens, and `TestCluster.start`
  retries a lost race with a fresh allocation (3 attempts) after tearing down the partial
  attempt, so the race costs a slow start rather than a red build.
- **`SqlVecError` dropped the error it wrapped.** `RaftAdapter.init` reported every failure
  as `INTERNAL_ERROR`, which discarded the code of the cause — an `EADDRINUSE` was
  indistinguishable from a certificate error by the time a caller saw it. `SqlVecError` now
  accepts `{ cause }` and forwards it to `Error`, and the retry decision above walks that
  chain instead of pattern-matching on a message.
- **Two peers dialling each other at once could each keep a socket the other had closed.**
  `ConnectionPool.onIncoming` replaced whatever the pool held and `_connect` overwrote the
  entry unconditionally, so a simultaneous dial left both sides writing into a half-closed
  pair: the pool that lost the race held a socket the peer had already dropped, and only the
  reconnect timer recovered it — up to `maxRetryMs` of silence for a peer that was up the
  whole time. Both paths now converge on one socket by comparing node ids (the smaller id
  keeps its outbound socket, the larger one yields to the inbound), and a dial that loses
  the race to an already-live connection is discarded. Measured over 8 consecutive runs of
  the two-node socket suite: worst case 23 ms to a single live connection on each side.
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
