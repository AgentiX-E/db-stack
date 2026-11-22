/**
 * What the mutation gate is made of, per package.
 *
 * This file is data, not configuration: `stryker.config.mjs` at the repository
 * root selects one entry from it and hands the result to Stryker. The split
 * exists because the selection can throw (running Stryker without a target is a
 * mistake, not a default) while this table has to stay importable by
 * `scripts/check-gates.mjs`, which verifies every entry against the files on
 * disk.
 *
 * Paths are relative to the repository root, because that is the directory
 * Stryker is invoked from and therefore the directory it copies into its
 * sandbox. See `stryker.config.mjs` for why that matters.
 */

/** Settings every target shares. */
export const SHARED = {
  testRunner: "vitest",
  // Attribute each mutant to the tests that execute it, so a verdict costs the
  // tests that cover the line rather than the suite.
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  timeoutMS: 30_000,
  timeoutFactor: 2,
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  // A mutant that runs at import time (a changed constant, a tweaked default)
  // executes before any test, so no test can be blamed for it. Running those is
  // the expensive, ambiguous half of the tool; they are reported as ignored with
  // that reason rather than counted as detected.
  ignoreStatic: true,
  // Directories that hold build output, not source: copying them into the
  // sandbox costs seconds per target and cannot change a verdict.
  ignorePatterns: ["**/dist", "**/coverage", "**/.turbo"],
  plugins: ["@stryker-mutator/vitest-runner"],
};

/**
 * One entry per package that ships a mutation gate.
 *
 * `mutate` is the list of files whose changes the suite must notice;
 * `testConfig` is the narrow vitest configuration that judges them. The two are
 * kept honest against each other by `check-gates`: a mutated file with no suite
 * behind it, or a suite that no mutated file needs, fails the gate.
 */
export const TARGETS = {
  node: {
    // These files decide what gets deleted, whether a backup can be
    // restored, which key material survives at all, which key a blob was sealed
    // with, whether a compliance window passed, whether evidence is tamper-evident
    // and when a maintenance window runs. These are the answers a green suite is
    // most expensive to be wrong about.
    mutate: [
      "node/src/maintenance/impl/MaintenanceWindowScheduler.ts",
      "node/src/backup/impl/RetentionPolicyEvaluator.ts",
      // The manager that decides whether a backup exists at all, and the chain that
      // decides whether the audit trail proves itself. Both replaced a simulator this
      // iteration; the mutants are the reason the replacements are believed.
      "node/src/backup/impl/BackupManager.ts",
      // The record that makes a snapshot outlive its process, and the bucket that can
      // hold one across processes. Both decide whether a backup exists tomorrow; the
      // mutants are what keeps that from being a claim about a class name.
      "node/src/backup/impl/inventory.ts",
      "node/src/backup/impl/FileSystemStorageBackend.ts",
      "node/src/audit/impl/auditChain.ts",
      // The anchor: the one file that decides whether a deleted prefix is a finding or
      // a pruned trail. Its mutants are why "the head is anchored" is a measurement.
      "node/src/audit/impl/auditAnchor.ts",
      "node/src/backup/impl/backupChain.ts",
      "node/src/maintenance/impl/cron.ts",
      "node/src/security/impl/KeyRotationManager.ts",
      "node/src/audit/impl/FileAuditStore.ts",
      "node/src/audit/impl/DurableFileSystem.ts",
      "node/src/security/impl/RotationAuditor.ts",
      "node/src/security/impl/AuditLogManager.ts",
      "node/src/security/impl/KeyManager.ts",
      "node/src/security/impl/EnvelopeEncryptionProvider.ts",
      "node/src/security/impl/AES256GCMEncryptionProvider.ts",
    ],
    testConfig: "node/vitest.mutation.config.ts",
    concurrency: 4,
    thresholds: { high: 92, low: 88, break: 86 },
  },
  cluster: {
    // The only component whose failure mode is silent corruption of the log, and
    // the one place a "green" suite can be green for the wrong reason — plus the
    // four assemblers, which decide which member leaves, which batch runs and
    // which partition is emitted. A mutant there is not a wrong number on a
    // graph: it is a group that loses quorum or a partition that only exists on
    // one side.
    mutate: [
      "cluster/src/consensus/storage/SqliteStorage.ts",
      "cluster/src/assemblers/membership/quorum.ts",
      "cluster/src/assemblers/scaling/ClusterScalingExecutor.ts",
      "cluster/src/assemblers/rollout/ClusterRolloutPlanner.ts",
      "cluster/src/assemblers/chaos/RaftFaultTranslator.ts",
    ],
    testConfig: "cluster/vitest.mutation.config.ts",
    // Raised with the assemblers rather than lowered around them. Every file in
    // this target measured above 94 % on its last run — `SqliteStorage.ts` 94.26 %,
    // `ClusterRolloutPlanner.ts` 94.03 %, the other three at 100 % — so 86 is the
    // floor those numbers support, and it is the floor the assemblers were held to
    // when they lived in the operations target. Merging them into a target that
    // broke at 70 would have been a quiet 16-point relaxation of their gate.
    concurrency: 4,
    thresholds: { high: 92, low: 88, break: 86 },
  },
  federation: {
    // The transport is where a refusal and a failure look alike from the outside,
    // and the confirmation frame is the only thing that can tell them apart.
    mutate: [
      "federation/src/transport/TcpSecureTransport.ts",
      "federation/src/replication/cdcAck.ts",
    ],
    testConfig: "federation/vitest.mutation.config.ts",
    concurrency: 2,
    thresholds: { high: 85, low: 75, break: 70 },
  },
};

/** The Stryker configuration for one target. */
export function configFor(target) {
  const entry = TARGETS[target];
  if (!entry) {
    throw new Error(
      `Unknown mutation target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}.`,
    );
  }
  return {
    ...SHARED,
    vitest: { configFile: entry.testConfig, related: true },
    mutate: entry.mutate,
    concurrency: entry.concurrency,
    thresholds: entry.thresholds,
    jsonReporter: { fileName: `reports/mutation/${target}.json` },
  };
}
