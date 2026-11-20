import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the mutation suite.
 *
 * Stryker judges one mutant at a time, so the test set behind it has to be
 * narrow enough that a verdict costs seconds rather than minutes: the whole
 * operations suite is over 2 700 cases across 21 packages, and a dry run of that
 * would spend minutes before the first mutant was generated. This config names
 * exactly the suites that exercise the files in `stryker.config.json`'s
 * `mutate` list. A suite listed here that does not import a mutated file is not
 * free: `perTest` has to run it in the dry run and attribute nothing to it. When one grows, the other grows with it — `check:gates`
 * compares the two and fails if a mutated file has no suite behind it.
 *
 * The base config pins a single thread to keep heap flat across 21 packages;
 * mutation runs want the opposite, because a mutant that hangs must not stall
 * the other three workers. `pool: 'forks'` also gives each worker a clean
 * module registry, which matters when a mutant changes a module-level constant.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    include: [
      'packages/node/src/maintenance/__tests__/*.test.ts',
      'packages/node/src/backup/__tests__/RetentionPolicyEvaluator.test.ts',
      'packages/node/src/backup/__tests__/AC57-retention-floors.test.ts',
      'packages/node/src/backup/__tests__/AC59-retention-chains.test.ts',
      'packages/node/src/backup/__tests__/InMemoryBackup.test.ts',
      'packages/node/src/backup/__tests__/AC62-backup-store-surface.test.ts',
      'packages/node/src/backup/__tests__/AC65-retention-order-independence.test.ts',
      'packages/node/src/security/__tests__/i28-key-rotation.test.ts',
      'packages/node/src/security/__tests__/i28-rotation-failure-modes.test.ts',
      'packages/node/src/security/__tests__/InMemoryImpls.test.ts',
      'packages/node/src/audit/__tests__/FileAuditStore.test.ts',
      'packages/node/src/audit/__tests__/FileAuditStore.chaos.test.ts',
      'packages/node/src/audit/__tests__/FileAuditStore.degradation.test.ts',
      'packages/node/src/audit/__tests__/AC67-audit-facts-not-pages.test.ts',
      'packages/node/src/security/__tests__/AC66-rotation-policy-contract.test.ts',
      'packages/node/src/security/__tests__/AC68-retention-keeps-evidence.test.ts',
      'packages/node/src/security/__tests__/AC69-rotation-audit-report-honesty.test.ts',
      'packages/node/src/security/__tests__/AC70-audit-boundaries.test.ts',
      'packages/node/src/security/__tests__/AC71-key-material-survives.test.ts',
      'packages/node/src/security/__tests__/AC72-envelope-key-ownership.test.ts',
      'packages/node/src/security/__tests__/AC73-replayed-survivors.test.ts',
      'packages/node/src/security/__tests__/i27-encryption-at-rest.test.ts',
      'packages/node/src/security/__tests__/i27-encryption-edge-cases.test.ts',
      'packages/node/src/security/__tests__/EnvelopeEncryptionMutationKillers.test.ts',
      'packages/node/src/security/__tests__/AC74-one-name-one-key.test.ts',
      'packages/node/src/security/__tests__/AC75-work-factor.test.ts',
      'packages/node/src/security/__tests__/AC77-initialise-is-not-a-reset.test.ts',
      'packages/node/src/security/__tests__/AC78-header-is-an-input.test.ts',
      'packages/node/src/security/__tests__/SecurityMutationKillers.test.ts',
      'packages/node/src/audit/__tests__/AC76-audit-reads-through-a-port.test.ts',
      'packages/node/src/audit/__tests__/AC80-durable-write.test.ts',
      'packages/node/src/audit/__tests__/AC81-out-of-process-writes.test.ts',
      'packages/node/src/audit/__tests__/AC82-group-commit.test.ts',
      'packages/node/src/audit/__tests__/AC83-archive-publish.test.ts',
      'packages/node/src/audit/__tests__/AC84-failure-arms.test.ts',
      'packages/node/src/audit/__tests__/AC85-segment-claim.test.ts',
      'packages/node/src/audit/__tests__/AC86-two-writers.test.ts',
      'packages/node/src/audit/__tests__/AC87-retention-decision.test.ts',
      'packages/node/src/audit/__tests__/AC88-archive-whole-segment.test.ts',
      'packages/node/src/audit/__tests__/AC89-what-the-suite-could-not-see.test.ts',
      'packages/node/src/audit/__tests__/AC90-shadowed-segment.test.ts',
      'packages/node/src/audit/__tests__/DurableFileSystem.test.ts',
      'packages/node/src/security/__tests__/i29-audit-logging.test.ts',
      'packages/node/src/security/__tests__/i29-audit-logging-edges.test.ts',
      'packages/node/src/security/__tests__/AuditLogManagerMutationKillers.test.ts',
      // The cluster assemblers: which member leaves, which batch runs, which
      // transport is told to drop traffic.
      'packages/cluster/src/membership/__tests__/quorum.test.ts',
      'packages/cluster/src/scaling/__tests__/ClusterScalingExecutor.test.ts',
      'packages/cluster/src/rollout/__tests__/ClusterRolloutPlanner.test.ts',
      'packages/cluster/src/chaos/__tests__/RaftFaultTranslator.test.ts',
    ],
    exclude: [],
    pool: 'forks',
    poolOptions: { forks: {} },
    fileParallelism: true,
    maxConcurrency: 4,
    // Derived, not inherited. `base.test` carries `testTimeout: 60_000`, which was
    // chosen for the unit suite — where a case is allowed to build an encryption
    // key — and Stryker abandons a mutant after `timeoutFactor × netTime + 30 s`,
    // so a timeout inherited from there is always above the runner's own cap and
    // can never be the thing that reports a hang. That is why the operations target
    // used to report 60 `Timeout` verdicts: nothing in the suite could expire
    // before the runner gave up.
    //
    // The number comes from the suite's own measurement (2026-11-18): 1 149 cases
    // across 59 files, the slowest a single 3 665 ms — `AC75-work-factor`, which
    // runs scrypt at four work factors on purpose — and the next two 3 311 ms and
    // 3 005 ms, both of which spawn processes. Four times the worst case is
    // 14 660 ms, floored at 15 s and kept below the 30 s cap so that the budget,
    // and not the runner, is what reports a hang. A per-file table would only
    // change how long a hang takes to be reported; it would also put twenty
    // numbers in the repository that nobody re-measures.
    testTimeout: 15_000,
    // The same budget for the teardown, and for a second reason: a mutant that
    // wedges a `setImmediate` leaves the store's flush pending, so `close()` in an
    // `afterEach` waits for a promise that will never settle. With the base config's
    // 30 s hook budget that wait outlasts Stryker's own cap, and the mutant is
    // recorded as an abandoned run instead of a failing test — measured on
    // 2026-11-18, mutants 419 and 420 of `FileAuditStore` did exactly that.
    hookTimeout: 15_000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
