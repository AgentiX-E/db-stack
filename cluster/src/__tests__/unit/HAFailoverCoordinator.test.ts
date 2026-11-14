/**
 * HAFailoverCoordinator Unit Tests
 *
 * Iteration 31 — comprehensive coverage of the HA failover coordinator to
 * ≥95% on all dimensions (lines/statements/branches/functions).
 *
 * Acceptance criteria:
 *   AC 31.1  constructor wires up injected vs default collaborators
 *   AC 31.2  initialize wires the detector, registers the failover handler,
 *            and is idempotent
 *   AC 31.3  handleFailover: node_failure full flow (verify → takeover →
 *            fence → election → topology → reconfiguration → consistency →
 *            client notify → status updates)
 *   AC 31.4  handleFailover: verifyFailure aborts when a leader already exists
 *   AC 31.5  handleFailover: verifyFailure leader shows up after double-check
 *   AC 31.6  handleFailover: shouldTakeOver false path (marks unhealthy)
 *   AC 31.7  handleFailover: election failure path
 *   AC 31.8  handleFailover: consistency check throws (non-regression guard)
 *   AC 31.9  handleFailover: outer catch logs an exception
 *   AC 31.10 verifyFailure: quorum_loss / node_failure / catch branch
 *   AC 31.11 shouldTakeOver: leader_failure (already leader / affected / true),
 *           node_failure, quorum_loss, unknown type
 *   AC 31.12 triggerElection: leader already exists / appears after backoff /
 *           campaign success / no-leader force / campaign throws → propose
 *           fallback / propose also throws / node_failure passthrough / outer catch
 *   AC 31.13 handleRaftReconfiguration: double-removal guard / success / throw
 *   AC 31.14 getStatus healthy vs unhealthy classification
 *   AC 31.15 getters (detector/verifier/clientManager/clockCompensator)
 *   AC 31.16 registerShard / shutdown / markNodeRecovered
 *   AC 31.17 transferLeadership: concurrent / self / dead-target / log-gap /
 *           success / timeout / getHealthStatus fallback / clock not sync
 *   AC 31.18 executeTransfer: success / not-leader / throw
 *   AC 31.19 setTransferConfig / setClockCompensationEnabled /
 *           isClockCompensationEnabled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HAFailoverCoordinator } from '../../ha/HAFailoverCoordinator';
import {
  HAFailoverDetector,
  type FailoverEvent,
} from '../../ha/HAFailoverDetector';
import { HAConsistencyVerifier } from '../../ha/HAConsistencyVerifier';
import { HAClientManager } from '../../ha/HAClientManager';
import { ClockCompensator } from '../../ha/ClockCompensator';
import {
  IConsensusLayer,
  IClusterTopology,
  TopologyChange,
} from '../../consensus/interfaces/interfaces';

// ─────────────────────────────────────────────────────────────
//  Mock HAFailoverDetector so we can capture the onFailover callback
//  and avoid real internal timers.
// ─────────────────────────────────────────────────────────────

const mockFailoverHandler = vi.hoisted(() => {
  return { current: null as null | ((e: FailoverEvent) => void) };
});

const mockLogger = vi.hoisted(() => {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
});

vi.mock('pino', () => {
  return {
    default: vi.fn(() => mockLogger),
  };
});

vi.mock('../../ha/HAFailoverDetector', async () => {
  const actual = await vi.importActual<typeof import('../../ha/HAFailoverDetector')>(
    '../../ha/HAFailoverDetector',
  );
  return {
    ...actual,
    HAFailoverDetector: class MockDetector {
      start = vi.fn();
      stop = vi.fn();
      registerShard = vi.fn();
      unregisterShard = vi.fn();
      onFailover = vi.fn((handler: (e: FailoverEvent) => void) => {
        mockFailoverHandler.current = handler;
      });
    },
  };
});

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function createMockTopology(
  nodeId = 'node-1',
  peerIds = ['node-2', 'node-3'],
  isPeerAlive: (id: string) => boolean = () => true,
): IClusterTopology {
  return {
    getNodeId: () => nodeId,
    getPeerIds: () => peerIds,
    isPeerAlive,
    onTopologyChange: () => {},
  };
}

/**
 * A fully controllable IConsensusLayer mock. Every method is a vi.fn whose
 * implementation can be overridden per test.
 */
function createMockConsensus(
  overrides: Partial<Record<keyof IConsensusLayer, unknown>> = {},
): IConsensusLayer {
  const base: IConsensusLayer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    propose: vi.fn().mockResolvedValue(1),
    isLeader: vi.fn().mockResolvedValue(false),
    getLeader: vi.fn().mockResolvedValue(null),
    getCommitIndex: vi.fn().mockResolvedValue(42),
    registerShard: vi.fn(),
    removeShard: vi.fn().mockResolvedValue(undefined),
    notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue([]),
    campaign: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    setForceLeader: vi.fn(),
  };
  return Object.assign(base, overrides) as IConsensusLayer;
}

function createMockVerifier(returns = true): HAConsistencyVerifier {
  return {
    verifyNewLeaderConsistency: vi.fn().mockResolvedValue(returns),
  } as unknown as HAConsistencyVerifier;
}

function createMockClientManager(): HAClientManager {
  return {
    onLeaderChange: vi.fn(),
  } as unknown as HAClientManager;
}

function createMockClock(synchronized = true, maxOffset = 0): ClockCompensator {
  return {
    synchronized: vi.fn().mockReturnValue(synchronized),
    getMaxAbsOffset: vi.fn().mockReturnValue(maxOffset),
  } as unknown as ClockCompensator;
}

interface Collaborators {
  consensus: IConsensusLayer;
  topology: IClusterTopology;
  verifier: HAConsistencyVerifier;
  clientManager: HAClientManager;
  clock: ClockCompensator;
  fencing: { fenceNode: ReturnType<typeof vi.fn> };
  coord: HAFailoverCoordinator;
}

function build(cfg: {
  consensus?: IConsensusLayer;
  topology?: IClusterTopology;
  verifier?: HAConsistencyVerifier;
  clientManager?: HAClientManager;
  clock?: ClockCompensator;
  fencing?: { fenceNode: ReturnType<typeof vi.fn> };
  detectorConfig?: Record<string, unknown>;
} = {}): Collaborators {
  const consensus = cfg.consensus ?? createMockConsensus();
  const topology = cfg.topology ?? createMockTopology();
  const verifier = cfg.verifier ?? createMockVerifier(true);
  const clientManager = cfg.clientManager ?? createMockClientManager();
  const clock = cfg.clock ?? createMockClock(true);
  const fencing = cfg.fencing ?? { fenceNode: vi.fn() };
  const coord = new HAFailoverCoordinator(
    consensus,
    topology,
    verifier,
    clientManager,
    clock,
    fencing as any,
    cfg.detectorConfig as any,
  );
  return { consensus, topology, verifier, clientManager, clock, fencing, coord };
}

function event(overrides: Partial<FailoverEvent> = {}): FailoverEvent {
  return {
    type: 'node_failure',
    shardId: 's0',
    affectedNodeId: 'node-2',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFailoverHandler.current = null;
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.info.mockClear();
  mockLogger.debug.mockClear();
});

describe('HAFailoverCoordinator — constructor & lifecycle', () => {
  it('AC 31.1: wires up injected collaborators without throwing', () => {
    const { coord } = build();
    expect(coord).toBeInstanceOf(HAFailoverCoordinator);
  });

  it('AC 31.1: falls back to default collaborators when omitted', () => {
    const consensus = createMockConsensus();
    const topology = createMockTopology();
    const coord = new HAFailoverCoordinator(consensus, topology);
    // Defaults are real instances (verifier/client/clock), not undefined.
    expect(coord.getConsistencyVerifier()).toBeInstanceOf(HAConsistencyVerifier);
    expect(coord.getClientManager()).toBeInstanceOf(HAClientManager);
    expect(coord.getClockCompensator()).toBeInstanceOf(ClockCompensator);
    coord.shutdown();
  });

  it('AC 31.2: initialize binds the failover handler, starts the detector, is idempotent', () => {
    const { coord } = build();
    const detector = coord.getDetector() as any;

    coord.initialize();
    expect(mockFailoverHandler.current).toBeTypeOf('function');
    expect(detector.start).toHaveBeenCalledTimes(1);

    // Second initialize is a no-op.
    coord.initialize();
    expect(detector.start).toHaveBeenCalledTimes(1);

    coord.shutdown();
  });

  it('AC 31.15/31.16: getters return injected collaborators; shutdown stops detector', () => {
    const { coord, consensus, topology, verifier, clientManager, clock } = build();
    coord.initialize();
    expect(coord.getDetector()).toBeDefined();
    expect(coord.getConsistencyVerifier()).toBe(verifier);
    expect(coord.getClientManager()).toBe(clientManager);
    expect(coord.getClockCompensator()).toBe(clock);
    expect(
      coord.isClockCompensationEnabled(),
    ).toBe(true);

    coord.shutdown();
    expect((coord.getDetector() as any).stop).toHaveBeenCalled();
    expect(coord.isClockCompensationEnabled()).toBe(true);
  });

  it('AC 31.16: registerShard delegates to the detector', () => {
    const { coord } = build();
    coord.registerShard('s9');
    expect((coord.getDetector() as any).registerShard).toHaveBeenCalledWith('s9');
  });

  it('AC 31.16b: the failover handler logs and swallows a rejecting handleFailover', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus });
    coord.initialize();

    // Make the very first warn inside handleFailover (before its try block)
    // throw, so handleFailover rejects and the handler's .catch runs.
    mockLogger.warn.mockImplementationOnce(() => {
      throw new Error('logger-warn-fail');
    });

    const handler = mockFailoverHandler.current;
    expect(handler).toBeTypeOf('function');

    // The handler swallows the rejection into logger.error.
    await handler!(event({ type: 'node_failure' }));
    // Give the microtask queue a tick for the .catch to run.
    await new Promise((r) => setImmediate(r));
    expect(mockLogger.error).toHaveBeenCalled();

    mockLogger.warn.mockClear();
    coord.shutdown();
  });

  it('AC 31.16: markNodeRecovered clears unhealthy and removed sets', () => {
    const { coord } = build();
    (coord as any).unhealthyNodes.add('node-2');
    (coord as any).removedFromRaft.add('node-2');
    coord.markNodeRecovered('node-2');
    expect((coord as any).unhealthyNodes.has('node-2')).toBe(false);
    expect((coord as any).removedFromRaft.has('node-2')).toBe(false);
  });
});

describe('HAFailoverCoordinator — handleFailover', () => {
  it('AC 31.3: leader_failure full flow triggers reconfiguration (Stage 6)', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      isLeader: vi.fn().mockResolvedValue(false),
      campaign: vi.fn().mockResolvedValue(undefined),
      notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
    });
    const { coord } = build({ consensus });

    const result = await (coord as any).handleFailover(
      event({ type: 'leader_failure', affectedNodeId: 'node-2' }),
    );

    expect(result).toBe(true);
    // Stage 6 reconfiguration removes the dead node.
    expect((coord as any).removedFromRaft.has('node-2')).toBe(true);
  });

  it('AC 31.3: node_failure full flow completes and returns true', async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    const onLeaderChange = vi.fn();
    const fenceNode = vi.fn();
    const consensus = createMockConsensus({
      notifyTopologyChange: notifySpy,
      getLeader: vi.fn().mockResolvedValue(null),
      isLeader: vi.fn().mockResolvedValue(false),
      campaign: vi.fn().mockResolvedValue(undefined),
      getCommitIndex: vi.fn().mockResolvedValue(10),
    });
    const clientManager = { onLeaderChange } as unknown as HAClientManager;
    const { coord, verifier } = build({
      consensus,
      clientManager,
      fencing: { fenceNode },
    });

    const result = await (coord as any).handleFailover(event({ type: 'node_failure' }));

    expect(result).toBe(true);
    expect(notifySpy).toHaveBeenCalled();
    expect(onLeaderChange).toHaveBeenCalled();
    expect(verifier.verifyNewLeaderConsistency).toHaveBeenCalled();
    expect((coord as any).totalFailovers).toBe(1);
    expect((coord as any).activeFailovers).toBe(0);
    expect((coord as any).lastFailoverTime).toBeTypeOf('string');
    expect((coord as any).unhealthyNodes.has('node-2')).toBe(true);
  });

  it('AC 31.4: verifyFailure aborts when a leader already exists', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue('node-3'),
    });
    const { coord } = build({ consensus });

    const result = await (coord as any).handleFailover(
      event({ type: 'leader_failure' }),
    );

    expect(result).toBe(false);
    expect((coord as any).activeFailovers).toBe(0);
  });

  it('AC 31.5: leader shows up after the double-check wait → aborts', async () => {
    let calls = 0;
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockImplementation(() => {
        calls++;
        return calls === 1 ? null : 'node-2';
      }),
    });
    const { coord } = build({ consensus });

    const result = await (coord as any).handleFailover(
      event({ type: 'quorum_loss' }),
    );

    expect(result).toBe(false);
  });

  it('AC 31.6: shouldTakeOver false path marks the node unhealthy and returns false', async () => {
    // local node is the affected node for node_failure → cannot take over.
    const consensus = createMockConsensus();
    const topology = createMockTopology('node-2', ['node-3']);
    const { coord } = build({ consensus, topology });

    const result = await (coord as any).handleFailover(
      event({ type: 'node_failure', affectedNodeId: 'node-2' }),
    );

    expect(result).toBe(false);
    expect((coord as any).unhealthyNodes.has('node-2')).toBe(true);
  });

  it('AC 31.7: triggerElection throws unexpectedly → handleFailover returns false', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus });

    // Force triggerElection's outer catch by making the logger throw on the
    // first (unprotected) info call inside the election try block.
    mockLogger.info.mockImplementationOnce(() => {
      throw new Error('logger-fail');
    });

    const result = await (coord as any).handleFailover(
      event({ type: 'quorum_loss' }),
    );

    expect(result).toBe(false);
    expect((coord as any).activeFailovers).toBe(0);
  });

  it('AC 31.7b: triggerElection returns false → "failed to trigger" branch decrements counter', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus });

    // Make the pre-backoff debug log (inside triggerElection's outer try, but
    // outside the inner try/catch) throw so triggerElection returns false
    // without propagating an exception to handleFailover's outer catch.
    mockLogger.debug.mockImplementationOnce(() => {
      throw new Error('election-body-fail');
    });

    const result = await (coord as any).handleFailover(
      event({ type: 'quorum_loss' }),
    );

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('AC 31.8b: consistency error with no message uses the "unknown error" fallback', async () => {
    const verifier = {
      verifyNewLeaderConsistency: vi.fn().mockRejectedValue(undefined),
    } as unknown as HAConsistencyVerifier;
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus, verifier });
    const r = await (coord as any).handleFailover(event({ type: 'node_failure' }));
    expect(r).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('AC 31.8c: empty peer list falls back to "unknown" leader address', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const clientManager = { onLeaderChange: vi.fn() } as unknown as HAClientManager;
    const topology = createMockTopology('node-1', []);
    const { coord } = build({ consensus, clientManager, topology });
    const r = await (coord as any).handleFailover(event({ type: 'node_failure' }));
    expect(r).toBe(true);
    expect(clientManager.onLeaderChange).toHaveBeenCalledWith('s0', 'node-1', 'unknown');
  });

  it('AC 31.8: consistency check throws → caught and warn-logged, still returns true', async () => {
    const verifier = {
      verifyNewLeaderConsistency: vi.fn().mockRejectedValue(new Error('divergent')),
    } as unknown as HAConsistencyVerifier;
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      isLeader: vi.fn().mockResolvedValue(false),
      getCommitIndex: vi.fn().mockResolvedValue(9),
    });
    const { coord } = build({ consensus, verifier });

    const result = await (coord as any).handleFailover(
      event({ type: 'node_failure' }),
    );

    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('AC 31.8: consistency returns false → warn path, returns true', async () => {
    const verifier = createMockVerifier(false);
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus, verifier });

    const result = await (coord as any).handleFailover(
      event({ type: 'node_failure' }),
    );

    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('AC 31.8: getCommitIndex throws → passes undefined baseline, still succeeds', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      getCommitIndex: vi.fn().mockRejectedValue(new Error('nope')),
    });
    const verifier = createMockVerifier(true);
    const { coord } = build({ consensus, verifier });

    const result = await (coord as any).handleFailover(
      event({ type: 'node_failure' }),
    );

    expect(result).toBe(true);
    expect(verifier.verifyNewLeaderConsistency).toHaveBeenCalled();
  });

  it('AC 31.9: outer catch logs an exception and returns false', async () => {
    const consensus2 = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      isLeader: vi.fn().mockResolvedValue(false),
      notifyTopologyChange: vi.fn().mockRejectedValue(new Error('notify-fail')),
    });
    const { coord: coord2 } = build({ consensus: consensus2 });
    const result = await (coord2 as any).handleFailover(event({ type: 'node_failure' }));
    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('AC 31.10: verifyFailure for node_failure skips leader checks and returns true', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockRejectedValue(new Error('unreachable')),
    });
    const { coord } = build({ consensus });
    const result = await (coord as any).verifyFailure(event({ type: 'node_failure' }));
    expect(result).toBe(true);
  });

  it('AC 31.10: verifyFailure catch branch proceeds when getLeader throws', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockRejectedValue(new Error('unreachable')),
    });
    const { coord } = build({ consensus });
    const result = await (coord as any).verifyFailure(event({ type: 'quorum_loss' }));
    expect(result).toBe(true);
  });

  it('AC 31.10: verifyFailure aborts when a leader already exists for leader_failure', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue('node-2'),
    });
    const { coord } = build({ consensus });
    const result = await (coord as any).verifyFailure(event({ type: 'leader_failure' }));
    expect(result).toBe(false);
  });

  it('AC 31.10: verifyFailure aborts when a leader appears after the wait', async () => {
    let calls = 0;
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockImplementation(() => {
        calls++;
        return calls === 1 ? null : 'node-2';
      }),
    });
    const { coord } = build({ consensus });
    expect(await (coord as any).verifyFailure(event({ type: 'leader_failure' }))).toBe(false);
  });
});

describe('HAFailoverCoordinator — shouldTakeOver', () => {
  it('AC 31.11: leader_failure with local node affected → false', async () => {
    const topology = createMockTopology('node-2', ['node-3']);
    const { coord } = build({ topology });
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'leader_failure', affectedNodeId: 'node-2' }),
      'node-2',
    );
    expect(r).toBe(false);
  });

  it('AC 31.11: leader_failure when already leader → false', async () => {
    const consensus = createMockConsensus({ isLeader: vi.fn().mockResolvedValue(true) });
    const { coord } = build({ consensus });
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'leader_failure', affectedNodeId: 'node-2' }),
      'node-1',
    );
    expect(r).toBe(false);
  });

  it('AC 31.11: leader_failure when not leader and not affected → true', async () => {
    const consensus = createMockConsensus({ isLeader: vi.fn().mockResolvedValue(false) });
    const { coord } = build({ consensus });
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'leader_failure', affectedNodeId: 'node-2' }),
      'node-1',
    );
    expect(r).toBe(true);
  });

  it('AC 31.11: leader_failure isLeader throws → assume takeover (true)', async () => {
    const consensus = createMockConsensus({
      isLeader: vi.fn().mockRejectedValue(new Error('x')),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'leader_failure', affectedNodeId: 'node-2' }),
      'node-1',
    );
    expect(r).toBe(true);
  });

  it('AC 31.11: node_failure → local !== affected', async () => {
    const { coord } = build({ topology: createMockTopology('node-1', ['node-2']) });
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'node_failure', affectedNodeId: 'node-2' }),
      'node-1',
    );
    expect(r).toBe(true);
    const r2 = await (coord as any).shouldTakeOver(
      event({ type: 'node_failure', affectedNodeId: 'node-1' }),
      'node-1',
    );
    expect(r2).toBe(false);
  });

  it('AC 31.11: quorum_loss → always true', async () => {
    const { coord } = build();
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'quorum_loss' }),
      'node-1',
    );
    expect(r).toBe(true);
  });

  it('AC 31.11: unknown type → false', async () => {
    const { coord } = build();
    const r = await (coord as any).shouldTakeOver(
      event({ type: 'unknown' as any }),
      'node-1',
    );
    expect(r).toBe(false);
  });
});

describe('HAFailoverCoordinator — triggerElection', () => {
  it('AC 31.12: leader already exists → true without campaigning', async () => {
    const consensus = createMockConsensus({ getLeader: vi.fn().mockResolvedValue('node-3') });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
    expect(consensus.campaign).not.toHaveBeenCalled();
  });

  it('AC 31.12: leader appears after backoff → skip campaign and return true', async () => {
    let calls = 0;
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockImplementation(() => {
        calls++;
        return calls === 1 ? null : 'node-2';
      }),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'leader_failure' }), 'node-1');
    expect(r).toBe(true);
  });

  it('AC 31.12: campaign succeeds → returns true', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockResolvedValue(undefined),
      isLeader: vi.fn().mockResolvedValue(true),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
  });

  it('AC 31.12: campaign does not produce leadership and no leader → forces leader', async () => {
    const setForceLeader = vi.fn();
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockResolvedValue(undefined),
      isLeader: vi.fn().mockResolvedValue(false),
      setForceLeader,
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
    expect(setForceLeader).toHaveBeenCalledWith(true);
  });

  it('AC 31.12: campaign throws → propose fallback succeeds', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockRejectedValue(new Error('no voting member')),
      propose: vi.fn().mockResolvedValue(1),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
    expect(consensus.propose).toHaveBeenCalled();
  });

  it('AC 31.12: campaign and propose both throw → waits for auto-election (isLeader true)', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockRejectedValue(new Error('c')),
      propose: vi.fn().mockRejectedValue(new Error('p')),
      isLeader: vi.fn().mockResolvedValue(true),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    // After fallback failure, it checks isLeader → true, returns true.
    expect(r).toBe(true);
  });

  it('AC 31.12: campaign + propose both throw, auto-election not leader → returns true (fall-through)', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockRejectedValue(new Error('c')),
      propose: vi.fn().mockRejectedValue(new Error('p')),
      isLeader: vi.fn().mockResolvedValue(false),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
  });

  it('AC 31.12: outer catch returns false when the election body throws', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
    });
    const { coord } = build({ consensus });
    // The pre-backoff debug log is the first logger call inside the outer try
    // block that is not itself wrapped in an inner try/catch; make it throw.
    mockLogger.debug.mockImplementationOnce(() => {
      throw new Error('sync throw');
    });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('AC 31.12: leader check throws at each guard → empty catch blocks exercised', async () => {
    // getLeader rejects at every guard; campaign succeeds; isLeader false so
    // the force-leader path runs with getLeader rejecting again.
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockRejectedValue(new Error('unavailable')),
      campaign: vi.fn().mockResolvedValue(undefined),
      isLeader: vi.fn().mockResolvedValue(false),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
  });

  it('AC 31.12: propose fallback isLeader check throws → empty catch exercised', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue(null),
      campaign: vi.fn().mockRejectedValue(new Error('c')),
      propose: vi.fn().mockRejectedValue(new Error('p')),
      isLeader: vi.fn().mockRejectedValue(new Error('no')),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'quorum_loss' }), 'node-1');
    expect(r).toBe(true);
  });

  it('AC 31.12: node_failure → no election needed, returns true', async () => {
    const consensus = createMockConsensus();
    const { coord } = build({ consensus });
    const r = await (coord as any).triggerElection(event({ type: 'node_failure' }), 'node-1');
    expect(r).toBe(true);
    expect(consensus.campaign).not.toHaveBeenCalled();
  });
});

describe('HAFailoverCoordinator — handleRaftReconfiguration', () => {
  it('AC 31.13: double-removal guard skips processing', async () => {
    const { coord, consensus } = build();
    (coord as any).removedFromRaft.add('node-2');
    await (coord as any).handleRaftReconfiguration(event());
    expect(consensus.notifyTopologyChange).not.toHaveBeenCalled();
  });

  it('AC 31.13: removes dead node and records it', async () => {
    const { coord, consensus } = build();
    await (coord as any).handleRaftReconfiguration(event());
    expect(consensus.notifyTopologyChange).toHaveBeenCalled();
    expect((coord as any).removedFromRaft.has('node-2')).toBe(true);
  });

  it('AC 31.13: notifyTopologyChange throws → caught and logged', async () => {
    const consensus = createMockConsensus({
      notifyTopologyChange: vi.fn().mockRejectedValue(new Error('x')),
    });
    const { coord } = build({ consensus });
    await (coord as any).handleRaftReconfiguration(event());
    expect((coord as any).removedFromRaft.has('node-2')).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe('HAFailoverCoordinator — getStatus', () => {
  it('AC 31.14: classifies local + peers into healthy/unhealthy', () => {
    const { coord } = build({ topology: createMockTopology('node-1', ['node-2', 'node-3']) });
    coord.initialize();
    (coord as any).unhealthyNodes.add('node-2');
    const status = coord.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.healthyNodes).toContain('node-1');
    expect(status.healthyNodes).toContain('node-3');
    expect(status.unhealthyNodes).toContain('node-2');
  });

  it('AC 31.14: local node unhealthy → moved to unhealthy list', () => {
    const { coord } = build({ topology: createMockTopology('node-1', []) });
    coord.initialize();
    (coord as any).unhealthyNodes.add('node-1');
    const status = coord.getStatus();
    expect(status.healthyNodes).not.toContain('node-1');
    expect(status.unhealthyNodes).toContain('node-1');
    expect(status.lastFailoverTime).toBeNull();
  });
});

describe('HAFailoverCoordinator — transferLeadership', () => {
  it('AC 31.17: transfer already in progress → false', async () => {
    const { coord } = build();
    (coord as any).transferInProgress.set('s0', true);
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.17: transfer to self → false', async () => {
    const { coord } = build({ topology: createMockTopology('node-2', []) });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.17: target not alive → false', async () => {
    const topology = createMockTopology('node-1', ['node-2'], () => false);
    const { coord } = build({ topology });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.17: log gap exceeds threshold → false', async () => {
    const { coord } = build();
    const r = await coord.transferLeadership('s0', 'node-2', 0, 99999);
    expect(r).toBe(false);
  });

  it('AC 31.17: successful transfer', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue('node-2'),
      notifyTopologyChange: vi.fn().mockResolvedValue(undefined),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2', 100, 100);
    expect(r).toBe(true);
    expect((coord as any).transferInProgress.get('s0')).toBe(false);
  });

  it('AC 31.17: transfer times out → false', async () => {
    vi.useFakeTimers();
    try {
      const consensus = createMockConsensus({
        getLeader: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      const { coord } = build({ consensus });
      const p = coord.transferLeadership('s0', 'node-2');
      vi.runAllTimersAsync();
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC 31.17: getHealthStatus fallback — target commit index gap too large', async () => {
    const consensus = createMockConsensus({
      getHealthStatus: vi.fn().mockResolvedValue([
        { nodeId: 'node-2', matchIndex: 0 },
      ]),
      getCommitIndex: vi.fn().mockResolvedValue(99999),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.17: getHealthStatus fallback — matches by leaderId and uses commitIndex', async () => {
    let localIdx = 99999;
    const consensus = createMockConsensus({
      getHealthStatus: vi.fn().mockResolvedValue([
        { nodeId: 'other', leaderId: 'node-2', matchIndex: null, commitIndex: 0 },
      ]),
      getCommitIndex: vi.fn().mockImplementation(() => localIdx),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.17: getHealthStatus fallback — no target info proceeds with transfer', async () => {
    const consensus = createMockConsensus({
      getHealthStatus: vi.fn().mockResolvedValue([{ nodeId: 'other', leaderId: 'other' }]),
      getLeader: vi.fn().mockResolvedValue('node-2'),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(true);
  });

  it('AC 31.17: getHealthStatus fallback — target info without match/commit index defaults to 0', async () => {
    const consensus = createMockConsensus({
      getHealthStatus: vi.fn().mockResolvedValue([
        { nodeId: 'node-2', leaderId: undefined, matchIndex: undefined, commitIndex: undefined },
      ]),
      getCommitIndex: vi.fn().mockResolvedValue(0),
      getLeader: vi.fn().mockResolvedValue('node-2'),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(true);
  });

  it('AC 31.17: getHealthStatus fallback throws → proceeds with transfer', async () => {
    const consensus = createMockConsensus({
      getHealthStatus: vi.fn().mockRejectedValue(new Error('nope')),
      getLeader: vi.fn().mockResolvedValue('node-2'),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2');
    expect(r).toBe(true);
  });

  it('AC 31.17: clock not synchronized → warns but proceeds', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue('node-2'),
    });
    const clock = createMockClock(false, 60);
    const { coord } = build({ consensus, clock });
    const r = await coord.transferLeadership('s0', 'node-2', 100, 100);
    expect(r).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('AC 31.18: executeTransfer target is not leader → false', async () => {
    const consensus = createMockConsensus({
      getLeader: vi.fn().mockResolvedValue('node-3'),
    });
    const { coord } = build({ consensus });
    const r = await (coord as any).executeTransfer('s0', 'node-2');
    expect(r).toBe(false);
  });

  it('AC 31.18: executeTransfer throws → rethrown', async () => {
    const consensus = createMockConsensus({
      notifyTopologyChange: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { coord } = build({ consensus });
    await expect((coord as any).executeTransfer('s0', 'node-2')).rejects.toThrow('boom');
  });

  it('AC 31.18: transferLeadership catch path (try block throws → catch → finally)', async () => {
    const consensus = createMockConsensus({
      notifyTopologyChange: vi.fn().mockRejectedValue(new Error('notify-boom')),
    });
    const { coord } = build({ consensus });
    const r = await coord.transferLeadership('s0', 'node-2', 100, 100);
    expect(r).toBe(false);
    expect((coord as any).transferInProgress.get('s0')).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('AC 31.19: setTransferConfig clamps min values', () => {
    const { coord } = build();
    coord.setTransferConfig({ maxTransferLagMs: 1, transferTimeoutMs: 1 });
    expect((coord as any).maxTransferLagMs).toBe(100);
    expect((coord as any).transferTimeoutMs).toBe(1000);
    coord.setTransferConfig({ maxTransferLagMs: 500, transferTimeoutMs: 5000 });
    expect((coord as any).maxTransferLagMs).toBe(500);
    expect((coord as any).transferTimeoutMs).toBe(5000);
  });

  it('AC 31.19: setClockCompensationEnabled toggles the flag', () => {
    const { coord } = build();
    expect(coord.isClockCompensationEnabled()).toBe(true);
    coord.setClockCompensationEnabled(false);
    expect(coord.isClockCompensationEnabled()).toBe(false);
  });
});