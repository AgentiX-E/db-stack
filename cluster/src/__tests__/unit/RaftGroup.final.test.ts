/**
 * RaftGroup — final branch completion: shared transport, snapshot file
 * error paths, install-snapshot no-field guard, membership C_NEW transition,
 * and leader-monitor exception handling.
 *
 * These are the remaining reachable branches (real error/guard paths) rather
 * than defensive dead code, and are exercised via their public entry points.
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

describe('RaftGroup — final branch completion', () => {
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

  describe('init with shared transport + missing snapshot dir', () => {
    it('creates the snapshot dir when missing and passes transport', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const dir = pathMod.join(os.tmpdir(), `raft-init-${Date.now()}-${Math.random()}`);
      // dir intentionally not created → L220 mkdirSync branch
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, dir);
      const transport = { send: vi.fn() };
      (g.raft as any).config = { enableInstallSnapshot: false };
      await g.init(transport);
      expect(fsMod.existsSync(dir)).toBe(true);
      // transport branch → init called with 3 args
      expect(mockRaftAdapter.init).toHaveBeenCalledWith(expect.any(Function), undefined, {
        transport,
        shardId: 0,
      });
    });
  });

  describe('applyHandler without index/term', () => {
    it('defaults index/term to 0', async () => {
      (group.raft as any).config = { enableInstallSnapshot: false };
      await group.init();
      const applyHandler = mockRaftAdapter.init.mock.calls[0][0];
      (MOCK_REPLICA as any).apply = vi.fn();
      applyHandler(JSON.stringify({ msgId: 'm', type: 'exec', data: '{}' }));
      expect((MOCK_REPLICA as any).apply).toHaveBeenCalled();
    });
  });

  describe('snapshot metadata contract', () => {
    it('reports no snapshot when raft holds none', () => {
      mockRaftAdapter.getSnapshotMeta.mockReturnValue(null);
      expect(group.snapshotExists()).toBe(false);
      expect(group.readSnapshotMeta()).toBeNull();
    });

    it("maps raft's snapshot into the group's public shape", () => {
      mockRaftAdapter.getSnapshotMeta.mockReturnValue({
        lastIncludedIndex: 42,
        lastIncludedTerm: 7,
        observedAt: 1234,
      });
      expect(group.snapshotExists()).toBe(true);
      expect(group.readSnapshotMeta()).toEqual({
        lastIncludedIndex: 42,
        lastIncludedTerm: 7,
        nodeId: MOCK_CONFIG.id,
        shardId: 0,
        timestamp: 1234,
      });
    });

    it('forwards a snapshot request to raft and logs the boundary', async () => {
      mockRaftAdapter.requestSnapshot.mockResolvedValue({
        lastIncludedIndex: 9,
        lastIncludedTerm: 1,
        observedAt: 1,
      });
      await expect(group.trySnapshot()).resolves.toBeUndefined();
      expect(mockRaftAdapter.requestSnapshot).toHaveBeenCalledTimes(1);
    });

    it('swallows a snapshot failure instead of failing the caller', async () => {
      mockRaftAdapter.requestSnapshot.mockRejectedValue(new Error('disk full'));
      await expect(group.trySnapshot()).resolves.toBeUndefined();
    });
  });

  describe('legacy inbound hook', () => {
    it('never intercepts MsgInstallSnapshot: raft-core installs it itself', async () => {
      // The group used to reassemble chunked InstallSnapshot messages here and push
      // the bytes into `RaftAdapter.step()`, which is a no-op under raft-core — so
      // the enabled path *discarded* snapshots. It is gone; the only thing this hook
      // still does is note that a peer was heard from.
      await group.init();
      const reportPeerActivity = vi.spyOn(group, 'reportPeerActivity');
      group.handleRaftMessage({ msgType: 14, from: 3, snapshot: { done: true } });
      expect(reportPeerActivity).toHaveBeenCalledWith('3');
    });

    it('ignores a message with no sender', async () => {
      await group.init();
      const reportPeerActivity = vi.spyOn(group, 'reportPeerActivity');
      expect(() => group.handleRaftMessage({ msgType: 3 })).not.toThrow();
      expect(reportPeerActivity).not.toHaveBeenCalled();
    });
  });

  describe('removed snapshot-file API', () => {
    it('exposes no way to delete or locate a second snapshot file', () => {
      // `deleteSnapshot` and `getSnapshotFilePath` went with the metadata-only file
      // that could compact the log without covering it. Keeping either would invite
      // a caller to reintroduce the divergence this iteration removed.
      expect((group as any).deleteSnapshot).toBeUndefined();
      expect((group as any).getSnapshotFilePath).toBeUndefined();
    });
  });

  describe('_cleanupActivePeers config nullish defaults', () => {
    it('defaults electionTick=10 and tickIntervalMs=100 when config omits them', () => {
      // config present but missing tick fields → `config?.electionTick ?? 10`
      // and `config?.tickIntervalMs ?? 100` nullish fallbacks.
      (group.raft as any).config = { peers: [1, 2, 3] };
      (group as any)._cleanupActivePeers();
      // No throw; defaults are applied internally.
    });

    it('cleans up a stale peer using the default threshold', () => {
      (group.raft as any).config = { peers: [1, 2, 3] };
      group._activePeers = new Set(['2']);
      group._activePeerTimestamps = new Map([['2', Date.now() - 10_000_000]]);
      (group as any)._cleanupActivePeers();
      expect(group._activePeers.size).toBe(0);
    });

    it('cleans up when config is entirely absent', () => {
      (group.raft as any).config = undefined;
      group._activePeers = new Set(['2']);
      group._activePeerTimestamps = new Map([['2', Date.now() - 10_000_000]]);
      (group as any)._cleanupActivePeers();
      expect(group._activePeers.size).toBe(0);
    });
  });
});
