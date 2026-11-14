/**
 * Error utility functions for type-safe error handling.
 *
 * Replaces `catch (err: any)` patterns throughout the codebase.
 * Provides a single, consistent way to extract error messages
 * regardless of what was thrown.
 */

/**
 * Safely extract a human-readable error message from an unknown thrown value.
 *
 * Handles Error objects, strings, objects with .message, and plain values.
 * Never throws — always returns a string.
 *
 * @example
 *   try { riskyOp(); } catch (err: unknown) {
 *     logger.error(`Failed: ${getErrorMessage(err)}`);
 *   }
 */
export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
    return JSON.stringify(err);
  }
  return fallback;
}

/**
 * Safe wrapper for `err.stack` or the result of `err.stack?.toString()`.
 * Works with both Error objects and anything that looks like one.
 */
export function getErrorStack(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack;
  if (err && typeof err === 'object') {
    const stack = (err as Record<string, unknown>).stack;
    if (typeof stack === 'string') return stack;
  }
  return undefined;
}
