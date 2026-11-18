# Changelog

All notable changes to @agentix-e/db-cluster will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Membership changes over a live cluster** — `RaftAdapter.addServer(nodeId, address, asLearner)`,
  `promoteServer(nodeId)`, `removeServer(nodeId)`, `getMembership()` and `refreshMembership()`.
  Each change answers `{ changed, reason }` where `reason` is one of `not-leader`, `no-quorum`,
  `unreachable`, `rejected`, `unsupported`: a bare `false` cannot tell a caller whether to retry,
  re-route or start a node. `addServer` registers the peer, waits up to 3 s for a socket, and only
  then appends the configuration entry, so a member that cannot be reached is not added at all.
- **`QuorumWatchdog.setMembers(peers)`** — quorum accounting follows the committed configuration.
  Counting fewer voters than the configuration holds makes a majority smaller than reality, and a
  leader that has lost contact would claim a quorum raft cannot commit with.
- **`BatchedRaftTransport.addPeer / removePeer / awaitPeer`** — raft-core asks the transport to
  register a new peer; until now it was answered by an empty method, so the configuration changed and
  the peer was never sent an entry.
- **`ConnectionPool.removeNode(peerId)`** and **`RaftTcpTransport.unregister(peerId)`** — a removed
  member is forgotten completely: retry loop, socket, queue, circuit breaker. A dial that lands after
  the removal is discarded rather than resurrecting the peer.
- **`RaftTcpTransport.awaitPeerConnection(peerId, timeoutMs)`** — whether a socket exists within a
  budget, so "added" can be decided on evidence rather than on a registration that only records intent.
- **`RAFT_TEST_LOG=1`** in the multi-process harness forwards the workers' stdout. pino writes there
  and the harness never read it, which is why every failure in that suite was diagnosed by patching the
  line in temporarily.
- **`SqliteStorage.durability.test.ts`** — `AC 38.1`–`AC 38.13`, 43 cases covering what the AC 32
  suite cannot see because it asserts return values: which file descriptor a sync opens, when a batch
  defers one, whether the native handle is released, whether a database written before the checksum
  column existed still opens, whether `VACUUM` gives the space back, and what a damaged database
  reports. Measurement goes through a wrapped `fs`, so every counted call still reaches the kernel.
  The module moved from 74.02 % to **94.26 %** (476 killed, 29 equivalent, 1 runner error of 510).
- **`RaftTcpTransport.canReach(peerId)`** — whether a frame written right now would reach a
  live, certificate-verified socket rather than the in-memory buffer `send()` falls back to.
  `send()` is non-blocking by design here (blocking the Raft tick on I/O costs an election),
  which left callers unable to tell "sent" from "queued" — and one of them,
  `@agentix-e/db-federation`'s outbox, was deleting entries on the wrong answer.
- **`RaftTcpTransport.offMessage(handler)`** — the counterpart of `onMessage`. Without it a
  stopped transport stayed registered on the inner emitter and held its owner alive after
  shutdown.
- **A `mutation` job in `ci.yml`** and `test:mutation` — Stryker scores `SqliteStorage.ts`
  against its own tests: 510 mutants, **74.41 %** killed, `break: 72`. The score is a
  measurement of the tests; it found 130 changes they do not notice, including an early
  return that can be deleted without a single failure.
- **`openSqliteHandleCount()`** — live better-sqlite3 handles owned by the package.
  A leaked handle is invisible to assertions: the suite stays green and the process
  aborts at teardown with `terminate called after throwing an instance of 'Napi::Error'`
  and exit 134, no stack and no test name. Counting it turns "this middleware does not
  leak storage" into something a test can assert, which is the only form in which it
  stays true.
- **`SqliteStorage.isOpen`** — whether a live handle is held. Cheap and synchronous, so
  health checks and shutdown paths can ask instead of calling a method that throws.
- **`src/testing/latency.ts`** — the measuring instrument the perf suite was missing:
  `summarise` (nearest-rank percentiles, no interpolation), `measureLatency` (explicit
  warmup that is discarded, not counted), `ms`, `describeLatency`. Percentiles are only
  comparable if every suite computes them the same way, and before this each benchmark
  had its own idea.
- **`vitest.performance.config.ts` / `vitest.soak.config.ts`** — the two suites have
  their own config. The base config excludes `src/__tests__/performance/**` and
  `src/__tests__/longrun/**`, and a positional filter does not override `exclude`, so
  `test:perf` and `test:soak` printed `No test files found` and ran nothing. A
  `mergeConfig` override does not work either: merging *concatenates* the arrays.
- **`bench/snapshot-threshold-sweep.ts`** — snapshot threshold against retained log,
  proposal latency and restart time, measured on a real cluster.
- **`bench/proposal-concurrency-curve.ts`** — throughput against in-flight proposals,
  1 to 50.
- **A `benchmark` job in `ci.yml`** — `test:perf` now runs on every pull request and
  reports into `ci-summary`. It was a script nobody called, which is how it stayed
  broken.

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
- **`src/__tests__/support/retainedHeap.ts`** — `retainedHeapMB()`, heap after a
  forced collection, and `retainedGrowthBudgetMB(proposals)`, a growth budget scaled to the
  work a case asks for. A `heapUsed` delta is a statement about GC timing, not about what a
  workload keeps: `--expose-gc` cannot be passed to a worker thread
  (`ERR_WORKER_INVALID_EXEC_ARGV`) and the boundary suites run in vitest's `threads` pool, so
  the flag is set on the isolate at runtime and the collector taken from a fresh context. The
  same 96 MB of dropped allocation that a `heapUsed` delta reports as **117.7 MB** is **under
  8 MB** through this function, which is the difference between "the cluster is filling the
  heap" and "the collector had not run yet".

### Fixed

- **A CONFIG log entry lost its configuration on the way to disk.** `SqliteLogStorage.append` persisted
  `entry.command` and nothing else, so a configuration entry was read back with `config: undefined` —
  and the leader replicates by re-reading its own log. `validateLogEntry` rejected the AppendEntries on
  the follower, the follower answered nothing, the leader timed out, and **no configuration change
  could replicate on any cluster**. The payload column now carries `{ config }` for a CONFIG entry, a
  CONFIG entry without one is refused at write time, and a legacy row that has neither fails loudly
  instead of being read as an empty voter set (which would have been *applied*, rewriting a node's
  membership to nobody).
- **A malformed member row could contribute a phantom voter 0.** `Number(null)` and `Number('')` are
  both `0`; member ids are now required to be positive integers.

### Changed

- **`_initialized` is gone; `stats()` has one guard instead of two.** The flag distinguished "handle
  open" from "open finished", a state only a throwing `onOpen` could produce — and that now rolls back,
  so the second guard was unreachable by construction. Its only test manufactured the state by writing
  to the private field, which no caller can do. `close()` and the open rollback share `resetStatements()`,
  because a prepared statement belongs to the handle that prepared it and outliving it means the next
  `open()` uses a statement against a database that no longer exists.
- **`initialState()` returns the object it built.** `Object.keys(result).length > 0 ? result : {}`
  answered `{}` from both arms: every branch writes only when it has something to write.
- **The boundary suites assert retention, not allocation, and each case carries a budget
  derived from its own volume.** The heap bounds were 100, 200, 300 and 200 MB against cases of
  10 000, 5 000, 2 000 and 1 000 proposals — the tightest attached to the heaviest, and it
  failed on a runner at 111.6 MB (CI run 43909923898) with nothing wrong in the product.
  Measured retention is 5.7 MB over 10 000 proposals, 2.9 over 5 000, 0.9 over 800 and 1.2 over
  1 000 (~0.6 KB per proposal), so the bound is now `8 MB + 2 KB per proposal` for every case:
  the same property at every volume, about four times the observed cost, and a case that leaks
  fails instead of a case that ran on a slower machine.
- **The performance suite uses the same instrument, and stops skipping.** `P.3` asserted a
  15 MB allocation delta for 1 000 proposals while its own title said 10 MB; measured retention is
  1.2 MB, so what it was really testing was that the collector ran often enough. `AC 41.6` called
  `globalThis.gc()` directly and skipped itself when the flag was missing — a bare `vitest` run
  reported it as passed without measuring anything. Both go through
  `retainedHeapMB()`/`collectNow()` now, and `AC 41.6`'s per-proposal bound is 8 KB rather than
  32 KB against a measured median of 1.1 KB.
- **`DEFAULT_SNAPSHOT_INTERVAL` is 200, and it is the threshold that reaches
  raft-core.** The adapter forwarded `this.config.snapshotInterval` and dropped the
  default on the floor, so an unset interval meant "raft-core's own number" — 200 —
  while three places in this repository documented 1000 or 300. A caller who relied on
  the documented value got a snapshot every 200 entries instead of every 1000, and the
  cost showed up as restart time, not as an error. Measured on a real three-node
  cluster: threshold 200 retains 51 entries and snapshots at 600 with a 144 ms restart;
  threshold 1000 retains 651 entries, never snapshots in the same window, and restarts
  in 186 ms.
- **`getRetainedLogLength()` counts the log's own boundaries.** It returned
  `lastLogIndex - appliedIndex`, and the apply loop leaves `applied` one behind, so a
  freshly snapshotted node reporting 21 retained entries answered 20 — and a node whose
  log had been truncated to a single entry could answer 1 or 0 depending on where the
  loop happened to be. It now reads `getFirstIndex`/`getLastIndex` from the log manager,
  which is what "retained" means.
- **The performance suite measures a real cluster.** Three of its files were rewritten:
  the election benchmark timed five simulated elections and called the number an
  election, the operations benchmark took a single cold sample and reported it as P50,
  and the throughput benchmark proposed through a stub instead of `RaftAdapter`. Every
  number in this file now comes from three nodes over mTLS with an explicit warmup
  window that is discarded.
- **`RaftAdapter.stop()` does not close storage it did not open.** A storage passed in
  through `config.storage` belongs to the caller and may be shared with another group;
  closing it there pulled the database out from under its owner. Storage opened from
  `storagePath` is still closed — nothing else holds a reference to it.
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

- **A throwing `onOpen` left the storage half open.** The callback runs after the handle is created,
  so a configuration hook that threw produced a live better-sqlite3 handle reachable from nowhere,
  `isOpen` answering `true`, and a file locked for the life of the process — while every later call
  reported the documented "Database not open" and blamed the caller. `open()` now rolls the handle
  back, drops the statements prepared against it and rethrows the original error, so a failed open is
  the whole effect of the call (`AC 38.1`). Measured: handle count and file lock both clear, and a
  clean `open()` on the same path afterwards works.
- **A mutant that deadlocks the log was scored as if no test had noticed it.** The runner records a
  mutant whose test never finishes as `Timeout`, a status the mutation score does not count — so the
  19 deadlocking mutants of `SqliteStorage.ts` were invisible in the number, and `Survived` and
  `Timeout` were being read as "equivalent" and "unanswered" in the same table. The judging suite now
  carries `testTimeout: 8000`: the whole file runs in ~5 s and its slowest case is under 100 ms, so
  8 s is the boundary between "slow" and "stuck", and a stuck storage is a defect. All 19 now count as
  killed (P3-11).
- **The mutation suite was flaky, and a flaky suite moves a mutation score in both directions.**
  `vitest.mutation.config.ts` ran its four files in parallel; three clean runs — *no mutant applied* —
  failed a test in two of them with `SqliteError: disk I/O error` from `pragma journal_mode = WAL`, a
  different test each time. Replaying the 133 reported survivors showed what that does to the number:
  **68 of them failed** when applied, because a flaky test was failing and the runner charged it to the
  mutant. With `fileParallelism: false` and nothing else changed, four of four clean runs pass, the whole
  mutation run is **faster** (3 m 40 s against roughly ten), and the score rose from 73.62 % to
  **74.02 %** (357 killed, 132 survived, 19 timeouts). The suites are isolated per file, so what they
  share is the machine — and Stryker already runs four workers, each with its own sandbox.
- **A node had fifteen seconds to say it was ready — on any machine.** CI run 44045755888
  failed `AC 8.13 — connection drop and reconnect` with `Timeout waiting for "ready" from
  node 1 (15000ms)`, and the restarted process had printed nothing but its first `DEP0123`
  line: it was starting, slowly, on a two-core runner shared with four other files. A cold
  start is `node --import tsx` plus a better-sqlite3 store plus a TLS identity, so the
  budget is now *derived* — four times the slowest start the same file has measured, floored
  at the old number — because the right value is a property of the machine and the test is
  the only thing in a position to ask. `raft-core.test.ts` carried the same constant at ten
  seconds and got the same treatment.
- **`waitForMessage` left a listener behind on every wait that succeeded.** The listener was
  removed on the timeout only, so a file accumulated one per wait and reported
  `MaxListenersExceededWarning: 11 message listeners added to [ChildProcess]` — a leaked
  reference per wait, plus handlers running for messages nobody was waiting for. It is
  removed on both exits now, and a timeout reports what the node *did* say and whether it is
  still alive, because "timeout waiting for ready" cannot be acted on.
- **`SqliteStorage.open()` was not idempotent, and the handle it dropped aborted the
  process.** A second `open()` built a second better-sqlite3 database and assigned it
  over the first, so the original was reachable from nowhere and could never be closed.
  The node then ran on one handle while the log file it believed it owned was still held
  by the orphan. Nothing observable failed until teardown, where the leaked wrapper was
  finalised on an environment that no longer existed and better-sqlite3 called
  `terminate` — `Napi::Error`, exit 134, no stack, no test name, and only when the
  performance suite ran its files together. `open()` now returns early when a handle is
  live, and `open()` after `close()` reopens the same file.
- **`close()` left the storage half-initialised.** `_initialized` stayed true while the
  handle was gone, so a closed storage answered inconsistently and the next call
  dereferenced `null` instead of raising the documented "Database not open".
- **`RaftAdapter.init()` could be entered twice and orphan a storage.** A second init
  built a fresh `SqliteStorage`, assigned it over `sqliteStorage`, and left the previous
  handle open — while a node that had already started kept serving on storage the
  adapter no longer tracked. It now refuses, before installing the apply handler, so a
  refused call changes nothing; `stop()` then `init()` is the supported restart.
- **A failed `init()` leaked everything it had opened.** The catch block wrapped the
  error and rethrew, leaving the SQLite handle, the TLS listener and the timers running
  with no reference held by any caller — and nothing in the public API suggested a
  cleanup was owed, so correct usage leaked. The failure path now releases in reverse
  order of construction, which also makes a failed init retryable instead of terminal.
- **`test:perf` and `test:soak` never ran a single test.** Both passed a directory as a
  positional filter while the base config excluded it; vitest printed
  `No test files found, exiting with code 1`. Both now use a dedicated config whose
  `exclude` is empty, one file at a time on a forks pool — a benchmark that shares cores
  with another benchmark is not measuring the middleware, and the native storage handles
  are not finalised on a worker isolate that is already shutting down.
- **The nightly benchmark workflow failed before reaching its first benchmark.**
  `TMPDIR` was set at workflow level, so `pnpm/action-setup` — which runs before any step
  could create the directory — aborted with
  `ENOENT: lstat '/home/runner/work/db-stack/db-stack/.tmp'`. Moved into the steps that
  need it, each of which creates the directory first.
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
