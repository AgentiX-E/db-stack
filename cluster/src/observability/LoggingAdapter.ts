/**
 * LoggingAdapter — Unified structured logger for db-cluster.
 *
 * Wraps pino with ILogger-compatible interface from db-operations.
 * Provides:
 *   - Structured logging (pino backend)
 *   - Trace context propagation (traceId in every log entry)
 *   - Component-scoped child loggers
 *   - Log level control (LOG_LEVEL env)
 *
 * Replaces ad-hoc `pino({...})` scattered across 16 files with a
 * single factory that ensures consistent log format, trace correlation,
 * and output destination.
 *
 * @module db-cluster/observability
 */

import pino, { type Logger as PinoLogger } from 'pino';
import type { ILogger, LogEntry, LogLevel } from './interfaces';
import { resolveLogLevel } from './logLevel';

// ── Global logger instance (lazy) ───────────────────────────

let _rootLogger: PinoLogger | null = null;

function rootLogger(): PinoLogger {
  if (!_rootLogger) {
    _rootLogger = pino({
      level: resolveLogLevel(),
      // Structured JSON in all environments. A previous development-only
      // `pino-pretty` transport was removed because `pino-pretty` is not a
      // declared dependency — any NODE_ENV=development startup crashed with
      // "unable to determine transport target".
      serializers: pino.stdSerializers,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return _rootLogger;
}

// ── Trace context (AsyncLocalStorage) ───────────────────────

// Lightweight trace context using Node.js AsyncLocalStorage.
// No external deps — works with @maboke123/raft-core.

// Build the trace-context adapter. The `node:async_hooks` module exists in
// every supported Node runtime (>= 12); the catch branch only guards a
// pre-12 environment that the test suite cannot exercise.
function createTraceContext() {
  try {
    const { AsyncLocalStorage } = require('node:async_hooks');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage: any = new (AsyncLocalStorage as any)();

    return {
      getTraceId(): string | undefined {
        return storage.getStore();
      },
      runWith<T>(traceId: string, fn: () => T): T {
        return storage.run(traceId, fn);
      },
      runWithAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
        return storage.run(traceId, fn);
      },
    };
    /* c8 ignore start — `node:async_hooks` exists in every supported Node
       runtime (>= 12); this catch guards a pre-12 environment that the test
       suite cannot exercise. */
  } catch {
    // Fallback: no trace correlation (Node < 12)
    return {
      getTraceId: () => undefined,
      runWith: <T>(_id: string, fn: () => T) => fn(),
      runWithAsync: <T>(_id: string, fn: () => Promise<T>) => fn(),
    };
  }
  /* c8 ignore stop */
}

const traceContext = createTraceContext();

// ── LoggingAdapter (ILogger-compatible) ─────────────────────

export class LoggingAdapter implements ILogger {
  private readonly _pino: PinoLogger;
  private readonly _component: string;
  private readonly _bindings: Record<string, unknown>;

  /**
   * Create a new LoggingAdapter.
   *
   * @param component - Component name (e.g., 'RaftGroup', 'ConnectionPool')
   * @param bindings  - Pre-bound context for all log messages
   * @param base      - Parent pino instance (defaults to root)
   */
  constructor(
    component: string,
    bindings?: Record<string, unknown>,
    base?: PinoLogger,
  ) {
    this._pino = (base || rootLogger()).child({ component, ...bindings });
    this._component = component;
    this._bindings = bindings || {};
  }

  /** Create a child logger with additional bindings. */
  child(bindings: Record<string, unknown>): ILogger {
    return new LoggingAdapter(this._component, { ...this._bindings, ...bindings }, this._pino);
  }

  // ── Log methods ─────────────────────────────────────

  trace(msg: string): void;
  trace(context: Record<string, unknown>, msg: string): void;
  trace(contextOrMsg: unknown, msg?: string): void {
    this._log('trace', contextOrMsg, msg);
  }

  debug(msg: string): void;
  debug(context: Record<string, unknown>, msg: string): void;
  debug(contextOrMsg: unknown, msg?: string): void {
    this._log('debug', contextOrMsg, msg);
  }

  info(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;
  info(contextOrMsg: unknown, msg?: string): void {
    this._log('info', contextOrMsg, msg);
  }

  warn(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;
  warn(contextOrMsg: unknown, msg?: string): void {
    this._log('warn', contextOrMsg, msg);
  }

  error(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(err: Error, msg?: string): void;
  error(context: Record<string, unknown>, err: Error, msg?: string): void;
  error(arg1: unknown, arg2?: unknown, arg3?: unknown): void {
    if (arg1 instanceof Error) {
      const err = arg1;
      this._pino.error({ err, traceId: traceContext.getTraceId() }, arg2 as string || '');
    } else if (arg2 instanceof Error) {
      const ctx = arg1 as Record<string, unknown>;
      const err = arg2;
      this._pino.error({ ...ctx, err, traceId: traceContext.getTraceId() }, arg3 as string || '');
    } else {
      this._log('error', arg1, arg2 as string | undefined);
    }
  }

  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
  fatal(arg1: unknown, arg2?: unknown, arg3?: unknown): void {
    if (arg1 instanceof Error) {
      const err = arg1;
      this._pino.fatal({ err, traceId: traceContext.getTraceId() }, arg2 as string || '');
    } else if (arg2 instanceof Error) {
      const ctx = arg1 as Record<string, unknown>;
      const err = arg2;
      this._pino.fatal({ ...ctx, err, traceId: traceContext.getTraceId() }, arg3 as string || '');
    } else {
      this._pino.fatal({ context: arg1, traceId: traceContext.getTraceId() }, arg2 as string || '');
    }
  }

  // ── Backdoor: get underlying pino instance (for advanced use) ─

  raw(): PinoLogger {
    return this._pino;
  }

  // ── Private helpers ─────────────────────────────────────

  private _log(level: LogLevel, contextOrMsg: unknown, msg?: string): void {
    const traceId = traceContext.getTraceId();
    if (msg === undefined) {
      this._pino[level]({ traceId }, contextOrMsg as string);
    } else {
      this._pino[level]({ ...(contextOrMsg as object), traceId }, msg);
    }
  }
}

// ── Factory function (drop-in replacement for pino()) ──────

/**
 * Create a component-scoped logger.
 *
 * @example
 * ```ts
 * const logger = createLogger('RaftGroup', { nodeId: '3' });
 * logger.info('Group started');
 * logger.error(new Error('fail'), 'Proposal rejected');
 * ```
 */
export function createLogger(
  component: string,
  bindings?: Record<string, unknown>,
): LoggingAdapter {
  return new LoggingAdapter(component, bindings);
}

// ── Re-exports ─────────────────────────────────────────────

export { traceContext };
export type { LogEntry, LogLevel, ILogger };
