/**
 * ShardStateMachine — the state it reports is the state it has.
 *
 * `getState()` returned `{ status: 'running' }`: a constant, on every machine, at
 * every moment, whether it had applied nothing or ten thousand entries, and
 * whether the last apply had succeeded or thrown. The interface it implements is
 * the one a leader asks to answer `getState` for a shard, so the answer was the
 * same for a shard that was caught up and one that had never seen a log entry.
 *
 * The same file declared `applyHandler?(data, index?, term?)` and documented that
 * the position comes from `getEntryContext` — a callback that did not exist, so
 * `apply()` called the handler with the payload alone and the parameters were
 * decoration. That matters beyond bookkeeping: PITR records where in the log each
 * write happened, and the adapter was the only place that knew.
 *
 *   SM.1  a machine that has applied nothing says so
 *   SM.2  the applied count, index and term are the last entry's
 *   SM.3  the handler receives the position the context reports
 *   SM.4  a handler that throws leaves the machine degraded, with the reason, and still throws
 *   SM.5  no context still applies, and the count still moves
 *   SM.6  a snapshot install does not count as an apply
 */

import { describe, expect, it, vi } from 'vitest';
import { ShardStateMachine } from '../../consensus/core/ShardStateMachine';
import type { Command } from '@maboke123/raft-core';

function command(payload: unknown): Command {
  return { type: 'command', payload } as Command;
}

describe('ShardStateMachine — what it reports', () => {
  it('SM.1: a machine that has applied nothing says so', () => {
    const sm = new ShardStateMachine({});
    expect(sm.getState()).toEqual({
      status: 'running',
      appliedCommands: 0,
      appliedIndex: null,
      appliedTerm: null,
      lastAppliedAt: null,
      lastError: null,
    });
  });

  it('SM.2: the count, index and term are the ones the entries carried', async () => {
    let context: { index: number; term: number } | undefined = { index: 7, term: 2 };
    const sm = new ShardStateMachine({
      applyHandler: () => {},
      getEntryContext: () => context,
    });

    await sm.apply(command('a=1'));
    context = { index: 9, term: 3 };
    await sm.apply(command('b=2'));

    const state = sm.getState();
    expect(state.appliedCommands).toBe(2);
    expect(state.appliedIndex).toBe(9);
    expect(state.appliedTerm).toBe(3);
    expect(state.lastAppliedAt).toBeGreaterThan(0);
    expect(state.lastError).toBeNull();
    expect(state.status).toBe('running');
  });

  it('SM.3: the handler receives the position the context reports', async () => {
    const handler = vi.fn();
    const sm = new ShardStateMachine({
      applyHandler: handler,
      getEntryContext: () => ({ index: 42, term: 5 }),
    });

    await sm.apply(command('SET k v'));

    expect(handler).toHaveBeenCalledWith('SET k v', 42, 5);
  });

  it('SM.3: without a context the handler is called with the payload alone', async () => {
    const handler = vi.fn();
    const sm = new ShardStateMachine({ applyHandler: handler });

    await sm.apply(command('SET k v'));

    // Two arguments, not three with two `undefined`s: a handler that forwards its
    // arguments, or a test that asserts the call, should not have to know that the
    // position was unavailable.
    expect(handler.mock.calls[0]).toEqual(['SET k v']);
  });

  it('SM.4: a handler that throws leaves the machine degraded, with the reason', async () => {
    const sm = new ShardStateMachine({
      applyHandler: () => {
        throw new Error('disk full');
      },
      getEntryContext: () => ({ index: 3, term: 1 }),
    });

    await expect(sm.apply(command('a=1'))).rejects.toThrow('disk full');

    const state = sm.getState();
    expect(state.status).toBe('degraded');
    expect(state.lastError).toBe('disk full');
    // The entry was attempted, and the position it failed at is the useful part.
    expect(state.appliedIndex).toBe(3);
    expect(state.appliedCommands).toBe(0);
  });

  it('SM.4: a later success clears the failure', async () => {
    let fail = true;
    const sm = new ShardStateMachine({
      applyHandler: () => {
        if (fail) throw new Error('transient');
      },
    });

    await expect(sm.apply(command('a=1'))).rejects.toThrow('transient');
    fail = false;
    await sm.apply(command('b=2'));

    expect(sm.getState().status).toBe('running');
    expect(sm.getState().lastError).toBeNull();
  });

  it('SM.5: no context still applies, and the count still moves', async () => {
    const handler = vi.fn();
    const sm = new ShardStateMachine({ applyHandler: handler });

    await sm.apply(command({ op: 'SET' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sm.getState().appliedCommands).toBe(1);
    expect(sm.getState().appliedIndex).toBeNull();
  });

  it('SM.6: installing a snapshot does not count as an apply', async () => {
    const sm = new ShardStateMachine({ installSnapshotCallback: () => {} });

    await sm.installSnapshot(Buffer.from('state'));

    expect(sm.getState().appliedCommands).toBe(0);
  });
});
