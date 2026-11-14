/**
 * RaftGroup — pipeline, snapshot, leader-transfer, and quorum completion tests.
 *
 * Complements RaftGroup.more.test.ts (joint consensus + learner). Covers the
 * C5 pipeline flush/buffer machinery, snapshot lifecycle, C4 leader transfer,
 * flexible-quorum accessors, and a set of simple delegation/query methods that
 * RaftGroup.test.ts left unreached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRaftAdapter: any = {
  init: vi.fn().mockResolvedValue(undefined),
  propose: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  proposeAndWait: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  isLeader: vi.fn().mockResolvedValue(true),
  getLeader: vi.fn().mockResolvedValue(9),
  getTerm: vi.fn().mockResolvedValue(1),
  getProgress: vi.fn().mockResolvedValue({ commit: 5, applied: 5, lastLog: 5 }),
  getAppliedIndex: vi.fn().mockResolvedValue(5),
  setApplicationSnapshotHandlers: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ term: '1', lead: '1' }),
  getRetainedLogLength: vi.fn().mockResolvedValue(0),
  getSnapshotMeta: vi.fn().mockReturnValue(null),
  requestSnapshot: vi.fn().mockResolvedValue(null),
  // Present so the regression guard below can prove it is never called; the
  // group must not compact on its own authority.
  compactLogs: vi.fn().mockResolvedValue(undefined),
  resetCommittedCount: vi.fn(),
  shouldTakeSnapshot: vi.fn().mockReturnValue(false),
  stop: vi.fn(),
  setForceLeader: vi.fn(),
  campaign: vi.fn().mockResolvedValue(undefined),
  step: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue([]),
  addLearner: vi.fn().mockResolvedValue(true),
  transferLeadership: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../consensus/core/RaftAdapter', () => ({
  RaftAdapter: class MockRaftAdapter {
    static encodeSnapshotData(meta: any) {
      return Buffer.from(JSON.stringify(meta));
    }
    constructor(_config: any) {}
    init = mockRaftAdapter.init;
    propose = mockRaftAdapter.propose;
    proposeAndWait = mockRaftAdapter.proposeAndWait;
    isLeader = mockRaftAdapter.isLeader;
    getLeader = mockRaftAdapter.getLeader;
    getTerm = mockRaftAdapter.getTerm;
    getProgress = mockRaftAdapter.getProgress;
    getAppliedIndex = mockRaftAdapter.getAppliedIndex;
    setApplicationSnapshotHandlers = mockRaftAdapter.setApplicationSnapshotHandlers;
    getStatus = mockRaftAdapter.getStatus;
    getRetainedLogLength = mockRaftAdapter.getRetainedLogLength;
    getSnapshotMeta = mockRaftAdapter.getSnapshotMeta;
    requestSnapshot = mockRaftAdapter.requestSnapshot;
    compactLogs = mockRaftAdapter.compactLogs;
    resetCommittedCount = mockRaftAdapter.resetCommittedCount;
    shouldTakeSnapshot = mockRaftAdapter.shouldTakeSnapshot;
    stop = mockRaftAdapter.stop;
    setForceLeader = mockRaftAdapter.setForceLeader;
    campaign = mockRaftAdapter.campaign;
    step = mockRaftAdapter.step;
    read = mockRaftAdapter.read;
    addLearner = mockRaftAdapter.addLearner;
    transferLeadership = mockRaftAdapter.transferLeadership;
  },
}));

const MOCK_CONFIG = {
  id: 1,
  peers: [1, 2, 3],
  electionTick: 10,
  heartbeatTick: 2,
  tickIntervalMs: 100,
  snapshotInterval: 100,
  maxLogEntries: 0,
};

const MOCK_REPLICA = { apply: vi.fn() };
const MOCK_OUTBOX = { append: vi.fn() };

describe('RaftGroup — pipeline, snapshot, transfer, quorum', () => {
  let RaftGroup: any;
  let group: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../../consensus/core/RaftGroup');
    RaftGroup = mod.RaftGroup;
    group = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX);
  });

  afterEach(() => {
    if (group && typeof group.stop === 'function') group.stop();
  });

  describe('simple delegation and query methods', () => {
    it('setStorage delegates to raft custom storage', () => {
      const fakeStorage: any = { fake: 'storage' };
      group.setStorage(fakeStorage);
      expect((group.raft as any)._customStorage).toBe(fakeStorage);
    });

    it('getRaftAdapter returns the adapter', () => {
      expect(group.getRaftAdapter()).toBe(group.raft);
    });

    it('readSnapshotMeta exposes the boundary raft holds', () => {
      mockRaftAdapter.getSnapshotMeta.mockReturnValue({
        lastIncludedIndex: 12,
        lastIncludedTerm: 3,
        observedAt: 99,
      });
      expect(group.readSnapshotMeta()).toMatchObject({ lastIncludedIndex: 12, lastIncludedTerm: 3 });
    });

    it('applyFromEventBus delegates to replica', () => {
      (MOCK_REPLICA as any).applyFromEventBus = vi.fn().mockReturnValue(true);
      const entry = { msgId: 'm', type: 'exec', data: '{}' };
      expect(group.applyFromEventBus(entry)).toBe(true);
      expect((MOCK_REPLICA as any).applyFromEventBus).toHaveBeenCalledWith(entry);
    });

    it('setFencingManager stores the instance', () => {
      const fm: any = { receiveHeartbeat: vi.fn() };
      group.setFencingManager(fm);
      expect(group._fencingManager).toBe(fm);
    });

    it('clearActivePeerTracking clears the active set', () => {
      group.reportPeerActivity('2');
      expect(group.getActivePeers()).toHaveLength(1);
      group.clearActivePeerTracking();
      expect(group.getActivePeers()).toHaveLength(0);
    });

    it('isLeaderTransferInProgress reflects the flag', () => {
      expect(group.isLeaderTransferInProgress()).toBe(false);
      group.leaderTransferInProgress = true;
      expect(group.isLeaderTransferInProgress()).toBe(true);
    });
  });

  describe('flexible quorum', () => {
    it('isQuorumReached uses writeQuorum', () => {
      const r = group.isQuorumReached(2, 3);
      expect(r.type).toBe('write');
      expect(r.required).toBeGreaterThan(0);
      // writeQuorum default = majority of total (peers.length = 3 → 2)
      expect(r.quorumMet).toBe(true);
    });

    it('isReadQuorumReached uses readQuorum', () => {
      const r = group.isReadQuorumReached(1, 3);
      expect(r.type).toBe('read');
      expect(r.quorumMet).toBe(true);
    });

    it('isCommitQuorumReached uses commitQuorum', () => {
      const r = group.isCommitQuorumReached(2, 3);
      expect(r.type).toBe('commit');
      expect(r.quorumMet).toBe(true);
    });

    it('quorum accessors default to 1 when total is 0 (self-only)', () => {
      const w = group.isQuorumReached(0, 0);
      expect(w.required).toBe(1);
      expect(w.quorumMet).toBe(false);
    });

    it('getFlexQuorumConfig returns a copy', () => {
      const cfg = group.getFlexQuorumConfig();
      expect(cfg).toHaveProperty('writeQuorum');
      cfg.writeQuorum = 999;
      expect(group.getFlexQuorumConfig().writeQuorum).not.toBe(999);
    });
  });

  describe('pipeline', () => {
    it('getPipeline returns a shallow copy', () => {
      expect(group.getPipeline()).toEqual([]);
      expect(group.getPipelineDepth()).toBe(0);
      expect(group.getPipelineQueueDepth()).toBe(0);
    });

    it('getPipelineConfig returns a copy of config', () => {
      const cfg = group.getPipelineConfig();
      expect(cfg).toHaveProperty('batchSize');
      cfg.batchSize = 999;
      expect(group.getPipelineConfig().batchSize).not.toBe(999);
    });

    it('setPipelineConfig clamps values and restarts timer', async () => {
      await group.init();
      const before = group.pipelineFlushTimer;
      group.setPipelineConfig({ batchSize: 0, batchIntervalMs: 5 });
      expect(group.getPipelineConfig().batchSize).toBe(1); // clamped to 1
      expect(group.getPipelineConfig().batchIntervalMs).toBe(10); // clamped to 10
      expect(group.pipelineFlushTimer).not.toBe(before);
    });

    it('appendWithPipeline buffers entries and flushes on batch size', async () => {
      group.pipelineConfig = { ...group.getPipelineConfig(), batchSize: 2, maxPipelineQueueSize: 100 };
      mockRaftAdapter.propose.mockResolvedValue({ index: '1', term: '1' });
      await group.appendWithPipeline([
        { msgId: 'm1', type: 'exec', data: '{"x":1}' },
        { msgId: 'm2', type: 'exec', data: '{"y":2}' },
      ]);
      expect(mockRaftAdapter.propose).toHaveBeenCalled();
      expect(group.getPipelineDepth()).toBe(0); // flushed + acknowledged → cleared
    });

    it('appendWithPipeline throws BACKPRESSURE when exceeding max queue', async () => {
      group.pipelineConfig = { ...group.getPipelineConfig(), batchSize: 1000, maxPipelineQueueSize: 1 };
      await expect(
        group.appendWithPipeline([
          { msgId: 'm1', type: 'exec', data: '{"x":1}' },
          { msgId: 'm2', type: 'exec', data: '{"y":2}' },
        ]),
      ).rejects.toThrow('BACKPRESSURE');
    });

    it('flushPipeline flushes pending entries', async () => {
      group.pipelineConfig = { ...group.getPipelineConfig(), batchSize: 1000 };
      mockRaftAdapter.propose.mockResolvedValue({ index: '1', term: '1' });
      await group.appendWithPipeline([{ msgId: 'm1', type: 'exec', data: '{"x":1}' }]);
      await group.flushPipeline();
      expect(group.getPipelineDepth()).toBe(0);
    });

    it('flushPipeline is a no-op when pipeline is empty', async () => {
      await group.flushPipeline();
      expect(mockRaftAdapter.propose).not.toHaveBeenCalled();
    });

    it('forceFlush delegates to flushPipeline', async () => {
      await group.forceFlush();
      expect(mockRaftAdapter.propose).not.toHaveBeenCalled();
    });

    it('flushPipelineInternal keeps unacknowledged entries when nothing unflushed', async () => {
      group.pipeline = [{ index: 1, flushed: true, acknowledged: false, data: '{}', term: 1 }];
      await group.flushPipeline();
      // No unflushed entries → filter(!acknowledged) keeps the unacknowledged one.
      expect(group.getPipelineDepth()).toBe(1);
    });

    it('flushPipelineInternal appends acknowledged entries to outbox', async () => {
      mockRaftAdapter.propose.mockResolvedValue({ index: '5', term: '1' });
      group.pipeline = [
        {
          index: 5,
          flushed: false,
          acknowledged: false,
          data: JSON.stringify({ msgId: 'm5', type: 'exec', data: '{}' }),
          term: 1,
          sentAt: Date.now(),
        },
      ];
      await group.flushPipeline();
      expect(MOCK_OUTBOX.append).toHaveBeenCalled();
      expect(group.getPipelineDepth()).toBe(0);
    });

    it('flushPipelineInternal tolerates a failing propose', async () => {
      mockRaftAdapter.propose.mockRejectedValueOnce(new Error('raft down'));
      group.pipeline = [
        {
          index: 5,
          flushed: false,
          acknowledged: false,
          data: JSON.stringify({ msgId: 'm5', type: 'exec', data: '{}' }),
          term: 1,
          sentAt: Date.now(),
        },
      ];
      await group.flushPipeline();
      // Failed propose keeps entry unacknowledged → retained for retry.
      expect(group.getPipelineDepth()).toBe(1);
    });
  });

  describe('snapshot lifecycle', () => {
    it('reports no snapshot when raft holds none', () => {
      mockRaftAdapter.getSnapshotMeta.mockReturnValue(null);
      expect(group.snapshotExists()).toBe(false);
      expect(group.readSnapshotMeta()).toBeNull();
    });

    it('trySnapshot asks raft for a snapshot and takes exactly one', async () => {
      mockRaftAdapter.requestSnapshot.mockResolvedValue({
        lastIncludedIndex: 5,
        lastIncludedTerm: 1,
        observedAt: 1,
      });
      await group.trySnapshot();
      expect(mockRaftAdapter.requestSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not keep a second compaction path of its own', async () => {
      // Regression guard: the group used to call `compactLogs` itself, on the
      // strength of a metadata file that contained no state. That pair of calls is
      // what discarded 16 of 60 writes in AC-C7.
      //
      // The assertion is made against a spy that *exists*, not against `undefined`:
      // the previous version read `(group.raft as any).compactLogs` off a mock that
      // never defined it, so it passed no matter what the group called.
      await group.trySnapshot();
      await group.enforceLogLimit();
      expect(mockRaftAdapter.compactLogs).not.toHaveBeenCalled();
      expect(mockRaftAdapter.resetCommittedCount).not.toHaveBeenCalled();
      expect(mockRaftAdapter.shouldTakeSnapshot).not.toHaveBeenCalled();
    });

    it('enforceLogLimit is a no-op when maxLogEntries <= 0', async () => {
      await group.enforceLogLimit();
      expect(mockRaftAdapter.getProgress).not.toHaveBeenCalled();
    });

    it('enforceLogLimit forces a snapshot when the log exceeds the limit', async () => {
      group.maxLogEntries = 10;
      mockRaftAdapter.getProgress.mockResolvedValue({ lastLog: 100, applied: 80 });
      await group.enforceLogLimit();
      expect(mockRaftAdapter.requestSnapshot).toHaveBeenCalledTimes(1);
    });

    it('enforceLogLimit leaves a log inside the limit alone', async () => {
      group.maxLogEntries = 100;
      mockRaftAdapter.getProgress.mockResolvedValue({ lastLog: 100, applied: 80 });
      await group.enforceLogLimit();
      expect(mockRaftAdapter.requestSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('leader transfer', () => {
    it('transferLeadership rejects when already in progress', async () => {
      group.leaderTransferInProgress = true;
      const r = await group.transferLeadership('2');
      expect(r.success).toBe(false);
      expect(r.error).toContain('already in progress');
    });

    it('transferLeadership rejects when not leader', async () => {
      mockRaftAdapter.isLeader.mockResolvedValueOnce(false);
      const r = await group.transferLeadership('2');
      expect(r.success).toBe(false);
      expect(r.error).toContain('Only the leader');
    });

    it('transferLeadership succeeds when a new leader is elected', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      mockRaftAdapter.getLeader.mockResolvedValue(9); // different from self (1)
      const r = await group.transferLeadership('9');
      expect(r.success).toBe(true);
      expect(r.newLeader).toBe('9');
    });

    it('transferLeadership reports may-not-take-effect when leader unchanged', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      mockRaftAdapter.getLeader.mockResolvedValue(1); // still self
      vi.useFakeTimers();
      const p = group.transferLeadership('9');
      await vi.advanceTimersByTimeAsync(30 * 200);
      const r = await p;
      vi.useRealTimers();
      expect(r.success).toBe(true);
      expect(r.error).toContain('may not have taken effect');
    });

    it('transferLeadership catches transfer failure', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      mockRaftAdapter.transferLeadership.mockRejectedValueOnce(new Error('transfer failed'));
      const r = await group.transferLeadership('9');
      expect(r.success).toBe(false);
      expect(r.error).toContain('transfer failed');
    });

    it('transferLeadershipViaCampaign detects a new leader', async () => {
      mockRaftAdapter.getLeader.mockResolvedValue(9);
      const r = await group.transferLeadershipViaCampaign('9');
      expect(r.success).toBe(true);
      expect(r.newLeader).toBe('9');
    });

    it('transferLeadershipViaCampaign fails when no new leader detected', async () => {
      mockRaftAdapter.getLeader.mockResolvedValue(1); // stays self for all 30 polls
      vi.useFakeTimers();
      const p = group.transferLeadershipViaCampaign('9');
      await vi.advanceTimersByTimeAsync(30 * 200);
      const r = await p;
      vi.useRealTimers();
      expect(r.success).toBe(false);
      expect(r.error).toContain('no new leader detected');
    });

    it('transferLeadershipViaCampaign catches propose failure', async () => {
      mockRaftAdapter.propose.mockRejectedValueOnce(new Error('propose failed'));
      const r = await group.transferLeadershipViaCampaign('9');
      expect(r.success).toBe(false);
      expect(r.error).toContain('propose failed');
    });
  });

  describe('proposeAsync', () => {
    it('appends to outbox on success', async () => {
      mockRaftAdapter.propose.mockResolvedValue({ index: '7', term: '1' });
      const entry = { msgId: 'ma', type: 'exec', data: '{}' };
      group.proposeAsync(entry);
      await vi.waitFor(() => expect(MOCK_OUTBOX.append).toHaveBeenCalled());
    });

    it('logs and triggers health check on failure', async () => {
      mockRaftAdapter.propose.mockRejectedValueOnce(new Error('propose explode'));
      const onHealth = vi.fn();
      group._onHealthCheck = onHealth;
      const entry = { msgId: 'mb', type: 'exec', data: '{}' };
      group.proposeAsync(entry);
      await vi.waitFor(() => expect(onHealth).toHaveBeenCalled());
    });
  });
});
