/**
 * InMemoryLogger — ILogger implementation that retains entries in memory.
 *
 * Stores log entries in an array for test assertions.
 * Supports child loggers with inherited bindings and max capacity eviction.
 *
 * @module @agentix-e/db-operations-logger/impl
 */

import type { ILogger, LogEntry, LogLevel } from '../interfaces/ILogger.js';

/**
 * InMemoryLogger — retains log entries for inspection.
 */
export class InMemoryLogger implements ILogger {
  private readonly _entries: LogEntry[] = [];
  private readonly _maxEntries: number;
  private readonly _context: Record<string, unknown>;
  private readonly _component: string;

  constructor(component = 'default', maxEntries = 100) {
    this._component = component;
    this._maxEntries = maxEntries;
    this._context = {};
  }

  // ── ILogger implementation ──

  child(bindings: Record<string, unknown>): ILogger {
    const child = new InMemoryLogger(this._component, this._maxEntries);
    // Copy parent entries to child (child starts fresh but inherits context)
    Object.assign(child._context, this._context, bindings);
    return child;
  }

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
  error(...args: unknown[]): void {
    this._logError('error', ...args);
  }

  fatal(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(err: Error, msg?: string): void;
  fatal(context: Record<string, unknown>, err: Error, msg?: string): void;
  fatal(...args: unknown[]): void {
    this._logError('fatal', ...args);
  }

  // ── Custom methods — not part of ILogger ──

  /**
   * Get all log entries.
   */
  getEntries(): LogEntry[] {
    return [...this._entries];
  }

  /**
   * Get entries filtered by log level.
   */
  getByLevel(level: LogLevel): LogEntry[] {
    return this._entries.filter(e => e.level === level);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this._entries.length = 0;
  }

  // ── Private helpers ──

  private _makeEntry(level: LogLevel, message: string, extraContext?: Record<string, unknown>): LogEntry {
    return {
      level,
      message,
      timestamp: new Date().toISOString(),
      component: this._component,
      context: { ...this._context, ...extraContext },
    };
  }

  private _pushEntry(entry: LogEntry): void {
    if (this._entries.length >= this._maxEntries) {
      this._entries.shift();
    }
    this._entries.push(entry);
  }

  /**
   * Resolve overloaded log arguments.
   *
   * Handles three TypeScript overload patterns correctly:
   *   1. log("message")           → contextOrMsg = "message", msg = undefined
   *   2. log(context, "message")  → contextOrMsg = object, msg = "message"
   *   3. log("message", {extra})  → contextOrMsg = "message", msg = {extra}
   *      (TS resolves to 1-arg overload, but second arg still passed at runtime)
   *
   * Case 3 is the bug: without type-aware dispatch, runtime sees msg !== undefined
   * and incorrectly treats the string "message" as context and the object as message.
   *
   * Fix: inspect the FIRST argument — if it is a string, it is always the message.
   * Only treat it as context if it is a non-string truthy object.
   */
  private _log(level: LogLevel, contextOrMsg: unknown, extra?: unknown): void {
    const firstIsString = typeof contextOrMsg === 'string';
    const firstIsObject = contextOrMsg !== null && typeof contextOrMsg === 'object' && !Array.isArray(contextOrMsg);

    if (firstIsString) {
      // Case 1: log("message")         → extra is undefined
      // Case 3: log("message", {ctx})   → extra is the extra context object
      const extraNotNull = extra !== undefined;
      const extraIsObject = typeof extra === 'object';
      const extraNotArray = !Array.isArray(extra);
      let validCtx = false;
      if (extraNotNull) {
        if (extraIsObject) {
          if (extraNotArray) {
            validCtx = true;
          }
        }
      }
      const extraCtx = validCtx
        ? extra as Record<string, unknown>
        : undefined;
      this._pushEntry(this._makeEntry(level, contextOrMsg, extraCtx));
    } else if (firstIsObject) {
      const ctx = contextOrMsg as Record<string, unknown>;
      const msg = typeof extra === 'string' ? extra : String(extra ?? '');
      this._pushEntry(this._makeEntry(level, msg, ctx));
    } else {
      // Case 2 variant or fallback
      const extraNotNull = extra !== undefined;
      const extraIsString = typeof extra === 'string';
      let useExtra = false;
      if (extraNotNull) {
        useExtra = extraIsString;
      }
      const msg = useExtra
        ? extra as string
        : String(contextOrMsg ?? '');
      this._pushEntry(this._makeEntry(level, msg));
    }
  }

  private _logError(level: LogLevel, ...args: unknown[]): void {
    if (args.length === 1) {
      // error(msg: string) or error(err: Error)
      const arg = args[0];
      if (arg instanceof Error) {
        const entry = this._makeEntry(level, arg.message);
        entry.error = { message: arg.message, stack: arg.stack, name: arg.name };
        this._pushEntry(entry);
      } else {
        this._pushEntry(this._makeEntry(level, arg as string));
      }
    } else if (args.length === 2) {
      // error(context, msg) or error(context, err, msg?) or error(err, msg)
      const [first, second] = args;
      if (first instanceof Error) {
        // error(err, msg?)
        const msg = second as string ?? first.message;
        const entry = this._makeEntry(level, msg);
        entry.error = { message: first.message, stack: first.stack, name: first.name };
        this._pushEntry(entry);
      } else if (first && typeof first === 'object' && second instanceof Error) {
        // error(context, err) or error(context, err, msg?)
        const ctx = first as Record<string, unknown>;
        const err = second as Error;
        const msg = args[2] as string ?? err.message;
        const entry = this._makeEntry(level, msg, ctx);
        entry.error = { message: err.message, stack: err.stack, name: err.name };
        this._pushEntry(entry);
      } else {
        // error(context, msg)
        const ctx = first as Record<string, unknown>;
        const msg = second as string;
        this._pushEntry(this._makeEntry(level, msg, ctx));
      }
    } else if (args.length >= 3) {
      // error(context, err, msg)
      const [ctx, err, msg] = args;
      const entry = this._makeEntry(level, msg as string, ctx as Record<string, unknown>);
      if (err instanceof Error) {
        entry.error = { message: err.message, stack: err.stack, name: err.name };
      }
      this._pushEntry(entry);
    }
  }
}
