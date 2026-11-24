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

## 3. Node, cluster and federation (`@agentix-e/db-*`)

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
`node/src/<module>/`, and they are still twenty entry points —
`@agentix-e/db-node/audit`, `…/core`, `…/slacollector` — because a module is a
directory, not a package. Twenty npm names for code that cannot be misused without a topology
would have been twenty version numbers and twenty release notes describing one decision.
`node/src/index.ts` is the whole list: twenty namespace re-exports under a header that
states the property deciding placement, so a module that starts asking about the other nodes is a
module that has to move, rather than one that quietly grows a dependency on a group.

`core` is why the old shape could not hold. Forty-six of the former packages imported it, so a
change to a base type was a change to a published dependency graph. The imports are relative now;
the nine edges between former packages that disappeared took their version constraints with them.
`node` publishes 375 exports across its twenty-two entry points, and every one is named somewhere
under `node/docs/`.

| Module           | Capability                                                           | Verification  |
| ---------------- | -------------------------------------------------------------------- | ------------- |
| `core`           | Base types, provider registry, error hierarchy                       | U · I         |
| `health`         | Liveness/readiness orchestration, dependency graph                   | U · I         |
| `logger`         | Structured logging, levels, child loggers, backends                  | U · I         |
| `metrics`        | Counters, gauges, histograms, sink fan-out                           | U · I         |
| `monitor`        | Alert rules, thresholds, de-duplication                              | U · I         |
| `backup`         | Capture, digests, bucket confirmation, durable inventory, PITR       | U · I · M · P |
| `maintenance`    | Maintenance windows, occurrence projection                           | U · I · M     |
| `auth`           | Authentication providers and credentials (interfaces only)           | U · I         |
| `security`       | Key rotation, envelope encryption, tamper-evident audit chain        | U · I · M     |
| `audit`          | Append-only storage, per-writer hash chain, verify, read/write ports | U · I · M · P |
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

Every one of the twenty modules ships a `docs/` tree — at `node/docs/<module>/` — and since iteration 54 that is enforced rather than observed: ten of them shipped none and
were skipped by the documentation gate, because the loop read a package's documents to decide
whether it had any. `pnpm check:docs-api` now reads 34 entry points across 3 packages, requires
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
All four rows are from CI run `45159857370`, the run that accepted iteration 76: `node`
(99.49/98.67/99.87/99.49 over 157 files), `cluster` with the assemblers in it
(99.46/98.33/99.72/99.46 over 65) and `federation` with the query and schema modules it absorbed
(99.64/98.58/100/99.64 over 38). The iteration measured `node` locally first — 99.49/98.67/99.87/99.49
over 3 174 cases — because a change to twenty lines of loop-shaped code has to be measured on the tree
it ships, and the CI run restated the row rather than correcting it. The gate covers four packages, not three: the end-to-end harness is
measured as well (100/97.22/100/100), because a harness bug produces confident, meaningless
acceptance passes. That last row read 100 % on all four dimensions when this page was first
written, then 99.44 / 96.47 while the harness carried the fatal-error path nothing read; it reads
100 / 97.22 now that the two refusal paths are tested. The number moves because the harness gains
code, and the row is reported as measured rather than as remembered.

| Package         | Statements | Branches | Functions | Lines  |
| --------------- | ---------- | -------- | --------- | ------ |
| `cluster`       | 99.46%     | 98.33%   | 99.72%    | 99.46% |
| `federation`    | 99.64%     | 98.58%   | 100%      | 99.64% |
| `node`          | 99.49%     | 98.67%   | 99.87%    | 99.49% |
| `e2e` (harness) | 100%       | 97.22%   | 100%      | 100%   |

The rows are in the order the tool prints them — statements, branches, functions, lines. The first
two columns had been labelled the other way round since this table was written, which is how a
swapped pair can sit in a page for six iterations: both numbers were plausible, and neither label had
a compiler until a run was read against the raw `coverage-summary.json` (`e2e`: 99.44 statements,
96.47 branches, 100 functions, 99.44 lines).

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
failed under `tsc` (`noUncheckedIndexedAccess` on a `Buffer` index). CI's `Typecheck (node)` job
was the only gate that saw it, and it saw it on the first push. For a long time that meant the
test trees were the only unverified code in the repository — and they drifted. When
`pnpm typecheck:tests` was finally wired up it reported **1 192 errors in three test trees**
(cluster 297, federation 317, node 578), and a large share of them were not cosmetic:

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
(including `noUncheckedIndexedAccess`, which the node test config used to switch off).
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
   package and was read by nothing. `node/docs/getting-started.md` told readers to
   `import { HealthOrchestrator, ComponentProbe }` from a package that exports `componentProbe`;
   another snippet imported `IBackupManager` from `core` and a `BackupType` that exists nowhere,
   and returned `{ snapshotId, type, state }` where `BackupResult` is `{ success, snapshot }`.
   The heading rule cannot see any of it, because a fenced block has no headings. The user guide
   had five more: `Counter` and `Histogram` from `metrics`, which exports `ICounter`/`IHistogram`
   and creates them through `registry.counter()`; `BackupManager`, which the guide
   described as `InMemoryBackupManager` and as taking two collaborators positionally (it takes
   three — a source, a bucket and a policy — and the class itself was replaced in iteration 63);
   and `report.passed`, where the field is `valid`. A guide that cannot compile is worse than no
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

| Area                                                     | Status                           | Why it matters to you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Per-file coverage floor**                              | Gated (from iteration 25)        | The gate enforces the package total and every individual file; a single file below 95 % fails the build. The entry here used to say "partially gated… around a dozen files sit below 95 %" — that described an older gate and had been false since the per-file check was added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Federation cross-DC fault injection at the TLS layer** | Covered (iteration 24)           | `chaos/tls-fault-injection.test.ts` drives a real listener with real certificates: an untrusted CA is refused, a peer that stops is noticed within a bounded time, a peer that resets is reported, a peer that accepts but never reads cannot hang `send()`, and twenty reconnects leave no timer behind (AC 43.1–43.11). **Not** covered: an active proxy in the middle of an established stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Node process-level acceptance**                        | Partially covered (iteration 35) | The audit write path is now killed for real: `AC81` starts a second process, waits for 120 acknowledgements, sends `SIGKILL`, and every acknowledged entry is readable afterwards; two processes appending to one trail lose nothing (`OS.1`). **Not** covered: a **power cut** — `SIGKILL` leaves the page cache intact, so it proves the line is in the file and cannot prove it reached the medium. The `fsync` half is asserted by order and by failure propagation in-process (`AC80`), and that limit is stated in the user guide rather than implied. Batching did not widen that gap: a burst of concurrent writes is acknowledged by **one** sync, and `GC.8` pins the case with one caller at a time to the same one-sync-per-write it always paid, so the throughput gain is concurrency and not a weaker promise. No other node module has an out-of-process case yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Mutation testing over the rest of node**               | Partially covered                | All three packages are gated by Stryker in CI — `node` **97.96 %**, `cluster` **93.76 %**, `federation` **94.59 %** — with the break thresholds at 86, 86 and 70; `node` and `federation` are CI run 45159857370's figures, and `cluster` is iteration 77's local run of the tree it ships (1 691 judged: 1 575 killed, **3 timeout**, 101 survived, 4 with no coverage). The `node` figure is also iteration 76's local run of the same tree (4 152 judged: 3 994 killed, 1 timeout, 79 survived, 4 with no coverage), which agrees to the second decimal because the score is decided by mutants and only the abort set moves between machines — CI reports 2 timeouts there where this machine reports 1, and a timeout counts as detected. The `cluster` figure is 2 points below the 95.78 % this table carried from 44962687038, and the difference is the instrument rather than the code twice over: iteration 75 changed which cluster tests run — which changes what each mutant is judged against — and iteration 77 stopped counting seventeen abandoned runs as detections (P3-75). Its timeouts fell 17 → 3 for a score that rose 0.38 points, because the twelve verdicts that left the abort column arrived in the kill column. The percentage is lower than the 98.15 % this table carried for three iterations, and that is the finding rather than a regression: forty-one of the verdicts behind the old number were abandoned runs, and iteration 76 removed the loops that produced them instead of counting them (see _An edit that cannot be interrupted is not a detection_). The population has moved twice without the percentage moving with it: 3 753 judged at 98.03 %, 4 060 at 98.15 % after iteration 66 added two audit files and a prune, 4 113 at 98.15 % after iteration 67 added a chain walk — so the figure is only a comparison when the denominator travels beside it. What the flat score hides is where the mutants went: `backupChain.ts` measured 100.00 % over 76 mutants after iteration 67, and measures **97.18 %** over 71 now, because `resolveChain`'s `for (;;)` became a walk bounded by the inventory and the bound's own refusal is a line no correct walk reaches — the one `NoCoverage` in that file is that line, and it is the answer a stopped walk deserves. In `node` seventeen files across four of the twenty _modules_ are mutated — `backup`, `audit`, `security` and `maintenance` — chosen by the selection rule _mutate what decides deletion, durability, or when work runs_; the other sixteen modules have unit, integration and coverage gates but no mutant measures their assertions. The `cluster` package contributes four more — `quorum.ts`, `ClusterScalingExecutor`, `ClusterRolloutPlanner`, `RaftFaultTranslator` — because a scale-down that removes one node too many and a partition that emits one direction are failures a green suite can be green about. In the `cluster` and `federation` _engines_ one module each is mutated — the SQLite log and the TLS wire — because those are the two places a green suite can be green for the wrong reason. The rule is published in the roadmap (P2-14), so the next module is a decision rather than a preference. Iteration 52 hand-checked `CDCSubscriptionPump` against five mutations — the queue cap, the retry budget, the operation filter, the table filter, and the post-close accounting — and every one of them failed at least one named case, so it is the next entry in that queue. Iteration 53 did the same to `CDCFailureInjector`: a global instead of a per-entry budget (two cases), no duplicate-entry check, no injection-point filter, a swallowed disconnect, and a budget spent by a fault that could not fire — five edits, five named failures. |
| **TLA+ model checking**                                  | Manual                           | The specs exist and run locally; they are not part of CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Dependency advisories**                                | Covered                          | `pnpm audit:policy` holds the _production_ tree to zero high and critical advisories with no allowlist that can reach it, and requires a named, dated entry for anything in the dev tree — the test toolchain, which cannot always be fixed on the day an advisory lands because a transitive dependency may have no patched release. An entry that matches no advisory fails the gate, so the list cannot rot into an exemption nobody re-read; the two failure modes were checked by removing the entry and by adding a bogus one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
pnpm check:legacy-names                              # the 2.0 migration page matches the exports
pnpm test:scripts && pnpm check:script-coverage      # the gates' own tests, and their coverage
pnpm typecheck && pnpm typecheck:tests               # static gates, production and tests
pnpm lint && pnpm format:check                       # the packages' sources
pnpm format:check:repo                               # everything no package owns: scripts, workflows, root pages
pnpm check:package                                   # every published entry loads, and its probe runs (needs pnpm build)
pnpm audit:policy                                    # production tree to zero, dev exceptions dated
(cd cluster && pnpm coverage)                        # unit + integration + conformance
(cd federation && pnpm coverage)
(cd node && pnpm coverage)
pnpm coverage:e2e                                    # e2e harness, same 95 % thresholds
pnpm coverage:gate                                   # all four packages, every dimension
pnpm check:test-counts                               # the numbers on the README are this run's numbers
pnpm e2e                                             # 85 real-process acceptance tests (TLS, HTTP, SIGKILL)
pnpm test:mutation                                   # mutation score, all three packages
pnpm check:mutation-timeouts                         # every Timeout in those reports has been read
(cd cluster && pnpm test:perf)                       # 22 benchmarks on a real 3-node TLS cluster
pnpm verify                                          # all of the above, in order
```

A `Timeout` verdict has to be read, and reading one means replaying it: there is no score that answers
"did a test object" for a run that stopped. The replay is
`node scripts/resolve-timeouts.mjs --target <name> --record`, which applies each edit to the
real tree, runs the tests the report attributed to it, and writes `mutation/timeouts.json`. It takes
about half a minute per abort, so CI runs the millisecond check (`pnpm check:mutation-timeouts`) instead
and fails when a report and that file disagree in either direction.

The benchmark suite runs on GitHub runners from `.github/workflows/benchmark.yml`; results
are attached to each run so a regression is visible next to the change that caused it. The
same suite runs on every pull request as the `benchmark` job in `ci.yml`, because a benchmark
nobody calls is a benchmark that stays broken.

**How the mutation score is produced.** Twenty-two files are under mutation testing, chosen by one
rule — _mutate what decides deletion, durability, or when work runs_: durable state
(`cluster/.../SqliteStorage.ts`), the wire (`federation/.../TcpSecureTransport.ts`), what gets
deleted (`node/.../RetentionPolicyEvaluator.ts`, `node/.../FileAuditStore.ts`), what a
durable write costs (`node/.../DurableFileSystem.ts`), whether
a backup can be replayed at all (`node/.../backupChain.ts`,
`node/.../BackupManager.ts`), which key material survives at all
(`node/.../KeyManager.ts`), which key material survives a rotation
(`node/.../KeyRotationManager.ts`), which key a blob was sealed with
(`node/.../EnvelopeEncryptionProvider.ts`), what a cipher does when it is initialised twice
(`node/.../AES256GCMEncryptionProvider.ts`), when a window runs
(`node/.../MaintenanceWindowScheduler.ts`), what time it runs at
(`node/.../cron.ts`), whether a compliance window passed
(`node/.../RotationAuditor.ts`) and whether evidence is tamper-evident
(`node/.../AuditLogManager.ts`). The four assemblers the split introduced are mutated for a
different reason: `.../cluster/membership/quorum.ts` decides what a majority is, and
`.../scaling/ClusterScalingExecutor.ts`, `.../rollout/ClusterRolloutPlanner.ts` and
`.../chaos/RaftFaultTranslator.ts` decide which member leaves, which batch runs, and which
transport is told to drop traffic. A mutant there does not produce a wrong number on a graph; it
produces a group that has lost quorum, or a partition that exists on one side only. Stryker alters
the source one change at a
time and runs the tests that cover the change; a change no test notices is a behaviour nothing
constrains. Which edit Stryker made is recorded in `reports/mutation/node.json`, and
`scripts/replay-mutant.mjs` applies it by that record — a line number is not enough, and
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
target's `break` threshold is missing, when a `mutate` glob matches no file, when any package runs
Stryker directly instead of delegating to the root, or when a `vitest run` filter names a directory
that is not there — the last one because that filter is the single path a script can name with no file
extension, which is the one shape the path rule beside it could not see. CI runs the three targets as
`pnpm run test:mutation:<target>` and then asserts that `git status --porcelain` is empty — an
in-place edit that leaked out of a sandbox would otherwise be committed by the next person.

| Package    | Module                           | Mutants |            Killed |                        Survived |       Score | Threshold |
| ---------- | -------------------------------- | ------: | ----------------: | ------------------------------: | ----------: | --------: |
| cluster    | `SqliteStorage.ts`               |     507 |               476 | 29 (+1 ignored, 1 runner error) | **94.26 %** |  break 70 |
| federation | `TcpSecureTransport.ts`          |     271 |  254 (+1 timeout) |                              16 | **94.10 %** |  break 70 |
| cluster    | `ClusterRolloutPlanner.ts`       |     134 |  119 (+7 timeout) |                               8 | **94.03 %** |  break 86 |
| node       | `KeyManager.ts`                  |     139 |  125 (+3 timeout) |              7 (+1 no coverage) | **94.12 %** |  break 86 |
| node       | `AuditLogManager.ts`             |     343 |  323 (+2 timeout) |             10 (+2 no coverage) | **96.44 %** |  break 86 |
| node       | `FileAuditStore.ts`              |     704 |  663 (+8 timeout) |            22 (+1 runner error) | **96.83 %** |  break 86 |
| node       | `RotationAuditor.ts`             |     286 |               275 |                               7 | **97.52 %** |  break 86 |
| node       | `AES256GCMEncryptionProvider.ts` |      81 |                79 |                               2 | **97.53 %** |  break 86 |
| node       | `EnvelopeEncryptionProvider.ts`  |     111 |               108 |                               2 | **98.18 %** |  break 86 |
| node       | `InMemoryBackupManager.ts`       |      95 |                93 |                               1 | **98.94 %** |  break 86 |
| node       | `MaintenanceWindowScheduler.ts`  |     622 | 602 (+13 timeout) |                               6 | **99.03 %** |  break 86 |
| node       | `KeyRotationManager.ts`          |     239 |               236 |                               2 | **99.16 %** |  break 86 |
| node       | `DurableFileSystem.ts`           |      74 |                73 |                               0 |   **100 %** |  break 86 |
| node       | `RetentionPolicyEvaluator.ts`    |     196 |  172 (+2 timeout) |                               0 |   **100 %** |  break 86 |
| cluster    | `RaftFaultTranslator.ts`         |     245 |               245 |                               0 |   **100 %** |  break 86 |
| cluster    | `quorum.ts`                      |      29 |                29 |                               0 |   **100 %** |  break 86 |
| cluster    | `ClusterScalingExecutor.ts`      |     162 |  161 (+1 timeout) |                               0 |   **100 %** |  break 86 |
| node       | `backupChain.ts`                 |      66 |   59 (+7 timeout) |                               0 |   **100 %** |  break 86 |
| node       | `cron.ts`                        |      87 |   82 (+5 timeout) |                               0 |   **100 %** |  break 86 |

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
wrong is the point.** The tool used to verify them, `scripts/replay-mutant.mjs`, resolved
its default report path against the working directory — so, started from the package where it lived,
it opened a 2.6 MB in-place report left over from that morning, found fourteen survivors in it, and
reported them killed; four of those "kills" were runs that never finished. The tool now resolves the
report and every path inside it against the repository root, refuses a report older than the file it
describes, and restores the mtime so its own second replay is not blocked by the first.

### The timeout column

A `Timeout` is not a verdict: it says the runner stopped, not that a test objected. Stryker records two
different things under that status, and there are 52 of them across the three targets — every one read
by replaying the edit against the tests the report attributed to it, and re-read after the split moved
every path:

| What the runner did                                           | node | cluster | federation | What it means                                                                                                                                                                 |
| ------------------------------------------------------------- | ---: | ------: | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hit-limit abort (`statusReason: Hit limit reached (n/100×m)`) |   33 |       8 |          1 | the vitest runner counts how often a mutant executes and abandons the run at a hundred times the original's count — a _guess_ at non-termination made from an execution count |
| Wall-clock timeout                                            |   10 |       0 |          0 | `timeoutFactor × netTime + 30 s` elapsed                                                                                                                                      |

| What the suite said when it was asked again        |  node | cluster | federation |
| -------------------------------------------------- | ----: | ------: | ---------: |
| `failed` — vitest reported a failing test          |     7 |       0 |          0 |
| `stuck` — nothing reported, the run never finished |    36 |       8 |          1 |
| `survived` — the suite passed it                   | **0** |   **0** |      **0** |

The third row is the one that mattered. Had any of them passed, the score would have counted a mutant
no test noticed, and the score would have been wrong by that much. None did: every abort is either a
test the suite fails or an edit that cannot terminate — JavaScript cannot interrupt a synchronous
`while (true)`, so "the run did not finish" is the strongest honest record, and
`mutation/timeouts.json` holds the run that produced it, with the child's last three lines as evidence.

**The budgets were the other half of the question.** All three mutation configs inherited their
`testTimeout` from the unit suite — 60 s for the node package, 180 s for the other two — and Stryker abandons
a mutant at about 31 s, so no test timeout could ever fire. The values are now derived from each
target's own measurement, four times its slowest case, rounded up to the next second and kept below the
runner's cap:

| Target     | Slowest case |                                          Where it comes from | Budget |
| ---------- | -----------: | -----------------------------------------------------------: | -----: |
| cluster    |     2 120 ms |                             `SqliteStorage.handle-lifecycle` |    9 s |
| federation |     2 479 ms |   `chaos/tls-fault-injection` (a delay, injected on purpose) |   10 s |
| node       |     3 665 ms | `AC75-work-factor` (scrypt at four work factors, on purpose) |   15 s |

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

The node score is higher than the other two because the mutated surface is pure decision
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
| `FileAuditStore`                                                          | `isUnlinkRefusal(error)` → `true`                                                                                                                       | no runner can make `unlink` fail for a reason outside the four listed codes — a process running as root is never refused — and the rule itself is asserted by `DW.12`, which is why it is a predicate rather than a list inside a `catch`                                                                                                                                                                                                                                                                            |
| `FileAuditStore`                                                          | `rmSync(gzPath, { force: false })`                                                                                                                      | detected as a **crash**, not as a failing test: without `force` the cleanup rejects inside a `catch` whose promise nothing awaits, and the runner dies with it — which is the unhandled rejection the flag prevents                                                                                                                                                                                                                                                                                                  |
| `FileAuditStore`                                                          | `'at-rest'` → `''` on the reconciliation's call to `repairFor`                                                                                          | the function asks `when === 'live'`, so every value that is not `'live'` takes the at-rest path — the parameter is a union of two names for readability, and the distinction it encodes is one predicate                                                                                                                                                                                                                                                                                                             |
| `FileAuditStore`                                                          | `else if (repair === 'promote')` → `else if (true)` in the sweep                                                                                        | the only verdicts that reach that branch are `none`, `release` and `promote`, and a pair with no plain file cannot exist: `shadowedPairs` yields a name only if that name is in the listing. The one `none` a runner can produce needs a file it can see but not read, which a process running as the owner never meets                                                                                                                                                                                              |
| `FileAuditStore`                                                          | `if (repair === 'promote')` → `if (true)` in the live path                                                                                              | as above: with an archive present, `none` and `plain-unreadable` are the only other verdicts, and the second one is unreachable without a file the runner cannot read                                                                                                                                                                                                                                                                                                                                                |
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

The instrument that prevents a repeat is `scripts/replay-mutant.mjs`. It reads the
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

Iteration 65 re-read the file, and it reversed half of that decision. The `null` sentinel came back,
not because the dead branch was worth having but because deleting it had removed the only way to say
"this segment could not be read": with the collapse into `''`, a trail whose only segment was a
truncated archive verified as `ok: true, entries: 0` — an attestation of evidence the store never saw,
produced by the method whose only job is to attest. `readSegment` returns `string | null` again,
`verify()` counts the nulls and answers `ok: false, unreadable: true`, and `query()` still serves every
segment it can get, because an incident report must not be refused. The same read found the second half
of the same seam: `readView` — the comparison the sweep and the live path make between a segment and its
archive — read through `readSegmentFromDisk` directly and ignored the configured reader, so a deployment
that wrapped the port was silently given a second, unwrapped one. It takes the reader now, which is also
what let the guard in front of it be measured instead of argued.

The file measures **97.27 %** — 749 of 770 judged — with 21 survivors and none uncovered, from 93.94 %
with 38 and 7. Those 21 are named at the top of `FileAuditStore.survivors.test.ts`, ten of them with a
case that asserts the property making the mutant invisible and eleven with the reason no case can exist.

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
socket. The node modules were measured in-process only. `FileAuditStore`'s
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

## A budget measured on a clock the test could not spend

CI run `44999465716` came back red in three jobs, and none of the three was the
code the run was about. That is the shape worth writing down: a suite that fails
where nothing changed is a suite whose failures have to be read one at a time,
because two of them were the tests and one was the harness.

**`BM.26` measured the wrong step.** The case is about an upload that outlives
its budget: capture is immediate, the bucket sleeps 40 ms, the budget is 1 ms.
`createBackup` checked the deadline twice — once after the capture, once after the
upload — against `Date.now()`. On a loaded runner the capture of one small file
took longer than a millisecond, so the _capture_ branch fired and the case failed
with `the capture took longer than 1 ms` while asserting on the upload. The budget
now comes from `this.clock()`, the same clock the manager stamps `createdAt` with,
and `BM.10`/`BM.26` move that clock from inside the step under test. A budget is a
comparison; a comparison a test cannot move is a measurement of the machine.

**A removal that raced a compressor.** `FileAuditStore.degradation` deletes the
audit directory between scheduling a compression and calling `close()`, to assert
that a compressor whose source vanished cannot reject. The compressor's
`open(…, 'wx')` runs on a libuv thread, so it can recreate a file between the
`rmSync`'s `unlink` and its `rmdir` — `ENOTEMPTY`, an error about the removal
standing in for the case about the compressor. The removal now retries
(`maxRetries`), and the assertion is unchanged: what the case is about is a
directory that is gone.

**A port the kernel was still handing out.** The cross-cluster job failed with
`EADDRINUSE: 127.0.0.1:38473` — 38473 is inside Linux's ephemeral range
(32768–60999). The harness asked the kernel for port 0, read the number, closed
the socket, and handed that number to a child that binds _later_; between the two
any outbound connection on the runner may take it. `cluster` solved this for
itself with a per-run lease (`AC 52.1`–`52.6`); the e2e harness now draws from its
own window instead of the ephemeral pool: `PORT_BASE = 20000`, one 2000-port
window per vitest worker, eight ports reserved per allocation, each probed before
it is handed over. Two workers cannot overlap by construction, and no port the
kernel hands out on its own is in the range. The window is arithmetic rather than
an acceptance criterion, so what the harness contract asserts is the arithmetic
(six allocations, six distinct ports, all below 32768) and the probe it rests on
(a port another socket holds is `busy`, and `free` once it is released).

**The one that is still unexplained.** The `Coverage (e2e harness)` job failed
`AC-C15` on ordering — the peer applied `0/00000004` before `0/00000003`. The
same suite passed on the next push and in three local runs, and the pump is
sequential: it awaits each `send`, refuses at the head, and `pendingKey` is
zero-padded precisely so the queue cannot be reordered. So the claim was split
into the two it always was — the writer now reports every position it appends,
the case asserts the log's order first and the reader's agreement with it second.
A failure now says which side moved. Until one recurs, the mechanism is
registered as `P3-68` rather than declared absent.

## A delivery nobody confirmed

`docs/api-reference.md` carried two limits under `ExactlyOnceCDCPipeline`,
written down because a deployment plans around them rather than discovering them:
an accepted frame is not an applied frame, and a refused send costs one retry out
of three. Both were this iteration's work, and both were the same kind of defect —
a number that meant something other than what its name said.

**`send()` answers a question about this process.** It resolves `true` when the
bytes reached a socket. A TCP write into a connection whose peer has gone is
accepted by the local kernel, so the sender learned "enqueued" while the receiver
learned nothing. An acceptance run measured it precisely: twenty changes reported
delivered, thirteen applied, `refusals: 0`, `deadLetterCount: 0`. The outbox was
perfectly consistent about a delivery that had not happened, which is worse than
inconsistent — there was nothing to see.

The instrument that can close that gap is the peer, because the peer is the party
the claim was about. `ExactlyOnceCDCPipeline` now sends a `cdc_ack` frame back and
waits for it, matched by message id:

| The peer's answer                      | What the pump does                                     |
| -------------------------------------- | ------------------------------------------------------ |
| applied                                | `markDelivered`, advance the checkpoint                |
| refused — `{ok:false, error}`          | `markFailed` at once, the peer's reason in `lastError` |
| silent past `ackTimeoutMs`             | `markFailed`; the entry stays pending                  |
| nothing — the pipeline stopped waiting | nothing; the entry keeps its place, no attempt charged |

Three decisions were not obvious and are worth stating:

1. **`processInbound()` does not ack.** An ack means _applied_, and applying is the
   caller's next line. A pipeline that confirmed inside `processInbound` would turn
   a crash between the callback and the caller's write into a silent lost change —
   the same defect, one layer up, where it is harder to see. The caller calls
   `acknowledge()` after its own durable write, and answers duplicates too, because
   a duplicate was applied the first time and the sender has to be allowed to stop.
2. **The wait is registered before the send.** An in-process transport delivers the
   answer inside the same tick, so a registration after `await send()` misses it —
   and a missed ack is a timeout, a failed attempt and a re-send of a change the
   peer had already applied.
3. **A cycle ends at the first entry the peer did not confirm.** The entries behind
   it were sent and probably applied, and marking them delivered would let the
   checkpoint move past an entry still owed. They stay pending; the retry is
   deduplicated and answered again. A duplicate is recoverable, a gap is not.

**Three attempts is sixty milliseconds.** `OutboxStore` dead-lettered an entry after
`maxRetries` failures, default 3, and the pump retries the head of the queue once per
cycle — 20 ms by default. A peer that was restarting came back to a dead-letter
queue, and an acceptance run lost nine changes to a one-second outage. A count
cannot know how much time it represents, so the budget is a window now, measured
from the _first_ failure (an entry that waited a minute behind a busy peer has not
spent that minute failing), with exponential backoff inside it (50 ms doubling to a
2 s ceiling) because a hot loop is not a retry policy either. `maxRetries` survives
as an optional hard cap and loses its default.

**The instrument was checked against the defect.** `e2e` `AC-C23` holds the receiving
relay at `applyLimit` — thirteen of twenty frames are dropped **before** the dedup
ring, which is exactly what "accepted here, never arrived there" looks like from the
far end — and asserts that the sender's delivered count equals the receiver's applied
count. With the pump reverted to `acknowledgement: 'none'` the case fails in 660 ms
with `expected 20 to be 13`: the defect's own numbers, named by an assertion rather
than by a timeout. `AC-C24` releases the receiver and checks all twenty are applied
once, in write order, with the sender's count catching up to the receiver's.

**What the change broke, and why that was the change working.** Three `e2e` cases
compared the tail's read position with the checkpoint, and one compared the outbox's
pending count with the applied file, at moments when the two were no longer the same
number: the tail legitimately reads ahead of the confirmed position by the in-flight
window, and the receiver applies before it confirms. Those waits were rewritten to
wait for the confirmation — the assertion that survived is stronger, because
"delivered" and "applied" are now two processes' answers to the same question rather
than one process's answer to itself.

**A refusal has to say which refusal it is.** The acknowledgement work turned an
old ambiguity into a defect: `processInbound()` answered `accepted: false` for both
a duplicate and a payload that will never decode, and a caller that confirms
duplicates — the correct thing to do for a real one — would then tell the sender a
change had landed that never did. The reason is now part of the answer, the ring
is the record of what has been _applied_ (so an undecodable frame is removed from
it, and its retry is judged again rather than suppressed), and the relay answers
the two differently: a duplicate is confirmed, an undecodable frame is refused with
the receiver's reason and keeps being refused until the sender's own budget puts it
in the dead-letter queue. `ACK.21` pins the first half; `ACK.4` already pinned what
the sender does with a refusal.

## A framed stream that reordered its own frames

The acceptance run for iteration 69 failed three `e2e` cases, all in the CDC
suites, all on the same assertion — the receiving datacenter had applied the
changes in the wrong order:

```
FAIL tests/cdc-refusal.test.ts > AC-C20: the system is up and the first batch is applied in order
AssertionError: expected [ 2, 3, 1, 4, 5, 6, 7, 8, 9, 10, …(2) ] to deeply equal [ 1, 2, 3, … ]
```

The three cases in that file were one failure, not three. `AC-C20` assigned the
processes to the suite's shared `state` on its **last** line, after the assertion
that failed, so `AC-C21` read an empty applied file (`expected +0 to be 12`) and
`AC-C22` spawned a relay with no configuration (`CDC_RELAY_CONFIG missing`). The
second file's failure was the same defect wearing a different number: `AC-C24`
applied `1,3,4,5,2,6,…`.

**The first two readings were wrong.** The acknowledgement protocol was a day old
and it was in every one of those code paths, so the ack was the obvious suspect —
but `cdc-ack`'s own case passed in the same run, and the pipeline marks an entry
delivered only when the peer said so. The pump was the second suspect, and it was
already strict: a cycle ends at the first entry the peer did not confirm. The
order in the _applied file_ was wrong, and that file is written by the receiver's
`onMessage` handler, synchronously, with `fsync` — so the receiver had been handed
the frames out of order. The wire did that, not the protocol.

**Two queues were missing, one in each direction.**

`RaftTcpTransport` compresses payloads over 1 024 bytes with zstd, which runs on
libuv's thread pool: `compress()` resolves when a worker is free, not when it was
asked. The frame was written **inside that callback**, so the socket received the
frames in _completion_ order. Twenty small frames submitted after a large one could
reach the peer ahead of it.

The receive side had the same shape for a different reason. `_processData` awaits
a decompression, and the event loop calls it again for the next `data` event while
it is awaiting — a re-entrant handler over a per-peer accumulation buffer. Two
loops read the same buffer, and the run that produced the original report delivered
**91 messages for the 40 that were sent**: frames decoded twice as well as out of
order.

Both are per-peer queues now. On the way out, one link per frame does both halves —
compress, then write — because the write is the part that has to be ordered, and
putting it in a second queue the compressor's callbacks enter in their own order is
the bug again with extra steps. On the way in, a chunk decodes only after the chunk
handed over before it. Peers never wait for each other: this is a queue per peer,
not a lock.

**The instrument is a size, not a coin toss.** The `e2e` suite was green in this
sandbox three times before the fix and three times after it — on an idle machine
the thread pool answers in submission order and the defect does not exist — and
the commit that failed that run passed the next one (`45024073958`), which is what
a defect with a load in its trigger looks like and the reason it cannot be the
acceptance criterion. An
acceptance criterion that needs a loaded runner to fail is not an acceptance
criterion, so `RaftTcpTransport.ordering.test.ts` builds the condition instead of
waiting for it: one 300 KB frame followed by twenty just over the threshold, over
real mTLS between two real transports. The compressor's answer for the first frame
cannot arrive first, so the order that arrives is a fact about the code.

| Configuration           | What arrived                                       |
| ----------------------- | -------------------------------------------------- |
| no queue on either side | `1,2,3,5,4,6,7,3,5,4,…` — reordered and duplicated |
| receive queue only      | `2,3,4,5,6,7,8,1,9,…` — the slow frame last        |
| send queue only         | `1,2,3,4,6,7,5,8,…` — one frame decoded late       |
| both queues             | `1,2,3,…,21` — submission order                    |

**The queue exists only where the defect was.** The first version of the fix put
every frame through the chain, and two existing tests failed: they hand a frame to
`_sendFrame` and then assert the write has happened, which was true and was no
longer. That is the right kind of failure — a change that is observable where it
should not be — so the fast path was restored: a frame the compressor would pass
through untouched (compression off, or a payload under the threshold, which is most
Raft frames) is written synchronously, exactly as before. What is queued is what is
compressed, and what is compressed is the only place the order could be lost.

**Raft was never broken by this, and that is not a defence.** The same run logged
`Unexpected error during RPC` on an `AppendEntries` to node 3 and the cluster test
passed anyway, because Raft is built to survive it: a follower that receives index
five before three rejects it with a hint and the leader retries. The CDC consumer
has no such repair, and "applied once, in write order" was a promise the pipeline
made while standing on a transport that did not keep it. A layer cannot promise an
order it does not own — or, as here, it can, until the day a compression callback
takes longer than the one before it.

## The first implementation of a port is a test of the port

`IMemberSet` has existed for three iterations. Every claim the four cluster
assemblers make — which member leaves, which batch costs quorum, which partition
is emitted — is a claim about a set read through it, and the only implementation
it had ever had was `InMemoryClusterTopology`, written by the same hand as the
executors and tested by the same suite.

Iteration 71 wrote the second one. `e2e/tests/cluster-scaling.test.ts` starts
three real Raft processes over mTLS, wraps them in an `IMemberSet`, and runs
`ClusterScalingExecutor` against what the _processes_ answer.

Two things the port turned out to require that the reference implementation had
never had to express:

- **The members are the committed configuration, not the peer list.** A process
  is started with a list of addresses; the group's configuration is what a
  majority agreed to, and the two disagree from the first membership change
  onwards. The adapter reads the leader's copy, because a follower's can lag by
  one entry and a member set that lags by one entry is the drift the executor was
  written to survive — it should not also be the drift it is fed.
- **A removal is a request whose refusal is a value.** `removeNode` appends a
  configuration entry and throws the typed error the assemblers already branch
  on, carrying the consensus layer's own reason (`no-quorum`, `rejected`) rather
  than a summary of it.

`AC-C25` asks for a scale-down from three voters to one. The executor removes one
follower, keeps the leader, reports `clampedBy: 'quorum-floor'`, and the cluster —
asked afterwards, in its own words — holds two voters. `AC-C26` asks again and
removes nothing: a majority of two is two, so there is no removal this group can
afford, and the note says so instead of leaving an operator to infer it from a
graph. `AC-C27` sets the policy floor above the observed size and checks the
clamp is named `policy-min`: a scale-down does not mend an under-sized group, and
an executor that quietly grew one would be answering a question nobody asked.

**The instrument fails on purpose.** Removing the quorum floor from the executor —
one line, `Math.max(this.minNodes, quorumFloor)` become `this.minNodes` — makes
`AC-C25` fail on `skipped`:

```
AssertionError: expected [ { id: '2', …(1) } ] to deeply equal []
```

That entry is the second removal: with only the policy floor in the way, the
executor tries to take a two-voter group down to one, the consensus layer refuses
because the configuration entry cannot commit, and the executor stops. The test
does not see a wrong number; it sees an attempt that should not have been made,
which is the defect.

**What the adapter does not do, and says so.** `addNode` throws
`ClusterMembershipError('unsupported')`: the port takes an id, the consensus layer
needs an address to dial, and this member set reads its ids from a running group.
A scale-up through it would be a member that exists in the member set and nowhere
in the cluster — the exact state the executor's own notes warn about.

**One semantic worth writing down.** In the scale-down path `targetCount` reports
the member count that _is_, not the target that was asked for, and `AC-C27` pins
it at two while the policy says three. That is not a rounding of the target: the
executor was asked to shrink, it shrank nothing, and the gap between the policy and
the group is the operator's to resolve. An outcome that reported three would be
describing a cluster that does not exist.

## What a mutation score measures when the module is a wire

`RaftTcpTransport.ts` has been the subject of two iterations of narrative in this
document and was never judged by the gate that judges `SqliteStorage.ts` and the
four assemblers. Iteration 71 put it there. The first measurement was **77.68 %**
over 548 mutants — 120 survivors and 9 timeouts — and the number is the useful
part: a module whose every ordering claim the cluster depends on had a hundred and
twenty behaviours no test named.

Five rounds, each one reading the survivors and asking what each of them said:

| Round                                           |       Score | Survivors | What the round added   |
| ----------------------------------------------- | ----------: | --------: | ---------------------- |
| first measurement                               |     77.68 % |       120 | nothing — the baseline |
| mTLS material, TLS parameters, queue cleanup    |     85.06 % |        81 | 14 cases               |
| inbound sockets, buffers, the frame path        |     87.45 % |        68 | 14 cases               |
| bound port, health check, zero-length frames    |     87.64 % |        67 | 6 cases                |
| what `send()` addresses, what `stop()` releases | **89.11 %** |        59 | 10 cases               |

The third round moved the score by 0.19 and was not wasted: it converted two
timeouts into failures, and a timeout is not a verdict — it says the runner
stopped, not that a test objected. The gate requires every one of them to be read
and recorded, which is why `mutation/timeouts.json` grew seven entries that name
the mechanism (`stuck`: this edit does not terminate) rather than a score.

**What the 44 tests actually assert.** Not "coverage". Each one names a contract
that a caller outside this package relies on:

- **The material `start()` refuses to proceed without.** Three fields, and the
  whitespace-only case — which is what a configuration templated from an unset
  variable looks like: present, non-empty and useless.
- **The TLS parameters as a whole.** `minVersion`, `maxVersion`, `ciphers`,
  `ecdhCurve`, `requestCert`, `rejectUnauthorized`, asserted as one object,
  because "TLS 1.3 only" is a security claim and a claim that survives one field
  being dropped is not the claim.
- **The CN prefix as a literal.** `raft.` in the allowed-prefix list must not match
  `raftx7`: an unescaped dot accepts a certificate issued for a name the
  deployment never said it trusted.
- **The per-peer queues' release.** Both maps, on drain and on `stop()`. A map
  entry per peer that is never removed is a leak that only shows under churn, and
  a transport that stops and starts under a membership change would accumulate one
  queue per peer per generation.
- **The two-second fallback in `stop()`.** Asserted with fake timers against a
  listener that never reports closed. Without it a shutdown waits on a callback
  the operating system may never send.
- **The compression threshold's boundary.** A payload of exactly the threshold is
  queued; one byte less is written synchronously. `<` and `<=` differ by exactly
  that frame, and the frame is the one the ordering queue exists for.
- **A batch that is not re-initialised per message**, and a frame that never passed
  through zstd not being sent through the decompressor.

**The 59 survivors are argued, not silenced.** Most are `StringLiteral` edits to
log lines: the message an operator reads is not a behaviour any test can fail on,
and asserting the text of a `console.warn` would be testing the logging library.
The rest are type guards the compiler already enforces (`typeof cert === 'string'`
is always true for a `string | Buffer` field reached from a typed caller), a
`clearInterval(null)` that is harmless by construction, and two `.clear()` calls
whose absence cannot be observed before the next `start()` repopulates the maps.
No `// Stryker disable` was added: a survivor with a reason in prose is a fact
about the code, and a suppressed one is a fact about the gate.

**The CI budget moved with the gate, and the measurement is in the commit.** Local,
this target alone costs twelve minutes; the job that runs all three measured 31
minutes before the addition and 36 after it (`45053900655`). Sixty would still have
passed. The cap went to ninety anyway, and the reason is not the number measured
today: this job grows every time a file enters a target, the runner's speed is not
ours, and a job killed at its cap reports nothing about the mutants it had not
reached — the failure names the clock rather than a survivor.

## A group of one

Every acceptance suite in this repository runs three nodes or more, which is the
right default: a majority is the whole point of Raft, and three is the smallest
number that has one to lose. The cost of that default is that a group of one is
never exercised — and a group of one is not a hypothetical. It is the development
deployment, the edge site, the shard that has not been given replicas yet, and it
is described in `cluster/docs/api-reference.md` in as many words: _"its committed
configuration names one voter, one answer is a majority, and `hasQuorum` is `true`
because it has to be."_

Iteration 72 wrote the first test that starts a one-voter group. It did not elect
a leader. Two independent defects in `@maboke123/raft-core` 0.2.1, neither reachable
with a peer:

| #   | Mechanism                                                                                                                                                                                                                                     | Measurement before the patch                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `becomeCandidateUnlocked` collects the self-vote, sets `votesNeeded`, then waits for `RequestVoteResponse`s. With no peers there are none. The pre-vote path _does_ check the quorum before becoming a candidate; the candidate path does not | `role: Candidate`, term 1 → 11 in four seconds, `commitIndex` 0                                               |
| 2   | The only caller of `tryAdvanceCommitIndex` is the `AppendEntriesResponse` handler. With no followers there are no responses, so nothing ever counts the leader's own log as a majority                                                        | `RaftApiError: Raft propose failed: Failed to commit command within timeout`, entry appended, never committed |

Neither is a misreading of Raft: the algorithm says a candidate holding a majority
has won, and that a leader's own log counts toward the majority that commits an
entry. Both patches are four lines, both carry the measurement in the comment, and
both live in `patches/@maboke123__raft-core@0.2.1.patch` beside the two that were
already there.

The interesting part of the fix is the control. "A candidate that holds a quorum
wins" is one line away from "a candidate wins", and a patch that made every
candidate a leader would pass the one-voter test and break every cluster that ever
lost a majority. `AC 72.9` is a two-voter group whose peer is unreachable: it must
never take office, and — the sharper half — its **term must not move**. An
unreachable peer means every election ends in pre-vote, and pre-vote is the loop
that deliberately does not increment the term. A climbing term there would mean the
patch had made campaigning unconditional.

The failure evidence is on the record, taken by reverting one hunk at a time:

```
× AC 72.6  → timed out after 15000ms waiting for the single voter to lead
× AC 72.7  → Raft propose failed: Failed to commit command within timeout
✓ AC 72.9  (the control passes both before and after — it is the one case that must not change)
```

## The position a node claims

`AC-C7` — a full-cluster restart after compaction keeps every write — once failed
with one node's engine holding one key fewer than the cluster had acknowledged. No
snapshot was installed, no restore failed, no apply raised, and the log entries were
identical on all three nodes. The only mechanism that produces that shape is a node
that was handed a _position_ without being handed the _state_, and raft-core has
exactly one place that does it:

```js
if (nextIndex <= snapshotIndex) {
  this.volatileState.setLastApplied(snapshotIndex); // the log moves
  continue; // the application is never called
}
```

The branch is correct for entries the snapshot covers _and the application already
has_. It is a silent hole for a node whose engine is behind the log, and there are
three ways to be that node: an engine restored from an older backup than the log, an
`installSnapshot` that writes nowhere, or `takeSnapshot` registered without
`installSnapshot` at all. The last one is a configuration, not an accident — the
class doc for the handler table has warned about it since the hooks were added, in
prose, which is the form of warning nothing enforces.

Measured, on a real restart over real SQLite storage, with the guard removed:

```json
{
  "snapshot": { "lastIncludedIndex": 4 },
  "commitIndex": 4,
  "lastApplied": 4,
  "appliedAfterRestart": []
}
```

The node reports index 4 on both counters, and the application was handed nothing.
Three of the four writes were in the snapshot; the fourth was in the log and would
replay. Restore nothing and the engine answers three keys where the cluster
acknowledged four — the failure that took a twelve-minute investigation to describe
and had never had a name.

The adapter cannot see the engine, so the fix has two halves and the application
supplies one of them:

| Configuration                                               | Decided by        | Result                                                                       |
| ----------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `takeSnapshot`, no `installSnapshot`, a snapshot in storage | the handler table | refused at `init()`, naming the snapshot index                               |
| `appliedIndex` reports a position behind `lastApplied`      | the application   | refused at `init()`, naming both indexes and the width of the hole           |
| no provider, no snapshot in storage                         | nothing to decide | starts; `getStatus()` reports `applicationApplied: null`, `appliedGap: null` |

`null` is not zero. A status field that reads `0` for "this node has not published a
position" is indistinguishable from the defect it exists to expose, so the pair is
`null` together — and an `appliedIndex` that answers with something that is not an
index (`undefined` from a forgetful arrow function, `NaN` from arithmetic on a
missing field) is refused as a wiring error rather than read as "caught up".

What that buys the e2e suite is a number in the divergence line: `gap=0` on a
healthy node, and on a node with a hole, the width of it in the first line of the
timeout instead of a key count that differs by one. `AC-C7` asserts the pair and its
own consistency — the adapter computes `raftApplied - applicationApplied`, the
harness computes `raftApplied - appliedIndex` from the replica's watermark, and
`AC-C10` requires the two to agree, because a diagnostic that disagrees with itself
is the one failure a diagnostic must not have.

## A suite that no job invoked

Iteration 71 added `e2e/tests/cluster-scaling.test.ts` and recorded that `pnpm e2e` ran
"69 cases / 11 files — `cluster-scaling` is the eleventh". The next iteration ran
`pnpm e2e` and counted 66 across 10; the file had no script of its own and no CI
step, and the only reason it had ever run is that the coverage job invokes the
whole directory.

The suite was green the entire time. Nothing about it was wrong. What was wrong was
the _path_: a dedicated job that uploads its logs on failure is how a red e2e run
gets diagnosed, and a suite outside every such job fails in one place only — the
coverage job — where the report is a percentage rather than a failing case name.

It is the third instance in this repository of the same shape: a gate that reads
less than the reader assumes (P3-43, the format gate covering four packages), a job
whose budget was measured on a suite that no longer existed (iteration 71's cap),
and now a suite absent from the job that keeps its logs. The general form is worth
stating once: **the set of tests that run is not the set of tests that exist**, and
the only defence is arithmetic — count what the runner produced, compare it with
what the page says, and treat a difference of three as a defect rather than a
rounding.

## Three ways to write

Iteration 70 fixed a real reordering: `_sendFrame` wrote the frame inside the
compressor's `.then()`, and zstd runs on libuv's pool, so the wire order became the
completion order. The fix — one promise chain per peer, each link doing
compress-then-write — is correct for the route it covers. The contract that was
written down afterwards, in `federation/docs/api-reference.md`, is broader than the
route: _the frames of one peer reach `onMessage` in the order `send()` was called._

By the end of iteration 72 that class had three routes to the socket:

| Route          | Taken when                                                         | Ordered in 70?                 |
| -------------- | ------------------------------------------------------------------ | ------------------------------ |
| Queue link     | payload over the compression threshold                             | yes — the chain                |
| Fast path      | compression off, or payload under the threshold (most Raft frames) | no — written inline            |
| Buffered flush | no connection when the frame arrived                               | no — written inline on connect |

Two crossings between them were reachable, and both inverted:

```
AC 73.1  a compressed frame in flight, then a small one buffered, then the
         connection arrives        →  [0x59, 0x41]   (submitted 0x41 first; on real
                                                        mTLS sockets: [2, 1])
AC 73.2  a batch's flush fails, a frame arrives before the redial
                                   →  ['new', 'old']
```

The mechanism in both is the same sentence: **a queue that only some writes enter
is not a queue.** A frame can only be ordered against frames that pass through the
same gate, so the gate has to be at the one place every write goes through, or the
promise has to be narrowed to the frames that do. Narrowing it would have been
honest and useless — the CDC consumer and Raft's `prevLogIndex` both need the
whole stream in order.

So the writes were moved onto one gate rather than a second gate being added:

- a frame joins the peer's queue whenever anything older is in flight **or
  buffered** (`_mustQueue`), not only when its payload needs compressing;
- the flush is a link in that queue, taken from the buffer synchronously and
  written when its turn comes, instead of writing inline from
  `onConnectionCreated`;
- a new frame never overtakes a buffered backlog — it appends, and the backlog is
  drained first;
- a write that fails is put back at the head of the buffer instead of being
  warned about and lost. That one is not an ordering fix; it is the same defect
  class from the other end. `AC 73.3` measured an empty buffer after a failed
  write: the entry was in the leader's log, its predecessor was on the wire, and
  the follower was never told.

The invariant that makes the failure path's `_prependFrames` correct is worth
stating because it is not local: a frame takes the fast path only when the peer's
queue is empty _and_ its buffer is empty, so anything that enters the buffer while
that write is in flight was submitted later. Prepending on failure therefore
restores the submission order rather than asserting it — and `AC 34.77`, which
called `_doSendFrame` directly while a batch was in flight, described a state
`_sendFrame` cannot produce. That test now enters through `_sendFrame` and its
expectations changed with the mechanism: two frames arriving during the batch's
flight each evict one from the cap, instead of one batch re-buffer evicting two.

The evidence, each on its own mechanism:

```
no gate at all           AC 73.1 [89, 65]   AC 73.2 ['new','old']   AC 73.3 frame lost
                         AC 73.5 heartbeat written ahead of backlog
                         AC 73.7 batch written to the abandoned socket
                         O5 (real sockets) [2, 1]
gate on the fast path removed only (the flush still chained):
                         O5 [2, 1]                    ← the real-socket proof is O5
```

Three of these are about order and one is about loss, and the loss one is the
reason this is not only a `federation` concern: a dropped AppendEntries is a
leader re-sending, but a dropped `cdc_ack` is a replication window that never
closes.

## A gate that nothing runs

`pnpm verify` has existed since the first iteration and is documented in
`CONTRIBUTING.md` as the thing to run before asking for review. It runs nineteen
steps: every package's compiler, the suite, coverage in four dimensions, the gate
self-tests and the e2e harness. It takes tens of minutes.

It ran before a push exactly as often as someone remembered to type it, which is
to say never. The repository had no hooks at all. Iteration 25 landed a file that
`format:check` rejects and learned about it from CI — a runner spent fifteen
minutes and an author spent a context switch, on a check that takes one command
locally and one second to run.

The gap was not a missing gate. It was a missing _trigger_, and the interesting
part is how many ways the trigger can fail silently:

| Failure                                             | What git does                                                 |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `.git/hooks` is not versioned                       | every clone has different hooks, and review sees none of them |
| a hook file without the execute bit                 | skipped, with no message                                      |
| `core.hooksPath` pointing at a directory that moved | skipped, with no message                                      |
| a hook written as if run from `.githooks/`          | fails on the first push, for a path reason                    |
| pushing through the Git Data API                    | no client hook exists to run                                  |

Every row is a push that was not checked, and every one of them looks exactly like
a push that passed. That is the same shape as the gates themselves —
`check:script-coverage` exists because a gate over zero files reports perfect
compliance — one level up: a _chain_ over zero executions reports perfect
compliance.

The answer is three files and the rule that binds them:

- `.githooks/pre-push` — one line: `exec pnpm preflight`. Versioned, so the hook
  git runs is the hook review read.
- `scripts/install-hooks.mjs` — sets `core.hooksPath` and the execute bit, and
  refuses a tree with no hooks rather than configuring an empty directory.
  `--check` answers "is this clone configured" for a machine; CI cannot answer it
  and does not pretend to.
- `scripts/preflight.mjs` — the fast end of `verify`: seventeen steps, ordered to
  fail fastest, stopping at the first failure so the message read is the cause
  rather than the cascade.

`check:hooks` reads the repository side of the chain — the hook exists, is
executable, runs _that_ command, and `prepare` installs it — because the remote
side cannot be read by a gate that runs on a fresh checkout. The two halves
together are the whole chain, and each says which half it is.

One honesty note that is also a decision: **a passing preflight is not a green
build.** CI runs what needs a runner — the suites, the coverage gate, the e2e
harness, the mutation targets, the benchmark. Preflight buys the absence of the
failures that are cheapest to catch where they were introduced, and the command
prints that sentence on success so nobody has to remember it.

## The test that failed the runner it ran under

Iteration 74 added `scripts/preflight.mjs` and one case to prove its executor
answers with the step's exit status. The second assertion asked pnpm for a script
that does not exist — the cheapest way to get a non-zero status out of the single
line under test:

```js
assert.equal(runScript("check:hooks"), true);
assert.equal(runScript("no-such-script-name"), false);
```

Locally it did exactly what it says: pnpm refused, the status was 1, `runScript`
answered `false`. CI job `45108062128` disagreed. Every assertion in the suite
passed and the `Quality` step failed, with the annotation naming the fixture:

```
#  ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "no-such-script-name" not found
##[error]Process completed with exit code 1.
```

The test's input was a failure of pnpm, and the process running the test was
pnpm. Spawned with `stdio: 'inherit'`, the child reports through the chain that
hosts it, and that chain reports the failure as its own: `pnpm test:scripts`
exited 1 for a suite in which nothing failed.

There are three instruments on this page with the same defect, and the defect is
that the answer arrives from somewhere other than the code under test:

| Instrument                               | What it accepted as an answer                                              |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| a gate over zero files                   | "no violations" from a file list nobody computed — `check:script-coverage` |
| a chain nothing executes                 | "checked" from a hook git skipped without a word — `check:hooks`           |
| a test whose input is the tool's failure | "false" from a process that also failed its caller                         |

The repair is one parameter — `runScript(script, spawn = spawnSync)`, the same
injection `runSteps` already takes as `execute`. The real spawn still runs, on the
passing side; the failure side states a status, and the case asserts the argv and
options the real call uses instead of assuming them:

```js
runScript("lint", spawnThatExits(2)); // false, and pnpm was asked for ["lint"] in the repo root
runScript("lint", () => ({ status: null })); // a killed child is not a passed step
```

### A branch that was covered by the clock

Removing the nested pnpm call cost `preflight.mjs` three and a half points of
branch coverage: 100 % → 96.55 %. The uncovered arm was the one that names the
slowest step.

```js
const slowest = executed.results.reduce((a, b) => (b.ms > a.ms ? b : a));
```

`? b` was never taken, because every passing run in the suite injected an executor
that returns instantly: each step measured `Date.now() - Date.now()` — zero — and
the first step always won. The arm had been covered exactly as long as two clock
reads straddled a millisecond. Eight runs of the pre-fix suite: seven at 100.00 %,
one at 98.96 %.

A coverage figure that depends on how slow the machine is, is a figure that would
have gone red on faster hardware with no change to the code — the same class of
failure as a threshold pinned to a Node version, one level down. The case that
replaced it drives the clock: `Date.now` is replaced for the duration, `lint` is
charged 4 200 ms against `typecheck`'s 7 ms, and the summary must name `lint`.
Reverting the comparator to `a` fails it with `preflight: 2 steps passed
(slowest: typecheck).`

## A cache that erases the evidence

The gate that measures the gates reported three files under the branch floor on
CI — `check-hooks.mjs` 94.12 %, `install-hooks.mjs` 93.55 %, `preflight.mjs`
94.12 % — and 100.00 % for all three on the machine the change was written on.
Same commit, same Node (`v22.13.1`), same command.

The difference is one environment variable. `NODE_COMPILE_CACHE` was set in the
sandbox; a GitHub runner does not set it. Measured both ways from one tree:

| Variable                 | `check-doc-examples.mjs`                          | `install-hooks.mjs` | `preflight.mjs` |
| ------------------------ | ------------------------------------------------- | ------------------- | --------------- |
| `NODE_COMPILE_CACHE` set | 100.00 lines / 97.40 branches                     | 100.00 / 100.00     | 100.00 / 100.00 |
| unset                    | 99.56 lines / 95.00 branches, `457-458` uncovered | 100.00 / 93.55      | 100.00 / 94.12  |

A script compiled from cached bytecode loses block ranges in V8's precise
coverage, and a range nobody reports is a range nobody can fail. The variable is
invisible in the number it moves: nothing in `100.00 %` says "this was measured
with a warm cache". So the measurement was not of this repository — it was of
this repository plus whatever a previous process had left in
`~/.cache/v8-compile-cache`.

`measure()` now strips `NODE_COMPILE_CACHE` from the run it starts, beside
`NODE_TEST_CONTEXT` and `NODE_V8_COVERAGE`, which are there for the same reason:
a number that belongs to the caller is not a measurement of the code. The case
that asserts it names the table above.

What the honest number then showed was real debt, of the kind this page keeps
finding: `install-hooks.mjs`'s `process.exit(main())` had never run in any case —
the suite imports the module, so `process.argv[1]` is always a test file, and the
program path a contributor takes was the one path nothing exercised. Three
scripts had the same hole, because they shared the same two lines:

```js
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
```

Naming the check — `isEntryPoint(process.argv[1])`, the shape
`check-script-coverage.mjs` already used — turned the untaken half into a case,
and the command line of each script into a case that runs the file as a program.
All three read 100.00 % on all three dimensions in the full suite. Measured
alone, `install-hooks.mjs` reads 97.14 % branches, because one arm of `rootArg`
is taken by a case in a neighbouring file: a file's percentage belongs to the
run it was taken from, which is the same lesson as the cache, one turn of the
screw further in.

The boundary of that was measured rather than assumed, because the next obvious
question is whether the other coverage instrument in this repository reads the
same cache. It does not: `vitest run --coverage` over
`RaftJointConsensusEngine.test.ts` returns `All files 3.2 / 93.62 / 98.9` with
`NODE_COMPILE_CACHE` set and the same three numbers without it. Vitest transforms
modules itself and runs them through its own runner, so V8 never compiles the
source as a module and never consults the cache. The inflation belongs to Node's
own collector, which is what `check:script-coverage` starts.

The general lesson is the page's oldest one in a new costume: **a green number
is a claim about an instrument**. A Node version was already named as part of
that ruler; a cache directory was not part of it, and it moved the reading by
five points while looking like nothing at all.

## An edit that cannot be interrupted is not a detection

The mutation report carried forty-two `Timeout` verdicts against `node`, and
thirty-six of them were `stuck`: the attributed tests reported nothing and the run
never finished. A timeout is not a verdict — it says the runner stopped — but the
score treats it as one, so those thirty-six were counted as thirty-six detections.

Every one of them was the same shape:

```ts
while (pending.length > 0) { …; pending.push(snapshot.snapshotId); }
for (let value = low; value <= high; value += step) { … }
for (;;) { …; if (seen.has(parentId)) return refuse(…); … }
while (this.pendingCompressions.size > 0) { await Promise.allSettled([...]); }
```

A counted loop is a promise about its own update expression. Mutate it — `value++`
to `value--`, a body emptied to `{}`, a `> 0` to `>= 0` — and the result is not a
wrong answer but a loop that never ends. JavaScript cannot preëmpt synchronous
code, so the case running it never gets to fail: it wedges its worker, Stryker
abandons the mutant at its cap, and the abandonment is filed as a kill. The score
was paying the same credit for _the tests objected_ and _the tests never got a
chance to_.

The child-process remedy the roadmap had registered is real but insufficient, and
the reason is mechanical: to be **attributed** to a mutant a test must execute the
mutated line, and the process that executes it is the worker that cannot report.
A deadline in a child observes a hang; it does not prevent the case that hangs.
So the loops were removed instead:

| Where                      | Was                                      | Is                                                                                                                |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cron.ts`                  | three counted walks                      | `valuesBetween` / `steppedValues`: the length is arithmetic, and `Array.from` refuses an infinite one by throwing |
| scheduler                  | four `while (cursor < toMs)`             | `instantsBetween`: `[from, to)` at a step, capped by `MAX_PROJECTED_INSTANTS`                                     |
| `backupChain.ts`           | a worklist, and `for (;;)`               | rounds over the inventory; one step per stored snapshot plus one                                                  |
| `RetentionPolicyEvaluator` | a worklist queue                         | one round per level, bounded by the inventory                                                                     |
| `BackupManager`            | a cursor two workers shared              | one generator two workers consume                                                                                 |
| `FileAuditStore.close()`   | `while (size > 0) { await … }`           | one `allSettled` over a snapshot                                                                                  |
| `AuditLogManager`          | `while (i < n && events[i].ts < cutoff)` | `findIndex`                                                                                                       |
| `KeyManager`               | `while (cache.size > MAX)`               | a slice of the cache's own entries                                                                                |

Measured on the node target, 4 190 → 4 152 mutants: **timeouts 42 → 1**, survivors
76 → 79, and the score **98.15 % → 97.96 %**. The drop is the deliverable. Thirty-
nine credits that had never been earned left the numerator, and a gate that reports
a higher number for a suite that cannot object is the instrument lying.

Two details keep the number from being a different kind of lie.

**The bound is a length, not a counter.** `instantsBetween` computes
`Math.ceil((toMs - fromMs) / stepMs)` and caps it. Without the cap, one mutation of
the subtraction — `-` to `+` — produced a count of nine million and a run that
allocated until the cap: the one mutant that stayed a timeout after every loop was
gone. With the cap the same edit names a hundred thousand wrong instants, and an
assertion fails in milliseconds.

**The one that remains is not a silence.** `FileAuditStore.ts:926` sets a
"flushed" flag to `true`; with it mutated, a case reports `Test timed out in
15000ms` (`AC 87 EX.3`) and the run still never exits, because a second case in the
same worker never drains. The objection was made and the trial was not finished,
which is a different instrument's job — a worker that cannot be reclaimed — and it
is registered as such rather than folded into this one.

And the child with a deadline still exists, for the loop nobody has written yet.
`AC 103` runs `parseCronField` in a process the test owns, with a 5 s deadline;
with `valuesBetween` replaced by `for (;;) { }` it fails at 5 017 ms:

```
parseCronField("*") did not return within 5000 ms — the process was killed,
so a loop in it never ended. stderr: (empty): expected 'SIGKILL' to be null
```

Five seconds is fifty times the measured process start (0.09–0.25 s), a third of
the mutation suite's 15 s case budget, and a sixth of Stryker's 30 s cap — so the
same edit is a _failed test_ in both instruments, which is the difference between a
verdict and a silence.

## Two writers released before either had read the directory

The acceptance run for this iteration failed one case, and the case was right:
`AC 86 TW.2` reported `audit-20261123-0001.ndjson holds lines from proc-2715,
proc-2716`. Two processes were supposed to write to their own segments, and one
segment held both.

The product was not at fault. A store that is constructed while another's segment is
open **adopts** it — that is what makes a restart a continuation rather than a new
file — and three store calls reproduce the state the case forbids:

```ts
const a = new FileAuditStore({ dataDir });
await a.write(entry);
const b = new FileAuditStore({ dataDir });
await b.write(entry);
// audit-20261123-0001.ndjson holds ["proc-a","proc-b"]
```

What was wrong was the premise of the case: it released both children as soon as it
had _spawned_ them. On a quiet machine both construct before the release, so the
window never opened; on a runner busy enough that `tsx` takes a moment to compile,
the faster child appends first and the slower one adopts. A pause that is usually
long enough, on the one day it is not, reads as a product bug.

```
let release;                       // before: a pause
writeFileSync(releaseFile, '');
// after: a handshake
process.stdout.write('READY\n');    // in the child, after construction
await Promise.all(children.map((c) => c.ready));
writeFileSync(releaseFile, '');
```

Measured both ways: with the second child started 400 ms late, the handshake passes
and the immediate release hands that child a segment holding another process's
lines. Five consecutive runs of the file after the fix: 5 × 2 cases, 0.4–0.6 s. The
lesson is this page's oldest one again — a test that depends on being fast enough is
a test of the machine — and the answer is the same as for the coverage instrument: a
bound on a property, never a pause.

## A wait that never settles is not a failure

Iteration 76 removed forty-two aborts from the `node` target by deleting the loops
that produced them. Iteration 77 read the cluster target's seventeen and found that
only nine were loops. The other eight were not loops at all:

```ts
resolve();                                    // start(): a listen that never answers
setTimeout(() => resolve(), 2000);            // stop(): the fallback for a stuck close
this._flushPending(peerId);                   // a flush that is never asked for
if (this.pool) { this.pool.onIncoming(…) }    // an inbound socket that is never registered
```

Mutate any of those four and the product stops completing an operation it promised.
Nothing in the loop-removal doctrine helps, because there is no loop: a promise has
exactly one line that resolves it, and deleting that line leaves an awaiter. The
case waits, vitest's own cap fires at 180 s (the cluster suite's budget), the worker
is killed mid-file, and the report records a timeout. That is a statement about the
runner's patience, not about the suite — the same silence in a different place.

So the second half of the instrument is on the _waiting_ side. `support/awaitBound.ts`
races every product promise a transport suite awaits against 1 200 ms and fails with
the operation named:

```ts
const startWithin = (t: RaftTcpTransport) =>
  bounded(t.start(), "transport.start()");
const stopWithin = (t: RaftTcpTransport) =>
  bounded(t.stop(), "transport.stop()");
```

The number is not a guess. A real transport binds a loopback port in 35 ms and tears
it down in 0.5 ms, so 1 200 ms is thirty times the slower one; and the number that
actually chose it is the gate's — a mutant that leaves fifteen stops unresolved must
finish inside the thirty-second abandonment, and 15 × 1.2 s is 18 s where 15 × 3 s is
45 s. **A suite that spends longer than the cap is a verdict that never becomes one**,
which is how a fix can be mistaken for a silence in a new place.

Measured one edit at a time, against the instrument:

| Edit                                     | The case now reports                                         | The run                                 |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `resolve()` → `;` in `start()`           | `transport.start() did not settle within 1200 ms` (1 206 ms) | completes, mutant killed                |
| force-close callback → `() => undefined` | one failed case                                              | completes in 4.6 s, killed              |
| `Date.now() >= deadline` → `false`       | two failed cases at 1.2 s                                    | completes in 5.5 s, killed              |
| `_handleIncoming()` → `{}`               | 28 failed cases                                              | completes in 2 m 40 s — still a timeout |

The fourth is where the arithmetic runs out: twenty-eight cases at five to thirty
seconds each cannot fit in thirty seconds, so the verdict is still a timeout — but it
is a _reported_ timeout, and the difference between `failed` and `stuck` is the whole
of this page. `resolve-timeouts.mjs --record` on the three that remain says `failed`
three times, at 1.9 s, 2.6 s and 3.3 s, and `stuck` never.

Two habits travel with it, both learned here.

**A test that outlives its verdict holds the event loop.** A step of
`awaitPeerConnection` is a `setTimeout`, and a timer keeps the process alive, so a
mutant that never lets the budget expire leaves a chain nothing owns — the case
fails, and the run never ends. The two cases whose waits do that end their transport
in a `finally`, and `_stopped` is what ends a step. That is also why the retry is a
step per deadline rather than `for (;;)`: a loop whose body is emptied spins, and a
spinning process is not one a timer can reach.

**Under fake timers the observation is the verdict.** One case drives a never-closing
listener with `vi.useFakeTimers()` and asserts that the fallback ends the shutdown.
It used to `await stopped` and then assert the flag; with the mutation applied it hung
for 180 s, because no deadline the test owns can fire while time is fake. The flag is
asserted first now and the await follows, which is the same rule as everywhere else on
this page: **a verdict has to exist before the thing it is a verdict about can be
awaited**.

---

## A flush that delivers one event is not a flush

`CDCManager` sits on the write hot path: `FederationManager.replicate()` captures every
change it commits locally. `flushBuffer()` took the whole buffer with `splice(0)` and then,
for each handler, did `await handler(events[0]!)`. A batch of thirty changes delivered one
change and destroyed twenty-nine, and the `flushed` event that reported it emitted
`events.length` — the count of the ones that were thrown away.

Two properties replaced it, and both are about sets rather than counters.

**Every captured event reaches every handler, in capture order.** The case asserts the
sequence `['e0'…'e4']`, not a length. It is the difference between "thirty arrived" and
"thirty were captured".

**A handler that refuses an event has not seen the ones behind it.** Delivery is
at-least-once and order-preserving, so a failure at index *i* re-queues *i…n*. The test
drives a handler that rejects `k1` and asserts the healthy handler received `k0`, the
buffer still holds two entries, and `flushed` reported **one** — a re-queued tail is not a
delivery, and the counter that says otherwise is the defect wearing a dashboard.

A full buffer became a reason to drain rather than a reason to discard. `capture()` awaits
the drain and then buffers, so the producer's backpressure is latency and the buffer is
allowed to exceed its bound instead of dropping an event at the threshold. `getDeliveryStats()`
publishes `captured === delivered + bufferSize`; the re-queue counter is deliberately _not_
in that identity, because an event that goes back is counted once when it returns and again
when it finally lands.

The per-target `CDCEngine` array went with it. It was constructed in `start()`, started,
stopped, and never given an event: the engines model PostgreSQL's table-and-row shape
(`tableName`, `oldValues`, `newValues`) and this manager models key/value changes, so the
only way to feed one from the other was to invent a table name from a key. `getEngineCount()`
answered a question about decoration — a two-target federation reported two engines and
zero events ever reached either.

## A dead letter is a queue entry, not a tombstone

Three facts made the dead-letter queue a graveyard:

- `retryFailed()` on the replication engine reset a failure counter, scheduled a tick, and
  returned a hard `0`. Its comment said a future iteration would iterate the queue.
- `OutboxStore.retryDeadLetter(id)` revived one entry and had **no production caller**.
- `housekeeping()` deleted delivered and dead-lettered entries past their TTL and had **no
  production caller** either.

So the queue only ever grew, one entry at a time, and nothing in the package could say how
much each target was owed.

The repair keeps the two directions apart. `retryDeadLetters(target?)` revives a queue and
returns the count; `MultiLeaderReplication.retryFailed()` calls it and answers with that
number; `FederationManager` runs the scan (`dlqScanIntervalMs`, default 5 s) and the prune
(`outboxHousekeepingIntervalMs`, default 60 s), and exposes `scanDeadLetters()` for an
operator who has just restored a site. Reviving only for a **reachable** target is what
makes the scan a retry policy rather than a spin: a revived entry gets a fresh window, so a
permanently failing target costs one attempt per window, not one per scan.

`housekeeping()` now returns `{ delivered, deadLettered }`. It is the last moment an entry
can leave the outbox, and a prune that removes a thousand dead letters looks exactly like a
prune that removed none.

**The revive must not erase the evidence of failure.** `retryFailed()` resets the entry's
budget in the store and deliberately leaves the worker's consecutive-failure count alone: it
is what makes the next successful delivery a recovery rather than an ordinary one. The first
version of the change reset it, and the case that asserts `target-recovered` failed — the
announcement could no longer tell the two apart.

Recovery also had to survive an empty queue. The only place that could emit a recovery
signal was the success branch of `doTick()`, and when every pending entry has been written
off the worker takes its empty-batch early return — so the branch that reports recovery was
unreachable exactly when recovery mattered. The empty branch now reads the **link** instead
of the queue: `isPeerReachable()` is a fact about a socket, and it is what "the peer is back"
means when there is nothing left to send.

## Lag is what is owed, not how long ago

`getStatus()` computed `lagMs` as `now - lastSuccessAt`. That figure grows on a channel with
nothing to send, so a target that delivered one write and then sat idle for five minutes
reported itself critical — and a monitor built on it would forward every read away from a
healthy replica, permanently. The two halves of the defect are one:

```ts
const lagMs = worker.lastSuccessAt !== null ? now - worker.lastSuccessAt : 0;  // before
const lagMs = oldest === null ? 0 : Math.max(0, now - oldest);                // after
```

`oldest` is the creation time of the oldest entry the target still owes, read in the same
ordered pass over the pending index that counts the backlog — one scan answers "how many"
and "how far behind" together, and replaces the `fetchOldestPending(100_000)` the count used
to cost. `HealthMonitor` additionally requires `pendingCount > 0` before it calls anything
lagging, which is belt and braces: the case injects a target with `lagMs: 600_000` and zero
entries and requires silence, then the same target owing one entry and requires the callback.

## A consumer that declines is not an apply

The recovery e2e killed all four processes of one datacenter, wrote eight keys, waited for
them to be written off, cold-restarted the datacenter, and then waited for the keys at the
peer for three minutes. What the dump said:

```
west: { isLeader: true, commitIndex: 2, stateSize: 0, inboundFrames: 8, lastInboundError: null }
east: { pending: { 'dc-west-gw': 0 }, deadLetters: 0, connectedPeers: ['dc-west-gw'] }
```

Eight frames arrived. None was applied. Nothing recorded an error, and the sender's outbox
was already empty — the entries had been retired the moment `send()` accepted them.

The mechanism: the restarted gateway is a follower for the few hundred milliseconds before
it wins its election, its `proposeReplicated` saw `isLeader() === false`, sent a message to
the harness and **returned**, and `applyInbound` recorded the frame as applied. The library
cannot currently tell the two apart: a receiver that could not apply is indistinguishable
from one that did.

The harness consumer now waits for leadership and throws if it never arrives, which is what
turned the case green. The library half is the synchronous commit gate — an acknowledgement
must be the peer's statement that its own log has the change, not the sender's statement
that its socket took the bytes — and it is the same defect as the write path's
`local commit → ACK` one layer down. Both are open, and this dump is what they are for.

## The gate that counted a page it never compiled

`check-doc-examples` lists `docs/user-guide/federation.md` among the pages it reads. Three
deliberate errors on that page — a constructor with the wrong number of arguments, a
`priority` field the interface does not declare, and finally `const zz: number = "not a
number"` — all pass it, in a `ts` fence the gate's own contract page says is compiled twice.

The page was the worst offender in the audit: sections 3–6 described a `FederationManager`
constructor the package does not have, a `QueryRouter` class that does not exist, four
routing policies out of the six that do, and an `AntiEntropy` that takes a remote store it
cannot use. The examples are rewritten against the real API in iteration 78 and now
type-check where a reader pastes them; the gate's hole is recorded rather than assumed
closed, because a page count is not a page compiled.

---

## A fatal error nobody read

CI run `45320587437` failed two jobs on one commit: `E2E — cross-cluster sync over
mTLS (two real DCs)` and `Coverage (e2e harness)`. Both failures were the same failure,
and it read like this:

```
[east-gateway] [gateway] fatal: RetentionViolation: retry-covers-backoff:
  the retry budget is 1000 ms but one backoff may last 2000 ms
Error: [east-gateway] timed out after 90000ms waiting for ready from east-gateway
  (exit=1; stderr: … [gateway] fatal: RetentionViolation …)
```

The child had said what was wrong, in its first ten milliseconds, **and then the suite
waited ninety seconds for it to say something else**. Three separate defects had to line
up for that, and each one is the same shape: a signal that exists and is read by nobody.

**The knob that was dropped.** The gateway's harness copied four keys out of the suite's
`outbox` block —

```js
ttlMs: outboxConfig.ttlMs ?? 600_000,
maxRetries: outboxConfig.maxRetries ?? 10,
retryWindowMs: outboxConfig.retryWindowMs ?? 60_000,
deadLetterTtlMs: outboxConfig.deadLetterTtlMs ?? 600_000,
```

— and dropped every other key the store accepts. So the scenario that shortened the retry
window to one second kept the two-second default backoff, and iteration 80's derivation
refused the pair at boot, correctly: a budget that is spent sleeping past its own deadline
is not a budget. The refusal was right. The configuration was never what the suite asked
for, and the harness had no way to say so.

The `outbox` block is now forwarded verbatim, with `dataDir` and `mapSize` owned by the
gateway and every other key checked in the parent before a process is spawned —
`assertGatewayConfig` refuses a key the store does not read (a typo is not a default) and
names the keys it does. The check is typed against `keyof OutboxStoreConfig`, so a field
the store renames stops compiling here instead of silently reverting to production
defaults at runtime.

**The flag nobody consumed.** `NodeMessage` has carried `fatal?: boolean` since the
harness was written, and all six child programmes set it as their last message before
exiting. `ChildNode` read it nowhere. A gateway that refused its configuration and a
gateway that was slow to bind a port produced the same observation: silence, until the
deadline. `waitFor` now fails on `{ type: 'error', fatal: true }` with the child's own
reason in the message, and resolution still precedes rejection so that a test *asserting*
a refusal receives the message it asked for.

**The exit nobody noticed.** `process.on('exit')` recorded the status and stopped there.
A wait whose message can no longer arrive now fails with it:

```
[exiting-node] exited with code 3 before ready (stderr: <empty>)
```

Measured on the case that used to cost the run ninety seconds: **4 ms** to a named
failure. The `settleAfterExit` path deliberately has no "is the message in the buffer?"
branch — a message the child sent before leaving is dispatched before the exit handler
runs, and a wait created afterwards searches the buffer first, so the branch would be
code no test could reach. That is the same rule this page applies to empty `if` blocks:
an unreachable branch is a comment shaped like code.

The suite now also *observes* what it configured. `status` carries
`retention: federation.getRetention()`, and `AC-F5` asserts the gateway runs with a 1 000 ms
window and a 200 ms ceiling — the number the scenario's timing depends on, reported by the
process that runs with it rather than restated by the test that asked for it.

| Measure | Before | After |
| ------- | ------ | ----- |
| Time to a named failure when a child refuses its configuration | 90 000 ms (deadline) | 4 ms |
| Failure text | `timed out after 90000ms waiting for ready` | `reported a fatal error before ready (fatal: retry-covers-backoff…)` |
| `outbox` keys the gateway honours | 4 of 10 | 10 of 10, checked before spawn |
| `e2e` harness coverage | 99.44 / 96.47 / 100 / 99.44 | **100 / 97.22 / 100 / 100** |
| `e2e` cases | 71 | **85** (14 new) |

The general lesson is the one the acceptance table already states about products and this
page states about instruments: **a declared signal with no consumer is not a feature, it
is a claim**. `fatal: true` was produced by six programmes, documented in the message type,
and consumed by zero callers for the whole life of the harness — and the cost was not
correctness, it was diagnosis: every run that hit it paid ninety seconds to learn something
the child had already said.
