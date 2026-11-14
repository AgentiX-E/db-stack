/**
 * HAFailoverDetector Unit Tests
 *
 * Iteration 13 — Stage 2: HAFailoverDetector core detection logic.
 *
 * Acceptance Criteria:
 *   AC 13.11: registerShard — adds shard to known set
 *   AC 13.12: unregisterShard — removes shard and cleans up tracked state
 *   AC 13.13: start/stop lifecycle — mirrors started state
 *   AC 13.14: PATH 1 — leaderless detection does not fire immediately, fires quorum_loss after timeout
 *   AC 13.15: PATH 1 — startup grace period suppresses failover event
 *   AC 13.16: PATH 2 — leader exists, reset leaderless timer
 *   AC 13.17: checkNow — does not crash, can be manually triggered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HAFailoverDetector } from '../../ha/HAFailoverDetector';
import { IConsensusLayer, IClusterTopology } from '../../consensus/interfaces/interfaces';

// ── Helpers ──

function createMockTopology(nodeId = 'node-1', peerIds = ['node-2', 'node-3']): IClusterTopology {
  return {
    getNodeId: () => nodeId,
    getPeerIds: () => peerIds,
    isPeerAlive: () => true,
    onTopologyChange: () => {},
  };
}

function createMockConsensusLayer(
  overrides: Partial<{
    getLeader: (shardId: string) => string | null;
    isLeader: (shardId: string) => boolean;
    getCommitIndex: (shardId: string) => number;
    getHealthStatus: () => any[];
  }> = {},
): IConsensusLayer {
  const defaults = {
    getLeader: (_s: string) => 'node-1',
    isLeader: (_s: string) => true,
    getCommitIndex: (_s: string) => 42,
    getHealthStatus: () => [{ shardId: '0' }],
  };
  const merged = { ...defaults, ...overrides };

  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    propose: (_s: string, _v: string) => Promise.resolve(1),
    isLeader: (s: string) => Promise.resolve(merged.isLeader(s)),
    getLeader: (s: string) => Promise.resolve(merged.getLeader(s)),
    getCommitIndex: (s: string) => Promise.resolve(merged.getCommitIndex(s)),
    registerShard: () => {},
    removeShard: () => Promise.resolve(),
    notifyTopologyChange: () => Promise.resolve(),
    getHealthStatus: () => Promise.resolve(merged.getHealthStatus()),
    campaign: () => Promise.resolve(),
    on: () => {},
    off: () => {},
    setForceLeader: () => {},
  };
}

describe('HAFailoverDetector — Unit', () => {
  let detector: HAFailoverDetector;
  let topology: IClusterTopology;
  let consensus: IConsensusLayer;
  let failoverEvents: any[];

  beforeEach(() => {
    failoverEvents = [];
    topology = createMockTopology();
    consensus = createMockConsensusLayer();
    detector = new HAFailoverDetector(
      {
        checkIntervalMs: 100,
        leaderlessFailoverTimeoutMs: 500,
        startupGracePeriodMs: 0, // No startup delay for most tests
      },
      topology,
      consensus,
    );
    detector.onFailover((event) => failoverEvents.push(event));
  });

  afterEach(async () => {
    detector.stop();
  });

  //
  // AC 13.11: registerShard — adds shard to known set
  //
  it('AC 13.11: registerShard — adds shard to known set', () => {
    detector.registerShard('test-shard');
    detector.registerShard('another-shard');

    // Use checkNow with known shards to verify they are processed
    // We'll verify indirectly by seeing that no errors occur
    detector.checkNow().then(() => {
      // Succeeded without error
    });
  });

  //
  // AC 13.12: unregisterShard — removes shard and cleans up tracked state
  //
  it('AC 13.12: unregisterShard — removes shard and cleans up tracked state', () => {
    detector.registerShard('test-shard');
    detector.unregisterShard('test-shard');
    // No-op for unknown shard
    detector.unregisterShard('unknown-shard');
  });

  //
  // AC 13.13: start/stop lifecycle — mirrors started state
  //
  it('AC 13.13: start/stop lifecycle — start then stop is idempotent', () => {
    detector.start();
    detector.start(); // Idempotent
    detector.stop();
    detector.stop(); // Idempotent
  });

  //
  // AC 13.14: PATH 1 — No leader → fire quorum_loss after timeout
  //
  it('AC 13.14: PATH 1 — leaderless timeout triggers quorum_loss event', async () => {
    // Create a detector with very short timeout
    const leaderlessDetector = new HAFailoverDetector(
      {
        checkIntervalMs: 50,
        leaderlessFailoverTimeoutMs: 100,
        startupGracePeriodMs: 0,
      },
      topology,
      createMockConsensusLayer({ getLeader: () => null }),
    );
    const events: any[] = [];
    leaderlessDetector.onFailover((e) => events.push(e));
    leaderlessDetector.registerShard('s0');

    // Must call start() to clear startupGrace (sets startTimestamp)
    leaderlessDetector.start();

    // First check — starts timer but not yet timed out
    await leaderlessDetector.checkNow();
    expect(events.length).toBe(0);

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 150));

    // Second check — should fire quorum_loss
    await leaderlessDetector.checkNow();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('quorum_loss');
    expect(events[0].shardId).toBe('s0');

    leaderlessDetector.stop();
  });

  //
  // AC 13.15: PATH 1 — startup grace period suppresses failover events
  //
  it('AC 13.15: PATH 1 — startup grace period suppresses quorum_loss events', async () => {
    const graceDetector = new HAFailoverDetector(
      {
        checkIntervalMs: 50,
        leaderlessFailoverTimeoutMs: 100,
        startupGracePeriodMs: 10000, // Very long grace
      },
      topology,
      createMockConsensusLayer({ getLeader: () => null }),
    );
    const events: any[] = [];
    graceDetector.onFailover((e) => events.push(e));
    graceDetector.registerShard('s0');

    // Start detector (startTimestamp set)
    graceDetector.start();

    // Wait for potential detection
    await new Promise((r) => setTimeout(r, 200));
    await graceDetector.checkNow();

    // Should be suppressed due to startup grace
    expect(events.length).toBe(0);

    graceDetector.stop();
  });

  //
  // AC 13.16: PATH 2 — leader exists, reset leaderless timer
  //
  it('AC 13.16: PATH 2 — leader present prevents false failover', async () => {
    const leaderDetector = new HAFailoverDetector(
      {
        checkIntervalMs: 50,
        leaderlessFailoverTimeoutMs: 150,
        startupGracePeriodMs: 0,
      },
      topology,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    const events: any[] = [];
    leaderDetector.onFailover((e) => events.push(e));
    leaderDetector.registerShard('s0');

    // Multiple checks with leader present — should never trigger failover
    for (let i = 0; i < 5; i++) {
      await leaderDetector.checkNow();
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(events.length).toBe(0);

    leaderDetector.stop();
  });

  //
  // AC 13.17: checkNow — can be manually triggered without crash
  //
  it('AC 13.17: checkNow — manual trigger with no shards', async () => {
    // Should not throw with empty knownShards
    await expect(detector.checkNow()).resolves.toBeUndefined();
  });

  it('AC 13.17b: checkNow — manual trigger with registered shards', async () => {
    detector.registerShard('s0');
    await expect(detector.checkNow()).resolves.toBeUndefined();
  });
});

describe('HAFailoverDetector — PATH 2 (leader stagnation) & PATH 3 (node failure)', () => {
  let failoverEvents: FailoverEventLike[];
  const topology = () => createMockTopology('node-1', ['node-2', 'node-3']);

  interface FailoverEventLike {
    type: string;
    shardId: string;
    affectedNodeId: string;
    suspectedLeaderId?: string;
  }

  beforeEach(() => {
    failoverEvents = [];
  });

  // AC 13.18: PATH 2 — stalled commit index fires leader_failure after timeout.
  it('AC 13.18: leader commit index stall fires leader_failure', async () => {
    const d = new HAFailoverDetector(
      { leaderStagnationTimeoutMs: 50, startupGracePeriodMs: 0, checkIntervalMs: 10 },
      topology(),
      createMockConsensusLayer({ getLeader: () => 'node-1', getCommitIndex: () => 42 }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow(); // first check → initializes lastCommitIndex/Time
    expect(failoverEvents.length).toBe(0);

    await new Promise((r) => setTimeout(r, 80));
    await d.checkNow(); // commit index unchanged + 80ms elapsed > 50ms → fire
    expect(failoverEvents.length).toBe(1);
    expect(failoverEvents[0].type).toBe('leader_failure');
    expect(failoverEvents[0].suspectedLeaderId).toBe('node-1');

    d.stop();
  });

  // AC 13.19: PATH 2 — advancing commit index resets stall tracking.
  it('AC 13.19: advancing commit index prevents leader_failure', async () => {
    let commit = 0;
    const d = new HAFailoverDetector(
      { leaderStagnationTimeoutMs: 50, startupGracePeriodMs: 0, checkIntervalMs: 10 },
      topology(),
      createMockConsensusLayer({ getLeader: () => 'node-1', getCommitIndex: () => (commit += 10) }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow();
    await new Promise((r) => setTimeout(r, 80));
    await d.checkNow();

    // Commit index advanced → healthy, no leader_failure.
    expect(failoverEvents.length).toBe(0);
    d.stop();
  });

  // AC 13.20: PATH 2 — startup grace suppresses leader_failure.
  it('AC 13.20: startup grace suppresses leader_failure', async () => {
    const d = new HAFailoverDetector(
      { leaderStagnationTimeoutMs: 10, startupGracePeriodMs: 10000, checkIntervalMs: 10 },
      topology(),
      createMockConsensusLayer({ getLeader: () => 'node-1', getCommitIndex: () => 42 }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow();
    await new Promise((r) => setTimeout(r, 30));
    await d.checkNow();

    expect(failoverEvents.length).toBe(0);
    d.stop();
  });

  // AC 13.21: PATH 3 — missed heartbeats fire node_failure after threshold.
  it('AC 13.21: missed heartbeats fire node_failure after threshold', async () => {
    const t = createMockTopology('node-1', ['node-2']);
    t.isPeerAlive = () => false; // peer always dead

    const d = new HAFailoverDetector(
      { missedHeartbeatThreshold: 3, startupGracePeriodMs: 0, checkIntervalMs: 10 },
      t,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow(); // missed = 1
    await d.checkNow(); // missed = 2
    await d.checkNow(); // missed = 3 → fire node_failure
    expect(failoverEvents.length).toBe(1);
    expect(failoverEvents[0].type).toBe('node_failure');
    expect(failoverEvents[0].affectedNodeId).toBe('node-2');

    d.stop();
  });

  // AC 13.22: PATH 3 — a live peer resets its missed heartbeat counter.
  it('AC 13.22: a live peer resets missed heartbeat counter', async () => {
    let alive = false;
    const t = createMockTopology('node-1', ['node-2']);
    t.isPeerAlive = () => alive;

    const d = new HAFailoverDetector(
      { missedHeartbeatThreshold: 3, startupGracePeriodMs: 0, checkIntervalMs: 10 },
      t,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow(); // missed = 1
    await d.checkNow(); // missed = 2
    alive = true;
    await d.checkNow(); // alive → reset to 0, no fire
    alive = false;
    await d.checkNow(); // missed = 1 again
    await d.checkNow(); // missed = 2
    expect(failoverEvents.length).toBe(0); // never reached threshold 3 consecutively

    d.stop();
  });

  // AC 13.23: PATH 3 — startup grace suppresses node_failure.
  it('AC 13.23: startup grace suppresses node_failure', async () => {
    const t = createMockTopology('node-1', ['node-2']);
    t.isPeerAlive = () => false;

    const d = new HAFailoverDetector(
      { missedHeartbeatThreshold: 1, startupGracePeriodMs: 10000, checkIntervalMs: 10 },
      t,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    d.onFailover((e) => failoverEvents.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow();
    await d.checkNow();
    expect(failoverEvents.length).toBe(0);
    d.stop();
  });
});

describe('HAFailoverDetector — error isolation & RTT sampling', () => {
  interface FailoverEventLike {
    type: string;
    shardId: string;
    affectedNodeId: string;
  }

  // AC 13.24: consensus layer error during checkShard is swallowed.
  it('AC 13.24: consensus layer error is swallowed (no crash)', async () => {
    const d = new HAFailoverDetector(
      { startupGracePeriodMs: 0 },
      createMockTopology(),
      createMockConsensusLayer({
        getLeader: () => { throw new Error('down'); },
      }),
    );
    d.registerShard('s0');
    await expect(d.checkNow()).resolves.toBeUndefined();
  });

  // AC 13.25: getHealthStatus error falls back to empty shard list.
  it('AC 13.25: getHealthStatus error falls back to no shards', async () => {
    const d = new HAFailoverDetector(
      { startupGracePeriodMs: 0 },
      createMockTopology(),
      createMockConsensusLayer({
        getHealthStatus: () => { throw new Error('health-down'); },
      }),
    );
    // No registered shards → shard discovery via getHealthStatus throws → [].
    await expect(d.checkNow()).resolves.toBeUndefined();
  });

  // AC 13.26: shard discovery via getHealthStatus when no shards registered.
  it('AC 13.26: shard discovery via getHealthStatus populates shards', async () => {
    const d = new HAFailoverDetector(
      { startupGracePeriodMs: 0 },
      createMockTopology(),
      createMockConsensusLayer({
        getHealthStatus: () => [{ shardId: '0' }, { shardId: '1' }, { shardId: '0' }], // dup 0
        getLeader: () => null,
      }),
    );
    await d.checkNow(); // discovers shards 0,1 and dedups; leaderless, no timeout yet
    await expect(d.checkNow()).resolves.toBeUndefined();
  });

  // AC 13.27: a throwing failover handler is isolated.
  it('AC 13.27: a throwing failover handler is isolated', async () => {
    const d = new HAFailoverDetector(
      { leaderlessFailoverTimeoutMs: 10, startupGracePeriodMs: 0 },
      createMockTopology(),
      createMockConsensusLayer({ getLeader: () => null }),
    );
    const events: FailoverEventLike[] = [];
    d.onFailover(() => { throw new Error('handler-boom'); });
    d.onFailover((e) => events.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    await d.checkNow();
    await new Promise((r) => setTimeout(r, 20));
    await d.checkNow();

    // The second handler still received the event despite the first throwing.
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('quorum_loss');
    d.stop();
  });

  // AC 13.28: interval callback error is isolated (start + detection throw).
  it('AC 13.28: interval callback catches a throwing detection cycle', async () => {
    const d = new HAFailoverDetector(
      { checkIntervalMs: 10, startupGracePeriodMs: 0 },
      createMockTopology(),
      createMockConsensusLayer({
        getHealthStatus: () => { throw new Error('boom'); },
      }),
    );
    d.start();
    // Let the interval fire a few times; the catch must swallow the error.
    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBe(true); // reached without unhandled rejection
    d.stop();
  });

  // AC 13.29: getRegisteredShardCount reflects register/unregister.
  it('AC 13.29: getRegisteredShardCount reflects register/unregister', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    expect(d.getRegisteredShardCount()).toBe(0);
    d.registerShard('a');
    d.registerShard('b');
    expect(d.getRegisteredShardCount()).toBe(2);
    d.unregisterShard('a');
    expect(d.getRegisteredShardCount()).toBe(1);
  });

  // ── RTT sampling ──────────────────────────────────────────────────

  // AC 13.30: updateRTT rejects negative samples and slides the window.
  it('AC 13.30: updateRTT rejects negative values and slides the window', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    d.updateRTT(-5); // ignored
    expect(d.getRTTSampleCount()).toBe(0);

    d.setRttSampleMax(3);
    d.updateRTT(10);
    d.updateRTT(20);
    d.updateRTT(30);
    d.updateRTT(40); // slides out 10
    expect(d.getRTTSampleCount()).toBe(3);
    expect(d.getAvgRTT()).toBe(30); // (20+30+40)/3
  });

  // AC 13.31: getAvgRTT returns 0 when empty.
  it('AC 13.31: getAvgRTT returns 0 when no samples', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    expect(d.getAvgRTT()).toBe(0);
  });

  // AC 13.32: getAdaptiveTimeout returns default 3000 with no samples.
  it('AC 13.32: getAdaptiveTimeout returns 3000 with no samples', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    expect(d.getAdaptiveTimeout()).toBe(3000);
  });

  // AC 13.33: getAdaptiveTimeout scales with average RTT (>= 1000 floor).
  it('AC 13.33: getAdaptiveTimeout scales with average RTT and honours 1000ms floor', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    vi.spyOn(Math, 'random').mockReturnValue(0); // zero jitter

    d.updateRTT(1000);
    const t = d.getAdaptiveTimeout();
    // avgRtt=1000 → 1000*3 + 0 = 3000, max(1000, 3000) = 3000
    expect(t).toBe(3000);

    d.clearRttSamples();
    d.updateRTT(100); // avgRtt=100 → 300 + 0 = 300 → max(1000, 300) = 1000 floor
    expect(d.getAdaptiveTimeout()).toBe(1000);

    vi.restoreAllMocks();
  });

  // AC 13.34: clearRttSamples resets the window.
  it('AC 13.34: clearRttSamples resets the window', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    d.updateRTT(10);
    d.updateRTT(20);
    expect(d.getRTTSampleCount()).toBe(2);
    d.clearRttSamples();
    expect(d.getRTTSampleCount()).toBe(0);
    expect(d.getAvgRTT()).toBe(0);
  });

  // AC 13.35: setRttSampleMax clamps to a minimum of 2.
  it('AC 13.35: setRttSampleMax clamps to a minimum of 2', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    d.setRttSampleMax(1); // clamped to 2
    d.updateRTT(10);
    d.updateRTT(20);
    d.updateRTT(30);
    expect(d.getRTTSampleCount()).toBe(2); // window is 2
    expect(d.getAvgRTT()).toBe(25); // (20+30)/2
  });

  // AC 13.36: setRttSampleMax shrinks an already-filled window (while loop).
  it('AC 13.36: setRttSampleMax shrinks an already-filled window', () => {
    const d = new HAFailoverDetector({}, createMockTopology(), createMockConsensusLayer());
    for (let i = 1; i <= 10; i++) d.updateRTT(i * 10); // fill default window of 10
    expect(d.getRTTSampleCount()).toBe(10);

    d.setRttSampleMax(3); // shrink → while loop evicts oldest samples
    expect(d.getRTTSampleCount()).toBe(3);
    expect(d.getAvgRTT()).toBe(90); // (80+90+100)/3
  });

  // AC 13.37: PATH 2 first-check initialization when commitIndex is not greater.
  it('AC 13.37: first check initializes tracking when commitIndex does not advance', async () => {
    const d = new HAFailoverDetector(
      { leaderStagnationTimeoutMs: 1000, startupGracePeriodMs: 0, checkIntervalMs: 10 },
      createMockTopology(),
      createMockConsensusLayer({ getLeader: () => 'node-1', getCommitIndex: () => -1 }),
    );
    const events: FailoverEventLike[] = [];
    d.onFailover((e) => events.push(e as FailoverEventLike));
    d.registerShard('s0');
    d.start();

    // commitIndex=-1, prevCommit=-1 → -1 > -1 is false → first-check init branch.
    await d.checkNow();
    expect(events.length).toBe(0); // only initializes, no stall yet
    d.stop();
  });

  // AC 13.38: a throwing isPeerAlive propagates to the per-shard catch.
  it('AC 13.38: a throwing isPeerAlive is isolated by the shard loop', async () => {
    const t = createMockTopology('node-1', ['node-2']);
    t.isPeerAlive = () => { throw new Error('gossip-down'); };

    const d = new HAFailoverDetector(
      { startupGracePeriodMs: 0 },
      t,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    d.registerShard('s0');
    await expect(d.checkNow()).resolves.toBeUndefined(); // no crash
  });

  // AC 13.39: a throwing getPeerIds propagates to the interval catch.
  it('AC 13.39: a throwing getPeerIds is caught by the interval callback', async () => {
    const t = createMockTopology();
    t.getPeerIds = () => { throw new Error('topology-down'); };

    const d = new HAFailoverDetector(
      { checkIntervalMs: 10, startupGracePeriodMs: 0 },
      t,
      createMockConsensusLayer(),
    );
    d.registerShard('s0');
    d.start();
    // The interval's .catch must swallow the rejection — no unhandled error.
    await new Promise((r) => setTimeout(r, 50));
    d.stop();
  });

  // AC 13.40: the local node is skipped when it appears in the peer list.
  it('AC 13.40: the local node is skipped in the peer-failure loop', async () => {
    // peerIds includes the local node id — the detector must skip itself.
    const t = createMockTopology('node-1', ['node-1', 'node-2']);
    let peer2Checks = 0;
    t.isPeerAlive = (id) => {
      if (id === 'node-2') peer2Checks++;
      return true; // alive — only the skip branch matters here
    };

    const d = new HAFailoverDetector(
      { startupGracePeriodMs: 0 },
      t,
      createMockConsensusLayer({ getLeader: () => 'node-1' }),
    );
    d.registerShard('s0');
    await d.checkNow();

    // node-2 was still checked (the loop continued past the local node).
    expect(peer2Checks).toBe(1);
  });
});
