# Maturity and test coverage

This page is the honest answer to two questions a team asks before adopting middleware:
**what does it actually do**, and **how is each part verified**. It is generated from the
same evidence the CI gate enforces, and it lists what is _not_ covered as explicitly as what
is. A capability with a gap is more useful to you than a claim without one.

Legend for the coverage column — test types actually executed against the feature:

| Code  | Meaning                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------- |
| **U** | Unit: the component in isolation, branches and error paths included                                            |
| **I** | Integration: real components wired together, in-process                                                        |
| **C** | Conformance: the published contract suite (`runEngineConformance`)                                             |
| **B** | Boundary: concurrency, storms, 5 000-entry floods, resource limits                                             |
| **L** | Linearizability: history checked with a Wing-Gong style register model                                         |
| **E** | End-to-end: **separate OS processes over TLS 1.3 with mutual authentication**                                  |
| **P** | Performance: a benchmark that runs on a GitHub runner and fails on regression                                  |
| **R** | Recovery: crash, restart, snapshot install, log truncation                                                     |
| **M** | Mutation: the source is altered on purpose and the suite must notice                                           |
| **A** | Artefact: the **built** package is loaded and _called_ in a plain Node process — no bundler, no test transform |

**What "resource limits" means in a B row.** Heap assertions here sample _after a forced collection_,
so the number is what the workload still holds rather than what the collector had not got to yet.
Each case is bounded by `8 MB + 2 KB per proposal` — about four times the measured cost — and every
case reports its own number: 5.7 MB over 10 000 proposals, 2.9 over 5 000, 1.2 over 1 000, 9.8 over
30 000, and 0.0 for 1 000 peer registrations that must overwrite rather than accumulate. Until
iteration 33 these were allocation deltas against four constants that were also in the wrong order
(the tightest bound on the heaviest case), and one of them failed CI at 111.6 MB with nothing wrong in
the product. The rule we now hold to: a bound that no regression can fail is not evidence, so the
number and the instrument that produced it are stated together.

---

## 1. Cluster (`@agentix-e/db-cluster`)

### 1.1 Consensus core

| Capability                                    | Verification          | Notes                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Leader election, pre-vote, check-quorum       | U · I · E · P         | Real elections in 3- and 5-node TLS clusters; median and p95 over five trials on a real cluster (`AC 29.1`)                                                                                                                                                  |
| Log replication, commit index, apply ordering | U · I · L · E · P · M | Every entry applied in index order on every node; latency and throughput measured through `RaftAdapter` (`AC 29.6`, `AC 41.1`)                                                                                                                               |
| Entry position forwarded to the application   | U · I · C · E         | `index`/`term` reach the engine; asserted end-to-end                                                                                                                                                                                                         |
| Joint consensus membership change             | U · I · E             | C_old,new → C_new, rollback on failure                                                                                                                                                                                                                       |
| Learner (non-voting) catch-up                 | U · I · E             | Promoted only after catching up; a fourth process joins a live 3-node TLS cluster and holds the log before it is promoted (`AC 8.21`)                                                                                                                        |
| Learner log pull (`requestForLearner`)        | U · I                 | Serves the leader's **real** retained log, not an empty buffer: window, contiguous ascending entries and recovered `msgId`s asserted against a 3-node mTLS cluster (`AC 58.14`–`AC 58.19`); a cursor below the window is clamped, one past the head is empty |
| Leader transfer                               | U · I · E             | Target confirmed as leader before success is reported                                                                                                                                                                                                        |
| ReadIndex and lease reads                     | U · I · P             | Leader-lease expiry and stepping down; p50 0.001 ms over 1 000 reads (`AC 41.3`, `AC 41.4`)                                                                                                                                                                  |
| Snapshots: take, frame, install, compact      | U · I · R · E         | 30-byte envelope, CRC32, position, cross-shard rejection                                                                                                                                                                                                     |
| Restart from a snapshot, single node          | R · E                 | The engine, not the log, is the recovery source                                                                                                                                                                                                              |
| Restart from a snapshot, **whole cluster**    | R · E                 | Three processes, snapshots every 15 entries, all killed and restarted: every key returns and the cluster accepts writes again                                                                                                                                |
| Log compaction and retention limits           | U · I · B · P · M     | Enforced bounds, no unbounded growth; retained log 21 → 21 across 300 proposals and 1.0–1.4 KB retained per proposal (`AC 41.5`, `AC 41.6`)                                                                                                                  |
| Point-in-time recovery                        | U · I                 | Records are positioned by Raft index                                                                                                                                                                                                                         |
| Session and watch APIs                        | U · I · E             | Reads-your-writes, change notification                                                                                                                                                                                                                       |
| Event bus                                     | U · I · B             | Ordered delivery, backpressure                                                                                                                                                                                                                               |
| Write forwarding to the shard leader          | U · A                 | `pg` is optional; a missing driver is a named error, not a module-resolution trace (`AC 55.1`–`AC 55.7`)                                                                                                                                                     |
| Trace correlation across async boundaries     | U · A                 | `traceContext.runWith` survives `await` and timers (`OBS4.1`–`OBS4.5`); the id is verified in the **built** package                                                                                                                                          |
| Merkle anti-entropy digest                    | U · A                 | Root asserted against an independent SHA-256 of the ordered leaves (`AC 54.1`–`AC 54.8`)                                                                                                                                                                     |
| Apply lag in health status                    | U                     | `applyLag` replaces `pipelineDepth`, which read `0` on every shard at every moment because nothing wrote the buffer it counted                                                                                                                               |

### 1.2 Transport and security

| Capability                                        | Verification | Notes                                                                                                                                       |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS 1.3 with mutual authentication                | I · E        | Real sockets, real certificates                                                                                                             |
| Rogue-certificate rejection                       | I · E        | Handshake refused before any Raft traffic                                                                                                   |
| Message framing, CRC, compression                 | U · B        | Corrupt frame is dropped, not misparsed                                                                                                     |
| Connection pool, reconnect storm, circuit breaker | U · B        | 50-proposer storms, pool exhaustion                                                                                                         |
| Frame buffering, its cap, and its retry           | U · B        | Frames survive a failed flush and are re-sent; a batch no fresh socket will take is dropped in the open (`droppedFrames`, `frames-dropped`) |
| Shared transport for many shards per node         | U · I        | Per-shard tagging and routing                                                                                                               |

### 1.3 Sharding and high availability

| Capability                              | Verification | Notes                                               |
| --------------------------------------- | ------------ | --------------------------------------------------- |
| Hash, range, consistent-hash placement  | U · I        | Deterministic and stable across rebalances          |
| Online shard migration                  | U · I · E    | Dual-write, cut-over, rollback                      |
| Failover detection and coordination     | U · I · E    | Timeout-based, quorum-checked                       |
| Fencing (stale leader cannot write)     | U · I        | Epoch and lease fencing                             |
| Consistency verification after failover | U · I        | Divergence detection reports, never repairs blindly |

### 1.4 Published test harness

| Capability                                  | Verification | Notes                                                                                                                                 |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Real multi-node cluster, partition and kill | I · E        | `TestCluster` starts real nodes on real ports over mutual TLS; `PartitionTransport` models a silent partition rather than a dead node |
| Agreement waiting                           | U · I        | `awaitAgreement`, `pollUntil`, `ConvergenceTimeoutError` with the last observation and the round count                                |
| Linearizability checking                    | U · I · B    | Bounded search returning `'unknown'` when the bound is hit; `fuzzyCheck` for the long runs where the full checker cannot finish       |
| Engine conformance suite                    | C            | `runEngineConformance` registers into any framework and injects its own failure, so the engine under test needs no test hooks         |

The subpath is published, so it is documented like one: `docs/testing.md`, and the docs gate
now reads every entry point in each package's `exports` map rather than only `src/index.ts`
(see §4).

### 1.5 Storage engine SPI

| Capability                                      | Verification  | Notes                                                                                                   |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `IStorageEngine` contract                       | C             | 23 checks, run against two structurally different engines                                               |
| Idempotent replay across restarts               | C · R · E     | Duplicate indexes never reach the engine                                                                |
| Forward jumps, no replays                       | C · R · E     | Raft skips non-command entries; a jump is applied, a duplicate index is dropped                         |
| Apply failure propagates to Raft                | C · U         | Fail-stop rather than silent divergence                                                                 |
| Serializable applies                            | C · B         | Concurrent submission stays ordered                                                                     |
| Snapshot framing, CRC, shard binding            | C · U · R · E | Truncated / corrupt / foreign snapshots rejected; the frame carries Raft's boundary index               |
| Reference engine (`MemoryStorageEngine`)        | C · U · E     | Shipped as the adapter template                                                                         |
| A storage failure names its file and free space | U             | `disk I/O error` became a message with the path, the directory and its free space (`AC 57.1`–`AC 57.7`) |

---

## 2. Federation (`@agentix-e/db-federation`)

| Capability                                 | Verification | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDC capture (engine-agnostic)              | U · I        | `ICDCEngine` with a monotonic LSN — a counter, not a clock reading, so two changes in the same millisecond still have an order. The engine shipped here **simulates** WAL (`appendChange`); a deployment supplies an engine that decodes a real log                                                        |
| Publication/subscription catalogue         | U            | Keeps the two maps and watches their tables, and records each subscription's `targetDsn` verbatim. It delivers nothing; a slot-invalid event is **not** observed here, because nothing in this package reads PostgreSQL slots                                                                              |
| Subscription delivery to a sink            | U · I        | `CDCSubscriptionPump` resolves the DSN through a caller-supplied factory and delivers per subscription: one FIFO queue, one `emit()` per change, retry then a bounded failure log, a queue cap that reports the change it could not hold. `CDCSinkResolver` wraps any sink with retry, batching and health |
| Fault injection for sink delivery          | U            | `CDCFailureInjector`, published from `./testing`: five fault types, per-entry budgets, refusals that report instead of passing. It is both the tool a consumer checks their sink with and the instrument the pump's retry cases use                                                                        |
| Outbox-before-send delivery                | U · I · E    | Durable enqueue, then send                                                                                                                                                                                                                                                                                 |
| Exactly-once application                   | U · I · E    | Dedup ring keyed by `(origin, lsn)`                                                                                                                                                                                                                                                                        |
| Hybrid logical clocks                      | U · I        | Monotonic across skew                                                                                                                                                                                                                                                                                      |
| Conflict resolution: LWW, CRDT, custom     | U · I        | Deterministic, tested against divergent histories                                                                                                                                                                                                                                                          |
| Multi-leader replication                   | U · I        | Loop suppression, causal ordering                                                                                                                                                                                                                                                                          |
| Merkle anti-entropy repair                 | U · I · B    | Divergence detected and repaired                                                                                                                                                                                                                                                                           |
| Topology epochs and split-brain detection  | U · I        | Fencing old epochs                                                                                                                                                                                                                                                                                         |
| Cross-cluster transport over TLS           | I · E        | Two real clusters, real certificates                                                                                                                                                                                                                                                                       |
| Channel health, backpressure, pause/resume | U · I · B    | Stalled peer does not stall the cluster                                                                                                                                                                                                                                                                    |
| Query routing to a serving cluster         | U · I        | Locality-aware, failure-aware                                                                                                                                                                                                                                                                              |

---

## 3. Operations (`@agentix-e/db-operations-*`)

Three packages, and one question decides which of them a line of code belongs to:
**does this code need to know how many nodes exist?** A module that does not is a module in
`node`. It may read a `minNodes` field or return a plan naming five nodes, because data _about_ a
group is not authority _over_ one. A module whose subject is how many nodes exist — which of them
is the leader, how many may be down before a write stops, which order they may restart in — is in
`cluster`. A module whose "nodes" are datacenters is in `federation`.

| Package      | Capability                                                                                                                                 | Verification |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `node`       | Twenty topology-independent modules behind one manifest and twenty-two entry points, each bound to an engine only through a provider token | U · I        |
| `cluster`    | Membership arithmetic, scale-down, rollout order, chaos translation — the four places where a group loses quorum                           | U · I · M    |
| `federation` | Federated node identity, cross-cluster query routing, repair execution                                                                     | U · I        |

Twenty of the twenty-one former packages are directories now, under
`packages/node/src/<module>/`, and they are still twenty entry points —
`@agentix-e/db-operations-node/audit`, `…/core`, `…/slacollector` — because a module is a
directory, not a package. Twenty npm names for code that cannot be misused without a topology
would have been twenty version numbers and twenty release notes describing one decision.
`packages/node/src/index.ts` is the whole list: twenty namespace re-exports under a header that
states the property deciding placement, so a module that starts asking about the other nodes is a
module that has to move, rather than one that quietly grows a dependency on a group.

`core` is why the old shape could not hold. Forty-six of the former packages imported it, so a
change to a base type was a change to a published dependency graph. The imports are relative now;
the nine edges between former packages that disappeared took their version constraints with them.
`node` publishes 331 exports across its twenty-two entry points, and every one is named somewhere
under `packages/node/docs/`.

| Module           | Capability                                                           | Verification  |
| ---------------- | -------------------------------------------------------------------- | ------------- |
| `core`           | Base types, provider registry, error hierarchy                       | U · I         |
| `health`         | Liveness/readiness orchestration, dependency graph                   | U · I         |
| `logger`         | Structured logging, levels, child loggers, backends                  | U · I         |
| `metrics`        | Counters, gauges, histograms, sink fan-out                           | U · I         |
| `monitor`        | Alert rules, thresholds, de-duplication                              | U · I         |
| `backup`         | Full/incremental backup, verification, restore drills                | U · I · M     |
| `maintenance`    | Maintenance windows, occurrence projection                           | U · I · M     |
| `auth`           | Authentication providers and credentials (interfaces only)           | U · I         |
| `security`       | Key rotation, envelope encryption, tamper-evident audit chain        | U · I · M     |
| `audit`          | Append-only audit storage, query, verification, read and write ports | U · I · M · P |
| `observability`  | W3C trace context, OpenTelemetry export                              | U · I         |
| `otel`           | OpenTelemetry bridge for metrics and traces                          | U · I         |
| `autotuner`      | Parameter tuning from workload analysis                              | U · I         |
| `autoscaler`     | Scaling recommendations from multi-dimensional metrics               | U · I         |
| `chaosengine`    | Fault definitions and the experiment runner                          | U · I         |
| `circuitbreaker` | Per-dependency breakers                                              | U · I · B     |
| `configwatcher`  | Config watching, hot reload, validation                              | U · I         |
| `memoryguard`    | Heap pressure, eviction, OOM avoidance                               | U · I         |
| `rollingupgrade` | Upgrade plans, batching and health gating                            | U · I         |
| `slacollector`   | SLA recording, compliance, violation log, uptime                     | U · I         |

`autoscaler` and `rollingupgrade` are the cases that show where the line was drawn: both returned
a `string[]` of node ids and did no IO at all, so both stayed in `node`. Turning
`ScaleAction.targetCount` into members added and removed is `ClusterScalingExecutor`; turning
`RollingUpgradePlan.nodes` into an order that keeps quorum is `ClusterRolloutPlanner`. A module
that can only describe a group cannot take a group's quorum away.

The five cluster modules are 75 cases named `AC-CL*`, and the arithmetic is where most of them
sit: `quorumOf(n) = floor(n/2) + 1` (not `ceil`, which is wrong at even `n`), learners are members
but not voters, and `holdsQuorumOf` measures against the _previous_ configuration, because that is
the configuration whose votes the change needs. Scale-down computes its delta from **observed**
members rather than from the plan — a plan is an opinion and the member set is the fact — clamps
at `max(minNodes, quorumOf(voters))`, never removes the leader, drains learners first and newest
ids before oldest. A partition emits both directions, because `isolate` on `n1` does not stop
`n2` sending to `n1`; `direction: 'one-way'` is the opt-out a test has to spell. A fault the
transport cannot express is a refusal rather than an empty instruction list, since an empty list
reads as "injected, no effect".

Every one of the twenty modules ships a `docs/` tree — at `packages/node/docs/<module>/` since the
split — and since iteration 54 that is enforced rather than observed: ten of them shipped none and
were skipped by the documentation gate, because the loop read a package's documents to decide
whether it had any. `pnpm check:docs-api` now reads 34 entry points across 7 packages, requires
every published value to be named somewhere under its package's `docs/`, resolves every import in
every fenced example against the export surface of the package it names, and holds each package
index to the directory it indexes.

The imports were the easy half. `pnpm check:doc-examples` compiles the examples themselves —
316 fenced TypeScript blocks across 64 pages — against the packages' sources rather than their
built `dist/`, and judges only the diagnostics that are _claims_: a property that does not exist,
an argument that cannot be passed, a call with the wrong arity, an object literal with a key the
target does not declare or without one it requires. Fragments are allowed to be fragments —
undeclared names, implicit `any`, class sketches without bodies — because none of those is a
statement about the API. It found **72** findings on the first run and **14** once the gate
stopped lying about its own assembling (see §4.1); every one of the 14 was a snippet a reader
would have pasted and watched fail. See §4.1 for what that found.

---

## 4. Measured coverage

Vitest v8 coverage, every dimension gated at ≥95 % in CI. Numbers below are from the last
green run of this repository; the gate fails the build if any dimension drops below 95 %.
All four rows are from a green run of this repository; `operations` was re-measured after the
split into three packages (99.51/99.51/99.88/98.59), `cluster` with the same run that added the
four assembler modules to its mutation target list (99.42/99.42/99.70/98.18) and `federation` with
its own (99.61/99.61/100/98.79). The gate covers four packages, not three:
the end-to-end harness is measured as well, because a harness bug produces confident, meaningless
acceptance passes.

| Package         | Lines  | Statements | Functions | Branches |
| --------------- | ------ | ---------- | --------- | -------- |
| `cluster`       | 99.42% | 99.42%     | 99.70%    | 98.18%   |
| `federation`    | 99.61% | 99.61%     | 100%      | 98.79%   |
| `operations`    | 99.51% | 99.51%     | 99.88%    | 98.59%   |
| `e2e` (harness) | 100 %  | 100 %      | 100 %     | 100 %    |

The `e2e` row covers the TypeScript harness — `support.ts` (process supervision, IPC, port
allocation, log capture) and `published-artefact.ts` (the runner for the published-behaviour
probes). The eight `.mjs` programs it spawns (`raft-node.mjs`, `federation-gateway.mjs`,
`published-probes.mjs`, `change-writer.mjs`, `cdc-relay.mjs`, `cdc-sink-server.mjs`,
`audit-writer.mjs`, `audit-reader.mjs`) run in
child processes and are therefore _not_ instrumented by the
in-process v8 collector; they are exercised for real by every acceptance test, and they are
verified by what those processes report — a probe that stops asserting fails the suite that
runs it, which is a stronger claim than a counter.

Coverage is a _floor_, not an achievement: a line can be executed by a test that asserts
nothing. The suites above are written to fail when behaviour changes, and bug-hunting is an
explicit goal of each iteration (see the audit reports in the companion repository).

### 4.1 The suite is compiled too

Vitest strips types with esbuild; it does not check them. Iteration 32 re-learned why the separate
`typecheck:tests` job exists: a case written after the last local run of it compiled under vitest and
failed under `tsc` (`noUncheckedIndexedAccess` on a `Buffer` index). CI's `Typecheck (operations)` job
was the only gate that saw it, and it saw it on the first push. For a long time that meant the
test trees were the only unverified code in the repository — and they drifted. When
`pnpm typecheck:tests` was finally wired up it reported **1 192 errors in three test trees**
(cluster 297, federation 317, operations 578), and a large share of them were not cosmetic:

- tests configuring options the product never reads (`latency` where the field is
  `latencyP95`, `snapshotInterval` on a chaos config that has no such key,
  `heartbeatIntervalMs` on a transport config that has no such key) — the assertion after
  such a configuration compared `undefined` against a threshold and could not fail;
- tests asserting on properties that do not exist on the object under test;
- a reference engine adapter that did not satisfy the interfaces it claimed to implement;
- module specifiers that resolved to nothing.

**And the documentation was not in the tarball.** Every package listed `dist`, `README.md` and
`CHANGELOG.md` in `files`, and all fourteen that have a `docs/` tree left it out: the reference
pages this repository gates so carefully were readable on GitHub and absent from
`node_modules/@agentix-e/db-*`, which is the first place a consumer looks. Measured with
`npm pack`: `federation` shipped 200 files and no `docs/`. `files` now includes it, and
`pnpm check:package` runs `npm pack` over every package with a `docs/` tree and fails when the
tarball carries none of it — the assertion is the tarball rather than the manifest, because
`files` can name a directory that an `.npmignore` then empties.

Iteration 53 re-learned it a third time, in the file it was writing at that moment. A new
fixture described a sink event as `{ id, table, operation, data, timestamp: 1, lsn }`; the
contract is `{ id, type, table, key, data, timestamp: bigint }`. Vitest ran all eleven cases
green, because a sink here only counts what it is handed — and CI's `Typecheck (federation)`
failed on the first push with six errors, the first of them `number` against `bigint`. A fixture
that describes an object the contract does not have is a test that passes while measuring
something else, and only the compiler can see it.

Both directions are now gated: `pnpm typecheck` proves the published surface compiles,
`pnpm typecheck:tests` proves that what tests it compiles under the _same_ compiler options
(including `noUncheckedIndexedAccess`, which the operations test config used to switch off).
A structural check, `pnpm check:gates`, fails the build if any `tsconfig` in the workspace is
referenced by no script — the exact shape of the defect that hid those 1 192 errors: a
configuration file that looked like a gate and ran nowhere.

### 4.1.1 A test that cannot fail for the right reason

Two cases in the federation suite failed in CI while passing locally, and both were wrong in a
way that no amount of re-running fixes.

- `InProcessTransport — should delay delivery when latency is set` waited a fixed 100 ms for a
  `setTimeout(50)` and then asserted the message had arrived. A timer is a request, not a
  promise: under a loaded event loop the callback can be later than the whole margin, so the
  assertion was a bet on the scheduler. It now waits on the callback itself with a deadline, and
  asserts the property that matters — delivery is not immediate, is not earlier than the
  configured latency, and happens once.
- `BM6b: addBatch should not regress vs serial add` asserted `serialElapsed / batchElapsed >
0.2`. It was measuring two wrong things at once: a wall-clock ratio between two
  single-transaction paths (which BM6a had already replaced with an absolute budget, for exactly
  this reason), and a serial side written as `for (…) store.add(…)` with no `await`, so the
  denominator was the cost of creating five hundred promises rather than of inserting five
  hundred entries. It now awaits the serial path, compares the two queues entry for entry, and
  holds each to the same 5 ms-per-entry budget BM6a uses.

Both passed every run on an idle machine, which is what a flaky test does. That is the
definition of a test that cannot fail for the right reason, and the fix is to assert the
property rather than the timing.

The same applied to the API references. `cluster/docs/api-reference.md` opened with four classes
that were never written (`RaftCluster`, `ClusterConfig`, `FencingToken`, `ITransport`), and
`federation/docs/api-reference.md` documented five more (`FederationEngine`, `FederationConfig`,
`DataChange`, `PipelineBuilder`, `HeartbeatStatus`) plus a constructor, a dedup ring and an error
hierarchy the package does not have. Both pages had been written from a design sketch before the
code existed and were never compared to it; a reader following either one wrote code that failed
on the first line. `pnpm check:docs-api` now resolves every `##`–`####` heading that opens with a
backticked identifier against the package's real export surface, read through the TypeScript
compiler rather than by pattern matching. Both pages were rewritten against it, and the check is
what keeps them honest.

It read `src/index.ts` and stopped there, which left a second promise on every package
unchecked: a subpath. `@agentix-e/db-cluster/testing` had been publishing fifteen symbols — a
whole harness a downstream package is expected to build against — and no gate looked at any of
them; its first page was written in iteration 53, after the gate learned to read the `exports`
map. Every entry point is now resolved from `package.json` and headings may name a symbol from
any of them. Twenty findings, all real, all now closed — and the gate's own suite pins both
directions, including `run()` over the working tree, because a gate that only ever prints
"passed" is the same defect one layer out.

Iteration 54 found that the coverage rule was still stated about a _filename_. It fired on
`api-reference.md`, which two of twenty-four packages have, and a package with no `docs/` tree at
all was skipped before any rule ran — the loop read a package's documents to decide whether it
had any, so writing none was the strongest possible way to comply. Measured: **50 exported values
across nine documented packages named by no page, and ten packages publishing 17 values behind no
documentation whatsoever.** Three rules replaced the one:

1. **Every exported value of every entry point is mentioned somewhere under the package's
   `docs/`.** Root and subpaths alike; the duty is on the package, so `architecture.md` may carry
   a class the `api/` page omits.
2. **A package that publishes a value ships a `docs/` tree.** A `docs/`-less package is a finding,
   not a skip.
3. **Every named import in a fenced example resolves** against the package and entry point it
   names — in a package's own `docs/` **and** in the repository's `docs/`, which belongs to no
   package and was read by nothing. `operations/docs/getting-started.md` told readers to
   `import { HealthOrchestrator, ComponentProbe }` from a package that exports `componentProbe`;
   another snippet imported `IBackupManager` from `core` and a `BackupType` that exists nowhere,
   and returned `{ snapshotId, type, state }` where `BackupResult` is `{ success, snapshot }`.
   The heading rule cannot see any of it, because a fenced block has no headings. The user guide
   had five more: `Counter` and `Histogram` from `metrics`, which exports `ICounter`/`IHistogram`
   and creates them through `registry.counter()`; `BackupManager`, which is
   `InMemoryBackupManager` and takes its storage and retention policy positionally; and
   `report.passed`, where the field is `valid`. A guide that cannot compile is worse than no
   guide, because it is the page a reader trusts.

Nineteen of the 50 were internals — `audit` published nineteen helpers of `FileAuditStore`, and
the only importer outside the package was a _different package's_ test, which is the shape of an
export nobody asked for. Those are gone from the root and the test moved to the package that owns
the behaviour. The rest were real gaps: `FileAuditStore` itself, the seven production classes in
`security`, `BackupVerifier`, `S3StorageBackend`, the backup-chain functions, the cron grammar,
`PrometheusPushExporter`, `W3CTraceContextProvider`. The gate's suite now pins all three rules
against trees that must fail them, because the working tree passing is equally consistent with a
rule that never fires.

---

## 5. What is **not** covered

| Area                                                     | Status                           | Why it matters to you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-file coverage floor**                              | Gated (from iteration 25)        | The gate enforces the package total and every individual file; a single file below 95 % fails the build. The entry here used to say "partially gated… around a dozen files sit below 95 %" — that described an older gate and had been false since the per-file check was added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Federation cross-DC fault injection at the TLS layer** | Covered (iteration 24)           | `chaos/tls-fault-injection.test.ts` drives a real listener with real certificates: an untrusted CA is refused, a peer that stops is noticed within a bounded time, a peer that resets is reported, a peer that accepts but never reads cannot hang `send()`, and twenty reconnects leave no timer behind (AC 43.1–43.11). **Not** covered: an active proxy in the middle of an established stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Operations process-level acceptance**                  | Partially covered (iteration 35) | The audit write path is now killed for real: `AC81` starts a second process, waits for 120 acknowledgements, sends `SIGKILL`, and every acknowledged entry is readable afterwards; two processes appending to one trail lose nothing (`OS.1`). **Not** covered: a **power cut** — `SIGKILL` leaves the page cache intact, so it proves the line is in the file and cannot prove it reached the medium. The `fsync` half is asserted by order and by failure propagation in-process (`AC80`), and that limit is stated in the user guide rather than implied. Batching did not widen that gap: a burst of concurrent writes is acknowledged by **one** sync, and `GC.8` pins the case with one caller at a time to the same one-sync-per-write it always paid, so the throughput gain is concurrency and not a weaker promise. No other operations package has an out-of-process case yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Mutation testing over the rest of operations**         | Partially covered                | All three packages are gated by Stryker in CI (**94.26 %**, **94.10 %** and **98.03 %** as reported, gates at 70, 70 and 86). In operations thirteen of the twenty _modules_ in `node` are mutated, chosen by the selection rule _mutate what decides deletion, durability, or when work runs_; the other 7 have unit, integration and coverage gates but no mutant measures their assertions. The `cluster` package contributes four more — `quorum.ts`, `ClusterScalingExecutor`, `ClusterRolloutPlanner`, `RaftFaultTranslator` — because a scale-down that removes one node too many and a partition that emits one direction are failures a green suite can be green about. In the `cluster` and `federation` _engines_ one module each is mutated — the SQLite log and the TLS wire — because those are the two places a green suite can be green for the wrong reason. The rule is published in the roadmap (P2-14), so the next module is a decision rather than a preference. Iteration 52 hand-checked `CDCSubscriptionPump` against five mutations — the queue cap, the retry budget, the operation filter, the table filter, and the post-close accounting — and every one of them failed at least one named case, so it is the next entry in that queue. Iteration 53 did the same to `CDCFailureInjector`: a global instead of a per-entry budget (two cases), no duplicate-entry check, no injection-point filter, a swallowed disconnect, and a budget spent by a fault that could not fire — five edits, five named failures. |
| **TLA+ model checking**                                  | Manual                           | The specs exist and run locally; they are not part of CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Dependency advisories**                                | Covered                          | `pnpm audit:policy` holds the _production_ tree to zero high and critical advisories with no allowlist that can reach it, and requires a named, dated entry for anything in the dev tree — the test toolchain, which cannot always be fixed on the day an advisory lands because a transitive dependency may have no patched release. An entry that matches no advisory fails the gate, so the list cannot rot into an exemption nobody re-read; the two failure modes were checked by removing the entry and by adding a bogus one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

| **Cross-version upgrade path** | Partially covered | `AC 38.7` opens a database written before the `checksum` column existed, lets `open()` run the migration, and appends and verifies an entry afterwards — the schema half of an N-1 → N upgrade, with real bytes on disk. **Not** covered: a full N-1 → N upgrade crossing the wire and snapshot **formats**, which are versioned but never exercised across versions. |
| **Sustained soak beyond CI limits** | Scheduled only | Multi-hour runs exist (`test:soak`) but do not gate a pull request. |
| **Quorum-loss step-down** | Covered | raft-core 0.2.1 has no check-quorum, so an isolated leader keeps reporting `isLeader() === true` while committing nothing (measured: 16 s, commit index frozen, write refused at 5 028 ms). `checkQuorum` is now real: contact is a completed round trip through the _real_ transport, `isLeader()` answers from the role **and** from a majority inside one election timeout, `getLeader()` returns `null` while that is not true, and a write is refused with `QUORUM_FAILED` instead of waiting out the library's commit timeout. Seven cases in `quorum-loss.test.ts` drive it against a real 3-node TLS cluster. |
| **Documentation fidelity** | Covered (iteration 54) | Three gates, each comparing a different kind of claim to the code. `pnpm check:docs-api` reads every package's `exports` map and fails when a heading names a symbol the package does not publish, when a published value is named on no page, when a package ships no `docs/` tree at all, when a fenced import names a member the entry point does not have, or when a package index omits a package that exists. `pnpm check:doc-examples` type-checks all 316 fenced TypeScript blocks in 64 pages against the packages' **sources**, which is how 14 examples that could not compile — `new InMemoryLogger({ level: 'info' })`, `health.runAllChecks()`, `backups.delete(id)`, `tracing.extract(req.headers)`, `{ tables: [...] }` in a two-field config — were found and fixed. `pnpm check:public-types` closes the type half: every type a public signature names must be importable from the package root. Not covered: the prose around a signature, and the field-level detail of a config interface — a page can name the right class and describe the wrong default. |
| **CDC delivery over a network** | Not covered | The pump hands events to an `ICDCSink` the deployment supplies; the sinks exercised in CI are in-process (a recording sink, `InMemoryCDCSink`, the resolver, the failure injector). A webhook or Kafka sink is application code, and no suite here drives one over a real socket. The ordering, retry and loss properties are measured against the sink contract; a sink that lies about accepting a batch is outside it, and the contract says so. |
| **Coverage of the gates** | Covered | `pnpm test:scripts && pnpm check:script-coverage` runs the gate suite a second time under Node's own coverage and judges the result: every `scripts/*.mjs` must appear in the report, or be listed with a reason and a roadmap id; every measured gate must clear 95 % on lines, branches and functions; and a recorded debt that was paid — or that grew — fails the gate. It found why nobody could quote a number before: a coverage report lists the files that were **loaded**, so six of the fifteen gates were simply absent from it, and losing all coverage of a gate made the report _shorter_ rather than red — the same shape as the documentation gate that used to skip packages with no `docs/`. **Fifteen** scripts are measured, and **both** lists are now empty. `check-package` was the last entry in `UNMEASURED` (importing it _ran_ the check) and `package-targets.mjs` the last in `BELOW_FLOOR` (three `behaviour` closures that called the built artefact, in a job with no `dist/`). The first is a driver whose process, sinks and target table are parameters, judged by 21 cases that build throwaway packages with a real `dist/` — including the rule that a package ships its docs, which now has a case in which it fires. The second is gone: its closures became `e2e/harness/published-probes.mjs`, a child programme run in the E2E job where there is a build, so the table they lived in had no reason left to be a module of its own. Eight scripts are at 100 % on all three dimensions and every other one clears the floor. The floor is measured on a pinned engine (`22.13.1`) and the gate prints that engine in its header, because V8's branch accounting moved inside the 22.x line: the same commit read 95.45 % for `audit-policy` on one minor and 93.48 % on another. Writing the cases found three defects in gates that predate them, and one in the code they were written against: `check-public-types` reported a type declared inside an exported namespace as one a consumer cannot name, `check-gates` never read the root manifest, `check-docs-api` discovered packages from three hard-coded directory names, and `check-package`'s new summary printed four frames of `node:internal` as the whole diagnosis of a failed probe — the first fixture said so. |

| **Harness `.mjs` child programs** | Executed, not instrumented | `raft-node.mjs` and `federation-gateway.mjs` run out-of-process, so the v8 collector cannot see them. Their contract is covered by the harness suite in-process; their internals are not measured. |

Each row is tracked in the roadmap in
[`db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs/blob/main/plan/ROADMAP.md) with
an owner and an exit criterion; none of them is hidden behind a passing badge.

---

## 6. How to reproduce any number on this page

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm check:gates                                     # no orphan configs, no dangling scripts
pnpm check:docs-api                                  # every API heading resolves to a real export
pnpm check:doc-examples                              # every fenced example type-checks
pnpm check:public-types                              # every type a public signature names is exported
pnpm check:script-bins                               # every script's binary is installed
pnpm test:scripts && pnpm check:script-coverage      # the gates' own tests, and their coverage
pnpm typecheck && pnpm typecheck:tests               # static gates, production and tests
pnpm lint && pnpm format:check                       # the packages' sources
pnpm format:check:repo                               # everything no package owns: scripts, workflows, root pages
pnpm check:package                                   # every published entry loads, and its probe runs (needs pnpm build)
pnpm audit:policy                                    # production tree to zero, dev exceptions dated
(cd cluster && pnpm coverage)                        # unit + integration + conformance
(cd federation && pnpm coverage)
(cd operations && pnpm coverage)
pnpm coverage:e2e                                    # e2e harness, same 95 % thresholds
pnpm coverage:gate                                   # all four packages, every dimension
pnpm check:test-counts                               # the numbers on the README are this run's numbers
pnpm e2e                                             # 59 real-process acceptance tests (TLS, HTTP, SIGKILL)
pnpm test:mutation                                   # mutation score, all three packages
pnpm check:mutation-timeouts                         # every Timeout in those reports has been read
(cd cluster && pnpm test:perf)                       # 22 benchmarks on a real 3-node TLS cluster
pnpm verify                                          # all of the above, in order
```

A `Timeout` verdict has to be read, and reading one means replaying it: there is no score that answers
"did a test object" for a run that stopped. The replay is
`node operations/scripts/resolve-timeouts.mjs --target <name> --record`, which applies each edit to the
real tree, runs the tests the report attributed to it, and writes `mutation/timeouts.json`. It takes
about half a minute per abort, so CI runs the millisecond check (`pnpm check:mutation-timeouts`) instead
and fails when a report and that file disagree in either direction.

The benchmark suite runs on GitHub runners from `.github/workflows/benchmark.yml`; results
are attached to each run so a regression is visible next to the change that caused it. The
same suite runs on every pull request as the `benchmark` job in `ci.yml`, because a benchmark
nobody calls is a benchmark that stays broken.

**How the mutation score is produced.** Nineteen files are under mutation testing, chosen by one
rule — _mutate what decides deletion, durability, or when work runs_: durable state
(`cluster/.../SqliteStorage.ts`), the wire (`federation/.../TcpSecureTransport.ts`), what gets
deleted (`operations/.../RetentionPolicyEvaluator.ts`, `operations/.../FileAuditStore.ts`), what a
durable write costs (`operations/.../DurableFileSystem.ts`), whether
a backup can be replayed at all (`operations/.../backupChain.ts`,
`operations/.../InMemoryBackupManager.ts`), which key material survives at all
(`operations/.../KeyManager.ts`), which key material survives a rotation
(`operations/.../KeyRotationManager.ts`), which key a blob was sealed with
(`operations/.../EnvelopeEncryptionProvider.ts`), what a cipher does when it is initialised twice
(`operations/.../AES256GCMEncryptionProvider.ts`), when a window runs
(`operations/.../MaintenanceWindowScheduler.ts`), what time it runs at
(`operations/.../cron.ts`), whether a compliance window passed
(`operations/.../RotationAuditor.ts`) and whether evidence is tamper-evident
(`operations/.../AuditLogManager.ts`). The four assemblers the split introduced are mutated for a
different reason: `.../cluster/membership/quorum.ts` decides what a majority is, and
`.../scaling/ClusterScalingExecutor.ts`, `.../rollout/ClusterRolloutPlanner.ts` and
`.../chaos/RaftFaultTranslator.ts` decide which member leaves, which batch runs, and which
transport is told to drop traffic. A mutant there does not produce a wrong number on a graph; it
produces a group that has lost quorum, or a partition that exists on one side only. Stryker alters
the source one change at a
time and runs the tests that cover the change; a change no test notices is a behaviour nothing
constrains. Which edit Stryker made is recorded in `reports/mutation/operations.json`, and
`operations/scripts/replay-mutant.mjs` applies it by that record — a line number is not enough, and
iteration 30 proved it the hard way.

**There is exactly one instrument, and it lives at the root.** Stryker copies `process.cwd()` into a
sandbox and runs the suite inside the copy; that single fact decides where the configuration may live.
Until iteration 36 each package carried its own `stryker.config.json`, so the sandbox was a copy of
_one package_ — and both things every test file needs (`tsconfig.base.json`, which Vite reads while
transforming, and `scripts/test-tmpdir.mjs`, which every `vitest.setup.ts` imports) live one directory
above it. The run died on `TSConfckParseError: failed to resolve "extends"` rather than producing a
wrong number, which is the only reason the arrangement survived review as long as it did. There is now
one `stryker.config.mjs` and one `mutation/targets.mjs`, both at the root; the three package configs
are deleted. `scripts/mutation.mjs` is the only entry point: it refuses to start anywhere but the
repository root, refuses `--inPlace`, and sets `MUTATION_TARGET` for `stryker.config.mjs`, which in
turn refuses to run without it. The three `vitest` configs pin `root: __dirname`, because `include` and
`setupFiles` resolve against `root` and `root` defaults to the working directory — without the pin, a
run started from the root collects zero files and reports a perfect score over nothing.
`check:gates` grew a rule that fails when a `test:mutation` script is not invoked by a workflow, when a
target's `break` threshold is missing, when a `mutate` glob matches no file, or when any package runs
Stryker directly instead of delegating to the root. CI runs the three targets as
`pnpm run test:mutation:<target>` and then asserts that `git status --porcelain` is empty — an
in-place edit that leaked out of a sandbox would otherwise be committed by the next person.

| Package    | Module                           | Mutants |            Killed |                        Survived |       Score | Threshold |
| ---------- | -------------------------------- | ------: | ----------------: | ------------------------------: | ----------: | --------: |
| cluster    | `SqliteStorage.ts`               |     507 |               476 | 29 (+1 ignored, 1 runner error) | **94.26 %** |  break 70 |
| federation | `TcpSecureTransport.ts`          |     271 |  254 (+1 timeout) |                              16 | **94.10 %** |  break 70 |
| operations | `ClusterRolloutPlanner.ts`       |     134 |  119 (+7 timeout) |                               8 | **94.03 %** |  break 86 |
| operations | `KeyManager.ts`                  |     139 |  125 (+3 timeout) |              7 (+1 no coverage) | **94.12 %** |  break 86 |
| operations | `AuditLogManager.ts`             |     343 |  323 (+2 timeout) |             10 (+2 no coverage) | **96.44 %** |  break 86 |
| operations | `FileAuditStore.ts`              |     704 |  663 (+8 timeout) |            22 (+1 runner error) | **96.83 %** |  break 86 |
| operations | `RotationAuditor.ts`             |     286 |               275 |                               7 | **97.52 %** |  break 86 |
| operations | `AES256GCMEncryptionProvider.ts` |      81 |                79 |                               2 | **97.53 %** |  break 86 |
| operations | `EnvelopeEncryptionProvider.ts`  |     111 |               108 |                               2 | **98.18 %** |  break 86 |
| operations | `InMemoryBackupManager.ts`       |      95 |                93 |                               1 | **98.94 %** |  break 86 |
| operations | `MaintenanceWindowScheduler.ts`  |     622 | 602 (+13 timeout) |                               6 | **99.03 %** |  break 86 |
| operations | `KeyRotationManager.ts`          |     239 |               236 |                               2 | **99.16 %** |  break 86 |
| operations | `DurableFileSystem.ts`           |      74 |                73 |                               0 |   **100 %** |  break 86 |
| operations | `RetentionPolicyEvaluator.ts`    |     196 |  172 (+2 timeout) |                               0 |   **100 %** |  break 86 |
| operations | `RaftFaultTranslator.ts`         |     245 |               245 |                               0 |   **100 %** |  break 86 |
| operations | `quorum.ts`                      |      29 |                29 |                               0 |   **100 %** |  break 86 |
| operations | `ClusterScalingExecutor.ts`      |     162 |  161 (+1 timeout) |                               0 |   **100 %** |  break 86 |
| operations | `backupChain.ts`                 |      66 |   59 (+7 timeout) |                               0 |   **100 %** |  break 86 |
| operations | `cron.ts`                        |      87 |   82 (+5 timeout) |                               0 |   **100 %** |  break 86 |

Operations overall: **98.03 %** — 3 444 killed, 48 timed out, 67 survived, 3 with no coverage and one
that crashes the runner rather than failing a test, out of the 3 562 mutants the instrument judges (it
enumerates 3 613 and reports 50 as ignored, because a mutant that runs at import time executes before
any test can be blamed for it). The arithmetic is the gate's own:
`(killed + timeout) / (killed + timeout + survived + no coverage)`, and `(judged − survived − no
coverage) / judged` gives the same 98.03 %. The four `cluster` rows are the price and the reward of
moving the assemblers: three of them are at 100 % after their first pass because every refusal sentence,
every sorted peer list and every floor is asserted by name, and `ClusterRolloutPlanner` sits at 94.03 %
for the reasons in the survivor table below.

**Every one of the 48 timeouts has been read** — first in iteration 40, then again in iteration 61
after the split moved every path: each was replayed against the tests the report attributed to it, and
`mutation/timeouts.json` records what those tests said — 6 of them fail, 42 report nothing at all and
the run does not finish. None of the 48 passes, which is the question the
column could not answer before: a `Timeout` counted towards the score without any test having been
asked. The gate now reads what the file does not already answer, on the spot, and fails only when the
suite _passes_ an abort — a score that counted a detection nobody made. See
`docs/maturity.md#the-timeout-column`.

The overall figure is a share of a larger denominator than iteration 37's 98.09 %: `FileAuditStore.ts`
gained 161 mutants with the segment/archive reconciliation, 156 of which are killed.

**Iteration 39 gave that file 161 new mutants and killed 155 of them.** The six that remain are in the
table above with their arguments, and the suite behind them — `AC 90`, 21 cases — fails 15 times when
the two reconciliation calls are removed, which is what makes the argument about the other six worth
reading.

**The twenty-six survivors of `FileAuditStore.ts` were read one by one, and ten of them were real
gaps.** Every one was applied _exactly as the report printed it_ and run against the whole audit
suite: all twenty-six stayed green, which is what a survivor means — the suite did not make the
distinction, the instrument did not miss a failure. Each of the ten now has the case it lacked in
`AC 89`, and each of those cases was then re-checked the other way round: put the mutant back and the
named case fails. They are one family in seven shapes, and every shape is a boundary nobody had asked
about:

| Mutant                                                                               | The observation that was missing                                                                                                                                                                                 | Case   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `typeof error !== 'object'` → `false` in `isAlreadyExists`                           | `undefined` is the only input where reading `.code` off it throws instead of answering `false`; `null` is caught by the second disjunct and a string answers `undefined`                                         | `SV.1` |
| `retentionDays ?? DEFAULT` → `&&`                                                    | a window given as `2`: the suite had only ever passed `0` (disables) or `90` (the default), and `??` and `&&` agree on both                                                                                      | `SV.2` |
| the default `claim` → `() => undefined`                                              | the claim was only ever observed _after_ the append that followed it — a store that claimed nothing passed `SC.5`, because the file the second store found was the one the first store's append had just created | `SV.3` |
| `activeSegmentClaimed && needsSeparator(...)` → `true` (and → `\|\|`)                | a separator owed by an _adopted_ segment that ends cleanly: `DW.8` asserts the owed case and `DW.3` the store's own segment, and the parser skips a blank line, so only the bytes can tell                       | `SV.4` |
| `attempt < CLAIM_ATTEMPTS` → `<=`, and the second half of the failure message → `''` | the eighth attempt, counted; and the sentence that says what eight means — a loop that ran nine times and a message that stopped explaining the bound both passed                                                | `SV.5` |
| `i < covered && …` → `true` (and `i <` → `i <=`)                                     | a failure on the _first_ sync of a batch: `GC.5` fails the second, where the generation test rejects the rest on its own, so the count of covered commits was never load-bearing                                 | `SV.6` |
| `mtime === null` → `false` in `pruneOlderThan`                                       | a segment name the prune cannot date — the rule `EX.1` states for the retention sweep, at the boundary a caller chooses                                                                                          | `SV.7` |

Two survivors were not gaps at all, they were **dead assignments**, and they were deleted rather than
defended: `rotate()` reset `currentSize`, `currentCreatedAt` and `separatorOwed`, and the claim that
follows sets all three — so the second write always agreed with the first and no run could tell them
apart; and `activeSegmentClaimed` carried a `= false` initializer that the constructor overwrites. The
file is 543 mutants instead of 545 for that reason, and 97.37 % instead of 95.13 % because ten of what
remained are now killed.

The other fourteen are **equivalent**, and each has an argument rather than a test:

| Survivor                                                                                 | Why nothing can distinguish it                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name > newest` → `>=` in `newestOpenSegment`                                            | `readdir` cannot return a name twice; when the strings are equal the assignment writes the value already there                                                                                                                                                                                                     |
| `?? []` in `sweepAbandonedArchives` → a foreign name                                     | the loop keeps names that start with `<prefix>-` and end with `.ndjson.gz.part`; a foreign name removes nothing and the count is `0`, exactly as for an empty list                                                                                                                                                 |
| `?? []` in `getNextSequence` → a foreign name                                            | the regex cannot match it, so `maxSeq` stays `0` and the answer is `0001` — the same as for an empty list                                                                                                                                                                                                          |
| `if (!this.activeSegmentClaimed) return false` in `shouldRotate` → `true`, and → `false` | `rotate()` reads no file when the store has no name: `fileIdentity('')` throws `ENOENT`, which it catches. The two smaller tests would then be asked with `currentSize === 0` and an age measured from construction, and both can only answer true for a zero threshold — after which `rotate()` is the same no-op |
| `this.activeFilePath = ''` in `rotate` → any name                                        | every read of it is guarded by `activeSegmentClaimed`: `appendLine` claims before it appends, `shouldRotate` returns on the unclaimed state, and the next claim overwrites it. There is no suspension point in between                                                                                             |
| `if (!fileIdentity(oldPath)) return` in `rotate` → `false`                               | `archiveSegment` opens with the identical check and returns before it compresses, so the only difference is a scheduled job that does nothing                                                                                                                                                                      |
| `if (this.flushScheduled) return` → `false`, and `this.flushScheduled = true` → `false`  | a second schedule in one turn produces a second `setImmediate` that calls `flush()` on an empty queue, which returns at its first line. The flag's entire effect is the absence of a no-op                                                                                                                         |
| `if (this.pendingCommits.length === 0) return` → `false`                                 | an empty batch syncs nothing: `highest` is `-1`, `durableDirectoryGeneration` starts at `-1` and only rises, and both loops are over an empty array                                                                                                                                                                |
| `let synced = ''` → any name                                                             | the initial value is compared with an absolute path inside the data directory, so the first commit of a batch syncs either way and `synced` is overwritten immediately                                                                                                                                             |
| `let highest = -1` → `+1`                                                                | a commit's generation _is_ its segment's generation, so the newest commit in a batch is always at least the current one and the initial value cannot be the maximum                                                                                                                                                |
| `?? ''` in `readSegment`, and `return ''` in its `catch` → any text                      | the text reaches a parser that accepts nothing but NDJSON, so every alternative contributes zero entries — which is the property that let the `null` sentinel be deleted in iteration 34                                                                                                                           |

**The previous version of this paragraph said all 27 were killed. That was wrong, and the way it was
wrong is the point.** The tool used to verify them, `operations/scripts/replay-mutant.mjs`, resolved
its default report path against the working directory — so, started from `operations/` where it lives,
it opened a 2.6 MB in-place report left over from that morning, found fourteen survivors in it, and
reported them killed; four of those "kills" were runs that never finished. The tool now resolves the
report and every path inside it against the repository root, refuses a report older than the file it
describes, and restores the mtime so its own second replay is not blocked by the first.

### The timeout column

A `Timeout` is not a verdict: it says the runner stopped, not that a test objected. Stryker records two
different things under that status, and the operations target has 41 of them — every one read on
2026-11-18, by replaying the edit against the tests the report attributed to it:

| What the runner did                                           | Count | What it means                                                                                                                                                                 |
| ------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hit-limit abort (`statusReason: Hit limit reached (n/100×m)`) |    33 | the vitest runner counts how often a mutant executes and abandons the run at a hundred times the original's count — a _guess_ at non-termination made from an execution count |
| Wall-clock timeout                                            |     8 | `timeoutFactor × netTime + 30 s` elapsed                                                                                                                                      |

| What the suite said when it was asked again        | operations | federation | cluster |
| -------------------------------------------------- | ---------: | ---------: | ------: |
| `failed` — vitest reported a failing test          |          5 |          0 |       0 |
| `stuck` — nothing reported, the run never finished |         36 |          1 |       0 |
| `survived` — the suite passed it                   |      **0** |      **0** |   **0** |

The third row is the one that mattered. Had any of them passed, the score would have counted a mutant
no test noticed, and 97.96 % would have been wrong by that much. None did: every abort is either a
test the suite fails or an edit that cannot terminate — JavaScript cannot interrupt a synchronous
`while (true)`, so "the run did not finish" is the strongest honest record, and
`mutation/timeouts.json` holds the run that produced it, with the child's last three lines as evidence.

**The budgets were the other half of the question.** All three mutation configs inherited their
`testTimeout` from the unit suite — 60 s for operations, 180 s for the other two — and Stryker abandons
a mutant at about 31 s, so no test timeout could ever fire. The values are now derived from each
target's own measurement, four times its slowest case, rounded up to the next second and kept below the
runner's cap:

| Target     | Slowest case |                                          Where it comes from | Budget |
| ---------- | -----------: | -----------------------------------------------------------: | -----: |
| cluster    |     2 120 ms |                             `SqliteStorage.handle-lifecycle` |    9 s |
| federation |     2 479 ms |   `chaos/tls-fault-injection` (a delay, injected on purpose) |   10 s |
| operations |     3 665 ms | `AC75-work-factor` (scrypt at four work factors, on purpose) |   15 s |

Eighteen of the 59 aborts this target used to report are now kills: the budget expires before the
runner's cap, so the test is the party that fails. The cluster config's justification said "its slowest
case is under 100 ms", which had stopped being true — the number was 2 120 ms — and the gate now fails
when a mutation config inherits a budget instead of declaring one, or declares one at or above the cap.

`check:gates` cannot check a _measurement_, so the derived numbers live in the configs with the
measurement recorded beside them, and the relationship it can check is the one that broke: a test
timeout below the runner's cap, on every target, declared explicitly.

**The proof file is a cache, and CI proved it has to be.** The first version of the gate required the
report and `mutation/timeouts.json` to name each other in both directions, and CI run `44221390170`
failed it: the runner reported four mutants differently from the workstation the file was written on —
two as aborts that had been killed locally, two killed that had been aborts — because whether the runner
drains after a failed test depends on the load. A gate that fails on the difference between two
computers is a flaky gate, so the check now settles the difference instead of reporting it: a known
abort is answered from the file, an unknown one is replayed in place (half a minute), and the build
fails only on an answer — a suite that passes an abort. The file saves thirty seconds per known abort and
documents what was learned; it no longer decides whether CI is green.

**The dry run found a defect before it could run a single mutant.** `AC 85`'s `SC.3` asserted on
`audit-20261117-0001.ndjson`, a name the store derives from the clock; it passed until the first UTC
midnight after it was written and failed from then on — the mutation run on 2026-11-18 refused to
start at 00:03 UTC for that reason. The case now freezes `Date` (and only `Date`: the store flushes
through `setImmediate`, which a faked timer would hold open), so the day it asserts about is the day
it runs.

### The two product targets, read the same way

`SqliteStorage.ts` and `TcpSecureTransport.ts` carried 215 unread verdicts between them at 74.02 %
and 77.12 % — survivors, timeouts, runner errors and mutants no test reached. All 215 were replayed
exactly as the report printed them, and the answer was the same shape as `FileAuditStore`'s: **almost
all of them were missing tests**. The two files now stand at **94.26 %** (476 killed of 505 judged) and
**94.10 %** (255 of 271): 166 of the 215 are killed, 46 remain and each has an argument below, and 3
disappeared because the code they described was deleted.

Two of the 215 were not what the report said they were, and both corrections are the same lesson —
read the replacement, not the line:

- **The 19 `Timeout` verdicts were not equivalent mutants; they were decisions nobody had made.** The
  runner records "the test never finished" as a status the score does not count, which in a table is
  indistinguishable from "no test noticed". The judging suite now carries `testTimeout: 8000` — the
  whole file runs in about 5 s and its slowest case is under 100 ms, so 8 s is the line between slow
  and stuck — and all 19 became failing tests on the first run (P3-11). The timeout column is zero
  because there is nothing left in it, not because nothing hangs.
- **`ready.entries.length > 0` → `true` reads like a gap and is not one.** The replacement applies to
  the right-hand operand, so the `ready.entries &&` in front of it still guards the loop, and an
  absent entry list still takes the skip. `>= 0` is equivalent for the same reason plus one: an empty
  list iterates zero times.

What the 166 killed mutants were, in families — and every family is a question a caller asks:

| The observation that was missing                                                                                                                                                                                                                                             | Where it is now                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **When the bytes are forced out.** Three writes inside `beginBatch` opened zero descriptors; `endBatch` opened one; batch mode ended with the batch; `persistReady`'s three-entry transaction synced once, not three times; every truncation path and `setKv` forced its own | `AC 38.3`                       |
| **Which file a sync touches.** `fsync` truncates the WAL, syncs the main file, closes its descriptor and nothing else; `fsyncWAL` opens `-wal` and never the main file; a refused sync is logged with its own name rather than thrown                                        | `AC 38.4`, `AC 38.5`            |
| **What a failed open leaves behind.** A throwing `onOpen` used to leave a handle nobody could reach, `isOpen` answering true and a locked file — now rolled back, with the statements dropped and the error rethrown                                                         | `AC 38.1`, `AC 38.6`            |
| **Whether a database from an older build still opens.** The `ALTER TABLE` for the checksum column had never run against a table that predated it, so both the migration and its guard were untested                                                                          | `AC 38.7`                       |
| **What a damaged database reports.** `every` vs `some` over `integrity_check`, the failing rows in the message, the separators between them, and the retry verdict                                                                                                           | `AC 38.8`                       |
| **Which defaults actually reached SQLite.** `synchronous`, `wal_autocheckpoint`, `foreign_keys`, `busy_timeout` and `maxLogSize` were computed and then never read back — and `pragma(name, value)` was never asserted to have written anything                              | `AC 38.2`                       |
| **The auto-compaction boundary.** A limit of `0` means "no limit" rather than "compact always"; a snapshot index of `0` is not a reason to compact; a log exactly at the limit is not past it                                                                                | `AC 38.12`                      |
| **The wire frame, field by field.** The transport's own suite asserted `send` had been called, not what it carried — the message id, the source peer, the `federation_send` type, the payload bytes and the BigInt wall clock encoded as a string                            | `AC 47.1`                       |
| **A configuration that cannot be addressed.** Two peers sharing a wire id, a peer sharing this node's, an id with no number in it, `peers: []` falling through to the address list, and a legacy address with no host or no port                                             | `AC 47.3`–`AC 47.5`             |
| **The retry schedule as a schedule.** `maxRetries` attempts double, attempt `maxRetries + 1` is capped — asserted on `retryDelayMs()` instead of by timing a timer                                                                                                           | `AC 47.6`                       |
| **What a refused send costs.** An unknown peer arms no timer, a reachability refusal comes from the live check before the lagging snapshot, and `broadcast` counts deliveries rather than attempts                                                                           | `AC 47.2`, `AC 47.9`–`AC 47.11` |

Three of those turned into product fixes rather than tests, because the observation showed the
behaviour was wrong:

1. **`open()` was not exception-safe.** A throwing `onOpen` produced a half-open storage.
2. **`stop()` skipped detaching the inbound bridge when the transport had never started**, so an
   object destroyed during bootstrap stayed registered on the inner transport for that transport's
   whole life.
3. **`reconnect()` returned `void` over asynchronous work**, which made every failure inside it an
   unobserved rejection — and made the transport's own guards untestable, because breaking one of
   them produced no observable failure at all.

The leftovers are equivalent, in eight families for `SqliteStorage` and eight for `TcpSecureTransport`:

| Survivor(s)                                                                                                                                           | Why nothing can distinguish it                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `if (!fs.existsSync(dir))` → `true`                                                                                                                   | `mkdirSync(recursive: true)` on an existing directory is a no-op                                                                                                                                                            |
| `handle?.close()` → `handle.close()`                                                                                                                  | `handle` is the value assigned one statement earlier, so it is never nullish                                                                                                                                                |
| the `checkpoint('PASSIVE')` guard and its mode in `close()`                                                                                           | the handle is closed either way, and SQLite checkpoints on close; `wal_checkpoint()` with no argument is `PASSIVE`                                                                                                          |
| `if (!this.db) return` in `initStatements`                                                                                                            | every call is inside `open()`, after the handle is set                                                                                                                                                                      |
| `queue.length >= maxBatch` → `true`, `if (this.groupCommitTimer)` → `true`/`false`/`{}`, `clearTimeout` → `;`, `if (!this.groupCommitTimer)` → `true` | a flush of an empty queue returns at its first line, so a surplus timer or a surplus flush syncs nothing; `clearTimeout(null)` and `Map.delete` of an absent key are no-ops                                                 |
| `unref()` → `;`                                                                                                                                       | it changes whether the event loop stays alive, which no test observes and the runner decides                                                                                                                                |
| `let batch = []` → a foreign element, `queue = []` → a foreign element                                                                                | the initial value is overwritten by the mutex callback before it is read; the queue variant replaced by a foreign element throws inside a timer callback, which is the runner error this file records rather than a verdict |
| `if (batch.length === 0) return` → `false`                                                                                                            | an empty batch syncs a database that has nothing to sync — same bytes, one extra call                                                                                                                                       |
| `?.minIndex`, `?.count`, `countRow?.count`, `row?.minIndex`, `row?.count`                                                                             | `MIN`, `COUNT` and `LIMIT 1` over a non-empty table always return a row; over an empty one `MIN` answers `null`, which the `?? 0` behind it handles                                                                         |
| `if (hardStateBuf)`, `if (metaBuf)`, `if (meta.hardState)` → `true`                                                                                   | `JSON.parse(buf.toString())` on `null` throws into the `catch` that already exists, leaving the field unset                                                                                                                 |
| `ready.entries.length > 0` → `true`/`>= 0`, same for `committedEntries`                                                                               | the `ready.entries &&` in front of the operand still guards the loop; an empty list iterates zero times                                                                                                                     |
| `this._batchMode = true` → `false` in `persistReady`                                                                                                  | inside a `better-sqlite3` transaction every `fsync()` fails with `SQLITE_BUSY` and is caught by its own handler, so the per-entry syncs the flag suppresses would not have reached the file anyway                          |
| `if (fromIndex > lastIndex) return []` → `false`                                                                                                      | the range query answers `[]` for the same input, which is what the guard was returning                                                                                                                                      |
| `if (existing)` → `true`, `_retryTimers.delete()` → `;`                                                                                               | `clearTimeout(undefined)` is a no-op, and the entry is overwritten by the `set` two lines later                                                                                                                             |
| `getStatus?.()?.connectedPeers.includes(id)` variants                                                                                                 | the refusal below it reads the same snapshot directly, so a wrong `reachable` is corrected one statement later                                                                                                              |
| `if (peers.length === 0) return 0` → `false`                                                                                                          | `allSettled([])` is `[]`, and the filter of an empty array is `0`                                                                                                                                                           |
| `r.status === 'fulfilled'` → `true` in the broadcast filter                                                                                           | `true && r.value` is `r.value`: a rejected settlement has no `value`, so it is still not counted                                                                                                                            |
| `/^\d+$/` → `/\d+$/` and → `/^\d+/`                                                                                                                   | `Number('abc12')` and `Number('12abc')` are `NaN`, and `logicalByNumeric.has(NaN)` is false, so both fall through to the string form                                                                                        |
| `messageHandlers.clear()` → `;` in `destroy()`                                                                                                        | `destroy()` calls `stop()` first, which detaches the bridge; there is no subscriber left to iterate                                                                                                                         |
| `if (digits.length === 0) return null` → `false`, and `?? ''` → any text in `extractPort`                                                             | `parseInt('')` and `parseInt('Stryker was here!')` are both `NaN`, which the `Number.isNaN` behind them maps to the same `null` / `7000`                                                                                    |
| `host && host.length > 0` → `host                                                                                                                     |                                                                                                                                                                                                                             | …`, `> 0`→`>= 0`, `?:`→`true` | the `host &&` outside the comparison already rejects the empty string, so the condition is never the only thing standing between `''` and the answer |

The previous version of _this_ section also said every number here was a floor. That claim is
withdrawn for a different reason, and the way it was withdrawn matters: iteration 35 argued that
`--inPlace` let four workers share one source tree, so a worker's vitest could read a file another
worker had already restored. The _symptom_ was real, but the hand application was not the edit the
report printed — the report said `false || mtime >= cutoff` and what was applied was
`if (false) continue;`, which is a _stronger_ change. Applying the printed replacement left all 162
tests green: the `mtime === null` arm had never been tested. The rule that came out of it is now part
of the review habit: **apply the replacement the report prints, never a stronger one.** A survivor is
either a missing assertion or an equivalent mutant, and both are provable; "the runner is wrong" is
not a third option. The headline moved for reasons that are worth separating: modules joined the list
(`AES256GCMEncryptionProvider` at 97.53 %, `DurableFileSystem` at 100 % on its first measurement) and
the weakest improved because their defects were fixed rather than excused —
`EnvelopeEncryptionProvider` 90.38 → 98.18 %, `KeyManager` 86.60 → 94.12 %, and `FileAuditStore`
97.05 → 98.85 % when its durable-write recipe stopped being unobservable. Every one of the fourteen mutants that changed verdict
in those two files was a _behaviour_ the suite did not constrain, and reading them produced the four
concurrency defects recorded in the changelog: a version number that two mints could share, eight
keys minted for eight concurrent first writes, a header naming a version the payload was not sealed
with, and a wipe that an in-flight mint undid.

The composition of what remains is now almost entirely two families: memory wipes (nine mutants) and
encoding and separator defaults (`'utf-8'` → `''`, `'|'` → `''`, `?? ''` → any text). The third family
— the durability recipe in `FileAuditStore.writeLine`, five mutants that no test could reach — is
gone: iteration 34 put the recipe behind a four-operation port, which made the _order_ assertable, and
the survivors it left are enumerated below. Two
survivors are in none of those families and are recorded as equivalent with a proof rather than as
gaps: the `err` branch of the PBKDF2 callback (Node throws synchronously for an unusable digest, so
the branch is unreachable — proved by AC 75.21, which sees the throw from `generateKey`) and the
optional call on a `Map` entry read one statement earlier.

The operations score is higher than the other two because the mutated surface is pure decision
logic with no sockets and no clock of its own: a surviving mutant there is almost always a missing
assertion rather than a verdict that depends on the machine.

The survivors of every other module were read one by one as well; `FileAuditStore`'s are accounted for
above, one mutant at a time. Where a row below describes a mutant that is no longer reported, the
reason still holds for the family — a survivor disappears when the behaviour it changes gets an
assertion, and the argument for the family does not. Each family names the property that makes it
invisible to any in-process assertion; the reasons are grouped, because one property often explains
several mutants:

| Module                                                                    | Surviving mutant                                                                                                                                        | Why no test can distinguish it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InMemoryBackupManager`                                                   | `state: 'in-progress'` → `state: ''`                                                                                                                    | the same method sets `completed` before it returns, so the interim value is never observable                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MaintenanceWindowScheduler`                                              | `cursor.setUTCHours(...)` → `setUTCMinutes(...)`                                                                                                        | the cursor's _month_ is what drives the loop; every candidate is built from explicit year/month/day and `startTime`, and the ones the moved cursor would skip have already failed `candidateMs >= fromMs`                                                                                                                                                                                                                                                                                                            |
| `MaintenanceWindowScheduler`                                              | `cursor.setUTCDate(1)` → `cursor.setTime(1)`                                                                                                            | the cursor jumps to 1970 and walks every month to the range; all those candidates are before `fromMs`, so the answer is the same and only the walking is wasted                                                                                                                                                                                                                                                                                                                                                      |
| `MaintenanceWindowScheduler`                                              | `while (cursorMs < toMs)` → `<=` (monthly)                                                                                                              | at equality no candidate is `< toMs`, so the extra month contributes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MaintenanceWindowScheduler`                                              | `day > lastDay` → `day >= lastDay`                                                                                                                      | at `day === lastDay` both branches produce `lastDay`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MaintenanceWindowScheduler`                                              | `while (cursor.getTime() < toMs …)` → `<=` (cron)                                                                                                       | as above, for the minute scan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MaintenanceWindowScheduler`                                              | `iterations < maxIterations` → `<=`                                                                                                                     | one extra minute inside a 100 000-minute safety bound; only an expression that matches every minute for 69 days could see it, and that projection allocates 100 000 instances                                                                                                                                                                                                                                                                                                                                        |
| `KeyRotationManager`                                                      | `success: false` → `true` in the event template                                                                                                         | every exit assigns it: the success path sets `true`, the `catch` sets `false`, and there is no third way out                                                                                                                                                                                                                                                                                                                                                                                                         |
| `KeyRotationManager`                                                      | `default:` arm of `_isDue` removed                                                                                                                      | the fall-through returns `undefined`, and the caller asks a yes/no question — `undefined` is not due, which is what `return false` says                                                                                                                                                                                                                                                                                                                                                                              |
| `FileAuditStore`                                                          | `name > newest` → `>=`                                                                                                                                  | `readdir` cannot return the same name twice, so the two comparisons select the same name                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FileAuditStore`                                                          | `?? ''` in `readSegment`, and the `return ''` in its `catch` → any text (two mutants)                                                                   | the replacement text reaches a parser that accepts nothing but NDJSON, so every alternative contributes zero entries — which is the property that let the `null` sentinel be deleted this iteration                                                                                                                                                                                                                                                                                                                  |
| `FileAuditStore`                                                          | `isUnlinkRefusal(error)` → `true`                                                                                                                       | no runner can make `unlink` fail for a reason outside the four listed codes — a process running as root is never refused — and the rule itself is asserted by `DW.12`, which is why it is a predicate rather than a list inside a `catch`                                                                                                                                                                                                                                                                            |
| `FileAuditStore`                                                          | `rmSync(gzPath, { force: false })`                                                                                                                      | detected as a **crash**, not as a failing test: without `force` the cleanup rejects inside a `catch` whose promise nothing awaits, and the runner dies with it — which is the unhandled rejection the flag prevents                                                                                                                                                                                                                                                                                                  |
| `FileAuditStore`                                                          | `'at-rest'` → `''` on the reconciliation's call to `repairFor`                                                                                          | the function asks `when === 'live'`, so every value that is not `'live'` takes the at-rest path — the parameter is a union of two names for readability, and the distinction it encodes is one predicate                                                                                                                                                                                                                                                                                                             |
| `FileAuditStore`                                                          | `else if (repair === 'promote')` → `else if (true)` in the sweep                                                                                        | the only verdicts that reach that branch are `none`, `release` and `promote`, and on a runner that reads as root a name that exists and yields no text cannot be produced — the cell is asserted through `repairFor`'s table (`SH.21`) rather than through a directory                                                                                                                                                                                                                                               |
| `FileAuditStore`                                                          | `if (repair === 'promote')` → `if (true)` in the live path                                                                                              | as above: with an archive present, `none` and `plain-unreadable` are the only other verdicts, and the second one is unreachable without a file the runner cannot read                                                                                                                                                                                                                                                                                                                                                |
| `FileAuditStore`                                                          | `if (!isRegularFile(archivePath)) return` in the live path → `false`                                                                                    | `relateTwin` answers `no-twin` for an archive that is not there, so the guard changes only how many bytes are read — and the bytes it prevents reading are the _whole active segment_, which is why it stays                                                                                                                                                                                                                                                                                                         |
| `FileAuditStore`                                                          | `this.activeFilePath = ''` in `releaseActiveFile` and in `rotate` → any string                                                                          | the name is re-derived by the claim that the next append makes before it uses one; both assignments exist to keep "an unclaimed store names nothing" true, and no reader observes the intermediate value                                                                                                                                                                                                                                                                                                             |
| `RotationAuditor`                                                         | `hash: ''` placeholder → any string                                                                                                                     | the placeholder is overwritten by `_hashEntry` before the entry is stored, and `hash` is not part of the hashed content                                                                                                                                                                                                                                                                                                                                                                                              |
| `RotationAuditor`                                                         | `firstCompletedAt !== null && lastCompletedAt !== null` → `\|\|`, or → `true` (three mutants)                                                           | both are derived from the same list, so they are null together and non-null together; with neither, `null - null` is `0`, which is what the ternary returns                                                                                                                                                                                                                                                                                                                                                          |
| `RotationAuditor`                                                         | the `\|` separator in `_hashEntry` → `''`                                                                                                               | the separator is a free choice: any fixed string produces the same chain. Only a deliberate concatenation collision could tell them apart, and `seq` is a number between two fixed-width fields                                                                                                                                                                                                                                                                                                                      |
| `AuditLogManager`                                                         | `'utf-8'` in `createHash().update()` and in `appendFileSync` → `''` (two mutants)                                                                       | `''` is falsy, so Node falls back to the same default encoding                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AuditLogManager`                                                         | `sortBy ?? 'timestamp'` → `''`, `sortDir ?? 'asc'` → `''`                                                                                               | the default only matters when the field is absent, and `''` matches none of the other branches, so it takes the same `timestamp` / `cmp` path                                                                                                                                                                                                                                                                                                                                                                        |
| `AuditLogManager`                                                         | `a.seq - b.seq` → `a.seq + b.seq`                                                                                                                       | the event log is append-only, so it is always already in sequence order; a comparator that returns a consistent positive sign cannot reorder it, in either direction                                                                                                                                                                                                                                                                                                                                                 |
| `AuditLogManager`                                                         | `if (limit <= 0) return []` → `limit < 0`                                                                                                               | for `limit === 0` the `slice` below returns the same empty array                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AuditLogManager`                                                         | `events.length - drop > maxEvents` → `>=`                                                                                                               | the assignment that follows sets `drop` to `events.length - maxEvents`, which at equality is the value it already has                                                                                                                                                                                                                                                                                                                                                                                                |
| `AuditLogManager`                                                         | `if (this.flushTimer)` in `destroy()` → `true`                                                                                                          | `clearInterval(null)` is a no-op and the field is nulled either way                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KeyManager`                                                              | `existing.key.length === dek.length &&` → `true`                                                                                                        | `Buffer.equals` compares lengths itself, so the test could not be told from its absence — the line was deleted rather than excused                                                                                                                                                                                                                                                                                                                                                                                   |
| `KeyManager`                                                              | `if (err) reject(err)` → `if (false)` (and the `reject` call itself, which no test covers)                                                              | the branch is **unreachable**: `crypto.pbkdf2` reports an unusable digest or work factor by throwing synchronously, and the promise executor turns that into the rejection. AC 75.21 observes the rejection from `generateKey` — with the branch present and with it disabled — so the two verdicts are the same rejection from different frames. Kept because the callback signature can report an error in principle, and resolving with `undefined` would fail one frame later with a message nobody could act on |
| `KeyManager`                                                              | `this.kekCache.get(oldest)?.fill(0)` → `.fill(0)`                                                                                                       | the entry was read from the same map one statement earlier and nothing between them can remove it                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `KeyManager`, `EnvelopeEncryptionProvider`, `AES256GCMEncryptionProvider` | every `fill(0)` on key material, and the `try`/`finally` blocks that hold them (nine mutants)                                                           | wiping a buffer cannot be observed by an assertion inside the same process (P2-19). Every one of these buffers has exactly one reference — the history, map or local being cleared on the next line — and the accessors (`getKey`, `getCurrentKey`) hand out copies, so no caller holds the buffer being wiped. It is a _testability_ limit, not a permission to stop wiping                                                                                                                                         |
| `ClusterRolloutPlanner`                                                   | `const candidates: ClusterMember[] = []` → `['Stryker was here']`                                                                                       | every candidate is classified by `order()`, which keeps a member only if it is a `learner`, a `follower` or the `leader`; a string has no role, so it reaches no batch, no id list and no zone                                                                                                                                                                                                                                                                                                                       |
| `ClusterRolloutPlanner`                                                   | the batch-size floor: `Number.isFinite(capped) && capped >= 1` → `true`, `&&` → `\|\|`, `>= 1` → `> 1`, and `Math.floor(capped)` removed (four mutants) | `capped` is `min(requestedBatchSize, budget)`, and both are positive integers by construction — every strategy answers at least one, and the branch is reached only when `budget >= 1`. The floor cannot change a number that is always already legal; it is there so that a strategy added later fails as a wrong plan instead of an infinite loop, and the one input that would make it matter — a strategy this version does not know — is pinned by `AC-CL4.20` as a throw                                       |
| `ClusterRolloutPlanner`                                                   | `input.batchSize >= 1` → `> 1`                                                                                                                          | the two differ only at exactly `1`, where both answer one node per batch                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Two survivors in `ClusterRolloutPlanner` were killed by the whole suite and survived the subset the
runner chose.** Stryker attributes a mutant to the tests that execute the line it changed, and runs
only those: for the `percentage` fallback and the `fixed_size` guard it selected a subset that did not
contain `AC-CL4.10` / `AC-CL4.19`. Replaying each edit by hand — `typeof input.batchSize === 'number'
&& …` → `true`, once per strategy — fails exactly those cases, so the behaviour is constrained and the
verdict was an artifact of the subset. Two more of the nine disappeared the same way once `AC-CL4.20`
existed: `case 'one_by_one': return 1;` → `case 'one_by_one':` falls through to `all_at_once`, which
the quorum cap hides on a three-node group and does not hide on a five-voter one. The six that remain
are in the table above.

**P2-18 was withdrawn, and the way it was withdrawn is the useful part.** Iteration 30 reported
five mutants as "killed by hand, survived according to the runner" and concluded the runner's
per-test attribution was wrong. The report had not been read carefully enough. It recorded a
survivor at `AuditLogManager.ts:167` whose replacement text was `false`; the statement at that
position is `stats.eventsBySeverity[s] = (stats.eventsBySeverity[s] || 0) + 1`, and the change that
was applied by hand was `if (false) stats.failedEvents++`, the statement two lines below it, which
the runner had killed all along. The same mistake accounts for the other four: a line number was
used as the identity of a mutant, and line numbers move.

The instrument that prevents a repeat is `operations/scripts/replay-mutant.mjs`. It reads the
report, finds the mutant by status, and splices the recorded replacement into the recorded character
range — the only description of the edit that is unambiguous. `apply <n>` prints what it removed and
what it inserted, so the operator sees the change before running the tests. The five "discrepancies"
are now five missing assertions (AC 73.1–73.13), each verified by replaying the recorded edit and
watching the named test fail:

| Recorded survivor                                              | What a caller would have noticed                                               | Killed by      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| `(stats.eventsBySeverity[s] \|\| 0)` → `false`                 | every severity bucket reported one event, whatever it held                     | AC 73.1        |
| `${expectedSeq + i}` → `${expectedSeq - i}` in the gap message | the second and later gaps blamed the wrong number                              | AC 73.2        |
| `flush()`'s empty-buffer guard → `false`                       | flushing an idle manager appended a blank line to an NDJSON trail              | AC 73.3        |
| `actual.ino !== expected.ino` → `false`                        | a different file of the same length was deleted as if it were the measured one | AC 73.12       |
| `[...DATA_KEY_BYTES].join(', ')` (two mutants)                 | the error message lost the list it exists to state                             | AC 73.4        |
| `iterations < 1` → `<= 1`                                      | `iterations: 1` was refused                                                    | AC 73.5        |
| `version > highestVersion` → `true` in `loadKey`               | importing an old key lowered the next minted version                           | AC 73.6        |
| `ciphertext.length <= HEADER_PREFIX_LENGTH` (two boundaries)   | a blob that has a header was reported as short                                 | AC 73.9, 73.10 |
| `data.length <= 12 + 16`                                       | the only empty ciphertext the provider can produce became undecryptable        | AC 73.11       |

Iteration 32 closed the two `FileAuditStore` survivors that had been registered as P2-21, and it
closed them in opposite ways because they turned out to be opposite things. The unreadable-segment
skip was **not** an untested branch: `readSegment()` returned `null`, both call sites answered it with
`continue`, and the parser said the same thing a second way — `JSON.parse(null)` yields nothing to
push, and `''.split('\n')` yields one line no parser accepts. Two statements expressing one fact is
how a mutant survives, so the sentinel was deleted rather than tested around. The per-segment budget
break was a real gap, and the fix was the seam the roadmap asked for: `FileAuditStoreConfig.segmentReader`
is the store's read port, its default is the exported `readSegmentFromDisk`, and a scan's I/O is
therefore observable — which is what makes "`maxScanLines` keeps a page cheap" an assertion instead
of a comment (AC 76.6–76.8).

Reading them was worth doing rather than assuming: iteration 27 turned 38 survivors into 11
assertions and two defects, iteration 29 turned 100 into eighteen defects and seventy-five
assertions, and iteration 30 turned 81 into four defects and thirty-two assertions. What is left is
quieter, and each row above says _why_ the mutant cannot be seen rather than _that_ it probably
cannot.

A green suite says the assertions pass. It does not say they would fail if the behaviour changed —
that is what the score adds. P2-15 ("read every survivor") is closed: the seven that remain are
written out above with the reason each is invisible, rather than counted as a number and left
unread. P2-17 in the roadmap asks the one remaining question — whether the monthly and cron
projections can be restructured so their loop bounds are observable — and that is a design
argument, not a missing assertion. Iteration 29 started from a hundred survivors across two modules and
turned them into eighteen defects and seventy-five assertions (AC 66.1–66.38, AC 67.1–67.31); of the eighteen that remain, seventeen
are equivalent for a stated reason and one is registered as a runner discrepancy. The defects were
not exotic: the audit store's count was capped at a page, its active segment was chosen by sequence
number across dates, its retention setting was read by nothing, and the rotation manager accepted
`reEncrypt: true` and re-encrypted nothing. Reading a survivor is still the cheapest defect
detector in this repository.

The cluster score moves by about half a point between runs, which is why the break threshold sits
three points below the observed value rather than one. Most of that movement comes from the 19 mutants
that time out, whose verdict depends on how much of the runner they get that minute — but not all of it
did, and finding out which part was not is worth more than the half point.

**The mutation config for this package was itself flaky, and it was measuring noise.** With
`fileParallelism: true`, three clean runs of the config — no mutant applied at all — failed a test in
two of them, with `SqliteError: disk I/O error` from `pragma journal_mode = WAL`, and a _different_ test
each time. Replaying the reported survivors made the consequence concrete: 68 of the 133 "survived"
mutants failed the suite when applied, because a flaky test was failing and the runner attributed it to
the mutant. A score moved by noise moves in both directions, and neither is evidence.

Turning file parallelism off — and nothing else — fixed it: four of four clean runs pass, the suite is
**faster** (3 m 40 s for the whole mutation run against roughly ten), and the score went **up** by half a
point — **74.02 %** locally (357 killed, 132 survived, 19 timeouts) and **74.21 %** in CI run 44059738539
(358 / 131), the same nineteen timeouts explaining the difference. The suites are isolated per file
(`mkdtemp`), so what they share is the box: SQLite's WAL bookkeeping, and a runner on which Stryker
already starts four workers, each with its own sandbox copy of the repository. Four files in parallel
inside each of those is sixteen processes for a suite that takes five seconds. The mutation job itself
went from about an hour to **4 m 15 s** for this target.

That number was a floor, and the iteration after it found out how low: the nineteen timeouts were the
first hint, and the 132 survivors were the rest. Reading them (see _The two product targets, read the
same way_ above) took the same target to **94.26 %** — 476 killed, 29 equivalent, one runner error — with
a run time of 1 m 35 s, because a suite that fails fast costs less than one that waits to be killed.

**How the performance numbers are produced.** Every latency case goes through
`src/testing/latency.ts`: an explicit warmup window that is discarded, then nearest-rank
percentiles over the recorded samples — no interpolation, and an empty sample set is an error
rather than a zero. The cluster benchmarks start three real nodes over mTLS and propose through
`RaftAdapter`, one file at a time, because a benchmark that shares cores with another benchmark
is not measuring the middleware. Representative numbers from this machine:

| Metric                                               | Value                                |
| ---------------------------------------------------- | ------------------------------------ |
| `proposeAndWait` p50 / p99 (n = 200)                 | 1.09–1.39 ms / 3.5–4.6 ms            |
| Sequential throughput                                | 712–874 ops/s                        |
| `readIndex` / `leaseRead` p50 (n = 1 000)            | 0.001 ms                             |
| Retained log after 300 proposals (default threshold) | 21 entries                           |
| Retained heap per proposal                           | 1.0–1.4 KB                           |
| Concurrent (8 in flight) versus sequential           | 0.42–0.43× — see P1-5 in the roadmap |

**A convergent property cannot be read at an instant.** CI run `44225232372` failed the benchmark
job on `AC 29.2`: `expected [ null, 2, null ] to deeply equal [ 2, 2, 2 ]`. That is neither a flake
nor a product bug. raft-core's `becomeLeaderUnlocked` sets `state = Leader` and
`currentLeader = self`, _then_ appends the no-op entry, _then_ starts the heartbeat timer — and
`TestCluster.findLeader()` polls `isLeader()`, so it resolves inside that window. A test that reads
`getLeader()` on all three nodes immediately afterwards is reading a property that cannot have
converged yet. Measured on a workstation: **six of six** trials returned `[ 1, null, null ]` right
after `findLeader()`, converging 54–68 ms later — one heartbeat. The assertion was wrong on every
run and passed only when unrelated work happened to buy a heartbeat.

The same defect appeared a second time as `await sleep(2000)`, commented "give some time for leader
info to propagate", followed by `filter((l) => l !== null)` before asserting that one id remained:
two of three nodes could know nothing and the case still passed.

`@agentix-e/db-cluster/testing` now ships the wait as an object: `pollUntil(read, accept,
{ timeoutMs })` and `awaitAgreement(reads, { timeoutMs, require, equal })`, with
`TestCluster.awaitLeaderAgreement()` built on them. The contract is pinned by twenty-three cases
(`AC 45.1`–`AC 45.14`, `AC 46.1`–`AC 46.9`), most of them driven by an injected clock, so deadline
behaviour is tested exactly and in microseconds — and the three that are not are there on purpose,
because a primitive whose real clock and real sleep are never executed is a primitive shipping its
test double:

| Property                                   | Why it is the contract                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The deadline bounds waiting, not looking   | a check skipped for want of time reports "not converged" about a property nobody read                                                        |
| A read started inside the budget counts    | an RPC that returns late still answered the question that was asked in time; discarding it makes the outcome a function of scheduler latency |
| A throwing read is retried, and remembered | during an election a peer may not answer; "timed out" must not hide a broken transport                                                       |
| The failure carries the observation        | `attempts=2 last observed: [null,2,null]` separates a lagging follower from a cluster that never elected anyone                              |
| Readers of a round are read concurrently   | three sequential reads observe three moments and call the difference a fault                                                                 |

Three consequences, each measured rather than argued. `AC 29.2` now agrees in two rounds (54–68 ms),
which is one heartbeat and exactly what the protocol implies. `AC 7.2` dropped its 2 000 ms sleep for
a bounded agreement, runs in **502 ms**, and asserts something stricter than before. And `FC.4` —
which had asserted that no node may _claim_ leadership when one of three survives — turned out to
assert a property the library never claimed: raft-core 0.2.1 implements no check-quorum, so an
isolated leader keeps reporting `isLeader() === true` (measured: still true at 16 s, commit index
frozen at 1, the write refused after 5 028 ms). It asserts the guarantee that exists — a minority
commits nothing — and the missing step-down is registered as P3-20 alongside the `checkQuorum` and
`preVote` flags that were declared and never forwarded to the library.

**The per-file floor caught the gap this iteration created, which is the gate doing its job.** The
first push passed twenty-two CI jobs — including the benchmark that had failed — and failed
`coverage-gate` with `TestCluster.ts: lines 90.43 %` and `convergence.ts: functions 90.90 %, branches
91.30 %`. The cause was structural rather than careless: `awaitLeaderAgreement` was exercised only by
the performance suite, which the coverage configuration excludes, and the new module's real clock and
real sleep are only reached by a caller that omits them. Both are now measured on their own terms —
`convergence.ts` at 100 % on all four dimensions from its unit cases alone, `TestCluster.ts` at
99.2 % lines with an integration case that asserts the agreement from every node — and the number in
this paragraph is the one the gate prints, not the one a reviewer would have assumed.

Not covered: fixed sleeps that precede assertions remain in the `raft-stress`, `raft-core` and
`raft-shared-transport` child-process suites (P3-19). Same defect class, same remedy, but each
conversion has to be read rather than applied mechanically.

**A fault injector installed into a field nobody reads.** With the leader of a real 3-node cluster
"partitioned" — `ChaosCluster.injectFault('partition', [leader])` — the injector reported
`{lost: 0, delayed: 0, partitioned: 0, forwarded: 0}` and the isolated leader **committed a write**.
Not a counting bug: `RaftNode` captures the `Transport` object it is constructed with, and the harness
assigned the injector to `adapter.transport` _after_ construction, so the library kept talking to the
transport it had. Every partition, loss and latency fault in this repository was applied to a
transport nobody used, which means the assertions that followed — "no split brain", "converges after
partition recovery" — were describing a cluster that was never partitioned.

The seam is one object: `SwappableTransport` is what raft-core holds, and `adapter.transport` is now a
getter/setter over its inside. Two details are the contract rather than the implementation. The
inbound handler follows every swap, because raft-core registers exactly one handler, once, at start —
a seam that forwards sends but not the handler produces a node that answers nothing while looking
correctly wired. And optional transport methods stay _absent_ when the wrapped transport cannot do
them, because raft-core branches on whether `addPeer` exists: a wrapper that always defines it turns
"this transport cannot add peers" into a failed start, which is how `raft-shared-transport` broke on
the first attempt.

Making the injection real exposed three more defects in the harness, each of which had been invisible
for the same reason — nothing ever called it:

| Defect                                                                         | What it produced                                                                                                                                                       | Fix                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The injector kept its own `started` flag                                       | every Raft RPC failed with `ChaosInjectingTransport not started` the moment the seam routed through it: an injector installed on a running node had never been started | delegate the lifecycle; a wrapper adopts the state of what it wraps |
| A dropped request was answered with an `AppendEntries` message whatever it was | a `RequestVote` answered by an append is not a dropped message, it is a malformed one that reads as a rejection by accident                                            | refuse in the request's own kind at term 0, in one shared helper    |
| Isolation only filtered outbound traffic                                       | a "partitioned" follower still answered the leader's heartbeats, so it stayed in sync: a half-open partition                                                           | filter inbound as well, and mark the complement on the other side   |

Plus a fourth, in the tests themselves: `injectFault('partition', [])` isolated _nobody_ and healed
nothing, and four call sites wrote it meaning "rejoin the cluster". With injection inert that was
harmless; with injection real, `BP.3` wrote 30 of the 55 entries it asserts and `BP.2` never elected a
leader again. `injectFault('partition', [])` now heals — isolating nobody _is_ healing everyone — and
`healPartitions()` names it. The same file's `verifyConvergence` used to `console.log('[WARN] …')` and
return, so every "after healing, all nodes converge" claim in it was unfalsifiable; it throws now.

**The leader that could not serve.** `checkQuorum` was documented as "default: true" and read by
nothing. It is now a quorum watchdog: `ObservedTransport` sits _innermost_ — inside any injector — and
records the moment the real transport completed a round trip, because that is the only evidence a peer
answered. A fault layer that answers a message it dropped produces no observation, which is exactly
what an isolated leader must not mistake for contact. Two runs of the same experiment, one node of
three isolated, at the four-second mark:

| Configuration                            | Leadership                                                                           | The write                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `checkQuorum: false` (the old behaviour) | `isLeader()` still `true`, 40 messages blocked, so the isolation was real            | refused after **5 035 ms** by the library's commit wait                                             |
| `checkQuorum: true` (the default)        | `false` within one election timeout, and `getQuorumHealth()` names both silent peers | refused with `QUORUM_FAILED` inside **1.5 s**, naming the majority, the window and the silent peers |

The library's own role is left alone: the node stops _claiming_ it can serve, which is the part a
router reads. `getLeader()` returns `null` while that is true — a leader that cannot hear a majority
does not know who leads, and naming itself would be the claim the mechanism exists to stop making.

Fifty-eight cases pin the contract: `AC 47.1`–`47.10` the seam (inbound handler follows, optional
methods stay absent, a swap does not stop what it replaced), `AC 48.1`–`48.15` the watchdog
arithmetic on an injected clock (majorities 1–7, a stale answer, a learner's answer, a backwards
clock, a member list that repeats this node), `AC 49.1`–`49.9` the observer (a rejected send is not
contact, an outer layer that fabricates an answer is not contact, a throwing callback cannot fail a
completed RPC), `AC 50.1`–`50.9` the partition wrapper, `AC 51.1`–`51.7` the real cluster,
including the opt-out that reports `getQuorumHealth() === null` rather than a health report that
always says "fine".

**A port that was free for one caller.** The first full run after the seam and the watchdog was green;
the second failed three cases in `raft-multishard` with `EADDRINUSE 127.0.0.1:46315`, plus two on the
half-started cluster behind it. `getFreePort` asked the OS for a free port — bind, read, close — which
answers "free now": the next caller in the same process could be offered the same number. This
iteration added seven clusters to a suite that already had dozens, which is what finally opened the
window. Ports are now leased for the run (an atomically created file in a directory keyed by pid, with
the workers of a thread pool sharing it) and the allocation retries rather than trusting one answer;
the defect has its own case — fifty simultaneous allocations, fifty distinct ports (`AC 52.1`–`52.6`).

`preVote` is the one option that still cannot be honoured — raft-core pre-votes on every election
timeout and exposes no flag to skip it — and it is now honest about it: `preVote: false` warns, and
`getIgnoredSettings()` returns the setting with the reason, so a deployment can assert that its
configuration is fully in effect instead of trusting a field.

**A pause where the claim was a bound.** Fifteen fixed sleeps sat in the child-process suites, and
three of them were labelled "allow log catch-up" followed by an assertion on a node that had never
left the cluster: `AC 8.13`, `AC 8.14` and `AC 8.15` passed while the restarted node replayed
nothing. They are waits on the property in the title now — `pollUntil` for "this node applied N
entries", `awaitAgreement` for "these nodes name one leader" — and the file that carried twelve of
them went from 160 s to 12.4 s, because the pauses were 90 % of its wall clock. Reading the three
assertions rather than translating them also turned up a follower that cannot be recovered at all
after losing its disk: restarted on a wiped directory it reports `lastLog: 0` for 30 s and 596 polls
while the leader's own view of it stays frozen at `{next: 5, match: 4}`, and the same node restarted
on its own storage catches up in 1.7 s. That is filed as P3-24 with the trace, not papered over.

Only English prose is English, and now the build says so. "Comments and titles are English" had no
gate, and 321 lines across ten files had drifted — including every title in the W3C trace-context
suite. `pnpm check:english` reads comments and title strings, deliberately ignores CJK in data
literals (several suites feed multi-byte payloads through the code on purpose), reports the line
inside a block comment rather than its opener, and has ten tests of its own. It runs in
`Quality (lint + format)` beside the structural gate.

**A follower that lost its disk can rejoin.** Wiping a follower's storage left it at `lastLog: 0` for
30 s and 596 polls while the leader's view of it stayed frozen at `{next: 5, match: 4}`. The leader was
replicating to its healthy peer in the same interval, the transport counted 47 answers from the wiped
peer with no timeout, and splitting those by outcome showed **20 rejections** — the follower was
rejecting correctly and the leader was discarding the evidence. `LeaderState.setNextIndex` in
`@maboke123/raft-core` 0.2.1 clamps every backtrack to `matchIndex + 1`, and `matchIndex` is exactly
the belief a rejection disproves. One patch (`patches/@maboke123__raft-core@0.2.1.patch`, with the
argument beside the code and a `check-gates` rule that fails when it stops being applied) and the
wiped follower catches up in **2 s** with a single rejection. `AC 8.17` is the case; the per-peer
counters `sent / answered / accepted / rejected / timedOut / failed` are the instrument, now on
`getTransportStats()`.

**A member that only existed on paper.** The multi-process harness could not perform a membership
change at all — no command reached the library's `addServer` — so "a node joined" was a claim only the
in-process suite could make. Making it reachable found the reason nobody had missed it: the storage
adapter persisted `entry.command` and nothing else, so a CONFIG entry came back with `config:
undefined`, and raft-core's `validateLogEntry` rejected every AppendEntry carrying it. The follower
answered nothing, the leader timed out, and **no configuration change could replicate on any cluster**.
With the payload persisted, a fourth process joins a live three-node TLS cluster as a learner, holds
the log that existed before it joined, is promoted, and then carries quorum: with one of the original
voters killed, a majority of the four is three, and three entries commit that the newcomer has to
acknowledge. `AC 8.21` is the whole lifecycle; `AC 8.22` is a node nobody can reach, refused before an
entry exists and absent from the configuration afterwards (`addServer` waits for a socket, up to 3 s,
before it appends).

Quorum accounting on a shared transport is covered, and the entry that said it was not is the finding:
`AC 12.7` reads the health of all six adapters of a three-node, two-shard cluster over three
`NodeTransport`s with real mTLS (three voters, majority two, leader quorate), and `AC 12.8` isolates one
group's leader through the published seam — its `isLeader()` flips inside ten seconds while the _other_
group's leader keeps claiming leadership, and the group commits again after healing. Both passed against
unmodified source: those adapters declare their peers, so a watchdog was already built at `init()`. What
had no denominator is the narrower state the entry should have named — a node that declares **nothing** —
and it now takes the member set from `RaftConfig.quorumMembers` or, failing that, from the configuration
raft committed, which is the only list that is a fact.

**A membership change while a voter is missing — the entry, and what it got wrong.** P3-28 was
registered by reading `submitConfigChange`: the configuration is single-step, so the new voter set
governs the commit that admits it, and the entry concluded that a promotion with a voter down waits five
seconds and then reports `rejected`. Measured on five real processes over mTLS, the arithmetic says
otherwise — promoting a _reachable_ learner needs a majority of the **enlarged** set, and the learner is
one of its members, so one dead voter out of six leaves enough acknowledgements (`AC-C11`: seven voters
agreed in under a second). What cannot survive is losing the quorum the change would need, and that is
refused by name in about a millisecond rather than by timeout (`AC-C12`: `{ changed: false, reason:
'no-quorum' }`, nothing appended, every survivor still reporting the seven-voter configuration it
committed). The residue is named rather than hidden: an entry that does reach raft-core — in the window
between losing a majority and the watchdog noticing — stays in its in-memory active set, and that node
refuses further changes until it restarts; `getMembership()` is unaffected, because it reports what was
committed. `AC-C13` restarts one node and then commits a removal, so a refusal is measured as a refusal
and not as a wedge. The public contract in `cluster/docs/api-reference.md` asserted the old reading and
now states the measured one.

**A `require` that only the test runner had.** Three published features called the CommonJS `require`
from a package that ships as ESM. None of them failed to compile, and none of them failed a test: the
test transform supplies a `require`, so the suite exercised code that no consumer could run. In the
built artefact — loaded in a plain Node process, which is what `check-package` now does — the same
three lines behave as follows. `RaftGroupManager`'s write forwarding threw
`ReferenceError: require is not defined in ES module scope` on the first forwarded write.
`MerkleTree.computeRoot()` threw the same way, so the public anti-entropy digest could not hash
anything; it also appended its input twice in `build()`, which two replicas holding identical data
could never detect, because they were wrong identically. And `LoggingAdapter`'s trace context loaded
`node:async_hooks` inside a `try` whose `catch` was documented as a pre-Node-12 guard — the guard
caught the `ReferenceError`, so the fallback was the only branch production ever took and every log
line carried `traceId: undefined` while a test asserted correlation. Coverage had not noticed any of
it: `MerkleTree` lived in `src/interfaces/`, which the coverage configuration skips as
declaration-only.

The three are fixed at the root (a static `node:crypto` import, a static `node:async_hooks` import, and
`consensus/core/pgClient` using `createRequire(import.meta.url)`), the class is closed by a gate —
`pnpm check:esm-require` fails on a bare `require` in any package declaring `"type": "module"`, with
twelve tests of its own — and the artefact is now _called_ rather than merely imported: the E2E job
probes the Merkle root against a constant computed with `node:crypto`, a trace id across an `await`
boundary, and a CDC change arriving at a subscription sink exactly once — the first two of which
fail on the previous artefacts, and the third of which fails when the pump's wiring does. Those probes used to live inside `check-package`, whose own tests run in a job with
no `dist/` — the one part of a gate no test could reach; they are now `e2e/harness/published-probes.mjs`,
run in a child process against the package resolved _by name_, which is one step further than the
packaging gate goes. `AC 54.1`–`AC 54.8` and `AC 55.1`–`AC 55.7` are
the cases; the digest is asserted against an independent SHA-256, never against another call of the
class.

The same run turned up a test-harness defect worth recording, because it was the apology for the
product one: to make a CommonJS `require('pg')` resolvable from the test transform, the cluster suite
materialised a fake `pg` package at `node_modules/pg` in `setupFiles`. That runs once per worker
_thread_, so four threads truncated and rewrote the same two files, and a worker that required `pg`
inside that window got an empty module — `TypeError: Client is not a constructor`, three cases, CI run
44323059769, pointing at a file that was correct. Worse, `node_modules/pg` is a symlink into the pnpm
store, so the stub replaced the real `pg` for the whole workspace for the rest of the run. The fake is
now injected at the `pgClient` seam through the module graph, and nothing under `node_modules` is
written by a test run.

## The change stream had a simulator at one end and nothing at the other

Every claim this package makes about CDC — ordered delivery, a resumable
checkpoint, exactly-once _delivery_ on top of at-least-once transport — started
at `CDCEngine.appendChange()`, a method whose own comment said "test-only: in
production this would be triggered by WAL decoding". Four defects were behind
that sentence, and the first three were found by wiring the path to a real log
and watching what came out.

**The outbox was not a queue.** `fetchOldestPending` documented itself as
"FIFO" and its pending index was keyed `pending:entry:<seq>`. LMDB iterates keys
lexicographically, so a backlog of ten or more came back as 1, 10, 11, …, 19, 2,
20 — and the receiving datacenter applied `0/0000000A` before `0/00000002`. The
key is now zero-padded to sixteen digits, `pending:<seq>`, so key order and
sequence order are the same order; `AC 99.1`–`99.5` measure it, including the
specific pair a string sort gets wrong.

**The dedup key was a local counter.** `outbox.add({ id: msgId })` was discarded —
the store assigns `entry:<sequence>` and overwrites `id` — so the transport
shipped `entry:7` and the receiver deduplicated on a per-outbox sequence. Two
datacenters whose outboxes both started at `entry:1` deduplicated _each other_,
dropping one region's first change; a change replayed after a restart got a new
sequence and was applied twice. The message id travels as `msgId` now, which the
store already indexed for exactly this purpose, and `AC 98.7` runs two senders
into one receiver to prove the collision is gone.

**The checkpoint advanced to the word "entry".** The pump derived the position
with `entry.id.split(':')[0]`, which is `"entry"` for every entry. `markDelivered`
kept the outbox honest, so nothing looked wrong — but the resume point a restart
depends on was a constant string that compared equal to itself for ever. The
position comes from the event's own `lsn` now, and `AC-C18` kills a relay
mid-stream, verifies the checkpoint names the writer's last LSN, restarts it and
checks that all fifty changes are applied exactly once.

**Four hundred lines of the pipeline could not be reached at all.**
`this.cdc = new CDCEngine(...)` was hardcoded, so `ExactlyOnceCDCPipeline` — the
one class whose job is to carry a real change stream — could only ever be fed by
the simulator. It takes an `engine` now; `appendChange()` refuses by name when
the engine is a read end, and `AC 98.1` drives the whole path from a file another
process wrote.

The read end itself is `IChangeLogReader` (two methods), with `FileChangeLog` as
a reference implementation — a JSON-lines log whose appends resolve only after
`fsync`, whose writer truncates a torn tail and refuses to reuse a position, and
whose reader refuses a shrunken file, a non-JSON line and an LSN that does not
advance, each by name with a byte offset. `WalTailCDCEngine` polls it, moves one
cursor, filters by watch set and stamps an HLC anchored to the writer's commit
time; `AC 93.1`–`93.21` and `94.1`–`94.11` are the cases. The write end is
`HttpCDCSink`, which is the first sink in this package whose delivery crosses a
socket: `AC 95.1`–`95.15` cover batching, status handling, timeouts, keep-alive,
mid-response disconnects and the two counter defects the tests found — a 50 kB
error page produced an _empty_ excerpt, and a timeout was not counted as a
refusal at all.

What makes the path measurable end to end is that the counters now have an
identity and an exposition: `accepted = delivered + failed + dropped + Σ pending`
for the pump (the queue is the ledger — the head stays in it until its outcome is
known, so there is no in-flight bucket to double-count), and
`produced = pending + sent + deadLettered` over the outbox for the pipeline.
`pumpConservation` and `pipelineConservation` state them, `renderPumpMetrics` and
`renderPipelineMetrics` publish them, and a projection that throws is now counted
as `projectionFailed` rather than as a delivery failure — the old counting broke
the identity by exactly the number of projection errors.

The measurement is a run of three processes: `change-writer.mjs` fsyncs records
into a log, `cdc-relay.mjs` tails it and ships each change over TLS 1.3 with
mutual certificate verification _and_ delivers the same change to
`cdc-sink-server.mjs` over HTTP, and the receiving relay deduplicates and appends
what it accepted to a file. `AC-C15`–`C19` assert on those files, not on
counters: fifty changes, each once, in order; a `503` retried rather than
dropped; the ledger balanced in the process that ran; the exposition parsing as
Prometheus text and agreeing with the same process's counters.

## The coverage gate read a file the package average had been hiding

`ExactlyOnceCDCPipeline.ts` came out of iteration 59 at 88.97 % branches — the
package reported 97.97 % and passed, the per-file row did not — and every one of
the fifteen uncovered arms was a decision this file makes twice:

- `err instanceof Error ? err.message : String(err)` appeared at four call sites.
  Three of them could only ever see an `Error`, because the only throw they could
  observe was `JSON.parse`'s `SyntaxError`, so the `String(err)` arm was
  unreachable in three places and untested in the fourth. It is `describeError()`
  now, and the transport port is what proves the arm: a transport that rejects
  with a string is a configuration this package accepts.
- `entry.msgId ?? entry.id` appeared at three call sites and once inside `lsnOf`.
  The fallback is reachable only through the outbox — an entry stored by a
  producer that set no message id — so three of the four copies were untested.
  It is `messageIdOf()` now, and `AC 99.6` pumps an entry a real `OutboxStore`
  stored without one.
- The checkpoint was validated twice: `loadCheckpoint()` refused a file that is
  not JSON with a message naming the consequence, `readCheckpoint()` let
  `JSON.parse`'s own `SyntaxError` out and was the only one that sanitised a
  checkpoint whose `updatedAt`/`version` are not numbers. Two copies of "may I
  start?" is two answers, so both doors walk through `parseCheckpoint()` now, and
  the public one — the one a deployment calls before it builds an engine — is
  where the four refusals are asserted (`AC 99.1`–`99.3`).

Writing them found one more defect, of the kind the arms were hiding: `stop()`
flushed the working checkpoint unconditionally, and a pipeline whose `start()`
was refused on an unreadable checkpoint never loaded one — so cleaning up after
the refusal wrote `{ "lastConfirmedLSN": {} }` over the file that caused it. That
is the replay-from-the-beginning decision the class refuses to make at start,
taken through the back door by the caller who caught the refusal. `stop()` now
flushes only what `loadCheckpoint()` actually read (`AC 99.4`), and the case
asserts the directory is still a directory afterwards.

## The operations layer had no process that could die

`cluster` and `federation` have been measured by processes since Phase 3: a node
that is killed is really gone, and every byte between peers crosses a mutual-TLS
socket. The operations packages were measured in-process only. `FileAuditStore`'s
`dataDir` pinning had one child-process case (`AC 92`), but nothing wrote a trail
in one process, died without warning, and asked a _second_ process what it could
still read — which is the only question a durability recipe answers, because
`close()` runs the code a crash skips.

`AC-O1`–`O3` ask it. `audit-writer.mjs` appends entries and acknowledges each one
only after the store synced it; the suite takes twenty acknowledgements, sends
`SIGKILL`, and `audit-reader.mjs` — a process that never saw the writer — reports
every acknowledged id exactly once and in order. `AC-O2` runs the same shape with
4 KiB segments and 1 KiB entries so rotation and its compression happen under
load, waits for the archive to exist, then kills the writer and asserts the
archived segment is still readable from the other process. `AC-O3` plants the
artefact a kill during compression leaves behind — a five-byte `.ndjson.gz.part`
— and asserts the next process to open the directory sweeps it without losing a
segment.

Three cases, and the honest limit is stated rather than implied: what a kill can
show is that acknowledged entries are _readable_ afterwards, not that they
reached the medium; the `fsync` order that decides the second question is
`DurableFileSystem`'s, and `P2-19`/`DW.1` are where that is observed.

The same exercise made a larger gap unavoidable, and it is registered as `P3-52`
rather than fixed here: `InMemoryBackupManager.createBackup()` never touches the
`IStorageBackend` it is constructed with. It sets `sizeBytes: 1024` and
`state: 'completed'` after a five-millisecond sleep, `restoreFromSnapshot()`
answers `{ success: true }` without downloading anything, and `pitr()` answers
success for a recovery point it invented. A real-process restore probe over that
manager would be a test of a simulator.
