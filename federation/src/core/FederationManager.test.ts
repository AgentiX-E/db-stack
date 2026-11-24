/**
 * FederationManager Tests — Top-level orchestrator.
 *
 * Coverage:
 *   - Start/stop lifecycle
 *   - Replicate through to MultiLeaderReplication
 *   - Health check via HealthMonitor
 *   - Consumer registration
 *   - HLC access
 *   - CDC/AntiEntropy stub access
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FederationManager,
  type IFederationConsumer,
  type ReplicatedEntry,
  type ConflictEntry,
} from './FederationManager';
import type {
  IMultiLeaderReplication,
  ReplicationStatus,
  ReplicationConfig,
} from '../interfaces/replication/IMultiLeaderReplication';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { OutboxEntry } from '../interfaces/outbox/OutboxEntry';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC } from '../hlc/HLC';
import { deriveRetention } from '../storage/retention';

function dummyReplicationConfig(): ReplicationConfig {
  return {
    nodeId: 'node-a',
    dc: 'dc-east',
    curveDir: '/tmp/test',
    targets: [],
  };
}

function mockReplication(): IMultiLeaderReplication {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    replicate: vi.fn().mockResolvedValue({ msgId: 'repl:0:mock-uuid' }),
    getStatus: vi.fn().mockResolvedValue({
      nodeId: 'node-a',
      dc: 'dc-east',
      targets: [],
    }),
    retryFailed: vi.fn().mockResolvedValue(0),
    getPendingCounts: vi.fn().mockResolvedValue({}),
    onTargetConnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetDisconnected: vi.fn().mockReturnValue(vi.fn()),
    onTargetRecovered: vi.fn().mockReturnValue(vi.fn()),
    isPeerReachable: vi.fn(() => true),
    onHighLag: vi.fn().mockReturnValue(vi.fn()),
    getRetention: () => deriveRetention(),
  };
}

function mockTransport(): ITransport {
  return {
    send: vi.fn().mockResolvedValue(true),
    broadcast: vi.fn().mockResolvedValue(1),
    onMessage: vi.fn().mockReturnValue(vi.fn()),
    getConnectedPeers: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      peersConnected: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      uptimeMs: 0,
    }),
  };
}

/** A complete stored entry, as `add()` returns it. */
function storedEntry(): OutboxEntry {
  return {
    id: 'entry:1',
    targetPeerIds: [],
    payload: new Uint8Array(),
    timestamp: new HLC('test-node').now(),
    type: 'test',
    status: 'pending',
    createdAt: Date.now(),
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
  };
}

function mockOutbox(): IOutboxStore {
  return {
    add: vi.fn().mockResolvedValue(storedEntry()),
    fetchOldestPending: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockReturnValue(false),
    getPendingCount: vi.fn().mockResolvedValue(0),
    getPendingStats: vi.fn(() => ({})),
    getDeadLetterEntries: vi.fn(() => []),
    retryDeadLetters: vi.fn(() => 0),
    housekeeping: vi.fn(() => ({ delivered: 0, deadLettered: 0 })),
    getRetention: () => deriveRetention(),
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 0,
      pendingCount: 0,
      deliveredCount: 0,
      oldestPendingTimestamp: null,
    }),
  };
}

describe('FederationManager — Lifecycle', () => {
  it('should start replication and health monitor', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
      hlc: new HLC('test'),
      healthConfig: { highLagThresholdMs: 60_000, checkIntervalMs: 50_000 },
    });

    expect(fm.isStarted()).toBe(false);
    await fm.start();
    expect(fm.isStarted()).toBe(true);

    // Replication should have been started
    expect(repl.start).toHaveBeenCalledTimes(1);

    await fm.stop();
    expect(fm.isStarted()).toBe(false);
    expect(repl.stop).toHaveBeenCalledTimes(1);
  });

  it('should not start twice', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    await fm.start();
    await fm.start(); // second start should be no-op
    expect(repl.start).toHaveBeenCalledTimes(1);
  });
});

describe('FederationManager — Replication', () => {
  it('should replicate through to MultiLeaderReplication', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    await fm.start();
    const result = await fm.replicate(0, 'test-data', 'test');
    expect(result.msgId).toContain('repl:0:');
    expect(repl.replicate).toHaveBeenCalledWith(0, 'test-data', 'test');

    await fm.stop();
  });

  it('should return the replication engine', () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    expect(fm.getReplication()).toBe(repl);
  });
});

describe('FederationManager — Health', () => {
  it('should return health via HealthMonitor', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    const health = await fm.getHealth();
    expect(health.nodeId).toBe('node-a');
    expect(health.dc).toBe('dc-east');
    expect(health.totalTargets).toBe(0);
  });

  it('should support health change callbacks', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    let callCount = 0;
    fm.onHealthChange(() => callCount++);
    await fm.getHealth();
    // check() fires health change callbacks
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe('FederationManager — Consumer Registration', () => {
  it('should register and return consumers', () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    const consumer: IFederationConsumer = {
      proposeReplicated: vi.fn(),
      getHLC: () => new HLC('consumer-node'),
      onConflict: vi.fn(),
    };

    fm.registerConsumer(consumer);

    const consumers = fm.getConsumers();
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toBe(consumer);
  });

  it('should support multiple consumers', () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    const consumer1: IFederationConsumer = {
      proposeReplicated: vi.fn(),
      getHLC: () => new HLC('n1'),
      onConflict: vi.fn(),
    };
    const consumer2: IFederationConsumer = {
      proposeReplicated: vi.fn(),
      getHLC: () => new HLC('n2'),
      onConflict: vi.fn(),
    };

    fm.registerConsumer(consumer1);
    fm.registerConsumer(consumer2);

    expect(fm.getConsumers()).toHaveLength(2);
  });
});

describe('FederationManager — HLC Access', () => {
  it('should return the HLC instance', () => {
    const hlc = new HLC('test-node');
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
      hlc,
    });

    expect(fm.getHLC()).toBe(hlc);
  });

  it('should create a default HLC if not provided', () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-default',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    const hlc = fm.getHLC();
    expect(hlc.nodeId).toBe('node-default');
  });
});

describe('FederationManager — Stubs (Phase 3)', () => {
  it('should return CDC after I18 — no longer stub', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    // CDCManager is lazily initialized on start()
    await fm.start();
    expect(fm.getCDC()).toBeDefined();
    await fm.stop();
  });

  it('should return AntiEntropy after I18 — no longer stub', async () => {
    const repl = mockReplication();
    const fm = new FederationManager(repl, {
      nodeId: 'node-a',
      dc: 'dc-east',
      replicationConfig: dummyReplicationConfig(),
      transport: mockTransport(),
      outbox: mockOutbox(),
    });

    // AntiEntropy is lazily initialized on start()
    await fm.start();
    expect(fm.getAntiEntropy()).toBeDefined();
    await fm.stop();
  });
});
