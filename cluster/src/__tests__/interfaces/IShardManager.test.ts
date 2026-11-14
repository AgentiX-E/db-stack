import { describe, it, expect, vi } from 'vitest';
import { IShardManager } from '../../interfaces/shard/IShardManager';
import { IShardStrategy } from '../../interfaces/shard/IShardStrategy';

describe('IShardManager', () => {
  it('should define the interface contract', () => {
    const methods: (keyof IShardManager)[] = [
      'initialize',
      'getStrategy',
      'listShards',
      'getShardNodes',
      'getShardForKey',
      'assignShard',
      'removeShard',
      'rebalance',
      'addNode',
      'removeNode',
      'getDistribution',
      'onShardAssigned',
      'onShardRemoved',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('mock shard manager should implement interface', () => {
    const mock: IShardManager = {
      initialize: vi.fn().mockResolvedValue({ success: true }),
      getStrategy: vi.fn().mockReturnValue({ name: 'hash' } as unknown as IShardStrategy),
      listShards: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getShardNodes: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getShardForKey: vi.fn().mockResolvedValue({ success: true, data: 'shard-0' }),
      assignShard: vi.fn().mockResolvedValue({ success: true }),
      removeShard: vi.fn().mockResolvedValue({ success: true }),
      rebalance: vi.fn().mockResolvedValue({ success: true }),
      addNode: vi.fn().mockResolvedValue({ success: true }),
      removeNode: vi.fn().mockResolvedValue({ success: true }),
      getDistribution: vi.fn().mockResolvedValue({ success: true, data: {} }),
      onShardAssigned: vi.fn(),
      onShardRemoved: vi.fn(),
    };

    expect(mock.getStrategy().name).toBe('hash');
  });
});
