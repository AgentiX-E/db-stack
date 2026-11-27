/**
 * RaftGroup — no committed write leaves the group without a quorum position.
 *
 * `fencingRequest()` mints a token and `getFencingToken()` returns it, but the
 * write path used to propose the caller's entry unchanged. The resource layer —
 * the only place a partitioned primary can actually be stopped — therefore had
 * nothing to compare, and the fencing mechanism was something an engine had to
 * thread through its own write path by hand.
 *
 * These cases pin the contract at the seam the token has to cross: every proposal
 * carries a wire-form `fencingToken`, a caller's token below the group's own
 * position is refused before a log entry exists, and the position survives into
 * the outbox record the fan-out reads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatFencingToken, mintFencingToken } from '../../consensus/fencing/FencingToken';

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

/** The payload actually submitted, read back from the seam the bug lived in. */
function submitted(): any {
  return JSON.parse(mockRaftAdapter.propose.mock.calls.at(-1)?.[0]);
}

describe('RaftGroup — every proposal carries the quorum position', () => {
  let RaftGroup: any;
  let group: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockRaftAdapter.getTerm.mockResolvedValue(3);
    mockRaftAdapter.getCommitIndex.mockResolvedValue(77);
    mockRaftAdapter.propose.mockResolvedValue({ index: '78', term: '3' });
    mockRaftAdapter.proposeAndWait.mockResolvedValue({ index: '78', term: '3' });
    const mod = await import('../../consensus/core/RaftGroup');
    RaftGroup = mod.RaftGroup;
    group = new RaftGroup(0, MOCK_CONFIG, MOCK_REPLICA, MOCK_OUTBOX);
    (group.raft as any).config = MOCK_CONFIG;
  });

  afterEach(() => {
    if (group && typeof group.stop === 'function') group.stop();
  });

  it('stamps the current term and committed index on an async proposal', async () => {
    await group.propose({ msgId: 'a', type: 'exec', data: '{}' });

    expect(submitted().fencingToken).toBe(formatFencingToken(mintFencingToken(3, 77)));
  });

  it('stamps the synchronous path as well, not only the async one', async () => {
    await group.proposeAndWait({ msgId: 'b', type: 'exec', data: '{}' });

    const payload = JSON.parse(mockRaftAdapter.proposeAndWait.mock.calls.at(-1)?.[0]);
    expect(payload.fencingToken).toBe('3/77');
  });

  it('stamps a batch as one entry, so a bulk write cannot escape the fence', async () => {
    await group.proposeBatch([
      { msgId: 'c1', type: 'exec', data: '{}' },
      { msgId: 'c2', type: 'exec', data: '{}' },
    ]);

    expect(submitted().fencingToken).toBe('3/77');
  });

  it('uses a position the group advanced to after its last fence', async () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    await group.fencingRequest(true);
    mockRaftAdapter.getCommitIndex.mockResolvedValue(92);

    await group.propose({ msgId: 'd', type: 'exec', data: '{}' });

    expect(submitted().fencingToken).toBe('3/92');
  });

  it('carries the stamped token into the outbox payload the fan-out reads', async () => {
    await group.propose({ msgId: 'e', type: 'exec', data: '{"k":1}' });

    const record = MOCK_OUTBOX.append.mock.calls.at(-1)?.[0];
    expect(JSON.parse(record.payload).fencingToken).toBe('3/77');
  });

  it('refuses a caller token below the group position before a log entry exists', async () => {
    await assertProposalRefused(
      () => group.propose({ msgId: 'stale', type: 'exec', data: '{}', fencingToken: '2/999' }),
      /fencing token .* behind/i,
    );
    expect(mockRaftAdapter.propose).not.toHaveBeenCalled();
  });

  it('refuses a token in an earlier term even with a larger index', async () => {
    await assertProposalRefused(
      () => group.propose({ msgId: 'stale-term', type: 'exec', data: '{}', fencingToken: '2/100000' }),
      /fencing token/i,
    );
    expect(mockRaftAdapter.propose).not.toHaveBeenCalled();
  });

  it('refuses a malformed caller token rather than guessing its position', async () => {
    await assertProposalRefused(
      () => group.propose({ msgId: 'bad', type: 'exec', data: '{}', fencingToken: 'not-a-token' }),
      /fencing token/i,
    );
    expect(mockRaftAdapter.propose).not.toHaveBeenCalled();
  });

  it('keeps a caller token at or above the group position without rewriting it', async () => {
    await group.propose({ msgId: 'fresh', type: 'exec', data: '{}', fencingToken: '4/1' });

    expect(submitted().fencingToken).toBe('4/1');
  });

  it('keeps an equal token: a retry is not a usurper', async () => {
    await group.propose({ msgId: 'retry', type: 'exec', data: '{}', fencingToken: '3/77' });

    expect(submitted().fencingToken).toBe('3/77');
  });

  it('refuses a stale token on the synchronous path too', async () => {
    await assertProposalRefused(
      () => group.proposeAndWait({ msgId: 'stale-sync', type: 'exec', data: '{}', fencingToken: '1/1' }),
      /fencing token/i,
    );
    expect(mockRaftAdapter.proposeAndWait).not.toHaveBeenCalled();
  });
});

async function assertProposalRefused(act: () => Promise<void>, pattern: RegExp): Promise<void> {
  try {
    await act();
    throw new Error('the proposal was accepted');
  } catch (error) {
    expect(String((error as Error).message)).toMatch(pattern);
  }
}
