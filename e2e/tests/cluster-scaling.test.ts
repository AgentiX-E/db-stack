/**
 * E2E — a scale-down that stops at the quorum floor, over a real three-node group.
 *
 * Acceptance criteria covered:
 *   AC-C25  a scale-down from three voters to none removes one follower, keeps the
 *           leader, and leaves the cluster at two voters
 *   AC-C26  the next scale-down is clamped at the quorum floor and removes nothing
 *   AC-C27  a policy floor above the observed size is named as the clamp, and the
 *           executor does not grow a group it was asked to shrink
 *
 * Why this file exists
 * --------------------
 * `P3-56`. The four assemblers in `@agentix-e/db-cluster/assemblers` are pure
 * decisions over a member set, and they have been tested against
 * `InMemoryClusterTopology` — which is the reference implementation of the port
 * and also written by the same hand as the executor. Nothing in this package had
 * ever driven a real topology, so the first adapter written against `IMemberSet`
 * was going to be the first thing to test the port itself: whether "the members"
 * can be read from a real cluster, and whether "remove a member" can be a real
 * configuration change whose refusal is a value rather than a thrown string.
 *
 * That is what the adapter below is. It reads the *committed* configuration from
 * the live leader — not the peer list a process was started with, which is a
 * different thing and disagrees with the configuration the moment a node has been
 * added or removed — and it removes a member by asking the leader to append a
 * configuration entry. Every assertion after it is about what the *processes*
 * answer, because a scale-down that only the executor believes in is exactly the
 * failure this port exists to prevent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ScaleAction } from '@agentix-e/db-node/autoscaler';
import {
  ClusterMembershipError,
  ClusterScalingExecutor,
  type ClusterMember,
  type ClusterRole,
  type IMemberSet,
} from '@agentix-e/db-cluster/assemblers';
import {
  type ChildNode,
  type ClusterNodeSpec,
  type MembershipReport,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnRaftNode,
  waitUntil,
} from '../harness/support';

const VOTERS = 3;

const nodes = new Map<number, ChildNode>();
const dirs: string[] = [];
let certs: ReturnType<typeof makeCertificates>;
let baseDir = '';

/** What one process answers when asked what it is and what it believes the group is. */
interface StatusReport {
  id: number;
  isLeader: boolean;
  term: number;
  membership: MembershipReport;
  quorum: { size: number; majority: number; hasQuorum: boolean; unheardPeers: number[] } | null;
}

/**
 * `IMemberSet` over real processes.
 *
 * The two halves are deliberately asymmetric. Reading is a *snapshot of the
 * committed configuration*, taken from the leader, because a follower's report can
 * lag by one entry and a member set that lags by one entry is the drift this
 * executor was written to survive — it should not also be the drift it is fed.
 * Writing is a request, and a refusal from the consensus layer is thrown as the
 * typed error the assemblers already branch on: `unknown-member` means the plan is
 * stale and continuing is correct, anything else means the layer just pushed back.
 */
class RaftMemberSet implements IMemberSet {
  constructor(private readonly processes: ReadonlyMap<number, ChildNode>) {}

  async members(): Promise<readonly ClusterMember[]> {
    const reports = await this.report();
    // The leader's copy is the committed one. With no leader there is no
    // configuration to read that is more true than another, and guessing would
    // make a scale-down decision out of a stale follower.
    const authoritative = reports.find((report) => report.isLeader);
    const source = authoritative ?? reports[0];
    if (!source) throw new Error('no live process to read a configuration from');

    const voters = source.membership.voters;
    const learners = source.membership.learners;
    const roleOf = (id: number): ClusterRole => {
      if (id === authoritative?.id) return 'leader';
      return learners.includes(id) ? 'learner' : 'follower';
    };
    return [...voters, ...learners].map((id) => ({ id: String(id), role: roleOf(id) }));
  }

  async addNode(id: string): Promise<void> {
    // Not a limitation of the port: `addNode` takes an id, and the consensus layer
    // needs an address to dial. A member set whose ids are its own addresses can
    // answer; this one reads them from a running group, so a scale-up is outside
    // what it can honestly do. Thrown rather than approximated, because a member
    // that exists in the member set and nowhere in the cluster is the state the
    // executor's own notes call out.
    throw new ClusterMembershipError(
      'unsupported',
      `this member set reads a fixed group; it has no address to dial for ${id}`,
    );
  }

  async removeNode(id: string): Promise<void> {
    const reports = await this.report();
    const leader = reports.find((report) => report.isLeader);
    if (!leader) {
      throw new ClusterMembershipError('unsupported', `no live leader to append the removal of ${id}`);
    }
    const process = this.processes.get(leader.id);
    if (!process || process.exited) {
      throw new ClusterMembershipError('unsupported', `node ${leader.id} claims leadership and does not answer`);
    }
    const reply = await process.change('remove', Number(id));
    if (!reply.result.changed) {
      // Named, not summarised: 'no-quorum' and 'rejected' are different facts, and
      // an operator reading the skipped list is entitled to the one that happened.
      throw new ClusterMembershipError(
        'unsupported',
        `the consensus layer refused to remove ${id}: ${reply.result.reason ?? 'no reason given'}`,
      );
    }
  }

  /** Every live process's answer, or nothing for a process that stopped answering. */
  private async report(): Promise<StatusReport[]> {
    const live = [...this.processes.entries()].filter(([, process]) => !process.exited);
    const reports = await Promise.all(live.map(([, process]) => process.status<StatusReport>().catch(() => null)));
    return reports.filter((report): report is StatusReport => report !== null);
  }
}

function specFor(id: number, port: number, peers: ClusterNodeSpec['peers']): ClusterNodeSpec {
  return {
    id,
    host: '127.0.0.1',
    port,
    dataDir: join(baseDir, `node-${id}`),
    cert: certs.nodes[id - 1]!,
    peers,
    electionTick: 10,
    heartbeatTick: 3,
  };
}

const running = (): ChildNode[] => [...nodes.values()].filter((node) => !node.exited);

async function statusOf(node: ChildNode): Promise<StatusReport> {
  return node.status<StatusReport>();
}

async function leaderAmong(candidates: ChildNode[], timeoutMs = 30_000): Promise<ChildNode> {
  return waitUntil(
    async () => {
      for (const node of candidates) {
        if (node.exited) continue;
        try {
          if ((await statusOf(node)).isLeader) return node;
        } catch {
          // A node in an election answers nothing for a moment; the next poll asks again.
        }
      }
      return undefined;
    },
    timeoutMs,
    `one live leader among nodes ${candidates.map((node) => node.label).join(',')}`,
    250,
  );
}

/** Wait until every live member reports the same committed voter set. */
async function votersEverywhere(
  leader: ChildNode,
  predicate: (voters: number[]) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<number[]> {
  return waitUntil(
    async () => {
      const named = new Set([...(await leader.membership()).voters, ...(await leader.membership()).learners]);
      const live = running().filter((node) => named.has(idOf(node)));
      const reports = await Promise.all(live.map((node) => node.membership().catch(() => null)));
      if (reports.length === 0 || reports.some((report) => report === null)) return undefined;
      const voters = reports[0]!.voters;
      const unanimous = reports.every((report) => report!.voters.join(',') === voters.join(','));
      return unanimous && predicate(voters) ? voters : undefined;
    },
    timeoutMs,
    label,
    250,
  );
}

function idOf(node: ChildNode): number {
  for (const [id, candidate] of nodes) if (candidate === node) return id;
  return -1;
}

/** The action a scaler emits when it wants the group smaller, regardless of by how much. */
function scaleDown(targetCount: number): ScaleAction {
  return {
    action: 'scale_down',
    amount: VOTERS - targetCount,
    reason: 'acceptance: the group is larger than the policy needs',
    triggeredBy: ['acceptance'],
    targetCount,
    timestamp: Date.now(),
    policy: 'acceptance',
  };
}

beforeAll(async () => {
  certs = makeCertificates(VOTERS);
  const ports = await getFreePorts(VOTERS);
  baseDir = makeTempDir('cluster-scaling');
  dirs.push(baseDir);

  const specs: ClusterNodeSpec[] = Array.from({ length: VOTERS }, (_, index) => specFor(index + 1, ports[index]!, []));
  for (const spec of specs) {
    spec.peers = specs
      .filter((peer) => peer.id !== spec.id)
      .map((peer) => ({ id: peer.id, host: peer.host, port: peer.port }));
  }
  for (const spec of specs) {
    const node = spawnRaftNode(spec);
    nodes.set(spec.id, node);
    await node.waitForType('ready', 60_000);
  }

  const leader = await leaderAmong(running());
  await votersEverywhere(leader, (voters) => voters.length === VOTERS, 'three voters agreed');
}, 180_000);

afterAll(async () => {
  await Promise.all([...nodes.values()].map((node) => (node.exited ? undefined : node.terminate())));
  for (const dir of dirs) removeTempDir(dir);
});

describe('scale-down over a real three-voter group (real processes, mTLS)', () => {
  it('AC-C25: the member set is the committed configuration, and a scale-down to one stops at two', async () => {
    const leader = await leaderAmong(running());
    const leaderId = String(idOf(leader));
    const adapter = new RaftMemberSet(nodes);

    // The port's first question, answered by the cluster rather than by a fixture:
    // who is in the group, and which one of them is leading.
    const members = await adapter.members();
    expect([...members].map((member) => member.id).sort()).toEqual(['1', '2', '3']);
    expect(members.filter((member) => member.role === 'leader').map((member) => member.id)).toEqual([leaderId]);
    expect(members.filter((member) => member.role === 'follower')).toHaveLength(VOTERS - 1);

    const executor = new ClusterScalingExecutor({ topology: adapter, minNodes: 1, maxNodes: 5 });
    const outcome = await executor.apply(scaleDown(1));

    // Three voters, so the quorum floor is two. The request said one, and the
    // answer says two — the arithmetic, not a policy the operator set.
    expect(outcome.observedCount).toBe(VOTERS);
    expect(outcome.targetCount).toBe(2);
    expect(outcome.clampedBy).toBe('quorum-floor');
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.note).toContain('stopped at the quorum floor of 2 voter(s)');
    // The leader decides which follower leaves; it never decides that it leaves.
    expect(outcome.applied).not.toContain(leaderId);
    expect(outcome.skipped).toEqual([]);

    // And the removal was a configuration change, not a line in a report.
    const voters = await votersEverywhere(leader, (set) => set.length === 2, 'two voters agreed');
    expect(voters).not.toContain(Number(outcome.applied[0]));
    expect(voters).toContain(Number(leaderId));
  }, 180_000);

  it('AC-C26: the next scale-down is clamped at the quorum floor and removes nothing', async () => {
    const leader = await leaderAmong(running());
    const adapter = new RaftMemberSet(nodes);
    const executor = new ClusterScalingExecutor({ topology: adapter, minNodes: 1, maxNodes: 5 });

    const before = await adapter.members();
    expect(before).toHaveLength(2);

    const outcome = await executor.apply(scaleDown(1));

    // Two voters, and a majority of two is two: there is no removal this group can
    // afford. The floor is the same number as the current size, which is why the
    // outcome is "nothing changed" rather than "changed by zero".
    expect(outcome.observedCount).toBe(2);
    expect(outcome.targetCount).toBe(2);
    expect(outcome.direction).toBe('none');
    expect(outcome.applied).toEqual([]);
    expect(outcome.clampedBy).toBe('quorum-floor');

    // The cluster is untouched, and it can still commit: a group of two that lost
    // one would be a group that cannot.
    expect((await votersEverywhere(leader, (set) => set.length === 2, 'still two voters')).length).toBe(2);
    const health = (await statusOf(leader)).quorum;
    expect(health?.size).toBe(2);
    expect(health?.majority).toBe(2);
    expect(health?.hasQuorum).toBe(true);
  }, 120_000);

  it('AC-C27: a policy floor above the observed size is the clamp that is named, and nothing grows', async () => {
    const adapter = new RaftMemberSet(nodes);
    // The operator's floor is three; the group is two. A scale-down cannot mend
    // that, and an executor that quietly scaled up would be answering a question
    // nobody asked — under a policy that says "never fewer than three".
    const executor = new ClusterScalingExecutor({ topology: adapter, minNodes: 3, maxNodes: 5 });

    const outcome = await executor.apply(scaleDown(1));
    expect(outcome.clampedBy).toBe('policy-min');
    expect(outcome.applied).toEqual([]);
    expect(outcome.note).toContain('stopped at the policy floor of 3');
    expect(outcome.targetCount).toBe(2);

    // Still two, which is the honest report: the executor shrank nothing and grew
    // nothing, and the difference between the policy and the group is the
    // operator's to resolve.
    expect([...(await adapter.members())]).toHaveLength(2);
  }, 120_000);
});
