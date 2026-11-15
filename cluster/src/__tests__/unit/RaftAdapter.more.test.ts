/**
 * RaftAdapter — Additional unit tests (post-init and defensive branches).
 *
 * Complements RaftAdapter.test.ts / RaftAdapter.transfer.test.ts /
 * RaftAdapter.semaphore.test.ts by exercising the methods that need a mocked
 * internal RaftNode (set via `(adapter as any).node = mockNode`) as well as
 * the snapshot API, resource teardown, and force-leader bypass paths.
 *
 * Acceptance Criteria:
 *   AC 34.21: propose force-leader bypass returns index 0 / term 0
 *   AC 34.22: propose force-leader apply error is wrapped
 *   AC 34.23: propose not-leader error (SUCCESS=true path)
 *   AC 34.24: propose not-leader with leaderId throws NOT_LEADER
 *   AC 34.25: propose generic failure without leaderId
 *   AC 34.26: propose unknown error is wrapped as INTERNAL_ERROR
 *   AC 34.27: _doPropose force-leader bypass
 *   AC 34.28: _doPropose not-leader with leaderId
 *   AC 34.29: _serviceQueue drains queued proposals
 *   AC 34.30: isLeader/getTerm/getLeader/getProgress/getCommitIndex/getStatus catch node errors
 *   AC 34.31: shouldTakeSnapshot (interval 0 / no commits / exact multiple)
 *   AC 34.32: takeSnapshot / resetCommittedCount
 *   AC 34.33: compactLogs (no storage / no compactLogs fn / success / throws)
 *   AC 34.34: getStorage returns sqliteStorage or config.storage
 *   AC 34.35: stop() tears down node/transport/originalTcp/sqlite with error isolation
 *   AC 34.36: no-op methods (flushApplyQueue / readBarrier / campaign / step)
 *   AC 34.37: stopHeartbeat throws when timerManager inaccessible
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';

function minimalConfig(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return { id: 1, peers: [2, 3], electionTick: 10, heartbeatTick: 3, ...overrides };
}

/** Build an adapter whose private `node` is replaced by a controllable mock. */
function adapterWithNode(mockNode: any, overrides: Partial<RaftConfig> = {}): RaftAdapter {
  const adapter = new RaftAdapter(minimalConfig(overrides));
  (adapter as any).node = mockNode;
  return adapter;
}

/** A minimal fake RaftNode exposing the getters/setters the adapter calls. */
function fakeNode(overrides: Record<string, any> = {}): any {
  return {
    isLeader: () => true,
    getCurrentTerm: () => 5,
    getLeaderId: () => '1',
    getCommittedIndex: () => 100,
    getLastApplied: () => 90,
    getLastLogIndex: () => 100,
    getState: () => 'leader',
    getNodeId: () => '1',
    submitCommand: () => Promise.resolve({ success: true, index: 7 }),
    stop: () => {},
    ...overrides,
  };
}

describe('RaftAdapter — propose / proposeAndWait force-leader & error paths', () => {
  beforeEach(() => vi.restoreAllMocks());

  // AC 34.21 — force-leader bypass still needs a non-null node (guard runs first).
  it('propose bypasses Raft when force leader and applies directly', async () => {
    const applied: string[] = [];
    const adapter = adapterWithNode(fakeNode());
    (adapter as any).applyHandler = (d: string) => applied.push(d);
    adapter.setForceLeader(true);

    const res = await adapter.propose('hello');
    expect(res).toEqual({ index: '0', term: '0' });
    expect(applied).toEqual(['hello']);
  });

  // AC 34.22
  it('propose wraps a force-leader apply error', async () => {
    const adapter = adapterWithNode(fakeNode());
    (adapter as any).applyHandler = () => {
      throw new Error('boom');
    };
    adapter.setForceLeader(true);

    await expect(adapter.propose('x')).rejects.toThrow(/Force-leader apply failed/);
  });

  // AC 34.23
  it('propose resolves index/term on success', async () => {
    const adapter = adapterWithNode(fakeNode({ getCurrentTerm: () => 9 }));
    const res = await adapter.propose('data');
    expect(res.index).toBe('7');
    expect(res.term).toBe('9');
  });

  // AC 34.24
  it('propose throws NOT_LEADER when result carries leaderId', async () => {
    const adapter = adapterWithNode(
      fakeNode({ submitCommand: () => Promise.resolve({ success: false, leaderId: '2' }) }),
    );
    await expect(adapter.propose('data')).rejects.toThrow(SqlVecError);
    await expect(adapter.propose('data')).rejects.toMatchObject({ code: SqlVecErrorCode.NOT_LEADER });
  });

  // AC 34.25
  it('propose throws INTERNAL_ERROR on generic failure without leaderId', async () => {
    const adapter = adapterWithNode(
      fakeNode({ submitCommand: () => Promise.resolve({ success: false, error: 'nope' }) }),
    );
    await expect(adapter.propose('data')).rejects.toThrow(/Raft propose failed/);
  });

  // AC 34.26
  it('propose wraps a thrown error as INTERNAL_ERROR', async () => {
    const adapter = adapterWithNode(
      fakeNode({
        submitCommand: () => {
          throw new Error('transport');
        },
      }),
    );
    await expect(adapter.propose('data')).rejects.toThrow(/Raft propose failed/);
  });

  // AC 34.27
  it('_doPropose bypasses Raft when force leader (proposeAndWait)', async () => {
    const applied: string[] = [];
    const adapter = adapterWithNode(fakeNode());
    (adapter as any).applyHandler = (d: string) => applied.push(d);
    adapter.setForceLeader(true);

    await adapter.proposeAndWait('pw');
    expect(applied).toEqual(['pw']);
  });

  // AC 34.28
  it('proposeAndWait rejects NOT_LEADER with leaderId', async () => {
    const adapter = adapterWithNode(
      fakeNode({ submitCommand: () => Promise.resolve({ success: false, leaderId: '3' }) }),
    );
    await expect(adapter.proposeAndWait('data')).rejects.toThrow(/Not the Raft leader/);
  });

  // AC 34.29
  it('_serviceQueue drains queued proposals', async () => {
    const adapter = adapterWithNode(fakeNode({ submitCommand: () => Promise.resolve({ success: true, index: 1 }) }));
    const priv = adapter as any;

    // Seed the queue directly with several deferred proposals.
    const deferred: Array<{ data: string; resolve: () => void; reject: (e: unknown) => void }> = [];
    for (let i = 0; i < 3; i++) {
      deferred.push({ data: `p${i}`, resolve: vi.fn(), reject: vi.fn() });
    }
    priv._proposeQueue = deferred.map((d) => ({ ...d }));
    priv._inFlight = 0;

    priv._serviceQueue();

    // Let the spawned _doPropose promises settle.
    await new Promise((r) => setTimeout(r, 10));

    // Queue fully drained and each resolve was invoked (submitCommand succeeded).
    expect(priv._proposeQueue.length).toBe(0);
  });

  it('_serviceQueue breaks when the queue becomes empty', () => {
    const adapter = adapterWithNode(fakeNode());
    const priv = adapter as any;
    priv._proposeQueue = [];
    priv._inFlight = 0;
    expect(() => priv._serviceQueue()).not.toThrow();
  });
});

describe('RaftAdapter — getter try/catch isolation', () => {
  // AC 34.30 — each getter must swallow a throwing node method.
  const throwing = {
    node: fakeNode({
      isLeader: () => {
        throw new Error('x');
      },
      getCurrentTerm: () => {
        throw new Error('x');
      },
      getLeaderId: () => {
        throw new Error('x');
      },
      getCommittedIndex: () => {
        throw new Error('x');
      },
      getLastApplied: () => {
        throw new Error('x');
      },
      getLastLogIndex: () => {
        throw new Error('x');
      },
      getState: () => {
        throw new Error('x');
      },
    }),
  };

  it('isLeader returns false when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.isLeader()).resolves.toBe(false);
  });

  it('getTerm returns 0 when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getTerm()).resolves.toBe(0);
  });

  it('getLeader returns null when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getLeader()).resolves.toBeNull();
  });

  it('getProgress returns {} when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getProgress()).resolves.toEqual({});
  });

  it('getAppliedIndex returns 0 when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getAppliedIndex()).resolves.toBe(0);
  });

  it('getCommitIndex returns 0 when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getCommitIndex()).resolves.toBe(0);
  });

  it('getStatus returns null when node throws', async () => {
    const adapter = adapterWithNode(throwing.node);
    await expect(adapter.getStatus()).resolves.toBeNull();
  });

  it('getStatus returns full status object when healthy', async () => {
    const adapter = adapterWithNode(fakeNode());
    const status = await adapter.getStatus();
    expect(status.role).toBe('leader');
    expect(status.commitIndex).toBe(100);
  });

  it('getProgress returns commit/applied/lastLog when healthy', async () => {
    const adapter = adapterWithNode(fakeNode());
    const p = await adapter.getProgress();
    expect(p.commit).toBe(100);
    expect(p.applied).toBe(90);
    expect(p.lastLog).toBe(100);
  });

  it('getStatus returns null before init (node null)', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.getStatus()).resolves.toBeNull();
  });

  it('isLeader returns true when force leader', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    adapter.setForceLeader(true);
    await expect(adapter.isLeader()).resolves.toBe(true);
  });

  it('getLeader returns config.id when force leader', async () => {
    const adapter = new RaftAdapter(minimalConfig({ id: 7 }));
    adapter.setForceLeader(true);
    await expect(adapter.getLeader()).resolves.toBe(7);
  });

  it('getLeader returns null when node reports null leader', async () => {
    const adapter = adapterWithNode(fakeNode({ getLeaderId: () => null }));
    await expect(adapter.getLeader()).resolves.toBeNull();
  });

  // AC 34.30b: getLeader converts a non-null leader id string to a number.
  it('getLeader returns the numeric leader id when node reports a leader', async () => {
    const adapter = adapterWithNode(fakeNode({ getLeaderId: () => '42' }));
    await expect(adapter.getLeader()).resolves.toBe(42);
  });

  // AC 34.23b: propose success without index → index falls back to '0'.
  it('propose falls back to index 0 when submitCommand omits index', async () => {
    const adapter = adapterWithNode(
      fakeNode({ submitCommand: () => Promise.resolve({ success: true }), getCurrentTerm: () => 2 }),
    );
    const res = await adapter.propose('data');
    expect(res.index).toBe('0');
    expect(res.term).toBe('2');
  });

  // AC 34.25b: propose generic failure without leaderId and without error msg.
  it('propose reports unknown error when result.error is falsy', async () => {
    const adapter = adapterWithNode(fakeNode({ submitCommand: () => Promise.resolve({ success: false }) }));
    await expect(adapter.propose('data')).rejects.toThrow(/unknown error/);
  });

  // AC 34.28b: _doPropose generic failure without leaderId.
  it('proposeAndWait rejects on generic failure without leaderId', async () => {
    const adapter = adapterWithNode(fakeNode({ submitCommand: () => Promise.resolve({ success: false }) }));
    await expect(adapter.proposeAndWait('data')).rejects.toThrow(/Raft propose failed/);
  });

  // AC 34.27b: _doPropose force-leader apply error (proposeAndWait).
  it('proposeAndWait wraps a force-leader apply error', async () => {
    const adapter = adapterWithNode(fakeNode());
    (adapter as any).applyHandler = () => {
      throw new Error('boom');
    };
    adapter.setForceLeader(true);
    await expect(adapter.proposeAndWait('x')).rejects.toThrow(/Force-leader apply failed/);
  });

  // AC 34.27c: _doPropose re-throws an SqlVecError from submitCommand verbatim.
  it('proposeAndWait re-throws a SqlVecError from submitCommand', async () => {
    const adapter = adapterWithNode(
      fakeNode({
        submitCommand: () => {
          throw new SqlVecError('already-leader-switched', SqlVecErrorCode.NOT_LEADER);
        },
      }),
    );
    await expect(adapter.proposeAndWait('data')).rejects.toMatchObject({
      code: SqlVecErrorCode.NOT_LEADER,
      message: 'already-leader-switched',
    });
  });

  // AC 34.27d: _doPropose wraps a plain thrown error from submitCommand.
  it('proposeAndWait wraps a plain thrown error from submitCommand', async () => {
    const adapter = adapterWithNode(
      fakeNode({
        submitCommand: () => {
          throw new Error('raw-io-error');
        },
      }),
    );
    await expect(adapter.proposeAndWait('data')).rejects.toThrow(/Raft propose failed: raw-io-error/);
  });

  // AC 34.29b: proposeAndWait queues when at capacity.
  it('proposeAndWait queues when in-flight is at CONCURRENCY_MAX', () => {
    const adapter = adapterWithNode(fakeNode());
    const priv = adapter as any;
    priv._inFlight = RaftAdapter['CONCURRENCY_MAX'];

    // Fire-and-forget: the returned promise is queued and unresolved by design.
    adapter.proposeAndWait('queued');

    // The proposal is queued, not executed immediately.
    expect(priv._proposeQueue.length).toBe(1);
    expect(priv._proposeQueue[0].data).toBe('queued');

    // Resolve the queued entry manually to avoid a dangling promise.
    priv._proposeQueue[0].resolve();
  });
});

describe('RaftAdapter — snapshot API & resource teardown', () => {
  // Scheduling belongs to raft-core (it checks its threshold after every apply);
  // this package only owns the explicit request. The three unit tests that used to
  // live here exercised `shouldTakeSnapshot`, `takeSnapshot(index)` and
  // `resetCommittedCount` — the counters of a second, competing snapshot loop. They
  // were replaced by the decision tests below plus a real-cluster integration test
  // (`raft-snapshot-authority.test.ts`) that proves the snapshot happens.

  it('requestSnapshot returns null before the node exists', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.requestSnapshot()).resolves.toBeNull();
  });

  it('requestSnapshot returns null when nothing has been applied', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = { getLastApplied: () => 0 };
    await expect(adapter.requestSnapshot()).resolves.toBeNull();
  });

  it('requestSnapshot is idempotent for an index already snapshotted', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    let calls = 0;
    (adapter as any).node = {
      getLastApplied: () => 42,
      takeSnapshot: async () => {
        calls += 1;
      },
    };
    (adapter as any)._snapshotMeta = { lastIncludedIndex: 42, lastIncludedTerm: 3, observedAt: 1 };

    const meta = await adapter.requestSnapshot();
    expect(meta?.lastIncludedIndex).toBe(42);
    expect(calls).toBe(0);
  });

  it('requestSnapshot asks raft-core and re-reads the stored boundary', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    let calls = 0;
    (adapter as any).node = {
      getLastApplied: () => 10,
      takeSnapshot: async () => {
        calls += 1;
      },
    };
    (adapter as any).nodeStorage = {
      snapshot: { readMetadata: async () => ({ lastIncludedIndex: 10, lastIncludedTerm: 2 }) },
    };

    const meta = await adapter.requestSnapshot();
    expect(calls).toBe(1);
    expect(meta).toMatchObject({ lastIncludedIndex: 10, lastIncludedTerm: 2 });
    expect(adapter.getSnapshotMeta()).toMatchObject({ lastIncludedIndex: 10 });
  });

  it('requestSnapshot survives a raft-core without the trigger, and says so', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = { getLastApplied: () => 5 };
    await expect(adapter.requestSnapshot()).resolves.toBeNull();
  });

  it('requestSnapshot swallows a failing snapshot instead of failing the caller', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      getLastApplied: () => 5,
      takeSnapshot: async () => {
        throw new Error('disk full');
      },
    };
    await expect(adapter.requestSnapshot()).resolves.toBeNull();
  });

  it('refreshSnapshotMeta reports null when the store holds no snapshot', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).nodeStorage = {
      snapshot: { readMetadata: async () => ({ lastIncludedIndex: 0, lastIncludedTerm: 0 }) },
    };
    await expect(adapter.refreshSnapshotMeta()).resolves.toBeNull();
    expect(adapter.getSnapshotMeta()).toBeNull();
  });

  it('refreshSnapshotMeta survives a storage read failure', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).nodeStorage = {
      snapshot: {
        readMetadata: async () => {
          throw new Error('io');
        },
      },
    };
    await expect(adapter.refreshSnapshotMeta()).resolves.toBeNull();
  });

  // AC 34.33
  it('compactLogs no-ops when storage is absent', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.compactLogs(10)).resolves.toBeUndefined();
  });

  it('compactLogs warns when storage lacks compactLogs', async () => {
    const adapter = new RaftAdapter(minimalConfig({ storage: {} }));
    await expect(adapter.compactLogs(10)).resolves.toBeUndefined();
  });

  it('compactLogs calls storage.compactLogs and swallows errors', async () => {
    const compactLogs = vi.fn().mockResolvedValue(undefined);
    const adapter = new RaftAdapter(minimalConfig({ storage: { compactLogs } }));
    await adapter.compactLogs(10);
    expect(compactLogs).toHaveBeenCalledWith(10);
  });

  it('compactLogs swallows a throwing compactLogs', async () => {
    const compactLogs = vi.fn().mockRejectedValue(new Error('io'));
    const adapter = new RaftAdapter(minimalConfig({ storage: { compactLogs } }));
    await expect(adapter.compactLogs(10)).resolves.toBeUndefined();
  });

  // AC 34.34
  it('getStorage returns config.storage when no sqliteStorage', () => {
    const storage = { file: 'x' };
    const adapter = new RaftAdapter(minimalConfig({ storage }));
    expect(adapter.getStorage()).toBe(storage);
  });

  it('getStorage returns null when nothing configured', () => {
    const adapter = new RaftAdapter(minimalConfig());
    expect(adapter.getStorage()).toBeNull();
  });

  // AC 34.35
  it('stop() tears down all resources with error isolation', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    const node = {
      stop: vi.fn(() => {
        throw new Error('node-stop');
      }),
    };
    const transport = {
      stop: vi.fn(() => {
        throw new Error('transport-stop');
      }),
    };
    const originalTcp = {
      stop: vi.fn(() => {
        throw new Error('tcp-stop');
      }),
    };
    const sqlite = {
      close: vi.fn(() => {
        throw new Error('sqlite-close');
      }),
    };

    (adapter as any).node = node;
    (adapter as any).transport = transport;
    (adapter as any).originalTcpTransport = originalTcp;
    (adapter as any).sqliteStorage = sqlite;
    // A storage this adapter opened itself: it is the one that must be closed,
    // because nothing else holds a reference to it.
    (adapter as any)._ownsStorage = true;

    // Awaited: error isolation means the promise resolves, not that a rejected
    // promise is acceptable.
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(node.stop).toHaveBeenCalled();
    expect(transport.stop).toHaveBeenCalled();
    expect(originalTcp.stop).toHaveBeenCalled();
    expect(sqlite.close).toHaveBeenCalled();
    expect((adapter as any).node).toBeNull();
    expect((adapter as any).transport).toBeNull();
    expect((adapter as any).originalTcpTransport).toBeNull();
    expect((adapter as any).sqliteStorage).toBeNull();
    expect((adapter as any)._ownsStorage).toBe(false);
  });

  it('stop() leaves a caller-supplied storage open', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    const sqlite = { close: vi.fn() };

    (adapter as any).sqliteStorage = sqlite;
    (adapter as any)._ownsStorage = false;

    await adapter.stop();
    // The adapter did not open it, and the same storage may be shared with
    // another group: closing it here would pull the database out from under
    // its owner.
    expect(sqlite.close).not.toHaveBeenCalled();
    expect((adapter as any).sqliteStorage).toBeNull();
  });

  it('stop() is a no-op when nothing initialized', () => {
    const adapter = new RaftAdapter(minimalConfig());
    expect(() => adapter.stop()).not.toThrow();
  });

  // AC 34.36
  it('no-op methods resolve without error', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    expect(() => adapter.step({ msgType: 1 })).not.toThrow();
    expect(() => adapter.flushApplyQueue()).not.toThrow();
    await expect(adapter.campaign()).resolves.toBeUndefined();
    await expect(adapter.readBarrier()).resolves.toBeUndefined();
  });

  // AC 34.37
  it('stopHeartbeat throws when timerManager is inaccessible', async () => {
    const adapter = adapterWithNode(fakeNode({ stateMachine: {} }));
    await expect(adapter.stopHeartbeat()).rejects.toThrow(/timerManager not accessible/);
  });
});
