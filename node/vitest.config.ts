import { defineConfig } from 'vitest/config';
import path from 'path';

const root = __dirname;
const moduleOf = (name: string) => path.resolve(root, 'src', name, 'index.ts');

/** The twenty modules this package publishes as subpaths. */
const MODULES = [
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

// Ordered: vite matches aliases by prefix, not by equality, so the bare package
// name has to come *after* every subpath of it — `@agentix-e/db-node` is a prefix
// of `@agentix-e/db-node/core`, and the other order rewrites the subpath to
// `…/src/index.ts/core`. The two exact subpaths come first of all, because
// `…/core/types` is not a directory.
const aliases = [
  {
    find: '@agentix-e/db-node/core/types',
    replacement: path.resolve(root, 'src/core/types.ts'),
  },
  ...MODULES.map((name) => ({
    find: `@agentix-e/db-node/${name}`,
    replacement: moduleOf(name),
  })),
  {
    find: '@agentix-e/db-node',
    replacement: path.resolve(root, 'src/index.ts'),
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
    // keeps memory flat.
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
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        // Barrels and declaration-only modules. Each of these is a re-export or a
        // type file: no line in one can be executed, and counting them as
        // uncovered lines made the per-file gate measure how many modules a
        // package has.
        'src/index.ts',
        'src/**/index.ts',
        'src/**/interfaces/**',
        'src/types.ts',
        'src/**/types.ts',
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
