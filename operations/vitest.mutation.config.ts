import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the mutation suite.
 *
 * Stryker judges one mutant at a time, so the test set behind it has to be
 * narrow enough that a verdict costs seconds rather than minutes: the whole
 * operations suite is 2 599 cases across 21 packages, and a dry run of that
 * would spend minutes before the first mutant was generated. This config names
 * exactly the suites that exercise the files in `stryker.config.json`'s
 * `mutate` list. When one grows, the other grows with it — `check:gates`
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
    ],
    exclude: [],
    pool: 'forks',
    poolOptions: { forks: {} },
    fileParallelism: true,
    maxConcurrency: 4,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
