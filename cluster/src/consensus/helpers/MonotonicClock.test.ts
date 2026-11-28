/**
 * MonotonicClock — an epoch-anchored clock that cannot move backwards.
 *
 * Fencing and lease decisions subtract two timestamps. When the host clock
 * steps backwards (NTP correction, VM migration, manual adjustment), that
 * subtraction goes negative: a lease looks unexpired forever and a partitioned
 * leader is never fenced. The fix is not to abandon the epoch domain — callers
 * pass epoch timestamps to `onQuorumHeartbeatAck` and status consumers read
 * them — but to clamp the reading so it never decreases.
 *
 * Every case injects the source; none sleeps. A passing case is evidence that
 * the clamp, not the fixture's good fortune, produced the reading.
 *
 * @module @agentix-e/db-cluster/consensus/helpers
 */

import { describe, expect, it } from 'vitest';

import { createMonotonicClock } from './MonotonicClock.js';

describe('MonotonicClock — epoch-anchored, cannot move backwards', () => {
  it('MC.1 — returns the source value when time moves forward', () => {
    let t = 1_000;
    const clock = createMonotonicClock(() => t);
    expect(clock.now()).toBe(1_000);
    t = 1_050;
    expect(clock.now()).toBe(1_050);
  });

  it('MC.2 — a backwards step is clamped to the last reading', () => {
    let t = 5_000;
    const clock = createMonotonicClock(() => t);
    expect(clock.now()).toBe(5_000); // anchor
    t = 4_000; // the host clock steps back one second
    expect(clock.now()).toBe(5_000); // clamp holds
    t = 4_500; // still below the anchor
    expect(clock.now()).toBe(5_000);
  });

  it('MC.3 — time resumes only after it passes the old high-water mark', () => {
    let t = 5_000;
    const clock = createMonotonicClock(() => t);
    clock.now(); // anchor at 5_000
    t = 4_900;
    clock.now(); // clamped
    t = 5_010; // finally past the watermark
    expect(clock.now()).toBe(5_010);
  });

  it('MC.4 — equal readings are stable', () => {
    const clock = createMonotonicClock(() => 777);
    expect(clock.now()).toBe(777);
    expect(clock.now()).toBe(777);
  });

  it('MC.5 — the source is read on every call, not cached once', () => {
    let calls = 0;
    const clock = createMonotonicClock(() => 10 + ++calls);
    clock.now();
    const afterFirst = calls;
    clock.now();
    expect(calls).toBeGreaterThan(afterFirst); // a second read happened
    expect(clock.now()).toBeGreaterThan(10); // and it saw the advancing source
  });
});
