/**
 * InMemoryDeadlockDetector — branch-completion tests.
 *
 * Targets two reachable branches not exercised by the cycle-detection suite:
 *
 *   1. The `?.` short-circuit in reportLockAcquired: `this._waitFor.get(txId)?.delete(resourceId)`
 *      is a no-op when the transaction never issued a lock-wait (it is not
 *      present in the `_waitFor` map).
 *
 *   2. The `catch {}` in `_notifyCallbacks`: a registered callback that throws
 *      must be swallowed so it cannot abort deadlock detection.
 */

import { describe, it, expect } from "vitest";
import { InMemoryDeadlockDetector } from "../impl/InMemoryDeadlockDetector.js";

describe("IDD-branch: optional chaining and callback isolation", () => {
  it("reportLockAcquired is a no-op delete for a transaction that never waited", () => {
    const detector = new InMemoryDeadlockDetector();
    // txA acquires without a prior wait → `_waitFor.get('txA')` is undefined,
    // so `?.delete(...)` must short-circuit without throwing.
    expect(() => detector.reportLockAcquired("txA", "res-1")).not.toThrow();

    // No deadlock is recorded from that lone acquire.
    expect(detector.detectDeadlocks()).toHaveLength(0);
    expect(detector.getDeadlockCount()).toBe(0);
  });

  it("clears a waited resource when the same tx later acquires it", () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockWait("txA", "res-1");
    // Now `_waitFor` has txA; acquiring res-1 must delete it (the non-short-circuit path).
    detector.reportLockAcquired("txA", "res-1");
    expect(detector.detectDeadlocks()).toHaveLength(0);
  });

  it("swallows a throwing deadlock callback without aborting detection", () => {
    const detector = new InMemoryDeadlockDetector();
    let calls = 0;
    detector.onDeadlock(() => {
      calls += 1;
      throw new Error("callback boom");
    });
    detector.onDeadlock(() => {
      calls += 1;
    });

    // Force a real cycle; _notifyCallbacks must invoke every callback and swallow
    // the first one's exception so the second still runs.
    detector.reportLockAcquired("txA", "res-1");
    detector.reportLockAcquired("txB", "res-2");
    detector.reportLockWait("txA", "res-2");
    detector.reportLockWait("txB", "res-1");

    expect(() => detector.detectDeadlocks()).not.toThrow();
    expect(calls).toBe(2);
    expect(detector.getDeadlockCount()).toBe(1);
  });

  it("exposes raw deadlock events without mutating internal state", () => {
    const detector = new InMemoryDeadlockDetector();
    detector.reportLockTimeout("txA", "res-1");

    const raw = detector.getRawDeadlockEvents();
    expect(raw).toHaveLength(1);
    expect(raw[0].resolvedBy).toBe("timeout:txA");
    expect(raw[0].transactions).toEqual(["txA"]);

    // The returned array is a defensive copy — mutating it must not affect history.
    raw.push({} as any);
    expect(detector.getDeadlockCount()).toBe(1);
    expect(detector.getRawDeadlockEvents()).toHaveLength(1);
  });
});
