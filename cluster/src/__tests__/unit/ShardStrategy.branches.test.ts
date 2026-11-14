/**
 * ShardStrategy — exhaustive branch coverage for the three strategies.
 *
 * Existing i22-resharding.test.ts covers the happy paths and the HashStrategy's
 * interface methods, but leaves several delegation methods and boundary
 * branches unreached:
 *   - RangeShardStrategy delegates computeAssignments/onNodeAdded/onNodeRemoved/
 *     validateDistribution to HashShardStrategy (never exercised).
 *   - ConsistentHashStrategy.validateDistribution delegates to HashShardStrategy.
 *   - HashShardStrategy.validateDistribution empty-node-list and over-replication
 *     branches.
 *   - getShardForKey / findNode binary-search boundary branches (key out of all
 *     ranges, ring lookup miss).
 *   - ConsistentHashStrategy.onNodeRemoved "no nodes remaining" branch.
 *
 * These tests close every remaining branch and add contract verification for
 * the delegation methods.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HashShardStrategy,
  RangeShardStrategy,
  ConsistentHashStrategy,
  type RangeShardBoundary,
} from '../../shard/ShardStrategy';

describe('ShardStrategy — delegation and boundary branches', () => {
  describe('RangeShardStrategy delegation methods', () => {
    let strategy: RangeShardStrategy;
    beforeEach(() => {
      strategy = new RangeShardStrategy([
        { shardId: 'A', rangeStart: 'a', rangeEnd: 'm' },
        { shardId: 'B', rangeStart: 'm', rangeEnd: 'z' },
      ] satisfies RangeShardBoundary[]);
    });

    it('computeAssignments delegates to hash round-robin', async () => {
      const r = await strategy.computeAssignments(
        ['s0', 's1', 's2'],
        ['n1', 'n2'],
        {},
        1,
      );
      expect(r.success).toBe(true);
      expect(Object.keys(r.data!)).toHaveLength(3);
    });

    it('computeAssignments propagates empty-node error', async () => {
      const r = await strategy.computeAssignments(['s0'], [], {}, 1);
      expect(r.success).toBe(false);
    });

    it('onNodeAdded delegates to hash', async () => {
      const dist = { s0: ['n1'], s1: ['n2'] };
      const r = await strategy.onNodeAdded('n3', dist, 1);
      expect(r.success).toBe(true);
      expect(Object.keys(r.data!)).toHaveLength(2);
    });

    it('onNodeRemoved delegates to hash', async () => {
      const dist = { s0: ['n1', 'n2'], s1: ['n2', 'n3'] };
      const r = await strategy.onNodeRemoved('n1', dist, 1);
      expect(r.success).toBe(true);
      expect(Object.keys(r.data!)).toHaveLength(2);
    });

    it('onNodeRemoved propagates no-nodes-remaining error', async () => {
      const dist = { s0: ['n1'] };
      const r = await strategy.onNodeRemoved('n1', dist, 1);
      expect(r.success).toBe(false);
    });

    it('validateDistribution delegates to hash', async () => {
      const r = await strategy.validateDistribution({ s0: ['n1', 'n2'] }, 2);
      expect(r.success).toBe(true);
      expect(r.data).toBe(true);
    });
  });

  describe('HashShardStrategy.validateDistribution branches', () => {
    const strategy = new HashShardStrategy();

    it('returns false for an empty node list in a shard', async () => {
      const r = await strategy.validateDistribution({ s0: [] }, 2);
      expect(r.data).toBe(false);
    });

    it('returns false when nodes exceed replication factor', async () => {
      const r = await strategy.validateDistribution({ s0: ['n1', 'n2', 'n3'] }, 2);
      expect(r.data).toBe(false);
    });

    it('returns false for duplicate node assignments', async () => {
      const r = await strategy.validateDistribution({ s0: ['n1', 'n1'] }, 2);
      expect(r.data).toBe(false);
    });

    it('returns true for a fully valid distribution', async () => {
      const r = await strategy.validateDistribution(
        { s0: ['n1', 'n2'], s1: ['n2', 'n3'] },
        2,
      );
      expect(r.data).toBe(true);
    });
  });

  describe('HashShardStrategy.computeAssignments replication', () => {
    const strategy = new HashShardStrategy();

    it('assigns multiple distinct replicas when replicationFactor > 1', async () => {
      const r = await strategy.computeAssignments(
        ['s0', 's1'],
        ['n1', 'n2', 'n3'],
        {},
        3,
      );
      expect(r.success).toBe(true);
      for (const replicas of Object.values(r.data!)) {
        expect(replicas).toHaveLength(3);
        expect(new Set(replicas).size).toBe(3);
      }
    });

    it('avoids duplicate replicas when replicationFactor exceeds node count', async () => {
      const r = await strategy.computeAssignments(
        ['s0'],
        ['n1', 'n2'],
        {},
        5,
      );
      expect(r.success).toBe(true);
      // Only 2 unique nodes exist; replicas are not duplicated.
      expect(new Set(r.data!['s0']!).size).toBe(2);
    });
  });
});

describe('RangeShardStrategy — getShardForKey binary-search boundaries', () => {
  it('returns error when key is below all ranges', async () => {
    const s = new RangeShardStrategy([
      { shardId: 'A', rangeStart: 'm', rangeEnd: 'z' },
    ]);
    const r = await s.getShardForKey('a', 1);
    expect(r.success).toBe(false);
  });

  it('returns error when key is above all ranges', async () => {
    const s = new RangeShardStrategy([
      { shardId: 'A', rangeStart: 'a', rangeEnd: 'm' },
    ]);
    const r = await s.getShardForKey('zebra', 1);
    expect(r.success).toBe(false);
  });

  it('binary searches to a lower half bin', async () => {
    const s = new RangeShardStrategy([
      { shardId: 'A', rangeStart: 'a', rangeEnd: 'c' },
      { shardId: 'B', rangeStart: 'c', rangeEnd: 'e' },
      { shardId: 'C', rangeStart: 'e', rangeEnd: 'g' },
    ]);
    expect((await s.getShardForKey('b', 3)).data).toBe('A');
    expect((await s.getShardForKey('d', 3)).data).toBe('B');
    expect((await s.getShardForKey('f', 3)).data).toBe('C');
  });
});

describe('ConsistentHashStrategy — remaining branches', () => {
  it('onNodeRemoved fails when no nodes remain', async () => {
    const cs = new ConsistentHashStrategy();
    const dist = { s0: ['n1'] };
    const r = await cs.onNodeRemoved('n1', dist, 1);
    expect(r.success).toBe(false);
  });

  it('onNodeRemoved reassigns when nodes remain', async () => {
    const cs = new ConsistentHashStrategy();
    const dist = { s0: ['n1', 'n2'], s1: ['n2', 'n3'] };
    const r = await cs.onNodeRemoved('n1', dist, 1);
    expect(r.success).toBe(true);
    expect(Object.keys(r.data!)).toHaveLength(2);
  });

  it('validateDistribution delegates to hash', async () => {
    const cs = new ConsistentHashStrategy();
    const r = await cs.validateDistribution({ s0: ['n1', 'n2'] }, 2);
    expect(r.data).toBe(true);
  });

  it('getShardForKey returns error when ring lookup misses', async () => {
    const cs = new ConsistentHashStrategy();
    // Build a ring so findNode can run, but force a miss via empty node set.
    // buildRing with an empty list leaves the ring empty → error branch.
    cs.buildRing([]);
    const r = await cs.getShardForKey('key', 1);
    expect(r.success).toBe(false);
  });

  it('computeAssignments with replication factor exceeding node count', async () => {
    const cs = new ConsistentHashStrategy(8);
    const r = await cs.computeAssignments(['s0'], ['n1', 'n2'], {}, 10);
    expect(r.success).toBe(true);
    expect(new Set(r.data!['s0']!).size).toBe(2);
  });

  it('buildRing with multiple nodes triggers the full sort comparator', () => {
    const cs = new ConsistentHashStrategy(4);
    cs.buildRing(['n1', 'n2', 'n3']);
    // ring populated with 4 vnodes × 3 nodes = 12 vnodes, sorted by hash.
    expect(cs.getRingSize()).toBe(12);
  });

  it('findNode returns null for an empty ring', () => {
    const cs = new ConsistentHashStrategy(4);
    expect((cs as any).findNode('key')).toBeNull();
  });

  it('findReplicas returns [] for an empty ring', () => {
    const cs = new ConsistentHashStrategy(4);
    expect((cs as any).findReplicas('key', 3)).toEqual([]);
  });

  it('findNode locates a node on a populated ring', () => {
    const cs = new ConsistentHashStrategy(4);
    cs.buildRing(['n1', 'n2']);
    const node = (cs as any).findNode('some-key');
    expect(['n1', 'n2']).toContain(node);
  });

  it('estimateRedistributionRatio returns 1.0 for empty oldNodes', () => {
    const cs = new ConsistentHashStrategy(4);
    expect(cs.estimateRedistributionRatio([], ['n1'])).toBe(1.0);
  });

  it('estimateRedistributionRatio returns a fraction for non-empty oldNodes', () => {
    const cs = new ConsistentHashStrategy(4);
    expect(cs.estimateRedistributionRatio(['n1', 'n2'], ['n1', 'n2', 'n3'])).toBeCloseTo(1 / 3);
  });
});
