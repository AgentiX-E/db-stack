/**
 * RaftJointConsensusEngine — branch completion tests.
 *
 * RaftJointConsensusEngine.test.ts (52 tests) drives the happy paths and most
 * failure paths but leaves a few boundary branches unreached:
 *   - logger.debug `process.env.DEBUG && console.log` short-circuit (getLeader
 *     throws while DEBUG is set)
 *   - `_getCurrentPeers` fallback `membership.oldPeers ?? []` / `newPeers ?? []`
 *     when a membership object carries neither field
 *   - `_computeJointProgress` jointCommitted=true branch (oldAcks/newAcks equal
 *     the voter counts instead of 0)
 *   - `transitionTo` "already in progress" nullish fallbacks when _lock is set
 *     but _state is still null (racing the awaited _getCurrentPeers)
 *   - `_executeJointPhase` / `_executeNewPhase` `!this._state` guards (invoked
 *     directly with no active transition)
 *
 * The two defensive `throw new Error('... identical oldPeers and newPeers')`
 * guards in _deriveChangeType/_getChangedNodeId are unreachable by design
 * (configsEqual intercepts identical configs first) and are already annotated
 * with `c8 ignore`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RaftJointConsensusEngine } from '../../consensus/joint-consensus/RaftJointConsensusEngine';
import type { IConsensusLayer } from '../../consensus/interfaces/interfaces';

function makePeer(id: string, role: 'voter' | 'learner' = 'voter') {
  return { id, host: 'localhost', port: 7001, role };
}

function makePeers(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => makePeer(String(i + 1 + offset)));
}

function createMockRaftGroup() {
  return {
    proposeMembershipChange: vi.fn(async () => ({ success: true, phase: 'joint' as any })),
    getConsensusPhase: vi.fn(() => 'normal' as any),
    getCurrentMembership: vi.fn(() => null),
    getProgress: vi.fn(async () => ({ commit: 100, applied: 100 })),
    getLeader: vi.fn(async () => '1'),
    getLeaderHealth: vi.fn(async () => ({ isLeader: true, peerCount: 3 })),
    propose: vi.fn(async () => {}),
    isLeader: vi.fn(async () => true),
    campaign: vi.fn(async () => {}),
    shardId: 0,
  };
}

function createMockConsensusLayer(): IConsensusLayer {
  return {
    start: vi.fn(), stop: vi.fn(), propose: vi.fn(), isLeader: vi.fn(),
    getLeader: vi.fn(), getCommitIndex: vi.fn(), registerShard: vi.fn(),
    removeShard: vi.fn(), notifyTopologyChange: vi.fn(), getHealthStatus: vi.fn(),
    campaign: vi.fn(), on: vi.fn(), off: vi.fn(), setForceLeader: vi.fn(),
  } as any;
}

describe('RaftJointConsensusEngine — branch completion', () => {
  afterEach(() => {
    delete process.env.DEBUG;
    vi.restoreAllMocks();
  });

  describe('logger.debug short-circuit (DEBUG env + getLeader throw)', () => {
    it('calls console.log when DEBUG is set and getLeader throws', async () => {
      process.env.DEBUG = '1';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // getCurrentMembership -> null, getLeader throws → logger.debug path.
      const group = createMockRaftGroup();
      group.getCurrentMembership = vi.fn(() => null);
      group.getLeader = vi.fn(async () => { throw new Error('no leader'); });

      // A second group supplies membership so peers resolve.
      const groupB = createMockRaftGroup();
      groupB.getCurrentMembership = vi.fn(() => ({
        oldPeers: ['1', '2', '3'],
        newPeers: ['1', '2', '3'],
      }));

      const engine = new RaftJointConsensusEngine(
        (shardId) => (shardId === 0 ? group : groupB) as any,
        () => createMockConsensusLayer(),
      );

      const result = await engine.transitionTo(makePeers(3, 4));
      expect(result.success).toBe(true);
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('_getCurrentPeers membership without oldPeers/newPeers fields', () => {
    it('falls back to empty peers when a secondary-group membership has no peer fields', async () => {
      // First group returns null membership (enters the !currentMembership branch),
      // so _getCurrentPeers iterates ALL groups to collect peers. The second group
      // returns a truthy membership lacking oldPeers/newPeers → `?? []` fallback
      // at L554. Nothing is collected → default single-voter peer.
      const groupA = createMockRaftGroup();
      groupA.getCurrentMembership = vi.fn(() => null); // triggers !currentMembership
      groupA.getLeader = vi.fn(async () => null);

      const groupB = createMockRaftGroup();
      groupB.getCurrentMembership = vi.fn(() => ({})) as any; // truthy, no peer fields
      groupB.getLeader = vi.fn(async () => null);

      const engine = new RaftJointConsensusEngine(
        (shardId) => (shardId === 0 ? groupA : groupB) as any,
        () => createMockConsensusLayer(),
      );

      // [default '1'] differs from ['1','2','3'], so the transition proceeds.
      const result = await engine.transitionTo(makePeers(3));
      expect(result.success).toBe(true);
    });
  });

  describe('_computeJointProgress jointCommitted=true', () => {
    it('reports oldAcks/newAcks equal to voter counts once jointCommitted', async () => {
      // Drive a transition to jointCommitted=true, then read progress mid-transition.
      let proposeCall = 0;
      const group = createMockRaftGroup();
      group.getCurrentMembership = vi.fn(() => ({
        oldPeers: ['1', '2', '3'],
        newPeers: ['1', '2', '3'],
      }));

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      // Force a slow C_NEW so the transition stays in the "jointCommitted=true"
      // window long enough to read progress.
      group.proposeMembershipChange = vi.fn(async (change: any) => {
        proposeCall++;
        if (change.changeId?.includes('-new')) {
          await new Promise((r) => setTimeout(r, 150));
          return { success: true, phase: 'normal' as any };
        }
        return { success: true, phase: 'joint' as any };
      });

      const promise = engine.transitionTo(makePeers(3, 4));
      await new Promise((r) => setTimeout(r, 20));

      // At this point C_JOINT committed → jointCommitted === true.
      const progress = engine.getProgress();
      expect(progress).not.toBeNull();
      expect(progress!.jointAcks.oldAcks).toBeGreaterThan(0);
      expect(progress!.jointAcks.newAcks).toBeGreaterThan(0);

      await promise;
    });
  });

  describe('transitionTo "already in progress" with _state still null', () => {
    it('uses nullish fallbacks when _lock set but _state not yet assigned', async () => {
      // First transitionTo stalls inside _getCurrentPeers (getLeader never resolves)
      // so _lock is true but _state is still null. Second call hits the lock branch.
      let resolveLeader: (v: string | null) => void;
      const leaderGate = new Promise<string | null>((r) => { resolveLeader = r; });

      const group = createMockRaftGroup();
      group.getCurrentMembership = vi.fn(() => null);
      group.getLeader = vi.fn(() => leaderGate);

      const engine = new RaftJointConsensusEngine(
        () => group as any,
        () => createMockConsensusLayer(),
      );

      const first = engine.transitionTo(makePeers(3, 4));
      // Give the first transition a tick to reach _getCurrentPeers and set _lock.
      await new Promise((r) => setTimeout(r, 10));

      // Second transition hits the lock branch while _state is null.
      const second = await engine.transitionTo(makePeers(3, 7));
      expect(second.success).toBe(false);
      expect(second.error).toContain('already in progress');
      expect(second.oldConfig).toEqual([]);
      expect(second.newConfig).toEqual([]);
      expect(second.phase).toBe('unknown');

      // Release the first transition and let it finish.
      resolveLeader!('1');
      await first;
    });
  });

  describe('private phase guards (no active transition)', () => {
    it('_executeJointPhase returns "No active transition" with no state', async () => {
      const engine = new RaftJointConsensusEngine(
        () => createMockRaftGroup() as any,
        () => createMockConsensusLayer(),
      );
      const result = await (engine as any)._executeJointPhase();
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active transition');
    });

    it('_executeNewPhase returns "No active transition" with no state', async () => {
      const engine = new RaftJointConsensusEngine(
        () => createMockRaftGroup() as any,
        () => createMockConsensusLayer(),
      );
      const result = await (engine as any)._executeNewPhase();
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active transition');
    });
  });
});
