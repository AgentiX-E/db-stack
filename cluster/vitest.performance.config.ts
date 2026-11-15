import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the performance suite.
 *
 * Why a second config file exists
 * -------------------------------
 * `vitest.config.ts` excludes `src/__tests__/performance/**` from the pull-request
 * gate, and `test:perf` used to be `vitest run … src/__tests__/performance`. A
 * positional filter does not override `exclude`, so the command printed
 * `No test files found, exiting with code 1` and never ran a single benchmark.
 * Nothing in CI called it, so the script's own failure was invisible.
 *
 * The override is a spread and not `mergeConfig`: merging *concatenates* the
 * arrays, so the base `exclude` survived and the perf directory stayed excluded.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    include: ['src/__tests__/performance/**/*.test.ts'],
    exclude: [],
    // Benchmarks run one file at a time, with no worker pool in between.
    //
    // Two independent reasons, both measured:
    //   1. A latency percentile taken while another benchmark is saturating
    //      cores is not a measurement of the middleware. Running the same
    //      election benchmark beside three others gave a median 100 ms higher
    //      than running it alone.
    //   2. better-sqlite3 is a native addon whose finaliser aborts the process
    //      (`terminate called after throwing an instance of 'Napi::Error'`,
    //      exit 134) when it runs on a worker_threads isolate that is already
    //      tearing down. Each file here starts and stops three clusters, so the
    //      accumulated handles made the suite crash *after* reporting 22/22
    //      passed — no stack, no test name. Forks sidestep the worker isolate;
    //      the handle accounting in `SqliteStorage` is what proves nothing is
    //      leaked in the first place (see AC 42.x).
    pool: 'forks',
    fileParallelism: false,
    // A benchmark measures wall-clock time on a shared runner; the default 180 s
    // is not enough for a cluster that has to be started per trial.
    testTimeout: 600_000,
    hookTimeout: 180_000,
    // Coverage is measured by the gate, not while benchmarking: instrumentation
    // changes the thing being measured.
    coverage: { ...base.test.coverage, enabled: false },
  },
});
