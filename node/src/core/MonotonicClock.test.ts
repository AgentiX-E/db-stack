/**
 * MonotonicClock — node's copy of the epoch-anchored, non-decreasing clock.
 *
 * Every case injects the source; none sleeps, so a passing case is evidence of
 * the clamp rather than of a cooperative host clock.
 *
 * @module @agentix-e/db-node/core
 */

import { describe, expect, it } from 'vitest';

import { createMonotonicClock } from './MonotonicClock.js';

describe('MonotonicClock — node', () => {
  it('MC.1 — follows a forward-moving source', () => {
    let t = 100;
    const clock = createMonotonicClock(() => t);
    expect(clock.now()).toBe(100);
    t = 140;
    expect(clock.now()).toBe(140);
  });

  it('MC.2 — clamps a backwards step to the watermark', () => {
    let t = 900;
    const clock = createMonotonicClock(() => t);
    clock.now();
    t = 700;
    expect(clock.now()).toBe(900);
    t = 850;
    expect(clock.now()).toBe(900);
  });

  it('MC.3 — resumes only past the previous maximum', () => {
    let t = 900;
    const clock = createMonotonicClock(() => t);
    clock.now();
    t = 950;
    expect(clock.now()).toBe(950);
  });

  it('MC.4 — equal and repeated readings are stable', () => {
    const clock = createMonotonicClock(() => 42);
    expect(clock.now()).toBe(42);
    expect(clock.now()).toBe(42);
  });

  it('MC.5 — reads the source on every call', () => {
    let calls = 0;
    const clock = createMonotonicClock(() => 10 + ++calls);
    clock.now();
    const afterFirst = calls;
    clock.now();
    expect(calls).toBeGreaterThan(afterFirst);
    expect(clock.now()).toBeGreaterThan(10);
  });
});
