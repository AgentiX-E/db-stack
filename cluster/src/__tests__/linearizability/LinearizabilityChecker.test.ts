/**
 * LinearizabilityChecker Tests — correctness and edge cases.
 *
 * D2 iteration: verifies the checker itself catches violations
 * and correctly accepts linearizable histories.
 *
 * Scenarios:
 *   L.1 — Single write → single read: trivially linearizable
 *   L.2 — Two concurrent writes on same key: any order is legal
 *   L.3 — Read-after-write (real-time order): linearizable
 *   L.4 — Read gets stale value after write returned: violation
 *   L.5 — Complex interleaving with 3 clients
 *   L.6 — Empty history
 *   L.7 — Malformed events (unpaired call)
 *   L.8 — OperationRecorder integration
 */

import { describe, it, expect } from 'vitest';
import { LinearizabilityChecker, OperationRecorder, type Event, type CallEvent, type ReturnEvent } from './LinearizabilityChecker';

function makeCall(clientId: string, op: 'read' | 'write', key: string, value?: string, time?: number): CallEvent {
  return { type: 'call', clientId, operation: op, key, value, time: time ?? Date.now() };
}

function makeRet(clientId: string, op: 'read' | 'write', key: string, value?: string, time?: number): ReturnEvent {
  return { type: 'return', clientId, operation: op, key, value, time: time ?? Date.now() + 1 };
}

describe('LinearizabilityChecker', () => {
  // L.1: Single write → single read
  it('L.1: should accept a single write-then-read sequence', () => {
    const t = 1000;
    const events: Event[] = [
      makeCall('a', 'write', 'x', '1', t),
      makeRet('a', 'write', 'x', undefined, t + 10),
      makeCall('b', 'read', 'x', undefined, t + 20),
      makeRet('b', 'read', 'x', '1', t + 25),
    ];

    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });

  // L.2: Two concurrent writes on same key — any order is legal
  it('L.2: should accept concurrent writes in any order', () => {
    const t = 1000;
    const events: Event[] = [
      makeCall('a', 'write', 'x', '1', t),
      makeCall('b', 'write', 'x', '2', t + 1),
      makeRet('a', 'write', 'x', undefined, t + 10),
      makeRet('b', 'write', 'x', undefined, t + 11),
      makeCall('c', 'read', 'x', undefined, t + 20),
      // Read returns either '1' or '2' — both legal
      makeRet('c', 'read', 'x', '2', t + 25),
    ];

    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });

  // L.3: Read-after-write (real-time order: write returned before read started)
  it('L.3: should accept sequential write-then-read', () => {
    const t = 1000;
    const events: Event[] = [
      makeCall('a', 'write', 'x', '42', t),
      makeRet('a', 'write', 'x', undefined, t + 10),
      makeCall('b', 'read', 'x', undefined, t + 20),
      makeRet('b', 'read', 'x', '42', t + 25),
    ];

    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });

  // L.4: Read returns stale value after write returned — violation
  it('L.4: should detect violation — read returns stale value', () => {
    const t = 1000;
    const events: Event[] = [
      makeCall('a', 'write', 'x', '2', t),
      makeRet('a', 'write', 'x', undefined, t + 10),
      // Write to 'x' = '2' completed at t+10
      // Now read starts AFTER write returned — must see '2'
      makeCall('b', 'read', 'x', undefined, t + 20),
      // But read returns stale '1' — violation!
      makeRet('b', 'read', 'x', '1', t + 25),
    ];

    expect(LinearizabilityChecker.isLinearizable(events)).toBe(false);
  });

  // L.5: Complex interleaving with 3 clients
  it('L.5: should handle complex 3-client interleaving', () => {
    const t = 1000;
    // a writes x=10, b writes y=20 concurrently
    // c reads x and y — must see both writes or none
    const events: Event[] = [
      makeCall('a', 'write', 'x', '10', t),
      makeCall('b', 'write', 'y', '20', t + 1),
      makeRet('a', 'write', 'x', undefined, t + 10),
      makeRet('b', 'write', 'y', undefined, t + 11),
      // c reads x and y after both writes returned
      makeCall('c', 'read', 'x', undefined, t + 20),
      makeRet('c', 'read', 'x', '10', t + 25),
      makeCall('c', 'read', 'y', undefined, t + 26),
      makeRet('c', 'read', 'y', '20', t + 30),
    ];

    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });

  // L.6: Empty history
  it('L.6: should accept empty history', () => {
    expect(LinearizabilityChecker.isLinearizable([])).toBe(true);
  });

  // L.7: Unpaired call silently skipped (pairEvents tolerates orphan calls from crashed clients)
  it('L.7: should silently skip unpaired call event', () => {
    const events: Event[] = [
      makeCall('a', 'write', 'x', '1'),
      // missing return — this is a crash/abort scenario
    ];

    // pairEvents should NOT throw; it should silently skip the orphan call
    const result = LinearizabilityChecker.isLinearizable(events);
    expect(result).toBe(true); // empty history is trivially linearizable
  });

  // L.8: OperationRecorder integration
  it('L.8: OperationRecorder should produce checkable events', () => {
    const recorder = new OperationRecorder();
    const t = Date.now();

    // Simulate a write operation
    const callId = recorder.recordCall('alice', 'write', 'k', 'hello');
    recorder.recordReturn(callId, 'write', 'k');

    // Simulate a read that sees the write
    const callId2 = recorder.recordCall('bob', 'read', 'k');
    recorder.recordReturn(callId2, 'read', 'k', 'hello');

    const events = recorder.getEvents();
    expect(events.length).toBe(4);

    const result = recorder.isLinearizable();
    expect(result).toBe(true);
  });

  // L.9: pairEvents basic test
  it('L.9: pairEvents should correctly pair call/return', () => {
    const t = 1000;
    const events: Event[] = [
      makeCall('a', 'write', 'x', '1', t),
      makeRet('a', 'write', 'x', undefined, t + 10),
      makeCall('a', 'read', 'x', undefined, t + 20),
      makeRet('a', 'read', 'x', '1', t + 25),
    ];

    const ops = LinearizabilityChecker.pairEvents(events);
    expect(ops.length).toBe(2);
    expect(ops[0].clientId).toBe('a');
    expect(ops[0].call.operation).toBe('write');
    expect(ops[1].call.operation).toBe('read');
    expect(ops[1].ret.value).toBe('1');
  });
});
