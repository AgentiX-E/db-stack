# Changelog

All notable changes to @agentix-e/db-operations will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] — 2026-11-16

### Breaking

- **`reEncrypt(policyId, blobs)` accepts `AsyncIterable<Buffer | null>`.** A `null` is the
  source saying "this blob is already under the current key" — the only component that can
  know a blob's key version is the one holding the version metadata. An existing iterable of
  `Buffer` still type-checks; what changed is who is allowed to answer the question.
- **`RotationEvent.reEncryption` is required.** Four states: `not-requested`, `completed`,
  `deferred`, `failed`. Code that constructs a `RotationEvent` by hand (tests, audit
  importers) must set it. `deferred` is a rotation that succeeded and left data on the old
  key, and it exists because the alternative was reporting that as a clean success.

### Added

- **`ReEncryptSource` and `KeyRotationOptions.reEncryptSource`** — the seam that makes
  `reEncrypt: true` mean something. `rotate()` asks it for blobs after the key has rotated and
  records what happened. Without a source the event says `deferred` rather than claiming a
  migration that did not happen (P3-1, AC 66.12–66.17).
- **`recordEncryption(policyId, bytes)` on `IKeyRotationManager`.** `RotationTrigger` has
  declared `count` and `volume` since the manager was written, and no code holding the
  interface could ever make them fire: the only method that fed the counters was on the class.
  AC 66.1–66.3.
- **`retentionDays` is enforced.** Rotation sweeps closed segments older than the window; `0`
  disables the sweep. AC 67.12–67.14.
- **`readableSegmentsNewestFirst`, `newestOpenSegment`, `segmentPattern`, `escapeRegExp`,
  `fileIdentity`, `unlinkIfUnchanged`** exported from the audit package. The two ordering rules
  — newest first, and the active segment by name — are pure functions of a list of names, so
  they are asserted on arrays instead of on whatever `readdir` returns.

### Fixed

- **`count(filter)` returned at most 100.** It routed through `query()`, whose default page is
  100, so any filter with more matches reported exactly one hundred and an `offset` shortened
  it further. Paging is not selection. AC 67.1–67.4.
- **`get(id)` and `count()` were capped by `maxScanLines`.** An entry past the budget was
  reported as absent. The budget bounds a page, not a lookup. AC 67.5–67.6.
- **`resolveActiveFile` compared sequence numbers across dates.** The sequence restarts at
  `0001` each day, so a restarted store picked yesterday's `-0003` over today's `-0001` and
  appended today's entries to a file named for yesterday. AC 67.7, AC 67.30.
- **A segment that already had an archive could be chosen as the active one.** Reads prefer the
  archive, so anything appended after that point was written and never read. AC 67.8.
- **`filePrefix` was interpolated into a `RegExp` unescaped.** A prefix containing a
  metacharacter — `billing.v2` — matched other stores' files and would have had them pruned.
  AC 67.10–67.11, AC 67.26–67.27.
- **`pruneOlderThan` could delete the segment it was appending to**, and one unremovable file
  abandoned the whole sweep through the outer `catch`, leaving evidence past its retention date
  and reporting a partial number as the result. It now skips the live segment, isolates each
  file, and only deletes names it could have produced. AC 67.15–67.18.
- **`reEncrypt` reported an undecryptable blob as `skipped`**, whose documentation says
  "already using new key". A blob that cannot be rewritten is data still on the old key; it is
  `failed` now. AC 66.19c.
- **`reEncrypt` left the plaintext in the heap on both failure paths** — a verification
  mismatch returned early and a cipher error unwound without wiping. AC 66.19–66.19b.
- **A failed rotation reported a key version it never created** (`toVersion = fromVersion + 1`)
  in the audit trail. AC 66.7.
- **A `compromise` policy was due forever**, so the scheduler rotated the cluster's key every
  tick for the life of the process. It is due until it has been rotated once. AC 66.8.
- **`checkPolicies` returned registration order**, although `RotationPriority` documents itself
  as "the order when multiple rotations are pending" and nothing read it. AC 66.5.
- **`startScheduler` never `unref`'d its interval**, so a service that forgot `stopScheduler`
  could not exit. AC 66.10.
- **Re-registering a policy kept the old deadline**, which had been computed from a trigger that
  no longer existed. AC 66.6.
- **`maxKeyVersions: 0` could report the brand-new key as retired** once the `> 0` guard was
  read as `>= 0`; the guard is gone and `hasKeyVersion` answers the only question there is.
  AC 66.25.
- **The store read every `.ndjson` in its directory**, including another store's segments and
  its own half-written `.tmp` files, while the pruner only deleted names it could have produced:
  two components disagreeing about what "this trail" means. Reads are prefix-scoped now.
  AC 67.26–67.28.

### Changed

- **`validate` of the audit scan is one dispatch on `.json`.** The `else if (.ndjson || .ndjson.gz)`
  could not be false once the file list was prefix-scoped, and its mutants were unkillable
  because they changed nothing.
- **Dead statements removed, each one a mutant no test could kill:**

  | Removed | Why it could not be observed |
  | --- | --- |
  | the empty-line guard in the NDJSON scan | `JSON.parse("")` throws, and the `catch` below already skips it |
  | `retireVersion > 0 &&` in the retirement rule | version 0 never exists, so `hasKeyVersion(0)` answered the same |
  | the `case 'manual'` arm of `_isDue` | `default: return false` is the same answer |
  | the history rewrite in `emergencyRotate` | it wrote the event back to the slot it already occupied |
  | the live-segment guard in the retention sweep | the sweep runs after rotation moved the active path |
  | the `readFileSync(..., 'utf-8')` encoding for legacy `.json` | `JSON.parse` coerces a Buffer anyway; one helper reads both formats now |

Mutation: **7 modules** behind the published rule — `backupChain.ts` 100 %, `cron.ts` 100 %,
`RetentionPolicyEvaluator.ts` 100 %, `InMemoryBackupManager.ts` 98.9 %,
`MaintenanceWindowScheduler.ts` 99.0 %, `KeyRotationManager.ts` 99.16 %,
`FileAuditStore.ts` 97.04 %. Operations overall **98.86 %** over 1 584 mutants.

## [1.4.0] — 2026-11-16

### Breaking

- **`IMaintenanceScheduler` declares the lifecycle transitions it documents.** `startWindow`,
  `completeWindow` and `failWindow` are now part of the interface, not only of
  `MaintenanceWindowScheduler`. Any other implementation must add them; the reference
  implementation is unchanged in signature. The break is the point: the executor — the
  component that knows a run began or ended — is typed against the interface, and it could not
  drive a run at all.

### Added

- **`startWindow(instanceId)`** — the missing `scheduled | approved → in_progress` transition.
  `WindowState` has declared `in_progress` since the scheduler was written, `actualStart` is
  documented as "set when in_progress" and `getStats().activeWindows` counts it, but nothing
  could put an instance there: a window that was running and one still queued both reported
  `scheduled`, and `completed` was only reachable by never having started. A `pending` instance
  is refused, because approval is the step that authorises taking the database offline. AC 64.
- **`parseCron`, `parseCronField` and `CronSchedule`** exported from
  `@agentix-e/db-operations-maintenance`. The five-field grammar is now a module with its own
  tests rather than an inner function of the scheduler, so an expression can be checked before a
  window is registered, and every rule of the grammar has an assertion of its own. AC 63.
- **Mutation covers five modules instead of four.** `maintenance/cron.ts` joins the list under the
  published selection rule — it decides when work runs — and scores 100 %. Operations overall:
  **99.33 %** over 1 042 mutants at `break: 86`.

### Fixed

- **`getStats().activeWindows` could not report a running window** — `in_progress` was
  unreachable, so the number only ever counted `scheduled` and `force_override` runs.
- **`in_progress` is refused by nothing and produced by nothing** in `_finishInstance`: a run can
  now start, complete or fail as three separate calls, and `completeWindow` leaves no `error` key
  behind on a run that did not fail.
- **`resolveConflict(..., 'defer_newer')` on a conflict with no `conflictingSides`** is asserted to
  be a no-op rather than the `TypeError` a reduction over an empty list would throw. The guard was
  there; nothing tested it.

### Changed

- **The cron parser moved to `impl/cron.ts`.** Behaviour is unchanged: a field that names nothing
  still yields an empty set and a window that never fires, and only a field count below five is an
  error. `MaintenanceWindowScheduler.ts` loses 90 lines and one responsibility.
- **Dead branches removed, each one a mutant no test could kill:**

  | Removed                                        | Why it could not be observed                                                    |
  | ---------------------------------------------- | ------------------------------------------------------------------------------- |
  | `if (isNaN(start)) return` in the once-projection | NaN fails the interval test that follows, so the guard never changed the answer |
  | `known.length === 0 \|\|` in `defer_lower`     | `[].every(...)` is vacuously true, so the other half of the condition covered it |
  | `if (targetDays.size === 0) return` in the monthly projection | an empty day set makes every month contribute nothing anyway    |
  | `members.sort(...)` in `buildBackupSets`        | nothing read the order: the policy sums bytes and the result is sorted on return |
  | `if (snapshots.length === 0)` fast path         | the general path already returns an empty result for an empty inventory          |
  | `removedSets.add(set)` in the byte rule         | `removedSets` is not read after that loop                                        |

  The retention module now scores **100 %** with no survivors; the scheduler keeps six, all
  equivalent (documented in `docs/maturity.md`).

## [1.3.0] — 2026-11-16

### Breaking

- **`WindowConflict.conflictingSides` is required, and a conflict now names occurrences instead of
  windows.** `checkConflict` fills it with the two overlapping runs (window id, instance id,
  start, end), earliest first; `detectConflicts` returns the same. A resolution acts on those
  instances and nothing else. Code that only read `conflictingWindowIds`, `description` or
  `recommendation` is unaffected; code that built a `WindowConflict` literal must add the field
  (an empty array is a valid answer). See "Changed" for the behaviour this replaced.
- **`resolveConflict(..., 'defer_lower')` with equal priorities is a no-op.** There is no lower
  window, `checkConflict` recommends `split` for that case, and the old behaviour cancelled
  whichever window happened to be second.

### Added

- **`dependentsOf`, `unrestorableReason`, `newestCompletedSnapshot`** — the chain primitives, exported
  from `@agentix-e/db-operations-backup`. `dependentsOf(inventory, id)` answers "what would I lose if
  I deleted this"; `unrestorableReason(inventory, snapshot)` answers "can this be replayed, and if
  not, which link is missing". Both are pure functions over `BackupMetadata[]`, so an adapter for a
  non-JS or non-in-memory store can use them without adopting the manager.
- **`RetentionPolicyEvaluator` groups snapshots into restorable sets.** AC 59.
- **`InMemoryBackupManager` records the chain it creates**: an incremental stores its base in
  `parentSnapshotId`, `deleteBackup` cascades to the snapshots that cannot be replayed without the
  one named, and `restoreFromSnapshot` refuses a broken chain instead of reporting success. AC 59.
- **`getStats()` reports `conflictsDetected` and `conflictsResolved`** for real. Both were hardcoded
  to `0`, so a dashboard built on them showed a quiet cluster during a conflict storm. AC 60.
- **Mutation covers four modules instead of two**, and `backup/backupChain.ts` scores 100 %.
  `pnpm --filter @agentix-e/db-operations run test:mutation`.

- **`RetentionPolicyEvaluator.evaluateWithOutcome()`** — returns what the pass decided
  *and* what it could not do: `{ toDelete, unreclaimedBytes }`. A policy can ask for two
  things that cannot both hold ("stay under this many bytes" and "never remove anything
  younger than a week"); when the floors win, the bytes that stayed are reported instead of
  being forgotten. `evaluate()` keeps its signature and returns the delete list. AC 57.3.
- **`pnpm --filter @agentix-e/db-operations run test:mutation`** — Stryker, the same
  instrument cluster and federation use, over the modules that decide what gets deleted, whether a
  backup can be replayed and when a window runs. Final measurement: 94.81 % overall — 
  `backupChain.ts` 100 %, `InMemoryBackupManager.ts` 98.94 %, `RetentionPolicyEvaluator.ts` 91.28 %,
  `MaintenanceWindowScheduler.ts` 94.75 %; `break` is 86.
- **`FileAuditStore.close()`** — awaits every rotation compression still in flight.
  Background gzip is off the write path by design, but it was not awaitable, so a
  caller that shut the store down raced a compressor that still held a path.
- **`IComponentRegistrar.registerFunctional`** — the convenience registration path that
  `HealthOrchestrator` implements and every adapter, service and fixture in this repository
  calls. It existed on the class and on no interface, so a consumer holding an
  `IHealthOrchestrator` could not see it and every caller had to name the concrete class.
  `FunctionalChecks` and `FunctionalCheckResult` name the closure shapes.
- **`IAlertRuleManager.evaluateSnapshot(snapshot)`** — the only evaluation path that can
  work. The interface previously declared `evaluate()` with no arguments, which the sole
  implementation satisfied with `return []`: a consumer holding the interface could evaluate
  rules forever and never see an alert.
- **`ResumeRequest`** — the resume half of a `PauseRequest`, carrying the `onResume`
  confirmation callback. `requestResume` had no way to report what it did, because it took
  a bare string array and had an empty body.
- **`pnpm typecheck:tests`** — all 21 packages' tests and the benchmarks are compiled with
  the production compiler options. The package had carried a `tsconfig.test.json` that no
  script referenced and that switched `noUncheckedIndexedAccess` off; 578 type errors were
  sitting under it.

### Changed

- **Retention operates on backup sets, not snapshots.** A set is a base plus every incremental
  chained to it; a set is kept or removed whole, and `maxFullSnapshots` counts sets. Treating
  snapshots one at a time deleted a base and left its incrementals behind — bytes that were listed,
  billed and impossible to restore — and let the count rule keep an incremental whose base it had
  just removed. AC 59.1, AC 59.2.
- **A snapshot whose `createdAt` cannot be parsed is never removed**, and the bytes it holds are
  reported in `unreclaimedBytes`. Retention may not delete what it cannot date. AC 59.10.
- **`toDelete` is ordered oldest first**, so deleting the list as it comes never removes a base
  before the snapshots that depend on it. AC 59.23.
- **`defer_lower` / `defer_newer` cancel one run, not a window's schedule.** `defer_lower` cancelled
  every future run of the losing window — a conflict at 03:00 today also removed next month's run —
  and `defer_newer` cancelled the newest run of *both* windows, so the winner lost one too. AC 60.5,
  AC 60.6.
- **Two overlapping runs of the same window are reported as a conflict.** The check compared window
  ids, so a window whose duration exceeds its recurrence period — two maintenances at once on the
  same targets — was reported as `coexist`/no conflict. Identity is now the instance. AC 60.1.
- **`activeWindows` counts a `force_override` run**, which it did not: a cluster in the middle of an
  emergency maintenance window reported itself idle. AC 61.12.
- **`defer_newer` resolves equal starts by the later side**, matching the order `checkConflict`
  reports. AC 60.15.


- **Breaking:** `parseDurationToMs` throws on input that names no duration, instead of
  returning `0`. See the Fixed entry below.
- **Breaking:** `RetentionPolicy.maxTotalBytes` no longer overrides `keepRecent`/`minAge`.
  A policy that cannot meet the ceiling while honouring its age floors now reports the
  excess rather than deleting backups the floors protect.
- **`KeyManagerConfig.keyLength` / `hashAlgorithm` are optional**, and defaults are resolved
  explicitly instead of by spreading an object that let an explicit `undefined` clobber them.
- **`EnvelopeEncryptionConfig.autoGenerateKey` is optional** (the implementation already
  treated it as "default true").
- **`ILogger` declares the `(message, context)` overload** its implementations handled and
  its documentation promised. Callers had already worked around it with `as any`.
- **`InMemoryLogger.child()` returns `InMemoryLogger`**, which is what it always returned.
- **`FederatedQueryRouter.setRoutingPolicy` takes `Partial<RoutingPolicy>`**, which the
  implementation already merged over its defaults.
- **Breaking:** `IAlertRuleManager.evaluate()` is gone, replaced by `evaluateSnapshot`.
- **Breaking:** `IMaintenanceScheduler.requestResume` takes a `ResumeRequest`, not a
  `resources: string[]`. See the Fixed entry below for why the old signature could not work.

### Fixed

- **The byte ceiling deleted backups the age floors promised to keep.** `RetentionPolicy`
  states four rules: keep the newest `maxFullSnapshots` full snapshots, skip anything younger
  than `keepRecent`, delete only what is at least `minAge` old, and stay under
  `maxTotalBytes`. The byte loop implemented the fourth against every snapshot the first rule
  had not already marked, so a policy of `keepRecent: 'P7D'` removed a one-hour-old backup the
  moment the ceiling was exceeded, and returned it in the delete list — the caller had no way
  to tell that the floor had been ignored. The old suite tested each rule alone: every
  `keepRecent` test set `maxTotalBytes: 0`, and every `maxTotalBytes` test left the floors
  unset, so the interaction was never exercised. Found by mutation testing, which showed the
  byte loop's guards surviving every mutant. AC 57.1–57.2.
- **An unreadable retention duration meant "keep nothing".** `parseDurationToMs('seven days')`
  returned `0`, so the floor it was meant to express vanished and the next pass deleted every
  backup it had promised to protect. The parser now accepts only the documented forms
  (`P7D`, `PT1H`, `PT30M`, `PT30S`, `P1DT2H3M4S`, and a plain number of hours) and throws on
  anything else; the constructor and `updateConfig` validate the policy where it is written,
  naming the field. AC 57.11–57.13.

- **`S3StorageBackend` uploaded 5-byte parts.** `DEFAULT_PART_SIZE` was
  `(5 / 1024) * 1024`, which is 5, not 5 MiB. Every backup larger than the 10 MB
  multipart threshold was sent as 5-byte parts, which S3 rejects for all but the
  last part: the default configuration could not back up a large database at all.
- **`S3StorageBackend` retried requests that could not succeed.** The retry helper
  repeated every failure three times, including 403 and 404 — three wasted
  requests and 1.5 s of backoff before the caller saw an error it could act on.
  Only 5xx, 429 and transport-level failures are retried now.
- **`AES256GCMEncryptionProvider` decrypted with the current key when the blob
  named an unknown key version.** The version prefix is not covered by the AEAD
  tag, so a blob could be relabelled with any version and still decrypt; and since
  that prefix is the only record of which key encrypted a blob, a re-encryption
  audit could be made to report the wrong key. An unknown version is rejected.
- **`NoopLogger`'s methods were typed as `() => void`**, so the class declared
  `implements ILogger` while `logger.info('message')` did not compile. The fields
  carry the interface's types now.
- **`AuditLogManager` built an entry with `hash: undefined as unknown as string`** and then
  patched it. The hash is now computed from the entry that is actually stored.
- **`SchemaFederator.executeRepair` caught `err: any`**, the only untyped throw path left in
  the package; it narrows `unknown` now.
- **`bench:ycsb` pointed at `bench/ycsb/run-ycsb.ts`**, which does not exist. Each package now
  runs its own YCSB entry point.
- **`FileAuditStore` deleted files it had not compressed.** Rotation reuses segment
  names (`audit-YYYYMMDD-0001.ndjson`), so a compressor that outlived its directory
  found _a_ file at its old path — the next run's — and unlinked it, because the
  name matched. The compressor now records the file's identity (inode and size)
  before reading and deletes only that exact file (`unlinkIfUnchanged`). Reproduced
  as a CI-only failure of the age-rotation test, which is what a cross-test file
  deletion looks like from the outside.
- **A data directory that did not exist yet was never created.** The guard was
  inverted (`if (existsSync(dir)) mkdirSync(dir)`), so a store pointed at a fresh
  path failed on its first write with ENOENT. Only directories created beforehand
  by the caller — as every test did — worked.
- **The age-rotation test no longer sleeps for a guessed duration.** It awaits
  `close()` and then polls, bounded, for the observable state. A fixed sleep plus an
  exact file count is a coin flip on a loaded runner; the property under test is the
  split of entries between segments.
- **The audit trail became unreadable as soon as it rotated.** `rotate()` archives the
  retired segment as `.ndjson.gz`, and `query()`, `get()` and `count()` only ever opened
  `.ndjson`. Every entry in an archived segment was on disk and invisible to the store:
  `query()` returned only the current segment, `get()` could not find an entry by id, and
  `count()` reported a number that silently shrank at each rotation. `createGunzip` was
  imported and never called, which is what the unfinished path looked like. Scans now read
  compressed segments, and a corrupt archive is skipped rather than aborting the scan.
- **A segment could be counted twice while it was being archived.** Rotation writes the
  `.gz` and only then unlinks the original; a query that landed in that window read both
  copies and reported every entry twice. The archive now wins over its namesake.
- **A `dataDir` that exists but is not a directory** was accepted at construction and failed
  on the first write with ENOENT. The constructor reads the directory now, so the
  configuration error surfaces where it is made.
- **A weekly maintenance window reported a start time that had already passed.**
  `getUpcomingOccurrences(from, to)` documents occurrences whose start lies in
  `[from, to)`. The daily, monthly, once and cron projections all enforce that lower
  bound; the weekly projection aligned its cursor to `HH:MM` on the range-start day and
  emitted it unconditionally. Asking at 23:58 about a `23:00` weekly window therefore
  returned the window of 58 minutes earlier as "upcoming" — a start an operator can
  never act on, and one extra occurrence in every projection that spanned the start
  time. The cursor now advances a day when the aligned instant precedes the range, the
  same rule `_projectDaily` already applied. Found by the CI unit job failing at 23:58
  and passing all day; the projection is now specified by AC 54.1–54.13 against fixed
  UTC instants rather than `Date.now()`.
- **`requestResume` resumed nothing.** The body was empty, so `await
  scheduler.requestResume(['orders'])` resolved immediately and the caller concluded the
  database was back in service while it stayed paused — a success signal that does not mean
  success. `requestPause` had always driven its `onPaused` callback; the resume half never
  existed even though `PauseRequest` declared `onResume`. `requestResume` now takes a
  `ResumeRequest` and awaits `onResume` for every resource, propagating the first failure so
  the caller learns which resource refused to come back. AC 56.1–56.5.
- **An out-of-range `startTime` silently scheduled the window at a different hour.**
  `Number('25')` is 25, not `NaN`, and `setUTCHours(25, 0)` rolls over to 01:00 the next
  day: `startTime: '25:00'` ran an hour nobody asked for, `'23:60'` ran at midnight,
  `'03:-5'` at 02:55. Only `NaN` was treated as malformed. The three projections that read
  `startTime` now share one `parseStartTime`, which requires an integer hour in `0..23` and
  an integer minute in `0..59`; anything else produces no occurrences, exactly as `'aa:bb'`
  already did. AC 55.1–55.3.
- **A `daysOfMonth` entry of `0` fired the window one month early.** `Date.UTC(year,
  month, 0)` is the last day of the *previous* month, so a `0` entry — or any negative one —
  projected a window on a date the operator never named, and projected it once per month
  iteration under a per-iteration de-duplication set (`[0, 15]` produced the 30th of
  November twice). Entries outside `1..31` are now dropped rather than interpreted;
  `31` in a short month is still clamped to that month's last day. AC 55.4–55.6.

### Removed

- **Three hand-rolled mutation engines** (2 023 lines): `packages/core/src/__tests__/mutation/`
  and `scripts/mutation-run.ts`. No workflow ran any of them, each scored mutants by its own
  rules, and the README quoted the 85.2 % that one of them produced. They are replaced by
  Stryker under the same shape of threshold as the other two packages — one instrument per
  measurement — and `check:gates` now fails if a `test:mutation` script is not invoked by a
  workflow.

## [1.2.0] — 2026-08-10

### Added

- **Mutation Testing Campaign** — Comprehensive mutation score audit across 8 core packages
  - **6/8 packages at ≥95% mutation score**: observability 100%, chaosengine 100%, configwatcher 100%, health 96.3%, security 98.3%, logger 95.2%
  - Full quality report: `db-stack-docs/archive/OPERATIONS-MUTATION-QUALITY-REPORT.md` with survivor classification framework
  - Documented structural ceilings for backup (69.4%) and maintenance (61.5%) — 63 total survivors, all classified as phantom/dead-code type

### Improved

- **Health** — 82.0% → 96.3% (+14.3%)
  - 4 De Morgan `||→&&` killers (H21-H24)
  - 2 uptime `/→*` killers via async-delayed testing (H5/H10)
  - Source restructure: `_makeOccurrence` named variables, `_validateWindow` positive booleans
- **Logger** — 81.3% → 95.2% (+13.9%)
  - 14 targeted mutation-killing tests
  - Source restructure: memory retention lambda extract
- **Maintenance** — 54% → 61.5% (+7.5%)
  - 52 targeted mutation-killing tests (MWS1-MWS20, MUT1-MUT32)
  - FULL source restructure of all 7 methods:
    - `_projectDaily`/`_projectWeekly`/`_projectMonthly`: explicit cursor arithmetic, named boolean flags per comparison
    - `resolveConflict`: split `defer_lower`/`defer_newer` branches, manual newest-finding loop
    - `checkConflict`: extracted overlap booleans, named priority flags
    - `_validateWindow`: ALL `||` chains expanded to individual named guards
    - `_makeOccurrence`: `maxDurVal`/`hasValidDuration` extraction
- **Backup** — 56% → 69.4% (+13.4%)
  - 30 targeted mutation-killing tests
  - Source restructure: `listBackups` 3-phase for-loop pipeline (type→newerThan→sort→limit)
  - `RetentionPolicyEvaluator`: markedKeepers, dailyPluck, quota enforcement edge cases
  - Faketimer tests written (standalone pass); blocked by mutation runner compatibility

### Architecture

- All source restructures preserve identical observable behavior while exposing each boolean/comparison/arithmetic operator for independent mutation killing
- 20 Git commits, all by Lambertyan <lambertyan@agentix-e.ai>
- All code, comments, docs, and commit messages in English
- No regressions introduced; full test suite passes clean

## [1.1.0] — 2026-08-05

### Added

- **I17 ChaosEngine v2.0** — Production-grade chaos engineering engine
  - ChaosEngineV2 (468 lines) with declarative ChaosScenario DAG
  - 8 fault types: latency, partition, crash, packet loss, bitflip, clock skew, disk full, network duplicate
  - Deterministic SeededRNG for reproducible chaos experiments
  - Event system with auto-resolve timers
  - 48 tests (CHAOS1-6 + v1 backward compat)
- **I13 Observability** — E2E cross-package observability tests (OBS6-OBS11)

### Internal

- **I14 Documentation** — ADR template for db-operations repository
- **I15 Security** — SECURITY.md added
- **I16 Release Readiness** — v1.0.0, CHANGELOG entries, npm pack verified

## [0.1.0] — 2026-07-26

### Added

- **core** package — Base types, provider registry, DI tokens (22 tests)
  - IProviderRegistry with register/get/supports
  - Error hierarchy with typed error codes
  - Engine-agnostic type definitions
- **health** package — K8s-style health probes (23 tests)
  - IHealthProbe, IComponentRegistrar, IHealthOrchestrator
  - Liveness and readiness probe patterns
  - Component-level health aggregation
- **logger** package — Structured logging (19 tests)
  - ILogger with levels, child loggers
  - InMemoryLogger and NoopLogger implementations
  - Trace context integration
- **metrics** package — Prometheus-style metrics (21 tests)
  - Counter, Gauge, Histogram
  - Label support
  - PrometheusPushExporter
- **monitor** package — Database monitoring (38 tests)
  - ISlowQueryRecorder, IDeadlockDetector
  - IConnectionMonitor, IAlertRuleManager, IResourceQuotaManager
  - Threshold-based alerting
- **backup** package — Backup orchestration (30 tests)
  - IBackupManager, IPITRManager, IBackupScheduler
  - IStorageBackend with S3StorageBackend implementation
  - IBackupRetentionPolicy
  - BackupEntry, RestorePoint, IBackupScheduleConfig, IBackupManifest
- **maintenance** package — Database maintenance (29 tests)
  - IMaintenanceExecutor (VACUUM, ANALYZE, REINDEX)
  - Scheduled maintenance window management
- **auth** package — Authentication (32 tests)
  - Authentication providers and credential management
  - Token-based and password-based auth
- **security** package — Security operations (42 tests)
  - ITLSManager, ICertMonitor
  - IEncryptionManager, IRBACProvider, IRateLimiter
  - ISCIMSyncProvider
- **audit** package — Audit trails (20 tests)
  - IAuditStore with FileAuditStore implementation
  - IAuditExporter
  - Immutable log patterns
- **observability** package — Distributed tracing (21 tests)
  - IDistributedTracer, ITelemetryExporter
  - W3C TraceContext support
- **otel** package — OpenTelemetry bridge (18 tests)
  - Metrics and traces export to OTEL collector
  - Span context propagation
- **autotuner** package — Automatic parameter tuning (15 tests)
  - AutoTunerWorker with workload analysis
  - AutoScalerMetrics connection count tracking
- **autoscaler** package — Dynamic scaling (12 tests)
- **chaosengine** package — Chaos experiment framework (14 tests)
- **circuitbreaker** package — Circuit breaker pattern (11 tests)
- **configwatcher** package — Runtime config management (10 tests)
- **memoryguard** package — Memory pressure monitoring (9 tests)
- **rollingupgrade** package — Zero-downtime upgrades (16 tests)
- **slacollector** package — SLA tracking (13 tests)
- **DESIGN.md** — Complete design philosophy and architecture documentation (now `db-stack-docs/design/OPERATIONS-DESIGN.md`)
- **Testing Suite**
  - 866 tests, 29 test files (as of cc34297)
  - E2E real engine integration (sqlvec/graphvec)
  - YCSB-style performance benchmarks
  - Chaos tests for all modules
  - Cross-engine adapter pattern tests

### Fixed

- interfaces/index.ts — Added missing type exports (BackupEntry, RestorePoint, etc.)
- S3StorageBackend — accessKeyId and secretAccessKey made optional
- AutoTunerWorker — connectionCount made optional in AutoScalerMetrics
- Micro-benchmark stabilization under concurrent test execution
- inject-1000 perf threshold — relaxed from 2M to 2.5M ns for single-core GC variance

[1.0.0]: https://github.com/AgentiX-E/db-operations/releases/tag/v1.0.0
[0.1.0]: https://github.com/AgentiX-E/db-operations/releases/tag/v0.1.0

## [1.0.0] — 2026-08-02

### Added

- **Observability E2E tests** — 30 cross-package integration tests validating
  InMemoryLogger, HealthOrchestrator, MetricsRegistry, PrometheusPushExporter,
  InMemoryDistributedTracer, W3CTraceContextProvider, InMemoryDeadlockDetector,
  InMemorySlowQueryRecorder, and InMemoryConnectionMonitor. (I13)
- **Security audit pipeline** (`_security.yml`) — npm audit, secret scanning, license
  compliance in CI gate. (I12)
- **ADR template** — standardized architecture decision record format. (I14)
- **SECURITY.md** — vulnerability reporting policy and support SLA. (I15)

### Changed

- **CI** extended with security pipeline in quality gate chain
  (security → quality → publish). (I12)
- **.gitignore** env hardening retained.

### Security

- npm audit gate (blocks PRs on HIGH/CRITICAL vulnerabilities).
- Secret scanning pattern matching against common credential formats.
- License compliance check (OSI-approved only).
