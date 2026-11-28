/**
 * Logical primary name — a stable address that follows the elected leader.
 *
 * The defect this pins: clients addressed a physical node id, so a failover was
 * a DNS change rather than a protocol event, and no caller could ask *which*
 * node the name resolved to or *when* it last moved. A logical name is resolved
 * through the cluster's own membership — leader id plus the live member set —
 * through engine-agnostic callbacks, so no engine import is needed and the
 * resolver can be driven by any consensus implementation.
 *
 * TDD: every assertion here is written before the resolver exists.
 */

import { describe, it, expect } from 'vitest';
import {
  LogicalPrimaryResolver,
  resolveLogicalPrimary,
  type PrimaryMember,
  type PrimaryResolution,
} from './LogicalPrimaryResolver';

const member = (id: string, role: PrimaryMember['role']): PrimaryMember => ({ id, role });

describe('resolveLogicalPrimary — pure resolution over membership', () => {
  it('resolves the name to the elected leader when it is a live member', () => {
    const result = resolveLogicalPrimary('primary', {
      leaderId: 2,
      members: [member('node-1', 'follower'), member('node-2', 'leader'), member('node-3', 'follower')],
    });
    expect(result).toEqual({
      name: 'primary',
      memberId: 'node-2',
      resolved: true,
      reason: 'leader-is-member',
      leaderTerm: undefined,
    });
  });

  it('refuses by name when there is no leader', () => {
    const result = resolveLogicalPrimary('primary', {
      leaderId: null,
      members: [member('node-1', 'follower')],
    });
    expect(result.resolved).toBe(false);
    expect(result.memberId).toBeNull();
    expect(result.reason).toBe('no-leader');
  });

  it('refuses by name when the leader id is absent from the member set', () => {
    const result = resolveLogicalPrimary('primary', {
      leaderId: 9,
      members: [member('node-1', 'follower'), member('node-2', 'follower')],
    });
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('leader-not-a-member');
  });

  it('refuses by name when the member set is empty', () => {
    const result = resolveLogicalPrimary('primary', { leaderId: 1, members: [] });
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('no-members');
  });

  it('refuses an empty logical name', () => {
    expect(() => resolveLogicalPrimary('  ', { leaderId: 1, members: [member('n', 'leader')] })).toThrow(
      /logical name must be non-empty/,
    );
  });

  it('matches a numeric leader id against a numeric string member id', () => {
    const result = resolveLogicalPrimary('orders', { leaderId: 2, members: [member('2', 'leader')] });
    expect(result.resolved).toBe(true);
    expect(result.memberId).toBe('2');
  });

  it('carries the leader term through when the caller supplies it', () => {
    const result = resolveLogicalPrimary('primary', {
      leaderId: 1,
      leaderTerm: 7,
      members: [member('node-1', 'leader')],
    });
    expect(result.leaderTerm).toBe(7);
  });

  it('does not require the member role to say leader — the election is authoritative', () => {
    // Membership views lag elections. The elected leader id is the fact; a
    // stale role label on the member row must not make the name unresolvable.
    const result = resolveLogicalPrimary('primary', {
      leaderId: 3,
      members: [member('node-3', 'follower')],
    });
    expect(result.resolved).toBe(true);
    expect(result.memberId).toBe('node-3');
  });
});

describe('LogicalPrimaryResolver — epoch advances on failover', () => {
  const makeDeps = (leaderId: number | null, ids: string[]) => ({
    leader: async () => leaderId,
    members: async () => ids.map((id) => member(id, id === `node-${leaderId}` ? 'leader' : 'follower')),
  });

  it('reports resolution 0 before the first resolve', () => {
    const resolver = new LogicalPrimaryResolver('primary', makeDeps(1, ['node-1']));
    expect(resolver.epoch()).toBe(0);
    expect(resolver.lastMemberId()).toBeNull();
  });

  it('first successful resolution advances the epoch to 1', async () => {
    const resolver = new LogicalPrimaryResolver('primary', makeDeps(1, ['node-1']));
    const first = await resolver.resolve();
    expect(first.resolved).toBe(true);
    expect(first.epoch).toBe(1);
    expect(resolver.epoch()).toBe(1);
  });

  it('re-resolving to the same member does not advance the epoch', async () => {
    let leader: number | null = 1;
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => leader,
      members: async () => [member('node-1', 'leader')],
    });
    await resolver.resolve();
    leader = 1;
    const again = await resolver.resolve();
    expect(again.epoch).toBe(1);
    expect(resolver.epoch()).toBe(1);
  });

  it('advances the epoch when the name follows a failover to a new leader', async () => {
    let leader: number | null = 1;
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => leader,
      members: async () => [member('node-1', 'follower'), member('node-2', 'leader')],
    });
    const before = await resolver.resolve();
    expect(before.memberId).toBe('node-1');
    leader = 2;
    const after = await resolver.resolve();
    expect(after.memberId).toBe('node-2');
    expect(after.epoch).toBe(2);
    expect(after.changed).toBe(true);
  });

  it('does not advance the epoch while there is no leader', async () => {
    let leader: number | null = 1;
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => leader,
      members: async () => [member('node-1', 'leader')],
    });
    await resolver.resolve();
    leader = null;
    const gap = await resolver.resolve();
    expect(gap.resolved).toBe(false);
    expect(resolver.epoch()).toBe(1);
  });

  it('reports changed only on the resolution that moved', async () => {
    let leader: number | null = 1;
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => leader,
      members: async () => [member('node-1', 'leader'), member('node-2', 'follower')],
    });
    expect((await resolver.resolve()).changed).toBe(true);
    expect((await resolver.resolve()).changed).toBe(false);
    leader = 2;
    expect((await resolver.resolve()).changed).toBe(true);
  });

  it('queries the injected callbacks on every resolve — membership is live', async () => {
    let leaderCalls = 0;
    let memberCalls = 0;
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => {
        leaderCalls++;
        return 1;
      },
      members: async () => {
        memberCalls++;
        return [member('node-1', 'leader')];
      },
    });
    await resolver.resolve();
    await resolver.resolve();
    expect(leaderCalls).toBe(2);
    expect(memberCalls).toBe(2);
  });

  it('refuses an empty logical name at construction', () => {
    expect(() => new LogicalPrimaryResolver('  ', makeDeps(1, ['node-1']))).toThrow(/logical name must be non-empty/);
  });

  it('carries the term callback through to the resolution', async () => {
    const resolver = new LogicalPrimaryResolver('primary', {
      leader: async () => 1,
      members: async () => [member('node-1', 'leader')],
      term: async () => 11,
    });
    const result = await resolver.resolve();
    expect(result.leaderTerm).toBe(11);
  });
});
