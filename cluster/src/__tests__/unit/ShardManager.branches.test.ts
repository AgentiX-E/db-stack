/**
 * ShardManager — branch completion tests.
 *
 * i22-resharding.test.ts covers the lifecycle, query, assign/remove, rebalance,
 * and add/remove-node happy paths, but leaves a few branches unreached:
 *   - getShardForKey (entire method — delegation to the strategy)
 *   - rebalance concurrency guard ("already in progress")
 *   - rebalance / addNode / removeNode strategy-failure branches
 *   - getShardAge null branch for an unknown shard
 *
 * These tests close each remaining branch using a controllable mock strategy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShardManager } from '../../shard/ShardManager';
import { HashShardStrategy } from '../../shard/ShardStrategy';
import type { IShardStrategy } from '../../interfaces/shard/IShardStrategy';

function failingStrategy(): IShardStrategy {
  return {
    name: 'failing',
    getShardForKey: vi.fn(async () => ({ success: false, error: 'nope' })),
    computeAssignments: vi.fn(async () => ({ success: false, error: 'compute failed' })),
    onNodeAdded: vi.fn(async () => ({ success: false, error: 'add failed' })),
    onNodeRemoved: vi.fn(async () => ({ success: false, error: 'remove failed' })),
    validateDistribution: vi.fn(async () => ({ success: true, data: true })),
  };
}

describe('ShardManager — branch completion', () => {
  let manager: ShardManager;

  beforeEach(() => {
    manager = new ShardManager();
  });

  describe('getShardForKey', () => {
    it('delegates to the strategy with the configured shard count', async () => {
      await manager.initialize(new HashShardStrategy());
      await manager.assignShard('shard-0', ['n1']);
      await manager.assignShard('shard-1', ['n2']);

      const result = await manager.getShardForKey('user:alice');
      expect(result.success).toBe(true);
      expect(typeof result.data).toBe('string');
    });

    it('uses a total of 1 when no shards are assigned yet', async () => {
      const mock = failingStrategy();
      mock.getShardForKey = vi.fn(async () => ({ success: true, data: 'shard-0' }));
      await manager.initialize(mock);
      const result = await manager.getShardForKey('user:alice');
      expect(result.success).toBe(true);
      expect(mock.getShardForKey).toHaveBeenCalledWith('user:alice', 1);
    });

    it('returns the number of existing shards as the total', async () => {
      const mock = failingStrategy();
      mock.getShardForKey = vi.fn(async () => ({ success: true, data: 'shard-0' }));
      await manager.initialize(mock);
      await manager.assignShard('a', ['n1']);
      await manager.assignShard('b', ['n2']);
      await manager.assignShard('c', ['n3']);

      await manager.getShardForKey('user:alice');
      expect(mock.getShardForKey).toHaveBeenCalledWith('user:alice', 3);
    });
  });

  describe('rebalance branches', () => {
    it('rejects a rebalance while another is in progress', async () => {
      const mock = {
        name: 'block',
        getShardForKey: vi.fn(),
        computeAssignments: vi.fn(
          () =>
            new Promise((resolve) => {
              // Never resolves synchronously — keeps rebalancing flag true.
              setTimeout(() => resolve({ success: true, data: {} }), 50);
            }),
        ),
        onNodeAdded: vi.fn(),
        onNodeRemoved: vi.fn(),
        validateDistribution: vi.fn(),
      };
      await manager.initialize(mock);
      await manager.assignShard('s0', ['n1']);

      const p1 = manager.rebalance(['n1', 'n2']);
      const r2 = await manager.rebalance(['n1', 'n2']);
      expect(r2.success).toBe(false);
      expect(r2.error).toContain('already in progress');

      await p1;
    });

    it('returns an error when the strategy rejects the assignment', async () => {
      await manager.initialize(failingStrategy());
      await manager.assignShard('s0', ['n1']);

      const result = await manager.rebalance(['n1', 'n2']);
      expect(result.success).toBe(false);
      expect(result.error).toBe('compute failed');
    });
  });

  describe('addNode / removeNode failure branches', () => {
    it('returns an error when addNode strategy fails', async () => {
      await manager.initialize(failingStrategy());
      await manager.assignShard('s0', ['n1']);

      const result = await manager.addNode('n2');
      expect(result.success).toBe(false);
      expect(result.error).toBe('add failed');
    });

    it('returns an error when removeNode strategy fails', async () => {
      await manager.initialize(failingStrategy());
      await manager.assignShard('s0', ['n1', 'n2']);

      const result = await manager.removeNode('n1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('remove failed');
    });
  });

  describe('nullish-coalescing default error fallbacks', () => {
    it('rebalance falls back to a default error when strategy omits error', async () => {
      const mock = failingStrategy();
      mock.computeAssignments = vi.fn(async () => ({ success: false } as any));
      await manager.initialize(mock);
      await manager.assignShard('s0', ['n1']);

      const result = await manager.rebalance(['n1', 'n2']);
      expect(result.success).toBe(false);
      expect(result.error).toBe('strategy failed');
    });

    it('addNode falls back to a default error when strategy omits error', async () => {
      const mock = failingStrategy();
      mock.onNodeAdded = vi.fn(async () => ({ success: false } as any));
      await manager.initialize(mock);
      await manager.assignShard('s0', ['n1']);

      const result = await manager.addNode('n2');
      expect(result.success).toBe(false);
      expect(result.error).toBe('addNode failed');
    });

    it('removeNode falls back to a default error when strategy omits error', async () => {
      const mock = failingStrategy();
      mock.onNodeRemoved = vi.fn(async () => ({ success: false } as any));
      await manager.initialize(mock);
      await manager.assignShard('s0', ['n1', 'n2']);

      const result = await manager.removeNode('n1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('removeNode failed');
    });
  });

  describe('getShardAge null branch', () => {
    it('returns null for an unknown shard', async () => {
      await manager.initialize(new HashShardStrategy());
      expect(manager.getShardAge('unknown-shard')).toBeNull();
    });
  });

  describe('assignShard reassign and remove event coverage', () => {
    it('updates an existing shard assignment', async () => {
      await manager.initialize(new HashShardStrategy());
      await manager.assignShard('s1', ['n1']);
      // Reassign the same shard to exercise the update (existing) branch.
      const r = await manager.assignShard('s1', ['n1', 'n2', 'n3']);
      expect(r.success).toBe(true);

      const nodes = await manager.getShardNodes('s1');
      expect(nodes.data).toEqual(['n1', 'n2', 'n3']);
    });
  });
});
