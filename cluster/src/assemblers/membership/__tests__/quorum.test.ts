/**
 * Majority arithmetic — the numbers every other decision here is built on.
 *
 * These are the assertions that would have caught the shortcuts: `ceil(n/2)` for
 * three voters, learners counted as voters, and "a majority of what is left" used
 * where "a majority of what exists" is the question.
 */

import { describe, expect, it } from 'vitest';
import { holdsQuorumOf, isVoter, leaderOf, quorumOf, tolerableFailures, votersOf } from '../quorum.js';
import type { ClusterMember } from '../../interfaces/index.js';

const member = (id: string, role: ClusterMember['role'], zone?: string): ClusterMember =>
  zone === undefined ? { id, role } : { id, role, zone };

describe('quorumOf', () => {
  it('AC-CL1.1 asks for a strict majority, not half rounded up', () => {
    // ceil(3/2) is 2 and so is floor(3/2)+1 — the disagreement is at 5 and 1,
    // which is where a "half plus one" written as `ceil` stops agreeing.
    expect([1, 2, 3, 4, 5, 6, 7].map(quorumOf)).toEqual([1, 2, 2, 3, 3, 4, 4]);
    for (const size of [3, 5, 7, 9]) {
      expect(quorumOf(size) * 2).toBeGreaterThan(size);
    }
  });

  it('AC-CL1.2 gives an empty group no quorum rather than a quorum of one', () => {
    expect(quorumOf(0)).toBe(0);
    expect(quorumOf(-3)).toBe(0);
  });

  it('AC-CL1.3 leaves one failure of slack from three voters upward', () => {
    expect([1, 2, 3, 4, 5, 6].map(tolerableFailures)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(tolerableFailures(0)).toBe(0);
    expect(tolerableFailures(-1)).toBe(0);
  });
});

describe('members', () => {
  it('AC-CL1.4 counts learners as members but not as voters', () => {
    const members = [
      member('n1', 'leader'),
      member('n2', 'follower'),
      member('n3', 'learner'),
      member('n4', 'learner'),
    ];
    expect(members.filter(isVoter).map((entry) => entry.id)).toEqual(['n1', 'n2']);
    expect(votersOf(members).map((entry) => entry.id)).toEqual(['n1', 'n2']);
    // Two voters tolerate no failure — the two learners do not change that, and a
    // planner that counted them would batch two nodes at once and stop the group.
    expect(tolerableFailures(votersOf(members).length)).toBe(0);
  });

  it('AC-CL1.5 finds the leader, or reports that there is none', () => {
    expect(leaderOf([member('n2', 'follower'), member('n1', 'leader')])?.id).toBe('n1');
    expect(leaderOf([member('n2', 'follower')])).toBeNull();
    expect(leaderOf([])).toBeNull();
  });
});

describe('holdsQuorumOf', () => {
  it('AC-CL1.6 measures against the configuration that exists, not the one proposed', () => {
    const before = [member('n1', 'leader'), member('n2', 'follower'), member('n3', 'follower')];
    const twoLeft = [member('n1', 'leader'), member('n2', 'follower')];

    // Two of three is a majority of what exists, and two of what is left: allowed.
    expect(holdsQuorumOf(before, twoLeft)).toBe(true);
    // One of three is not, even though it is all of "what would be left".
    expect(holdsQuorumOf(before, [member('n1', 'leader')])).toBe(false);
    expect(holdsQuorumOf(before, [])).toBe(false);
  });

  it('AC-CL1.7 treats an empty group as vacuously holding quorum', () => {
    // There is nothing to lose a majority of. The group is unusable for another
    // reason, and this function does not pretend to be about that reason.
    expect(holdsQuorumOf([], [])).toBe(true);
    expect(holdsQuorumOf([member('n3', 'learner')], [])).toBe(true);
  });

  it('AC-CL1.8 counts remaining voters, not remaining members', () => {
    const before = [
      member('n1', 'leader'),
      member('n2', 'follower'),
      member('n3', 'follower'),
      member('n4', 'learner'),
      member('n5', 'learner'),
    ];
    // Two of five members remain — one of them a voter. A majority of the
    // *members* is not a majority of the voters, and the group would stop
    // committing.
    expect(holdsQuorumOf(before, [member('n1', 'leader'), member('n4', 'learner')])).toBe(false);
    // Two voters remain: exactly a majority of the three that existed.
    expect(holdsQuorumOf(before, [member('n3', 'follower'), member('n5', 'learner'), member('n2', 'follower')])).toBe(
      true,
    );
  });
});
