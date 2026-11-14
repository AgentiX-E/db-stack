/**
 * ILogger — Structured logger interface (db-operations compatible).
 *
 * Mirrors @agentix-e/db-operations-logger/ILogger to enable
 * library-agnostic logging across all three repos.
 *
 * @module db-cluster/observability/interfaces
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  component: string;
  context?: Record<string, unknown>;
  error?: { message: string; stack?: string; name?: string };
  traceId?: string;
}

export interface ILogger {
  child(bindings: Record<string, unknown>): ILogger;

  trace(msg: string): void;
  trace(context: Record<string, unknown>, msg: string): void;

  debug(msg: string): void;
  debug(context: Record<string, unknown>, msg: string): void;

  info(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;

  warn(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;

  error(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(err: Error, msg?: string): void;
  error(context: Record<string, unknown>, err: Error, msg?: string): void;

  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
}
