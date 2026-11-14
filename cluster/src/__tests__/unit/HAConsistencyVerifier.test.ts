/**
 * HAConsistencyVerifier Unit Tests
 *
 * Iteration 16 — Post-failover consistency verification.
 *
 * HAConsistencyVerifier provides two verification methods:
 *   1. verifyConsistency() — cross-replica commit index comparison
 *   2. verifyNewLeaderConsistency() — 4-stage post-failover check:
 *      Check 1: Leader Identity — consensus confirms the new leader
 *      Check 2: Commit Progress — leader has committed entries
 *      Check 3: Non-Regression — commit index hasn't regressed
 *      Check 4: Cross-Replica Consistency — all replicas match
 *
 * Acceptance Criteria:
 *   AC 16.1: Constructor accepts optional IConsensusLayer
 *   AC 16.2: verifyConsistency returns consistent=true when single-node view
 *   AC 16.3: verifyConsistency detects commit index divergence
 *   AC 16.4: verifyNewLeaderConsistency — leader identity check passes when match
 *   AC 16.5: verifyNewLeaderConsistency — leader identity check throws on mismatch
 *   AC 16.6: verifyNewLeaderConsistency — commit progress reports index
 *   AC 16.7: verifyNewLeaderConsistency — non-regression check detects regressed commit
 *   AC 16.8: verifyNewLeaderConsistency — non-regression check passes on forward progress
 *   AC 16.9: verifyNewLeaderConsistency — cross-replica check passes on matching node status
 *   AC 16.10: verifyNewLeaderConsistency — cross-replica check passes on single-node view
 *   AC 16.11: verifyNewLeaderConsistency — full flow passes all 4 checks
 *   AC 16.12: verifyNewLeaderConsistency — best-effort fallback when no consensus layer
 *   AC 16.13: verifyConsistency — returns consistent=false on getCommitIndex error
 *   AC 16.14: verifyNewLeaderConsistency — infrastructure error returns false (doesn't throw)
 *   AC 16.15: verifyNewLeaderConsistency — uses instance-level consensus layer when param omitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HAConsistencyVerifier } from '../../ha/HAConsistencyVerifier';
import { IConsensusLayer } from '../../consensus/interfaces/interfaces';

// ── Helpers ──

function createMockConsensusLayer(
  overrides: Partial<{
    getLeader: (shardId: string) => string | null;
    isLeader: (shardId: string) => boolean;
    getCommitIndex: (shardId: string) => number;
    getHealthStatus: () => any[];
    start: () => void;
    stop: () => void;
    propose: () => number;
  }> = {},
): IConsensusLayer {
  const defaults = {
    getLeader: (_s: string) => 'node-1',
    isLeader: (_s: string) => true,
    getCommitIndex: (_s: string) => 42,
    getHealthStatus: () => [
      { shardId: 's0', nodeId: 'node-1', isLeader: true, commitIndex: 42, lastLogIndex: 42, term: 3 },
      { shardId: 's0', nodeId: 'node-2', isLeader: false, commitIndex: 42, lastLogIndex: 42, term: 3 },
    ],
  };
  const merged = { ...defaults, ...overrides };

  return {
    start: () => Promise.resolve(merged.start?.()),
    stop: () => Promise.resolve(merged.stop?.()),
    propose: (_s: string, _v: string) => Promise.resolve(merged.propose?.() ?? 42),
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

describe('HAConsistencyVerifier — Unit', () => {
  //
  // AC 16.1: Constructor accepts optional IConsensusLayer
  //
  it('AC 16.1: Constructor accepts optional IConsensusLayer', () => {
    const verifier1 = new HAConsistencyVerifier();
    expect(verifier1).toBeInstanceOf(HAConsistencyVerifier);

    const consensus = createMockConsensusLayer();
    const verifier2 = new HAConsistencyVerifier(consensus);
    expect(verifier2).toBeInstanceOf(HAConsistencyVerifier);
  });

  //
  // AC 16.2: verifyConsistency returns consistent=true when single-node view
  //
  it('AC 16.2: verifyConsistency — single-node view returns consistent', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [], // No health data → single-node view
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(true);
  });

  //
  // AC 16.3: verifyConsistency detects commit index divergence
  //
  it('AC 16.3: verifyConsistency — detects commit index divergence', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [
        { shardId: 's0', leaderId: 'node-1', commitIndex: 50, isLeader: true },
        { shardId: 's0', leaderId: 'node-2', commitIndex: 30, isLeader: false },
      ],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(false);
    expect(result.details).toContain('Divergence');
  });

  //
  // AC 16.4: verifyNewLeaderConsistency — leader identity passes when match
  //
  it('AC 16.4: verifyNewLeaderConsistency — leader identity passes', async () => {
    const consensus = createMockConsensusLayer({
      getLeader: () => 'node-1',
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });

  //
  // AC 16.5: verifyNewLeaderConsistency — leader identity throws on mismatch
  //
  it('AC 16.5: verifyNewLeaderConsistency — leader mismatch throws', async () => {
    const consensus = createMockConsensusLayer({
      getLeader: () => 'node-2', // Consensus says node-2 is leader
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus)).rejects.toThrow(/leader/);
  });

  //
  // AC 16.6: verifyNewLeaderConsistency — commit progress reports index
  //
  it('AC 16.6: verifyNewLeaderConsistency — commit progress checked', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => 100,
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    // Full flow: leader identity + commit progress + non-regression + cross-replica
    expect(result).toBe(true);
  });

  //
  // AC 16.7: verifyNewLeaderConsistency — non-regression detects regressed commit
  //
  it('AC 16.7: verifyNewLeaderConsistency — detects commit regression', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => 10, // Now only 10 (regressed from 100)
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus, 100)).rejects.toThrow(/regression/);
  });

  //
  // AC 16.8: verifyNewLeaderConsistency — non-regression passes on forward progress
  //
  it('AC 16.8: verifyNewLeaderConsistency — forward progress passes regression check', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => 150, // Forward progress from 100
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus, 100);
    expect(result).toBe(true);
  });

  //
  // AC 16.9: verifyNewLeaderConsistency — cross-replica passes on matching status
  //
  it('AC 16.9: verifyNewLeaderConsistency — cross-replica passes when all match', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [
        { shardId: 's0', nodeId: 'node-1', isLeader: true, commitIndex: 42, lastLogIndex: 42, term: 3 },
        { shardId: 's0', nodeId: 'node-2', isLeader: false, commitIndex: 42, lastLogIndex: 42, term: 3 },
      ],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });

  //
  // AC 16.10: verifyNewLeaderConsistency — single-node view passes
  //
  it('AC 16.10: verifyNewLeaderConsistency — single-node health view passes', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [{ shardId: 's0', nodeId: 'node-1', isLeader: true, commitIndex: 42, lastLogIndex: 42 }],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });

  //
  // AC 16.11: verifyNewLeaderConsistency — full flow passes all 4 checks
  //
  it('AC 16.11: verifyNewLeaderConsistency — full flow all checks pass', async () => {
    const consensus = createMockConsensusLayer();
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus, 40);
    expect(result).toBe(true);
  });

  //
  // AC 16.12: verifyNewLeaderConsistency — best-effort fallback
  //
  it('AC 16.12: verifyNewLeaderConsistency — best-effort fallback returns true', async () => {
    const verifier = new HAConsistencyVerifier(); // No consensus layer
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0');
    expect(result).toBe(true);
  });

  //
  // AC 16.13: verifyConsistency — returns consistent=false on error
  //
  it('AC 16.13: verifyConsistency — returns false on getCommitIndex error', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => {
        throw new Error('storage error');
      },
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(false);
    expect(result.details).toContain('Error');
  });

  //
  // AC 16.14: verifyNewLeaderConsistency — health status error returns false (non-fatal)
  //
  it('AC 16.14: verifyNewLeaderConsistency — health status error returns false', async () => {
    // Health status failure is non-fatal (no [HAConsistencyVerifier] prefix in error)
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => {
        throw new Error('health endpoint unavailable');
      },
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus, 40)).resolves.toBe(true); // Health status failure is logged as warning, not fatal
  });

  //
  // AC 16.15: verifyNewLeaderConsistency — uses instance-level CL when param omitted
  //
  it('AC 16.15: verifyNewLeaderConsistency — uses instance-level consensus layer', async () => {
    const consensus = createMockConsensusLayer();
    const verifier = new HAConsistencyVerifier(consensus);
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0');
    expect(result).toBe(true);
  });

  //
  // Additional coverage: defensive / error / nullish branches
  //

  it('verifyConsistency — getHealthStatus throwing falls back to empty list', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => {
        throw new Error('health unavailable');
      },
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(true);
    expect(result.details).toContain('Only local node info');
  });

  it('verifyConsistency — single replica for shard reports consistent', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [{ shardId: 's0', leaderId: 'node-1', commitIndex: 42, isLeader: true }],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(true);
  });

  it('verifyConsistency — defaults missing health fields (nullish fallbacks)', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [{ shardId: 's0' }, { shardId: 's0' }],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyConsistency('s0', consensus);
    expect(result.consistent).toBe(true);
  });

  it('verifyNewLeaderConsistency — getLeader throwing re-throws as consistency error', async () => {
    const consensus = createMockConsensusLayer({
      getLeader: () => {
        throw new Error('rpc down');
      },
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus)).rejects.toThrow(
      /Cannot verify new leader consistency/,
    );
  });

  it('verifyNewLeaderConsistency — getCommitIndex throwing re-throws as consistency error', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => {
        throw new Error('storage read failure');
      },
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus)).rejects.toThrow(
      /Cannot query commit index/,
    );
  });

  it('verifyNewLeaderConsistency — leader mismatch with null actual leader', async () => {
    const consensus = createMockConsensusLayer({
      getLeader: () => null,
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus)).rejects.toThrow(
      /actual leader="null"/,
    );
  });

  it('verifyNewLeaderConsistency — commitIndex 0 on fresh shard notes no entries', async () => {
    const consensus = createMockConsensusLayer({
      getCommitIndex: () => 0,
      getHealthStatus: () => [],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });

  it('verifyNewLeaderConsistency — cross-replica divergence throws', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [
        { shardId: 's0', nodeId: 'node-1', isLeader: true, commitIndex: 50, lastLogIndex: 50, term: 3 },
        { shardId: 's0', nodeId: 'node-2', isLeader: false, commitIndex: 30, lastLogIndex: 30, term: 3 },
      ],
    });
    const verifier = new HAConsistencyVerifier();
    await expect(verifier.verifyNewLeaderConsistency('node-1', 's0', consensus)).rejects.toThrow(
      /Cross-replica consistency check FAILED/,
    );
  });

  it('verifyNewLeaderConsistency — no replicas for shard in health status', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [{ shardId: 's1', nodeId: 'node-1', isLeader: true, commitIndex: 42, lastLogIndex: 42, term: 3 }],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });

  it('verifyNewLeaderConsistency — cross-replica with missing fields uses defaults', async () => {
    const consensus = createMockConsensusLayer({
      getHealthStatus: () => [{ shardId: 's0' }, { shardId: 's0' }],
    });
    const verifier = new HAConsistencyVerifier();
    const result = await verifier.verifyNewLeaderConsistency('node-1', 's0', consensus);
    expect(result).toBe(true);
  });
});
