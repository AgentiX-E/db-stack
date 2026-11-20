import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;

export default defineConfig({
  // Pinned to this file's directory: `include` and `setupFiles` resolve against
  // `root`, which otherwise defaults to the working directory. The mutation gate
  // runs from the repository root inside a sandboxed copy of it, and a suite that
  // only collects files when started from its own directory cannot be mutated.
  root,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    silent: true, // suppress console noise from Raft pino logs in fork workers
    include: ['src/**/*.test.ts'],
    // Soak (multi-hour stability) and micro-benchmark suites are not part of
    // the pull-request gate: they exist to catch slow leaks and to produce
    // performance numbers. They run from `test:soak` / `bench` in a dedicated
    // scheduled workflow, on a runner that can afford the wall-clock time.
    exclude: ['src/__tests__/longrun/**', 'src/__tests__/performance/**'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Thread pool, not forks: vitest 3.x fork workers tear down a shared
    // `/tmp/<run>/ssr` module cache when one worker exits, which surfaced as
    // spurious ENOENT failures in unrelated files. Threads keep the cache
    // single-owner. The multi-process Raft suites still spawn real child
    // processes — that isolation comes from `child_process`, not the pool.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: Number(process.env.VITEST_MAX_THREADS ?? 4),
        minThreads: 1,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Test code itself never counts towards product coverage.
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        // Barrel files: pure re-export plumbing, no behaviour of its own.
        'src/index.ts',
        'src/**/index.ts',
        // Type-only modules: erased by the compiler, zero runtime statements.
        'src/interfaces/**',
        'src/consensus/interfaces/**',
        'src/types/**',
        'src/consensus/joint-consensus/IClusterMembershipTransition.ts',
        'src/observability/interfaces.ts',
        'src/snapshot/ISnapshotManager.ts',
        'src/stream/IWalStreamer.ts',
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      // Every dimension must independently clear 95%.
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
  resolve: {
    alias: {
      '@agentix-e/db-cluster/testing': path.resolve(root, 'src/testing/index.ts'),
      '@agentix-e/db-cluster': path.resolve(root, 'src/index.ts'),
      '@agentix-e/db-operations-node/chaosengine': path.resolve(
        root,
        '../operations/packages/node/src/chaosengine/index.ts',
      ),
      '@agentix-e/db-operations-node/core': path.resolve(root, '../operations/packages/node/src/core/index.ts'),
    },
  },
});
