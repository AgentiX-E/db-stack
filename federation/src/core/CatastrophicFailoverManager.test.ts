/**
 * CatastrophicFailoverManager Tests — DC-level failure detection and recovery.
 *
 * Coverage:
 *   - DC timeout detection (elapsed >= threshold) → unhealthy
 *   - getDCHealth returns correct status for all DCs
 *   - recovery clears pending events and marks healthy
 *   - detectDCFailure returns false for unknown DCs
 *   - recordHeartbeat resets lastSeen
 *   - detectDCFailure updates health status internally
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CatastrophicFailoverManager } from './CatastrophicFailoverManager';
import { TopologyManager } from '../topology/TopologyManager';
import type { ReplicationTarget } from '../interfaces/replication/IMultiLeaderReplication';

function makeTarget(overrides: Partial<ReplicationTarget> & { nodeId: string }): ReplicationTarget {
  return {
    dc: overrides.dc ?? 'dc-west',
    address: overrides.address ?? '127.0.0.1:7001',
    topology: overrides.topology ?? 'cross-dc',
    maxBackoffSeconds: overrides.maxBackoffSeconds ?? 60,
    ...overrides,
  };
}

describe('CatastrophicFailoverManager', () => {
  let failover: CatastrophicFailoverManager;
  let topology: TopologyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    topology = new TopologyManager({
      nodeId: 'node-1',
      dc: 'dc-west',
      peers: [
        makeTarget({ nodeId: 'node-2', dc: 'dc-west', topology: 'intra-dc' }),
        makeTarget({ nodeId: 'node-3', dc: 'dc-east', topology: 'cross-dc' }),
        makeTarget({ nodeId: 'node-4', dc: 'dc-east', topology: 'cross-dc' }),
      ],
    });
    failover = new CatastrophicFailoverManager(topology, 10_000); // 10s timeout
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('detectDCFailure', () => {
    it('should return false when DC is healthy and recently seen', () => {
      const failed = failover.detectDCFailure('dc-west');
      expect(failed).toBe(false);
    });

    it('should return true when DC exceeds timeout threshold', () => {
      // Advance time past the 10s timeout
      vi.advanceTimersByTime(15_000);

      const failed = failover.detectDCFailure('dc-west');
      expect(failed).toBe(true);
    });

    it('should return false for unknown DCs', () => {
      const failed = failover.detectDCFailure('unknown-dc');
      expect(failed).toBe(false);
    });
  });

  describe('getDCHealth', () => {
    it('should return health status for all tracked DCs', () => {
      const health = failover.getDCHealth();
      expect(health.has('dc-west')).toBe(true);
      expect(health.has('dc-east')).toBe(true);
    });

    it('should reflect unhealthy status after timeout', () => {
      vi.advanceTimersByTime(15_000);
      failover.detectDCFailure('dc-west');

      const health = failover.getDCHealth();
      const west = health.get('dc-west');
      expect(west).toBeDefined();
      expect(west!.healthy).toBe(false);
    });
  });

  describe('recoverDC', () => {
    it('should mark DC as healthy and clear pending events', async () => {
      vi.useRealTimers();
      // Re-create failover with real timers to avoid setTimeout issues
      const realTopology = new TopologyManager({
        nodeId: 'node-1',
        dc: 'dc-west',
        peers: [
          makeTarget({ nodeId: 'node-2', dc: 'dc-west', topology: 'intra-dc' }),
          makeTarget({ nodeId: 'node-3', dc: 'dc-east', topology: 'cross-dc' }),
        ],
      });
      const realFailover = new CatastrophicFailoverManager(realTopology, 1); // 1ms timeout
      await new Promise((r) => setTimeout(r, 5));
      realFailover.detectDCFailure('dc-west');

      await realFailover.recoverDC('dc-west');

      const health = realFailover.getDCHealth();
      const west = health.get('dc-west');
      expect(west).toBeDefined();
      expect(west!.healthy).toBe(true);
      expect(west!.pendingEvents).toBe(0);
      vi.useFakeTimers();
    });

    it('should throw for unknown DCs', async () => {
      await expect(failover.recoverDC('unknown-dc')).rejects.toThrow('not found');
    });
  });

  describe('recordHeartbeat', () => {
    it('should reset lastSeen and mark DC healthy', () => {
      vi.advanceTimersByTime(15_000);
      failover.detectDCFailure('dc-west');

      // Now record heartbeat
      failover.recordHeartbeat('dc-west');

      // DC should be healthy again
      const failed = failover.detectDCFailure('dc-west');
      expect(failed).toBe(false);
    });

    it('should create health entry for unknown DC', () => {
      failover.recordHeartbeat('new-dc');
      const health = failover.getDCHealth();
      expect(health.has('new-dc')).toBe(true);
      expect(health.get('new-dc')!.healthy).toBe(true);
    });
  });
});
