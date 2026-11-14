import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // These suites spawn real processes, bind real TCP ports and negotiate
    // real TLS handshakes: give them room, and never run them concurrently
    // with each other (each suite owns a fixed port range).
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true, maxThreads: 1, minThreads: 1 },
    },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Only the harness is instrumented: the acceptance suites are the
      // *consumers* of the harness, so their coverage of it is the number that
      // says whether the harness is exercised for real.
      include: ['harness/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // A threshold of zero is documentation, not a gate. The harness must meet
      // the same bar as every package even though a full run is expensive.
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
