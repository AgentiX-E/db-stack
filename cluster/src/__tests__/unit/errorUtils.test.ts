/**
 * Tests for the type-safe error utility functions.
 *
 * Verifies that getErrorMessage / getErrorStack handle every thrown-value
 * shape the codebase may encounter (Error, string, object-with-message,
 * arbitrary object, and plain primitives) without ever throwing.
 */

import { describe, it, expect } from 'vitest';
import { getErrorMessage, getErrorStack } from '../../consensus/helpers/errorUtils';

describe('getErrorMessage', () => {
  it('extracts the message from an Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('extracts the message from a subclassed Error', () => {
    class CustomError extends Error {
      constructor(m: string) { super(m); this.name = 'CustomError'; }
    }
    expect(getErrorMessage(new CustomError('custom'))).toBe('custom');
  });

  it('returns the string itself for a thrown string', () => {
    expect(getErrorMessage('just a string')).toBe('just a string');
  });

  it('extracts .message from a plain object', () => {
    expect(getErrorMessage({ message: 'from object' })).toBe('from object');
  });

  it('JSON-stringifies an object without a string message', () => {
    const err = { code: 42, reason: 'nope' };
    expect(getErrorMessage(err)).toBe(JSON.stringify(err));
  });

  it('returns the fallback for null', () => {
    expect(getErrorMessage(null, 'default')).toBe('default');
  });

  it('returns the fallback for undefined', () => {
    expect(getErrorMessage(undefined, 'fallback-msg')).toBe('fallback-msg');
  });

  it('returns the fallback for a plain number', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
  });

  it('returns the fallback for a plain boolean', () => {
    expect(getErrorMessage(true)).toBe('Unknown error');
  });

  it('returns the empty string message verbatim when Error has empty message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });

  it('ignores a non-string .message on an object and stringifies instead', () => {
    const err = { message: 123, other: 'x' };
    expect(getErrorMessage(err)).toBe(JSON.stringify(err));
  });
});

describe('getErrorStack', () => {
  it('returns the stack of an Error instance', () => {
    const err = new Error('with-stack');
    expect(getErrorStack(err)).toBe(err.stack);
  });

  it('returns the .stack property of a stack-like object', () => {
    const err = { stack: 'fake stack trace' };
    expect(getErrorStack(err)).toBe('fake stack trace');
  });

  it('returns undefined for a string', () => {
    expect(getErrorStack('no stack here')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(getErrorStack(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(getErrorStack(undefined)).toBeUndefined();
  });

  it('returns undefined when an object has a non-string stack', () => {
    const err = { stack: 42 };
    expect(getErrorStack(err)).toBeUndefined();
  });

  it('returns undefined for a plain object with no stack', () => {
    expect(getErrorStack({ message: 'no stack' })).toBeUndefined();
  });

  it('returns undefined for a plain primitive', () => {
    expect(getErrorStack(7)).toBeUndefined();
  });
});
