# Maturity and test coverage

This page is the honest answer to two questions a team asks before adopting middleware:
**what does it actually do**, and **how is each part verified**. It is generated from the
same evidence the CI gate enforces, and it lists what is *not* covered as explicitly as what
is. A capability with a gap is more useful to you than a claim without one.

Legend for the coverage column — test types actually executed against the feature:

| Code | Meaning |
|---|---|
| **U** | Unit: the component in isolation, branches and error paths included |
| **I** | Integration: real components wired together, in-process |
| **C** | Conformance: the published contract suite (`runEngineConformance`) |
| **B** | Boundary: concurrency, storms, 5 000-entry floods, resource limits |
| **L** | Linearizability: history checked with a Wing-Gong style register model |
| **E** | End-to-end: **separate OS processes over TLS 1.3 with mutual authentication** |
| **P** | Performance: a benchmark that runs on a GitHub runner and fails on regression |
| **R** | Recovery: crash, restart, snapshot install, log truncation |

---

## 1. Cluster (`@agentix-e/db-cluster`)

### 1.1 Consensus core

| Capability | Verification | Notes |
|---|---|---|
| Leader election, pre-vote, check-quorum | U · I · E | Real elections in 3- and 5-node TLS clusters |
| Log replication, commit index, apply ordering | U · I · L · E | Every entry applied in index order on every node |
| Entry position forwarded to the application | U · I · C · E | `index`/`term` reach the engine; asserted end-to-end |
| Joint consensus membership change | U · I · E | C_old,new → C_new, rollback on failure |
| Learner (non-voting) catch-up | U · I · E | Promoted only after catching up |
| Leader transfer | U · I · E | Target confirmed as leader before success is reported |
| ReadIndex and lease reads | U · I | Leader-lease expiry and stepping down |
| Snapshots: take, frame, install, compact | U · I · R · E | 30-byte envelope, CRC32, position, cross-shard rejection |
| Restart from a snapshot, single node | R · E | The engine, not the log, is the recovery source |
| Restart from a snapshot, **whole cluster** | R · E | Three processes, snapshots every 15 entries, all killed and restarted: every key returns and the cluster accepts writes again |
| Log compaction and retention limits | U · I · B | Enforced bounds, no unbounded growth |
| Point-in-time recovery | U · I | Records are positioned by Raft index |
| Session and watch APIs | U · I · E | Reads-your-writes, change notification |
| Event bus | U · I · B | Ordered delivery, backpressure |

### 1.2 Transport and security

| Capability | Verification | Notes |
|---|---|---|
| TLS 1.3 with mutual authentication | I · E | Real sockets, real certificates |
| Rogue-certificate rejection | I · E | Handshake refused before any Raft traffic |
| Message framing, CRC, compression | U · B | Corrupt frame is dropped, not misparsed |
| Connection pool, reconnect storm, circuit breaker | U · B | 50-proposer storms, pool exhaustion |
| Shared transport for many shards per node | U · I | Per-shard tagging and routing |

### 1.3 Sharding and high availability

| Capability | Verification | Notes |
|---|---|---|
| Hash, range, consistent-hash placement | U · I | Deterministic and stable across rebalances |
| Online shard migration | U · I · E | Dual-write, cut-over, rollback |
| Failover detection and coordination | U · I · E | Timeout-based, quorum-checked |
| Fencing (stale leader cannot write) | U · I | Epoch and lease fencing |
| Consistency verification after failover | U · I | Divergence detection reports, never repairs blindly |

### 1.4 Storage engine SPI

| Capability | Verification | Notes |
|---|---|---|
| `IStorageEngine` contract | C | 23 checks, run against two structurally different engines |
| Idempotent replay across restarts | C · R · E | Duplicate indexes never reach the engine |
| Forward jumps, no replays | C · R · E | Raft skips non-command entries; a jump is applied, a duplicate index is dropped |
| Apply failure propagates to Raft | C · U | Fail-stop rather than silent divergence |
| Serializable applies | C · B | Concurrent submission stays ordered |
| Snapshot framing, CRC, shard binding | C · U · R · E | Truncated / corrupt / foreign snapshots rejected; the frame carries Raft's boundary index |
| Reference engine (`MemoryStorageEngine`) | C · U · E | Shipped as the adapter template |

---

## 2. Federation (`@agentix-e/db-federation`)

| Capability | Verification | Notes |
|---|---|---|
| CDC capture (engine-agnostic) | U · I | `ICDCEngine` with a monotonic LSN |
| Outbox-before-send delivery | U · I · E | Durable enqueue, then send |
| Exactly-once application | U · I · E | Dedup ring keyed by `(origin, lsn)` |
| Hybrid logical clocks | U · I | Monotonic across skew |
| Conflict resolution: LWW, CRDT, custom | U · I | Deterministic, tested against divergent histories |
| Multi-leader replication | U · I | Loop suppression, causal ordering |
| Merkle anti-entropy repair | U · I · B | Divergence detected and repaired |
| Topology epochs and split-brain detection | U · I | Fencing old epochs |
| Cross-cluster transport over TLS | I · E | Two real clusters, real certificates |
| Channel health, backpressure, pause/resume | U · I · B | Stalled peer does not stall the cluster |
| Query routing to a serving cluster | U · I | Locality-aware, failure-aware |

---

## 3. Operations (`@agentix-e/db-operations-*`)

21 engine-agnostic packages. Every one is bound to an engine only through a provider token,
so it works with any engine that registers the providers it needs.

| Package | Capability | Verification |
|---|---|---|
| `health` | Liveness/readiness orchestration, dependency graph | U · I |
| `metrics` | Counters, gauges, histograms, sink fan-out | U · I |
| `monitor` | Alert rules, thresholds, de-duplication | U · I |
| `backup` | Full/incremental backup, verification, restore drills | U · I |
| `security` | Key rotation, audit log, tamper-evident hash chain | U · I |
| `audit` | Append-only audit storage, query, verification | U · I |
| `maintenance` | Maintenance windows, occurrence generation | U · I |
| `rollingupgrade` | Rolling upgrade orchestration, health gates | U · I |
| `autoscaler` | Predictive and reactive scaling | U · I |
| `config` | Config watching, hot reload, validation | U · I |
| `slo` | Error budgets, burn rates | U · I |
| `observability` | W3C trace context, OpenTelemetry export | U · I |
| `circuitbreaker` | Per-dependency breakers | U · I · B |
| `memoryguard` | Heap pressure, eviction, OOM avoidance | U · I |
| `chaosengine` | Fault injection schedules | U · I |
| `federation` | Schema federation, repair execution | U · I |
| …and 5 more | See the operations guide | U · I |

---

## 4. Measured coverage

Vitest v8 coverage, every dimension gated at ≥95 % in CI. Numbers below are from the last
green run of this repository; the gate fails the build if any dimension drops below 95 %.
The gate covers four packages, not three: the end-to-end harness is measured as well,
because a harness bug produces confident, meaningless acceptance passes.

| Package | Lines | Statements | Functions | Branches |
|---|---|---|---|---|
| `cluster` | 98.4 % | 98.4 % | 98.8 % | 97.3 % |
| `federation` | 99.3 % | 99.3 % | 99.8 % | 97.8 % |
| `operations` | 98.2 % | 98.2 % | 98.9 % | 96.0 % |
| `e2e` (harness) | 100 % | 100 % | 100 % | 100 % |

The `e2e` row covers `e2e/harness/support.ts` — process supervision, IPC, port allocation,
log capture. The two `.mjs` programs it spawns (`raft-node.mjs`, `federation-gateway.mjs`)
run in child processes and are therefore *not* instrumented by the in-process v8 collector;
they are exercised for real by every acceptance test, but no percentage is claimed for them.

Coverage is a *floor*, not an achievement: a line can be executed by a test that asserts
nothing. The suites above are written to fail when behaviour changes, and bug-hunting is an
explicit goal of each iteration (see the audit reports in the companion repository).

---

## 5. What is **not** covered

| Area | Status | Why it matters to you |
|---|---|---|
| **Test-tree type checking** | Partially gated | The e2e package (suites and process harness) is now type-checked. Package test trees under `src/**/__tests__` are still excluded from `tsc`: a test can compile in `vitest` (esbuild strips types) while a type error sits in it. Measured: several hundred errors per package, all in test code. Production code is fully typed and gated. |
| **Per-file coverage floor** | Partially gated | The gate enforces the package total plus a weakest-files report. Around a dozen files (mostly test harnesses and error-only paths) sit below 95 % individually. |
| **Federation cross-DC fault injection at the TLS layer** | Not covered | Federation faults are injected at the transport interface, not by breaking real sockets mid-stream. |
| **Operations process-level acceptance** | Not covered | Operations packages are verified in-process; there is no run that kills a process mid-backup. |
| **Mutation testing (cluster, federation)** | Not covered | Operations has a mutation report; the other two packages do not. A surviving mutant means a test that cannot fail. |
| **TLA+ model checking** | Manual | The specs exist and run locally; they are not part of CI. |
| **Cross-version upgrade path** | Not covered | The wire and snapshot formats are versioned, but no test exercises an N-1 → N upgrade. |
| **Sustained soak beyond CI limits** | Scheduled only | Multi-hour runs exist (`test:soak`) but do not gate a pull request. |
| **Harness `.mjs` child programs** | Executed, not instrumented | `raft-node.mjs` and `federation-gateway.mjs` run out-of-process, so the v8 collector cannot see them. Their contract is covered by the harness suite in-process; their internals are not measured. |

Each row is tracked in the roadmap in
[`db-stack-docs`](https://github.com/AgentiX-E/db-stack-docs/blob/main/plan/ROADMAP.md) with
an owner and an exit criterion; none of them is hidden behind a passing badge.

---

## 6. How to reproduce any number on this page

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm typecheck && pnpm lint && pnpm format:check     # static gates
(cd cluster && pnpm coverage)                        # unit + integration + conformance
(cd federation && pnpm coverage)
(cd operations && pnpm coverage)
pnpm coverage:e2e                                    # e2e harness, same 95 % thresholds
pnpm coverage:gate                                   # all four packages, every dimension
pnpm e2e                                             # 30 real-process TLS acceptance tests
pnpm verify                                          # all of the above, in order
```

The benchmark suite runs on GitHub runners from `.github/workflows/benchmark.yml`; results
are attached to each run so a regression is visible next to the change that caused it.
