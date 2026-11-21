/**
 * NoopLogger — ILogger implementation that discards all output.
 *
 * Useful as a default/fallback logger when none is configured,
 * avoiding null checks everywhere. Also useful in tests.
 *
 * @module @agentix-e/db-node/logger/impl
 */

import type { ILogger } from '../interfaces/ILogger.js';

const NOOP = (): void => {};

/**
 * NoopLogger — silently discards all log messages.
 */
export class NoopLogger implements ILogger {
  static readonly INSTANCE = new NoopLogger();

  child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  trace: ILogger['trace'] = NOOP;
  debug: ILogger['debug'] = NOOP;
  info: ILogger['info'] = NOOP;
  warn: ILogger['warn'] = NOOP;
  error: ILogger['error'] = NOOP;
  fatal: ILogger['fatal'] = NOOP;
}
