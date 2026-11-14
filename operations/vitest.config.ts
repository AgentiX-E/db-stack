import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;
const pkg = (name: string) => path.resolve(root, 'packages', name, 'src', 'index.ts');

const PACKAGES = [
  'audit',
  'auth',
  'autoscaler',
  'autotuner',
  'backup',
  'chaosengine',
  'circuitbreaker',
  'configwatcher',
  'core',
  'federation',
  'health',
  'logger',
  'maintenance',
  'memoryguard',
  'metrics',
  'monitor',
  'observability',
  'otel',
  'rollingupgrade',
  'security',
  'slacollector',
];

const aliases: Record<string, string> = {};
for (const name of PACKAGES) {
  aliases[`@agentix-e/db-operations-${name}`] = pkg(name);
}
aliases['@agentix-e/db-operations'] = path.resolve(root, 'src/index.ts');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Node 24 + tinypool fork mode leaks heap across files; a single thread
    // keeps memory flat for the 21-package suite.
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        maxThreads: 1,
        minThreads: 1,
      },
    },
    maxConcurrency: 1,
    hookTimeout: 30_000,
    testTimeout: 60_000,
    retry: 0,
    isolate: true,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.spec.ts',
        'packages/*/src/**/__tests__/**',
        'packages/*/src/**/*.d.ts',
        // Barrel / declaration-only modules.
        'packages/*/src/index.ts',
        'packages/*/src/interfaces/**',
        'packages/*/src/types.ts',
        'packages/*/src/**/types.ts',
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
  resolve: { alias: aliases },
});
