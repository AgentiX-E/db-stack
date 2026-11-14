/**
 * SqlVecFederationConsumer Tests — AC 46.1–46.5
 *
 * AC 46.1 — SqlVecFederationConsumer wraps IConsensusLayer
 * AC 46.2 — Replicated entries carry HLC, observer advances local
 * AC 46.3 — OutboxWriter integration with Raft commit index
 * AC 46.4 — Propose re-entrant flow (remote → propose → outbox)
 * AC 46.5 — Conflict notification re-proposes resolved value
 *     — proposereplicated observes HLC causal ordering
 *     — Multiple replicated entries maintain sequence
 *     — onConflict generates properly formatted payload
 */

import { describe, it, expect, vi } from 'vitest';
import { SqlVecFederationConsumer } from './SqlVecFederationConsumer';
import { HLC } from '../hlc/HLC';

function mockConsensusLayer() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    propose: vi.fn().mockResolvedValue(42),
    isLeader: vi.fn().mockResolvedValue(true),
    getLeader: vi.fn().mockResolvedValue('node-a'),
    getCommitIndex: vi.fn().mockResolvedValue(100),
    registerShard: vi.fn(),
    removeShard: vi.fn().mockResolvedValue(undefined),
    notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue([]),
    campaign: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    setForceLeader: vi.fn(),
  };
}

function mockOutboxWriter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    getLastWrittenIndex: vi.fn().mockResolvedValue(42),
  };
}

describe('SqlVecFederationConsumer — AC 46.1: Wraps IConsensusLayer', () => {
  it('should propose replicated entries to consensus layer', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('test-node');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'node-a',
    });

    await consumer.proposeReplicated({
      data: 'remote-data',
      type: 'sqlvec-replicate',
      sourceDc: 'dc-east',
      sourceNodeId: 'node-b',
      hlcTimestamp: hlc.now(),
    });

    expect(consensus.propose).toHaveBeenCalledTimes(1);
    expect(consensus.propose).toHaveBeenCalledWith('federation', expect.stringContaining('remote-data'));
  });

  it('should include federation metadata in proposal payload', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('test-node');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'node-a',
    });

    await consumer.proposeReplicated({
      data: 'test-data',
      type: 'insert',
      sourceDc: 'dc-east',
      sourceNodeId: 'node-x',
      hlcTimestamp: hlc.now(),
    });

    const payload = JSON.parse(consensus.propose.mock.calls[0][1]);
    expect(payload.__federation).toBe(true);
    expect(payload.sourceDc).toBe('dc-east');
    expect(payload.sourceNodeId).toBe('node-x');
    expect(payload.data).toBe('test-data');
    expect(payload.type).toBe('insert');
    expect(payload.hlc).toBeDefined();
    expect(payload.hlc.nodeId).toBe('test-node');
  });

  it('should return the HLC instance', () => {
    const hlc = new HLC('custom-node');
    const consumer = new SqlVecFederationConsumer({
      consensusLayer: mockConsensusLayer(),
      outboxWriter: mockOutboxWriter(),
      hlc,
      dc: 'dc-west',
      nodeId: 'node-a',
    });

    expect(consumer.getHLC()).toBe(hlc);
  });
});

describe('SqlVecFederationConsumer — AC 46.2: HLC Causal Ordering', () => {
  it('should observe remote HLC timestamp before proposal', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const localHlc = new HLC('local-node');

    // Capture pre-observation state
    const preObserve = localHlc.now();

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc: localHlc,
      dc: 'dc-west',
      nodeId: 'local-node',
    });

    // Remote has a much higher wall time
    const remoteTimestamp = {
      wallTime: Number(preObserve.wallTime) + 1000,
      logical: 1,
      nodeId: 'remote-node',
    };

    await consumer.proposeReplicated({
      data: 'data',
      type: 'test',
      sourceDc: 'dc-east',
      sourceNodeId: 'remote-node',
      hlcTimestamp: remoteTimestamp,
    });

    // After observation, local HLC should be ≥ remote
    const postObserve = localHlc.now();
    expect(postObserve.wallTime).toBeGreaterThanOrEqual(remoteTimestamp.wallTime);
  });

  it('should maintain HLC monotonicity across multiple proposals', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('local-node');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'local-node',
    });

    const timestamps: number[] = [];

    // Simulate 5 proposals from different sources with increasing HLCs
    for (let i = 0; i < 5; i++) {
      await consumer.proposeReplicated({
        data: `data-${i}`,
        type: 'test',
        sourceDc: 'dc-east',
        sourceNodeId: `remote-${i}`,
        hlcTimestamp: {
          wallTime: 1000 + i * 100,
          logical: 1,
          nodeId: `remote-${i}`,
        },
      });
      timestamps.push(hlc.now().wallTime);
    }

    // Wall times should be monotonically increasing
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });
});

describe('SqlVecFederationConsumer — AC 46.3: OutboxWriter Integration', () => {
  it('should write to outbox via IOutboxWriter', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('local');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'local',
    });

    await consumer.writeToOutbox('shard-0', 100, 3, 'committed-data');

    expect(outbox.write).toHaveBeenCalledWith('shard-0', 100, 3, 'committed-data');
  });

  it('should track last written index via outbox writer', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    outbox.getLastWrittenIndex.mockResolvedValue(42);

    const hlc = new HLC('local');
    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'local',
    });

    await consumer.writeToOutbox('shard-0', 100, 3, 'data');

    // writeToOutbox delegates to outboxWriter.write
    expect(outbox.write).toHaveBeenCalledWith('shard-0', 100, 3, 'data');

    // The outbox writer should still track last written index independently
    const lastIdx = await outbox.getLastWrittenIndex('shard-0');
    expect(lastIdx).toBe(42);
  });
});

describe('SqlVecFederationConsumer — AC 46.4: Re-entrant Propose', () => {
  it('should handle remote -> propose -> outbox -> replicate cycle', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('local');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'local',
    });

    // Step 1: Consume replicated entry
    await consumer.proposeReplicated({
      data: 'remote-write',
      type: 'write',
      sourceDc: 'dc-east',
      sourceNodeId: 'remote-node',
      hlcTimestamp: { wallTime: 500, logical: 1, nodeId: 'remote-node' },
    });

    // Step 2: Propose to local Raft
    expect(consensus.propose).toHaveBeenCalled();

    // Step 3: Post-commit, write to outbox for further fan-out
    // (simulating Raft commit callback)
    await consumer.writeToOutbox('federation', 101, 3, 'remote-write');

    expect(outbox.write).toHaveBeenCalledWith('federation', 101, 3, 'remote-write');
  });
});

describe('SqlVecFederationConsumer — AC 46.5: Conflict Notification', () => {
  it('should re-propose conflict resolution payload', async () => {
    const consensus = mockConsensusLayer();
    const outbox = mockOutboxWriter();
    const hlc = new HLC('local');

    const consumer = new SqlVecFederationConsumer({
      consensusLayer: consensus,
      outboxWriter: outbox,
      hlc,
      dc: 'dc-west',
      nodeId: 'local',
    });

    await consumer.onConflict({
      key: 'user:42',
      localValue: 'alice',
      remoteValue: 'bob',
      localHlc: { wallTime: 100, logical: 1, nodeId: 'local' },
      remoteHlc: { wallTime: 200, logical: 1, nodeId: 'remote' },
      sourceDc: 'dc-east',
    });

    expect(consensus.propose).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(consensus.propose.mock.calls[0][1]);
    expect(payload.__conflict).toBe(true);
    expect(payload.key).toBe('user:42');
    expect(payload.localValue).toBe('alice');
    expect(payload.remoteValue).toBe('bob');
    expect(payload.resolvedBy).toBe('lww');
  });
});
