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
| `security`       | Key rotation, audit log, tamper-evident hash chain    | U · I        |
| `audit`          | Append-only audit storage, query, verification        | U · I        |
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
| `operations`    | 99.42% | 99.42%     | 99.86%    | 98.13%   |
| `e2e` (harness) | 100 %  | 100 %      | 100 %     | 100 %    |

The `e2e` row covers `e2e/harness/support.ts` — process supervision, IPC, port allocation,
log capture. The two `.mjs` programs it spawns (`raft-node.mjs`, `federation-gateway.mjs`)
run in child processes and are therefore _not_ instrumented by the in-process v8 collector;
they are exercised for real by every acceptance test, but no percentage is claimed for them.

Coverage is a _floor_, not an achievement: a line can be executed by a test that asserts
nothing. The suites above are written to fail when behaviour changes, and bug-hunting is an
explicit goal of each iteration (see the audit reports in the companion repository).

### 4.1 The suite is compiled too

Vitest strips types with esbuild; it does not check them. For a long time that meant the
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
| **Operations process-level acceptance**                  | Not covered                | Operations packages are verified in-process; there is no run that kills a process mid-backup.                                                                                                      |
| **Mutation testing over the rest of operations**         | Partially covered          | All three packages are gated by Stryker in CI (74.4 %, 77.1 %, 98.18 %, gates at 70, 70 and 86). In operations nine of 21 packages are mutated, chosen by the selection rule *mutate what decides deletion, durability, or when work runs*; the other 12 have unit, integration and coverage gates but no mutant measures their assertions. The rule is published in the roadmap (P2-14), so the next module is a decision rather than a preference. |
| **TLA+ model checking**                                  | Manual                     | The specs exist and run locally; they are not part of CI.                                                                                                                                          |
| **Cross-version upgrade path**                           | Not covered                | The wire and snapshot formats are versioned, but no test exercises an N-1 → N upgrade.                                                                                                             |
| **Sustained soak beyond CI limits**                      | Scheduled only             | Multi-hour runs exist (`test:soak`) but do not gate a pull request.                                                                                                                                |
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
(cd cluster && pnpm coverage)                        # unit + integration + conformance
(cd federation && pnpm coverage)
(cd operations && pnpm coverage)
pnpm coverage:e2e                                    # e2e harness, same 95 % thresholds
pnpm coverage:gate                                   # all four packages, every dimension
pnpm e2e                                             # 35 real-process TLS acceptance tests
pnpm test:mutation                                   # mutation score, all three packages
(cd cluster && pnpm test:perf)                       # 22 benchmarks on a real 3-node TLS cluster
pnpm verify                                          # all of the above, in order
```

The benchmark suite runs on GitHub runners from `.github/workflows/benchmark.yml`; results
are attached to each run so a regression is visible next to the change that caused it. The
same suite runs on every pull request as the `benchmark` job in `ci.yml`, because a benchmark
nobody calls is a benchmark that stays broken.

**How the mutation score is produced.** Eleven modules are under mutation testing, chosen by one
rule — *mutate what decides deletion, durability, or when work runs*: durable state
(`cluster/.../SqliteStorage.ts`), the wire (`federation/.../TcpSecureTransport.ts`), what gets
deleted (`operations/.../RetentionPolicyEvaluator.ts`, `operations/.../FileAuditStore.ts`), whether
a backup can be replayed at all (`operations/.../backupChain.ts`,
`operations/.../InMemoryBackupManager.ts`), which key material survives a rotation
(`operations/.../KeyRotationManager.ts`), when a window runs
(`operations/.../MaintenanceWindowScheduler.ts`), what time it runs at
(`operations/.../cron.ts`), whether a compliance window passed
(`operations/.../RotationAuditor.ts`) and whether evidence is tamper-evident
(`operations/.../AuditLogManager.ts`). Stryker alters the source one change at a
time and runs the tests that cover the change; a change no test notices is a behaviour nothing
constrains. There is one instrument: the three hand-rolled engines the operations package carried
until iteration 26 are gone, and `check:gates` now fails if a `test:mutation` script is not
invoked by a workflow.

| Package | Module | Mutants | Killed | Survived | Score | Threshold |
|---|---|---:|---:|---:|---:|---:|
| cluster | `SqliteStorage.ts` | 510 | 356–359 (+19 timeout) | 130–133 | **73.8–74.4 %** | break 70 |
| federation | `TcpSecureTransport.ts` | 260 | 208 (+1 timeout) | 56 (+6 no coverage) | **77.1 %** | break 70 |
| operations | `backupChain.ts` | 66 | 59 (+7 timeout) | 0 | **100 %** | break 86 |
| operations | `InMemoryBackupManager.ts` | 94 | 92 (+1 timeout) | 1 | **98.9 %** | break 86 |
| operations | `RetentionPolicyEvaluator.ts` | 174 | 172 (+2 timeout) | 0 | **100 %** | break 86 |
| operations | `cron.ts` | 87 | 80 (+7 timeout) | 0 | **100 %** | break 86 |
| operations | `MaintenanceWindowScheduler.ts` | 621 | 602 (+13 timeout) | 6 | **99.0 %** | break 86 |
| operations | `FileAuditStore.ts` | 304 | 288 (+7 timeout) | 9 | **97.0 %** | break 86 |
| operations | `KeyRotationManager.ts` | 238 | 233 (+3 timeout) | 2 | **99.2 %** | break 86 |
| operations | `RotationAuditor.ts` | 282 | 275 | 7 | **97.5 %** | break 86 |
| operations | `AuditLogManager.ts` | 337 | 320 (+2 timeout) | 13 (+2 no coverage) | **95.6 %** | break 86 |

Operations overall: 2 203 judged mutants, 98.18 %. The score is 0.68 points below iteration 29's
98.86 % because the two hardest modules in the package joined: one behaves differently depending on
what the filesystem says, the other is a hash chain whose interesting failures are the ones an
attacker causes. The number to compare is the survivor count — 38, of which 24 are equivalent for a
stated reason and 4 are killed by the suite when the mutation is applied by hand.

The operations floor is higher than the other two because the mutated surface is pure decision
logic with no sockets and no clock of its own: a surviving mutant there is almost always a missing
assertion rather than a verdict that depends on the machine.

The survivors were read one by one, and every one of the seven is equivalent:

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
| `FileAuditStore` | the outer `maxScanLines` break in the segment loop | leaving it out reads files it then refuses to take entries from: the answer is identical, only the I/O differs — and a read is not observable from inside the process |
| `FileAuditStore` | `if (array === null) continue` for a legacy `.json` segment | without it, `JSON.parse(null)` yields `null`, `for … of null` throws, and the `catch` on the next line skips the file — the same outcome by a longer route |
| `FileAuditStore` | `'.tmp'` appended to the temp path → `''` | writing the full content straight onto the segment produces the same bytes; only a crash *between* the write and the rename could tell the two apart, and a test process does not crash |
| `FileAuditStore` | `open`/`fsync`/`close` in the durable-write block, and the `try` around them | these are the durability recipe: `fsync` before `rename` is what survives a power loss. No in-process assertion can observe a power loss, which is why the block is registered as P2-19 rather than claimed as covered |
| `RotationAuditor` | `hash: ''` placeholder → any string | the placeholder is overwritten by `_hashEntry` before the entry is stored, and `hash` is not part of the hashed content |
| `RotationAuditor` | `firstCompletedAt !== null && lastCompletedAt !== null` → `\|\|`, or → `true` (three mutants) | both are derived from the same list, so they are null together and non-null together; with neither, `null - null` is `0`, which is what the ternary returns |
| `RotationAuditor` | the `\|` separator in `_hashEntry` → `''` | the separator is a free choice: any fixed string produces the same chain. Only a deliberate concatenation collision could tell them apart, and `seq` is a number between two fixed-width fields |
| `AuditLogManager` | `'utf-8'` in `createHash().update()` and in `appendFileSync` → `''` (two mutants) | `''` is falsy, so Node falls back to the same default encoding |
| `AuditLogManager` | `sortBy ?? 'timestamp'` → `''`, `sortDir ?? 'asc'` → `''` | the default only matters when the field is absent, and `''` matches none of the other branches, so it takes the same `timestamp` / `cmp` path |
| `AuditLogManager` | `a.seq - b.seq` → `a.seq + b.seq` | the event log is append-only, so it is always already in sequence order; a comparator that returns a consistent positive sign cannot reorder it, in either direction |
| `AuditLogManager` | `if (limit <= 0) return []` → `limit < 0` | for `limit === 0` the `slice` below returns the same empty array |
| `AuditLogManager` | `events.length - drop > maxEvents` → `>=` | the assignment that follows sets `drop` to `events.length - maxEvents`, which at equality is the value it already has |
| `AuditLogManager` | `if (this.flushTimer)` in `destroy()` → `true` | `clearInterval(null)` is a no-op and the field is nulled either way |

**Five survivors are not equivalent and are not missing assertions either.** They are mutants the
suite kills when the change is applied by hand, which the runner reports as surviving because it
judges a mutant with only the tests it attributes to that statement. The first was found in
iteration 29 (`unlinkIfUnchanged`, AC 52.13 and AC 67.31); iteration 30 found four more in
`AuditLogManager`, each by applying the change and running the 843-case mutation suite:

| Mutant | Killed by hand | Attributed tests |
| --- | --- | --- |
| `if (!event.success) stats.failedEvents++` → `if (false)` | 2 tests fail (`AC 70.6`, `AUD4: Statistics`) | 2 |
| `expectedSeq + i` → `expectedSeq - i` | 10 tests fail | 3 |
| `if (maxAgeMs > 0)` → `if (false)` | 4 tests fail (`AC 68.6`, `AC 68.8`, `AC 70.11`) | 79 |
| `if (maxEvents > 0 && …)` → `if (true)` | 6 tests fail | 72 |

The common shape is a condition whose *false* branch is what a test would assert: the killing test
takes the branch the mutant removes, and the statement the runner attributes to the mutant is the
one inside the branch, which that test never executes. `AC 70.11` is the clearest case — it asserts
that an event sitting exactly on the age limit survives, which is precisely the branch `maxAgeMs > 0`
guards, and the runner had already stopped counting it. Registered as **P2-18** with five data
points; until the attribution is understood, the score above is the conservative one.

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
three points below the observed value rather than one. The movement is not noise in the product: it
comes from the 19 mutants that time out, whose verdict depends on how much of the runner the four
test-runner processes get that minute. A threshold tight enough to catch that movement would fail on
a busy CI machine and teach people to ignore it.

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
