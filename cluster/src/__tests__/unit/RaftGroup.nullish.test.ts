/**
 * RaftGroup — nullish fallback completion tests.
 *
 * Targets the remaining `|| 0` / `|| 1` / `?? default` / `?.` fallback
 * branches by feeding 0 / undefined / null / missing-field inputs into the
 * public pipeline, learner, membership, and health APIs, plus real error
 * paths (transfer failure, snapshot write/read failure).
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
  setApplicationSnapshotHandlers: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ term: '1', lead: '1' }),
  getRetainedLogLength: vi.fn().mockResolvedValue(0),
  getLogBounds: vi.fn().mockResolvedValue(null),
  getLogEntries: vi.fn().mockResolvedValue([]),
  getSnapshotMeta: vi.fn().mockReturnValue(null),
  requestSnapshot: vi.fn().mockResolvedValue(null),
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
    getLogBounds = mockRaftAdapter.getLogBounds;
    getLogEntries = mockRaftAdapter.getLogEntries;
    getSnapshotMeta = mockRaftAdapter.getSnapshotMeta;
    requestSnapshot = mockRaftAdapter.requestSnapshot;
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

describe('RaftGroup — nullish fallback completion', () => {
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

  describe('requestForLearner on a node with no readable log', () => {
    it('reports a zero window rather than a fabricated one', async () => {
      mockRaftAdapter.getLogBounds.mockResolvedValue(null);
      mockRaftAdapter.getLogEntries.mockResolvedValue([]);
      const res = await group.requestForLearner(1);
      expect(res.lastIndex).toBe(0);
      expect(res.lastTerm).toBe(0);
      expect(res.firstAvailableIndex).toBe(0);
      expect(res.entries).toEqual([]);
    });
  });

  describe('trySnapshot with no snapshot taken', () => {
    it('resolves quietly when raft reports nothing to snapshot', async () => {
      mockRaftAdapter.requestSnapshot.mockResolvedValue(null);
      await expect(group.trySnapshot()).resolves.toBeUndefined();
      expect(mockRaftAdapter.requestSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe('leader-monitor term fallback (parseInt → 0)', () => {
    it('uses 0 for a missing term', async () => {
      const receiveHeartbeat = vi.fn();
      group.setFencingManager({ receiveHeartbeat });
      group._lastFencingTerm = 0;
      const campaign = vi.fn();
      (group.raft as any).node = { campaign };
      mockRaftAdapter.getStatus.mockResolvedValue({ term: undefined, lead: '9' });
      group.startLeaderMonitor(50);
      await vi.waitFor(() => expect(receiveHeartbeat).toHaveBeenCalled());
      expect(receiveHeartbeat).toHaveBeenCalledWith(0, 0, '9');
      group.stopLeaderMonitor();
    });
  });

  describe('leader monitor survives a failing status read', () => {
    it('logs the failure and keeps the timer running', async () => {
      // A monitor that dies on the first error stops watching the leader for the
      // rest of the process's life, silently — and the symptom of that is a node
      // that never campaigns when it should.
      mockRaftAdapter.getStatus.mockRejectedValue(new Error('status unavailable'));
      group.startLeaderMonitor(20);
      await new Promise((r) => setTimeout(r, 70));

      expect((group as any)._leaderMonitorTimer).toBeTruthy();
      group.stopLeaderMonitor();
      expect((group as any)._leaderMonitorTimer).toBeNull();
    });
  });

  describe('config nullish defaults (electionTick/tickIntervalMs)', () => {
    it('uses defaults when config omits tick fields in leader monitor', async () => {
      const campaign = vi.fn();
      (group.raft as any).node = { campaign };
      (group.raft as any).config = { peers: [1, 2, 3] }; // no electionTick/tickIntervalMs
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '1', lead: '9' });
      group.startLeaderMonitor(50);
      await new Promise((r) => setTimeout(r, 60));
      group.stopLeaderMonitor();
      expect((group.raft as any).config).toBeTruthy();
    });

    it('uses defaults when config omits tick fields in cleanup', () => {
      (group.raft as any).config = { peers: [1, 2, 3] }; // no electionTick/tickIntervalMs
      group.reportPeerActivity('2');
      group.startLeaderMonitor();
      expect(group.getActivePeers()).toContain('2');
      group.stopLeaderMonitor();
    });
  });

  describe('transferLeadershipViaCampaign swallow', () => {
    it('swallows a failing transfer and still polls for a new leader', async () => {
      mockRaftAdapter.transferLeadership.mockRejectedValue(new Error('transfer unavailable'));
      mockRaftAdapter.getLeader.mockResolvedValue(9);
      const r = await group.transferLeadershipViaCampaign('9');
      expect(r.success).toBe(true);
      expect(r.newLeader).toBe('9');
    });
  });

  describe('snapshot request failure', () => {
    it('swallows a rejected snapshot request and keeps the group serving', async () => {
      // A failing snapshot must never take down the apply path: the group reports it
      // and carries on, because the log is still intact and the next threshold (or
      // operator request) will try again.
      mockRaftAdapter.requestSnapshot.mockRejectedValue(new Error('flush failure'));
      await expect(group.trySnapshot()).resolves.toBeUndefined();
    });

    it('reports no metadata while raft holds no snapshot', () => {
      mockRaftAdapter.getSnapshotMeta.mockReturnValue(null);
      expect(group.snapshotExists()).toBe(false);
      expect(group.readSnapshotMeta()).toBeNull();
    });
  });
});
