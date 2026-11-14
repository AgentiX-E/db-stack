/**
 * RaftGroupManager — IConsensusLayer interface, event emitter, health,
 * topology-change (joint consensus), learner management, leader transfer,
 * pipeline config, and batching.
 *
 * These coordinator-level methods were entirely uncovered (FNDA 0). Each is
 * exercised through the public API with a mocked RaftGroup to verify routing,
 * state aggregation, and error handling without real Raft/TCP/PG activity.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const mockGroups = new Map<number, any>();

vi.mock('../../consensus/core/RaftGroup', () => {
  return {
    RaftGroup: class MockRaftGroup {
      public shardId: number;
      public config: any;
      public replica: any;
      public outboxManager: any;
      public flexQuorum: any;
      public _leader: number | null = null;
      public _term = 1;
      public _progress: any = { commit: 5, applied: 5, lastLog: 5 };
      public _isLeaderCalled = 0;
      public _initArgs: any[] = [];
      public _stopped = false;
      public _storage: any = null;
      public _forceLeader = false;
      public _learnerCount = 0;
      public _phase: string = 'NORMAL';
      public _transferInProgress = false;
      public _health = { healthy: true, lastHeartbeatMs: 50, term: 1, leaderId: '1', leaderMonitorRunning: true };
      public _pipelineDepth = 3;
      public _readRows: any[] = [{ id: 1 }];
      public _isReadQuorum = vi.fn().mockReturnValue({ required: 2, quorumMet: true, commitQuorum: 2 });
      public _applyFromEventBusResult = true;
      public _membershipResult = { success: true, phase: 'NORMAL' };
      public _rollbackResult = true;
      public _addLearnerResult = true;
      public _removeLearnerResult = true;
      public _requestLearner = { entries: [], snapshotAvailable: false, lastIndex: 0, lastTerm: 0 };
      public _transferResult = { success: true, newLeader: '2', durationMs: 5 };
      public _proposeAndWaitCalls: any[] = [];
      public _proposeBatchCalls: any[][] = [];
      public _proposeCalls: any[] = [];
      public _raftAdapter = { flushApplyQueue: vi.fn() };

      constructor(shardId: number, config: any, replica: any, outboxManager: any, _snapshotDir?: any, pipelineConfig?: any, flexQuorum?: any) {
        this.shardId = shardId;
        this.config = config;
        this.replica = replica;
        this.outboxManager = outboxManager;
        this.flexQuorum = flexQuorum ?? { writeQuorum: 2, readQuorum: 1, commitQuorum: 2 };
        mockGroups.set(shardId, this);
      }

      async init(_sharedTransport?: any) { this._initArgs.push(_sharedTransport); }
      stop() { this._stopped = true; }
      async isLeader() { this._isLeaderCalled++; return this._leader === this.config?.id; }
      async getLeader() { return this._leader; }
      async getTerm() { return this._term; }
      async getProgress() { return this._progress; }
      async propose(entry: any) { this._proposeCalls.push(entry); return { index: '1', term: '1' }; }
      async proposeAndWait(entry: any) { this._proposeAndWaitCalls.push(entry); }
      async proposeBatch(entries: any[]) { this._proposeBatchCalls.push(entries); }
      async read(_sql: string, _params?: any[]) { return this._readRows; }
      isReadQuorumReached(...args: any[]) { return this._isReadQuorum(...args); }
      getLearnerCount() { return this._learnerCount; }
      setForceLeader(enabled: boolean) { this._forceLeader = enabled; }
      async campaign() {}
      getConsensusPhase() { return this._phase; }
      async rollbackMembershipChange() { return this._rollbackResult; }
      async addLearner(_nodeId: string) { return this._addLearnerResult; }
      removeLearner(_nodeId: string) { return this._removeLearnerResult; }
      async requestForLearner(fromIndex: number) { return { ...this._requestLearner, lastIndex: fromIndex }; }
      updateLearnerProgress(_nodeId: string, _matchedIndex: number) {}
      async transferLeadership(_target: string) { return this._transferResult; }
      isLeaderTransferInProgress() { return this._transferInProgress; }
      async getLeaderHealth() { return this._health; }
      getPipelineDepth() { return this._pipelineDepth; }
      setPipelineConfig(_config: any) {}
      async forceFlush() {}
      handleRaftMessage(_msg: any) {}
      async applyFromEventBus(_entry: any) { return this._applyFromEventBusResult; }
      startLeaderMonitor(_intervalMs?: number) {}
      stopLeaderMonitor() {}
      async proposeMembershipChange(_change: any) { return this._membershipResult; }
      async getState() { return {}; }
      getRaftAdapter() { return this._raftAdapter; }
      setStorage(s: any) { this._storage = s; }
      toString() { return `MockRaftGroup(${this.shardId})`; }
    },
  };
});

vi.mock('../../consensus/opt/AdaptiveElectionTimeout', () => ({
  AdaptiveElectionTimeout: class MockAET {
    constructor(public config: any) {}
    start() {}
    stop() {}
    recordRtt(_r: number) {}
    getSampleCount() { return 0; }
    getAvgRtt() { return 0; }
  },
}));

vi.mock('../../consensus/storage/SqliteStorage', () => ({
  SqliteStorage: class MockSqliteStorage {
    constructor(public cfg: any) {}
    open() {}
    close() {}
  },
}));

class MockReplica {
  constructor(public shardId: number) {}
}

describe('RaftGroupManager — interface/health/topology/learner/transfer/pipeline', () => {
  let RaftGroupManager: any;
  let manager: any;

  beforeEach(async () => {
    mockGroups.clear();
    vi.resetModules();
    const mod = await import('../../consensus/core/RaftGroupManager');
    RaftGroupManager = mod.RaftGroupManager;
    manager = new RaftGroupManager({}, 100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  function registerOne(shardId = 1): any {
    manager.registerShardWithReplica(shardId, new MockReplica(shardId), [{ nodeId: 'n1', raftIndex: shardId }], shardId);
    return mockGroups.get(shardId);
  }

  // ── IConsensusLayer interface ────────────────────────────────
  describe('IConsensusLayer interface methods', () => {
    it('isLeader returns false for unknown shard', async () => {
      expect(await manager.isLeader('999')).toBe(false);
    });

    it('isLeader delegates to group', async () => {
      const g = registerOne();
      g._leader = 1;
      expect(await manager.isLeader('1')).toBe(true);
    });

    it('getLeader returns null for unknown and string for known', async () => {
      expect(await manager.getLeader('999')).toBeNull();
      const g = registerOne();
      g._leader = 7;
      expect(await manager.getLeader('1')).toBe('7');
    });

    it('getCommitIndex returns 0 for unknown, commit for known', async () => {
      expect(await manager.getCommitIndex('999')).toBe(0);
      const g = registerOne();
      g._progress.commit = 42;
      expect(await manager.getCommitIndex('1')).toBe(42);
    });

    it('removeShard deregisters', async () => {
      registerOne();
      expect(manager.getShardCount()).toBe(1);
      await manager.removeShard('1');
      expect(manager.getShardCount()).toBe(0);
    });

    it('campaign throws for unknown, delegates for known', async () => {
      await expect(manager.campaign('999')).rejects.toThrow('not found');
      registerOne();
      await expect(manager.campaign('1')).resolves.toBeUndefined();
    });

    it('registerShard warns and skips without replica/peers', () => {
      registerOne;
      expect(() => manager.registerShard('888', {})).not.toThrow();
      expect(manager.getGroup(888)).toBeUndefined();
    });

    it('registerShard uses topology node id when available', () => {
      manager.setClusterTopology({ nodes: [], getNodeId: () => 'node-77' });
      manager.registerShard('5', { replica: new MockReplica(5), peers: [{ nodeId: 'x', raftIndex: 5 }], localRaftIndex: 0 });
      expect(manager.getGroup(5)).toBeTruthy();
    });
  });

  // ── propose (overloads) ──────────────────────────────────────
  describe('propose overloads', () => {
    it('throws for unknown numeric shard', async () => {
      await expect(manager.propose(999, { sql: 'x' })).rejects.toThrow('not found');
    });

    it('throws for unknown string shard', async () => {
      await expect(manager.propose('999', '{}')).rejects.toThrow('not found');
    });

    it('proposes on leader via string path and returns commit', async () => {
      const g = registerOne();
      g._leader = 1;
      g._progress.commit = 9;
      const result = await manager.propose('1', JSON.stringify({ sql: 'SELECT 1' }));
      expect(result).toBe(9);
      expect(g._proposeCalls.length).toBe(1);
    });

    it('throws when not leader and auto-forward disabled (string)', async () => {
      registerOne();
      manager.autoForwardEnabled = false;
      await expect(manager.propose('1', '{}')).rejects.toThrow('not the Raft leader');
    });

    it('proposes directly on leader via numeric path', async () => {
      const g = registerOne();
      g._leader = 1;
      manager.localPgPort = 5432;
      await manager.propose(1, { sql: 'x' });
      expect(g._proposeCalls.length).toBe(1);
    });

    it('proposeAndWait throws for unknown shard', async () => {
      await expect(manager.proposeAndWait(999, {})).rejects.toThrow('not found');
    });

    it('proposeAndWait delegates when leader', async () => {
      const g = registerOne();
      g._leader = 1;
      await manager.proposeAndWait(1, { sql: 'y' });
      expect(g._proposeAndWaitCalls.length).toBe(1);
    });

    it('proposeAndWait throws when not leader and forwarding disabled', async () => {
      const g = registerOne();
      g._leader = null;
      manager.autoForwardEnabled = false;
      vi.useFakeTimers();
      // Attach the rejection assertion BEFORE advancing timers so the retry
      // loop's eventual throw is already observed (avoids an unhandled
      // rejection when the 50x10ms backoff resolves under fake timers).
      const p = manager.proposeAndWait(1, { sql: 'y' });
      const assertion = expect(p).rejects.toThrow('not the Raft leader');
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      vi.useRealTimers();
    });
  });

  // ── proposeBatch + batching ──────────────────────────────────
  describe('proposeBatch', () => {
    it('throws for unknown shard', async () => {
      await expect(manager.proposeBatch(999, [{}])).rejects.toThrow('not found');
    });

    it('delegates to group when leader', async () => {
      const g = registerOne();
      g._leader = 1;
      await manager.proposeBatch(1, [{ data: { sql: 'a' } }]);
      expect(g._proposeBatchCalls.length).toBe(1);
    });

    it('throws when not leader and forwarding disabled', async () => {
      const g = registerOne();
      g._leader = null;
      manager.autoForwardEnabled = false;
      await expect(manager.proposeBatch(1, [{ data: { sql: 'a' } }])).rejects.toThrow('not the Raft leader');
    });
  });

  // ── read / proposeRead / applyFromEventBus ───────────────────
  describe('read routing', () => {
    it('read throws for unknown shard', async () => {
      await expect(manager.read(999, 'SELECT 1')).rejects.toThrow('not found');
    });

    it('read delegates and returns rows', async () => {
      registerOne();
      const rows = await manager.read(1, 'SELECT 1');
      expect(rows).toEqual([{ id: 1 }]);
    });

    it('proposeRead throws for unknown shard', async () => {
      await expect(manager.proposeRead(999, 'SELECT 1')).rejects.toThrow('not found');
    });

    it('proposeRead leader path (linearizable)', async () => {
      const g = registerOne();
      g._leader = 1;
      manager.localPgPort = 5432;
      const r = await manager.proposeRead(1, 'SELECT 1');
      expect(r.rows).toEqual([{ id: 1 }]);
      expect(r.quorumResult).toBeTruthy();
    });

    it('proposeRead follower stale-read path (readQuorum <= 1)', async () => {
      const g = registerOne();
      g._leader = null;
      g.flexQuorum = { writeQuorum: 2, readQuorum: 1, commitQuorum: 2 };
      const r = await manager.proposeRead(1, 'SELECT 1');
      expect(r.rows).toEqual([{ id: 1 }]);
    });

    it('proposeRead follower throws when readQuorum > 1', async () => {
      const g = registerOne();
      g._leader = null;
      g.flexQuorum = { writeQuorum: 2, readQuorum: 2, commitQuorum: 2 };
      await expect(manager.proposeRead(1, 'SELECT 1')).rejects.toThrow('readQuorum > 1');
    });

    it('applyFromEventBus returns false for unknown, delegates for known', async () => {
      expect(await manager.applyFromEventBus(999, {})).toBe(false);
      const g = registerOne();
      g._applyFromEventBusResult = true;
      expect(await manager.applyFromEventBus(1, {})).toBe(true);
    });
  });

  // ── handleRaftMessage ─────────────────────────────────────────
  describe('handleRaftMessage', () => {
    it('routes to group when present', () => {
      const g = registerOne();
      const spy = vi.spyOn(g, 'handleRaftMessage');
      manager.handleRaftMessage(1, { msgType: 3, from: 2 });
      expect(spy).toHaveBeenCalled();
    });

    it('ignores message for unknown group without throwing', () => {
      expect(() => manager.handleRaftMessage(999, { msgType: 3 })).not.toThrow();
    });

    it('records RTT on AppendEntries response (msgType=4)', () => {
      registerOne();
      manager.handleRaftMessage(1, { msgType: 4, from: 2 });
      // First contact: no prior timestamp, so no RTT, but timestamp stored.
      manager.handleRaftMessage(1, { msgType: 4, from: 2 });
      expect(manager._peerLastRecvTimestamps.has('2')).toBe(true);
    });
  });

  // ── health / peer status ──────────────────────────────────────
  describe('health & peer status', () => {
    it('getHealthStatus aggregates per-shard', async () => {
      const g = registerOne();
      g._leader = 1;
      const results = await manager.getHealthStatus();
      expect(results).toHaveLength(1);
      expect(results[0].shardId).toBe(1);
      expect(results[0].isLeader).toBe(true);
    });

    it('getHealthStatus catches per-shard error', async () => {
      const g = registerOne();
      g.isLeader = vi.fn().mockRejectedValue(new Error('boom'));
      const results = await manager.getHealthStatus();
      expect(results[0].error).toBe('boom');
      expect(results[0].isLeader).toBe(false);
    });

    it('getPeerStatus filters self and reports learners', () => {
      const g = registerOne();
      g._learnerCount = 2;
      const results = manager.getPeerStatus();
      expect(results[0].peers).toEqual([]); // self filtered out
      expect(results[0].learnerCount).toBe(2);
    });

    it('getStats aggregates term/progress', async () => {
      registerOne();
      const stats = await manager.getStats();
      expect(stats[1].term).toBe(1);
      expect(stats[1].progress.commit).toBe(5);
    });

    it('getLeaderHealthStatus aggregates health', async () => {
      registerOne();
      const results = await manager.getLeaderHealthStatus();
      expect(results[0].healthy).toBe(true);
      expect(results[0].leaderId).toBe('1');
    });

    it('getLeaderHealthStatus catches error', async () => {
      const g = registerOne();
      g.getLeaderHealth = vi.fn().mockRejectedValue(new Error('bad'));
      const results = await manager.getLeaderHealthStatus();
      expect(results[0].healthy).toBe(false);
      expect(results[0].lastHeartbeatMs).toBe(-1);
    });

    it('getLeaderHealthSummary computes aggregate', async () => {
      registerOne();
      const s = await manager.getLeaderHealthSummary();
      expect(s.totalGroups).toBe(1);
      expect(s.healthyGroups).toBe(1);
      expect(s.leaderCount).toBe(1);
    });
  });

  // ── topology change / joint consensus ─────────────────────────
  describe('topology change', () => {
    it('notifyTopologyChange two-arg returns map of results', async () => {
      const g = registerOne();
      g._membershipResult = { success: true, phase: 'NORMAL' };
      const results = await manager.notifyTopologyChange([{ nodeId: 'n1', raftIndex: 1 }], 1);
      expect(results).toBeInstanceOf(Map);
      expect(results.get(1).success).toBe(true);
    });

    it('notifyTopologyChange single-arg (interface) path', async () => {
      registerOne();
      await expect(
        manager.notifyTopologyChange({ type: 'add', nodeId: '1', shardId: 1 }),
      ).resolves.toBeUndefined();
    });

    it('topology change catches per-group error', async () => {
      const g = registerOne();
      g.proposeMembershipChange = vi.fn().mockRejectedValue(new Error('consensus fail'));
      const results = await manager.notifyTopologyChange([{ nodeId: 'n1', raftIndex: 1 }], 1);
      expect(results.get(1).success).toBe(false);
      expect(results.get(1).error).toBe('consensus fail');
    });

    it('getConsensusPhase returns null for unknown', () => {
      expect(manager.getConsensusPhase(999)).toBeNull();
      const g = registerOne();
      g._phase = 'JOINT';
      expect(manager.getConsensusPhase(1)).toBe('JOINT');
    });

    it('rollbackMembershipChange returns false unknown / delegates known', async () => {
      expect(await manager.rollbackMembershipChange(999)).toBe(false);
      const g = registerOne();
      g._rollbackResult = true;
      expect(await manager.rollbackMembershipChange(1)).toBe(true);
    });
  });

  // ── learner management ────────────────────────────────────────
  describe('learner management', () => {
    it('addShardLearner false for unknown', async () => {
      expect(await manager.addShardLearner(999, 'x')).toBe(false);
    });

    it('addShardLearner delegates', async () => {
      const g = registerOne();
      g._addLearnerResult = true;
      expect(await manager.addShardLearner(1, 'x')).toBe(true);
    });

    it('removeShardLearner false for unknown', () => {
      expect(manager.removeShardLearner(999, 'x')).toBe(false);
    });

    it('addLearners returns false array for unknown', async () => {
      expect(await manager.addLearners(999, ['a', 'b'])).toEqual([false, false]);
    });

    it('removeLearners returns false array for unknown', () => {
      expect(manager.removeLearners(999, ['a', 'b'])).toEqual([false, false]);
    });

    it('getShardLearnerCount / getTotalLearnerCount', () => {
      expect(manager.getShardLearnerCount(999)).toBe(0);
      const g = registerOne();
      g._learnerCount = 3;
      expect(manager.getShardLearnerCount(1)).toBe(3);
      expect(manager.getTotalLearnerCount()).toBe(3);
    });

    it('requestForLearner returns empty for unknown', async () => {
      const r = await manager.requestForLearner(999, 0);
      expect(r.entries).toEqual([]);
    });

    it('updateLearnerProgress no-op for unknown', () => {
      expect(() => manager.updateLearnerProgress(999, 'x', 1)).not.toThrow();
    });
  });

  // ── leader transfer ───────────────────────────────────────────
  describe('leader transfer', () => {
    it('transferGroupLeadership error for unknown', async () => {
      const r = await manager.transferGroupLeadership(999, '2');
      expect(r.success).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('transferGroupLeadership delegates', async () => {
      registerOne();
      const r = await manager.transferGroupLeadership(1, '2');
      expect(r.success).toBe(true);
      expect(r.newLeader).toBe('2');
    });

    it('isLeaderTransferInProgress false unknown / delegates', () => {
      expect(manager.isLeaderTransferInProgress(999)).toBe(false);
      const g = registerOne();
      g._transferInProgress = true;
      expect(manager.isLeaderTransferInProgress(1)).toBe(true);
    });
  });

  // ── leader monitor + event emitter ────────────────────────────
  describe('leader monitor + events', () => {
    it('startAllLeaderMonitors / stopAllLeaderMonitors', () => {
      registerOne();
      expect(() => manager.startAllLeaderMonitors()).not.toThrow();
      expect(() => manager.startAllLeaderMonitors(500)).not.toThrow();
      expect(() => manager.stopAllLeaderMonitors()).not.toThrow();
    });

    it('on/off generic events', () => {
      const h = vi.fn();
      manager.on('leader-change', h);
      manager.emitLeaderChange('1', 2, 1);
      expect(h).toHaveBeenCalledWith('1', 2, 1);
      manager.off('leader-change', h);
      manager.emitLeaderChange('1', 3, 1);
      expect(h).toHaveBeenCalledTimes(1);
    });

    it('onLeaderChange / offLeaderChange', () => {
      const h = vi.fn();
      manager.onLeaderChange(h);
      manager.emitLeaderChange('2', 5, 3);
      expect(h).toHaveBeenCalledWith('2', 5, 3);
      manager.offLeaderChange(h);
    });

    it('onClusterTopologyChange / offClusterTopologyChange', () => {
      const h = vi.fn();
      manager.onClusterTopologyChange(h);
      manager.emitClusterTopologyChange(['a', 'b']);
      expect(h).toHaveBeenCalledWith(['a', 'b']);
      manager.offClusterTopologyChange(h);
    });

    it('onHealthChange / offHealthChange', () => {
      const h = vi.fn();
      manager.onHealthChange(h);
      manager.emitHealthChange('1', false, 2);
      expect(h).toHaveBeenCalledWith('1', false, 2);
      manager.offHealthChange(h);
    });
  });

  // ── pipeline config / flush ───────────────────────────────────
  describe('pipeline', () => {
    it('setGlobalPipelineConfig delegates', () => {
      registerOne();
      expect(() => manager.setGlobalPipelineConfig({ batchSize: 10 })).not.toThrow();
    });

    it('forceGlobalPipelineFlush awaits all groups', async () => {
      registerOne(1);
      registerOne(2);
      await expect(manager.forceGlobalPipelineFlush()).resolves.toBeUndefined();
    });

    it('flushApplyQueue best-effort per group', () => {
      registerOne();
      expect(() => manager.flushApplyQueue()).not.toThrow();
    });
  });

  // ── force leader + stop + start ───────────────────────────────
  describe('force leader / start / stop', () => {
    it('setForceLeader iterates groups', () => {
      const g = registerOne();
      manager.setForceLeader(true);
      expect(g._forceLeader).toBe(true);
      manager.setForceLeader(false);
      expect(g._forceLeader).toBe(false);
    });

    it('start initializes groups and starts monitors', async () => {
      const g = registerOne();
      manager.setSharedTransport({ send: vi.fn() });
      await manager.start();
      expect(g._initArgs.length).toBe(1);
      expect(manager._reconnectMonitorTimer).toBeTruthy();
      expect(manager._pgPoolCleanupTimer).toBeTruthy();
      await manager.stop();
      expect(manager._reconnectMonitorTimer).toBeNull();
      expect(manager._pgPoolCleanupTimer).toBeNull();
    });

    it('start creates SqliteStorage when storagePath set without storage', async () => {
      const g = registerOne();
      const config = manager.groupConfigs.get(1);
      config.storagePath = '/tmp/test.db';
      await manager.start();
      expect(g._storage).toBeTruthy();
      await manager.stop();
    });

    it('stop cleans pg pool and reconnect state', async () => {
      registerOne();
      manager.peerReconnectState.set('p', { peerId: 'p', attempt: 0, timer: setTimeout(() => {}, 1000) });
      await manager.stop();
      expect(manager.peerReconnectState.size).toBe(0);
      expect(manager.groups.size).toBe(0);
    });
  });
});
