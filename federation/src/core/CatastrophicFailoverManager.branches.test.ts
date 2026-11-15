/**
 * CatastrophicFailoverManager — branch-completion tests.
 *
 * Targets the two decision branches the existing suite leaves implicit:
 *   - constructor `dcTimeoutMs ?? DEFAULT_DC_TIMEOUT_MS` (default timeout)
 *   - recordHeartbeat() `!status.healthy` recovery branch (unhealthy → healthy)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function makeTopology(): TopologyManager {
  return new TopologyManager({
    nodeId: 'node-1',
    dc: 'dc-west',
    peers: [makeTarget({ nodeId: 'node-3', dc: 'dc-east', topology: 'cross-dc' })],
  });
}

describe('CatastrophicFailoverManager — constructor default timeout', () => {
  it('falls back to DEFAULT_DC_TIMEOUT_MS when dcTimeoutMs is omitted', () => {
    const fm = new CatastrophicFailoverManager(makeTopology()); // no timeout → default 30_000
    expect(fm['dcTimeoutMs']).toBe(30_000);
  });
});

describe('CatastrophicFailoverManager — recordHeartbeat recovery branch', () => {
  let fm: CatastrophicFailoverManager;

  beforeEach(() => {
    vi.useFakeTimers();
    const topology = makeTopology();
    fm = new CatastrophicFailoverManager(topology, 1_000); // 1s timeout
  });

  afterEach(() => vi.useRealTimers());

  it('transitions an unhealthy DC back to healthy on heartbeat', () => {
    // Drive the DC to unhealthy via timeout
    vi.advanceTimersByTime(2_000);
    expect(fm.detectDCFailure('dc-west')).toBe(true);

    // Confirm it is unhealthy
    expect(fm.getDCHealth().get('dc-west')!.healthy).toBe(false);

    // Re-detecting an already-failed DC short-circuits to true (L81 branch)
    expect(fm.detectDCFailure('dc-west')).toBe(true);

    // Heartbeat must flip it back to healthy (recordHeartbeat `!status.healthy` branch)
    fm.recordHeartbeat('dc-west');
    expect(fm.getDCHealth().get('dc-west')!.healthy).toBe(true);

    // And a subsequent detection no longer reports failure
    expect(fm.detectDCFailure('dc-west')).toBe(false);
  });
});
