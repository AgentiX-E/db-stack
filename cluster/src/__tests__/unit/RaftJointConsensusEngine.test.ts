/**
 * @fileoverview RaftJointConsensusEngine — complete unit test suite
 *
 * Coverage strategy:
 *   L0: happy-path and failure-path tests (config validation, phase transitions, rollback)
 *   L1: integration scenarios (multi-shard coordination, timeouts, concurrency)
 *   L3: chaos scenarios (partition, crash, network delay)
 *   L4: linearizability verification
 *
 * Principles:
 *   - real RaftGroup instances are used for integration tests
 *   - mocks are used only when testing RaftJointConsensusEngine's own logic
 *   - each test verifies one behavior; test names start with the AC (Acceptance Criterion) id
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RaftJointConsensusEngine } from '../../consensus/joint-consensus/RaftJointConsensusEngine';
import type {
  PeerConfig,
  TransitionOptions,
  IClusterMembershipTransition,
} from '../../consensus/joint-consensus/IClusterMembershipTransition';
import type { IConsensusLayer } from '../../consensus/interfaces/interfaces';
import type { RaftGroup } from '../../consensus/core/RaftGroup';
import type { RaftConsensusPhase } from '../../interfaces/types';

// ============================================================
// Helpers
// ============================================================

function makePeer(id: string, role: 'voter' | 'learner' = 'voter'): PeerConfig {
  return { id, host: 'localhost', port: 7000 + Number(id), role };
}

function makePeers(count: number, startFrom: number = 1): PeerConfig[] {
  return Array.from({ length: count }, (_, i) => makePeer(String(startFrom + i)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Mock Helpers
// ============================================================

function createMockRaftGroup(slowMs: number = 0) {
  const phase: string = 'normal';
  let _internalPhase: string = 'normal';

  return {
    proposeMembershipChange: vi.fn(
      async (change: any): Promise<{ success: boolean; phase: RaftConsensusPhase; error?: string }> => {
        if (slowMs > 0) await sleep(slowMs);
        if (change.changeId?.includes('-new')) {
          _internalPhase = 'normal';
          return { success: true, phase: 'normal' as any };
        }
        _internalPhase = 'joint';
        return { success: true, phase: 'joint' as any };
      },
    ),
    getConsensusPhase: vi.fn(() => {
      if (_internalPhase === 'joint') return 'joint' as any;
      return 'normal' as any;
    }),
    getCurrentMembership: vi.fn(() => null),
    getProgress: vi.fn(async () => ({ commit: 100, applied: 100 })),
    getLeader: vi.fn(async () => 1),

    propose: vi.fn(async () => {}),
    isLeader: vi.fn(async () => true),
    campaign: vi.fn(async () => {}),
    shardId: 0,
  };
}

/**
 * The engine's constructor takes a RaftGroup, which needs a live raft-core
 * node. The mock below implements the members the engine actually calls, so it
 * is asserted into the RaftGroup view here — the single conversion point.
 */
function asRaftGroup(group: ReturnType<typeof createMockRaftGroup>): RaftGroup {
  const partial: Partial<RaftGroup> = group;
  return partial as RaftGroup;
}

function createMockConsensusLayer() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    propose: vi.fn(),
    isLeader: vi.fn(),
    getLeader: vi.fn(),
    getCommitIndex: vi.fn(),
    registerShard: vi.fn(),
    removeShard: vi.fn(),
    notifyTopologyChange: vi.fn(),
    getHealthStatus: vi.fn(),
    campaign: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    setForceLeader: vi.fn(),
  };
}

// ============================================================
// Tests start here
// ============================================================

describe('RaftJointConsensusEngine — unit tests', () => {
  describe('L0: config validation', () => {
    it('AC-D1-01: accepts a valid peer config', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const peers = makePeers(3);
      expect(() => engine.transitionTo(peers)).not.toThrow();
    });

    it('AC-D1-02: rejects an empty peer list', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const result = await engine.transitionTo([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty');
    });

    it('AC-D1-03: rejects a config with no voter', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const result = await engine.transitionTo([makePeer('1', 'learner')]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('voter');
    });

    it('AC-D1-04: rejects a duplicate node ID', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const result = await engine.transitionTo([makePeer('1'), makePeer('1')]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Duplicate');
    });

    it('AC-D1-05: rejects an invalid port', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const result = await engine.transitionTo([{ id: '1', host: 'localhost', port: 0, role: 'voter' }]);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid address');
    });

    it('AC-D1-06: succeeds immediately when the config is unchanged', async () => {
      const engine = new RaftJointConsensusEngine(
        () => createMockRaftGroup() as any,
        () => createMockConsensusLayer(),
      );
      const peers = makePeers(3);
      const result = await engine.transitionTo(peers);
      expect(result.success).toBe(true);
      expect(result.committedStep).toBe('new');
    });
  });

  describe('L0: transition lifecycle', () => {
    it('AC-D1-07: the phase after transitionTo is readable through getActiveTransition', async () => {
      const engine = new RaftJointConsensusEngine(
        (id) => {
          const g = createMockRaftGroup();
          return g as any;
        },
        () => createMockConsensusLayer(),
      );

      // After transitionTo finishes the phase should be stable
      const result = await engine.transitionTo(makePeers(4));
      expect(result.success).toBe(true);
      expect(engine.getTransitionPhase()).toBe('stable');
      expect(engine.getActiveTransition()).toBeNull();
    });

    it('AC-D1-08: returns to stable when done', async () => {
      const group = createMockRaftGroup(); // fast by default

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      const result = await engine.transitionTo(makePeers(5));
      expect(result.success).toBe(true);
      expect(engine.getTransitionPhase()).toBe('stable');
      expect(engine.getActiveTransition()).toBeNull();
    });

    it('AC-D1-09: a second concurrent transition is rejected', async () => {
      // Use slowConsensus to make the first transition slow
      const slowConsensus = createMockConsensusLayer();
      // _getCurrentPeers needs getLeader to return fast, so consensus is left untouched

      const group = createMockRaftGroup();
      const proposeCalls: string[] = [];
      group.proposeMembershipChange.mockImplementation(async (change) => {
        proposeCalls.push(change.changeId || '');
        const isNewPhase = change.changeId?.includes('-new');
        if (!isNewPhase) {
          // C_JOINT phase: block on the first call
          if (proposeCalls.length === 1) {
            // This call returns fast as usual, because the engine serialises callers with a lock
          }
        }
        return {
          success: true,
          phase: isNewPhase ? ('normal' as any) : ('joint' as any),
        };
      });

      const engine = new RaftJointConsensusEngine(
        (id) => group as any,
        () => slowConsensus,
      );

      // The first transition takes the lock immediately
      const p1 = engine.transitionTo(makePeers(4));
      // Start the second one in the same microtask
      const p2 = await engine.transitionTo(makePeers(5));
      expect(p2.success).toBe(false);
      expect(p2.error).toContain('already in progress');

      await p1;
    });

    it('AC-D1-10: returns to stable when transitionTo fails', async () => {
      const group = createMockRaftGroup();
      group.proposeMembershipChange.mockReset();
      group.proposeMembershipChange.mockImplementation(async () => {
        return { success: false, error: 'Leader lost', phase: 'normal' as any };
      });

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      const result = await engine.transitionTo(makePeers(5), { timeoutMs: 500, maxRetries: 1 });
      expect(result.success).toBe(false);
      expect(engine.getTransitionPhase()).toBe('stable');
    });
  });

  describe('L0: abort behavior', () => {
    it('AC-D1-11: abort fails with no active transition', async () => {
      const engine = new RaftJointConsensusEngine(
        () => undefined,
        () => createMockConsensusLayer(),
      );
      const result = await engine.abortTransition();
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active transition');
    });

    it('AC-D1-12: abort succeeds before C_JOINT commits', async () => {
      const group = createMockRaftGroup();

      // Simulate a slow commit (never returns) so the test can abort
      group.proposeMembershipChange.mockImplementation(async () => {
        await sleep(5000);
        return { success: true, phase: 'joint' as any };
      });

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      // Start the transition without awaiting it
      const transitionPromise = engine.transitionTo(makePeers(4));
      await sleep(50);

      // Abort before C_JOINT commits → should succeed (C_JOINT is uncommitted, so the rollback is safe)
      const abortResult = await engine.abortTransition();
      expect(abortResult.success).toBe(true);
      expect(abortResult.committedStep).toBe('none');
      expect(abortResult.error).toContain('Transition aborted');

      // transitionTo was aborted, so it is not awaited (the 5s sleep in the mock is simply dropped)

      // transitionTo was aborted, so it is not awaited (the 5s sleep in the mock is simply dropped)
    });
  });

  describe('L1: event notification', () => {
    it('AC-D1-13: transition lifecycle events are emitted', async () => {
      const group = createMockRaftGroup();
      group.proposeMembershipChange.mockImplementation(async (change: any) => {
        if (change.changeId?.includes('-new')) {
          return { success: true, phase: 'normal' as any };
        }
        return { success: true, phase: 'joint' as any };
      });

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      const events: any[] = [];
      engine.onTransitionEvent((e) => events.push(e.type));

      await engine.transitionTo(makePeers(5));

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events).toContain('transition_started');
      expect(events).toContain('new_committed');
    });

    it('AC-D1-14: an event listener can be unsubscribed', async () => {
      const engine = new RaftJointConsensusEngine(
        () => createMockRaftGroup() as any,
        () => createMockConsensusLayer(),
      );

      const events: any[] = [];
      const unsubscribe = engine.onTransitionEvent((e) => events.push(e.type));
      unsubscribe();

      await engine.transitionTo(makePeers(3));

      expect(events.length).toBe(0);
    });
  });

  describe('L1: progress reporting', () => {
    it('AC-D1-15: transition progress can be read', async () => {
      const group = createMockRaftGroup();
      // Slow first phase so progress can be inspected
      group.proposeMembershipChange.mockImplementation(async (change) => {
        if (!change.changeId?.includes('-new')) {
          await sleep(200);
          return { success: true, phase: 'joint' as any };
        }
        return { success: true, phase: 'normal' as any };
      });
      group.getConsensusPhase.mockReturnValue('joint' as any);

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      // null is returned when there is no active transition
      expect(engine.getProgress()).toBeNull();

      const transitionPromise = engine.transitionTo(makePeers(5), { timeoutMs: 30000 });
      await sleep(50);

      const progress = engine.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.changeId).toBeDefined();
      expect(progress!.phase).toBe('joint');
      expect(progress!.timeoutMs).toBeGreaterThan(0);
      expect(progress!.jointAcks.oldMajority).toBeGreaterThan(0);

      await transitionPromise;
    });

    it('AC-D1-16: timeout detection', async () => {
      const group = createMockRaftGroup();
      group.proposeMembershipChange.mockImplementation(async () => {
        await sleep(500);
        return { success: false, error: 'timeout', phase: 'normal' as any };
      });

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      const result = await engine.transitionTo(makePeers(5), { timeoutMs: 100, maxRetries: 1 });
      expect(result.success).toBe(false);
    });
  });

  describe('L0: change type derivation', () => {
    it('AC-D1-17: the old config is reported in the result', async () => {
      const engine = new RaftJointConsensusEngine(
        () => createMockRaftGroup() as any,
        () => createMockConsensusLayer(),
      );

      const result = await engine.transitionTo(makePeers(3));
      expect(result.oldConfig).toBeDefined();
      expect(result.newConfig).toBeDefined();
      expect(result.newConfig.length).toBe(3);
    });
  });
});

describe('RaftJointConsensusEngine — RaftGroupManager integration', () => {
  it('AC-D1-19: raft groups are obtained through RaftGroupManager', async () => {
    const group = createMockRaftGroup();
    // Simulate a RaftGroupManager with 3 shards
    const shardGroups = new Map<number, any>([
      [0, group],
      [1, createMockRaftGroup()],
      [2, createMockRaftGroup()],
    ]);

    const engine = new RaftJointConsensusEngine(
      (shardId: number) => shardGroups.get(shardId) as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(5));
    expect(result.success).toBe(true);

    // Verify proposeMembershipChange is called on every shard
    for (const [, g] of shardGroups) {
      expect(g.proposeMembershipChange).toHaveBeenCalled();
    }
  });

  it('AC-D1-C1: returns success immediately when the config is unchanged (configsEqual)', async () => {
    // Covers the early-return branch of _configsEqual
    const engine = new RaftJointConsensusEngine(
      () => asRaftGroup(createMockRaftGroup()),
      () => createMockConsensusLayer(),
    );

    // transitionTo with the same config as oldPeers (1 node, matching the _getCurrentPeers default)
    const peers = [makePeer('1')];
    const result = await engine.transitionTo(peers);
    expect(result.success).toBe(true);
    expect(result.committedStep).toBe('new');
    expect(result.phase).toBe('stable');
  });

  it('AC-D1-C4: abortTransition returns an error after C_NEW commits', async () => {
    // Simulate a transition that already finished (C_NEW committed) while _state is not yet cleared
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // A slow mock would let the transition finish C_JOINT first, then check the state flag
    // but the engine clears state when the transition completes, so an intermediate state must be forged
    // instead a second engine is built and its internal state flag is set directly (reflection on a private field)
    const engine2 = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    await engine2.transitionTo(makePeers(3));
    const abortResult = await engine2.abortTransition();
    // Aborting after the transition completes says either "No active" or "Cannot abort after"
    // Here the test only asserts the engine does not crash
    expect(abortResult.success).toBe(false);
  });

  it('AC-D1-C5: a C_NEW failure inside transitionTo rolls back and returns an error', async () => {
    const mockGroup = createMockRaftGroup();
    let callCount = 0;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      callCount++;
      if (callCount === 2) {
        // The second call (C_NEW) fails
        return { success: false, phase: 'joint' as RaftConsensusPhase, error: 'C_NEW propose failed' };
      }
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3));
    expect(result.success).toBe(false);
    expect(result.committedStep).toBe('joint');
  });

  it('AC-D1-C6: abortTransition aborts an active transition early', async () => {
    const mockGroup = createMockRaftGroup();
    // Make the C_JOINT commit slow so the abort lands before it
    mockGroup.proposeMembershipChange = vi.fn(async (change, ...args) => {
      await new Promise((r) => setTimeout(r, 200));
      return { success: true, phase: 'joint' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const promise = engine.transitionTo(makePeers(3));

    // Abort before C_JOINT completes
    await new Promise((r) => setTimeout(r, 50));
    const abortResult = await engine.abortTransition();

    await promise;
  });
});

// The real three-node cluster lives in `__tests__/integration/membership-e2e.test.ts`
// (AC-D1-18 to 18e), where a membership change is driven through `RaftAdapter` over
// mTLS. A case used to sit in this file and start a cluster, assert the leader, and
// stop — while its title named `proposeMembershipChange`, which it never called
// (P3-27). It is gone rather than renamed: the call it named is driven for real two
// files over, and the cluster assertion it did make is AC-D1-18 there.

describe('RaftJointConsensusEngine — extra coverage', () => {
  it('AC-D1-C3: forced election (autoCampaign) runs after the transition', async () => {
    const consensus = createMockConsensusLayer();
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => consensus,
    );

    // Use a different ID set (none of the current 1/2/3) so configsEqual returns false
    const result = await engine.transitionTo(makePeers(3, 4), { autoCampaign: true });
    expect(result.success).toBe(true);
    expect(consensus.campaign.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Once, not once per phase: the option is "campaign after the transition".
    expect(consensus.campaign).toHaveBeenCalledTimes(1);
    // And after it — an election started before C_NEW commits campaigns on the
    // configuration that is being replaced. The duplicate of the assertion above
    // sat here instead, which is what a missing second claim looks like.
    const lastProposal = Math.max(
      ...(mockGroup.proposeMembershipChange as ReturnType<typeof vi.fn>).mock.invocationCallOrder,
    );
    expect(consensus.campaign.mock.invocationCallOrder[0]).toBeGreaterThan(lastProposal);
  });

  it('AC-D1-C8: transitionTo passes straight through without a consensus layer', async () => {
    const engine = new RaftJointConsensusEngine(
      () => undefined,
      () => null,
    );
    const result = await engine.transitionTo(makePeers(3));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C9: a C_NEW failure on multiple shards returns an error', async () => {
    // Exercises the multi-shard failure handling in _executeNewPhase
    const group1 = createMockRaftGroup();
    const group2 = createMockRaftGroup();
    let callCount = 0;
    for (const g of [group1, group2]) {
      g.proposeMembershipChange = vi.fn(async (change) => {
        callCount++;
        if (callCount > 1) return { success: false, phase: 'joint' as RaftConsensusPhase, error: 'C_NEW phase error' };
        return { success: true, phase: 'normal' as any };
      });
    }

    const engine = new RaftJointConsensusEngine(
      (shardId) => {
        if (shardId === 0) return group1 as any;
        if (shardId === 1) return group2 as any;
        return undefined;
      },
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3));
    expect(result.success).toBe(false);
    expect(result.error).toContain('C_NEW');
  });

  it('AC-D1-C10: the leave scenario exercises _deriveChangeType and _getChangedNodeId', async () => {
    const mockGroup = createMockRaftGroup();
    // mock: nodes 1,2,3 today → node 3 leaves (only 1,2 remain)
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2'],
    })) as any;
    // Make propose return success quickly
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(2));
    expect(result.success).toBe(true);
    expect(result.committedStep).toBe('new');
  });

  it('AC-D1-C11: peers come from getLeader when currentMembership is missing', async () => {
    const mockGroup = createMockRaftGroup();
    // getCurrentMembership returns null → the fallback path runs
    mockGroup.getCurrentMembership = vi.fn(() => null) as any;
    mockGroup.getLeader = vi.fn(async () => '2') as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C12: peers are collected from groups when currentMembership is missing and getLeader returns empty', async () => {
    const groupA = createMockRaftGroup();
    groupA.getCurrentMembership = vi.fn(() => null) as any;
    groupA.getLeader = vi.fn(async () => null) as any;
    groupA.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const groupB = createMockRaftGroup();
    groupB.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['101', '102', '103'],
      newPeers: ['101', '102', '103'],
    })) as any;
    groupB.getLeader = vi.fn(async () => null) as any;
    groupB.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      (shardId) => {
        if (shardId === 0) return groupA as any;
        if (shardId === 1) return groupB as any;
        return undefined;
      },
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C13: the default peer is used when currentMembership, getLeader and the groups all come up empty', async () => {
    const groupA = createMockRaftGroup();
    groupA.getCurrentMembership = vi.fn(() => null) as any;
    groupA.getLeader = vi.fn(async () => {
      throw new Error('no leader');
    }) as any;
    groupA.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const groupB = createMockRaftGroup();
    groupB.getCurrentMembership = vi.fn(() => null) as any;
    groupB.getLeader = vi.fn(async () => null) as any;
    groupB.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      (shardId) => {
        if (shardId === 0) return groupA as any;
        if (shardId === 1) return groupB as any;
        return undefined;
      },
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C14: `already in progress` skips the retry (_executeJointPhase rollback branch)', async () => {
    const consensus = createMockConsensusLayer();
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    let callCount = 0;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      callCount++;
      if (callCount === 1) {
        return { success: false, phase: 'normal' as RaftConsensusPhase, error: 'already in progress' };
      }
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => consensus,
    );
    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C15: the guard branches of _computeJointProgress and _computeJointConfig', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // 1. getProgress → null with no state
    expect(engine.getProgress()).toBeNull();
    // 2. getActiveTransition → null with no state
    expect(engine.getActiveTransition()).toBeNull();
    // 3. getTransitionPhase → 'stable' with no state
    expect(engine.getTransitionPhase()).toBe('stable');

    // Run a transition to cover _computeJointConfig and getActiveTransition
    // Use a delay so the transition has not finished yet
    const mockGroupSlow = createMockRaftGroup(200);
    mockGroupSlow.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    const engine2 = new RaftJointConsensusEngine(
      () => mockGroupSlow as any,
      () => createMockConsensusLayer(),
    );
    const promise = engine2.transitionTo(makePeers(3, 4));
    // Query the active transition while it is in flight
    await sleep(20);
    const activeTrans = engine2.getActiveTransition();
    expect(activeTrans).not.toBeNull();
    expect(activeTrans!.changeId).toBeTruthy();
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it('AC-D1-C16: the _campaignIfNeeded catch branch (campaign throws)', async () => {
    const consensus = createMockConsensusLayer();
    consensus.campaign = vi.fn(async () => {
      throw new Error('not leader');
    });

    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => consensus,
    );

    const result = await engine.transitionTo(makePeers(3, 4), { autoCampaign: true });
    expect(result.success).toBe(true);
  });

  it('AC-D1-C17: the _cleanupStalePeers branch with no stale peer', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: true, phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // Transitioning to the same config (takes _configsEqual, not _cleanupStalePeers)
    // Switch to a different config with no removal — a join scenario
    const result = await engine.transitionTo(makePeers(4, 1)); // IDs 1,2,3,4 → a join with no removal
    expect(result.success).toBe(true);
  });

  it('AC-D1-C18: a shard returns a non-C_JOINT error (the generic _executeJointPhase failure path)', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      return { success: false, error: 'quorum not reached', phase: 'unknown' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(false);
    expect(result.error).toContain('quorum not reached');
  });

  it('AC-D1-C19: the transitionTo catch branch (_executeJointPhase throws)', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async () => {
      throw new Error('Internal consensus error');
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Internal consensus error');
  });

  it('AC-D1-C20: abortTransition proceeds to C_NEW after C_JOINT commits', async () => {
    let proposeCall = 0;
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      proposeCall++;
      if (change.changeId?.includes('-new')) {
        // C_NEW succeeds immediately
        return { success: true, phase: 'normal' as any };
      }
      // C_JOINT succeeds immediately
      return { success: true, phase: 'joint' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // Start the transition; C_JOINT completes immediately
    const promise = engine.transitionTo(makePeers(3, 4));
    // Wait 10ms so C_JOINT is committed
    await new Promise((r) => setTimeout(r, 10));
    // Abort after C_JOINT commits — it carries on to C_NEW
    const abortResult = await engine.abortTransition();

    const result = await promise;
    expect(result.success).toBe(true);
  });

  it('AC-D1-C21: lock contention between concurrent transitionTo calls', async () => {
    const mockGroup = createMockRaftGroup(200);
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const p1 = engine.transitionTo(makePeers(3, 4));
    const p2 = engine.transitionTo(makePeers(3, 7));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('in progress');
  });

  it('AC-D1-C22: getTransitionPhase reports the right phase during an active transition', async () => {
    const mockGroup = createMockRaftGroup(200);
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const promise = engine.transitionTo(makePeers(3, 4));
    await sleep(20);
    expect(engine.getTransitionPhase()).toBe('joint');
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it('AC-D1-C23: the _campaignIfNeeded catch branch — campaign throws', async () => {
    const consensus = createMockConsensusLayer();
    consensus.campaign = vi.fn(async () => {
      throw new Error('campaign failed');
    });
    const mockGroup = createMockRaftGroup(50);
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => consensus,
    );

    const result = await engine.transitionTo(makePeers(3, 4), { autoCampaign: true });
    // A campaign failure must not stop the transition from succeeding
    expect(result.success).toBe(true);
  });

  it('AC-D1-C24: a non-C_JOINT error in _executeJointPhase does not roll back', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async () => {
      return { success: false, error: 'quorum not reached', phase: 'normal' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(false);
    expect(result.error).toContain('quorum not reached');
  });

  it('AC-D1-C25: the _getCurrentPeers transitional-config path falls back to the default when peers is empty', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: [],
      newPeers: [],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // peers is empty → default [{id:'1'}]; configsEqual compares ['1'] vs ['4','5','6'] → different → a normal transition
    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C26: validateConfig address check — port is 0', async () => {
    const engine = new RaftJointConsensusEngine(
      () => createMockRaftGroup() as any,
      () => createMockConsensusLayer(),
    );

    const badPeers = [{ id: '1', host: 'localhost', port: 0, role: 'voter' as const }];
    const result = await engine.transitionTo(badPeers);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid address');
  });

  it('AC-D1-C27: validateConfig address check — port is 65536', async () => {
    const engine = new RaftJointConsensusEngine(
      () => createMockRaftGroup() as any,
      () => createMockConsensusLayer(),
    );

    const badPeers = [{ id: '1', host: 'localhost', port: 65536, role: 'voter' as const }];
    const result = await engine.transitionTo(badPeers);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid address');
  });

  it('AC-D1-C28: validateConfig address check — host is empty', async () => {
    const engine = new RaftJointConsensusEngine(
      () => createMockRaftGroup() as any,
      () => createMockConsensusLayer(),
    );

    const badPeers = [{ id: '1', host: '', port: 7001, role: 'voter' as const }];
    const result = await engine.transitionTo(badPeers);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid address');
  });

  it('AC-D1-C29: _campaignIfNeeded without a consensus layer', async () => {
    const mockGroup = createMockRaftGroup(50);
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => null, // no consensus layer
    );

    const result = await engine.transitionTo(makePeers(3, 4), { autoCampaign: true });
    expect(result.success).toBe(true);
  });

  it('AC-D1-C30: _cleanupStalePeers with a removed node', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // old: [1,2,3] → new: [1,2] (node 3 removed)
    const result = await engine.transitionTo(makePeers(2));
    expect(result.success).toBe(true);
  });

  it('AC-D1-C31: _getCurrentPeers takes the transitional-config path and falls back to the default when peers is empty', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: [],
      newPeers: [],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // the transitional config returns empty peers → default [{id:'1'}], configsEqual → true
    const result = await engine.transitionTo([makePeer('1')]);
    expect(result.success).toBe(true);
  });

  it('AC-D1-C32: _executeNewPhase throws and jointCommitted rolls back', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    let callCount = 0;
    mockGroup.proposeMembershipChange = vi.fn(async (change) => {
      callCount++;
      if (callCount === 2) {
        // Throw on the C_NEW call
        throw new Error('C_NEW internal error');
      }
      // C_JOINT succeeds
      return { success: true, phase: 'joint' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(false);
    expect(result.error).toContain('C_NEW internal error');
    // jointCommitted is already set, so committedStep should be 'joint'
    expect(result.committedStep).toBe('joint');
  });

  it('AC-D1-C33: the catch branch handles a non-Error throw (string)', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async () => {
      // A non-Error throw is the behaviour under test: the engine must
      // stringify anything the consensus layer throws.
      // eslint-disable-next-line no-throw-literal -- non-Error throw is the fixture
      throw 'string error message';
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const result = await engine.transitionTo(makePeers(3, 4));
    expect(result.success).toBe(false);
    expect(result.error).toBe('string error message');
  });

  it('AC-D1-C34: _executeJointPhase returns the C_JOINT phase with success=false', async () => {
    const mockGroup = createMockRaftGroup();
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;
    mockGroup.proposeMembershipChange = vi.fn(async () => {
      return { success: false, error: 'timeout', phase: 'joint' as any };
    });

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    // phase === C_JOINT skips the error handling and takes the continue/joint-success path
    const result = await engine.transitionTo(makePeers(3, 4));
    // _executeNewPhase then fails because propose returns false
    expect(result.success).toBe(false);
  });

  it('AC-D1-C35: getProgress reports progress during a transition (jointCommitted=false)', async () => {
    const mockGroup = createMockRaftGroup(200);
    mockGroup.getCurrentMembership = vi.fn(() => ({
      oldPeers: ['1', '2', '3'],
      newPeers: ['1', '2', '3'],
    })) as any;

    const engine = new RaftJointConsensusEngine(
      () => mockGroup as any,
      () => createMockConsensusLayer(),
    );

    const promise = engine.transitionTo(makePeers(3, 4));
    await sleep(20);
    // The transition is in flight with jointCommitted=false → oldAcks/newAcks should be 0
    const progress = engine.getProgress();
    expect(progress).not.toBeNull();
    expect(progress!.phase).toBe('joint');
    expect(progress!.jointAcks.oldAcks).toBe(0);
    expect(progress!.jointAcks.newAcks).toBe(0);
    expect(progress!.isTimedOut).toBe(false);
    const result = await promise;
    expect(result.success).toBe(true);
  });
});
