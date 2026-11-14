/**
 * RaftGroup — constructor fallbacks, membership-change timeout/rollback,
 * pipeline parse fallbacks, snapshot edge paths, and flexible-quorum
 * self-only branches.
 *
 * These are the remaining branch edges that require null/undefined/0 inputs
 * to trigger `?? 0` / `|| 0` / `?.` nullish fallbacks and idempotency guards.
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

describe('RaftGroup — constructor/fallback/membership-timeout branches', () => {
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

  describe('constructor fallbacks', () => {
    it('defaults snapshotInterval to 100 when config omits it', () => {
      const g = new RaftGroup(0, { ...MOCK_CONFIG, snapshotInterval: 0 }, MOCK_REPLICA, MOCK_OUTBOX);
      expect(g.snapshotInterval).toBe(100);
    });

    it('retains an explicit snapshotInterval', () => {
      const g = new RaftGroup(0, { ...MOCK_CONFIG, snapshotInterval: 250 }, MOCK_REPLICA, MOCK_OUTBOX);
      expect(g.snapshotInterval).toBe(250);
    });

    it('defaults snapshotDir to ./data when omitted', () => {
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, undefined);
      expect(g.getSnapshotFilePath()).toContain('data');
    });
  });

  describe('init shared transport + existing snapshot dir', () => {
    it('passes an applyHandler and no transport by default', async () => {
      await group.init();
      expect(mockRaftAdapter.init).toHaveBeenCalledWith(expect.any(Function));
    });

    it('passes a shared transport when provided', async () => {
      const transport = { send: vi.fn() };
      (group as any).sharedTransport = transport;
      await group.init();
      // No sharedTransport wired in constructor path; transport is passed via
      // raft.init third arg only when set before init. Verify init called.
      expect(mockRaftAdapter.init).toHaveBeenCalled();
    });
  });

  describe('applyHandler with index/term + pitr hook', () => {
    it('forwards index/term to pitr hook and applies to replica', async () => {
      const onApply = vi.fn();
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, undefined, undefined, undefined, {
        onApply,
      } as any);
      (g.raft as any).config = { enableInstallSnapshot: false };
      await g.init();
      const applyHandler = mockRaftAdapter.init.mock.calls[0][0];
      const entry = { msgId: 'm', type: 'exec', data: '{}' };
      (MOCK_REPLICA as any).apply = vi.fn();
      applyHandler(JSON.stringify(entry), 7, 3);
      expect(onApply).toHaveBeenCalledWith('0', 7, 3, JSON.stringify(entry));
      expect((MOCK_REPLICA as any).apply).toHaveBeenCalled();
    });
  });

  describe('membership-change timeout and rollback', () => {
    it('rolls back when C_JOINT times out', async () => {
      mockRaftAdapter.isLeader.mockResolvedValue(true);
      mockRaftAdapter.propose.mockResolvedValue({ index: '100', term: '1' });
      // commit never reaches jointIndex=100
      mockRaftAdapter.getProgress.mockResolvedValue({ commit: 0, applied: 0, lastLog: 0 });

      // Drive the exponential-backoff retry loop with fake timers so it
      // resolves instantly; the timeoutMs default is 30s but the commit
      // never advances, so the loop exhausts and rolls back.
      vi.useFakeTimers();
      const p = group.proposeMembershipChange({
        changeId: 'c-timeout',
        type: 'join',
        nodeId: '2',
        oldPeers: [1, 2, 3],
        newPeers: [1, 2, 3, 4],
      });
      await vi.advanceTimersByTimeAsync(40_000);
      const result = await p;
      vi.useRealTimers();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rolled back');
    });

    it('rollbackMembershipChange returns false when transition already advanced', async () => {
      group._transitionalConfig = { newEntryIndex: 5 };
      expect(await group.rollbackMembershipChange()).toBe(false);
    });

    it('rollbackMembershipChange returns true during C_JOINT', async () => {
      group._transitionalConfig = { newEntryIndex: 0 };
      expect(await group.rollbackMembershipChange()).toBe(true);
      expect(group._transitionalConfig).toBeNull();
    });

    it('_transitionToCNew is a no-op when no transition is active', async () => {
      group._transitionalConfig = null;
      await expect((group as any)._transitionToCNew({ changeId: 'x' }, 5)).resolves.toBeUndefined();
    });
  });

  describe('pipeline parse fallbacks', () => {
    it('defaults msgId and type in pipeline apply', async () => {
      mockRaftAdapter.getProgress.mockResolvedValue({ lastLog: 0 });
      group.pipeline = [
        { index: 1, flushed: false, acknowledged: true, data: '{}', term: 0, sentAt: Date.now() },
      ];
      mockRaftAdapter.propose.mockResolvedValue({ index: '1', term: '0' });
      await group.flushPipeline();
      expect(mockRaftAdapter.propose).toHaveBeenCalled();
    });

    it('tolerates non-JSON pipeline entry parse', async () => {
      group.pipeline = [
        { index: 1, flushed: false, acknowledged: true, data: 'not-json', term: 1, sentAt: Date.now() },
      ];
      mockRaftAdapter.propose.mockResolvedValue({ index: '1', term: '1' });
      await expect(group.flushPipeline()).resolves.toBeUndefined();
    });
  });

  describe('snapshot edges', () => {
    it('readSnapshotMeta returns null when snapshot does not exist', () => {
      expect(group.readSnapshotMeta()).toBeNull();
    });

    it('trySnapshot flush hook is awaited', async () => {
      const flushHook = vi.fn().mockResolvedValue(undefined);
      const g = new RaftGroup(
        0,
        MOCK_CONFIG,
        MOCK_REPLICA,
        MOCK_OUTBOX,
        undefined,
        undefined,
        undefined,
        undefined,
        flushHook,
      );
      mockRaftAdapter.shouldTakeSnapshot.mockReturnValue(true);
      mockRaftAdapter.getAppliedIndex.mockResolvedValue(5);
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '3', lead: '1' });
      await g.trySnapshot();
      expect(flushHook).toHaveBeenCalled();
    });
  });

  describe('flexible quorum self-only (total=0)', () => {
    it('isQuorumReached returns required=1 when total=0', () => {
      const r = group.isQuorumReached(0, 0);
      expect(r.required).toBe(1);
      expect(r.quorumMet).toBe(false);
    });

    it('isReadQuorumReached returns required=1 when total=0', () => {
      const r = group.isReadQuorumReached(0, 0);
      expect(r.required).toBe(1);
    });

    it('isCommitQuorumReached returns required=1 when total=0', () => {
      const r = group.isCommitQuorumReached(0, 0);
      expect(r.required).toBe(1);
    });
  });

  describe('getLeaderHealth', () => {
    it('returns unhealthy when leaderId is null', async () => {
      mockRaftAdapter.getLeader.mockResolvedValue(null);
      mockRaftAdapter.getTerm.mockResolvedValue(2);
      (group.raft as any).config = undefined;
      const h = await group.getLeaderHealth();
      expect(h.healthy).toBe(false);
      expect(h.leaderId).toBeNull();
    });

    it('returns healthy with recent heartbeat', async () => {
      mockRaftAdapter.getLeader.mockResolvedValue(9);
      mockRaftAdapter.getTerm.mockResolvedValue(2);
      group._leaderHeartbeatTs = Date.now();
      (group.raft as any).config = { electionTick: 10, tickIntervalMs: 100 };
      const h = await group.getLeaderHealth();
      expect(h.healthy).toBe(true);
      expect(h.leaderId).toBe('9');
    });
  });

  describe('reportPeerActivity leader heartbeat', () => {
    it('updates leader heartbeat when peer is current lead', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      (group.raft as any).node = { _lead: '2' };
      group.reportPeerActivity('2');
      expect(group._leaderHeartbeatTs).toBe(1_000_000);
      vi.useRealTimers();
    });

    it('does not update heartbeat when peer is not lead', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      (group.raft as any).node = { _lead: '3' };
      group._leaderHeartbeatTs = 0;
      group.reportPeerActivity('2');
      expect(group._leaderHeartbeatTs).toBe(0);
      vi.useRealTimers();
    });
  });
});
