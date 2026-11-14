/**
 * Debugging script: analyze why linearizability check returns false.
 * Run: npx vitest run --reporter=verbose src/__tests__/chaos/debug-linearizability.ts
 */

import { describe, it, expect } from 'vitest';
import { LinearizabilityChecker, OperationRecorder } from '../linearizability/LinearizabilityChecker';

describe('Linearizability Debug', () => {
  it('should analyze history and find violations', () => {
    const recorder = new OperationRecorder();

    // Simulate a real Jepsen-like workload with small operations
    for (let i = 0; i < 5; i++) {
      // write k0 -> v0
      const c1 = recorder.recordCall('c1', 'write', 'k0', `v${i}`);
      recorder.recordReturn(c1, 'write', 'k0');

      // read k0 -> should see v{i}
      const c2 = recorder.recordCall('c1', 'read', 'k0');
      recorder.recordReturn(c2, 'read', 'k0', `v${i}`);

      // write k1 -> v1
      const c3 = recorder.recordCall('c2', 'write', 'k1', `w${i}`);
      recorder.recordReturn(c3, 'write', 'k1');
    }

    // Also add some overlapping operations to test concurrency
    const c4 = recorder.recordCall('c3', 'write', 'k0', 'overlap');
    recorder.recordReturn(c4, 'write', 'k0');
    const c5 = recorder.recordCall('c3', 'read', 'k0');
    recorder.recordReturn(c5, 'read', 'k0', 'overlap');

    // Test without failures
    const events = recorder.getEvents();
    console.log(`Events: ${events.length} (${events.length / 2} operations)`);

    const operations = LinearizabilityChecker.pairEvents(events);
    console.log(`Operations: ${operations.length}`);

    const result = LinearizabilityChecker.isLinearizable(events, 1_000_000);
    console.log(`Linearizable: ${result}`);

    expect(result).not.toBe(false);
  });

  it('should handle concurrent writes to same key', () => {
    const recorder = new OperationRecorder();

    // Concurrent overlapping operations
    const c1 = recorder.recordCall('c1', 'write', 'k', 'a');
    const c2 = recorder.recordCall('c2', 'write', 'k', 'b');
    recorder.recordReturn(c1, 'write', 'k');
    recorder.recordReturn(c2, 'write', 'k');

    // Read after both writes
    const c3 = recorder.recordCall('c3', 'read', 'k');
    recorder.recordReturn(c3, 'read', 'k', 'b');

    const events = recorder.getEvents();
    const result = LinearizabilityChecker.isLinearizable(events, 1_000_000);
    console.log(`Concurrent writes linearizable: ${result}`);
    expect(result).not.toBe(false);
  });

  it('should handle failed writes (no-return)', () => {
    const recorder = new OperationRecorder();

    // Successful writes
    const c1 = recorder.recordCall('c1', 'write', 'k', 'a');
    recorder.recordReturn(c1, 'write', 'k');

    // A write call without return (failed)
    const c2 = recorder.recordCall('c2', 'write', 'k', 'b');
    // No return for c2!

    // Read sees only 'a'
    const c3 = recorder.recordCall('c3', 'read', 'k');
    recorder.recordReturn(c3, 'read', 'k', 'a');

    // This should throw "Unpaired event" — test it
    const events = recorder.getEvents();
    try {
      LinearizabilityChecker.pairEvents(events);
      console.log('ERROR: should have thrown on unpaired event');
    } catch (e: any) {
      console.log(`Correctly threw: ${e.message}`);
    }
  });

  it('should handle failed writes with return-undefined', () => {
    const recorder = new OperationRecorder();

    const c1 = recorder.recordCall('c1', 'write', 'k', 'a');
    recorder.recordReturn(c1, 'write', 'k');

    // Failed write — call/return recorded but value not written
    const c2 = recorder.recordCall('c2', 'write', 'k', 'b');
    recorder.recordReturn(c2, 'write', 'k'); // no value = undefined

    // Read should see 'a' (the failed write didn't take effect)
    const c3 = recorder.recordCall('c3', 'read', 'k');
    recorder.recordReturn(c3, 'read', 'k', 'a');

    const events = recorder.getEvents();
    const result = LinearizabilityChecker.isLinearizable(events, 1_000_000);
    console.log(`Failed write (return no-value) linearizable: ${result}`);
    expect(result).not.toBe(false);
  });

  it('should handle concurrent failed writes to same key', () => {
    const recorder = new OperationRecorder();

    // Three overlapping operations to same key
    const c1 = recorder.recordCall('c1', 'write', 'k', 'v1');
    const c2 = recorder.recordCall('c2', 'write', 'k', 'v2');
    recorder.recordReturn(c1, 'write', 'k');  // succeeds
    recorder.recordReturn(c2, 'write', 'k');  // succeeds (overwrite)

    const c3 = recorder.recordCall('c3', 'read', 'k');
    recorder.recordReturn(c3, 'read', 'k', 'v2');  // sees last write

    const events = recorder.getEvents();
    const result = LinearizabilityChecker.isLinearizable(events, 1_000_000);
    console.log(`Concurrent writes to same key: ${result}`);
    expect(result).not.toBe(false);
  });
});
