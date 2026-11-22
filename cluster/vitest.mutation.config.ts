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
      // The transport. Five suites under a mocked pool and one over real mTLS
      // between two real transports — the one that fails on purpose, because the
      // ordering defect it was written for needs a loaded machine to appear
      // otherwise (`RaftTcpTransport.ordering.test.ts`, iteration 70).
      'src/__tests__/unit/RaftTcpTransport.test.ts',
      'src/__tests__/unit/RaftTcpTransport.start.test.ts',
      'src/__tests__/unit/RaftTcpTransport.buffering.test.ts',
      'src/__tests__/unit/RaftTcpTransport.socket.test.ts',
      'src/__tests__/unit/RaftTcpTransport.storm.test.ts',
      'src/__tests__/unit/RaftTcpTransport.ordering.test.ts',
      // The assemblers: which member leaves, which batch runs, which transport is
      // told to drop traffic. A mutant there is not a wrong number on a graph — it
      // is a group that loses quorum or a partition that only exists on one side.
      // They arrived from the operations tree, which is why this file says
      // `src/assemblers` where it used to say `packages/cluster`.
      'src/assemblers/membership/__tests__/quorum.test.ts',
      'src/assemblers/scaling/__tests__/ClusterScalingExecutor.test.ts',
      'src/assemblers/rollout/__tests__/ClusterRolloutPlanner.test.ts',
      'src/assemblers/chaos/__tests__/RaftFaultTranslator.test.ts',
    ],
    exclude: [],
    pool: 'forks',
    fileParallelism: false,
    // A mutant that makes the storage wait forever must be *reported*, and the
    // only party that can report it is the test that is waiting. Without this
    // the runner's own 30 s cap is what fires, and it records the verdict as
    // "timeout" — a status the score does not count, so a mutant that deadlocks
    // the log was scored as if no test had noticed.
    //
    // The number is derived, and the derivation was repeated on 2026-11-18: 150
    // cases in five files, the slowest a single 2 120 ms
    // (`SqliteStorage.handle-lifecycle`), the next 13 ms. Four times the worst case
    // is 8 480 ms, rounded up to 9 s and kept below the 30 s runner cap so that the
    // budget, and not the runner, is what reports a hang. The previous value was
    // 8 s, justified by "its slowest case is under 100 ms" — a measurement that was
    // true when it was taken and had not been for some time.
    testTimeout: 9_000,
    // The same budget for hooks: a `beforeAll` that opens the database pays the
    // same cost as a test that does, and the inherited 60 s can only ever outlast
    // the runner.
    hookTimeout: 9_000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
