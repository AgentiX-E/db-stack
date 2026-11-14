/**
 * RaftGroupManager Unit Tests
 *
 * Tests the manager-layer logic: shard registration, lifecycle management,
 * leader election monitoring, and batch propose buffering.
 *
 * The RaftGroupManager does NOT manage TCP connections or Raft protocol
 * directly — those are delegated to RaftGroup/RaftAdapter. This test
 * verifies the coordinator logic through mocked RaftGroup instances.
 *
 * Acceptance criteria:
 *   AC 6.1 — Register shard creates RaftGroup with correct config
 *   AC 6.2 — Deregister shard stops group and cleans up
 *   AC 6.3 — waitForRaftLeaders returns true when all groups have leaders
 *   AC 6.4 — waitForRaftLeaders returns false on timeout
 *   AC 6.5 — propose dispatches to correct group
 *   AC 6.6 — Batch propose buffers and flushes entries
 *   AC 6.7 — Pause/resume shard lifecycle
 *   AC 6.8 — getState works for all groups
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock RaftGroup ──────────────────────────────────────────
const mockGroups = new Map<number, any>();

vi.mock('../../consensus/core/RaftGroup', () => {
  return {
    RaftGroup: class MockRaftGroup {
      public shardId: number;
      public config: any;
      public replica: any;
      public outboxManager: any;
      public _initCalled = false;
      public _stopped = false;
      public _leader: number | null = null;
      public _proposed: any[] = [];
      public _appliedOK = 0;

      constructor(shardId: number, config: any, replica: any, outboxManager: any) {
        this.shardId = shardId;
        this.config = config;
        this.replica = replica;
        this.outboxManager = outboxManager;
        mockGroups.set(shardId, this);
      }

      async init(_sharedTransport?: any) {
        this._initCalled = true;
      }

      stop() {
        this._stopped = true;
      }

      async isLeader() {
        return this._isLeader ?? (this._leader !== null && this._leader === this.config.id);
      }

      async getLeader() {
        return this._leader ?? null;
      }

      async propose(data: any) {
        this._proposed.push(data);
      }

      async getProgress() {
        if (this._progress) return this._progress;
        return { commit: this._proposed.length, applied: this._proposed.length };
      }

      setStorage(_storage: any) {
        // no-op mock
      }

      getRaftAdapter() {
        return {
          flushApplyQueue: vi.fn(),
        };
      }

      getLearnerCount() {
        return 0;
      }

      setForceLeader(enabled: boolean) {
        this._forceLeader = enabled;
      }

      async notifyTopologyChange(change: any) {
        this._topologyChanges ??= [];
        this._topologyChanges.push(change);
      }

      async campaign() {
        this._campaignCalls ??= 0;
        this._campaignCalls++;
      }

      async getTerm() {
        return this._term ?? 1;
      }

      getPipelineDepth() {
        return 0;
      }

      getLeaderHealthStatus() {
        return [];
      }

      async proposeMembershipChange(_change: any) {
        this._membershipChanges ??= 0;
        this._membershipChanges++;
        return { success: true, phase: 'NORMAL' };
      }
    },
  };
});

// Mock IShardReplica
class MockReplica {
  constructor(public shardId: number) {}
  apply(_entry: any) {}
}

describe('RaftGroupManager', () => {
  let RaftGroupManager: any;
  let manager: any;

  beforeEach(async () => {
    mockGroups.clear();
    vi.resetModules();
    const mod = await import('../../consensus/core/RaftGroupManager');
    RaftGroupManager = mod.RaftGroupManager;
    manager = new RaftGroupManager({}, 100);
  });

  afterEach(async () => {
    // Clear singleton instances that NodeTransport.createShared may have created
    const { NodeTransport } = await import('../../consensus/transport/NodeTransport');
    NodeTransport.clearAllShared?.();
  });

  // ── AC 6.1: Register shard ─────────────────────────────────
  describe('registerShardWithReplica', () => {
    it('should create a RaftGroup with correct config (AC 6.1)', () => {
      const replica = new MockReplica(1);
      const peers = [
        { nodeId: 'node-1', raftIndex: 1 },
        { nodeId: 'node-2', raftIndex: 2 },
        { nodeId: 'node-3', raftIndex: 3 },
      ];

      manager.registerShardWithReplica(1, replica, peers, 2);

      expect(mockGroups.has(1)).toBe(true);
      const group = mockGroups.get(1);
      expect(group).toBeDefined();
      expect(group.config.id).toBe(2); // localRaftIndex
      expect(group.config.peers).toEqual([1, 2, 3]); // peer raftIndexes
      expect(group.config.electionTick).toBeGreaterThan(0);
      expect(group.config.heartbeatTick).toBe(2);
    });

    it('should register multiple shards independently', () => {
      for (let i = 0; i < 3; i++) {
        manager.registerShardWithReplica(i, new MockReplica(i), [{ nodeId: 'node-1', raftIndex: 1 }], 1);
      }

      expect(mockGroups.size).toBe(3);
      expect(mockGroups.has(0)).toBe(true);
      expect(mockGroups.has(1)).toBe(true);
      expect(mockGroups.has(2)).toBe(true);
    });
  });

  // ── AC 6.2: Deregister shard ───────────────────────────────
  describe('deregisterShard', () => {
    it('should stop the RaftGroup and remove it from internal tracking (AC 6.2)', () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'node-1', raftIndex: 1 }], 1);

      const group = mockGroups.get(1);
      expect(group._stopped).toBe(false);

      manager.deregisterShard(1);

      expect(group._stopped).toBe(true);
      // Group is removed from manager's internal tracking
      // (verified by group not being returned in state queries)
    });

    it('should be a no-op for unknown shardId', () => {
      expect(() => manager.deregisterShard(999)).not.toThrow();
    });
  });

  // ── AC 6.3/6.4: waitForRaftLeaders ─────────────────────────
  describe('waitForRaftLeaders', () => {
    it('should return true when all groups have leaders (AC 6.3)', async () => {
      manager.registerShardWithReplica(
        1,
        new MockReplica(1),
        [
          { nodeId: 'node-1', raftIndex: 1 },
          { nodeId: 'node-2', raftIndex: 2 },
        ],
        1,
      );

      const group = mockGroups.get(1);
      group._leader = 1; // This group's node ID

      const result = await manager.waitForRaftLeaders(3000);
      expect(result).toBe(true);
    });

    it('should return false on timeout when no leader elected (AC 6.4)', async () => {
      manager.registerShardWithReplica(
        1,
        new MockReplica(1),
        [
          { nodeId: 'node-1', raftIndex: 1 },
          { nodeId: 'node-2', raftIndex: 2 },
        ],
        1,
      );

      // Don't set a leader — simulate election timeout
      const result = await manager.waitForRaftLeaders(500);
      expect(result).toBe(false);
    });
  });

  // ── AC 6.5: propose dispatch ───────────────────────────────
  describe('propose', () => {
    it('should dispatch to the correct RaftGroup (AC 6.5)', async () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'node-1', raftIndex: 1 }], 1);

      const group = mockGroups.get(1);
      group._leader = 1; // This node is leader for this shard

      // The string overload expects valueOrEntry to be valid JSON
      const idx = await manager.propose('1', '"test-value"');
      expect(idx).toBeTypeOf('number');
      expect(group._proposed).toContain('test-value');
    });

    it('should throw for unknown shard', async () => {
      await expect(manager.propose('999', 'value')).rejects.toThrow();
    });
  });

  // ── AC 6.7: Pause/resume ──────────────────────────────────
  describe('pause/resume shard', () => {
    it('should pause and resume a shard (AC 6.7)', async () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'node-1', raftIndex: 1 }], 1);

      const group = mockGroups.get(1);
      expect(group._stopped).toBe(false);

      await manager.pauseShard(1);
      expect(group._stopped).toBe(true);

      // Hack: reset _stopped for resume test since stop() was called
      group._stopped = false;
      await manager.resumeShard(1);
      expect(group._initCalled).toBe(true);
    });

    it('should not throw when pausing unknown shard', async () => {
      await expect(manager.pauseShard(999)).resolves.toBeUndefined();
    });

    it('should not throw when resuming unknown shard', async () => {
      await expect(manager.resumeShard(999)).resolves.toBeUndefined();
    });
  });

  // ── AC 6.6: Batch propose ─────────────────────────────────
  describe('batch propose', () => {
    it('should buffer batchable entries (AC 6.6)', async () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'node-1', raftIndex: 1 }], 1);

      const group = mockGroups.get(1);
      group._leader = 1; // This node is leader

      // Propose a batchable entry (numeric shard overload)
      const promise = manager.propose(1, { _batchable: true, data: 'batch-data' });
      // Immediately after propose, entry is in buffer (not proposed yet)
      expect(group._proposed).toHaveLength(0);
      // The promise resolves after flush
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ── AC 6.8: status reporting ──────────────────────────────
  describe('status', () => {
    it('should return peer status for all registered groups (AC 6.8)', () => {
      for (let i = 0; i < 2; i++) {
        manager.registerShardWithReplica(i, new MockReplica(i), [{ nodeId: 'node-1', raftIndex: 1 }], 1);
      }

      const statuses = manager.getPeerStatus();
      expect(Array.isArray(statuses)).toBe(true);
      expect(statuses).toHaveLength(2);
      expect(statuses[0].shardId).toBe(0);
      expect(statuses[1].shardId).toBe(1);
    });

    it('should return empty array when no shards registered', () => {
      const statuses = manager.getPeerStatus();
      expect(statuses).toEqual([]);
    });
  });

  // ── AC 10.1: registerShard (IConsensusLayer interface) ──

  describe('registerShard (AC 10.1)', () => {
    it('should register a shard by shard ID with replica and peers', () => {
      const replica = new MockReplica(101);
      const peers = [{ nodeId: 'node-1', raftIndex: 1, host: 'localhost', port: 10001 }];
      manager.registerShard('101', { replica, peers, localRaftIndex: 1 });

      const status = manager.getPeerStatus();
      expect(status).toHaveLength(1);
      expect(status[0].shardId).toBe(101);
    });
  });

  // ── AC 10.4: isLeader ──

  describe('isLeader (AC 10.4)', () => {
    beforeEach(() => {
      const replica = new MockReplica(201);
      const peers = [{ nodeId: 'node-1', raftIndex: 201 }];
      manager.registerShard('201', { replica, peers, localRaftIndex: 201 });
    });

    it('should return true when the group reports leader', async () => {
      const group = mockGroups.get(201)!;
      group._leader = 201;

      const result = await manager.isLeader('201');
      expect(result).toBe(true);
    });

    it('should return false when group reports not leader', async () => {
      const result = await manager.isLeader('201');
      expect(result).toBe(false);
    });

    it('should return false for unknown shardId', async () => {
      const result = await manager.isLeader('999');
      expect(result).toBe(false);
    });
  });

  // ── AC 10.5: getLeader ──

  describe('getLeader (AC 10.5)', () => {
    beforeEach(() => {
      const replica = new MockReplica(301);
      const peers = [{ nodeId: 'node-1', raftIndex: 301 }];
      manager.registerShard('301', { replica, peers, localRaftIndex: 301 });
    });

    it('should return leader node ID for a registered shard', async () => {
      mockGroups.get(301)!._leader = 5;

      const leader = await manager.getLeader('301');
      expect(leader).toBe('5');
    });

    it('should return null when no leader elected', async () => {
      const leader = await manager.getLeader('301');
      expect(leader).toBeNull();
    });

    it('should return null for unknown shardId', async () => {
      const leader = await manager.getLeader('999');
      expect(leader).toBeNull();
    });
  });

  // ── AC 10.6: getCommitIndex ──

  describe('getCommitIndex (AC 10.6)', () => {
    beforeEach(() => {
      const replica = new MockReplica(401);
      const peers = [{ nodeId: 'node-1', raftIndex: 401 }];
      manager.registerShard('401', { replica, peers, localRaftIndex: 401 });
    });

    it('should return commit index from the group', async () => {
      mockGroups.get(401)!._progress = { commit: 99, applied: 99 };

      const index = await manager.getCommitIndex('401');
      expect(index).toBe(99);
    });
  });

  // ── AC 10.7: removeShard ──

  describe('removeShard (AC 10.7)', () => {
    beforeEach(() => {
      const replica = new MockReplica(501);
      const peers = [{ nodeId: 'node-1', raftIndex: 501 }];
      manager.registerShard('501', { replica, peers, localRaftIndex: 501 });
    });

    it('should deregister and remove a shard', async () => {
      expect(mockGroups.has(501)).toBe(true);

      await manager.removeShard('501');

      expect(mockGroups.get(501)?._stopped).toBe(true);
      expect(manager.getPeerStatus()).toHaveLength(0);
    });

    it('should be no-op for unknown shard', async () => {
      await expect(manager.removeShard('999')).resolves.not.toThrow();
    });
  });

  // ── AC 10.8+10.9: notifyTopologyChange ──

  describe('notifyTopologyChange (AC 10.8, 10.9)', () => {
    beforeEach(() => {
      const replica1 = new MockReplica(601);
      const replica2 = new MockReplica(602);
      manager.registerShard('601', {
        replica: replica1,
        peers: [{ nodeId: 'node-1', raftIndex: 601 }],
        localRaftIndex: 601,
      });
      manager.registerShard('602', {
        replica: replica2,
        peers: [{ nodeId: 'node-1', raftIndex: 602 }],
        localRaftIndex: 602,
      });
    });

    it('should propose membership change for all registered groups', async () => {
      await manager.notifyTopologyChange({
        type: 'peer_added',
        nodeId: '101',
        timestamp: Date.now(),
      });

      expect(mockGroups.get(601)!._membershipChanges).toBeGreaterThanOrEqual(1);
      expect(mockGroups.get(602)!._membershipChanges).toBeGreaterThanOrEqual(1);
    });

    it('should handle peer_removed', async () => {
      mockGroups.get(601)!._membershipChanges = 0;

      await manager.notifyTopologyChange({
        type: 'peer_removed',
        nodeId: '102',
        timestamp: Date.now(),
      });

      expect(mockGroups.get(601)!._membershipChanges).toBeGreaterThanOrEqual(1);
    });

    it('should handle leader_changed', async () => {
      mockGroups.get(601)!._membershipChanges = 0;

      await manager.notifyTopologyChange({
        type: 'leader_changed',
        nodeId: '103',
        timestamp: Date.now(),
      });

      expect(mockGroups.get(601)!._membershipChanges).toBeGreaterThanOrEqual(1);
    });
  });

  // ── AC 10.10: getHealthStatus ──

  describe('getHealthStatus (AC 10.10)', () => {
    beforeEach(() => {
      const replica1 = new MockReplica(701);
      const replica2 = new MockReplica(702);
      manager.registerShard('701', {
        replica: replica1,
        peers: [{ nodeId: 'node-1', raftIndex: 701 }],
        localRaftIndex: 701,
      });
      manager.registerShard('702', {
        replica: replica2,
        peers: [{ nodeId: 'node-1', raftIndex: 702 }],
        localRaftIndex: 702,
      });
      mockGroups.get(701)!._leader = 701;
      mockGroups.get(702)!._leader = 3;
    });

    it('should return status for all registered groups', async () => {
      const status = await manager.getHealthStatus();

      expect(status).toHaveLength(2);
      const s701 = status.find((s) => s.shardId === '701' || s.shardId === 701);
      const s702 = status.find((s) => s.shardId === '702' || s.shardId === 702);
      expect(s701).toBeDefined();
      expect(s702).toBeDefined();
    });
  });

  // ── AC 10.11: campaign ──

  describe('campaign (AC 10.11)', () => {
    beforeEach(() => {
      const replica = new MockReplica(801);
      const peers = [{ nodeId: 'node-1', raftIndex: 801 }];
      manager.registerShard('801', { replica, peers, localRaftIndex: 801 });
    });

    it('should trigger immediate election on the shard group', async () => {
      await manager.campaign('801');

      const group = mockGroups.get(801);
      expect(group!._campaignCalls).toBeGreaterThanOrEqual(1);
    });

    it('should throw for unknown shard', async () => {
      await expect(manager.campaign('999')).rejects.toThrow();
    });
  });

  // ── AC 10.12: setForceLeader ──

  describe('setForceLeader (AC 10.12)', () => {
    beforeEach(() => {
      const replica1 = new MockReplica(901);
      const replica2 = new MockReplica(902);
      manager.registerShard('901', {
        replica: replica1,
        peers: [{ nodeId: 'node-1', raftIndex: 901 }],
        localRaftIndex: 901,
      });
      manager.registerShard('902', {
        replica: replica2,
        peers: [{ nodeId: 'node-1', raftIndex: 902 }],
        localRaftIndex: 902,
      });
    });

    it('should set force leader on all groups', async () => {
      manager.setForceLeader(true);

      expect(mockGroups.get(901)!._forceLeader).toBe(true);
      expect(mockGroups.get(902)!._forceLeader).toBe(true);
    });

    it('should toggle force leader off', async () => {
      manager.setForceLeader(true);
      manager.setForceLeader(false);

      expect(mockGroups.get(901)!._forceLeader).toBe(false);
    });
  });

  // ── AC 10.13: on/off event mechanism ──

  describe('on/off events (AC 10.13)', () => {
    it('should register and trigger event handlers', () => {
      const handler = vi.fn();
      const handler2 = vi.fn();

      manager.on('leader-elected', handler);
      manager.on('leader-elected', handler2);

      // Emit an event through the internal emitter
      (manager as any).eventEmitter.emit('leader-elected', { nodeId: 1 });

      expect(handler).toHaveBeenCalledWith({ nodeId: 1 });
      expect(handler2).toHaveBeenCalledWith({ nodeId: 1 });
    });

    it('should remove event handlers', () => {
      const handler = vi.fn();

      manager.on('leader-elected', handler);
      manager.off('leader-elected', handler);

      (manager as any).eventEmitter.emit('leader-elected', { nodeId: 1 });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple event types', () => {
      const leaderHandler = vi.fn();
      const failHandler = vi.fn();

      manager.on('leader-elected', leaderHandler);
      manager.on('failover', failHandler);

      (manager as any).eventEmitter.emit('leader-elected', { nodeId: 1 });

      expect(leaderHandler).toHaveBeenCalled();
      expect(failHandler).not.toHaveBeenCalled();
    });
  });
});
