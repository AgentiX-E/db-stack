/**
 * CatastrophicFailoverManager — recovery-consultation tests.
 *
 * F-07 / P3-81: `recoverDC()` used to be `await setTimeout(0)` plus a boolean
 * flip and a clear of a `pendingEvents` counter nothing ever incremented.
 * A recovery that never asks the resource it is recovering is not a recovery.
 * These tests pin the contract that a failed DC becomes healthy only after the
 * injected, engine-agnostic recovery action resolves, and that its pending
 * work is handed to that action rather than silently discarded.
 */

import { describe, it, expect, vi } from 'vitest';
import { CatastrophicFailoverManager } from './CatastrophicFailoverManager';
import { TopologyManager } from '../topology/TopologyManager';
import type { ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';

function makeTarget(overrides: Partial<ReplicationTarget> & { nodeId: string }): ReplicationTarget {
  return {
    dc: overrides.dc ?? 'dc-east',
    address: overrides.address ?? '127.0.0.1:7001',
    topology: overrides.topology ?? 'cross-dc',
    maxBackoffSeconds: overrides.maxBackoffSeconds ?? 60,
    ...overrides,
  };
}

function makeTopology(): TopologyManager {
  return new TopologyManager({
    nodeId: 'node-1',
    dc: 'dc-west',
    peers: [makeTarget({ nodeId: 'node-3', dc: 'dc-east' })],
  });
}

function failDC(fm: CatastrophicFailoverManager, dc = 'dc-east'): void {
  // Seed heartbeats in the past so detection is immediate without fake timers.
  vi.spyOn(Date, 'now').mockReturnValue(0);
  fm.recordHeartbeat(dc);
  vi.spyOn(Date, 'now').mockReturnValue(60_000);
  expect(fm.detectDCFailure(dc)).toBe(true);
  vi.restoreAllMocks();
}

describe('CatastrophicFailoverManager — recovery consults the resource', () => {
  it('marks a DC healthy only after the injected recovery action resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn(async () => {
      await gate;
    });
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000, { recover });
    failDC(fm);
    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(false);

    const pending = fm.recoverDC('dc-east');
    // Before the resource confirms recovery, the DC must not be declared healthy.
    expect(recover).toHaveBeenCalledTimes(1);
    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(false);

    release();
    await pending;
    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(true);
  });

  it('hands the pending-event count to the recovery action and clears it on success', async () => {
    const recover = vi.fn(async () => {});
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000, { recover });
    failDC(fm);
    fm.recordPendingEvent('dc-east', 3);
    fm.recordPendingEvent('dc-east', 2);
    expect(fm.getDCHealth().get('dc-east')!.pendingEvents).toBe(5);

    await fm.recoverDC('dc-east');

    expect(recover).toHaveBeenCalledWith('dc-east', 5);
    expect(fm.getDCHealth().get('dc-east')!.pendingEvents).toBe(0);
  });

  it('keeps the DC unhealthy and reports through onError when recovery rejects', async () => {
    const failure = new Error('resource refused reconfiguration');
    const recover = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000, { recover, onError });
    failDC(fm);
    fm.recordPendingEvent('dc-east', 4);

    await expect(fm.recoverDC('dc-east')).resolves.toBeUndefined();

    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(false);
    expect(fm.getDCHealth().get('dc-east')!.pendingEvents).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('resource refused reconfiguration');
  });

  it('converts a non-Error recovery rejection into an Error for onError', async () => {
    const onError = vi.fn();
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000, {
      recover: async () => {
        throw 42; // eslint-disable-line no-throw-literal
      },
      onError,
    });
    failDC(fm);
    await fm.recoverDC('dc-east');
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('42');
  });

  it('keeps the DC unhealthy on a failed recovery even when no onError hook is set', async () => {
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000, {
      recover: async () => {
        throw new Error('boom');
      },
    });
    failDC(fm);
    await expect(fm.recoverDC('dc-east')).resolves.toBeUndefined();
    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(false);
  });

  it('keeps the legacy no-callback behaviour: a plain state flip still works', async () => {
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000);
    failDC(fm);
    await fm.recoverDC('dc-east');
    expect(fm.getDCHealth().get('dc-east')!.healthy).toBe(true);
  });

  it('ignores pending events for an unknown DC instead of creating a phantom entry', () => {
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000);
    fm.recordPendingEvent('does-not-exist', 9);
    expect(fm.getDCHealth().has('does-not-exist')).toBe(false);
  });

  it('still throws synchronously for an unknown DC on recoverDC', async () => {
    const fm = new CatastrophicFailoverManager(makeTopology(), 1_000);
    await expect(fm.recoverDC('unknown')).rejects.toThrow('not found');
  });
});
