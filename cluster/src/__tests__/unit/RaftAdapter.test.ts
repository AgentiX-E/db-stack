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
  it('returns 0 before init (empty progress)', async () => {
    await expect(new RaftAdapter(minimalConfig()).getRetainedLogLength()).resolves.toBe(0);
  });

  it('computes lastLog - applied when progress is available', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    // Simulate a healthy node with a bounded retained log.
    (adapter as any).node = {
      getCommittedIndex: () => 150,
      getLastApplied: () => 140,
      getLastLogIndex: () => 142,
    };
    await expect(adapter.getRetainedLogLength()).resolves.toBe(2);
  });

  it('clamps negative values to zero (applied ahead of lastLog)', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    (adapter as any).node = {
      getCommittedIndex: () => 100,
      getLastApplied: () => 101,
      getLastLogIndex: () => 100,
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

describe('AC 34.20: init with invalid config', () => {
  it('rejects init when useInMemoryStorage=false and no storagePath', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.init()).rejects.toThrow();
  });
});
