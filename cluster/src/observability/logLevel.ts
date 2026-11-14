/**
 * Log-level resolution — a pure, testable helper that centralizes the
 * resolution of the process-wide log level.
 *
 * Prior to this helper, every module repeated the module-level expression
 * `resolveLogLevel()` inline inside its `pino(...)` call. That
 * pattern is a *module-level side effect*: it runs once at import time and
 * cannot be exercised through the two runtime branches (explicit LOG_LEVEL vs.
 * the `'info'` fallback) without `vi.resetModules()`, which is mutually
 * exclusive with v8 coverage instrumentation. Centralizing the branch into a
 * single exported function makes both branches unit-testable and removes the
 * per-module side effect.
 */

/** Default log level used when `LOG_LEVEL` is unset or empty. */
export const DEFAULT_LOG_LEVEL = 'info';

/**
 * Resolve the effective log level from the environment.
 *
 * @returns the non-empty `LOG_LEVEL` value, or `'info'` when it is unset/empty.
 */
export function resolveLogLevel(): string {
  return process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL;
}
