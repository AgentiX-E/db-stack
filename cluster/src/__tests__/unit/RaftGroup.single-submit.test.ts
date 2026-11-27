/**
 * RaftGroup — one synchronous proposal is one entry.
 *
 * `proposeAndWait` used to submit twice. The first call was an `await` left over
 * from when `IRaftNode.proposeAndWait` returned `void`; the second was the one whose
 * position was stamped into the outbox record. `RaftAdapter` grew a return value so
 * the second question did not have to be asked — its own comment says so, naming
 * this caller — and the first `await` stayed.
 *
 * The cost is not a slow path, it is the durable one: every synchronous write
 * appended two log entries instead of one, and the second entry carried the same
 * `msgId`, so correctness after that depended on the apply path's dedup rather than
 * on the middleware. These cases pin the contract at the seam the bug lived in: one
 * submit, and the record carries that submit's position.
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

describe('RaftGroup — one synchronous proposal is one entry', () => {
  let RaftGroup: any;
  let group: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../../consensus/core/RaftGroup');
    RaftGroup = mod.RaftGroup;
    group = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX);
    (group.raft as any).config = MOCK_CONFIG;
  });

  afterEach(() => {
    if (group && typeof group.stop === 'function') group.stop();
  });

  it('submits a synchronous entry exactly once', async () => {
    await group.proposeAndWait({ msgId: 'once', type: 'exec', data: '{}' });

    // Twice would mean two log entries for one write, and the record's position
    // would be the position of an entry the caller never asked for. The one submit
    // also carries the quorum position the resource will compare.
    expect(mockRaftAdapter.proposeAndWait).toHaveBeenCalledTimes(1);
    expect(mockRaftAdapter.proposeAndWait).toHaveBeenCalledWith(
      JSON.stringify({ msgId: 'once', type: 'exec', data: '{}', fencingToken: '3/77' }),
    );
  });

  it('stamps the position the single submit returned into the outbox record', async () => {
    // Two different answers, so a second submit cannot hide: the record has to carry
    // the first one, because the first one is the only submission that happened.
    mockRaftAdapter.proposeAndWait
      .mockResolvedValueOnce({ index: '10', term: '1' })
      .mockResolvedValueOnce({ index: '99', term: '9' });

    await group.proposeAndWait({ msgId: 'stamped', type: 'exec', data: '{}' });

    const record = MOCK_OUTBOX.append.mock.calls.at(-1)?.[0];
    expect(record).toMatchObject({ msgId: 'stamped', raftIndex: 10, raftTerm: 1 });
  });

  it('leaves the boundary case alone: the committed-then-returning path submits once', async () => {
    // `propose()` never had the double submit; the case is here so that a future
    // change to the shared seam cannot fix one path and break the other silently.
    await group.propose({ msgId: 'async', type: 'exec', data: '{}' });

    expect(mockRaftAdapter.propose).toHaveBeenCalledTimes(1);
    expect(mockRaftAdapter.proposeAndWait).not.toHaveBeenCalled();
  });
});
