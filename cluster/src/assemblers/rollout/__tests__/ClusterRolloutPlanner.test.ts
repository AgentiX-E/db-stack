/**
 * A plan is a list; a sequence is a decision.
 *
 * The cases below are the three ways a faithful batching of the operator's list is
 * still the wrong thing to run: the leader went first, a batch cost quorum, or a
 * batch landed entirely in one zone.
 */

import { describe, expect, it } from 'vitest';
import type { ClusterMember } from '../../interfaces/index.js';
import { ClusterRolloutPlanner } from '../ClusterRolloutPlanner.js';

const planner = new ClusterRolloutPlanner();

const members = (...specs: Array<[string, ClusterMember['role'], string?]>): ClusterMember[] =>
  specs.map(([id, role, zone]) => (zone === undefined ? { id, role } : { id, role, zone }));

describe('ClusterRolloutPlanner — order', () => {
  it('AC-CL4.1 upgrades followers before the leader', () => {
    const plan = planner.plan({
      nodes: ['n1', 'n2', 'n3'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['n2'], ['n3'], ['n1']]);
    expect(plan.feasible).toBe(true);
    expect(plan.note).toContain('leader last');
  });

  it('AC-CL4.2 upgrades learners first — a learner left behind cannot be promoted', () => {
    const plan = planner.plan({
      nodes: ['n1', 'n2', 'n3', 'n4'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'learner'], ['n4', 'follower']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['n3'], ['n2'], ['n4'], ['n1']]);
  });

  it('AC-CL4.3 spreads a batch across zones when it can', () => {
    const plan = planner.plan({
      nodes: ['a1', 'a2', 'b1', 'b2', 'c1'],
      members: members(
        ['a1', 'follower', 'zone-a'],
        ['a2', 'follower', 'zone-a'],
        ['b1', 'follower', 'zone-b'],
        ['b2', 'follower', 'zone-b'],
        ['c1', 'leader', 'zone-c'],
      ),
      batchStrategy: 'fixed_size',
      batchSize: 2,
    });

    // Interleaved first, then the batch picks one per zone where it can: a batch
    // of two from one rack is a majority-of-one-rack waiting to happen.
    expect(plan.batches[0]?.nodes).toEqual(['a1', 'b1']);
    expect(plan.batches[0]?.zones).toEqual(['zone-a', 'zone-b']);
    expect(plan.batches.flatMap((batch) => batch.nodes)).toHaveLength(5);
    expect(plan.batches.at(-1)?.nodes).toEqual(['c1']);
  });

  it('AC-CL4.3b falls back to the next node when every remaining one shares a zone', () => {
    // One rack, five voters. The batch cannot spread, and a planner that insisted
    // on a distinct zone would take nothing at all.
    const plan = planner.plan({
      nodes: ['a1', 'a2', 'a3', 'a4', 'a5'],
      members: members(
        ['a1', 'leader', 'zone-a'],
        ['a2', 'follower', 'zone-a'],
        ['a3', 'follower', 'zone-a'],
        ['a4', 'follower', 'zone-a'],
        ['a5', 'follower', 'zone-a'],
      ),
      batchStrategy: 'fixed_size',
      batchSize: 3,
    });

    expect(plan.batches[0]?.nodes).toEqual(['a2', 'a3']);
    expect(plan.batches[0]?.zones).toEqual(['zone-a']);
    expect(plan.batches.flatMap((batch) => batch.nodes)).toHaveLength(5);
  });

  it('AC-CL4.4 reports no zones when no member declares one', () => {
    const plan = planner.plan({
      nodes: ['n2'],
      members: members(['n1', 'leader'], ['n2', 'follower']),
      batchStrategy: 'one_by_one',
    });
    expect(plan.batches[0]?.zones).toBeNull();
  });
});

describe('ClusterRolloutPlanner — quorum', () => {
  it('AC-CL4.5 caps a batch at the number of failures the group can take', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n3', 'n4', 'n5', 'n1'],
      members: members(
        ['n1', 'leader'],
        ['n2', 'follower'],
        ['n3', 'follower'],
        ['n4', 'follower'],
        ['n5', 'follower'],
      ),
      batchStrategy: 'all_at_once',
    });

    // Five voters tolerate two; "all at once" is not a strategy that may cost the
    // group its ability to commit.
    expect(plan.requestedBatchSize).toBe(5);
    expect(plan.effectiveBatchSize).toBe(2);
    expect(plan.batches.map((batch) => batch.nodes.length)).toEqual([2, 2, 1]);
    for (const batch of plan.batches) {
      expect(batch.votersDown).toBeLessThanOrEqual(2);
    }
  });

  it('AC-CL4.6 reports a group that cannot afford any failure as infeasible', () => {
    const plan = planner.plan({
      nodes: ['n1'],
      members: members(['n1', 'leader']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.feasible).toBe(false);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.votersDown).toBe(1);
    expect(plan.note).toContain('outage window, not a rollout');
  });

  it('AC-CL4.7 keeps the leader upgradeable when the group can afford it', () => {
    const plan = planner.plan({
      nodes: ['n1'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.feasible).toBe(true);
    expect(plan.batches[0]?.nodes).toEqual(['n1']);
  });

  it('AC-CL4.8 does not count a batch against the next one', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n3', 'n4', 'n5'],
      members: members(
        ['n1', 'leader'],
        ['n2', 'follower'],
        ['n3', 'follower'],
        ['n4', 'follower'],
        ['n5', 'follower'],
      ),
      batchStrategy: 'fixed_size',
      batchSize: 2,
    });

    // Batches are sequential: the first is back up before the second drains, so
    // each batch costs the group two voters and not the running total. A
    // cumulative count would read [2, 4] and describe a rollout that takes both
    // batches down at once against a group of five, which cannot commit with one
    // voter left.
    expect(plan.batches.map((batch) => batch.votersDown)).toEqual([2, 2]);
  });
});

describe('ClusterRolloutPlanner — strategies and stale plans', () => {
  it('AC-CL4.9 takes the default batch size of one for a fixed-size plan with none', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n3'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'fixed_size',
    });
    expect(plan.requestedBatchSize).toBe(1);
    expect(plan.batches).toHaveLength(2);
  });

  it('AC-CL4.10 reads a percentage against the remaining nodes, with 20 % as the default', () => {
    const ten = Array.from({ length: 10 }, (_, index) => `n${index + 1}` as const);
    const plan = planner.plan({
      nodes: ten,
      members: members(
        ['n1', 'leader'],
        ...ten.slice(1).map((id): [string, ClusterMember['role']] => [id, 'follower']),
      ),
      batchStrategy: 'percentage',
    });

    expect(plan.requestedBatchSize).toBe(2);

    const explicit = planner.plan({
      nodes: ten,
      members: members(
        ['n1', 'leader'],
        ...ten.slice(1).map((id): [string, ClusterMember['role']] => [id, 'follower']),
      ),
      batchStrategy: 'percentage',
      batchSize: 0,
    });
    expect(explicit.requestedBatchSize).toBe(2);

    // A percentage a caller really sets: half of ten is five, and the quorum budget
    // still decides how much of that may run at once.
    const half = planner.plan({
      nodes: ten,
      members: members(
        ['n1', 'leader'],
        ...ten.slice(1).map((id): [string, ClusterMember['role']] => [id, 'follower']),
      ),
      batchStrategy: 'percentage',
      batchSize: 50,
    });
    expect(half.requestedBatchSize).toBe(5);
    expect(half.effectiveBatchSize).toBe(4);
  });

  it('AC-CL4.11 names the planned nodes the group does not have', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n9'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.unplanned).toEqual([{ id: 'n9', reason: 'not a member of this group' }]);
    expect(plan.batches.flatMap((batch) => batch.nodes)).toEqual(['n2']);
  });

  it('AC-CL4.12 distinguishes "nothing to do" from "nothing I recognise"', () => {
    const empty = planner.plan({
      nodes: [],
      members: members(['n1', 'leader']),
      batchStrategy: 'one_by_one',
    });
    expect(empty.batches).toEqual([]);
    expect(empty.feasible).toBe(true);
    expect(empty.note).toBe('nothing to upgrade');

    const stale = planner.plan({
      nodes: ['n7'],
      members: members(['n1', 'leader']),
      batchStrategy: 'one_by_one',
    });
    expect(stale.batches).toEqual([]);
    expect(stale.note).toContain('none of the 1 planned node(s) is a member of this group');
    expect(stale.effectiveBatchSize).toBe(0);
  });

  it('AC-CL4.13 states an infeasible plan in numbers an operator can check', () => {
    const plan = planner.plan({
      nodes: ['n1'],
      members: members(['n1', 'leader']),
      batchStrategy: 'one_by_one',
    });

    // One voter, one batch, and the batch is the whole group: the sentence and
    // the numbers have to agree, because this is the plan someone reads at 3 a.m.
    expect(plan.batches).toEqual([{ index: 1, nodes: ['n1'], votersDown: 1, zones: null }]);
    expect(plan.requestedBatchSize).toBe(1);
    expect(plan.effectiveBatchSize).toBe(1);
    expect(plan.note).toBe(
      '1 voter(s) tolerate 0 failures; upgrading any of them stops the group from committing ' +
        '— this is an outage window, not a rollout',
    );
  });

  it('AC-CL4.14 states a feasible plan in numbers an operator can check', () => {
    const plan = planner.plan({
      nodes: ['n1'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'one_by_one',
    });

    expect(plan.batches).toEqual([{ index: 1, nodes: ['n1'], votersDown: 1, zones: null }]);
    expect(plan.note).toBe('1 node(s) in 1 batch(es) of 1, 3 voter(s) tolerate 1; leader last');
  });

  it('AC-CL4.15 numbers batches from one, in the order they run', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n3', 'n1'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'all_at_once',
    });

    // Three requested, one allowed: the cap turns one batch into three, and the
    // index is what ties a plan line to the log line of the batch that ran.
    expect(plan.requestedBatchSize).toBe(3);
    expect(plan.effectiveBatchSize).toBe(1);
    expect(plan.batches.map((batch) => batch.index)).toEqual([1, 2, 3]);
    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['n2'], ['n3'], ['n1']]);
  });

  it('AC-CL4.16 sorts the zones it reports, whatever order the members came in', () => {
    const plan = planner.plan({
      nodes: ['b1', 'a1'],
      members: members(
        ['n1', 'leader', 'zone-c'],
        ['b1', 'follower', 'zone-b'],
        ['a1', 'follower', 'zone-a'],
        ['b2', 'follower', 'zone-b'],
        ['a2', 'follower', 'zone-a'],
      ),
      batchStrategy: 'fixed_size',
      batchSize: 2,
    });

    // Five voters tolerate two, so a batch of two runs; the batch is written
    // zone-b first because that is the member order, and reported sorted because
    // two runs of the same plan must diff to nothing.
    expect(plan.batches[0]?.nodes).toEqual(['b1', 'a1']);
    expect(plan.batches[0]?.zones).toEqual(['zone-a', 'zone-b']);
  });

  it('AC-CL4.20 takes one node at a time for one_by_one, even when quorum would allow more', () => {
    const plan = planner.plan({
      nodes: ['n2', 'n3', 'n4', 'n5'],
      members: members(
        ['n1', 'leader'],
        ['n2', 'follower'],
        ['n3', 'follower'],
        ['n4', 'follower'],
        ['n5', 'follower'],
      ),
      batchStrategy: 'one_by_one',
    });

    // Five voters tolerate two, so a batch of two would fit — and would not be
    // what "one by one" means. The strategy is a request, the quorum cap is a
    // limit, and a limit is not a target.
    expect(plan.requestedBatchSize).toBe(1);
    expect(plan.effectiveBatchSize).toBe(1);
    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['n2'], ['n3'], ['n4'], ['n5']]);
  });

  it('AC-CL4.19 ignores a batch size that is not a number', () => {
    // Same boundary as a thrown string: a caller in JavaScript is not bound by
    // `batchSize?: number`, and `'5' >= 1` is true while `Math.floor('5')` is 5 —
    // a batch size the type said could not arrive.
    const plan = planner.plan({
      nodes: ['n2', 'n3'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
      batchStrategy: 'fixed_size',
      batchSize: '5' as never,
    });

    expect(plan.requestedBatchSize).toBe(1);
    expect(plan.batches).toHaveLength(2);
  });

  it('AC-CL4.18 refuses a strategy this version does not know instead of planning one node at a time', () => {
    // `BatchStrategy` is the node package's union, and a caller in JavaScript is
    // not bound by it. Answering a batch size here would be a plausible plan for
    // a strategy that may have meant something else.
    expect(() =>
      planner.plan({
        nodes: ['n2'],
        members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']),
        batchStrategy: 'weekly' as never,
      }),
    ).toThrow('unknown batch strategy "weekly"');
  });

  it('AC-CL4.17 reads a fractional fixed size down and a negative percentage as the default', () => {
    const five = members(
      ['n1', 'leader'],
      ['n2', 'follower'],
      ['n3', 'follower'],
      ['n4', 'follower'],
      ['n5', 'follower'],
    );

    // "2.7 nodes at a time" is 2 nodes: half a node is not a batch.
    const fractional = planner.plan({
      nodes: ['n2', 'n3', 'n4', 'n5'],
      members: five,
      batchStrategy: 'fixed_size',
      batchSize: 2.7,
    });
    expect(fractional.requestedBatchSize).toBe(2);
    expect(fractional.batches.map((batch) => batch.nodes.length)).toEqual([2, 2]);

    // A negative percentage is a caller that did not mean it; the default is the
    // answer, not a batch of zero nodes that loops forever.
    const negative = planner.plan({
      nodes: ['n2', 'n3', 'n4', 'n5'],
      members: five,
      batchStrategy: 'percentage',
      batchSize: -5,
    });
    expect(negative.requestedBatchSize).toBe(1);
    expect(negative.effectiveBatchSize).toBe(1);
  });

  it('AC-CL4.21 a size below one is one node, not a length that cannot be divided', () => {
    // `Math.floor(0.5)` is 0, and a batch of zero nodes is a plan whose count is
    // `ceil(length / 0)` — `Infinity`, which `Array.from` refuses by throwing. The
    // strategies clamp before the split, and this is the case that says so: half a
    // node is one node.
    const plan = planner.plan({
      nodes: ['n2', 'n3'],
      members: members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower'], ['n4', 'follower']),
      batchStrategy: 'fixed_size',
      batchSize: 0.5,
    });

    expect(plan.requestedBatchSize).toBe(1);
    expect(plan.effectiveBatchSize).toBe(1);
    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['n2'], ['n3']]);
  });

  it('AC-CL4.22 a zone with fewer nodes does not leave holes in the sequence', () => {
    // The interleave walks round by round, and a round only has a member for a
    // queue that is still deep enough. One node in zone-a and three in zone-b is
    // the shape where round 2 has nothing to take from zone-a: the round ends with
    // that queue's absence *omitted*, not carried as an empty entry — an empty entry
    // is a batch holding `undefined`, which is a plan that fails when it is run.
    const plan = planner.plan({
      nodes: ['a1', 'b1', 'b2', 'b3', 'l1'],
      members: members(
        ['a1', 'follower', 'zone-a'],
        ['b1', 'follower', 'zone-b'],
        ['b2', 'follower', 'zone-b'],
        ['b3', 'follower', 'zone-b'],
        ['l1', 'leader', 'zone-a'],
      ),
      batchStrategy: 'one_by_one',
    });

    expect(plan.batches.map((batch) => batch.nodes)).toEqual([['a1'], ['b1'], ['b2'], ['b3'], ['l1']]);
    expect(plan.batches.flatMap((batch) => batch.nodes)).not.toContain(undefined);
  });
});
