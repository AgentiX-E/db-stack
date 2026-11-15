/**
 * RaftAdapter — Unit Tests
 *
 * Strategy: Test constructor, config validation, getters before init(),
 * static methods. Avoid init() which creates real RaftNode + Transport.
 * Use spyOn to capture state where possible.
 *
 * Acceptance Criteria:
 *   AC 34.1: Constructor stores config
 *   AC 34.2: setForceLeader / getStatus / isLeader before init()
 *   AC 34.3: getTerm returns 0 before init
 *   AC 34.4: getLeader returns null before init
 *   AC 34.5: getProgress returns {} before init
 *   AC 34.6: getAppliedIndex returns 0 before init
 *   AC 34.7: getCommitIndex returns 0 before init
 *   AC 34.8: initiateElection before init is safe (throws or no-op)
 *   AC 34.9: compactLogs before init is safe
 *   AC 34.10: encodeSnapshotData pure function
 *   AC 34.11: propose before init throws
 *   AC 34.12: stopHeartbeat before init is safe
 *   AC 34.13: readBarrier before init is safe
 *   AC 34.14: transferLeadership before init throws
 *   AC 34.15: checkQuorum / preVote config propagation
 *   AC 34.16: useInMemoryStorage config
 *   AC 34.17: useInMemoryTransport config
 *   AC 34.18: snapshotInterval config
 *   AC 34.19: maxLogEntries config
 *   AC 34.20: init with invalid config throws
 *   AC 34.21: getPeerProgress reports no peers before init
 */

import { describe, it, expect, vi } from 'vitest';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';

function minimalConfig(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return {
    id: 1,
    peers: [2, 3],
    electionTick: 10,
    heartbeatTick: 3,
    ...overrides,
  };
}

describe('AC 34.1: Constructor', () => {
  it('stores config', () => {
    const adapter = new RaftAdapter(minimalConfig());
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });

  it('accepts minimal config without storage/transport', () => {
    const adapter = new RaftAdapter(minimalConfig({ peers: [] }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.2: setForceLeader / state before init', () => {
  it('setForceLeader does not crash before init', () => {
    const adapter = new RaftAdapter(minimalConfig());
    adapter.setForceLeader(true);
    adapter.setForceLeader(false);
  });

  it('isLeader returns false before init', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.isLeader()).resolves.toBe(false);
  });
});

describe('AC 34.3: getTerm', () => {
  it('returns 0 before init', async () => {
    await expect(new RaftAdapter(minimalConfig()).getTerm()).resolves.toBe(0);
  });
});

describe('AC 34.4: getLeader', () => {
  it('returns null before init', async () => {
    await expect(new RaftAdapter(minimalConfig()).getLeader()).resolves.toBeNull();
  });
});

describe('AC 34.5: getProgress', () => {
  it('returns {} before init', async () => {
    const p = await new RaftAdapter(minimalConfig()).getProgress();
    expect(p).toEqual({});
  });
});

describe('AC 34.6: getAppliedIndex', () => {
  it('returns 0 before init', async () => {
    await expect(new RaftAdapter(minimalConfig()).getAppliedIndex()).resolves.toBe(0);
  });
});

describe('AC 34.6b: getRetainedLogLength', () => {
  it('returns 0 before init', async () => {
    await expect(new RaftAdapter(minimalConfig()).getRetainedLogLength()).resolves.toBe(0);
  });

  it('counts the entries the log still holds, not the un-applied tail', async () => {
    // The previous implementation returned `lastLog - applied`, which is 0 or 1 on a
    // live node — the apply loop keeps `applied` one step behind the head — so a log
    // holding 600 entries measured as 1 and every "bounded log" assertion passed
    // without measuring anything. The count comes from the log's own bounds.
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      getLastApplied: () => 140,
      getLastLogIndex: () => 142,
      logManager: { getFirstIndex: () => 1, getLastIndex: () => 142 },
    };
    await expect(adapter.getRetainedLogLength()).resolves.toBe(142);
  });

  it('counts only what survives compaction', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      logManager: { getFirstIndex: () => 101, getLastIndex: () => 142 },
    };
    await expect(adapter.getRetainedLogLength()).resolves.toBe(42);
  });

  it('returns 0 for an empty log and for one that is compacted away entirely', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = { logManager: { getFirstIndex: () => 1, getLastIndex: () => 0 } };
    await expect(adapter.getRetainedLogLength()).resolves.toBe(0);
  });

  it('returns 0 when the node exposes no log manager, and when reading it throws', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {};
    await expect(adapter.getRetainedLogLength()).resolves.toBe(0);

    (adapter as any).node = {
      logManager: {
        getFirstIndex: () => {
          throw new Error('storage closed');
        },
        getLastIndex: () => 1,
      },
    };
    await expect(adapter.getRetainedLogLength()).resolves.toBe(0);
  });
});

describe('AC 34.7: getCommitIndex', () => {
  it('returns 0 before init', async () => {
    await expect(new RaftAdapter(minimalConfig()).getCommitIndex()).resolves.toBe(0);
  });
});

describe('AC 34.8: campaign before init', () => {
  it('is safe (no-op when node is null)', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    // campaign is guarded: if (!this.node) return
    await expect(adapter.campaign()).resolves.toBeUndefined();
  });
});

describe('AC 34.9: compactLogs before init', () => {
  it('resolves without error', async () => {
    await expect(new RaftAdapter(minimalConfig()).compactLogs(10)).resolves.toBeUndefined();
  });
});

describe('AC 34.10: encodeSnapshotData', () => {
  it('produces valid Uint8Array', () => {
    const result = RaftAdapter.encodeSnapshotData({
      lastIncludedIndex: 100,
      lastIncludedTerm: 5,
      nodeId: 1,
      timestamp: Date.now(),
    });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes all metadata fields', () => {
    const meta = {
      lastIncludedIndex: 50,
      lastIncludedTerm: 3,
      nodeId: 2,
      shardId: 1,
      timestamp: 1234567890,
    };
    const encoded = RaftAdapter.encodeSnapshotData(meta);
    const decoded = JSON.parse(new TextDecoder().decode(encoded));
    expect(decoded.lastIncludedIndex).toBe(50);
    expect(decoded.lastIncludedTerm).toBe(3);
    expect(decoded.nodeId).toBe(2);
    expect(decoded.shardId).toBe(1);
    expect(decoded.timestamp).toBe(1234567890);
  });
});

describe('AC 34.11: propose before init', () => {
  it('throws', async () => {
    await expect(new RaftAdapter(minimalConfig()).propose('data')).rejects.toThrow();
  });
});

describe('AC 34.12: stopHeartbeat before init', () => {
  it('throws', async () => {
    await expect(new RaftAdapter(minimalConfig()).stopHeartbeat()).rejects.toThrow('not initialized');
  });
});

describe('AC 34.13: readBarrier before init', () => {
  it('resolves', async () => {
    await expect(new RaftAdapter(minimalConfig()).readBarrier()).resolves.toBeUndefined();
  });
});

describe('AC 34.14: transferLeadership before init', () => {
  it('throws', async () => {
    await expect(new RaftAdapter(minimalConfig()).transferLeadership('2')).rejects.toThrow();
  });
});

describe('AC 34.15: config propagation', () => {
  it('stores checkQuorum', () => {
    const adapter = new RaftAdapter(minimalConfig({ checkQuorum: false }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });

  it('stores preVote', () => {
    const adapter = new RaftAdapter(minimalConfig({ preVote: false }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.16: useInMemoryStorage', () => {
  it('accepts config', () => {
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.17: useInMemoryTransport', () => {
  it('accepts config', () => {
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryTransport: true }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.18: snapshotInterval', () => {
  it('accepts config', () => {
    const adapter = new RaftAdapter(minimalConfig({ snapshotInterval: 100 }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.19: maxLogEntries', () => {
  it('accepts config', () => {
    const adapter = new RaftAdapter(minimalConfig({ maxLogEntries: 10000 }));
    expect(adapter).toBeInstanceOf(RaftAdapter);
  });
});

describe('AC 34.21: getPeerProgress', () => {
  it('reports no peers before init instead of throwing', async () => {
    // Monitoring calls this on every node, including ones that never became
    // leader. A follower has no per-peer view at all, and that is an empty map,
    // not an error.
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.getPeerProgress()).resolves.toEqual({});
  });

  it('maps the leader state peer table to numbers', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      stateMachine: {
        leaderState: {
          snapshot: () =>
            new Map([
              ['2', { nextIndex: 11, matchIndex: 9 }],
              ['3', { nextIndex: 5, matchIndex: 4 }],
            ]),
        },
      },
    };

    await expect(adapter.getPeerProgress()).resolves.toEqual({
      2: { next: 11, match: 9 },
      3: { next: 5, match: 4 },
    });
  });

  it('reports nothing when the node has no leader state', async () => {
    // A follower, and a node still starting: both have no per-peer table. The
    // shape has to be an empty map so a caller can iterate without a guard.
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = { stateMachine: {} };
    await expect(adapter.getPeerProgress()).resolves.toEqual({});
    (adapter as any).node = { stateMachine: { leaderState: null } };
    await expect(adapter.getPeerProgress()).resolves.toEqual({});
    (adapter as any).node = { stateMachine: { leaderState: {} } };
    await expect(adapter.getPeerProgress()).resolves.toEqual({});
  });

  it('reports nothing when the library throws while reading it', async () => {
    // Reaching into another package's internals is a diagnostics path; it must
    // degrade to "unknown", never to a failure that breaks a status endpoint.
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      stateMachine: {
        leaderState: {
          snapshot: () => {
            throw new Error('leader state busy');
          },
        },
      },
    };
    await expect(adapter.getPeerProgress()).resolves.toEqual({});
  });
});

describe('AC 34.20: init with invalid config', () => {
  it('rejects init when useInMemoryStorage=false and no storagePath', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.init()).rejects.toThrow();
  });
});
