import { describe, it, expect, vi } from 'vitest';
import { IShardStrategy } from '../../interfaces/shard/IShardStrategy';

describe('IShardStrategy', () => {
  it('should define the interface contract', () => {
    const methods: (keyof IShardStrategy)[] = [
      'name',
      'getShardForKey',
      'computeAssignments',
      'onNodeAdded',
      'onNodeRemoved',
      'validateDistribution',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('mock hash strategy should implement interface', () => {
    const mock: IShardStrategy = {
      name: 'consistent-hashing',
      getShardForKey: vi.fn().mockResolvedValue({ success: true, data: 'shard-0' }),
      computeAssignments: vi.fn().mockResolvedValue({ success: true, data: {} }),
      onNodeAdded: vi.fn().mockResolvedValue({ success: true, data: {} }),
      onNodeRemoved: vi.fn().mockResolvedValue({ success: true, data: {} }),
      validateDistribution: vi.fn().mockResolvedValue({ success: true, data: true }),
    };

    expect(mock.name).toBe('consistent-hashing');
  });
});
