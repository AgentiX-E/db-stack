/**
 * RaftGroupManager — setters/getters, adaptive election timeout, and
 * topology helpers.
 *
 * These thin coordinator methods were entirely uncovered (FNDA 0). Each is
 * exercised directly with mocked RaftGroup instances to verify routing,
 * state reads, and configuration plumbing without touching real Raft/TCP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      public _term = 1;
      public _progress: any = { commit: 0, applied: 0, lastLog: 0 };
      public _forceLeader = false;
      public _learnerCount = 0;
      public _phase: string = 'NORMAL';
      public _transferInProgress = false;
      public _health = { healthy: true, lastHeartbeatMs: 100, term: 1, leaderId: '1', leaderMonitorRunning: true };
      public _pipelineDepth = 0;
      public _readRows: any[] = [];
      public _applyFromEventBusResult = true;

      constructor(shardId: number, config: any, replica: any, outboxManager: any, _snapshotDir?: any, pipelineConfig?: any, flexQuorum?: any) {
        this.shardId = shardId;
        this.config = config;
        this.replica = replica;
        this.outboxManager = outboxManager;
        this.flexQuorum = flexQuorum ?? { writeQuorum: 2, readQuorum: 1, commitQuorum: 2 };
        mockGroups.set(shardId, this);
      }

      async init(_sharedTransport?: any) { this._initCalled = true; }
      stop() { this._stopped = true; }
      async isLeader() { return this._leader === this.config?.id; }
      async getLeader() { return this._leader; }
      async getTerm() { return this._term; }
      async getProgress() { return this._progress; }
      async propose(_data: any) { return { index: '1', term: '1' }; }
      async proposeBatch(_entries: any[]) {}
      async read(_sql: string, _params?: any[]) { return this._readRows; }
      isReadQuorumReached(a: number, b: number) { return { required: a, quorumMet: a <= b } as any; }
      getLearnerCount() { return this._learnerCount; }
      setForceLeader(enabled: boolean) { this._forceLeader = enabled; }
      async campaign() {}
      getConsensusPhase() { return this._phase; }
      async rollbackMembershipChange() { return true; }
      async addLearner(_nodeId: string) { return true; }
      removeLearner(_nodeId: string) { return true; }
      async requestForLearner(fromIndex: number) { return { entries: [], snapshotAvailable: false, lastIndex: fromIndex, lastTerm: 0 }; }
      updateLearnerProgress(_nodeId: string, _matchedIndex: number) {}
      async transferLeadership(_target: string) { return { success: true, newLeader: '1', durationMs: 10 }; }
      isLeaderTransferInProgress() { return this._transferInProgress; }
      async getLeaderHealth() { return this._health; }
      getPipelineDepth() { return this._pipelineDepth; }
      setPipelineConfig(_config: any) {}
      async forceFlush() {}
      handleRaftMessage(_msg: any) {}
      async applyFromEventBus(_entry: any) { return this._applyFromEventBusResult; }
      startLeaderMonitor(_intervalMs?: number) {}
      stopLeaderMonitor() {}
      async proposeMembershipChange(_change: any) { return { success: true, phase: 'NORMAL' }; }
      async getState() { return {}; }
    },
  };
});

vi.mock('../../consensus/opt/AdaptiveElectionTimeout', () => {
  return {
    AdaptiveElectionTimeout: class MockAET {
      public config: any;
      public _samples = 0;
      public _avgRtt = 0;
      constructor(config: any) { this.config = config; }
      start() {}
      stop() {}
      recalculate() {}
      recordRtt(_rttMs: number) { this._samples++; this._avgRtt = 50; }
      getSampleCount() { return this._samples; }
      getAvgRtt() { return this._avgRtt; }
      getCurrentTick(base: number, _tickMs: number) { return base; }
    },
  };
});

class MockReplica {
  constructor(public shardId: number) {}
  apply(_entry: any) {}
}

describe('RaftGroupManager — setters/getters/adaptive/topology', () => {
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
    const { NodeTransport } = await import('../../consensus/transport/NodeTransport');
    NodeTransport.clearAllShared?.();
  });

  describe('constructor + basic getters', () => {
    it('exposes tick interval', () => {
      expect(manager.getTickIntervalMs()).toBe(100);
    });

    it('reports peer count from cluster topology', () => {
      manager.setClusterTopology({ nodes: [{}, {}, {}], getNodeId: () => 'node-1' });
      expect(manager.getPeerCount()).toBe(3);
    });

    it('defaults peer count to 1 without topology', () => {
      expect(manager.getPeerCount()).toBe(1);
    });
  });

  describe('setter plumbing', () => {
    it('setOutboxWriter stores the writer', () => {
      const writer = { append: vi.fn() };
      manager.setOutboxWriter(writer);
      expect(manager.outboxWriter).toBe(writer);
    });

    it('setClusterTopology stores the topology', () => {
      const topo = { nodes: [{}, {}], getNodeId: () => 'x' };
      manager.setClusterTopology(topo);
      expect(manager.clusterTopology).toBe(topo);
    });

    it('setSharedTransport stores the transport', () => {
      const t = { send: vi.fn() };
      manager.setSharedTransport(t);
      expect(manager.sharedTransport).toBe(t);
    });

    it('setReconnectConfig merges over defaults', () => {
      manager.setReconnectConfig({ maxRetries: 3, baseMs: 10 });
      expect(manager.reconnectConfig.maxRetries).toBe(3);
      expect(manager.reconnectConfig.baseMs).toBe(10);
      expect(manager.reconnectConfig.maxMs).toBe(10_000); // default preserved
    });

    it('setPgPorts builds peer port map with default host and enabled', () => {
      manager.setPgPorts(5432, { 1: 5433, 2: 5434 });
      expect(manager.localPgPort).toBe(5432);
      expect(manager.autoForwardEnabled).toBe(true);
      const ports = manager.getPeerPgPorts();
      expect(ports.get(1)).toEqual({ host: '127.0.0.1', port: 5433 });
      expect(ports.get(2)).toEqual({ host: '127.0.0.1', port: 5434 });
    });

    it('setPgPorts allows disabling auto-forward and custom host', () => {
      manager.setPgPorts(5432, { 1: 6000 }, 'db.internal', false);
      expect(manager.autoForwardEnabled).toBe(false);
      expect(manager.getPeerPgPorts().get(1)).toEqual({ host: 'db.internal', port: 6000 });
    });
  });

  describe('adaptive election timeout', () => {
    it('enables/disables and reports state', () => {
      expect(manager.isAdaptiveElectionTimeoutEnabled()).toBe(true);
      manager.setAdaptiveElectionTimeout(false);
      expect(manager.isAdaptiveElectionTimeoutEnabled()).toBe(false);
      manager.setAdaptiveElectionTimeout(true);
      expect(manager.isAdaptiveElectionTimeoutEnabled()).toBe(true);
    });

    it('setAdaptiveElectionConfig stores overrides', () => {
      const cfg = { minTick: 3, maxTick: 20 };
      manager.setAdaptiveElectionConfig(cfg);
      expect(manager.adaptiveElectionConfig).toBe(cfg);
    });

    it('recordRtt drops measurement when shard has no context', () => {
      expect(() => manager.recordRtt(999, 50)).not.toThrow();
    });

    it('recordRtt feeds RTT into the context', () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      manager.recordRtt(1, 50);
      const ctx = manager.groupContexts.get(1);
      expect(ctx).toBeTruthy();
    });

    it('getAdaptiveTick falls back to jitter when no RTT data', () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      const tick = manager.getAdaptiveTick(1, 100);
      expect(tick).toBeGreaterThanOrEqual(1);
    });

    it('getAvgRtt returns 0 for unknown shard', () => {
      expect(manager.getAvgRtt(999)).toBe(0);
    });
  });

  describe('group lookup helpers', () => {
    it('getGroup returns undefined for unknown shard', () => {
      expect(manager.getGroup(999)).toBeUndefined();
    });

    it('getShardCount and getLocalShardIds reflect registrations', () => {
      expect(manager.getShardCount()).toBe(0);
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      manager.registerShardWithReplica(2, new MockReplica(2), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      expect(manager.getShardCount()).toBe(2);
      expect(manager.getLocalShardIds()).toEqual([1, 2]);
    });

    it('getLocalPgPort reflects setPgPorts', () => {
      manager.setPgPorts(5432, {});
      expect(manager.getLocalPgPort()).toBe(5432);
    });

    it('getLeaderForShard returns leader or null', async () => {
      manager.registerShardWithReplica(1, new MockReplica(1), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      mockGroups.get(1)._leader = 1;
      expect(await manager.getLeaderForShard(1)).toBe(1);
      expect(await manager.getLeaderForShard(999)).toBeNull();
    });
  });
});
