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
 *
 * `fileParallelism: false`, and that is a measurement rather than a preference.
 * With it on, three clean runs of this config produced failures in two of them —
 * `SqliteError: disk I/O error` from `pragma journal_mode = WAL`, and a different
 * test each time — with **no mutant applied at all**. The suites are individually
 * isolated (`mkdtemp` per file), so what they share is the box: SQLite WAL
 * bookkeeping, and a runner on which Stryker already runs four workers, each with
 * its own sandbox copy of the repository. Four files in parallel inside each of
 * those multiplies processes to sixteen for a suite that takes five seconds.
 *
 * A flaky test is worse than a slow one here for a specific reason: it fails
 * *because of the mutant* in the runner's accounting. Replaying the 133 reported
 * survivors made that concrete — 68 of them "failed" while the same suite passes
 * them one at a time — so the score was being moved by noise in both directions.
 * With parallelism off, four of four runs pass, and the number means what it says.
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
      'src/__tests__/unit/SqliteStorage.durability.test.ts',
      'src/__tests__/unit/SqliteNodeStorage.test.ts',
    ],
    exclude: [],
    pool: 'forks',
    fileParallelism: false,
    // A mutant that makes the storage wait forever must be *reported*, and the
    // only party that can report it is the test that is waiting. Without this
    // the runner's own 30 s cap is what fires, and it records the verdict as
    // "timeout" — a status the score does not count, so a mutant that deadlocks
    // the log was scored as if no test had noticed. The whole file runs in
    // ~5 s and its slowest case is under 100 ms, so 8 s is not a margin any
    // correct behaviour can consume; it is the boundary between "slow" and
    // "stuck", and a stuck storage is a defect, not an unjudged mutant.
    testTimeout: 8000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
