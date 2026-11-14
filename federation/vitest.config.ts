import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;

export default defineConfig({
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
        'src/routing/index.ts',
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
      '@agentix-e/db-operations-core': path.resolve(root, '../operations/packages/core/src/index.ts'),
      '@agentix-e/db-operations-audit': path.resolve(root, '../operations/packages/audit/src/index.ts'),
      '@agentix-e/db-operations-backup': path.resolve(root, '../operations/packages/backup/src/index.ts'),
      '@agentix-e/db-operations-observability': path.resolve(
        root,
        '../operations/packages/observability/src/index.ts',
      ),
      '@agentix-e/db-operations-chaosengine': path.resolve(
        root,
        '../operations/packages/chaosengine/src/index.ts',
      ),
    },
  },
});
