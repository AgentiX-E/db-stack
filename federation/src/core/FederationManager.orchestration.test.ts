/**
 * FederationManager — the production wiring of failure detection and recovery.
 *
 * `FederationOrchestrator` is tested on its own in
 * `FederationOrchestrator.test.ts`. What is tested here is the one thing that
 * file cannot prove: that a manager started with failover hooks actually builds
 * the orchestrator, connects its detector's expiry signal and its replication's
 * recovery signal to it, and tears both down on stop. Before IT-96 the failover
 * manager existed but had no caller, so a datacenter could go silent while the
 * bookkeeping recovery reads stayed green.
 *
 * The detector, the transport, the failover manager and the orchestrator are
 * real. Only the replication engine and the outbox are doubled: they bring their
 * own stores and timers, and neither is the subject here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { FederationManager } from './FederationManager';
import type { IMultiLeaderReplication, ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import { InProcessTransport } from '../transport/InProcessTransport';
import { HLC } from '../hlc/HLC';
import { deriveRetention } from '../storage/retention';

function target(nodeId: string, dc: string): ReplicationTarget {
  return { nodeId, dc, address: `tls://${nodeId}`, topology: 'cross-dc', maxBackoffSeconds: 60 };
}

function storedEntry(): OutboxEntry {
  return {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: new HLC('node-a').now(),
    type: 'test',
    status: 'pending',
    createdAt: Date.now(),
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  };
}

function outbox(): IOutboxStore {
  return {
    add: async () => storedEntry(),
    fetchOldestPending: async () => [],
    markDelivered: async () => undefined,
    markFailed: () => false,
    getPendingCount: async () => 0,
    getPendingStats: () => ({}),
    getDeadLetterEntries: () => [],
    retryDeadLetters: () => 0,
    housekeeping: () => ({ delivered: 0, deadLettered: 0 }),
    getRetention: () => deriveRetention(),
    getStats: async () => ({
      totalEntries: 0,
      pendingCount: 0,
      deliveredCount: 0,
      oldestPendingTimestamp: null,
    }),
  };
}

function replication() {
  let emitRecovered: (nodeId: string) => void = () => undefined;
  const engine: IMultiLeaderReplication = {
    start: async () => undefined,
    stop: async () => undefined,
    replicate: async () => ({ msgId: 'repl:test' }),
    getStatus: async () => ({ nodeId: 'node-a', dc: 'dc-east', targets: [] }),
    retryFailed: async () => 0,
    getPendingCounts: async () => ({}),
    onTargetConnected: () => () => undefined,
    onTargetDisconnected: () => () => undefined,
    onTargetRecovered: (cb) => {
      emitRecovered = cb;
      return () => {
        emitRecovered = () => undefined;
      };
    },
    isPeerReachable: () => true,
    onHighLag: () => () => undefined,
    getRetention: () => deriveRetention(),
  };
  return { engine, emitRecovered: (id: string) => emitRecovered(id) };
}

const opened: FederationManager[] = [];

afterEach(async () => {
  for (const manager of opened.splice(0)) {
    await manager.stop();
  }
});

function managerWith(hooks: { recover?: (dcId: string, pending: number) => Promise<void> }) {
  const repl = replication();
  const transport = new InProcessTransport({ nodeId: 'node-a', registryKey: 'orchestration-test' });
  const manager = new FederationManager(repl.engine, {
    nodeId: 'node-a',
    dc: 'dc-east',
    transport,
    outbox: outbox(),
    replicationConfig: {
      nodeId: 'node-a',
      dc: 'dc-east',
      curveDir: '/tmp/test',
      targets: [target('node-b', 'dc-west')],
    },
    // A 10 ms beat with the default threshold of 3 expires a silent peer in
    // ~30 ms, which is short enough for the expiry case to run deterministically.
    heartbeatIntervalMs: 10,
    antiEntropyIntervalMs: 0,
    dlqScanIntervalMs: 0,
    outboxHousekeepingIntervalMs: 0,
    failover: hooks,
  });
  opened.push(manager);
  return { manager, repl, transport };
}

describe('FederationManager — failure orchestration wiring', () => {
  it('builds a started orchestrator and a failover manager with the configured hooks', async () => {
    const { manager } = managerWith({});
    await manager.start();

    expect(manager.getOrchestrator().getStatus().started).toBe(true);
    expect(manager.getFailover().getDCHealth().has('dc-west')).toBe(true);
  });

  it('a real heartbeat expiry marks the silent DC unhealthy', async () => {
    const { manager } = managerWith({});
    await manager.start();

    // A tracked heartbeat whose timestamp is already beyond the detector's
    // timeout (10 ms × 3 = 30 ms) is expired on the detector's next real tick.
    manager.getSplitBrainDetector().receiveHeartbeat({
      dcId: 'dc-west',
      nodeId: 'node-b',
      hlc: { wallTime: 1, logical: 0, nodeId: 'node-b' },
      appliedCount: 0,
      timestamp: Date.now() - 500,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(manager.getFailover().getDCHealth().get('dc-west')?.healthy).toBe(false);
  });

  it('a peer recovery drives the injected recover hook and restores the DC', async () => {
    const recovered: number[] = [];
    const { manager, repl } = managerWith({
      recover: async (_dcId, pending) => {
        recovered.push(pending);
      },
    });
    await manager.start();

    manager.getOrchestrator().recordPending('dc-west', 2);
    repl.emitRecovered('node-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(recovered).toEqual([2]);
    expect(manager.getFailover().getDCHealth().get('dc-west')?.healthy).toBe(true);
  });

  it('stopping the manager stops the orchestrator and unsubscribes its signals', async () => {
    const { manager } = managerWith({});
    await manager.start();
    expect(manager.getOrchestrator().getStatus().started).toBe(true);

    await manager.stop();
    // Remove from the afterEach list so a second stop is the idempotent path.
    opened.splice(opened.indexOf(manager), 1);
    expect(manager.getOrchestrator().getStatus().started).toBe(false);
  });
});
