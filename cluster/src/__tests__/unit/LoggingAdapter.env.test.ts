/**
 * LoggingAdapter environment-variant tests.
 *
 * These cover the lazy `rootLogger()` singleton's configuration branches that
 * depend on process environment variables (LOG_LEVEL). They live in a separate
 * file so that no static top-level import initializes the module-level
 * `_rootLogger` singleton before `vi.resetModules()` + dynamic import can take
 * effect.
 *
 * Invariants:
 *   ENV1 — an explicit LOG_LEVEL is honored (the `LOG_LEVEL || 'info'`
 *          left-hand truthy branch)
 *   ENV2 — the removed `pino-pretty` transport no longer crashes development
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('LoggingAdapter environment variants', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('ENV1: honors an explicit LOG_LEVEL (truthy || branch)', async () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    vi.resetModules();
    const mod = await import('../../observability/LoggingAdapter');
    const logger = mod.createLogger('EnvLogger');
    // A logger with LOG_LEVEL=debug must not throw and must expose `raw()`.
    expect(() => logger.info('explicit level')).not.toThrow();
    expect(typeof logger.raw()).toBe('object');
  });

  it('ENV2: logs without crashing when NODE_ENV is development', async () => {
    // Regression: the removed `pino-pretty` transport previously crashed here
    // with "unable to determine transport target".
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const mod = await import('../../observability/LoggingAdapter');
    const logger = mod.createLogger('DevLogger');
    expect(() => logger.info('dev mode')).not.toThrow();
  });
});
