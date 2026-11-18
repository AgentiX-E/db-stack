# Maturity and test coverage

This page is the honest answer to two questions a team asks before adopting middleware:
**what does it actually do**, and **how is each part verified**. It is generated from the
same evidence the CI gate enforces, and it lists what is _not_ covered as explicitly as what
is. A capability with a gap is more useful to you than a claim without one.

Legend for the coverage column — test types actually executed against the feature:

| Code  | Meaning                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| **U** | Unit: the component in isolation, branches and error paths included           |
| **I** | Integration: real components wired together, in-process                       |
| **C** | Conformance: the published contract suite (`runEngineConformance`)            |
| **B** | Boundary: concurrency, storms, 5 000-entry floods, resource limits            |
| **L** | Linearizability: history checked with a Wing-Gong style register model        |
| **E** | End-to-end: **separate OS processes over TLS 1.3 with mutual authentication** |
| **P** | Performance: a benchmark that runs on a GitHub runner and fails on regression |
| **R** | Recovery: crash, restart, snapshot install, log truncation                    |
| **M** | Mutation: the source is altered on purpose and the suite must notice          |

**What "resource limits" means in a B row.** Heap assertions here sample *after a forced collection*,
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

| Capability                                    | Verification  | Notes                                                                                                                         |
| --------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Leader election, pre-vote, check-quorum       | U · I · E · P | Real elections in 3- and 5-node TLS clusters; median and p95 over five trials on a real cluster (`AC 29.1`)                    |
| Log replication, commit index, apply ordering | U · I · L · E · P · M | Every entry applied in index order on every node; latency and throughput measured through `RaftAdapter` (`AC 29.6`, `AC 41.1`) |
| Entry position forwarded to the application   | U · I · C · E | `index`/`term` reach the engine; asserted end-to-end                                                                          |
| Joint consensus membership change             | U · I · E     | C_old,new → C_new, rollback on failure                                                                                        |
| Learner (non-voting) catch-up                 | U · I · E     | Promoted only after catching up                                                                                               |
| Leader transfer                               | U · I · E     | Target confirmed as leader before success is reported                                                                         |
| ReadIndex and lease reads                     | U · I · P     | Leader-lease expiry and stepping down; p50 0.001 ms over 1 000 reads (`AC 41.3`, `AC 41.4`)                                   |
| Snapshots: take, frame, install, compact      | U · I · R · E | 30-byte envelope, CRC32, position, cross-shard rejection                                                                      |
| Restart from a snapshot, single node          | R · E         | The engine, not the log, is the recovery source                                                                               |
| Restart from a snapshot, **whole cluster**    | R · E         | Three processes, snapshots every 15 entries, all killed and restarted: every key returns and the cluster accepts writes again |
| Log compaction and retention limits           | U · I · B · P · M | Enforced bounds, no unbounded growth; retained log 21 → 21 across 300 proposals and 1.0–1.4 KB retained per proposal (`AC 41.5`, `AC 41.6`) |
| Point-in-time recovery                        | U · I         | Records are positioned by Raft index                                                                                          |
| Session and watch APIs                        | U · I · E     | Reads-your-writes, change notification                                                                                        |
| Event bus                                     | U · I · B     | Ordered delivery, backpressure                                                                                                |

### 1.2 Transport and security

| Capability                                        | Verification | Notes                                     |
| ------------------------------------------------- | ------------ | ----------------------------------------- |
| TLS 1.3 with mutual authentication                | I · E        | Real sockets, real certificates           |
| Rogue-certificate rejection                       | I · E        | Handshake refused before any Raft traffic |
| Message framing, CRC, compression                 | U · B        | Corrupt frame is dropped, not misparsed   |
| Connection pool, reconnect storm, circuit breaker | U · B        | 50-proposer storms, pool exhaustion       |
| Shared transport for many shards per node         | U · I        | Per-shard tagging and routing             |

### 1.3 Sharding and high availability

| Capability                              | Verification | Notes                                               |
| --------------------------------------- | ------------ | --------------------------------------------------- |
| Hash, range, consistent-hash placement  | U · I        | Deterministic and stable across rebalances          |
| Online shard migration                  | U · I · E    | Dual-write, cut-over, rollback                      |
| Failover detection and coordination     | U · I · E    | Timeout-based, quorum-checked                       |
| Fencing (stale leader cannot write)     | U · I        | Epoch and lease fencing                             |
| Consistency verification after failover | U · I        | Divergence detection reports, never repairs blindly |

### 1.4 Storage engine SPI

| Capability                               | Verification  | Notes                                                                                     |
| ---------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `IStorageEngine` contract                | C             | 23 checks, run against two structurally different engines                                 |
| Idempotent replay across restarts        | C · R · E     | Duplicate indexes never reach the engine                                                  |
| Forward jumps, no replays                | C · R · E     | Raft skips non-command entries; a jump is applied, a duplicate index is dropped           |
| Apply failure propagates to Raft         | C · U         | Fail-stop rather than silent divergence                                                   |
| Serializable applies                     | C · B         | Concurrent submission stays ordered                                                       |
| Snapshot framing, CRC, shard binding     | C · U · R · E | Truncated / corrupt / foreign snapshots rejected; the frame carries Raft's boundary index |
| Reference engine (`MemoryStorageEngine`) | C · U · E     | Shipped as the adapter template                                                           |

---

## 2. Federation (`@agentix-e/db-federation`)

| Capability                                 | Verification | Notes                                             |
| ------------------------------------------ | ------------ | ------------------------------------------------- |
| CDC capture (engine-agnostic)              | U · I        | `ICDCEngine` with a monotonic LSN                 |
| Outbox-before-send delivery                | U · I · E    | Durable enqueue, then send                        |
| Exactly-once application                   | U · I · E    | Dedup ring keyed by `(origin, lsn)`               |
| Hybrid logical clocks                      | U · I        | Monotonic across skew                             |
| Conflict resolution: LWW, CRDT, custom     | U · I        | Deterministic, tested against divergent histories |
| Multi-leader replication                   | U · I        | Loop suppression, causal ordering                 |
| Merkle anti-entropy repair                 | U · I · B    | Divergence detected and repaired                  |
| Topology epochs and split-brain detection  | U · I        | Fencing old epochs                                |
| Cross-cluster transport over TLS           | I · E        | Two real clusters, real certificates              |
| Channel health, backpressure, pause/resume | U · I · B    | Stalled peer does not stall the cluster           |
| Query routing to a serving cluster         | U · I        | Locality-aware, failure-aware                     |

---

## 3. Operations (`@agentix-e/db-operations-*`)

21 engine-agnostic packages. Every one is bound to an engine only through a provider token,
so it works with any engine that registers the providers it needs.

| Package          | Capability                                            | Verification |
| ---------------- | ----------------------------------------------------- | ------------ |
| `health`         | Liveness/readiness orchestration, dependency graph    | U · I        |
| `metrics`        | Counters, gauges, histograms, sink fan-out            | U · I        |
| `monitor`        | Alert rules, thresholds, de-duplication               | U · I        |
| `backup`         | Full/incremental backup, verification, restore drills | U · I        |
| `security`       | Key rotation, envelope encryption, tamper-evident audit chain | U · I · M |
| `audit`          | Append-only audit storage, query, verification, read and write ports | U · I · M · P |
| `maintenance`    | Maintenance windows, occurrence projection            | U · I        |
| `rollingupgrade` | Rolling upgrade orchestration, health gates           | U · I        |
| `autoscaler`     | Predictive and reactive scaling                       | U · I        |
| `configwatcher`  | Config watching, hot reload, validation               | U · I        |
| `slacollector`   | SLA recording, compliance, violation log, uptime      | U · I        |
| `observability`  | W3C trace context, OpenTelemetry export               | U · I        |
| `circuitbreaker` | Per-dependency breakers                               | U · I · B    |
| `memoryguard`    | Heap pressure, eviction, OOM avoidance                | U · I        |
| `chaosengine`    | Fault injection schedules                             | U · I        |
| `federation`     | Schema federation, repair execution                   | U · I        |
| …and 5 more      | See the operations guide                              | U · I        |

---

## 4. Measured coverage

Vitest v8 coverage, every dimension gated at ≥95 % in CI. Numbers below are from the last
green run of this repository; the gate fails the build if any dimension drops below 95 %.
The gate covers four packages, not three: the end-to-end harness is measured as well,
because a harness bug produces confident, meaningless acceptance passes.

| Package         | Lines  | Statements | Functions | Branches |
| --------------- | ------ | ---------- | --------- | -------- |
| `cluster`       | 99.34% | 99.34%     | 99.68%    | 98.24%   |
| `federation`    | 99.19% | 99.19%     | 99.76%    | 98.52%   |
| `operations`    | 99.46% | 99.46%     | 99.87%    | 98.49%   |
| `e2e` (harness) | 100 %  | 100 %      | 100 %     | 100 %    |

The `e2e` row covers `e2e/harness/support.ts` — process supervision, IPC, port allocation,
log capture. The two `.mjs` programs it spawns (`raft-node.mjs`, `federation-gateway.mjs`)
run in child processes and are therefore _not_ instrumented by the in-process v8 collector;
they are exercised for real by every acceptance test, but no percentage is claimed for them.

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

Both directions are now gated: `pnpm typecheck` proves the published surface compiles,
`pnpm typecheck:tests` proves that what tests it compiles under the _same_ compiler options
(including `noUncheckedIndexedAccess`, which the operations test config used to switch off).
A structural check, `pnpm check:gates`, fails the build if any `tsconfig` in the workspace is
referenced by no script — the exact shape of the defect that hid those 1 192 errors: a
configuration file that looked like a gate and ran nowhere.

---

## 5. What is **not** covered

| Area                                                     | Status                     | Why it matters to you                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-file coverage floor**                              | Gated (from iteration 25)  | The gate enforces the package total and every individual file; a single file below 95 % fails the build. The entry here used to say "partially gated… around a dozen files sit below 95 %" — that described an older gate and had been false since the per-file check was added. |
| **Federation cross-DC fault injection at the TLS layer** | Covered (iteration 24)     | `chaos/tls-fault-injection.test.ts` drives a real listener with real certificates: an untrusted CA is refused, a peer that stops is noticed within a bounded time, a peer that resets is reported, a peer that accepts but never reads cannot hang `send()`, and twenty reconnects leave no timer behind (AC 43.1–43.11). **Not** covered: an active proxy in the middle of an established stream. |
| **Operations process-level acceptance**                  | Partially covered (iteration 35) | The audit write path is now killed for real: `AC81` starts a second process, waits for 120 acknowledgements, sends `SIGKILL`, and every acknowledged entry is readable afterwards; two processes appending to one trail lose nothing (`OS.1`). **Not** covered: a **power cut** — `SIGKILL` leaves the page cache intact, so it proves the line is in the file and cannot prove it reached the medium. The `fsync` half is asserted by order and by failure propagation in-process (`AC80`), and that limit is stated in the user guide rather than implied. Batching did not widen that gap: a burst of concurrent writes is acknowledged by **one** sync, and `GC.8` pins the case with one caller at a time to the same one-sync-per-write it always paid, so the throughput gain is concurrency and not a weaker promise. No other operations package has an out-of-process case yet. |
| **Mutation testing over the rest of operations**         | Partially covered          | All three packages are gated by Stryker in CI (**94.26 %**, **94.10 %**, **98.09 %** as reported, gates at 70, 70 and 86). In operations thirteen of 21 *modules* are mutated, chosen by the selection rule *mutate what decides deletion, durability, or when work runs*; the other 9 have unit, integration and coverage gates but no mutant measures their assertions. In cluster and federation one module each is mutated — the SQLite log and the TLS wire — because those are the two places a green suite can be green for the wrong reason. The rule is published in the roadmap (P2-14), so the next module is a decision rather than a preference. |
| **TLA+ model checking**                                  | Manual                     | The specs exist and run locally; they are not part of CI.                                                                                                                                          |
| **Dependency advisories**                              | Covered                    | `pnpm audit:policy` holds the *production* tree to zero high and critical advisories with no allowlist that can reach it, and requires a named, dated entry for anything in the dev tree — the test toolchain, which cannot always be fixed on the day an advisory lands because a transitive dependency may have no patched release. An entry that matches no advisory fails the gate, so the list cannot rot into an exemption nobody re-read; the two failure modes were checked by removing the entry and by adding a bogus one. |

| **Cross-version upgrade path**                           | Partially covered          | `AC 38.7` opens a database written before the `checksum` column existed, lets `open()` run the migration, and appends and verifies an entry afterwards — the schema half of an N-1 → N upgrade, with real bytes on disk. **Not** covered: a full N-1 → N upgrade crossing the wire and snapshot **formats**, which are versioned but never exercised across versions. |
| **Sustained soak beyond CI limits**                      | Scheduled only             | Multi-hour runs exist (`test:soak`) but do not gate a pull request.                                                                                                                                |
| **Quorum-loss step-down**                                | Not covered (P3-20)        | raft-core 0.2.1 has no check-quorum, so a leader that loses its quorum keeps reporting `isLeader() === true` indefinitely while committing nothing (measured: 16 s, commit index frozen, write refused at 5 028 ms). The product's guarantee — no progress without a majority — holds and is asserted; a *step-down* is not implemented, and the `checkQuorum` / `preVote` options are declared without reaching the library. |
| **Harness `.mjs` child programs**                        | Executed, not instrumented | `raft-node.mjs` and `federation-gateway.mjs` run out-of-process, so the v8 collector cannot see them. Their contract is covered by the harness suite in-process; their internals are not measured. |

Each row is tracked in the roadmap in
[`db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs/blob/main/plan/ROADMAP.md) with
an owner and an exit criterion; none of them is hidden behind a passing badge.

---

## 6. How to reproduce any number on this page

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm check:gates                                     # no orphan configs, no dangling scripts
pnpm typecheck && pnpm typecheck:tests               # static gates, production and tests
pnpm lint && pnpm format:check
pnpm audit:policy                                    # production tree to zero, dev exceptions dated
(cd cluster && pnpm coverage)                        # unit + integration + conformance
(cd federation && pnpm coverage)
(cd operations && pnpm coverage)
pnpm coverage:e2e                                    # e2e harness, same 95 % thresholds
pnpm coverage:gate                                   # all four packages, every dimension
pnpm e2e                                             # 35 real-process TLS acceptance tests
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

**How the mutation score is produced.** Fourteen modules are under mutation testing, chosen by one
rule — *mutate what decides deletion, durability, or when work runs*: durable state
(`cluster/.../SqliteStorage.ts`), the wire (`federation/.../TcpSecureTransport.ts`), what gets
deleted (`operations/.../RetentionPolicyEvaluator.ts`, `operations/.../FileAuditStore.ts`), whether
a backup can be replayed at all (`operations/.../backupChain.ts`,
`operations/.../InMemoryBackupManager.ts`), which key material survives at all
(`operations/.../KeyManager.ts`), which key material survives a rotation
(`operations/.../KeyRotationManager.ts`), which key a blob was sealed with
(`operations/.../EnvelopeEncryptionProvider.ts`), what a cipher does when it is initialised twice
(`operations/.../AES256GCMEncryptionProvider.ts`), when a window runs
(`operations/.../MaintenanceWindowScheduler.ts`), what time it runs at
(`operations/.../cron.ts`), whether a compliance window passed
(`operations/.../RotationAuditor.ts`) and whether evidence is tamper-evident
(`operations/.../AuditLogManager.ts`). Stryker alters the source one change at a
time and runs the tests that cover the change; a change no test notices is a behaviour nothing
constrains. Which edit Stryker made is recorded in `reports/mutation/operations.json`, and
`operations/scripts/replay-mutant.mjs` applies it by that record — a line number is not enough, and
iteration 30 proved it the hard way.

**There is exactly one instrument, and it lives at the root.** Stryker copies `process.cwd()` into a
sandbox and runs the suite inside the copy; that single fact decides where the configuration may live.
Until iteration 36 each package carried its own `stryker.config.json`, so the sandbox was a copy of
*one package* — and both things every test file needs (`tsconfig.base.json`, which Vite reads while
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

| Package | Module | Mutants | Killed | Survived | Score | Threshold |
|---|---|---:|---:|---:|---:|---:|
| cluster | `SqliteStorage.ts` | 507 | 476 | 29 (+1 ignored, 1 runner error) | **94.26 %** | break 70 |
| federation | `TcpSecureTransport.ts` | 271 | 254 (+1 timeout) | 16 | **94.10 %** | break 70 |
| operations | `backupChain.ts` | 66 | 59 (+7 timeout) | 0 | **100 %** | break 86 |
| operations | `InMemoryBackupManager.ts` | 95 | 93 | 1 | **98.94 %** | break 86 |
| operations | `RetentionPolicyEvaluator.ts` | 196 | 172 (+2 timeout) | 0 | **100 %** | break 86 |
| operations | `cron.ts` | 87 | 81 (+6 timeout) | 0 | **100 %** | break 86 |
| operations | `MaintenanceWindowScheduler.ts` | 622 | 602 (+13 timeout) | 6 | **99.03 %** | break 86 |
| operations | `FileAuditStore.ts` | 704 | 664 (+8 timeout) | 21 (+1 error) | **96.97 %** | break 86 |
| operations | `DurableFileSystem.ts` | 74 | 73 | 0 | **100 %** | break 86 |
| operations | `KeyRotationManager.ts` | 239 | 236 | 2 | **99.16 %** | break 86 |
| operations | `RotationAuditor.ts` | 286 | 275 | 7 | **97.52 %** | break 86 |
| operations | `AuditLogManager.ts` | 343 | 323 (+2 timeout) | 10 (+2 no coverage) | **96.44 %** | break 86 |
| operations | `KeyManager.ts` | 139 | 125 (+3 timeout) | 7 (+1 no coverage) | **94.12 %** | break 86 |
| operations | `EnvelopeEncryptionProvider.ts` | 111 | 108 | 2 | **98.18 %** | break 86 |
| operations | `AES256GCMEncryptionProvider.ts` | 81 | 79 | 2 | **97.53 %** | break 86 |

Operations overall: **97.96 %** — 2 890 killed, 41 timed out, 58 survived, 3 with no coverage and one
that crashes the runner rather than failing a test, out of the 2 992 mutants the instrument judges (it
enumerates 3 043 and reports 50 as ignored, because a mutant that runs at import time executes before
any test can be blamed for it). The arithmetic is the gate's own:
`(killed + timeout) / (killed + timeout + survived + no coverage)`.

**Every one of the 41 timeouts has been read** (iteration 40): each was replayed against the tests the
report attributed to it, and `mutation/timeouts.json` records what those tests said — 5 of them fail,
36 report nothing at all and the run does not finish. None of the 41 passes, which is the question the
column could not answer before: a `Timeout` counted towards the score without any test having been
asked. The gate now reads what the file does not already answer, on the spot, and fails only when the
suite *passes* an abort — a score that counted a detection nobody made. See
`docs/maturity.md#the-timeout-column`.

The overall figure is a share of a larger denominator than iteration 37's 98.09 %: `FileAuditStore.ts`
gained 161 mutants with the segment/archive reconciliation, 156 of which are killed.

**Iteration 39 gave that file 161 new mutants and killed 155 of them.** The six that remain are in the
table above with their arguments, and the suite behind them — `AC 90`, 21 cases — fails 15 times when
the two reconciliation calls are removed, which is what makes the argument about the other six worth
reading.

**The twenty-six survivors of `FileAuditStore.ts` were read one by one, and ten of them were real
gaps.** Every one was applied *exactly as the report printed it* and run against the whole audit
suite: all twenty-six stayed green, which is what a survivor means — the suite did not make the
distinction, the instrument did not miss a failure. Each of the ten now has the case it lacked in
`AC 89`, and each of those cases was then re-checked the other way round: put the mutant back and the
named case fails. They are one family in seven shapes, and every shape is a boundary nobody had asked
about:

| Mutant | The observation that was missing | Case |
| --- | --- | --- |
| `typeof error !== 'object'` → `false` in `isAlreadyExists` | `undefined` is the only input where reading `.code` off it throws instead of answering `false`; `null` is caught by the second disjunct and a string answers `undefined` | `SV.1` |
| `retentionDays ?? DEFAULT` → `&&` | a window given as `2`: the suite had only ever passed `0` (disables) or `90` (the default), and `??` and `&&` agree on both | `SV.2` |
| the default `claim` → `() => undefined` | the claim was only ever observed *after* the append that followed it — a store that claimed nothing passed `SC.5`, because the file the second store found was the one the first store's append had just created | `SV.3` |
| `activeSegmentClaimed && needsSeparator(...)` → `true` (and → `\|\|`) | a separator owed by an *adopted* segment that ends cleanly: `DW.8` asserts the owed case and `DW.3` the store's own segment, and the parser skips a blank line, so only the bytes can tell | `SV.4` |
| `attempt < CLAIM_ATTEMPTS` → `<=`, and the second half of the failure message → `''` | the eighth attempt, counted; and the sentence that says what eight means — a loop that ran nine times and a message that stopped explaining the bound both passed | `SV.5` |
| `i < covered && …` → `true` (and `i <` → `i <=`) | a failure on the *first* sync of a batch: `GC.5` fails the second, where the generation test rejects the rest on its own, so the count of covered commits was never load-bearing | `SV.6` |
| `mtime === null` → `false` in `pruneOlderThan` | a segment name the prune cannot date — the rule `EX.1` states for the retention sweep, at the boundary a caller chooses | `SV.7` |

Two survivors were not gaps at all, they were **dead assignments**, and they were deleted rather than
defended: `rotate()` reset `currentSize`, `currentCreatedAt` and `separatorOwed`, and the claim that
follows sets all three — so the second write always agreed with the first and no run could tell them
apart; and `activeSegmentClaimed` carried a `= false` initializer that the constructor overwrites. The
file is 543 mutants instead of 545 for that reason, and 97.37 % instead of 95.13 % because ten of what
remained are now killed.

The other fourteen are **equivalent**, and each has an argument rather than a test:

| Survivor | Why nothing can distinguish it |
| --- | --- |
| `name > newest` → `>=` in `newestOpenSegment` | `readdir` cannot return a name twice; when the strings are equal the assignment writes the value already there |
| `?? []` in `sweepAbandonedArchives` → a foreign name | the loop keeps names that start with `<prefix>-` and end with `.ndjson.gz.part`; a foreign name removes nothing and the count is `0`, exactly as for an empty list |
| `?? []` in `getNextSequence` → a foreign name | the regex cannot match it, so `maxSeq` stays `0` and the answer is `0001` — the same as for an empty list |
| `if (!this.activeSegmentClaimed) return false` in `shouldRotate` → `true`, and → `false` | `rotate()` reads no file when the store has no name: `fileIdentity('')` throws `ENOENT`, which it catches. The two smaller tests would then be asked with `currentSize === 0` and an age measured from construction, and both can only answer true for a zero threshold — after which `rotate()` is the same no-op |
| `this.activeFilePath = ''` in `rotate` → any name | every read of it is guarded by `activeSegmentClaimed`: `appendLine` claims before it appends, `shouldRotate` returns on the unclaimed state, and the next claim overwrites it. There is no suspension point in between |
| `if (!fileIdentity(oldPath)) return` in `rotate` → `false` | `archiveSegment` opens with the identical check and returns before it compresses, so the only difference is a scheduled job that does nothing |
| `if (this.flushScheduled) return` → `false`, and `this.flushScheduled = true` → `false` | a second schedule in one turn produces a second `setImmediate` that calls `flush()` on an empty queue, which returns at its first line. The flag's entire effect is the absence of a no-op |
| `if (this.pendingCommits.length === 0) return` → `false` | an empty batch syncs nothing: `highest` is `-1`, `durableDirectoryGeneration` starts at `-1` and only rises, and both loops are over an empty array |
| `let synced = ''` → any name | the initial value is compared with an absolute path inside the data directory, so the first commit of a batch syncs either way and `synced` is overwritten immediately |
| `let highest = -1` → `+1` | a commit's generation *is* its segment's generation, so the newest commit in a batch is always at least the current one and the initial value cannot be the maximum |
| `?? ''` in `readSegment`, and `return ''` in its `catch` → any text | the text reaches a parser that accepts nothing but NDJSON, so every alternative contributes zero entries — which is the property that let the `null` sentinel be deleted in iteration 34 |

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

| What the runner did | Count | What it means |
|---|---:|---|
| Hit-limit abort (`statusReason: Hit limit reached (n/100×m)`) | 33 | the vitest runner counts how often a mutant executes and abandons the run at a hundred times the original's count — a *guess* at non-termination made from an execution count |
| Wall-clock timeout | 8 | `timeoutFactor × netTime + 30 s` elapsed |

| What the suite said when it was asked again | operations | federation | cluster |
|---|---:|---:|---:|
| `failed` — vitest reported a failing test | 5 | 0 | 0 |
| `stuck` — nothing reported, the run never finished | 36 | 1 | 0 |
| `survived` — the suite passed it | **0** | **0** | **0** |

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

| Target | Slowest case | Where it comes from | Budget |
|---|---:|---:|---:|
| cluster | 2 120 ms | `SqliteStorage.handle-lifecycle` | 9 s |
| federation | 2 479 ms | `chaos/tls-fault-injection` (a delay, injected on purpose) | 10 s |
| operations | 3 665 ms | `AC75-work-factor` (scrypt at four work factors, on purpose) | 15 s |

Eighteen of the 59 aborts this target used to report are now kills: the budget expires before the
runner's cap, so the test is the party that fails. The cluster config's justification said "its slowest
case is under 100 ms", which had stopped being true — the number was 2 120 ms — and the gate now fails
when a mutation config inherits a budget instead of declaring one, or declares one at or above the cap.

`check:gates` cannot check a *measurement*, so the derived numbers live in the configs with the
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

| The observation that was missing | Where it is now |
| --- | --- |
| **When the bytes are forced out.** Three writes inside `beginBatch` opened zero descriptors; `endBatch` opened one; batch mode ended with the batch; `persistReady`'s three-entry transaction synced once, not three times; every truncation path and `setKv` forced its own | `AC 38.3` |
| **Which file a sync touches.** `fsync` truncates the WAL, syncs the main file, closes its descriptor and nothing else; `fsyncWAL` opens `-wal` and never the main file; a refused sync is logged with its own name rather than thrown | `AC 38.4`, `AC 38.5` |
| **What a failed open leaves behind.** A throwing `onOpen` used to leave a handle nobody could reach, `isOpen` answering true and a locked file — now rolled back, with the statements dropped and the error rethrown | `AC 38.1`, `AC 38.6` |
| **Whether a database from an older build still opens.** The `ALTER TABLE` for the checksum column had never run against a table that predated it, so both the migration and its guard were untested | `AC 38.7` |
| **What a damaged database reports.** `every` vs `some` over `integrity_check`, the failing rows in the message, the separators between them, and the retry verdict | `AC 38.8` |
| **Which defaults actually reached SQLite.** `synchronous`, `wal_autocheckpoint`, `foreign_keys`, `busy_timeout` and `maxLogSize` were computed and then never read back — and `pragma(name, value)` was never asserted to have written anything | `AC 38.2` |
| **The auto-compaction boundary.** A limit of `0` means "no limit" rather than "compact always"; a snapshot index of `0` is not a reason to compact; a log exactly at the limit is not past it | `AC 38.12` |
| **The wire frame, field by field.** The transport's own suite asserted `send` had been called, not what it carried — the message id, the source peer, the `federation_send` type, the payload bytes and the BigInt wall clock encoded as a string | `AC 47.1` |
| **A configuration that cannot be addressed.** Two peers sharing a wire id, a peer sharing this node's, an id with no number in it, `peers: []` falling through to the address list, and a legacy address with no host or no port | `AC 47.3`–`AC 47.5` |
| **The retry schedule as a schedule.** `maxRetries` attempts double, attempt `maxRetries + 1` is capped — asserted on `retryDelayMs()` instead of by timing a timer | `AC 47.6` |
| **What a refused send costs.** An unknown peer arms no timer, a reachability refusal comes from the live check before the lagging snapshot, and `broadcast` counts deliveries rather than attempts | `AC 47.2`, `AC 47.9`–`AC 47.11` |

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

| Survivor(s) | Why nothing can distinguish it |
| --- | --- |
| `if (!fs.existsSync(dir))` → `true` | `mkdirSync(recursive: true)` on an existing directory is a no-op |
| `handle?.close()` → `handle.close()` | `handle` is the value assigned one statement earlier, so it is never nullish |
| the `checkpoint('PASSIVE')` guard and its mode in `close()` | the handle is closed either way, and SQLite checkpoints on close; `wal_checkpoint()` with no argument is `PASSIVE` |
| `if (!this.db) return` in `initStatements` | every call is inside `open()`, after the handle is set |
| `queue.length >= maxBatch` → `true`, `if (this.groupCommitTimer)` → `true`/`false`/`{}`, `clearTimeout` → `;`, `if (!this.groupCommitTimer)` → `true` | a flush of an empty queue returns at its first line, so a surplus timer or a surplus flush syncs nothing; `clearTimeout(null)` and `Map.delete` of an absent key are no-ops |
| `unref()` → `;` | it changes whether the event loop stays alive, which no test observes and the runner decides |
| `let batch = []` → a foreign element, `queue = []` → a foreign element | the initial value is overwritten by the mutex callback before it is read; the queue variant replaced by a foreign element throws inside a timer callback, which is the runner error this file records rather than a verdict |
| `if (batch.length === 0) return` → `false` | an empty batch syncs a database that has nothing to sync — same bytes, one extra call |
| `?.minIndex`, `?.count`, `countRow?.count`, `row?.minIndex`, `row?.count` | `MIN`, `COUNT` and `LIMIT 1` over a non-empty table always return a row; over an empty one `MIN` answers `null`, which the `?? 0` behind it handles |
| `if (hardStateBuf)`, `if (metaBuf)`, `if (meta.hardState)` → `true` | `JSON.parse(buf.toString())` on `null` throws into the `catch` that already exists, leaving the field unset |
| `ready.entries.length > 0` → `true`/`>= 0`, same for `committedEntries` | the `ready.entries &&` in front of the operand still guards the loop; an empty list iterates zero times |
| `this._batchMode = true` → `false` in `persistReady` | inside a `better-sqlite3` transaction every `fsync()` fails with `SQLITE_BUSY` and is caught by its own handler, so the per-entry syncs the flag suppresses would not have reached the file anyway |
| `if (fromIndex > lastIndex) return []` → `false` | the range query answers `[]` for the same input, which is what the guard was returning |
| `if (existing)` → `true`, `_retryTimers.delete()` → `;` | `clearTimeout(undefined)` is a no-op, and the entry is overwritten by the `set` two lines later |
| `getStatus?.()?.connectedPeers.includes(id)` variants | the refusal below it reads the same snapshot directly, so a wrong `reachable` is corrected one statement later |
| `if (peers.length === 0) return 0` → `false` | `allSettled([])` is `[]`, and the filter of an empty array is `0` |
| `r.status === 'fulfilled'` → `true` in the broadcast filter | `true && r.value` is `r.value`: a rejected settlement has no `value`, so it is still not counted |
| `/^\d+$/` → `/\d+$/` and → `/^\d+/` | `Number('abc12')` and `Number('12abc')` are `NaN`, and `logicalByNumeric.has(NaN)` is false, so both fall through to the string form |
| `messageHandlers.clear()` → `;` in `destroy()` | `destroy()` calls `stop()` first, which detaches the bridge; there is no subscriber left to iterate |
| `if (digits.length === 0) return null` → `false`, and `?? ''` → any text in `extractPort` | `parseInt('')` and `parseInt('Stryker was here!')` are both `NaN`, which the `Number.isNaN` behind them maps to the same `null` / `7000` |
| `host && host.length > 0` → `host || …`, `> 0` → `>= 0`, `?:` → `true` | the `host &&` outside the comparison already rejects the empty string, so the condition is never the only thing standing between `''` and the answer |

The previous version of *this* section also said every number here was a floor. That claim is
withdrawn for a different reason, and the way it was withdrawn matters: iteration 35 argued that
`--inPlace` let four workers share one source tree, so a worker's vitest could read a file another
worker had already restored. The *symptom* was real, but the hand application was not the edit the
report printed — the report said `false || mtime >= cutoff` and what was applied was
`if (false) continue;`, which is a *stronger* change. Applying the printed replacement left all 162
tests green: the `mtime === null` arm had never been tested. The rule that came out of it is now part
of the review habit: **apply the replacement the report prints, never a stronger one.** A survivor is
either a missing assertion or an equivalent mutant, and both are provable; "the runner is wrong" is
not a third option. The headline moved for reasons that are worth separating: modules joined the list
(`AES256GCMEncryptionProvider` at 97.53 %, `DurableFileSystem` at 100 % on its first measurement) and
the weakest improved because their defects were fixed rather than excused —
`EnvelopeEncryptionProvider` 90.38 → 98.18 %, `KeyManager` 86.60 → 94.12 %, and `FileAuditStore`
97.05 → 98.85 % when its durable-write recipe stopped being unobservable. Every one of the fourteen mutants that changed verdict
in those two files was a *behaviour* the suite did not constrain, and reading them produced the four
concurrency defects recorded in the changelog: a version number that two mints could share, eight
keys minted for eight concurrent first writes, a header naming a version the payload was not sealed
with, and a wipe that an in-flight mint undid.

The composition of what remains is now almost entirely two families: memory wipes (nine mutants) and
encoding and separator defaults (`'utf-8'` → `''`, `'|'` → `''`, `?? ''` → any text). The third family
— the durability recipe in `FileAuditStore.writeLine`, five mutants that no test could reach — is
gone: iteration 34 put the recipe behind a four-operation port, which made the *order* assertable, and
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

| Module | Surviving mutant | Why no test can distinguish it |
| --- | --- | --- |
| `InMemoryBackupManager` | `state: 'in-progress'` → `state: ''` | the same method sets `completed` before it returns, so the interim value is never observable |
| `MaintenanceWindowScheduler` | `cursor.setUTCHours(...)` → `setUTCMinutes(...)` | the cursor's *month* is what drives the loop; every candidate is built from explicit year/month/day and `startTime`, and the ones the moved cursor would skip have already failed `candidateMs >= fromMs` |
| `MaintenanceWindowScheduler` | `cursor.setUTCDate(1)` → `cursor.setTime(1)` | the cursor jumps to 1970 and walks every month to the range; all those candidates are before `fromMs`, so the answer is the same and only the walking is wasted |
| `MaintenanceWindowScheduler` | `while (cursorMs < toMs)` → `<=` (monthly) | at equality no candidate is `< toMs`, so the extra month contributes nothing |
| `MaintenanceWindowScheduler` | `day > lastDay` → `day >= lastDay` | at `day === lastDay` both branches produce `lastDay` |
| `MaintenanceWindowScheduler` | `while (cursor.getTime() < toMs …)` → `<=` (cron) | as above, for the minute scan |
| `MaintenanceWindowScheduler` | `iterations < maxIterations` → `<=` | one extra minute inside a 100 000-minute safety bound; only an expression that matches every minute for 69 days could see it, and that projection allocates 100 000 instances |
| `KeyRotationManager` | `success: false` → `true` in the event template | every exit assigns it: the success path sets `true`, the `catch` sets `false`, and there is no third way out |
| `KeyRotationManager` | `default:` arm of `_isDue` removed | the fall-through returns `undefined`, and the caller asks a yes/no question — `undefined` is not due, which is what `return false` says |
| `FileAuditStore` | `name > newest` → `>=` | `readdir` cannot return the same name twice, so the two comparisons select the same name |
| `FileAuditStore` | `?? ''` in `readSegment`, and the `return ''` in its `catch` → any text (two mutants) | the replacement text reaches a parser that accepts nothing but NDJSON, so every alternative contributes zero entries — which is the property that let the `null` sentinel be deleted this iteration |
| `FileAuditStore` | `isUnlinkRefusal(error)` → `true` | no runner can make `unlink` fail for a reason outside the four listed codes — a process running as root is never refused — and the rule itself is asserted by `DW.12`, which is why it is a predicate rather than a list inside a `catch` |
| `FileAuditStore` | `rmSync(gzPath, { force: false })` | detected as a **crash**, not as a failing test: without `force` the cleanup rejects inside a `catch` whose promise nothing awaits, and the runner dies with it — which is the unhandled rejection the flag prevents |
| `FileAuditStore` | `'at-rest'` → `''` on the reconciliation's call to `repairFor` | the function asks `when === 'live'`, so every value that is not `'live'` takes the at-rest path — the parameter is a union of two names for readability, and the distinction it encodes is one predicate |
| `FileAuditStore` | `else if (repair === 'promote')` → `else if (true)` in the sweep | the only verdicts that reach that branch are `none`, `release` and `promote`, and on a runner that reads as root a name that exists and yields no text cannot be produced — the cell is asserted through `repairFor`'s table (`SH.21`) rather than through a directory |
| `FileAuditStore` | `if (repair === 'promote')` → `if (true)` in the live path | as above: with an archive present, `none` and `plain-unreadable` are the only other verdicts, and the second one is unreachable without a file the runner cannot read |
| `FileAuditStore` | `if (!isRegularFile(archivePath)) return` in the live path → `false` | `relateTwin` answers `no-twin` for an archive that is not there, so the guard changes only how many bytes are read — and the bytes it prevents reading are the *whole active segment*, which is why it stays |
| `FileAuditStore` | `this.activeFilePath = ''` in `releaseActiveFile` and in `rotate` → any string | the name is re-derived by the claim that the next append makes before it uses one; both assignments exist to keep "an unclaimed store names nothing" true, and no reader observes the intermediate value |
| `RotationAuditor` | `hash: ''` placeholder → any string | the placeholder is overwritten by `_hashEntry` before the entry is stored, and `hash` is not part of the hashed content |
| `RotationAuditor` | `firstCompletedAt !== null && lastCompletedAt !== null` → `\|\|`, or → `true` (three mutants) | both are derived from the same list, so they are null together and non-null together; with neither, `null - null` is `0`, which is what the ternary returns |
| `RotationAuditor` | the `\|` separator in `_hashEntry` → `''` | the separator is a free choice: any fixed string produces the same chain. Only a deliberate concatenation collision could tell them apart, and `seq` is a number between two fixed-width fields |
| `AuditLogManager` | `'utf-8'` in `createHash().update()` and in `appendFileSync` → `''` (two mutants) | `''` is falsy, so Node falls back to the same default encoding |
| `AuditLogManager` | `sortBy ?? 'timestamp'` → `''`, `sortDir ?? 'asc'` → `''` | the default only matters when the field is absent, and `''` matches none of the other branches, so it takes the same `timestamp` / `cmp` path |
| `AuditLogManager` | `a.seq - b.seq` → `a.seq + b.seq` | the event log is append-only, so it is always already in sequence order; a comparator that returns a consistent positive sign cannot reorder it, in either direction |
| `AuditLogManager` | `if (limit <= 0) return []` → `limit < 0` | for `limit === 0` the `slice` below returns the same empty array |
| `AuditLogManager` | `events.length - drop > maxEvents` → `>=` | the assignment that follows sets `drop` to `events.length - maxEvents`, which at equality is the value it already has |
| `AuditLogManager` | `if (this.flushTimer)` in `destroy()` → `true` | `clearInterval(null)` is a no-op and the field is nulled either way |
| `KeyManager` | `existing.key.length === dek.length &&` → `true` | `Buffer.equals` compares lengths itself, so the test could not be told from its absence — the line was deleted rather than excused |
| `KeyManager` | `if (err) reject(err)` → `if (false)` (and the `reject` call itself, which no test covers) | the branch is **unreachable**: `crypto.pbkdf2` reports an unusable digest or work factor by throwing synchronously, and the promise executor turns that into the rejection. AC 75.21 observes the rejection from `generateKey` — with the branch present and with it disabled — so the two verdicts are the same rejection from different frames. Kept because the callback signature can report an error in principle, and resolving with `undefined` would fail one frame later with a message nobody could act on |
| `KeyManager` | `this.kekCache.get(oldest)?.fill(0)` → `.fill(0)` | the entry was read from the same map one statement earlier and nothing between them can remove it |
| `KeyManager`, `EnvelopeEncryptionProvider`, `AES256GCMEncryptionProvider` | every `fill(0)` on key material, and the `try`/`finally` blocks that hold them (nine mutants) | wiping a buffer cannot be observed by an assertion inside the same process (P2-19). Every one of these buffers has exactly one reference — the history, map or local being cleared on the next line — and the accessors (`getKey`, `getCurrentKey`) hand out copies, so no caller holds the buffer being wiped. It is a *testability* limit, not a permission to stop wiping |

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

| Recorded survivor | What a caller would have noticed | Killed by |
| --- | --- | --- |
| `(stats.eventsBySeverity[s] \|\| 0)` → `false` | every severity bucket reported one event, whatever it held | AC 73.1 |
| `${expectedSeq + i}` → `${expectedSeq - i}` in the gap message | the second and later gaps blamed the wrong number | AC 73.2 |
| `flush()`'s empty-buffer guard → `false` | flushing an idle manager appended a blank line to an NDJSON trail | AC 73.3 |
| `actual.ino !== expected.ino` → `false` | a different file of the same length was deleted as if it were the measured one | AC 73.12 |
| `[...DATA_KEY_BYTES].join(', ')` (two mutants) | the error message lost the list it exists to state | AC 73.4 |
| `iterations < 1` → `<= 1` | `iterations: 1` was refused | AC 73.5 |
| `version > highestVersion` → `true` in `loadKey` | importing an old key lowered the next minted version | AC 73.6 |
| `ciphertext.length <= HEADER_PREFIX_LENGTH` (two boundaries) | a blob that has a header was reported as short | AC 73.9, 73.10 |
| `data.length <= 12 + 16` | the only empty ciphertext the provider can produce became undecryptable | AC 73.11 |

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
quieter, and each row above says *why* the mutant cannot be seen rather than *that* it probably
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
two of them, with `SqliteError: disk I/O error` from `pragma journal_mode = WAL`, and a *different* test
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
first hint, and the 132 survivors were the rest. Reading them (see *The two product targets, read the
same way* above) took the same target to **94.26 %** — 476 killed, 29 equivalent, one runner error — with
a run time of 1 m 35 s, because a suite that fails fast costs less than one that waits to be killed.

**How the performance numbers are produced.** Every latency case goes through
`src/testing/latency.ts`: an explicit warmup window that is discarded, then nearest-rank
percentiles over the recorded samples — no interpolation, and an empty sample set is an error
rather than a zero. The cluster benchmarks start three real nodes over mTLS and propose through
`RaftAdapter`, one file at a time, because a benchmark that shares cores with another benchmark
is not measuring the middleware. Representative numbers from this machine:

| Metric | Value |
|---|---|
| `proposeAndWait` p50 / p99 (n = 200) | 1.09–1.39 ms / 3.5–4.6 ms |
| Sequential throughput | 712–874 ops/s |
| `readIndex` / `leaseRead` p50 (n = 1 000) | 0.001 ms |
| Retained log after 300 proposals (default threshold) | 21 entries |
| Retained heap per proposal | 1.0–1.4 KB |
| Concurrent (8 in flight) versus sequential | 0.42–0.43× — see P1-5 in the roadmap |

**A convergent property cannot be read at an instant.** CI run `44225232372` failed the benchmark
job on `AC 29.2`: `expected [ null, 2, null ] to deeply equal [ 2, 2, 2 ]`. That is neither a flake
nor a product bug. raft-core's `becomeLeaderUnlocked` sets `state = Leader` and
`currentLeader = self`, *then* appends the no-op entry, *then* starts the heartbeat timer — and
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
`TestCluster.awaitLeaderAgreement()` built on them. The contract is pinned by twenty-two cases
(`AC 45.1`–`AC 45.13`, `AC 46.1`–`AC 46.9`), most of them driven by an injected clock, so deadline
behaviour is tested exactly and in microseconds — and the three that are not are there on purpose,
because a primitive whose real clock and real sleep are never executed is a primitive shipping its
test double:

| Property | Why it is the contract |
|---|---|
| The deadline bounds waiting, not looking | a check skipped for want of time reports "not converged" about a property nobody read |
| A read started inside the budget counts | an RPC that returns late still answered the question that was asked in time; discarding it makes the outcome a function of scheduler latency |
| A throwing read is retried, and remembered | during an election a peer may not answer; "timed out" must not hide a broken transport |
| The failure carries the observation | `attempts=2 last observed: [null,2,null]` separates a lagging follower from a cluster that never elected anyone |
| Readers of a round are read concurrently | three sequential reads observe three moments and call the difference a fault |

Three consequences, each measured rather than argued. `AC 29.2` now agrees in two rounds (54–68 ms),
which is one heartbeat and exactly what the protocol implies. `AC 7.2` dropped its 2 000 ms sleep for
a bounded agreement, runs in **502 ms**, and asserts something stricter than before. And `FC.4` —
which had asserted that no node may *claim* leadership when one of three survives — turned out to
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
