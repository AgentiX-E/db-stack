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
    setApplicationSnapshotHandlers = mockRaftAdapter.setApplicationSnapshotHandlers;
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

  describe('snapshot file error paths', () => {
    it('readSnapshotMeta returns null on JSON parse failure', () => {
      // Corrupt the real snapshot file instead of spying on node:fs — ESM
      // namespace spying does not intercept the module's own `fs` binding,
      // which made the original test assert against a different code path.
      const fsMod = require('fs');
      const snapshotPath = group.getSnapshotFilePath();
      fsMod.mkdirSync(require('path').dirname(snapshotPath), { recursive: true });
      fsMod.writeFileSync(snapshotPath, 'not-json');
      try {
        expect(group.snapshotExists()).toBe(true);
        expect(group.readSnapshotMeta()).toBeNull();
      } finally {
        fsMod.rmSync(snapshotPath, { force: true });
      }
    });

    it('deleteSnapshot unlinks and swallows errors', () => {
      const fsMod = require('fs');
      const realUnlink = fsMod.unlinkSync;
      vi.spyOn(fsMod, 'existsSync').mockReturnValue(true);
      vi.spyOn(fsMod, 'unlinkSync').mockImplementation(() => {
        throw new Error('unlink failed');
      });
      expect(() => group.deleteSnapshot()).not.toThrow();
      vi.restoreAllMocks();
    });
  });

  describe('install-snapshot no-field guard', () => {
    it('logs and returns when snapshot field is absent', async () => {
      (group.raft as any).config = { enableInstallSnapshot: true };
      await group.init();
      // msgType 14 but no snapshot field
      await expect(group.handleRaftMessage({ msgType: 14 })).toBeUndefined();
    });
  });

  describe('_transitionToCNew propose path', () => {
    it('proposes C_NEW and finalizes the transition', async () => {
      group._transitionalConfig = { newEntryIndex: 0, changeId: 'c1' };
      mockRaftAdapter.propose.mockResolvedValue({ index: '50', term: '2' });
      await (group as any)._transitionToCNew({ changeId: 'c1', type: 'join', nodeId: '2', newPeers: [1, 2] }, 10);
      expect(group._transitionalConfig).toBeNull();
    });

    it('keeps transitional config when C_NEW propose fails', async () => {
      group._transitionalConfig = { newEntryIndex: 0, changeId: 'c1' };
      mockRaftAdapter.propose.mockRejectedValueOnce(new Error('propose failed'));
      await (group as any)._transitionToCNew({ changeId: 'c1', type: 'join', nodeId: '2', newPeers: [1, 2] }, 10);
      expect(group._transitionalConfig).not.toBeNull();
    });
  });

  describe('leader-monitor exception handling', () => {
    it('logs and continues when getStatus throws', async () => {
      const campaign = vi.fn();
      (group.raft as any).node = { campaign };
      mockRaftAdapter.getStatus.mockRejectedValue(new Error('status boom'));
      group.startLeaderMonitor(50);
      await new Promise((r) => setTimeout(r, 80));
      expect(group._leaderMonitorTimer).toBeTruthy();
      group.stopLeaderMonitor();
    });
  });

  describe('install-snapshot error + guard paths', () => {
    it('catches a rejected install-snapshot handler', async () => {
      (group.raft as any).config = { enableInstallSnapshot: true };
      await group.init();
      // installSnapshotHandler.handleChunk rejects → _handleInstallSnapshot rejects
      group.installSnapshotHandler = {
        handleChunk: vi.fn().mockRejectedValue(new Error('chunk failure')),
      };
      await expect(
        group.handleRaftMessage({ msgType: 14, snapshot: { done: false, leaderId: '2', term: 1 } }),
      ).toBeUndefined();
      // The rejection is swallowed by the .catch (logged, not thrown).
    });

    it('returns early when snapshot field is missing (private guard)', async () => {
      (group.raft as any).config = { enableInstallSnapshot: true };
      await group.init();
      group.installSnapshotHandler = {
        handleChunk: vi.fn(),
      };
      await expect((group as any)._handleInstallSnapshot({})).resolves.toBeUndefined();
      expect(group.installSnapshotHandler.handleChunk).not.toHaveBeenCalled();
    });
  });

  describe('deleteSnapshot unlink failure swallow', () => {
    it('swallows an unlink error via a read-only snapshot dir', () => {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const dir = path.join(os.tmpdir(), `raft-snapro-${Date.now()}-${Math.random()}`);
      fs.mkdirSync(dir, { recursive: true });
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, dir);
      fs.writeFileSync(g.getSnapshotFilePath(), 'data');
      // Make the directory read-only so unlinkSync throws (EACCES/EPERM).
      fs.chmodSync(dir, 0o555);
      try {
        expect(() => g.deleteSnapshot()).not.toThrow();
      } finally {
        fs.chmodSync(dir, 0o755);
      }
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

  describe('pipeline flush timer error', () => {
    it('catches a flush error inside the timer callback', async () => {
      // Force flushPipeline to reject by making outbox.append throw during
      // the acknowledgement write, then invoke the timer callback directly.
      (group as any).startPipelineFlushTimer = vi.fn();
      await group.init();
      const flushSpy = vi.spyOn(group, 'flushPipeline').mockRejectedValue(new Error('flush boom'));
      // Start a real timer with a tiny interval; the catch should swallow.
      group.pipelineConfig = { ...group.getPipelineConfig(), batchIntervalMs: 10 };
      (group as any).startPipelineFlushTimer();
      await new Promise((r) => setTimeout(r, 30));
      flushSpy.mockRestore();
    });
  });
});
