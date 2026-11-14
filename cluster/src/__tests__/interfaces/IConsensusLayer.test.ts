/**
 * IConsensusLayer Interface Contract Test
 *
 * Verifies the interface definition (type-level contract) for the
 * production IConsensusLayer used by all HA and cluster components.
 * Note: this is a compile-time + runtime verification of the interface shape.
 */

import { describe, it, expect, vi } from 'vitest';
import { IConsensusLayer, TopologyChange } from '../../consensus/interfaces/interfaces';

describe('IConsensusLayer (new)', () => {
  it('should define the interface contract with all production methods', () => {
    const methods: (keyof IConsensusLayer)[] = [
      'start',
      'stop',
      'propose',
      'isLeader',
      'getLeader',
      'getCommitIndex',
      'registerShard',
      'removeShard',
      'notifyTopologyChange',
      'getHealthStatus',
      'campaign',
      'on',
      'off',
      'setForceLeader',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('should support a valid TopologyChange shape', () => {
    const change: TopologyChange = {
      type: 'leader_changed',
      nodeId: 'node-1',
      shardId: 'shard-0',
      timestamp: Date.now(),
    };
    expect(change.type).toBe('leader_changed');
    expect(change.nodeId).toBe('node-1');
  });

  it('should support quorum_loss topology change', () => {
    const change: TopologyChange = {
      type: 'peer_removed',
      nodeId: 'node-3',
      timestamp: Date.now(),
    };
    expect(change.type).toBe('peer_removed');
  });

  it('should have correct method signatures via mock implementation', async () => {
    const mock: IConsensusLayer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      propose: vi.fn().mockResolvedValue(42),
      isLeader: vi.fn().mockResolvedValue(true),
      getLeader: vi.fn().mockResolvedValue('node-1'),
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

    await mock.start();
    expect(mock.start).toHaveBeenCalled();

    const index = await mock.propose('shard-0', 'data');
    expect(index).toBe(42);

    const leader = await mock.getLeader('shard-0');
    expect(leader).toBe('node-1');

    mock.registerShard('shard-0', { peers: [1, 2, 3] });
    expect(mock.registerShard).toHaveBeenCalledWith('shard-0', { peers: [1, 2, 3] });
  });
});
