/**
 * RaftGroup — a fence that mints a token instead of trusting a belief.
 *
 * `fencingRequest()` used to answer "am I fenced?" from `isInMajority()` — the
 * count of peers this node happened to hear from. That answer is a belief, and a
 * belief is exactly what a partitioned leader still has. These cases pin the
 * replacement: a successful fence mints a token from the term the quorum is in
 * and the index it has committed, a minority partition mints nothing, a node
 * whose own term is behind one already observed refuses to mint at all, and
 * entering read-only drops the token so the resource stops accepting this node's
 * writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRaftAdapter: any = {
  init: vi.fn().mockResolvedValue(undefined),
  propose: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  proposeAndWait: vi.fn().mockResolvedValue({ index: '10', term: '1' }),
  isLeader: vi.fn().mockResolvedValue(true),
  getLeader: vi.fn().mockResolvedValue(9),
  getTerm: vi.fn().mockResolvedValue(3),
  getCommitIndex: vi.fn().mockResolvedValue(77),
  getProgress: vi.fn().mockResolvedValue({ commit: 5, applied: 5, lastLog: 5 }),
  getAppliedIndex: vi.fn().mockResolvedValue(5),
  setApplicationSnapshotHandlers: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ term: '3', lead: '9' }),
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
    getCommitIndex = mockRaftAdapter.getCommitIndex;
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

describe('RaftGroup — fencing tokens', () => {
  let RaftGroup: any;
  let group: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockRaftAdapter.getTerm.mockResolvedValue(3);
    mockRaftAdapter.getCommitIndex.mockResolvedValue(77);
    const mod = await import('../../consensus/core/RaftGroup');
    RaftGroup = mod.RaftGroup;
    group = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX);
    (group.raft as any).config = MOCK_CONFIG;
  });

  afterEach(() => {
    if (group && typeof group.stop === 'function') group.stop();
  });

  it('mints a token from the term and the committed index on a healthy fence', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');

    await expect(group.fencingRequest(true)).resolves.toBe(true);

    expect(group.getFencingToken()).toEqual({ term: 3, index: 77 });
    expect(mockRaftAdapter.getTerm).toHaveBeenCalled();
    expect(mockRaftAdapter.getCommitIndex).toHaveBeenCalled();
  });

  it('mints nothing while the node cannot hear a majority', async () => {
    mockRaftAdapter.isLeader.mockResolvedValue(false);

    await expect(group.fencingRequest(true)).resolves.toBe(false);

    expect(group.getFencingToken()).toBeNull();
    expect(group.isReadOnly()).toBe(true);
    expect(mockRaftAdapter.getCommitIndex).not.toHaveBeenCalled();
  });

  it('advances the token as the committed index advances', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    await group.fencingRequest(true);

    mockRaftAdapter.getCommitIndex.mockResolvedValue(80);
    await group.fencingRequest(true);

    expect(group.getFencingToken()).toEqual({ term: 3, index: 80 });
  });

  it('refuses to mint when its own term is behind a term already observed', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    group._lastFencingTerm = 5;
    mockRaftAdapter.getTerm.mockResolvedValue(4);
    mockRaftAdapter.isLeader.mockResolvedValue(false);

    await expect(group.fencingRequest(true)).resolves.toBe(false);

    expect(group.getFencingToken()).toBeNull();
    expect(group.isReadOnly()).toBe(true);
    expect(group.getSplitBrainStatus().fencingState).toBe('minority');
  });

  it('drops the token when it falls back to read-only', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    await group.fencingRequest(true);
    expect(group.getFencingToken()).not.toBeNull();

    group.clearActivePeerTracking();
    mockRaftAdapter.isLeader.mockResolvedValue(false);
    await group.fencingRequest(true);

    expect(group.getFencingToken()).toBeNull();
    expect(group.isReadOnly()).toBe(true);
  });

  it('reports the token alongside the rest of the split-brain status', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    await group.fencingRequest(true);

    const status = group.getSplitBrainStatus();

    expect(status.fencingToken).toEqual({ term: 3, index: 77 });
    expect(status.readOnly).toBe(false);
    expect(status.fencingState).toBe('normal');
  });

  it('reports a null token before any successful fence', () => {
    expect(group.getSplitBrainStatus().fencingToken).toBeNull();
  });

  it('keeps its token across a throttled check, which decides nothing new', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    await group.fencingRequest(true);
    mockRaftAdapter.getTerm.mockClear();
    mockRaftAdapter.getCommitIndex.mockClear();

    await expect(group.fencingRequest(false)).resolves.toBe(true);

    expect(mockRaftAdapter.getTerm).not.toHaveBeenCalled();
    expect(group.getFencingToken()).toEqual({ term: 3, index: 77 });
  });
});
