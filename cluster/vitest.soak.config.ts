import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the soak (long-running stability) suite.
 *
 * Same reason as `vitest.performance.config.ts`: the base config excludes
 * `src/__tests__/longrun/**`, and `test:soak` passed that directory as a
 * positional filter, which does not override `exclude` — so the nightly soak job
 * ran `vitest` and got `No test files found, exiting with code 1`. The workflow
 * failed before reaching that step for an unrelated reason, which is why nobody
 * saw it.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    include: ['src/__tests__/longrun/**/*.test.ts'],
    exclude: [],
    // Same isolation as the performance suite: a soak run measures stability
    // over hours, so it must not compete for cores with another file, and the
    // native storage handles it opens must not be finalised on a worker
    // isolate that is already shutting down. See vitest.performance.config.ts.
    pool: 'forks',
    fileParallelism: false,
    // A soak run is measured in hours by design.
    testTimeout: 3_600_000,
    hookTimeout: 180_000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
