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
    silent: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        // Barrel / interface-only modules.
        'src/index.ts',
        'src/interfaces/**',
        'src/types.ts',
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
      '@agentix-e/db-federation': path.resolve(root, 'src/index.ts'),
      '@agentix-e/db-cluster/testing': path.resolve(root, '../cluster/src/testing/index.ts'),
      '@agentix-e/db-cluster': path.resolve(root, '../cluster/src/index.ts'),
      '@agentix-e/db-operations-node/core': path.resolve(root, '../operations/packages/node/src/core/index.ts'),
      '@agentix-e/db-operations-node/audit': path.resolve(root, '../operations/packages/node/src/audit/index.ts'),
      '@agentix-e/db-operations-node/backup': path.resolve(root, '../operations/packages/node/src/backup/index.ts'),
      '@agentix-e/db-operations-node/observability': path.resolve(
        root,
        '../operations/packages/node/src/observability/index.ts',
      ),
      '@agentix-e/db-operations-node/chaosengine': path.resolve(
        root,
        '../operations/packages/node/src/chaosengine/index.ts',
      ),
    },
  },
});
