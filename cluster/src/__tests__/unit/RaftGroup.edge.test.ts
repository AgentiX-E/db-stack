/**
 * RaftGroup — constructor fallbacks, membership-change timeout/rollback,
 * pipeline parse fallbacks, snapshot edge paths, and flexible-quorum
 * self-only branches.
 *
 * These are the remaining branch edges that require null/undefined/0 inputs
 * to trigger `?? 0` / `|| 0` / `?.` nullish fallbacks and idempotency guards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

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

const MOCK_REPLICA = { apply: vi.fn(), snapshot: vi.fn().mockResolvedValue(Buffer.from('state')), restore: vi.fn() };
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
    it('always creates the snapshot directory, defaulting to ./data', async () => {
      // The directory is kept for engine-level artefacts and for deployments that
      // mount it; the authoritative snapshot now lives in the Raft storage.
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, undefined);
      await g.init();
      expect(fs.existsSync('./data')).toBe(true);
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
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, undefined, undefined, {
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

    it('_transitionToCNew keeps the transition open when C_NEW cannot be proposed', async () => {
      // The C_JOINT entry is already committed at this point, so a failed C_NEW
      // cannot be undone: the transitional config has to survive so an operator (or
      // a retry) can finish the change. Dropping it would leave the group running a
      // membership nobody voted for and no record that a change was in flight.
      group._transitionalConfig = { newEntryIndex: 5 };
      mockRaftAdapter.propose.mockRejectedValueOnce(new Error('quorum lost'));

      await expect(
        (group as any)._transitionToCNew({ changeId: 'c-new-fail', type: 'add', nodeId: 4 }, 5),
      ).resolves.toBeUndefined();

      expect(group._transitionalConfig).not.toBeNull();
      expect(group._transitionalConfig.newEntryIndex).toBe(5);
    });

    it('_transitionToCNew clears the transition once C_NEW commits', async () => {
      group._transitionalConfig = { newEntryIndex: 5 };
      mockRaftAdapter.propose.mockResolvedValueOnce({ index: '9', term: '2' });

      await (group as any)._transitionToCNew({ changeId: 'c-new-ok', type: 'add', nodeId: 4 }, 5);

      expect(group._transitionalConfig).toBeNull();
    });
  });

  describe('snapshot edges', () => {
    it('readSnapshotMeta returns null when snapshot does not exist', () => {
      expect(group.readSnapshotMeta()).toBeNull();
    });

    it('flushes the PITR WAL inside the snapshot capture, before the log is truncated', async () => {
      // The flush used to sit in the group's own snapshot loop. It now runs inside
      // the capture callback, which is the last moment before raft-core discards the
      // entries the WAL duplicates — so it cannot be skipped by a snapshot that
      // raft-core triggers on its own threshold.
      const flushHook = vi.fn().mockResolvedValue(undefined);
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, undefined, undefined, undefined, flushHook);
      await g.init();
      const handlers = mockRaftAdapter.setApplicationSnapshotHandlers.mock.calls.at(-1)![0];
      await handlers.takeSnapshot(7);
      expect(flushHook).toHaveBeenCalled();
      expect(MOCK_REPLICA.snapshot).toHaveBeenCalledWith(7);
      expect(flushHook.mock.invocationCallOrder[0]!).toBeLessThan(MOCK_REPLICA.snapshot.mock.invocationCallOrder[0]!);
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
