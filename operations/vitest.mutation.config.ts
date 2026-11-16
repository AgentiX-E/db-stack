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
      'packages/maintenance/src/__tests__/*.test.ts',
      'packages/backup/src/__tests__/RetentionPolicyEvaluator.test.ts',
      'packages/backup/src/__tests__/AC57-retention-floors.test.ts',
      'packages/backup/src/__tests__/AC59-retention-chains.test.ts',
      'packages/backup/src/__tests__/InMemoryBackup.test.ts',
      'packages/backup/src/__tests__/AC62-backup-store-surface.test.ts',
      'packages/backup/src/__tests__/AC65-retention-order-independence.test.ts',
      'packages/security/src/__tests__/i28-key-rotation.test.ts',
      'packages/security/src/__tests__/i28-rotation-failure-modes.test.ts',
      'packages/security/src/__tests__/InMemoryImpls.test.ts',
      'packages/audit/src/__tests__/FileAuditStore.test.ts',
      'packages/audit/src/__tests__/FileAuditStore.chaos.test.ts',
      'packages/audit/src/__tests__/FileAuditStore.degradation.test.ts',
      'packages/audit/src/__tests__/AC67-audit-facts-not-pages.test.ts',
      'packages/security/src/__tests__/AC66-rotation-policy-contract.test.ts',
      'packages/security/src/__tests__/AC68-retention-keeps-evidence.test.ts',
      'packages/security/src/__tests__/AC69-rotation-audit-report-honesty.test.ts',
      'packages/security/src/__tests__/AC70-audit-boundaries.test.ts',
      'packages/security/src/__tests__/i29-audit-logging.test.ts',
      'packages/security/src/__tests__/i29-audit-logging-edges.test.ts',
      'packages/security/src/__tests__/AuditLogManagerMutationKillers.test.ts',
    ],
    exclude: [],
    pool: 'forks',
    poolOptions: { forks: {} },
    fileParallelism: true,
    maxConcurrency: 4,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
