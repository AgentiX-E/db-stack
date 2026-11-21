/**
 * The reference topology has to be as strict as the thing it stands in for.
 *
 * Every assembler in this package is tested against this class, so a class that
 * accepted a duplicate id or removed a member it had never heard of would make
 * the whole suite agree with a cluster that cannot exist. The cases below are the
 * rules a consensus layer enforces, and each one is here because a fake that
 * skipped it would hide the bug the assembler was written to prevent.
 */

import { describe, expect, it } from 'vitest';
import { ClusterMembershipError } from '../errors.js';
import { InMemoryClusterTopology } from '../InMemoryClusterTopology.js';

describe('InMemoryClusterTopology', () => {
  it('AC-CL2.1 reads a member set without handing out the one it holds', async () => {
    const topology = new InMemoryClusterTopology({
      members: [
        { id: 'n1', role: 'leader' },
        { id: 'n2', role: 'follower', zone: 'a' },
      ],
    });

    const first = await topology.members();
    (first as unknown as Array<{ id: string }>).push({ id: 'injected' });
    (first[0] as { role: string }).role = 'learner';

    const second = await topology.members();
    expect(second.map((member) => member.id)).toEqual(['n1', 'n2']);
    expect(second[0]?.role).toBe('leader');
    expect(topology.readCount).toBe(2);
  });

  it('AC-CL2.2 refuses a member set with two leaders, and one with a repeated id', () => {
    expect(
      () =>
        new InMemoryClusterTopology({
          members: [
            { id: 'n1', role: 'leader' },
            { id: 'n2', role: 'leader' },
          ],
        }),
    ).toThrow(/at most one/);

    expect(
      () =>
        new InMemoryClusterTopology({
          members: [
            { id: 'n1', role: 'follower' },
            { id: 'n1', role: 'follower' },
          ],
        }),
    ).toThrow(/listed twice/);
  });

  it('AC-CL2.3 adds a member, with its zone when one is given', async () => {
    const topology = new InMemoryClusterTopology({ members: [{ id: 'n1', role: 'leader' }] });
    await topology.addNode('n2', { zone: 'eu-west-1b' });
    await topology.addNode('n3');

    const members = await topology.members();
    expect(members.map((member) => [member.id, member.role, member.zone ?? null])).toEqual([
      ['n1', 'leader', null],
      ['n2', 'follower', 'eu-west-1b'],
      ['n3', 'follower', null],
    ]);
  });

  it('AC-CL2.4 refuses a duplicate join and an id that is only whitespace', async () => {
    const topology = new InMemoryClusterTopology({ members: [{ id: 'n1', role: 'leader' }] });

    await expect(topology.addNode('n1')).rejects.toBeInstanceOf(ClusterMembershipError);
    await expect(topology.addNode('n1')).rejects.toMatchObject({ code: 'duplicate-member' });
    await expect(topology.addNode('   ')).rejects.toMatchObject({ code: 'unsupported' });
    expect((await topology.members()).length).toBe(1);
  });

  it('AC-CL2.5 removes a member and reports an unknown id as a failure', async () => {
    const topology = new InMemoryClusterTopology({
      members: [
        { id: 'n1', role: 'leader' },
        { id: 'n2', role: 'follower' },
      ],
    });

    await topology.removeNode('n2');
    expect((await topology.members()).map((member) => member.id)).toEqual(['n1']);

    // Not a no-op: a scale-down has to be able to tell "already gone" from
    // "refused", and a silent success makes the two indistinguishable.
    await expect(topology.removeNode('n2')).rejects.toMatchObject({ code: 'unknown-member' });
  });

  it('AC-CL2.6 moves leadership without ever having two leaders', async () => {
    const topology = new InMemoryClusterTopology({
      members: [
        { id: 'n1', role: 'leader' },
        { id: 'n2', role: 'follower' },
      ],
    });

    expect(() => topology.setRole('n2', 'leader')).toThrow(/already leader/);
    topology.setRole('n1', 'follower');
    topology.setRole('n2', 'leader');

    const members = await topology.members();
    expect(members.filter((member) => member.role === 'leader').map((member) => member.id)).toEqual(['n2']);
    expect(() => topology.setRole('n9', 'follower')).toThrow(/does not exist/);
  });

  it('AC-CL2.7 normalises a role change that is not a promotion', async () => {
    const topology = new InMemoryClusterTopology({
      members: [
        { id: 'n1', role: 'leader' },
        { id: 'n2', role: 'learner' },
      ],
    });
    topology.setRole('n2', 'follower');
    expect((await topology.members())[1]?.role).toBe('follower');
  });
});
