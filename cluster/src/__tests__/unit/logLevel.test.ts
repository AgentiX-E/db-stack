/**
 * resolveLogLevel unit tests.
 *
 * This helper centralizes the `LOG_LEVEL || 'info'` branch that was previously
 * repeated as a module-level side effect in 14 modules. Because it is now a
 * pure exported function, both branches are unit-testable without
 * `vi.resetModules()`, which is mutually exclusive with v8 coverage.
 *
 * AC — resolveLogLevel honors an explicit LOG_LEVEL and falls back to 'info'.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLogLevel, DEFAULT_LOG_LEVEL } from '../../observability/logLevel';

describe('resolveLogLevel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the default level when LOG_LEVEL is unset', () => {
    vi.stubEnv('LOG_LEVEL', '');
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL);
    expect(DEFAULT_LOG_LEVEL).toBe('info');
  });

  it('falls back to the default level when LOG_LEVEL is undefined', () => {
    delete process.env.LOG_LEVEL;
    expect(resolveLogLevel()).toBe('info');
  });

  it('honors an explicit LOG_LEVEL value', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    expect(resolveLogLevel()).toBe('debug');
  });

  it('honors a custom LOG_LEVEL value', () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    expect(resolveLogLevel()).toBe('warn');
  });
});
