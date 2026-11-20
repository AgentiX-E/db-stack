import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;
const moduleOf = (name: string) => path.resolve(root, 'packages', 'node', 'src', name, 'index.ts');

/** The twenty modules `@agentix-e/db-operations-node` publishes. */
const NODE_MODULES = [
  'audit',
  'auth',
  'autoscaler',
  'autotuner',
  'backup',
  'chaosengine',
  'circuitbreaker',
  'configwatcher',
  'core',
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

// Ordered: vitest takes the first alias whose `find` matches, so the two exact
// subpaths come before the wildcard-shaped ones that would otherwise resolve
// `…/node/core/types` to a directory this package does not have.
// Vite matches aliases by prefix, not by equality, so the bare package name has to
// come *after* every subpath of it: `@agentix-e/db-operations-node` is a prefix of
// `@agentix-e/db-operations-node/core`, and the other order rewrites the subpath to
// `…/node/src/index.ts/core`.
const aliases = [
  {
    find: '@agentix-e/db-operations-node/core/types',
    replacement: path.resolve(root, 'packages/node/src/core/types.ts'),
  },
  ...NODE_MODULES.map((name) => ({
    find: `@agentix-e/db-operations-node/${name}`,
    replacement: moduleOf(name),
  })),
  {
    find: '@agentix-e/db-operations-node',
    replacement: path.resolve(root, 'packages/node/src/index.ts'),
  },
  { find: '@agentix-e/db-operations', replacement: path.resolve(root, 'src/index.ts') },
  {
    find: '@agentix-e/db-operations-cluster',
    replacement: path.resolve(root, 'packages/cluster/src/index.ts'),
  },
  {
    find: '@agentix-e/db-operations-federation',
    replacement: path.resolve(root, 'packages/federation/src/index.ts'),
  },
];

export default defineConfig({
  // Pinned to this file's directory rather than taken from `process.cwd()`.
  // Vitest resolves `include` and `setupFiles` against `root`, so a run started
  // from anywhere else silently collects nothing — and the mutation gate starts
  // its run from the repository root, inside a sandbox that is a copy of the
  // whole repository. A suite that only works from one directory is a suite that
  // cannot be mutated.
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Node 24 + tinypool fork mode leaks heap across files; a single thread
    // keeps memory flat. Three packages now rather than twenty-one, and the same
    // ~3 000 cases.
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
        // Barrels and declaration-only modules. Each of these is a re-export or a
        // type file: no line in one can be executed, and counting them as
        // uncovered lines made the per-file gate measure how many modules a
        // package has.
        'packages/*/src/index.ts',
        'packages/*/src/**/index.ts',
        'packages/*/src/**/interfaces/**',
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
