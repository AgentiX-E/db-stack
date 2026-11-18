/**
 * RaftGroup — RPC, install-snapshot, active-peer cleanup, and factory tests.
 *
 * Completes the uncovered surface left by the other RaftGroup suites:
 *   - handleRaftMessage + _handleInstallSnapshot (chunk routing + reassembly)
 *   - applyHandler (the state-machine apply callback wired into raft.init)
 *   - _cleanupActivePeers (stale peer eviction via the leader-monitor timer)
 *   - createWithSqliteStorage (static persistent-storage factory)
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

describe('RaftGroup — RPC, install-snapshot, cleanup, factory', () => {
  let RaftGroup: any;
  let group: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../../consensus/core/RaftGroup');
    RaftGroup = mod.RaftGroup;
    group = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (group && typeof group.stop === 'function') group.stop();
  });

  describe('legacy inbound hook', () => {
    it('records the sender so split-brain detection can see the peer', () => {
      const reportPeerActivity = vi.spyOn(group, 'reportPeerActivity');
      group.handleRaftMessage({ msgType: 3, from: 2 });
      expect(reportPeerActivity).toHaveBeenCalledWith('2');
      expect(group.getActivePeers()).toContain('2');
    });

    it('ignores messages with no sender, including null', () => {
      const reportPeerActivity = vi.spyOn(group, 'reportPeerActivity');
      expect(() => group.handleRaftMessage({ msgType: 1 })).not.toThrow();
      expect(() => group.handleRaftMessage(null)).not.toThrow();
      expect(reportPeerActivity).not.toHaveBeenCalled();
    });

    it('does not forward anything to raft: routing belongs to raft-core', () => {
      // Regression guard for the dead chunked-snapshot path: it pushed reassembled
      // bytes into `RaftAdapter.step()`, which is a no-op under raft-core. Enabling
      // it therefore *discarded* snapshots; nothing may call `step` any more.
      group.handleRaftMessage({
        msgType: 14,
        from: 2,
        snapshot: { data: new Uint8Array([1]), done: true },
      });
      expect(mockRaftAdapter.step).not.toHaveBeenCalled();
    });
  });

  describe('applyHandler', () => {
    it('applies parsed JSON entries to the replica', async () => {
      // Capture the applyHandler passed into raft.init, then invoke it.
      (group.raft as any).config = { enableInstallSnapshot: false };
      await group.init();
      const applyHandler = mockRaftAdapter.init.mock.calls[0][0];
      expect(typeof applyHandler).toBe('function');

      (MOCK_REPLICA as any).apply = vi.fn().mockResolvedValue(undefined);
      const data = JSON.stringify({ msgId: 'm1', type: 'exec', data: '{"x":1}' });
      await applyHandler(data, 5, 1);
      expect((MOCK_REPLICA as any).apply).toHaveBeenCalled();
    });

    it('tolerates non-JSON data without throwing', async () => {
      (group.raft as any).config = { enableInstallSnapshot: false };
      await group.init();
      const applyHandler = mockRaftAdapter.init.mock.calls[0][0];
      expect(() => applyHandler('not-json', 5, 1)).not.toThrow();
      expect((MOCK_REPLICA as any).apply).not.toHaveBeenCalled();
    });
  });

  describe('_cleanupActivePeers (via startLeaderMonitor)', () => {
    it('evicts stale peers after the 10s cleanup timer fires', () => {
      vi.useFakeTimers();
      group.reportPeerActivity('2'); // recorded at fake-now T0
      group.startLeaderMonitor();
      // Advance past the 10s interval; the stale threshold is
      // electionTick * tickIntervalMs * 3 = 3000ms, so the peer is stale.
      vi.advanceTimersByTime(10_000);
      expect(group.getActivePeers()).not.toContain('2');
      vi.useRealTimers();
    });

    it('keeps fresh peers when cleanup fires', () => {
      vi.useFakeTimers();
      group.startLeaderMonitor();
      // Re-touch the peer just before the 10s interval fires, so its
      // lastSeen timestamp remains within the 3s stale threshold.
      vi.advanceTimersByTime(9_000);
      group.reportPeerActivity('3');
      vi.advanceTimersByTime(1_000); // fires the 10s interval
      expect(group.getActivePeers()).toContain('3');
      vi.useRealTimers();
    });

    it('startLeaderMonitor is idempotent', () => {
      group.startLeaderMonitor();
      const first = (group as any)._leaderMonitorTimer;
      group.startLeaderMonitor();
      expect((group as any)._leaderMonitorTimer).toBe(first);
      group.stopLeaderMonitor();
    });
  });

  describe('createWithSqliteStorage factory', () => {
    it('constructs a group wired with SqliteStorage', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const file = pathMod.join(os.tmpdir(), `raft-group-sqlite-${Date.now()}-${Math.random()}.db`);
      const g = await RaftGroup.createWithSqliteStorage(
        0,
        MOCK_CONFIG,
        MOCK_REPLICA,
        MOCK_OUTBOX,
        { file },
        file + '.dir',
      );
      expect(g).toBeInstanceOf(RaftGroup);
      expect(g.getRaftAdapter()).toBeTruthy();
      // The storage backend was injected into the adapter.
      expect((g.getRaftAdapter() as any)._customStorage).toBeTruthy();
      if (typeof g.stop === 'function') g.stop();
    });
  });
});
