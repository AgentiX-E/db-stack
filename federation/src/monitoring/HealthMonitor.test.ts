/**
 * HealthMonitor Tests — DC-level health and lag tracking.
 *
 * Coverage:
 *   - Target health classification (healthy / warning / critical / unknown)
 *   - Periodic health checks
 *   - High-lag event emission
 *   - Health change event emission
 *   - Stop/start lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitor, type FederationHealth, type HealthMonitorConfig } from './HealthMonitor';
import type { IMultiLeaderReplication, ReplicationStatus } from '../interfaces/replication/IMultiLeaderReplication';
import { deriveRetention } from '../storage/retention';

function mockStatus(overrides: Partial<ReplicationStatus> = {}): ReplicationStatus {
  return {
    nodeId: 'node-a',
    dc: 'dc-east',
    targets: [
      {
        targetNodeId: 'node-b',
        connected: true,
        lagMs: 1000,
        pendingCount: 5,
        lastSuccessAt: Date.now() - 1000,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
      {
        targetNodeId: 'node-c',
        connected: true,
        lagMs: 120_000, // 2 minutes
        pendingCount: 50,
        lastSuccessAt: Date.now() - 120_000,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    ],
    ...overrides,
  };
}

function createMockReplication(status: ReplicationStatus = mockStatus()): IMultiLeaderReplication {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    replicate: vi.fn().mockResolvedValue({ msgId: 'test' }),
    getStatus: vi.fn().mockResolvedValue(status),
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

describe('HealthMonitor — Classification', () => {
  it('should classify targets with low lag as healthy', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 100,
            pendingCount: 0,
            lastSuccessAt: Date.now(),
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );

    const monitor = new HealthMonitor(repl, {
      highLagThresholdMs: 60_000,
      criticalLagThresholdMs: 300_000,
    });
    const health = await monitor.check();
    expect(health.healthyTargets).toBe(1);
    expect(health.targets[0]!.status).toBe('healthy');
  });

  it('should classify targets with moderate lag as warning', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 100_000, // 100s, above 60s threshold
            pendingCount: 10,
            lastSuccessAt: Date.now() - 100_000,
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );

    const monitor = new HealthMonitor(repl, {
      highLagThresholdMs: 60_000,
      criticalLagThresholdMs: 300_000,
    });
    const health = await monitor.check();
    expect(health.warningTargets).toBe(1);
    expect(health.targets[0]!.status).toBe('warning');
  });

  it('should classify targets with high lag as critical', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 600_000, // 10 minutes, above 5 min threshold
            pendingCount: 100,
            lastSuccessAt: Date.now() - 600_000,
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );

    const monitor = new HealthMonitor(repl, {
      highLagThresholdMs: 60_000,
      criticalLagThresholdMs: 300_000,
    });
    const health = await monitor.check();
    expect(health.criticalTargets).toBe(1);
    expect(health.targets[0]!.status).toBe('critical');
  });

  it('should classify disconnected targets as unknown', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: false,
            lagMs: 0,
            pendingCount: 0,
            lastSuccessAt: null,
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );

    const monitor = new HealthMonitor(repl);
    const health = await monitor.check();
    expect(health.targets[0]!.status).toBe('unknown');
  });

  it('should handle zero-lag as healthy', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 0,
            pendingCount: 0,
            lastSuccessAt: Date.now(),
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );

    const monitor = new HealthMonitor(repl);
    const health = await monitor.check();
    expect(health.targets[0]!.status).toBe('healthy');
  });
});

describe('HealthMonitor — Health Check Results', () => {
  it('should aggregate DC info from replication status', async () => {
    const repl = createMockReplication();
    const monitor = new HealthMonitor(repl);
    const health = await monitor.check();

    expect(health.nodeId).toBe('node-a');
    expect(health.dc).toBe('dc-east');
    expect(health.totalTargets).toBe(2);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle missing replication gracefully', async () => {
    const errorRepl = createMockReplication();
    vi.spyOn(errorRepl, 'getStatus').mockRejectedValue(new Error('Not started'));

    const monitor = new HealthMonitor(errorRepl);
    const health = await monitor.check();

    expect(health.nodeId).toBe('unknown');
    expect(health.totalTargets).toBe(0);
  });
});

describe('HealthMonitor — High-Lag Events', () => {
  it('should fire onHighLag for warning targets', async () => {
    const repl = createMockReplication();
    const monitor = new HealthMonitor(repl, {
      highLagThresholdMs: 10_000,
      checkIntervalMs: 50_000,
    });
    monitor.start();

    const highLagTargets: string[] = [];
    monitor.onHighLag((targetNodeId, _lagMs) => {
      highLagTargets.push(targetNodeId);
    });

    await monitor.check();

    // node-c has 120s lag > 10s threshold
    expect(highLagTargets).toContain('node-c');

    monitor.stop();
  });

  it('should not fire onHighLag for healthy targets', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 100,
            pendingCount: 0,
            lastSuccessAt: Date.now(),
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );
    const monitor = new HealthMonitor(repl, { highLagThresholdMs: 60_000 });

    const highLagTargets: string[] = [];
    monitor.onHighLag((targetNodeId, _lagMs) => {
      highLagTargets.push(targetNodeId);
    });

    await monitor.check();
    expect(highLagTargets).toHaveLength(0);
  });

  it('does not fire for an idle channel whose lag figure is only the clock', async () => {
    // The shape a monitor fed by `now - lastSuccessAt` produces: a target that
    // delivered everything it was given and has been quiet since. Nothing is
    // owed, so nothing is lagging — and a consumer that believes otherwise
    // forwards every read away from a healthy replica, permanently.
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 600_000,
            pendingCount: 0,
            lastSuccessAt: Date.now() - 600_000,
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );
    const monitor = new HealthMonitor(repl, { highLagThresholdMs: 60_000 });

    const highLagTargets: string[] = [];
    monitor.onHighLag((targetNodeId) => highLagTargets.push(targetNodeId));

    const health = await monitor.check();

    expect(highLagTargets).toHaveLength(0);
    expect(health.targets[0]!.pendingCount).toBe(0);
  });

  it('fires as soon as the same channel owes one entry', async () => {
    const repl = createMockReplication(
      mockStatus({
        targets: [
          {
            targetNodeId: 'node-b',
            connected: true,
            lagMs: 600_000,
            pendingCount: 1,
            lastSuccessAt: Date.now() - 600_000,
            lastErrorAt: null,
            lastErrorMessage: null,
          },
        ],
      }),
    );
    const monitor = new HealthMonitor(repl, { highLagThresholdMs: 60_000 });

    const highLagTargets: string[] = [];
    monitor.onHighLag((targetNodeId) => highLagTargets.push(targetNodeId));

    await monitor.check();
    expect(highLagTargets).toEqual(['node-b']);
  });
});

describe('HealthMonitor — Health Change Events', () => {
  it('should fire onHealthChange on each check', async () => {
    const repl = createMockReplication();
    const monitor = new HealthMonitor(repl);

    // Collected rather than assigned to a `let`: the callback runs outside the
    // test body, so control-flow analysis would treat a `let` as still null.
    const emitted: FederationHealth[] = [];
    monitor.onHealthChange((health) => {
      emitted.push(health);
    });

    await monitor.check();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.totalTargets).toBe(2);
  });
});

describe('HealthMonitor — Lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should run periodic checks when started', async () => {
    const repl = createMockReplication();
    const getStatusSpy = vi.spyOn(repl, 'getStatus');

    const monitor = new HealthMonitor(repl, {
      checkIntervalMs: 1000,
      highLagThresholdMs: 60_000,
    });

    monitor.start();

    // First check fires immediately
    expect(getStatusSpy).toHaveBeenCalledTimes(1);

    // Advance time past interval
    vi.advanceTimersByTime(5000);

    // Should have fired ~5-6 times (first + 5 more)
    expect(getStatusSpy.mock.calls.length).toBeGreaterThanOrEqual(5);

    monitor.stop();
  });

  it('should stop periodic checks when stopped', () => {
    const repl = createMockReplication();
    const getStatusSpy = vi.spyOn(repl, 'getStatus');

    const monitor = new HealthMonitor(repl, { checkIntervalMs: 1000 });
    monitor.start();

    vi.advanceTimersByTime(2000);
    const callsAfterStart = getStatusSpy.mock.calls.length;

    monitor.stop();

    // Advance more time — should not increase call count
    getStatusSpy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(getStatusSpy).not.toHaveBeenCalled();
  });
});
