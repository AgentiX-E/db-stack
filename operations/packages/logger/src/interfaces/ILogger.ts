/**
 * ILogger — Structured logger interface for db-operations.
 *
 * Provides a pino-like API with log levels, structured context,
 * and child logger creation. Compatible with Pino, Winston, or
 * custom loggers.
 *
 * @module @agentix-e/db-operations-logger/interfaces
 */

/** Log severity level. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A structured log entry. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  component: string;
  /** Optional structured context. */
  context?: Record<string, unknown>;
  /** Error stack if applicable. */
  error?: { message: string; stack?: string; name?: string };
  /** Trace ID for distributed tracing correlation. */
  traceId?: string;
}

/**
 * Logger interface.
 *
 * All methods accept a simple message, a (context, message) pair, or a
 * (message, context) pair — the last form keeps the message first while
 * attaching structured context, and is part of the runtime contract every
 * implementation dispatches on.
 * Error-level methods accept an optional Error object.
 *
 * @example
 * ```ts
 * logger.info('Server started');
 * logger.info({ port: 3000, host: '0.0.0.0' }, 'Server started');
 * logger.info('Server started', { port: 3000 });
 * logger.error(err, 'Failed to connect');
 * logger.error({ peerId: 'node-2' }, err, 'Connection failed');
 * ```
 */
export interface ILogger {
  /** Create a child logger with pre-bound context. */
  child(bindings: Record<string, unknown>): ILogger;

  trace(msg: string): void;
  trace(context: Record<string, unknown>, msg: string): void;
  trace(msg: string, context: Record<string, unknown>): void;

  debug(msg: string): void;
  debug(context: Record<string, unknown>, msg: string): void;
  debug(msg: string, context: Record<string, unknown>): void;

  info(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;
  info(msg: string, context: Record<string, unknown>): void;

  warn(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;
  warn(msg: string, context: Record<string, unknown>): void;

  error(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(msg: string, context: Record<string, unknown>): void;
  error(err: Error, msg?: string): void;
  error(context: Record<string, unknown>, err: Error, msg?: string): void;

  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(msg: string, context: Record<string, unknown>): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
}

/** Trace context carrier for async operation correlation. */
export interface ITraceContextProvider {
  /** Get the current trace ID, if any. */
  getTraceId(): string | undefined;

  /** Run a function within a new trace context. */
  withTrace<T>(traceId: string, fn: () => T): T;

  /** Run a function within a new trace context (async version). */
  withTraceAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T>;
}
