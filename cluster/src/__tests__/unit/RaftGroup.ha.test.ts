/**
 * RaftGroup — HA (split-brain, fencing, read-only), stopped-guards, and
 * flexible-quorum completion tests.
 *
 * Covers the high-availability branch surface reachable only through:
 *   - propose/proposeBatch/proposeAndWait after stop() (stopped guards)
 *   - isInMajority single-node early return
 *   - enterReadOnlyMode idempotency + leader step-down (success & failure)
 *   - fencingRequest throttle + majority pass/fail
 *   - leader monitor heartbeat timeout + stale-term rejection + campaign
 *   - getSplitBrainStatus peer-count nullish fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRaftAdapter: any = {
  init: vi.fn().mockResolvedValue(undefined),
  propose: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  proposeAndWait: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  isLeader: vi.fn().mockResolvedValue(true),
  getLeader: vi.fn().mockResolvedValue(9),
  getTerm: vi.fn().mockResolvedValue(2),
  getProgress: vi.fn().mockResolvedValue({ commit: 5, applied: 5, lastLog: 5 }),
  getAppliedIndex: vi.fn().mockResolvedValue(5),
  getStatus: vi.fn().mockResolvedValue({ term: '1', lead: '1' }),
  getRetainedLogLength: vi.fn().mockResolvedValue(0),
  shouldTakeSnapshot: vi.fn().mockReturnValue(false),
  takeSnapshot: vi.fn(),
  resetCommittedCount: vi.fn(),
  compactLogs: vi.fn().mockResolvedValue(undefined),
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
    getStatus = mockRaftAdapter.getStatus;
    getRetainedLogLength = mockRaftAdapter.getRetainedLogLength;
    shouldTakeSnapshot = mockRaftAdapter.shouldTakeSnapshot;
    takeSnapshot = mockRaftAdapter.takeSnapshot;
    resetCommittedCount = mockRaftAdapter.resetCommittedCount;
    compactLogs = mockRaftAdapter.compactLogs;
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

describe('RaftGroup — HA, stopped-guards, and fallback branches', () => {
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
    vi.useRealTimers();
    if (group && typeof group.stop === 'function') group.stop();
  });

  describe('stopped guards', () => {
    it('propose throws after stop', async () => {
      group.stop();
      await expect(group.propose({ msgId: 'm', type: 'exec', data: '{}' })).rejects.toThrow(
        'group already stopped',
      );
    });

    it('proposeBatch throws after stop', async () => {
      group.stop();
      await expect(group.proposeBatch([{ msgId: 'm', type: 'exec', data: '{}' }])).rejects.toThrow(
        'group already stopped',
      );
    });

    it('proposeAndWait throws after stop', async () => {
      group.stop();
      await expect(group.proposeAndWait({ msgId: 'm', type: 'exec', data: '{}' })).rejects.toThrow(
        'group already stopped',
      );
    });
  });

  describe('isInMajority', () => {
    it('single-node cluster is always in majority', () => {
      const solo = new RaftGroup(0, { ...MOCK_CONFIG, peers: [1] }, MOCK_REPLICA, MOCK_OUTBOX);
      (solo.raft as any).config = { peers: [1], electionTick: 10, tickIntervalMs: 100 };
      expect(solo.isInMajority()).toBe(true);
    });

    it('returns true when config is absent', () => {
      delete (group.raft as any).config;
      expect(group.isInMajority()).toBe(true);
    });
  });

  describe('enterReadOnlyMode', () => {
    it('is idempotent when already read-only', async () => {
      group._readOnly = true;
      await group.enterReadOnlyMode();
      expect(mockRaftAdapter.isLeader).not.toHaveBeenCalled();
      expect(group.isReadOnly()).toBe(true);
    });

    it('sets read-only and steps down the leader', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      const stepDown = vi.fn().mockResolvedValue(undefined);
      (group.raft as any).node = { stepDown };
      await group.enterReadOnlyMode();
      expect(group.isReadOnly()).toBe(true);
      expect(group._fencingState).toBe('minority');
      expect(stepDown).toHaveBeenCalledWith(5000);
    });

    it('swallows step-down failure', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      const stepDown = vi.fn().mockRejectedValue(new Error('cannot step down'));
      (group.raft as any).node = { stepDown };
      await expect(group.enterReadOnlyMode()).resolves.toBeUndefined();
      expect(group.isReadOnly()).toBe(true);
    });

    it('does not step down when not leader', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(false);
      await group.enterReadOnlyMode();
      expect(group.isReadOnly()).toBe(true);
      expect((group.raft as any).node).toBeUndefined();
    });
  });

  describe('fencingRequest', () => {
    it('returns previous result when throttled', async () => {
      group._lastFencingCheck = Date.now();
      group._readOnly = false;
      const r = await group.fencingRequest(false);
      expect(r).toBe(true); // !readOnly
      expect(group._fencingState).not.toBe('fencing');
    });

    it('bypasses throttle when force=true', async () => {
      (group.raft as any).config = { peers: [1, 2, 3], electionTick: 10, tickIntervalMs: 100 };
      group._lastFencingCheck = Date.now();
      group._readOnly = false;
      // 3 peers → need > 1.5 active; none active → minority → enter read-only.
      mockRaftAdapter.isLeader.mockResolvedValue(false);
      const r = await group.fencingRequest(true);
      expect(r).toBe(false);
      expect(group._fencingState).toBe('minority');
    });

    it('passes when in majority', async () => {
      (group.raft as any).config = { peers: [1, 2, 3], electionTick: 10, tickIntervalMs: 100 };
      group.reportPeerActivity('2');
      group.reportPeerActivity('3');
      const r = await group.fencingRequest(true);
      expect(r).toBe(true);
      expect(group._fencingState).toBe('normal');
      expect(group.isReadOnly()).toBe(false);
    });
  });

  describe('getSplitBrainStatus', () => {
    it('returns a full status summary', () => {
      (group.raft as any).config = { peers: [1, 2, 3], electionTick: 10, tickIntervalMs: 100 };
      group.reportPeerActivity('2');
      const s = group.getSplitBrainStatus();
      expect(s).toHaveProperty('inMajority');
      expect(s).toHaveProperty('readOnly');
      expect(s).toHaveProperty('connectedPeers');
      expect(s).toHaveProperty('totalPeers');
      expect(s).toHaveProperty('fencingState');
      expect(s.connectedPeers).toBe(1);
      expect(s.totalPeers).toBe(3);
    });

    it('falls back to totalPeers=1 when config is absent', () => {
      delete (group.raft as any).config;
      const s = group.getSplitBrainStatus();
      expect(s.totalPeers).toBe(1);
    });
  });

  describe('leader monitor', () => {
    it('returns early when node is absent', () => {
      delete (group.raft as any).node;
      group.startLeaderMonitor(50);
      expect(group._leaderMonitorTimer).toBeTruthy();
      group.stopLeaderMonitor();
    });

    it('returns early when status is null', async () => {
      (group.raft as any).node = { campaign: vi.fn() };
      mockRaftAdapter.getStatus.mockResolvedValue(null);
      group.startLeaderMonitor(50);
      await new Promise((r) => setTimeout(r, 60));
      expect(mockRaftAdapter.campaign).not.toHaveBeenCalled();
      group.stopLeaderMonitor();
    });

    it('triggers campaign on heartbeat timeout', async () => {
      const campaign = vi.fn().mockResolvedValue(undefined);
      (group.raft as any).node = { campaign };
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '1', lead: '0' }); // lead '0' → no heartbeat update
      group._leaderHeartbeatTs = Date.now() - 60_000;
      group.startLeaderMonitor(50);
      await vi.waitFor(() => expect(campaign).toHaveBeenCalled());
      group.stopLeaderMonitor();
    });

    it('forwards heartbeat to fencing manager on non-stale term', async () => {
      const receiveHeartbeat = vi.fn();
      group.setFencingManager({ receiveHeartbeat });
      group._lastFencingTerm = 1;
      const campaign = vi.fn();
      (group.raft as any).node = { campaign };
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '2', lead: '9' });
      group.startLeaderMonitor(50);
      await vi.waitFor(() => expect(receiveHeartbeat).toHaveBeenCalled());
      expect(receiveHeartbeat).toHaveBeenCalledWith(0, 2, '9');
      group.stopLeaderMonitor();
    });

    it('rejects stale heartbeat (lower term)', async () => {
      const receiveHeartbeat = vi.fn();
      group.setFencingManager({ receiveHeartbeat });
      group._lastFencingTerm = 5;
      const campaign = vi.fn();
      (group.raft as any).node = { campaign };
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '3', lead: '9' });
      group.startLeaderMonitor(50);
      await new Promise((r) => setTimeout(r, 120));
      // Stale term (3 < 5) → heartbeat rejected, never forwarded to fencing.
      expect(receiveHeartbeat).not.toHaveBeenCalled();
      expect(group._lastFencingTerm).toBe(5); // unchanged
      group.stopLeaderMonitor();
    });
  });
});
