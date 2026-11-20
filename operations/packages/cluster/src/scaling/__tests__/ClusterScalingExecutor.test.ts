/**
 * The scaler's opinion against the cluster's fact.
 *
 * Each of these cases is one way the two numbers drift apart, and the assertion is
 * always the same shape: what the executor did, what it refused to do, and whether
 * the refusal is in the outcome rather than in a log line nobody reads.
 */

import { describe, expect, it } from 'vitest';
import type { ScaleAction } from '@agentix-e/db-operations-node/autoscaler';
import type { ClusterMember, IClusterTopology } from '../../interfaces/index.js';
import { ClusterMembershipError } from '../../membership/errors.js';
import { InMemoryClusterTopology } from '../../membership/InMemoryClusterTopology.js';
import { ClusterScalingExecutor } from '../ClusterScalingExecutor.js';

const action = (direction: ScaleAction['action'], targetCount: number): ScaleAction => ({
  action: direction,
  amount: Math.abs(targetCount),
  reason: 'test action',
  triggeredBy: ['cpu'],
  targetCount,
  timestamp: 1_700_000_000_000,
  policy: 'test',
});

const members = (...specs: Array<[string, ClusterMember['role']]>): ClusterMember[] =>
  specs.map(([id, role]) => ({ id, role }));

const topologyOf = (specs: Array<[string, ClusterMember['role']]>): InMemoryClusterTopology =>
  new InMemoryClusterTopology({ members: members(...specs) });

describe('ClusterScalingExecutor — scale up', () => {
  it('AC-CL3.1 grows by the difference from what exists, not from what the scaler remembers', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    // The scaler believes there are four members and wants five. There are three.
    const outcome = await executor.apply(action('scale_up', 5));

    expect(outcome.applied).toEqual(['node-1', 'node-2']);
    expect(outcome.observedCount).toBe(3);
    expect(outcome.targetCount).toBe(5);
    expect(outcome.clampedBy).toBeNull();
    expect(outcome.direction).toBe('scale_up');
    expect(outcome.skipped).toEqual([]);
    expect(outcome.note).toBe('grew from 3 to 5 members');
    expect((await topology.members()).map((member) => member.id)).toEqual(['n1', 'n2', 'n3', 'node-1', 'node-2']);
  });

  it('AC-CL3.2 stops at the policy ceiling and says so', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 4 });

    const outcome = await executor.apply(action('scale_up', 9));

    expect(outcome.targetCount).toBe(4);
    expect(outcome.applied).toEqual(['node-1', 'node-2']);
    expect(outcome.clampedBy).toBe('policy-max');
    expect(outcome.note).toBe('grew from 2 to 4 members');
  });

  it('AC-CL3.3 treats a target below the current size as a stale decision, not a removal', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_up', 2));

    // A scale-up that removes nodes would be a scale-down that skipped every
    // quorum check on its way past them.
    expect(outcome.direction).toBe('none');
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.clampedBy).toBeNull();
    expect(outcome.note).toBe('already at 3 members, policy ceiling is 10');
    expect(outcome.targetCount).toBe(3);
    expect((await topology.members()).length).toBe(3);
  });

  it('AC-CL3.4 mints ids the member set does not already use', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['node-1', 'follower'],
      ['node-3', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10, idPrefix: 'node' });

    const outcome = await executor.apply(action('scale_up', 5));

    expect(outcome.applied).toEqual(['node-2', 'node-4']);
  });

  it('AC-CL3.5 records a refused join and keeps going', async () => {
    const membersNamed = members(['n1', 'leader']);
    const added: string[] = [];
    const topology: IClusterTopology = {
      async members() {
        return [...membersNamed, ...added.map((id): ClusterMember => ({ id, role: 'follower' }))];
      },
      async addNode(id) {
        if (id === 'node-1') throw new Error('quota exceeded for this zone');
        added.push(id);
      },
      async removeNode() {
        throw new Error('not used');
      },
    };
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_up', 4));

    expect(outcome.applied).toEqual(['node-2', 'node-3']);
    expect(outcome.skipped).toEqual([{ id: 'node-1', reason: 'quota exceeded for this zone' }]);
    expect(outcome.targetCount).toBe(3);
    expect(outcome.note).toBe('grew from 1 to 3; 1 join(s) refused');
  });

  it('AC-CL3.5b records a refusal that is not an Error at all', async () => {
    // A port is a boundary, and a boundary can reject with anything. The reason has
    // to survive as a string rather than as `[object Object]`.
    const topology: IClusterTopology = {
      async members() {
        return members(['n1', 'leader']);
      },
      async addNode() {
        // eslint-disable-next-line no-throw-literal -- the port rejects with a string
        throw 'membership service unavailable';
      },
      async removeNode() {
        throw new Error('not used');
      },
    };
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 5 });

    const outcome = await executor.apply(action('scale_up', 2));

    expect(outcome.skipped).toEqual([{ id: 'node-1', reason: 'membership service unavailable' }]);
    expect(outcome.applied).toEqual([]);
  });
});

describe('ClusterScalingExecutor — scale down', () => {
  it('AC-CL3.6 stops at the quorum floor, not at the requested count', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
      ['n4', 'follower'],
      ['n5', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    // Five voters tolerate two failures; asking for two members asks for three
    // failures, which is a cluster that can no longer commit.
    const outcome = await executor.apply(action('scale_down', 2));

    expect(outcome.targetCount).toBe(3);
    expect(outcome.applied).toEqual(['n5', 'n4']);
    expect(outcome.clampedBy).toBe('quorum-floor');
    expect(outcome.note).toBe('shrank from 5 to 3 members; stopped at the quorum floor of 3 voter(s)');
    expect((await topology.members()).map((member) => member.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('AC-CL3.7 respects the policy floor when it is the higher one', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
      ['n4', 'follower'],
      ['n5', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 4, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_down', 1));

    expect(outcome.targetCount).toBe(4);
    expect(outcome.applied).toEqual(['n5']);
    expect(outcome.clampedBy).toBe('policy-min');
    expect(outcome.note).toBe('shrank from 5 to 4 members; stopped at the policy floor of 4');
  });

  it('AC-CL3.8 never removes the leader, even when it is the newest id', async () => {
    const topology = topologyOf([
      ['n1', 'follower'],
      ['n2', 'follower'],
      ['n9', 'leader'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_down', 2));

    // n9 is the newest id and would be first in the removal order if it were a
    // follower; the leader's role, not its name, decides.
    expect(outcome.applied).toEqual(['n2']);
    expect((await topology.members()).map((member) => member.id).sort()).toEqual(['n1', 'n9']);
  });

  it('AC-CL3.9 removes learners before followers — they do not vote', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'learner'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_down', 2));

    // Two members is the floor for three voters; the learner is the node that
    // costs nothing to lose.
    expect(outcome.applied).toEqual(['n3']);
    expect(outcome.direction).toBe('scale_down');
  });

  it('AC-CL3.10 treats "already absent" as the outcome that was wanted', async () => {
    const present = members(
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
      ['n4', 'follower'],
      ['n5', 'follower'],
    );
    const removed: string[] = [];
    const topology: IClusterTopology = {
      async members() {
        return present.filter((member) => !removed.includes(member.id));
      },
      async addNode() {
        throw new Error('not used');
      },
      async removeNode(id) {
        if (id === 'n4') {
          // Another actor got here first: the plan is stale by one node, and the
          // state the caller asked for is the state that already exists.
          throw new ClusterMembershipError('unknown-member', `member ${id} does not exist`);
        }
        removed.push(id);
      },
    };
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_down', 3));

    // One removal happened, one was already done by somebody else, and the group
    // is at the target: three members. Removing a third node here — the thing the
    // plan asked for — would take the group to two because the plan counted a node
    // that had already left.
    expect(outcome.applied).toEqual(['n5']);
    expect(outcome.skipped).toEqual([{ id: 'n4', reason: 'already absent' }]);
    expect(outcome.targetCount).toBe(3);
    expect(outcome.note).toBe('shrank from 5 to 3 members');
  });

  it('AC-CL3.11 stops after a refusal that is not "already absent"', async () => {
    let removals = 0;
    const topology: IClusterTopology = {
      async members() {
        return members(
          ['n1', 'leader'],
          ['n2', 'follower'],
          ['n3', 'follower'],
          ['n4', 'follower'],
          ['n5', 'follower'],
        );
      },
      async addNode() {
        throw new Error('not used');
      },
      async removeNode() {
        removals += 1;
        throw new ClusterMembershipError('unsupported', 'configuration change in progress');
      },
    };
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 10 });

    const outcome = await executor.apply(action('scale_down', 3));

    // The layer pushed back. Walking further into the floor it is protecting is
    // how a scale-down becomes a data-loss incident.
    expect(removals).toBe(1);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: 'n5', reason: 'configuration change in progress' }]);
    expect(outcome.direction).toBe('none');
    expect(outcome.targetCount).toBe(5);
  });
});

describe('ClusterScalingExecutor — no action', () => {
  it('AC-CL3.12 reports a declined decision without touching the topology', async () => {
    const topology = topologyOf([['n1', 'leader']]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 1, maxNodes: 3 });

    const declined = await executor.apply(action('none', 1));
    expect(declined.direction).toBe('none');
    expect(declined.note).toBe('scaler declined to act: test action');
    expect(declined.clampedBy).toBeNull();
    expect(declined.applied).toEqual([]);
    expect(declined.skipped).toEqual([]);

    const absent = await executor.apply(null);
    expect(absent.direction).toBe('none');
    expect(absent.note).toBe('scaler returned no action');
    expect(absent.action).toBeNull();
  });

  it('AC-CL3.13 refuses a policy that can never be satisfied, and accepts a floor of zero', () => {
    const topology = topologyOf([['n1', 'leader']]);
    expect(() => new ClusterScalingExecutor({ topology, minNodes: -1, maxNodes: 3 })).toThrow('minNodes must be >= 0');
    expect(() => new ClusterScalingExecutor({ topology, minNodes: 5, maxNodes: 3 })).toThrow(
      'maxNodes (3) is below minNodes (5); a policy that can never be satisfied would clamp every action',
    );
    // Zero is a floor, not a missing value: "scale to nothing when traffic stops"
    // is a policy a deployment may hold, and the quorum floor still overrides it.
    expect(() => new ClusterScalingExecutor({ topology, minNodes: 0, maxNodes: 3 })).not.toThrow();
  });

  it('AC-CL3.16 reports no clamp when the target is exactly the policy floor', async () => {
    const topology = topologyOf([
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
      ['n4', 'follower'],
      ['n5', 'follower'],
    ]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 3, maxNodes: 10 });

    // Five voters, a floor of three, and a target of three: the policy floor and
    // the request agree, so nothing was clamped and nothing is claimed to be.
    const outcome = await executor.apply(action('scale_down', 3));

    expect(outcome.applied).toEqual(['n5', 'n4']);
    expect(outcome.clampedBy).toBeNull();
    expect(outcome.note).toBe('shrank from 5 to 3 members');
  });

  it('AC-CL3.14 grows to the policy floor when the scaler asks for less than the minimum', async () => {
    const topology = topologyOf([['n1', 'leader']]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 3, maxNodes: 10 });

    // The scaler wants two members; the policy says a cluster smaller than three
    // is not a configuration this deployment runs.
    const outcome = await executor.apply(action('scale_up', 2));

    expect(outcome.applied).toEqual(['node-1', 'node-2']);
    expect(outcome.targetCount).toBe(3);
    expect(outcome.clampedBy).toBe('policy-min');
  });

  it('AC-CL3.15 stops growing at the ceiling when floor and ceiling coincide', async () => {
    const topology = topologyOf([['n1', 'leader']]);
    const executor = new ClusterScalingExecutor({ topology, minNodes: 2, maxNodes: 2 });

    const outcome = await executor.apply(action('scale_up', 2));
    expect(outcome.applied).toEqual(['node-1']);
    expect(outcome.clampedBy).toBeNull();
  });
});
