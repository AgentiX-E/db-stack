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
  cluster: {
    // The only component whose failure mode is silent corruption of the log, and
    // the one place a "green" suite can be green for the wrong reason.
    mutate: ["cluster/src/consensus/storage/SqliteStorage.ts"],
    testConfig: "cluster/vitest.mutation.config.ts",
    concurrency: 4,
    thresholds: { high: 85, low: 75, break: 70 },
  },
  federation: {
    // The transport is where a refusal and a failure look alike from the outside.
    mutate: ["federation/src/transport/TcpSecureTransport.ts"],
    testConfig: "federation/vitest.mutation.config.ts",
    concurrency: 2,
    thresholds: { high: 85, low: 75, break: 70 },
  },
  operations: {
    mutate: [
      "operations/packages/node/src/maintenance/impl/MaintenanceWindowScheduler.ts",
      "operations/packages/node/src/backup/impl/RetentionPolicyEvaluator.ts",
      "operations/packages/node/src/backup/impl/InMemoryBackupManager.ts",
      "operations/packages/node/src/backup/impl/backupChain.ts",
      "operations/packages/node/src/maintenance/impl/cron.ts",
      "operations/packages/node/src/security/impl/KeyRotationManager.ts",
      "operations/packages/node/src/audit/impl/FileAuditStore.ts",
      "operations/packages/node/src/audit/impl/DurableFileSystem.ts",
      "operations/packages/node/src/security/impl/RotationAuditor.ts",
      "operations/packages/node/src/security/impl/AuditLogManager.ts",
      "operations/packages/node/src/security/impl/KeyManager.ts",
      "operations/packages/node/src/security/impl/EnvelopeEncryptionProvider.ts",
      "operations/packages/node/src/security/impl/AES256GCMEncryptionProvider.ts",
      // The cluster assemblers decide which member is removed, which batch runs,
      // and which transport is told to drop traffic. A mutant there is not a wrong
      // number on a graph — it is a group that loses quorum or a partition that
      // only exists on one side.
      "operations/packages/cluster/src/membership/quorum.ts",
      "operations/packages/cluster/src/scaling/ClusterScalingExecutor.ts",
      "operations/packages/cluster/src/rollout/ClusterRolloutPlanner.ts",
      "operations/packages/cluster/src/chaos/RaftFaultTranslator.ts",
    ],
    testConfig: "operations/vitest.mutation.config.ts",
    concurrency: 4,
    thresholds: { high: 92, low: 88, break: 86 },
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
