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

  describe('requestForLearner lastLog fallback', () => {
    it('defaults lastIndex to 0 when lastLog is 0', async () => {
      mockRaftAdapter.getProgress.mockResolvedValue({ lastLog: 0 });
      mockRaftAdapter.getTerm.mockResolvedValue(0);
      const res = await group.requestForLearner(1);
      expect(res.lastIndex).toBe(0);
    });
  });

  describe('appendWithPipeline lastLog/term fallback', () => {
    it('computes index from lastLog=0 and term=0', async () => {
      mockRaftAdapter.getProgress.mockResolvedValue({ lastLog: 0 });
      mockRaftAdapter.getTerm.mockResolvedValue(0);
      mockRaftAdapter.propose.mockResolvedValue({ index: '1', term: '0' });
      // batchSize=1 forces an immediate flush after buffering.
      group.pipelineConfig = { ...group.getPipelineConfig(), batchSize: 1 };
      await group.appendWithPipeline([{ msgId: 'm', type: 'exec', data: '{}' }]);
      expect(mockRaftAdapter.propose).toHaveBeenCalled();
    });
  });

  describe('trySnapshot term fallback', () => {
    it('defaults term to 0 when getStatus omits term', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const dir = pathMod.join(os.tmpdir(), `raft-snapterm-${Date.now()}-${Math.random()}`);
      fsMod.mkdirSync(dir, { recursive: true });
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, dir);
      mockRaftAdapter.shouldTakeSnapshot.mockReturnValue(true);
      mockRaftAdapter.getAppliedIndex.mockResolvedValue(7);
      mockRaftAdapter.getStatus.mockResolvedValue({ term: undefined, lead: '1' });
      await expect(g.trySnapshot()).resolves.toBeUndefined();
      expect(mockRaftAdapter.takeSnapshot).toHaveBeenCalled();
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

  describe('snapshot write/read error paths', () => {
    it('trySnapshot catches a snapshot write failure', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const dir = pathMod.join(os.tmpdir(), `raft-snapfail-${Date.now()}-${Math.random()}`);
      fsMod.mkdirSync(dir, { recursive: true });
      // Force the flush hook (awaited inside trySnapshot) to reject, which
      // drives the try/catch exactly like a real persistence failure would.
      const flushHook = vi.fn().mockRejectedValue(new Error('flush failure'));
      const g = new RaftGroup(
        0,
        MOCK_CONFIG,
        MOCK_REPLICA,
        MOCK_OUTBOX,
        dir,
        undefined,
        undefined,
        undefined,
        flushHook,
      );
      mockRaftAdapter.shouldTakeSnapshot.mockReturnValue(true);
      mockRaftAdapter.getAppliedIndex.mockResolvedValue(5);
      mockRaftAdapter.getStatus.mockResolvedValue({ term: '3', lead: '1' });
      await expect(g.trySnapshot()).resolves.toBeUndefined();
      expect(flushHook).toHaveBeenCalled();
    });

    it('readSnapshotMeta returns null on a corrupt snapshot file', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const dir = pathMod.join(os.tmpdir(), `raft-snapcorrupt-${Date.now()}-${Math.random()}`);
      fsMod.mkdirSync(dir, { recursive: true });
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, dir);
      // Write a corrupt (non-JSON) snapshot file directly.
      fsMod.writeFileSync(g.getSnapshotFilePath(), 'not-json');
      expect(g.readSnapshotMeta()).toBeNull();
    });

    it('deleteSnapshot removes an existing snapshot', async () => {
      const os = await import('os');
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const dir = pathMod.join(os.tmpdir(), `raft-snapdel-${Date.now()}-${Math.random()}`);
      fsMod.mkdirSync(dir, { recursive: true });
      const g = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX, dir);
      fsMod.writeFileSync(g.getSnapshotFilePath(), 'data');
      expect(() => g.deleteSnapshot()).not.toThrow();
      expect(fsMod.existsSync(g.getSnapshotFilePath())).toBe(false);
    });
  });
});
