/**
 * FederationOrchestrator — the point where a failure signal becomes a recovery.
 *
 * Before IT-96 the federation layer had a detector that emitted
 * `heartbeat-expired`, a failover manager that could `detectDCFailure()` and
 * `recoverDC()`, and nothing in production connecting the two. The heartbeat's
 * only subscriber counted events; the failover manager had no caller at all.
 * A datacenter could go silent and stay "healthy" forever in the bookkeeping
 * that recovery is supposed to read.
 *
 * The subject here is that connection, not the detector or the failover
 * manager: they are tested in their own files. The signal sources and the
 * failover actions are supplied as narrow interfaces, so the orchestrator knows
 * nothing about sockets, clusters or storage engines — the callback is the seam
 * an arbitrary engine plugs into. The last case runs all three real components
 * together to prove the seam carries a real event, not just a recorded call.
 */

import { describe, it, expect } from 'vitest';
import { FederationOrchestrator } from './FederationOrchestrator';
import type {
  FailureSignalSource,
  RecoverySignalSource,
  FailoverActions,
  OrchestrationStatus,
} from './FederationOrchestrator';
import { CatastrophicFailoverManager } from './CatastrophicFailoverManager';
import { DCSplitBrainDetector } from './DCSplitBrainDetector';
import { TopologyManager } from '../topology/TopologyManager';
import { HLC } from '../hlc/HLC';
import type { ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';

// ── Observable test doubles (record calls; never decide the verdict) ──

type Expiry = { dcId: string; lastSeen: number; silenceMs: number };

function signalSources() {
  const expiries: Array<(e: Expiry) => void> = [];
  const recoveries: Array<(nodeId: string) => void> = [];
  let unsubExpiry = 0;
  let unsubRecovery = 0;

  const failure: FailureSignalSource = {
    onHeartbeatExpired(cb) {
      expiries.push(cb);
      return () => {
        const i = expiries.indexOf(cb);
        if (i >= 0) expiries.splice(i, 1);
        unsubExpiry += 1;
      };
    },
  };
  const recovery: RecoverySignalSource = {
    onTargetRecovered(cb) {
      recoveries.push(cb);
      return () => {
        const i = recoveries.indexOf(cb);
        if (i >= 0) recoveries.splice(i, 1);
        unsubRecovery += 1;
      };
    },
  };
  return {
    failure,
    recovery,
    emitExpiry: (e: Expiry) => expiries.forEach((cb) => cb(e)),
    emitRecovery: (nodeId: string) => recoveries.forEach((cb) => cb(nodeId)),
    subscriptions: () => ({ expiries: expiries.length, recoveries: recoveries.length }),
    unsubscriptions: () => ({ expiries: unsubExpiry, recoveries: unsubRecovery }),
  };
}

function failoverActions() {
  const calls: string[] = [];
  let detectVerdict = true;
  let recoverError: Error | null = null;
  const actions: FailoverActions = {
    detectDCFailure(dcId) {
      calls.push(`detect:${dcId}`);
      return detectVerdict;
    },
    async recoverDC(dcId) {
      calls.push(`recover:${dcId}`);
      if (recoverError) throw recoverError;
    },
    recordPendingEvent(dcId, count = 1) {
      calls.push(`pending:${dcId}:${count}`);
    },
  };
  return {
    actions,
    calls,
    setDetectVerdict: (v: boolean) => {
      detectVerdict = v;
    },
    setRecoverError: (e: Error | null) => {
      recoverError = e;
    },
  };
}

function makeOrchestrator(
  overrides: {
    resolveDc?: (nodeId: string) => string | undefined;
    onReconfigure?: (dcId: string, healthy: boolean) => Promise<void> | void;
    onError?: (error: Error) => void;
  } = {},
) {
  const signals = signalSources();
  const failover = failoverActions();
  const reconfigureCalls: string[] = [];
  const errors: string[] = [];
  const orchestrator = new FederationOrchestrator({
    failureSource: signals.failure,
    recoverySource: signals.recovery,
    failover: failover.actions,
    resolveDc: overrides.resolveDc ?? ((nodeId) => (nodeId === 'node-b' ? 'dc-west' : undefined)),
    onReconfigure:
      overrides.onReconfigure ??
      ((dcId, healthy) => {
        reconfigureCalls.push(`${dcId}:${healthy}`);
      }),
    onError:
      overrides.onError ??
      ((error) => {
        errors.push(error.message);
      }),
  });
  return { orchestrator, signals, failover, reconfigureCalls, errors };
}

// ── Cases ──

describe('FederationOrchestrator', () => {
  it('subscribes both signal sources once and reports started', () => {
    const { orchestrator, signals } = makeOrchestrator();
    orchestrator.start();
    orchestrator.start(); // idempotent

    expect(signals.subscriptions()).toEqual({ expiries: 1, recoveries: 1 });
    expect(orchestrator.getStatus().started).toBe(true);
  });

  it('turns a heartbeat expiry into a detection and records the failed DC', () => {
    const { orchestrator, signals, failover } = makeOrchestrator();
    orchestrator.start();

    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1_000, silenceMs: 3_000 });

    expect(failover.calls).toEqual(['detect:dc-west']);
    expect(orchestrator.getStatus().failedDcs).toEqual(['dc-west']);
  });

  it('forwards every expiry the source emits, leaving silence de-duplication upstream', () => {
    const { orchestrator, signals, failover } = makeOrchestrator();
    orchestrator.start();

    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });
    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 2 });

    expect(failover.calls).toEqual(['detect:dc-west', 'detect:dc-west']);
  });

  it('does not record a healthy verdict as a failed DC', () => {
    const { orchestrator, signals, failover } = makeOrchestrator();
    failover.setDetectVerdict(false);
    orchestrator.start();

    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });

    expect(orchestrator.getStatus().failedDcs).toEqual([]);
  });

  it('a recovery signal resolves the node to its DC, recovers, and reconfigures', async () => {
    const { orchestrator, signals, failover, reconfigureCalls } = makeOrchestrator();
    orchestrator.start();
    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });

    signals.emitRecovery('node-b');
    await Promise.resolve();

    expect(failover.calls).toEqual(['detect:dc-west', 'recover:dc-west']);
    expect(reconfigureCalls).toEqual(['dc-west:true']);
    expect(orchestrator.getStatus().failedDcs).toEqual([]);
    expect(orchestrator.getStatus().recoveries).toBe(1);
  });

  it('a rejected recovery keeps the DC failed, reports the error, and does not reconfigure', async () => {
    const { orchestrator, signals, failover, reconfigureCalls, errors } = makeOrchestrator();
    orchestrator.start();
    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });
    failover.setRecoverError(new Error('storage refused'));

    signals.emitRecovery('node-b');
    await Promise.resolve();

    expect(errors).toEqual(['storage refused']);
    expect(reconfigureCalls).toEqual([]);
    expect(orchestrator.getStatus().failedDcs).toEqual(['dc-west']);
    expect(orchestrator.getStatus().recoveryFailures).toBe(1);
  });

  it('a non-Error rejection is normalised before it reaches onError', async () => {
    const { orchestrator, signals, failover, errors } = makeOrchestrator();
    failover.setRecoverError('a string rejection' as unknown as Error);
    orchestrator.start();

    signals.emitRecovery('node-b');
    await Promise.resolve();

    expect(errors).toEqual(['a string rejection']);
  });

  it('an unresolvable node is counted and never drives a recovery', async () => {
    const { orchestrator, signals, failover, reconfigureCalls } = makeOrchestrator();
    orchestrator.start();

    signals.emitRecovery('unknown-node');
    await Promise.resolve();

    expect(failover.calls).toEqual([]);
    expect(reconfigureCalls).toEqual([]);
    expect(orchestrator.getStatus().ignoredRecoveries).toBe(1);
  });

  it('a reconfiguration failure is reported after the DC has been declared healthy', async () => {
    const { orchestrator, signals, errors } = makeOrchestrator({
      onReconfigure: () => {
        throw new Error('router refused');
      },
    });
    orchestrator.start();
    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });

    signals.emitRecovery('node-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['router refused']);
    expect(orchestrator.getStatus().failedDcs).toEqual([]);
  });

  it('coalesces concurrent recovery signals for one DC into a single recovery', async () => {
    const { orchestrator, signals, failover } = makeOrchestrator({
      onReconfigure: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    orchestrator.start();

    signals.emitRecovery('node-b');
    signals.emitRecovery('node-b');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(failover.calls.filter((c) => c === 'recover:dc-west')).toHaveLength(1);
    expect(orchestrator.getStatus().recoveries).toBe(1);
    expect(orchestrator.getStatus().coalescedRecoveries).toBe(1);
  });

  it('recordPending delegates with an explicit count and defaults to one', () => {
    const { orchestrator, failover } = makeOrchestrator();
    orchestrator.recordPending('dc-west');
    orchestrator.recordPending('dc-west', 5);

    expect(failover.calls).toEqual(['pending:dc-west:1', 'pending:dc-west:5']);
  });

  it('stop unsubscribes and later signals no longer drive actions', async () => {
    const { orchestrator, signals, failover } = makeOrchestrator();
    const { unsubscriptions } = signals;
    orchestrator.start();
    orchestrator.stop();

    signals.emitExpiry({ dcId: 'dc-west', lastSeen: 1, silenceMs: 1 });
    signals.emitRecovery('node-b');
    await Promise.resolve();

    expect(unsubscriptions()).toEqual({ expiries: 1, recoveries: 1 });
    expect(failover.calls).toEqual([]);
    expect(orchestrator.getStatus().started).toBe(false);
  });

  it('drives a real detector and a real failover manager across an expiry and a recovery', async () => {
    const peers: ReplicationTarget[] = [
      { nodeId: 'node-a', dc: 'dc-east', address: 'tls://a', topology: 'cross-dc', maxBackoffSeconds: 60 },
      { nodeId: 'node-b', dc: 'dc-west', address: 'tls://b', topology: 'cross-dc', maxBackoffSeconds: 60 },
    ];
    const topology = new TopologyManager({ nodeId: 'node-a', dc: 'dc-east', peers });
    const detector = new DCSplitBrainDetector({
      nodeId: 'node-a',
      dcId: 'dc-east',
      hlc: new HLC('node-a'),
      heartbeatIntervalMs: 10,
      missedHeartbeatThreshold: 2,
      autoRecover: false,
    });
    const recoveries: number[] = [];
    const failover = new CatastrophicFailoverManager(topology, 30, {
      recover: async (_dcId, pendingEvents) => {
        recoveries.push(pendingEvents);
      },
    });

    // The recovery source is the peer coming back — in production this is
    // FederationManager.onTargetRecovered. A one-slot emitter is enough here.
    let emitRecovery: (nodeId: string) => void = () => undefined;
    const recoverySource: RecoverySignalSource = {
      onTargetRecovered(cb) {
        emitRecovery = cb;
        return () => {
          emitRecovery = () => undefined;
        };
      },
    };

    const orchestrator = new FederationOrchestrator({
      failureSource: detector,
      recoverySource,
      failover,
      resolveDc: (nodeId) => topology.getPeer(nodeId)?.dc,
      onReconfigure: () => undefined,
    });

    detector.start();
    orchestrator.start();

    // A real heartbeat makes the detector track the peer, then silence expires it.
    detector.receiveHeartbeat({
      dcId: 'dc-west',
      nodeId: 'node-b',
      hlc: { wallTime: 1, logical: 0, nodeId: 'node-b' },
      appliedCount: 0,
      timestamp: Date.now() - 100,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(failover.getDCHealth().get('dc-west')?.healthy).toBe(false);

    // Work queued while it was down must be handed back on recovery.
    orchestrator.recordPending('dc-west', 3);
    emitRecovery('node-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(recoveries).toEqual([3]);
    expect(failover.getDCHealth().get('dc-west')?.healthy).toBe(true);

    orchestrator.stop();
    detector.stop();
  });
});

// Keep the status type referenced so a rename is a compile error.
const _statusShape: keyof OrchestrationStatus = 'coalescedRecoveries';
void _statusShape;
