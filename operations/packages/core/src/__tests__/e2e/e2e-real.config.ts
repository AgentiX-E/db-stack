/**
 * Shared E2E configuration for real engine integration tests.
 *
 * Controls which real engines are tested and timeout budgets.
 * All timestamps in milliseconds.
 */
export const E2E_CONFIG = {
  engines: {
    sqlvec: { enabled: true, basePort: 10000 },
    graphvec: { enabled: true, basePort: 20000 },
  },
  timeouts: {
    engineStartup: 30_000,
    operation: 5_000,
  },
} as const;

/** Duration (ms) after which a slow engine alert is logged. */
export const SLOW_ENGINE_WARN_MS = 2_000;
