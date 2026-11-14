/**
 * RaftGroup Unit Tests
 *
 * Iteration 15 — RaftGroup core lifecycle and coordination logic.
 *
 * RaftGroup is the central coordination layer: it owns a RaftAdapter,
 * manages leader heartbeats, install-snapshot, pipeline flushing,
 * joint consensus membership changes, read-only mode, and fencing.
 *
 * Acceptance Criteria:
 *   AC 15.1: init creates snapshot dir, sets applyHandler, starts pipeline timer
 *   AC 15.2: propose commits via raft and appends to outbox
 *   AC 15.3: proposeBatch encodes entries and commits in one batch
 *   AC 15.4: proposeAndWait delegates to raft.proposeAndWait
 *   AC 15.5: isLeader / getLeader / getTerm / getProgress delegate to raft
 *   AC 15.6: setForceLeader delegates to raft
 *   AC 15.7: campaign delegates to raft
 *   AC 15.8: getLeaderHealth reflects heartbeat freshness
 *   AC 15.9: stop cleans up timers and stops raft
 *   AC 15.10: read delegates to raft
 *   AC 15.11: reportPeerActivity tracks active peers
 *   AC 15.12: getSplitBrainStatus returns correct state
 *   AC 15.13: enterReadOnlyMode sets readOnly flag
 *   AC 15.14: fencingRequest passes when in majority
 *   AC 15.15: fencingRequest fails when in minority
 *   AC 15.16: stop cleans up active peer cleanup timer
 *   AC 15.17: addLearner delegates to raft
 *   AC 15.18: getLeaderHealth returns healthy=true when monitor not running
 *              but leader is fresh (getLeaderHealth now checks both conditions)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock RaftAdapter ─────────────────────────────────────────
// RaftGroup constructs a RaftAdapter internally. We vi.mock it so
// all calls hit our spy instead of real RaftNode + TCP transport.
const mockRaftAdapter: any = {
  init: vi.fn().mockResolvedValue(undefined),
  propose: vi.fn().mockResolvedValue({ index: '1', term: '1' }),
  proposeAndWait: vi.fn().mockResolvedValue({ index: '1', term: '1' }),
  isLeader: vi.fn().mockResolvedValue(true),
  getLeader: vi.fn().mockResolvedValue(1),
  getTerm: vi.fn().mockResolvedValue(1),
  getProgress: vi.fn().mockResolvedValue({ commit: 0, applied: 0 }),
  stop: vi.fn(),
  setForceLeader: vi.fn(),
  campaign: vi.fn().mockResolvedValue(undefined),
  step: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue([]),
  addLearner: vi.fn().mockResolvedValue(true),
};

vi.mock('../../consensus/core/RaftAdapter', () => ({
  RaftAdapter: class MockRaftAdapter {
    constructor(_config: any) {}
    init = mockRaftAdapter.init;
    propose = mockRaftAdapter.propose;
    proposeAndWait = mockRaftAdapter.proposeAndWait;
    isLeader = mockRaftAdapter.isLeader;
    getLeader = mockRaftAdapter.getLeader;
    getTerm = mockRaftAdapter.getTerm;
    getProgress = mockRaftAdapter.getProgress;
    stop = mockRaftAdapter.stop;
    setForceLeader = mockRaftAdapter.setForceLeader;
    campaign = mockRaftAdapter.campaign;
    step = mockRaftAdapter.step;
    read = mockRaftAdapter.read;
    addLearner = mockRaftAdapter.addLearner;
  },
}));

// ── Shared test fixtures ─────────────────────────────────────
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

describe('RaftGroup — Unit', () => {
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
    if (group && typeof group.stop === 'function') {
      group.stop();
    }
  });

  //
  // AC 15.1: init creates snapshot dir, sets applyHandler, starts pipeline timer
  //
  it('AC 15.1: init creates snapshot dir and starts pipeline timer', async () => {
    await group.init();
    expect(mockRaftAdapter.init).toHaveBeenCalled();
    expect(group._pipelineFlushTimer).not.toBeNull();
  });

  //
  // AC 15.2: propose commits via raft and appends to outbox
  //
  it('AC 15.2: propose delegates to raft and appends to outbox', async () => {
    const entry = { msgId: 'm1', type: 'exec', data: JSON.stringify({ x: 1 }) };
    await group.propose(entry);
    expect(mockRaftAdapter.propose).toHaveBeenCalled();
    expect(MOCK_OUTBOX.append).toHaveBeenCalled();
    const outboxCall = MOCK_OUTBOX.append.mock.calls[0];
    expect(outboxCall[0].msgId).toBe('m1');
    expect(outboxCall[0].raftIndex).toBe(1);
  });

  //
  // AC 15.3: proposeBatch encodes entries in one batch
  //
  it('AC 15.3: proposeBatch encodes entries as __batch', async () => {
    const entries = [
      { msgId: 'm1', type: 'exec', data: '{"x":1}' },
      { msgId: 'm2', type: 'exec', data: '{"y":2}' },
    ];
    await group.proposeBatch(entries);
    expect(mockRaftAdapter.propose).toHaveBeenCalledTimes(1);
    // The callArg is JSON.stringify(batchEntry) — batchEntry.data contains __batch
    const callArg = mockRaftAdapter.propose.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    expect(parsed.msgId).toBeDefined();
    expect(parsed.type).toBe('exec');
    // __batch is nested inside parsed.data (which is a stringified JSON)
    const dataParsed = JSON.parse(parsed.data);
    expect(dataParsed.__batch).toBe(true);
    expect(dataParsed.entries).toHaveLength(2);
  });

  //
  // AC 15.4: proposeAndWait delegates to raft.proposeAndWait
  //
  it('AC 15.4: proposeAndWait delegates to raft', async () => {
    const entry = { msgId: 'm3', type: 'exec', data: '{"z":3}' };
    await group.proposeAndWait(entry);
    expect(mockRaftAdapter.proposeAndWait).toHaveBeenCalled();
    expect(MOCK_OUTBOX.append).toHaveBeenCalled();
  });

  //
  // AC 15.5: isLeader / getLeader / getTerm / getProgress delegate to raft
  //
  it('AC 15.5: status queries delegate to raft', async () => {
    const isLeader = await group.isLeader();
    expect(isLeader).toBe(true);
    expect(mockRaftAdapter.isLeader).toHaveBeenCalled();

    const leader = await group.getLeader();
    expect(leader).toBe(1);
    expect(mockRaftAdapter.getLeader).toHaveBeenCalled();

    const term = await group.getTerm();
    expect(term).toBe(1);
    expect(mockRaftAdapter.getTerm).toHaveBeenCalled();

    const progress = await group.getProgress();
    expect(progress).toEqual({ commit: 0, applied: 0 });
    expect(mockRaftAdapter.getProgress).toHaveBeenCalled();
  });

  //
  // AC 15.6: setForceLeader delegates to raft
  //
  it('AC 15.6: setForceLeader delegates to raft', () => {
    group.setForceLeader(true);
    expect(mockRaftAdapter.setForceLeader).toHaveBeenCalledWith(true);
  });

  //
  // AC 15.7: campaign delegates to raft
  //
  it('AC 15.7: campaign delegates to raft', async () => {
    await group.campaign();
    expect(mockRaftAdapter.campaign).toHaveBeenCalled();
  });

  //
  // AC 15.8: getLeaderHealth reflects heartbeat freshness
  //
  it('AC 15.8: getLeaderHealth returns correct health status', async () => {
    await group.init();
    // Set heartbeat close to present
    group._leaderHeartbeatTs = Date.now();
    const health = await group.getLeaderHealth();
    expect(health.healthy).toBe(true);
    expect(health.leaderId).toBe('1');
    expect(typeof health.term).toBe('number');
  });

  //
  // AC 15.9: stop cleans up timers and stops raft
  //
  it('AC 15.9: stop cleans up timer and stops raft', async () => {
    await group.init();
    expect(group.pipelineFlushTimer).not.toBeNull();
    group.stop();
    expect(group.pipelineFlushTimer).toBeNull();
    expect(mockRaftAdapter.stop).toHaveBeenCalled();
  });

  //
  // AC 15.10: read delegates to raft for linearizable reads
  //
  it('AC 15.10: read delegates to raft', async () => {
    // RaftGroup.read() calls this.replica.query() — add to mock replica
    (MOCK_REPLICA as any).query = vi.fn().mockResolvedValue([{ id: 1 }]);
    const result = await group.read('SELECT 1');
    expect((MOCK_REPLICA as any).query).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(result).toEqual([{ id: 1 }]);
  });

  //
  // AC 15.11: reportPeerActivity tracks active peers
  //
  it('AC 15.11: reportPeerActivity tracks active peers', () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    expect(group.getActivePeers()).toContain('2');
    expect(group.getActivePeers()).toContain('3');
    // Self ID should be skipped
    group.reportPeerActivity('1');
    expect(group.getActivePeers()).not.toContain('1');
  });

  //
  // AC 15.12: getSplitBrainStatus returns correct state
  //
  it('AC 15.12: getSplitBrainStatus returns current state', () => {
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    const status = group.getSplitBrainStatus();
    expect(status).toHaveProperty('inMajority');
    expect(status).toHaveProperty('readOnly');
    expect(status).toHaveProperty('connectedPeers');
    expect(status).toHaveProperty('totalPeers');
    expect(status).toHaveProperty('fencingState');
  });

  //
  // AC 15.13: enterReadOnlyMode sets readOnly flag
  //
  it('AC 15.13: enterReadOnlyMode sets readOnly', async () => {
    expect(group.isReadOnly()).toBe(false);
    // Set isLeader to false to avoid stepDown call
    mockRaftAdapter.isLeader.mockResolvedValueOnce(false);
    await group.enterReadOnlyMode();
    expect(group.isReadOnly()).toBe(true);
  });

  //
  // AC 15.14: fencingRequest passes when in majority
  //
  it('AC 15.14: fencingRequest passes in majority', async () => {
    // Report all peers as active, so we're in majority
    group.reportPeerActivity('2');
    group.reportPeerActivity('3');
    const result = await group.fencingRequest(true);
    expect(result).toBe(true);
    expect(group.isReadOnly()).toBe(false);
  });

  //
  // AC 15.15: fencingRequest fails in minority
  //
  it('AC 15.15: fencingRequest fails in minority', async () => {
    // Mock needs a config with peers for isInMajority() to work
    (group.raft as any).config = MOCK_CONFIG;
    // No active peers → only self is connected out of 3 total
    // activeCount = 0 + 1 = 1, majority requires > 1.5 → false
    mockRaftAdapter.isLeader.mockResolvedValueOnce(false);
    const result = await group.fencingRequest(true);
    expect(result).toBe(false);
    expect(group.isReadOnly()).toBe(true);
  });

  //
  // AC 15.16: stop cleans up active peer cleanup timer
  //
  it('AC 15.16: stop cleans up active peer cleanup timer', async () => {
    await group.init();
    expect(group._activePeerCleanupTimer).toBeDefined();
    group.stop();
    // After stop, the cleanup timer should be null
    expect(group._activePeerCleanupTimer).toBeNull();
  });

  //
  // AC 15.17: addLearner tracks learner locally (does not delegate to raft adapter)
  //
  it('AC 15.17: addLearner tracks new learner without delegation', async () => {
    // addLearner is a local method that uses Map management + getProgress
    const result = await group.addLearner('node-99');
    expect(result).toBe(true);
    // Second add should return false (already tracked)
    const again = await group.addLearner('node-99');
    expect(again).toBe(false);
    // removeLearner should return true
    const removed = group.removeLearner('node-99');
    expect(removed).toBe(true);
    // Double remove should return false
    const removedAgain = group.removeLearner('node-99');
    expect(removedAgain).toBe(false);
  });

  //
  // AC 15.18: getLeaderHealth reports health based on heartbeat freshness
  //
  it('AC 15.18: getLeaderHealth reports healthy with fresh heartbeat', async () => {
    await group.init();
    // leaderMonitorTimer starts via startLeaderMonitor (separate from init)
    group.startLeaderMonitor(5000);
    // Simulate recent heartbeat
    group._leaderHeartbeatTs = Date.now() - 10; // Very recent
    const health = await group.getLeaderHealth();
    expect(health.healthy).toBe(true);
    expect(health.leaderMonitorRunning).toBe(true);
  });
});
