import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Configuration for the mutation suite.
 *
 * The transport's tests are the ones that can judge a mutant in it: the unit
 * file, the lifecycle file and the TLS fault-injection suite, which is what
 * catches a change that breaks the refusal path rather than the happy path.
 * The delivery file is the fourth: it asserts the wire frame field by field and
 * drives the configuration refusals, which is where the transport's decisions
 * are made rather than reported.
 */
const base = baseConfig as unknown as {
  test: Record<string, unknown> & { coverage?: Record<string, unknown> };
};

export default defineConfig({
  ...(baseConfig as Record<string, unknown>),
  test: {
    ...base.test,
    include: [
      'src/transport/TcpSecureTransport.test.ts',
      'src/transport/TcpSecureTransport.lifecycle.test.ts',
      'src/transport/TcpSecureTransport.delivery.test.ts',
      'src/__tests__/chaos/tls-fault-injection.test.ts',
    ],
    exclude: [],
    // Derived from this suite's own measurement (2026-11-18): 90 cases in four
    // files, the slowest a single 2 479 ms (`chaos/tls-fault-injection`, which
    // injects a delay on purpose), the next 5 ms. Four times the worst case is
    // 9 916 ms, rounded up to 10 s and kept below the 30 s runner cap. The base
    // config's 180 s never applied here: Stryker abandons a mutant long before a
    // test timeout that large can fire, so the timeout column would report the
    // runner giving up rather than a test objecting.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: { ...base.test.coverage, enabled: false },
  },
});
