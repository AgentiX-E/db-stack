/**
 * LinearizabilityChecker — the fuzzy register model, history generation and
 * the malformed-history contract.
 *
 * The checker is published as part of `@agentix-e/db-cluster/testing`, so a
 * user's own cluster test depends on these answers being the documented ones:
 * a fabricated value must be reported, a not-yet-applied read must not be, and
 * a history whose search exceeds its bound must answer `'unknown'` rather than
 * claim a violation it did not prove.
 */

import { describe, it, expect } from 'vitest';
import {
  LinearizabilityChecker,
  OperationRecorder,
  fuzzyCheck,
  type Event,
} from '../../testing/LinearizabilityChecker';

function call(clientId: string, operation: 'read' | 'write', key: string, value?: string, time = 0): Event {
  return { type: 'call', clientId, operation, key, value, time };
}

function ret(clientId: string, operation: 'read' | 'write', key: string, value?: string, time = 1): Event {
  return { type: 'return', clientId, operation, key, value, time };
}

/**
 * A read result as a JSON history carries it: `null` is how "the value is not
 * there yet" arrives from the wire, which is why the checker tests for it.
 */
function readResult(clientId: string, key: string, value: string | null | undefined, time: number): Event {
  return { type: 'return', clientId, operation: 'read', key, value, time } as Event;
}

/** write(k, v) by `clientId` starting at `time`, returning `time + 1`. */
function write(clientId: string, key: string, value: string | undefined, time: number): Event[] {
  return [call(clientId, 'write', key, value, time), ret(clientId, 'write', key, undefined, time + 1)];
}

/** read(k) by `clientId` that observed `value`, starting at `time`. */
function read(clientId: string, key: string, value: string | null | undefined, time: number): Event[] {
  return [call(clientId, 'read', key, undefined, time), readResult(clientId, key, value, time + 1)];
}

describe('fuzzyCheck', () => {
  it('accepts a read that returned a value the history wrote', () => {
    const result = fuzzyCheck([...write('w1', 'account', '100', 10), ...read('r1', 'account', '100', 20)]);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect([...result.writeSet.get('account')!]).toEqual(['100']);
  });

  it('reports a read that fabricated a value for a written key', () => {
    const result = fuzzyCheck([...write('w1', 'account', '100', 10), ...read('r1', 'account', '999', 20)]);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.key).toBe('account');
    expect(result.violations[0]!.readValue).toBe('999');
    expect([...result.violations[0]!.knownValues]).toEqual(['100']);
  });

  it('reports a non-null read of a key the history never wrote', () => {
    const result = fuzzyCheck(read('r1', 'ghost', 'fabricated', 10));

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.key).toBe('ghost');
    expect(result.violations[0]!.knownValues.size).toBe(0);
  });

  it('accepts a null read for a key whose write has not been applied yet', () => {
    const result = fuzzyCheck([...write('w1', 'account', '100', 10), ...read('r1', 'account', null, 20)]);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('keeps an independent write set per key', () => {
    const events = [
      ...write('w1', 'a', '1', 10),
      ...write('w2', 'b', '2', 20),
      ...read('r1', 'a', '1', 30),
      ...read('r2', 'b', '1', 40),
    ];

    const result = fuzzyCheck(events);

    expect([...result.writeSet.keys()].sort()).toEqual(['a', 'b']);
    expect([...result.writeSet.get('b')!]).toEqual(['2']);
    // '1' is legitimate for 'a' but fabricated for 'b'.
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.key).toBe('b');
  });
});

describe('LinearizabilityChecker.pairEvents', () => {
  it('rejects a return that has no matching call', () => {
    expect(() => LinearizabilityChecker.pairEvents([ret('c1', 'write', 'k', undefined, 10)])).toThrow(
      /Unpaired return for client c1/,
    );
  });

  it('rejects a return whose operation differs from its call', () => {
    const events = [call('c1', 'read', 'k', undefined, 10), ret('c1', 'write', 'k', undefined, 11)];

    expect(() => LinearizabilityChecker.pairEvents(events)).toThrow(
      /Mismatched operation for client c1: read vs write/,
    );
  });

  it('drops a call that never returned once the client starts its next one', () => {
    const events = [
      call('c1', 'write', 'k', 'aborted', 10),
      call('c1', 'write', 'k', 'completed', 20),
      ret('c1', 'write', 'k', undefined, 21),
    ];

    const operations = LinearizabilityChecker.pairEvents(events);

    expect(operations).toHaveLength(1);
    expect(operations[0]!.call.value).toBe('completed');
    expect(operations[0]!.ret.time).toBe(21);
  });
});

describe('LinearizabilityChecker.isLinearizable bound', () => {
  it("answers 'unknown' instead of false when the search bound is exhausted", () => {
    // A read cannot legally observe 'stale' after write('fresh') returned, so
    // the history is not linearizable — but a bound of 1 state must be reported
    // as "not proven" rather than as a violation.
    const events = [...write('w1', 'k', 'fresh', 10), ...read('r1', 'k', 'stale', 20)];

    expect(LinearizabilityChecker.isLinearizable(events, 1)).toBe('unknown');
    expect(LinearizabilityChecker.isLinearizable(events)).toBe(false);
  });

  it('accepts a read that observed no value before the key was ever written', () => {
    expect(LinearizabilityChecker.isLinearizable(read('r1', 'never-set', null, 10))).toBe(true);
  });

  it('cannot prove a linearizable history with a zero state budget', () => {
    // A bound of zero leaves no state to explore, so the honest answer is
    // "unknown" — never a false accusation against a correct history.
    const events = [...write('w1', 'k', 'v', 10), ...read('r1', 'k', 'v', 20)];

    expect(LinearizabilityChecker.isLinearizable(events, 0)).toBe('unknown');
    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });
});

describe('LinearizabilityChecker.generateHistory', () => {
  it('emits a call and a return for each operation, carrying its value', () => {
    const events = LinearizabilityChecker.generateHistory(
      [
        { clientId: 'w1', operation: 'write', key: 'k', value: 'v1' },
        { clientId: 'r1', operation: 'read', key: 'k', result: 'v1' },
      ],
      1000,
      20,
    );

    expect(events.map((e) => e.type)).toEqual(['call', 'return', 'call', 'return']);
    const [writeCall, writeReturn, readCall, readReturn] = events as [
      Extract<Event, { type: 'call' }>,
      Extract<Event, { type: 'return' }>,
      Extract<Event, { type: 'call' }>,
      Extract<Event, { type: 'return' }>,
    ];

    expect(writeCall.value).toBe('v1');
    expect(writeReturn.value).toBeUndefined();
    expect(readCall.value).toBeUndefined();
    expect(readReturn.value).toBe('v1');

    expect(writeReturn.time).toBeGreaterThan(writeCall.time);
    expect(readReturn.time).toBeGreaterThan(readCall.time);
    expect(readCall.time).toBeGreaterThan(writeCall.time);
  });

  it('produces a history the checker can consume as written', () => {
    const events = LinearizabilityChecker.generateHistory([
      { clientId: 'w1', operation: 'write', key: 'k', value: 'v1' },
      { clientId: 'r1', operation: 'read', key: 'k', result: 'v1' },
    ]);

    expect(LinearizabilityChecker.pairEvents(events)).toHaveLength(2);
    expect(LinearizabilityChecker.isLinearizable(events)).toBe(true);
  });
});

describe('OperationRecorder.reset', () => {
  it('clears the history and restarts call numbering', () => {
    const recorder = new OperationRecorder();
    const firstCallId = recorder.recordCall('c1', 'write', 'k', 'v');
    recorder.recordReturn(firstCallId, 'write', 'k');
    expect(recorder.getEvents()).toHaveLength(2);

    recorder.reset();

    expect(recorder.getEvents()).toEqual([]);
    expect(recorder.recordCall('c1', 'write', 'k', 'v')).toBe(firstCallId);
  });

  it('hands out a copy that a caller cannot use to rewrite the history', () => {
    const recorder = new OperationRecorder();
    recorder.recordCall('c1', 'read', 'k');

    recorder.getEvents().push(call('c2', 'read', 'k', undefined, 99));

    expect(recorder.getEvents()).toHaveLength(1);
  });

  it('attributes a return recorded without a call to the id it was given', () => {
    const recorder = new OperationRecorder();

    recorder.recordReturn('client-x', 'read', 'k', 'v');

    expect(recorder.getEvents()[0]!.clientId).toBe('client-x');
  });
});
