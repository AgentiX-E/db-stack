import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the mutation suite.
 *
 * Stryker needs a test set narrow enough that a single mutant can be judged in
 * seconds — the whole suite is 1 976 cases and a dry run of it costs minutes
 * before the first mutant is even generated. This config names the files that
 * exercise the modules in `stryker.config.json`'s `mutate` list. When that list
 * grows, this one grows with it; `check:gates` fails if the two disagree.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    include: [
      'src/__tests__/unit/SqliteStorage.test.ts',
      'src/__tests__/unit/SqliteStorageConcurrency.test.ts',
      'src/__tests__/unit/SqliteStorage.handle-lifecycle.test.ts',
      'src/__tests__/unit/SqliteNodeStorage.test.ts',
    ],
    exclude: [],
    pool: 'forks',
    fileParallelism: true,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
