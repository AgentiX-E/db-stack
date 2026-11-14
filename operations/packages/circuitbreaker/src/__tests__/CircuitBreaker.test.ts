import { describe, it, expect } from 'vitest';
import { InMemoryCircuitBreaker } from '../impl/InMemoryCircuitBreaker.js';

describe('InMemoryCircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new InMemoryCircuitBreaker('test');
    expect(cb.getState()).toBe('closed');
  });

  it('opens after failure threshold reached', () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 3, timeoutMs: 60000 });
    cb.onFailure();
    expect(cb.getState()).toBe('closed');
    cb.onFailure();
    expect(cb.getState()).toBe('closed');
    cb.onFailure();
    expect(cb.getState()).toBe('open');
  });

  it('throws when calling while open without fallback', async () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 60000 });
    cb.onFailure();
    await expect(cb.call(() => Promise.resolve('ok'))).rejects.toThrow('OPEN');
  });

  it('returns fallback when circuit is open', async () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 60000 });
    cb.onFailure();
    const result = await cb.call(() => Promise.resolve('real'), () => Promise.resolve('fallback'));
    expect(result).toBe('fallback');
  });

  it('transitions from open to half-open after timeout', async () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 1 });
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    await new Promise(r => setTimeout(r, 5));
    expect(cb.getState()).toBe('half-open');
  });

  it('closes from half-open on success', () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 1 });
    cb.onFailure();
    cb.getState(); // force transition to half-open after timeout
    // Manually set to half-open
    (cb as any).state = 'half-open';
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('call() transitions half-open to closed on successful execution', async () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 1 });
    cb.onFailure();        // open the circuit
    await new Promise((r) => setTimeout(r, 5)); // let timeoutMs elapse
    expect(cb.getState()).toBe('half-open');

    // A successful call while half-open must hit the `currentState === 'half-open'`
    // branch and close the circuit.
    const result = await cb.call(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  it('reset restores closed state and clears failures', () => {
    const cb = new InMemoryCircuitBreaker('test', { failureThreshold: 1, timeoutMs: 60000 });
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(() => cb.reset()).not.toThrow();
  });

  it('returns function result when closed', async () => {
    const cb = new InMemoryCircuitBreaker('test');
    const result = await cb.call(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('calls fallback on function failure', async () => {
    const cb = new InMemoryCircuitBreaker('test');
    const result = await cb.call(
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('fallback'),
    );
    expect(result).toBe('fallback');
  });

  it('rethrows error without fallback on function failure', async () => {
    const cb = new InMemoryCircuitBreaker('test');
    await expect(cb.call(() => Promise.reject(new Error('db error')))).rejects.toThrow('db error');
  });

  it('has the correct name property', () => {
    const cb = new InMemoryCircuitBreaker('my-service');
    expect(cb.name).toBe('my-service');
  });

  it('succeeds with zero threshold test configuration', async () => {
    const cb = new InMemoryCircuitBreaker('zero', { failureThreshold: 1, timeoutMs: 60000 });
    // Immediately open
    cb.onFailure();
    // half-open after 1ms timeout
    const cb2 = new InMemoryCircuitBreaker('zero-fast', { failureThreshold: 1, timeoutMs: 0 });
    cb2.onFailure();
    expect(cb2.getState()).toBe('open');
  });

  it('onSuccess in closed state decrements failure count', () => {
    const cb = new InMemoryCircuitBreaker('decrement', { failureThreshold: 3, timeoutMs: 60000 });
    (cb as any).failureCount = 2;
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
    expect((cb as any).failureCount).toBe(1);
  });

  it('onSuccess in closed state floors failure count at zero', () => {
    const cb = new InMemoryCircuitBreaker('floor', { failureThreshold: 3, timeoutMs: 60000 });
    (cb as any).failureCount = 0;
    cb.onSuccess();
    expect((cb as any).failureCount).toBe(0);
  });
});
