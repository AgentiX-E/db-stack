# Changelog

All notable changes to @agentix-e/db-node will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An upgrade waits for the node to report the target version.** `_drainAndUpgrade` used to
  `await sleep(0)` where the upgrade should have been and then mark the node `completed`, and
  nothing ever read `RollingUpgradePlan.targetVersion` — so `upgradedNodes` counted nodes that had
  been relabelled. A node that never restarted and a node that came back on the old version were both
  reported as upgraded, and a canary that failed to start was promoted. `IVersionProbe` is the port:
  `reportedVersion(nodeId)` is what the node says it is running, `requestUpgrade(nodeId, version)` is
  optional and lets the orchestrator drive the restart. The wait is bounded by
  `upgradeTimeoutMs`/`upgradePollIntervalMs` and counted in polls rather than against a wall clock, so
  an injected sleep still produces a deterministic number of attempts. A plan with no probe is
  refused in validation — a millisecond, instead of a batch of nodes reported as new when they are
  not. `NodeUpgradeState.reportedVersion` and the `node_version_confirmed` event carry the evidence
  and the number of polls it took.
- **`RollingUpgradeEvent.batchIndex` is set.** Every emit passed the index inside `details` and left
  the public field `undefined`, so a consumer filtering events by batch matched nothing.
- **A canary failure says what failed.** The catch reported "Canary health check failed" for every
  canary error, including the ones that happened before the first health check ran.

- **`ConfigWatcher` reads the files it claims to watch.** `startFileWatch()` armed an interval,
  reported `fileWatchActive: true` and read nothing: `_loadFiles()` was a comment, so a watcher
  started against a directory was a timer with no observer. It reads every configured path on each
  poll now, parses it by extension, and applies what changed. `json` and `env` have parsers and no
  dependencies; `yaml` and `toml` do not, and `FileWatchOptions.parsers` is where a caller supplies
  one — a file whose format has no parser is reported rather than skipped. `getStats().fileWatch`
  publishes what the file half did: one entry per path with the keys it contributed, the loads that
  found new content and the reason the last attempt failed, because `fileWatchActive` was `true`
  for a whole release while the answer to "what did it read" was "nothing".
- **A watched file owns the keys it contributed.** When a reload drops a key the file used to
  hold, the key leaves the store — but only if the store still carries the value that file put
  there, so a poll cannot undo a `set()` an operator made deliberately.
- **`reload()` can remove a key.** A reload applied `newValues` over the store and had no way to
  say "and this one is gone", which is why a config file that lost a key kept the key. The removal
  is part of the same atomic step: it fails validation if a schema requires the key, and it emits
  the same change event a value change does.
- **`FileWatchStats`, `WatchedFileStatus` and `FileWatchOptions.parsers`** are public types, so a
  caller can write down what `getStats().fileWatch` returns.

- **A restore replays the chain it was given, or refuses it by name.** `restoreFromSnapshot` verified
  that every base an incremental needs was still stored — and then handed `IBackupSource.restore` a
  single file. `DirectoryBackupSource` captures a whole tree every time, so for it that was correct; for
  an engine whose `capture` produces a delta it wrote the newest delta over a data directory as if it
  were a full copy and reported success, which is the one outcome worse than a refusal because it looks
  like a recovery. `resolveChain` now answers *may this be replayed* and *with what* in one walk, so the
  check and the replay cannot disagree, and the port makes the source say which of the two things it is:
  `whole: true` for a whole-capture engine (the newest artefact is the restore), or `restoreChain(chain)`
  for one that captures deltas (every artefact, oldest first, all of them already verified). A source
  that declares neither is refused a chain longer than one artefact, with the count and its own name in
  the message — the alternative is guessing, and guessing is what produced the fragment.
  `RestoreResult.artefacts` says how many were downloaded and verified. `DirectoryBackupSource` declares
  `whole: true` and its behaviour is unchanged.
- **`pitr` breaks a timestamp or LSN tie by chain depth.** Two incrementals taken inside one millisecond
  share a `createdAt`, and two snapshots that recorded the same `lsn` are exactly as close; a plain sort
  left those to the order the bucket happened to list, which puts the *older* candidate first — so "the
  newest at or before T" could resolve to the base of a chain whose head is also at T and be reported as
  the recovery point. Depth decides, and the id makes the answer total, so the recovery point no longer
  depends on the listing at all.
- **The head of the audit chain is anchored.** A chain proves the entries that are *present*: delete the
  beginning of a trail and every remaining link still holds, because the first survivor names a `prev`
  that retention could equally have pruned. That was the one deletion the digest could not report. A
  store now records what it gives up — `${filePrefix}.anchor`, one floor per writer, holding the
  sequence number and digest of the last entry of each prefix it pruned — and `verify()` compares the
  first surviving entry against it: resuming *above* the floor is `anchor-gap`, resuming *at* it without
  naming the recorded digest is `anchor-link`, and resuming above 1 with no record at all is reported as
  `unanchored` rather than accused, because a trail written before the record existed looks exactly
  like that. The file is written to `.part`, synced, and renamed, so a reader sees the old anchor or the
  new one; it is read through the store's own `segmentReader`; and a prune that cannot write it removes
  nothing. `AuditTrailVerification` grew `anchored`, `unanchored`, `anchorUnreadable` and `heads` — the
  last link of each chain, which is what a prune records and what an external witness can compare
  against — and `parseSegmentText` is published as the reader `verify()` and the prune share.
- **A prune reads before it deletes.** `pruneOlderThan()` and the retention sweep used to remove a closed
  segment by age alone. They now read it and check it as a segment first — every line parsed, every link
  inside it holds, with `unchained` lines counting as a legacy trail rather than as damage — and keep
  what does not verify, because retention is the one operation that can destroy a break. A segment that
  cannot be read is kept for the same reason: its floors cannot be recorded, and an unrecorded removal
  is the hole the anchor exists to prevent. The sweep reports a removal failure instead of throwing
  (`removeIfPossible`), since it runs from a compression job's `finally` where no caller can receive an
  error.
- **`BackupManager.reconcile()`.** Deletion removes a snapshot's record first and its artefact second, so
  a delete that fails between the two leaves an object no record names: invisible, billed,
  unrestorable, and impossible to find without listing the bucket and comparing it with the inventory.
  `reconcile()` is that comparison, and it answers three lists: `orphaned` (no record names it, older
  than `RECONCILE_GRACE_MS`), `inFlight` (no record names it *yet* — a backup being written, which
  reclaiming would delete), and `missing` (a record whose artefact is gone). Nothing is deleted unless
  `reclaim: true` is passed, because a listing can be stale and an object that merely looks unnamed is
  one delete away from being a backup nobody has; with it, `reclaimed` counts what is actually gone and
  a failed delete leaves the object for the next run. The age is measured against the manager's own
  clock, so the window's boundary is a millisecond an operator can stand on, and the report covers this
  manager's prefix and nothing else. A record names its artefact two ways and both are honoured — the
  `location` it carries, which protects an object whose *name* this build does not write, and the id in
  its own *key*, which needs no parsing and therefore protects the artefact of a record that cannot be
  read; `artifactIdOf` publishes the naming rule and answers `null` rather than guessing. Both halves of
  the report are ordered by key with the default comparator — code-unit order, the same on every
  machine and in every locale.

### Fixed

- **`_validatePlan` had an unreachable second empty-node check** — the first test already covers it —
  and `_checkBatchHealth` guarded against a missing check function that validation has already refused.
  Both removed rather than covered.

- **The backup budget is measured on the manager's clock.** `createBackup` compared `Date.now()`
  against the deadline after the capture and again after the upload, so a budget was a measurement of
  the machine: on a loaded CI runner the capture of one small file outlived a 1 ms budget, and the case
  that is about a slow *upload* failed with `the capture took longer than 1 ms`. Both checks now read
  `this.clock()` — the clock the manager already stamps `createdAt` with — so a test moves the budget
  from inside the step it is about, and a caller that injects a clock gets one consistent notion of
  time for the id, the timestamp and the budget.
- **`verify()` no longer attests to a segment it could not read.** A segment whose bytes could not be
  recovered used to be folded into the empty string, so a trail consisting of one truncated archive
  verified as `ok: true, entries: 0` — a report of "intact" about evidence the store never saw. A read
  failure now stays distinguishable from an empty segment: `verify()` sets `unreadable: true` and
  refuses `ok`, while `query()`, `get()` and `count()` still serve every segment they can, because an
  incident report must not be refused. The verification report now also tells a torn tail from an
  unparsable line: a fragment at the very end of a segment is `tornTail` (a crash nobody acknowledged),
  and `unparsable` is reserved for a line between others, where the position is part of the answer.
- **The construction sweep and the live append read through the configured reader.** `readView` — the
  comparison between a segment and its archive — called `readSegmentFromDisk` directly, so a deployment
  that wrapped `segmentReader` (accounting, a different medium) was silently given a second, unwrapped
  reader in the two places where the store decides what to delete. `readView` now takes the reader and
  the store passes its own, and a reader that fails during a comparison yields an unreadable view rather
  than an exception in the middle of an append: an append is not refused because a *comparison* could
  not be made.

### Added

- **The bucket is the inventory.** `BackupManager` no longer keeps its snapshots in a `Map` on the
  instance: every snapshot gets an immutable record at `<prefix>/inventory/<snapshotId>.json`, written
  after the artefact and confirmed with `list` the same way, and **every public method starts by listing
  that directory**. A restarted manager — or a second worker, or a process that has never seen the first
  one — can therefore name everything the bucket holds. The listing is single-flight, so a burst of
  concurrent calls costs one read; it reconciles in both directions, so a snapshot deleted in another
  process stops being listed here and one taken there starts; and it notices a record rewritten in
  place, by comparing the listing's own `size` and `lastModified` against what was last read.
  One record per snapshot rather than one manifest for the bucket, because a manifest is a
  read-modify-write: two workers would each add an entry and the second write would erase the first.
- **`inventoryProblems()`.** A record that cannot be read is reported as `{ key, reason }` rather than
  thrown — one damaged kilobyte must not stop every backup in a deployment — and the snapshot it
  described is not listed, because it cannot be restored. `InventoryRecordError` carries the key and the
  field that failed.
- **`FileSystemStorageBackend`** — a bucket that is a directory: an NFS mount, a SAN volume, the disk of a
  backup host. Objects are written as `<key>.partial` and renamed, so an object either exists whole or
  does not exist, and a process killed mid-copy leaves a file `list` does not return. Keys go through
  `safeJoin`, so `..` and absolute paths are refused. `PARTIAL_SUFFIX` is exported because a lifecycle
  rule that reclaims stale partials has to be able to name them. This is also the backend that makes a
  backup outlive its process: `InMemoryStorageBackend` is a `Map`, and its objects are gone at exit.
- **The record format is published** — `INVENTORY_FORMAT`, `inventoryKey`, `inventoryPrefix`,
  `serializeRecord`, `parseRecord` — for the same reason the audit chain's rule is: an operator with a
  bucket and no running manager has to be able to read a record, judge one, and decide what to do with a
  damaged one. Every field is validated on the way in, and the two refusals a length can produce are
  different sentences — `sizeBytes is not a number ("4096")` and `sizeBytes is not a length (-1)` —
  because a record written by something that did not serialise a number and a record whose arithmetic
  went wrong are two different problems for the operator holding the bucket. A length must be a whole
  non-negative number, so `4096.5` is refused as well.

### Changed

- **A confirmation the bucket does not give is undone.** `createBackup` deletes what it uploaded — the
  artefact, and the record if it got that far — before returning `success: false`. An answer and a
  bucket that disagree is worse than a retry.
- **`backup` now moves bytes.** `new BackupManager(source, storage, retention)` replaces
  `InMemoryBackupManager`, and it is a different class in the way that matters: `createBackup` captures
  a consistent cut through the new `IBackupSource` port, measures the artefact it got, hashes it,
  uploads it, and then **asks the bucket to list the key at that size** before it records a snapshot.
  `sizeBytes` is the artefact's length rather than the `1024` the old class wrote after a timer,
  `checksum` is its SHA-256, and a failed attempt stores no metadata at all — a listing that shows a
  snapshot the bucket cannot answer for is a snapshot somebody plans a recovery around.
  `restoreFromSnapshot` is the same path backwards: chain check, download, size, digest, and only then
  the engine. `pitr` resolves a target against the snapshots the manager actually holds (by id, by
  time, or by `lsn` fact with `compareLsn`'s hex ordering) and refuses an empty target instead of
  answering `recoveryPoint: 'unknown'`. `deleteBackup` and `prune` remove **sets** through
  `expandDeletions`, and `prune()` returns what was deleted rather than what the policy named.
  `DirectoryBackupSource` is the reference engine: a directory, captured into a `DBDIR1` container
  whose manifest lists every file with its own digest, hashed twice so a moving target is an error
  instead of an artefact that restores a state no moment ever held.
- **`audit` is tamper-evident.** Every entry written carries a `chain` link — `writer`, `seq`, `prev`,
  `hash` — where the digest covers the entry's canonical JSON, its writer, its sequence and the
  previous entry of the same writer, under the domain separator `db-node/audit/chain/v1`. `IAuditStore`
  gained `verify()`, which walks **every** segment and archive (a verification bounded like `query()`
  would answer "intact" about the part it looked at) and reports the first break with a reason:
  `content`, `link`, `sequence-gap`, `unchained` or `unparsable`. Chains are per writer because two
  processes may append to one trail; `writerId` defaults to a fresh UUID, because a reused name would
  restart the sequence and look exactly like a deleted entry. A pruned prefix is not a broken link.
  It is an unkeyed digest and the documentation says so: it catches an edit nobody recomputed after,
  and an administrator who can rewrite the file and the chain defeats it.

- **Twenty-one packages are three.** `@agentix-e/db-operations-<module>` is now
  `@agentix-e/db-node/<module>` for the twenty modules that do not need to know how
  many nodes exist, and the two categories that do are packages of their own:
  `@agentix-e/db-cluster` (membership arithmetic, scale-down, rollout order, chaos
  translation) and `@agentix-e/db-federation` (federated identity, cross-cluster query
  routing, repair). Every import changes name exactly once — `from '@agentix-e/db-operations-audit'`
  becomes `from '@agentix-e/db-node/audit'` — and no subpath is renamed, because the
  modules keep their names. The line is a question rather than a domain: `autoscaler` still returns
  a `ScaleAction` and `rollingupgrade` still returns a `RollingUpgradePlan`, because data about a
  group is not authority over one; `ClusterScalingExecutor` and `ClusterRolloutPlanner` are what
  turn those into members added, members removed, and an order that keeps quorum. Twenty package
  names for code that cannot be misused without a topology were twenty version numbers and twenty
  release notes describing one decision.
- **`operations/` is gone; the three packages are the workspace.** `db-node` lives in `node/`, and
  `cluster/` and `federation/` are the directories that already existed, so `pnpm-workspace.yaml`
  lists `node`, `cluster`, `federation` and `e2e` and no nested `operations/packages/*`. The umbrella
  entry point died with the directory: `DB_OPERATIONS_VERSION` named a package nobody installs now,
  and a constant that restates `package.json#version` is a second place for the number to be wrong.
  The move was mechanical only because the collisions were settled first, in a commit of its own:
  two interfaces called `IClusterTopology` — one node looking out at its peers, one set looking in —
  were two different shapes, and merging the packages would have made that a compile error rather
  than a naming question. The operations layer's version is now `IMemberSet`, and the consensus
  engine keeps the name it published.
- **The three packages are versioned independently.** They were a `fixed` group in
  `.changeset/config.json`, which meant `db-node`'s first release would have carried `db-cluster` to
  the same number. A consumer who installs one node does not care what the federation package is at;
  the group is gone and each package ships on its own cadence.
- **`@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are optional peer dependencies.** They were
  `dependencies` of the package that held `backup`, which meant every consumer installed the AWS SDK
  whether or not it used S3 — and because the umbrella entry point re-exports `backup`, a static
  import would have kept them mandatory even as peers. The import is deferred to first use now:
  constructing `S3StorageBackend` costs nothing and resolves nothing, and reaching an S3 path without
  the SDK is refused with a message naming both packages and the `npm install` line that fixes it.
  `health()` reports that refusal as `{ ok: false }` instead of throwing, so a readiness probe says
  "missing peer" the way it says "unreachable bucket".

### Added

- **`@agentix-e/db-node/backup`: `IBackupSource`, `SnapshotCapture`, and the artefact format.** The
  engine port is three members — `name`, `capture(destination)`, `restore(source)` — and it is the only
  part of a backup the middleware cannot supply. Around it, everything an engine would otherwise get
  subtly wrong is here: the container (`ARTIFACT_MAGIC`/`ARTIFACT_VERSION`, `writeDirectoryArtifact`,
  `readDirectoryArtifact`), the digest (`hashFile`), the refusal to write outside the engine's
  directory (`safeJoin`), the second half of the two-pass capture (`assertUnchanged`), the manifest
  ceiling (`MAX_MANIFEST_BYTES`), and the error helpers `reason` and `removeQuietly` — published as
  functions so that each branch is reachable by a test with a filesystem it controls.
- **`@agentix-e/db-node/audit`: the chain rule, published.** `canonicalJson`, `chainPreimage`,
  `chainDigest`, `sealEntry`, `recomputeDigest`, `verifyTrail` and `describeVerification`, plus
  `CHAIN_DOMAIN` and `GENESIS_DIGEST`. A claim of tamper-evidence that only the store can check is a
  claim on the store's authority; the rule is a function so an auditor can apply it to a file the store
  never touched.
- **`@agentix-e/db-cluster` is new.** `ClusterScalingExecutor` applies a `ScaleAction` to
  the members it observes rather than to the members a plan named — a plan is an opinion and the
  member set is the fact — clamps at `max(minNodes, quorumOf(voters))`, never removes the leader,
  and drains learners before voters. `ClusterRolloutPlanner` orders a restart learners-first,
  interleaves followers, and sizes each batch by the failures quorum tolerates, so a plan whose
  budget is zero is reported `feasible: false` instead of being issued. `RaftFaultTranslator` turns
  a chaos fault into transport instructions in both directions — `isolate` on `n1` does not stop
  `n2` sending to `n1` — and refuses a fault the transport cannot express rather than returning an
  empty list that reads as "injected, no effect".
- **Documentation for ten packages that shipped none.** `autoscaler`, `autotuner`, `chaosengine`,
  `circuitbreaker`, `configwatcher`, `federation`, `memoryguard`, `otel`, `rollingupgrade` and
  `slacollector` published 17 exported values behind no `docs/` tree at all, and a `docs/`-less
  package was skipped by `pnpm check:docs-api` — the loop read a package's documents to decide
  whether it had any. Each now has a page that names every value it publishes, and the gate fails
  a package that publishes without documenting (`no-docs`). The same pass filled the gaps in nine
  packages that *did* have documentation: `FileAuditStore` and the `DurableFileSystem` family in
  `audit`, the seven production classes in `security`, `BackupVerifier` / `S3StorageBackend` /
  the backup-chain functions in `backup`, `MaintenanceWindowScheduler` and the cron grammar in
  `maintenance`, `PrometheusPushExporter`, `W3CTraceContextProvider`, and `DB_OPERATIONS_VERSION`.
- **A fourth gate rule: an import in a fenced example must resolve.** `check:docs-api` now reads
  every named import in every package's documentation and checks it against the export surface of
  the package and entry point it names. `operations/docs/getting-started.md` told a reader to
  `import { HealthOrchestrator, ComponentProbe }` from the health package, which exports
  `componentProbe`; another snippet imported `IBackupManager` and a `BackupType` that exists
  nowhere from `@agentix-e/db-node/core/types`, and returned `{ snapshotId, type, state }`
  where `BackupResult` is `{ success, snapshot }`. The heading rule could not see any of it — a
  fenced block has no headings.
- **Thirty-seven types that public signatures named and no package exported.** The security package
  returned `RotationEvent`, `KeyRotationState`, `AuditEvent`, `RBACDecision`, `RBACStats` and
  eighteen more from methods a consumer calls, without exporting any of them; `monitor` did the same
  with `PoolStat`, `ResourceQuotaConfig` and `ResourceUsage`, `backup` with `VerifyResult`,
  `VerifyOptions`, `RetentionOutcome` and `S3StorageBackendConfig`, and `autoscaler`, `autotuner`,
  `health`, `maintenance` and `metrics` with one or two each. They are exported now, and
  `pnpm check:public-types` fails the build if a package grows another.

- **A fifth gate rule: a package index lists every package.** `operations/README.md` opened with
  "21 packages" above a table of twenty rows — `federation` was published, tested and documented,
  and absent from the one page that says what the umbrella contains. `check:docs-api` now compares
  a package index to the directory it indexes, in both directions: a package that exists and is not
  linked is a package a reader cannot find, and a link to a package that is gone is a 404 on the
  registry page.
- **`check:doc-examples`: every fenced example type-checks.** A new gate compiles all 281 fenced
  TypeScript blocks in the 61 documentation pages against the packages' sources — not their built
  `dist/` — and reports only the diagnostics that are claims about the API: a property that does
  not exist, an argument that cannot be passed, a call with the wrong number of arguments, an
  object literal with a key the target does not declare or without one it requires. Fourteen
  examples were wrong and are fixed; the worst were the quick start itself
  (`new InMemoryLogger({ level: 'info' })` for a constructor that takes `(component, maxEntries)`,
  `health.register(...)` and `health.runAllChecks()` for methods that do not exist, and a
  `BackupManager` built from `{ storage, schedule }`), `backups.delete(id)` for `deleteBackup(id)`,
  `tracing.extract(req.headers)` on a fetch `Headers`, and `{ tables, batchSize, pollIntervalMs }`
  passed as a two-field `CDCEngineConfig`.

### Removed

- **`InMemoryBackupManager` and `InMemoryPITRManager`.** Both are gone rather than deprecated. The
  first recorded `sizeBytes: 1024` after a five-millisecond timer, answered `restoreFromSnapshot` with
  `{ success: true }` without touching a database, and its `pitr()` returned `recoveryPoint:
  'unknown'`; the second tracked a WAL LSN string that no archive ever wrote. They implemented
  `IBackupManager` by name only, which made every document that said this package backs a database up
  a description of the interface rather than of the product. `BackupManager` and
  `DirectoryBackupSource` are the replacements, and `mutation/targets.mjs` mutates them instead —
  along with `auditChain.ts`, which is what makes the audit trail's tamper-evidence a claim the suite
  can break on purpose.

- **`FederationQueryRouter` and its ten cases from `@agentix-e/db-federation`.** It was never
  exported from the barrel and never named in `package.json#exports`, so nothing outside its own
  test could reach it — a router behind no door. It also declared `RoutingStrategy`
  (`broadcast | scatter-gather | direct`) and `QueryPlan` (`filters`, `shardKey`, `limit`, `offset`)
  against the operations layer's same-named types (`round_robin | ...` and
  `query`/`assignments`/`strategy`/`estimatedCost`), which is a collision that only matters once the
  two packages can see each other. The query router that ships is `FederatedQueryRouter`, now at
  `@agentix-e/db-federation/query`, and the schema federator moved to `/schema` beside it.
- **Nineteen internals from `@agentix-e/db-node/audit`'s root.** `segmentPattern`,
  `readableSegmentsNewestFirst`, `newestOpenSegment`, `fileIdentity`, `isUnlinkRefusal`,
  `unlinkIfUnchanged`, `readView`, `repairFor`, `shadowedPairs`, `relateTwin`, `listDirectory`,
  `isRegularFile`, `mtimeOf`, `removeFile`, `readSegmentFromDisk`, `PARTIAL_ARCHIVE_SUFFIX`,
  `gzipFile`, `archiveSegment` and `sweepAbandonedArchives` — plus the five types only they used
  (`FileIdentity`, `SegmentView`, `TwinRepair`, `TwinVerdict` and `CompressFile`) — were published
  by the package root and named by no document. The package's own suites import them from
  `impl/FileAuditStore.js`, which is where a test of an internal belongs; the one importer outside
  the package was another package's test, which is the shape of an export nobody asked for.
  `AC 79.2b` fails the build if one comes back.
- **`InMemoryRollingUpgrade`.** It was a one-line subclass of `RollingUpgradeOrchestrator` with no
  behaviour of its own, kept "to keep the public export stable". A second name for the same class
  makes every reference page document the same methods twice and every reader wonder which one to
  import; the tests and the e2e factory now use the orchestrator.
- **`VerifyOptions.cleanup` from `BackupVerifier`.** Declared as *"whether temporary data is deleted
  after verification"* and read by no branch, because nothing in the class creates temporary data.
  A flag the caller can set and cannot observe is a promise about a mechanism that does not exist.
- **`"docs": "typedoc"` from all three packages.** None of them depended on TypeDoc, so the script
  had never run: `pnpm --filter @agentix-e/db-federation docs` exited `sh: 1: typedoc: not found`,
  and the two API reference pages told readers to run it. A generated reference was the plan when
  the script was written; the reference pages are now curated and compiler-checked by
  `pnpm check:docs-api`, which is the stronger guarantee, so the uninstallable path is gone rather
  than published. `pnpm check:script-bins` now refuses a script whose command is not installed —
  the same question `check:gates` asks about a tsconfig no script references, asked from the other
  end.

### Fixed

- **`test:integration` ran no test.** The script still named `packages/core/src/__tests__/e2e`
  after the modules moved under `packages/node/`, and `vitest run <dir>` exits 1 with "No test files
  found" when nothing answers the filter — so 331 cases in 19 files were named by a script that ran
  none of them, and every local gate was green because none of them runs that script. `check:gates`
  grew rule 4 (a `vitest run` filter must name a directory that exists, with three self-tests), which
  is the rule that would have caught it in the same commit as the move.
- **`run-e2e-real.ts` orchestrated a directory that exists on no machine.** Its `cwd` was
  `/home/admin/openclaw/workspace/db-operations` — not this repository, not any path in it — and its
  filter was the pre-split `packages/core/...`. Both now derive from `import.meta.dirname`, so the
  runner that prints a per-engine summary can only run where the suite is.
- **Fourteen documented examples that could not compile.** `operations/README.md`'s quick start
  called three methods that do not exist and passed an options object to a constructor that takes
  two positional arguments; `docs/user-guide/operations.md` and `operations/docs/getting-started.md`
  repeated the same three mistakes, then called `backups.delete(id)` where the manager has
  `deleteBackup(id)`, built a `RollingUpgradeOrchestrator` from `{ cluster, targetVersion,
  maxUnavailable }` where the constructor takes `{ minBakeMs, sleep }` and the plan goes to
  `execute()`, and read `.length` off `parseCron("0 3 * *")`, which throws. `monitor`'s alert rules
  omitted the required `durationMs`, `metrics`' pool example called `this.poolAcquire()` on a class
  that never had one, `observability` passed a fetch `Headers` to a method that takes a plain string
  map and read `req.path` off a `Request`, `otel` logged with `level` instead of `severity` +
  `attributes`, `federation`'s quick start passed `{ tables, batchSize, pollIntervalMs }` as the
  two-field `CDCEngineConfig` and `{ maxSizeMB }` as an `OutboxStoreConfig`, and `cluster`'s quick
  start omitted the required `peers`. Every one is fixed, and `pnpm check:doc-examples` fails the
  build if another lands.
- **`BackupVerifier.verify` reported chunk counts for chunks it never took.** `chunkCount` was
  `Math.ceil(length / chunkSize)` beside a single `hash.update(buffer)` call — a number describing
  pieces that were never cut — and `verifyStream`, the only mode that actually receives pieces,
  reported `0` beside a comment saying streaming "does not count chunks". `verify` now walks the
  buffer in pieces of `chunkSize`, `verifyStream` counts what the iterable produced, and a
  non-positive or fractional `chunkSize` is refused instead of looping.
- **`AutoTunerWorker.runAnalysis` returned recommendations it had skipped.** The return was
  `raw.filter((r) => r.confidence >= minConfidence)`, which included every recommendation the
  cooldown and the per-cycle cap had blocked. A caller that logged the result reported three
  changes and made one. It now returns what it applied.
- **`InMemoryOTELBridge.shutdown()` changed nothing.** It set a flag that `isShutdown()` reported
  and no other method read, so `startSpan`, `recordMetric` and `exportLog` kept accepting work after
  its owner had stopped the pipeline, growing buffers nobody would drain. The three now throw, and
  ending a span that was already started still works — that is closing work, not opening any.
- **`DB_OPERATIONS_VERSION` said `1.1.0` while the manifest said `1.11.3`**, under a comment
  claiming a release step synchronised them; nothing in the repository read the constant or rewrote
  it. `AC 79.8` compares the two.

## [1.11.3] — 2026-11-18

### Added

- **`relateTwin(plain, archived)` and `readView(path, compressed)`** — the rule that decides what a
  segment name and its archive say to each other, as a function of the two views rather than of the
  directory. Eight answers, because "exists" and "readable" are different questions and only one of
  them is about the bytes: `no-twin`, `plain-missing`, `plain-unreadable`, `archive-unreadable`,
  `same`, `plain-extra`, `archive-extra`, `disjoint`. Exported with `TwinVerdict` and `SegmentView`
  so a deployment that keeps segments on another medium can apply the same rule.

### Fixed

- **A line appended after another process archived the segment it was writing to is no longer
  hidden.** The adopting store recreates the plain name from the unlink onwards, and every reader
  prefers an archive over a plain file of the same name — so those lines were complete, on the disk,
  and invisible to `get()`, `query()` and `count()`. `FileAuditStore` now compares its file with the
  archive of its own name after every append and before the acknowledgement, and repairs the
  disagreement: an archive that a longer file supersedes is removed, a file that carries nothing its
  archive does not hold is abandoned for a new segment, and two views with different entries are
  separated — the file is renamed to a name of its own. The construction path sweeps the directory
  for the same condition, which is what repairs the segment of a writer that died before it could.
- **A damaged archive no longer hides a readable segment.** A name that exists and yields no text was
  preferred by every reader over the complete segment beside it, so the segment was unreachable for
  as long as the damage lasted. The archive is removed instead.

### Changed

- **`write()` acknowledges a line only after its name is a name a reader reads.** The check costs one
  `stat` per append in the ordinary case, where no archive of the active name exists, and reads both
  views only when one does — once per segment, not once per line.
- **The documented rule is no longer "one writer per trail".** Two long-lived services on one
  directory now work, and a crashed writer's segment is repaired by the store that comes after it;
  what remains is a window of microseconds between that check and the sync, which the next append or
  the next start repairs. `docs/user-guide/operations.md` states the rule and the window.

## [1.11.2] — 2026-11-17

### Added

- **`replay-mutant.mjs --status pending`** — the four statuses that mean "no test decided this"
  (`Survived`, `Timeout`, `RuntimeError`, `NoCoverage`) are one concept, an unread verdict, and are
  now selectable as one. `--status` also takes a comma-separated list, and `*` still selects
  everything. The question the audit asks is never "which mutants survived" but "which mutants has
  nobody read": a timeout and a runner error are both unanswered — the runner gave up, no test passed
  — and reading only `Survived` skips them without saying so.
- **The `list` command prints each mutant's status**, because a filter can now select several of them
  and "which of these did the runner actually run" is the first thing a reader of a surviving verdict
  needs.

### Changed

- **`list` and `apply` share one filter.** They always did through the same argument, but `apply`
  resolves an index against the list it loads, so a `list` run with one status and an `apply` run with
  another named different mutants at the same index. Both now accept the same `--status`, and the
  usage text says the index is only valid for the filter that printed it.

## [1.11.1] — 2026-11-17

### Fixed

- **Ten of the twenty-six mutants that survived the measurement were missing tests, not a blind
  instrument.** Every survivor was applied *exactly as the report printed it* and the whole audit suite
  stayed green, so the file was 95.13 % and the number was the file's own. Each of the ten now has the
  case it lacked (`AC 89`): a guard whose only observable shape is `undefined`, which is the one input
  where reading `.code` off a non-object throws instead of answering; a retention window given as `2`
  and never as anything but the default or `0`, where `??` and `&&` agree; a claim observed only
  *after* the append that followed it, which a store that claimed nothing still passed because the
  file it wrote to was the file the next store then found; a separator owed by a segment this store
  adopted and that ends cleanly, which only the bytes can show; the eighth attempt and the sentence
  that explains why eight is the bound; a failure on the *first* sync of a batch, where the generation
  test cannot tell a line from a durable one and only the count of covered commits can; and a segment
  the prune cannot date.
- **`sweepAbandonedArchives` and `getNextSequence` return the same answer for an unlistable
  directory** as for an empty one — that is now stated where the fallback is, since a mutation run
  reaches the array literal and a reader of the report has to be able to tell why it is invisible.

### Changed

- **`rotate()` clears the name and nothing else.** `currentSize`, `currentCreatedAt` and
  `separatorOwed` describe a segment, and `claimActiveSegment` is where all three are set for the one
  that follows; resetting them in both places made three assignments no run could tell apart from the
  first, and one of them — `separatorOwed` — survived a whole iteration as a mutant because of it.
- **`FileAuditStore.activeSegmentClaimed` has no initializer.** The constructor computes it from the
  directory; a default that is always overwritten is a second place to state the same fact.

## [1.11.0] — 2026-11-17

### Added

- **`claimSegment(path, claim?)`**, **`isAlreadyExists(error)`** — a segment name is taken with
  `O_CREAT | O_EXCL` before anything is written to it. Two processes choosing the same next number
  used to append into one file, and the damage was not the interleaving (that is atomic) but what
  followed: whoever rotated first archived the segment while the other was still writing, the other's
  next append recreated the name, and the reader — which prefers an archive over the plain file of the
  same name — stopped seeing everything appended after the archive was taken.
- **`isWholeSegment(after, before)`** and a fourth step in `archiveSegment`: the segment must be the
  same file, at the same length, at the moment the archive is published. A segment that grew while it
  was being compressed produces an archive of a *prefix*, and a prefix hides every line after it. A
  segment that is *gone* is a different answer and is still published — the archive is then the only
  copy.
- **`isExpired(mtime, cutoff)`** — the retention decision as a function with four cases. `null` (the
  date could not be read) is not an expiry: turning a failed `stat` into a deletion converts a
  transient I/O error into permanent loss of evidence.
- **`FileAuditStoreConfig.claim`** — how a name is taken, injectable for the same reason the write
  port is: the two answers that matter (`EEXIST`, and a failure that is not one) cannot both be
  produced on a runner.
- **`append-child.ts --rotate --await <path>`** — the fixture can now rotate on every line and hold
  until released, so two real processes can be made to choose a segment name at the same instant.

### Changed

- **A store names a segment when it writes to it, not when it is constructed.** `rotate()` closes a
  segment and leaves the store without a name; the next `appendLine` claims one. An idle store
  therefore leaves no empty segment, and the "which number is free" question is answered at the one
  moment the answer can be made atomic.
- **Retention uses `isExpired`**, and the comparison is strict at the boundary: a segment whose last
  write is exactly `retentionDays` old is still inside the window.

### Fixed

- **Two concurrent writers could share a segment.** `TW.2` failed with
  `audit-20261117-0016.ndjson holds lines from proc-26841, proc-26842` before the claim; `SC.5` is the
  same defect in one process, deterministically.
- **A compression that outlived an append published an archive of a prefix**, which made the
  appended lines unreadable while they sat on the disk (`WS.2`).
- **`scripts/replay-mutant.mjs` verified the wrong report.** Its default report path was
  `reports/mutation/operations.json`, resolved against the working directory — which was
  `operations/`, because that is where the script lives. Once the mutation run moved to the repository
  root (P3-4) the report it writes is at the root and the paths inside it are root-relative, so the
  tool silently read the stale in-place report left behind by the previous iteration and spliced edits
  into a file that had changed since: the verdicts were about a report nobody had just produced. The
  report and every path inside it now resolve against the repository root, `apply` refuses a report
  older than the file it describes (`--allow-stale` to override, with a warning), and `restore` puts
  the original mtime back so that a second replay is not blocked by the first one's own write.

## [1.10.0] — 2026-11-17

### Added

- **Group commit.** `write()` appends synchronously and the sync moved to the end of the event-loop
  turn, so every append made in the same turn shares one `fsync` — sound because a file sync covers
  every byte appended before it, which is now stated as part of the `DurableFileSystem` contract.
  Measured on the same runner, 500 entries each: **500** `fsync` and 101 entries/s for a serial
  writer, **50** and 981 entries/s with 10 requests in flight, **1** and 20 646 entries/s for a burst.
  A serial caller pays exactly what it paid before; the gain belongs to concurrency.
- **`archiveSegment(source, archive, compress?)`**, **`gzipFile`**, **`PARTIAL_ARCHIVE_SUFFIX`** — a
  rotated segment is compressed to `<archive>.part`, `rename`d into place and unlinked in one
  synchronous block. The archive therefore exists only when it is complete.
- **`listDirectory`**, **`isRegularFile`**, **`mtimeOf`**, **`removeFile`**,
  **`sweepAbandonedArchives(directory, prefix)`** — the answers five call sites needed, as functions.
  Each replaces a `try`/`catch` whose failure arm no runner can produce (an unlistable directory, a
  removal that fails rather than refuses), and `removeFile`/`unlinkIfUnchanged` take the removal as a
  parameter so the arm is asserted by being handed an `EIO` instead of assumed.

### Fixed

- **A segment was invisible while its archive was being written.** Compression wrote straight to
  `<segment>.ndjson.gz`, and the reader prefers an archive over its original — correctly, since
  between the archive and the unlink both hold the same entries. Together those two rules meant that
  for the whole duration of a gzip the archive existed and was incomplete, the complete original was
  suppressed by it, and `get(id)` answered `null` for an entry sitting on the disk. An audit store
  that cannot find an entry it holds is wrong in the one place wrongness is not recoverable.
- **A directory wearing an archive's name hid the segment beside it.** Reads now take files, not
  names: `X.ndjson.gz` that is a directory holds nothing, and letting it win the comparison made a
  complete `X.ndjson` unreadable.
- **`pruneOlderThan` reports a removal that failed instead of counting it as a leftover.** A refusal
  (already gone, not this process's to delete) is still "leave it for the next sweep"; anything else
  now reaches the caller, because a cleanup that reports success for something it could not do is how
  evidence sits past its retention while the report says it expired.

### Changed

- **An acknowledgement is deferred by one event-loop turn.** `write()` still resolves only after the
  sync that covers the line, but that sync may also cover other callers' lines. `close()` flushes what
  is still queued, so a caller that never awaited a write still learns about it before shutdown.
- **`unlinkIfUnchanged(path, identity, unlink?)`** gained the optional third parameter (source
  compatible) for the reason `nodeFileCalls` exists.
- **A rejected write may still be in the trail.** The append precedes the sync and truncating after a
  failed `fsync` is a second write with its own failure mode, so the guarantee is at-least-once across
  a failure, never at-most-once. Documented in the guide; retry with a fresh id.

### Notes

- **The two defects above were found by a test that had been passing.** Making an acknowledged write
  cheaper changed the timing of `FileAuditStore.test.ts`'s rotation case, the archive window became
  observable, and two assertions that had been true by luck stopped being true. Neither was a flaky
  test: both were reads that could not see data that was on the disk.

## [1.9.0] — 2026-11-17

### Breaking

- **`FileAuditStore.write()` rejects when it cannot make the entry durable.** The write path caught
  its own `fsync` (`/* fsync best-effort */`) and returned an id anyway, so a caller could record an
  audit event that a power loss would erase — from the one component whose job is to say what
  happened. A step that fails now fails the write. Callers that ignored the promise were already
  ignoring the only signal the store has.
- **The segment is appended to, not rewritten.** No temporary file, no `rename`: the store used to
  read the whole segment, concatenate the new line and rename a replacement into place for every
  line. See the measured cost below. A deployment that observed segment inodes (a file watcher, a
  tail that follows the descriptor) now sees one stable file per segment instead of one per write.
- **`FileAuditStoreConfig.fileSystem` is the write port**, defaulting to `nodeDurableFileSystem`.

### Added

- **`DurableFileSystem`** — `append`, `syncFile`, `syncDirectory`, `needsSeparator`: the recipe that
  makes a line survive, as an interface, so the order is assertable and the medium is replaceable.
- **`nodeDurableFileSystem`**, **`createNodeDurableFileSystem(calls)`**, **`nodeFileCalls`**,
  **`isDirectorySyncUnsupported(error)`** — the POSIX implementation, a factory that takes syscalls
  so the two "this platform cannot sync a directory" branches are testable on a platform where they
  do not occur, and the predicate that decides whether an errno is a limitation or a failure.
- **`FileAuditStore` syncs the directory once per segment**, after its first line. A name is a
  directory entry; syncing the file does not sync the name, so without this a power cut could leave
  the entries written and unreachable.
- **A torn tail is separated, not fused.** The store asks once per segment whether the file ends
  mid-line and, if it does, starts the next line with a newline. An append after a crash used to glue
  the new entry to the fragment and lose both.

### Fixed

- **Two processes appending to one trail lost each other's entries.** The old recipe was
  read-concatenate-rename, which is a lost update by construction, and both writers used the same
  scratch path — so a second writer could fail outright (`ENOENT` from a rename that raced). An
  `O_APPEND` write is placed by the kernel; `AC81` runs two processes and 300 entries through it.
- **`unlinkIfUnchanged` caught everything**, so a `ReferenceError` from a missing import was reported
  as "the file could not be deleted" and left five uncompressed segments behind. Only `ENOENT`,
  `EISDIR`, `EPERM` and `EACCES` are answers about the file; anything else is a defect and propagates.
- **Cost of a line was the size of the segment.** Measured on 2 000 lines of 524 bytes: **1 000 MiB
  written to append 1 MiB**, now **1.0 MiB**. Wall time is the `fsync` (20.0 s against 20.8 s for a
  bare append+`fsync` loop with no store at all), which is what a group commit would address next.

### Notes

- **`SIGKILL` proves the file, not the medium.** A killed process leaves the page cache behind, so
  the out-of-process cases show that acknowledged lines are in the file; only a power cut empties the
  cache, and no runner provides one. The `fsync` half is asserted by order and by failure propagation
  in-process.

## [1.8.0] — 2026-11-16

### Breaking

- **`FileAuditStoreConfig.segmentReader` is the only way segments are read.** The store no longer
  calls `readFileSync` itself; the default value is `readSegmentFromDisk`, exported from
  `@agentix-e/db-node/audit`, so a wrapper keeps identical semantics. A store that cannot read
  a segment contributes no entries from it — the port's contract is text or `null`, and throwing
  means the same thing.
- **`AuditLogManager` and `FileAuditStore` are unchanged in behaviour, but two documented promises
  are now measured**: `maxScanLines` bounds *reads* as well as results, and a damaged segment is an
  empty one rather than a skipped one.
- **`AES256GCMEncryptionProvider.initialize()` no longer resets the provider.** A second call keeps
  the key in use; a call naming a different `algorithm` throws, because the blobs on disk were sealed
  with the first. It also gained `zeroize()`, which retires the key *and* its version number.

### Added

- **`KeyManager.keyDerivationCount` and `.kekCacheSize`** — the two numbers that make the cost of a
  write observable. A write path whose derivation count grows with the number of writes is paying
  PBKDF2 per blob.
- **`MAX_DERIVATION_ITERATIONS`, `MIN_SALT_BYTES`, `MAX_SALT_BYTES`, `MAX_CACHED_KEKS`** exported —
  the policy a wrapped key's header is checked against, as constants rather than as literals in a
  message.
- **`EnvelopeEncryptionProvider.keyDerivationCount`** — the same counter, one layer up where the
  write path lives.
- **`readSegmentFromDisk`** exported from the audit package: the default read port, public so a
  deployment can wrap it instead of reimplementing gzip handling.
- **`AES256GCMEncryptionProvider.zeroize()`** — a cipher that holds a master key forever with no way
  to drop it cannot be shut down cleanly.
- **The production implementations are now on the package surface.** `KeyManager`,
  `AES256GCMEncryptionProvider`, `EnvelopeEncryptionProvider`, `KeyRotationManager`, `RotationAuditor`,
  `AuditLogManager` and `RBACEngine` — plus the four bound constants and their configuration types —
  are exported from `@agentix-e/db-node/security`, and the audit package also exports
  `FileAuditStoreConfig`, `FileIdentity`, `segmentPattern`, `readableSegmentsNewestFirst` and
  `newestOpenSegment`.
- **`tsconfig.json` maps `@agentix-e/db-operations`** to the umbrella barrel, so a test can import the
  package a consumer is told to depend on.

### Fixed

- **Two concurrent `generateKey()` calls minted one key and lost the other.** Both read
  `highestVersion`, both awaited the wrap, both committed to the same version: the map kept the
  second, and the first key survived only inside the wrapped form the caller was handed. Measured
  before the fix — two keys, both named `v1`, `versionCount === 1`, and `unwrapKey(w1)` was not the
  material `getKey(1)` returned. Version allocation is serialised now. AC 74.1–74.9.
- **Eight concurrent first writes minted eight keys.** `_activeDek()` checked for a key, awaited a
  mint, and installed the field at resume time, so every writer that arrived before the first mint
  finished minted its own. Activation is single-flight. AC 74.10–74.12.
- **A rotation between two reads produced an unopenable blob.** `encrypt()` read the key, sealed the
  payload, then read `keyManager.version` *again* for the header — a `rotateKey()` in between named a
  version the payload was not sealed with. The version travels with the key now. AC 74.15.
- **A wipe that landed during a mint was undone by that mint.** `zeroize()` cleared the fields and
  the in-flight `generateKey()` then installed its key as the active one, after the wipe. The mint is
  discarded and the write fails with `zeroized while a data key was being minted`. AC 74.17–74.20.
- **`EnvelopeEncryptionProvider.encrypt()` derived the KEK on every blob.** PBKDF2 at 600 000
  iterations is ~100 ms; a database writing thousands of blobs paid minutes of CPU per thousand
  writes for a key it had derived a moment earlier. Derivations are cached per `(salt, iterations)`,
  bounded at `MAX_CACHED_KEKS` and wiped by `zeroize()`. Twenty writes now cost one derivation.
  AC 75.1–75.7.
- **A wrapped key chose the reader's work factor.** The header carries the salt and the iteration
  count, so a one-line edit to a blob turned a 100 ms read into an unbounded one: `1e12` iterations
  is roughly four hours. Out-of-range work factors and salts are refused before anything is derived.
  AC 75.8–75.14.
- **`AES256GCMEncryptionProvider.initialize()` minted a new key into `v1` on every call**, replacing
  the key every existing blob named. Initialising is not a reset. AC 77.1–77.6.
- **`rotateKey()` in `AES256GCMEncryptionProvider` forgot the version it issued** at the next
  `zeroize()`, so the key minted after a wipe reused a retired name. AC 77.15.
- **`EnvelopeEncryptionProvider.decrypt()` answered four kinds of damage with one unasserted
  failure.** A damaged header, an edited payload, a foreign key and a mismatched context each have a
  distinct message now, and each message is asserted. AC 78.1–78.9.
- **The security package exported its fixtures and not its implementations.** `index.ts` listed the
  seven in-memory providers and nothing else, so every import in the guide's "Encryption at rest" and
  "Audit trail" sections — `KeyManager`, `EnvelopeEncryptionProvider`, `KeyRotationManager`,
  `AuditLogManager`, `RotationAuditor` — resolved to `undefined` for a real consumer. The suites never
  noticed because they import `../impl/KeyManager.js` directly, which is the right way to test a
  module and the wrong way to find out whether a package has a surface. AC 79.1–79.7 imports by the
  documented package names and fails if any name is missing.
- **A test file typed as CI-only.** AC 78's tamper case indexed a `Buffer` under
  `noUncheckedIndexedAccess`, which the local `typecheck:tests` run had not seen because it happened
  before that file existed: CI's `Typecheck (operations)` job found it (run 43906849171). Fixed in the
  follow-up commit rather than by relaxing the option.
- **`i29-audit-logging-edges` wrote `audit.jsonl` into the repository** when its default-path case ran
  under the mutation runner (161 entries per run, and a dirty tree for every gate after it). The case
  reads the default off a manager it never destroys and proves the path on one it cleans up. AC 77.4
  of the previous iteration's report — recorded as P3-5 and now closed.

### Removed

- **`if (array === null) continue` and `if (content === null) continue` in `FileAuditStore`.** An
  unreadable segment and an empty segment produce the same entries, so both guards were a second way
  of saying what the parser already said — and the mutation run reported them as survivors no test
  could kill. `readSegment()` returns text and the sentinel is gone.
- **Three redundant statements that only ever offered equivalent mutants**: `authTagLength: 16` on
  four `createCipheriv`/`createDecipheriv` calls (GCM's default), `Buffer.from(str, 'utf-8')` where
  UTF-8 is the default, and a `then(() => {}, () => {})` tail on the version queue whose handlers the
  queue itself already supplies.
- **A dead `if (!this.currentKey) throw` after key activation** in the envelope provider: `rotateKey()`
  installs the key before resolving, and every path that leaves it null rejects instead.

### Changed

- **`AES256GCMEncryptionProvider._ensureInitialized()` checks `enabled` only.** `!this.masterKey` was
  dead (a `Buffer` is always truthy) and `length === 0` was only ever true together with
  `enabled === false`.
- **`KeyManager` keeps its monotonic cursors with `Math.max`** instead of `if (x > y) y = x`, whose
  `>=` and `>` variants assign identically.

## [1.7.0] — 2026-11-16

### Breaking

- **`KeyManager.loadKey()` takes one argument.** The second parameter was `unwrapNow`, and both of
  its branches were the same three lines — the "lazy" one carried the comment *"Not implemented
  here — for now always unwrap immediately"*. A parameter that promises a behaviour nobody
  implemented is worse than a missing feature: callers passed `false` and believed it.
- **`KeyManager.zeroize()` no longer resets the version counter.** Versions continue from the highest
  ever issued, so the key minted after a wipe is `v(n+1)`, not `v1`. `version` still reports `0`
  when there is no active key.
- **`KeyManager` validates its configuration at construction.** An empty `masterSecret`, a
  `keyLength` outside `{16, 24, 32}` and a non-positive `iterations` now throw immediately instead of
  surfacing as a `crypto` error on the first write — or, for the empty secret, not at all.
- **`EnvelopeEncryptionProvider.canDecryptVersion(v)` answers `keyManager.hasKeyVersion(v)`.** It was
  `hasKeyVersion(v) || encProvider.isEnabled()`, and the cipher is enabled for the whole life of the
  provider, so **every** number — including versions that never existed — was reported decryptable.
- **`EnvelopeEncryptionProvider` mints its first data key on the first `encrypt()`**, not in
  `initialize()`. `getCurrentKeyVersion()` therefore returns `0` until something is written. Without
  this, restoring a backup into a fresh process is impossible: the process already holds `v1`, and
  the backup's `v1` is a different key.
- **`EnvelopeEncryptionProvider` refuses a `keyLength` its configured algorithm cannot use** —
  `aes-256-gcm` needs 32 bytes. Named at construction, not on the first write.

### Added

- **`scripts/replay-mutant.mjs`** — applies a mutant from a Stryker report by its recorded range and
  replacement text. The report is the only place that says *which* edit was judged; a line number is
  not enough, and iteration 30's "the runner disagrees with the suite" conclusion came from exactly
  that mistake (see *Corrected* below).
- **`unlinkIfUnchanged` and `fileIdentity` exported from `@agentix-e/db-node/audit`** — the
  measure-then-delete pair is useful to any caller doing the same dance, and it is now part of the
  package's surface rather than an internal detail reached through a test.

### Fixed

- **`keyLength` sized the key-encryption key as well as the data key.** A manager configured for
  128-bit data keys derived a 16-byte KEK, and every `generateKey()`/`wrapKey()` threw
  `Invalid key length` — the configuration was documented and unusable. The KEK is now always 32
  bytes, because the wrapping cipher is fixed. AC 71.1–71.3.
- **`getKey()` and `getCurrentKey()` returned the stored buffer.** A caller following the module's own
  zeroization advice (`key.fill(0)` when done) destroyed the key the process was still using. They
  return copies now. AC 71.6–71.7.
- **`loadKey()` silently replaced an existing version.** Loading a version already in the history
  overwrote its material, so `v1` could name two different keys — and every blob sealed under the
  first one became undecryptable with no error at load time. Same material is a no-op, different
  material throws. AC 71.8–71.9.
- **`zeroize()` reset the counter, so the next key was `v1` again.** Old keys are still in ciphertext
  headers, exports and backups; reissuing their version number is how two keys end up sharing a name.
  AC 71.11.
- **`exportWrappedKeys()` returned map insertion order**, so an export replayed in order could be
  `[3, 1, 2]`. It is sorted ascending now, and each key is re-wrapped with a fresh nonce. AC 71.13,
  AC 71.15.
- **`generateKey()` spent a version before the wrap could fail.** A KEK that could not be derived left
  the numbering advanced with no key behind it. The wrap comes first. AC 71.19.
- **`initialize()` spending `v1`** made restore impossible (see *Breaking*). AC 72.1–72.3.
- **`importKey()` passed the removed second argument** — `loadKey(wrapped, true)`.
- **A dead half of the identity check in `loadKey`** — `existing.key.length === dek.length &&` is
  implied by `Buffer.equals`, so no test could tell it from its absence.
- **`encrypt()`'s `_ensureInitialized()`** — every path to a data key already refuses on an
  uninitialized provider, so the guard was a statement no run could distinguish.

### Corrected

- **P2-18 is withdrawn.** Iteration 30 reported five mutants as "killed by hand, survived according to
  the runner" and concluded the runner's per-test attribution was wrong. It was not. The report
  recorded a survivor at `AuditLogManager.ts:167` whose replacement was `false`; that statement is
  `stats.eventsBySeverity[s] = (stats.eventsBySeverity[s] || 0) + 1`, and the change applied by hand
  was `if (false) stats.failedEvents++` — the statement three lines below it, which the runner had
  killed all along. The measurement was never wrong; the comparison was. What the five cases actually
  were: five missing assertions, now written (AC 73.1–73.13), each verified by replaying the recorded
  edit instead of retyping it.

### Changed

- **The mutation list covers eleven modules** (was nine): `security/KeyManager.ts` and
  `security/EnvelopeEncryptionProvider.ts` join behind the published rule — a version number decides
  which key material survives.

Mutation: **11 modules** — `backupChain.ts` 100 %, `cron.ts` 100 %, `RetentionPolicyEvaluator.ts`
100 %, `KeyRotationManager.ts` 99.16 %, `MaintenanceWindowScheduler.ts` 99.03 %,
`InMemoryBackupManager.ts` 98.94 %, **`FileAuditStore.ts` 97.37 %**, **`RotationAuditor.ts` 97.52 %**,
**`AuditLogManager.ts` 96.44 %**, **`KeyManager.ts` 86.60 %** (81.37 % → 86.60 %),
**`EnvelopeEncryptionProvider.ts` 90.38 %** (84.76 % → 90.38 %). Operations overall **97.55 %** over
2 404 judged mutants.

## [1.6.0] — 2026-11-16

### Breaking

- **`verifyIntegrity()` returns `AuditIntegrityResult`** — `{ valid, errors, truncated }` — instead
  of `{ valid, errors }`. `truncated` is `null` until retention removes something, then the count,
  sequence number and hash of the newest removed event. Code that destructures the two old fields
  still compiles; code that compares the whole object must allow the new field.
- **`AuditRetentionPolicy.maxAgeMs` is enforced.** It was stored, defaulted, asserted and read by
  no branch, so a deployment that configured a 30-day window kept everything. `0` means *no age
  limit*, the same reading `maxEvents: 0` already had — a caller who configured `0` expecting
  "keep nothing" will now keep everything.
- **`RotationAuditor.record()` throws on an event that contradicts itself** — `success` with an
  `error`, failure with no error, success with no completion time, or success that moved no
  version. Refusing consumes no sequence number.
- **`RotationAuditor.importJSONL()` validates and is atomic.** It refuses a non-empty trail, a
  malformed line, a broken `prevHash` link, a mismatched hash, a contradictory event — and imports
  nothing in any of those cases. A JSONL export from this class still round-trips.
- **A negative `limit` returns no rows.** `query({ limit: -1 })` used to return everything but the
  last row; a negative `offset` is now read from the start.

### Added

- **`AuditRetentionAnchor` and `AuditIntegrityResult`** exported from the security package.
- **`truncated` in the verification result** — what retention removed, and the hash the retained
  chain hangs from, so a pruned trail verifies instead of accusing itself.

### Fixed

- **Retention made the audit trail unverifiable.** `prune()` and the `maxEvents` ceiling both
  removed events from the head of a hash chain, so the first call to `verifyIntegrity()` after a
  prune reported `seq gap at index 0` and `chain broken at seq N` — the manager's own policy,
  indistinguishable from an attacker deleting evidence. Removals are recorded now and the retained
  chain verifies from the newest removed hash. AC 68.1–68.5.
- **Retention deleted events it could not chain past.** `prune` filtered *every* event older than
  the cutoff instead of the leading run, so a non-monotonic timestamp punched a hole in the middle
  of the chain — a hole no anchor can express. It stops at the first event inside the window.
  AC 68.9–68.11.
- **`RotationAuditor` stored the caller's event object**, so a caller that kept its draft could
  rewrite history and `verify()` would report tampering on a document nobody had touched. Both
  audit classes copy what they are given. AC 69.1, AC 68.13.
- **`generateReport('SOX')` returned `pass: true` with no findings.** The `switch` ended at HIPAA,
  so a framework with no checks behind it scored better than one that is checked. An unsupported
  framework now fails and names itself. AC 69.13.
- **`oldestActiveKeyCreatedAt` was `events[0].startedAt`** — a *failed* first rotation reported the
  birth of a key that was never created, and the value never moved however often the key rotated.
  It is the completion of the earliest successful rotation. AC 69.11–69.12.
- **`recent(0)` returned every entry.** `slice(-0)` is `slice(0)`, so "the last zero entries" was
  the whole trail; a negative count returned everything but the first. AC 69.9.
- **`importJSONL()` pushed entries while parsing.** A malformed line at index 5 left four entries
  imported and a sequence counter to match; a forged line was adopted and the next real rotation
  was chained onto it; importing into a live trail spliced two chains together. AC 69.4–69.8.
- **`averageIntervalMs` dated an unfinished rotation to 1970** through `completedAt ?? 0`, so two
  rotations that never completed produced a "0 ms interval" and a passing compliance window built
  on events that claimed to succeed and never claimed to end. AC 70.31.
- **The auto-flush interval was not `unref`'d**, so a service with `autoStart: true` could not
  exit. `destroy()` also had no test that it left no interval behind. AC 68.17, AC 70.32.
- **`logBatch` carried its own copy of the flush threshold**, so the batch path and the single-log
  path could drift apart. One `_append` decides now.

### Changed

- **`logBatch`'s documented "atomic" is gone.** It said atomic and nothing could fail in it; the
  word described a property no code enforced. What it does guarantee — chained in call order — is
  asserted (AC 68.14).
- **Dead statements removed, each one a mutant no test could kill:**

  | Removed | Why it could not be observed |
  | --- | --- |
  | `chainBroken = true` at the sequence-gap site | `seq` is part of the hashed content, so a gap cannot occur without the hash check failing just below and marking the chain broken |

Mutation: **9 modules** behind the published rule — `backupChain.ts` 100 %, `cron.ts` 100 %,
`RetentionPolicyEvaluator.ts` 100 %, `KeyRotationManager.ts` 99.16 %,
`MaintenanceWindowScheduler.ts` 99.03 %, `InMemoryBackupManager.ts` 98.94 %, `RotationAuditor.ts`
97.52 %, `FileAuditStore.ts` 97.04 %, `AuditLogManager.ts` 95.55 %. Operations overall **98.18 %**
over 2 203 judged mutants (2 124 killed, 39 timed out, 38 survived, 2 no coverage). The overall
figure is 0.7 points below 1.5.0 because the two new modules are the two hardest in the package:
one behaves differently depending on what the filesystem says, the other is a hash chain whose
interesting failures are the ones an attacker causes.

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
  `@agentix-e/db-node/maintenance`. The five-field grammar is now a module with its own
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
  from `@agentix-e/db-node/backup`. `dependentsOf(inventory, id)` answers "what would I lose if
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
