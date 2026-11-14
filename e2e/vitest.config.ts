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
    poolOptions: { threads: { singleThread: true, maxThreads: 1, minThreads: 1 } },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['harness/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
