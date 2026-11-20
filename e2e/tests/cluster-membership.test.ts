/**
 * E2E — membership change in a five-voter cluster, over mTLS, in real processes.
 *
 * Acceptance criteria covered:
 *   AC-C10  a learner is added and promoted, and every member adopts the larger voter set
 *   AC-C11  a promotion commits while a voter is unreachable, and the survivors adopt it
 *   AC-C12  a change attempted without a quorum is refused by name, in milliseconds,
 *           and leaves every member's configuration untouched
 *   AC-C13  after one node is restarted the cluster forms a quorum again and commits
 *           a further change — a refusal is not a wedge
 *
 * Why this file exists
 * --------------------
 * `P3-28` was registered from reading `submitConfigChange`: raft-core appends a
 * *single-step* configuration, so the new voter set is in force for the commit
 * that admits it. The roadmap said that makes a membership change impossible
 * while a voter is missing — a five-second commit timeout, then `rejected`, with
 * the entry already in the in-memory active configuration. That is a claim about
 * arithmetic and about five processes, and neither can be settled by reading.
 *
 * So it is measured. Every assertion below is about what the *members* answer,
 * over real TLS sockets, after real signals: the leader's own view is the one
 * place a half-committed configuration still looks fine. A node that is running
 * but not named in the committed configuration is a stranger — the joiners start
 * that way — and its opinion is not part of any agreement asserted here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
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

const VOTERS = 5;
/**
 * Two spare identities: one is promoted with every voter up, the other with a
 * voter down. Both are started the way an operator starts a node — own TLS
 * identity, own disk, nobody's peer list — and are strangers until the leader
 * appends a configuration that names them.
 */
const JOINERS = 2;

const dirs: string[] = [];
const nodes = new Map<number, ChildNode>();
let certs: ReturnType<typeof makeCertificates>;
let specs: ClusterNodeSpec[] = [];
let baseDir = '';

interface StatusReport {
  id: number;
  isLeader: boolean;
  term: number;
  membership?: MembershipReport;
  quorum?: { size: number; majority: number; hasQuorum: boolean; unheardPeers: number[] } | null;
}

const running = (): ChildNode[] => [...nodes.values()].filter((n) => !n.exited);

function idOf(node: ChildNode): number {
  for (const [id, candidate] of nodes) if (candidate === node) return id;
  return -1;
}

async function statusOf(node: ChildNode): Promise<StatusReport> {
  return node.status<StatusReport>();
}

/** The live node that currently claims leadership — asked of every process, not assumed. */
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
    `one live leader among nodes ${candidates.map((n) => n.label).join(',')}`,
    250,
  );
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

async function startNode(spec: ClusterNodeSpec, timeoutMs = 60_000): Promise<ChildNode> {
  const node = spawnRaftNode(spec);
  nodes.set(spec.id, node);
  await node.waitForType('ready', timeoutMs);
  return node;
}

/**
 * The members according to the leader, limited to processes that are still alive.
 *
 * "Every node agrees" is only a claim about nodes the configuration names. A
 * joiner that has not been added yet is in nobody's configuration and answers
 * with its own bootstrap set; counting it would turn a correct cluster into a
 * disagreement, which is exactly what the first run of this file did.
 */
async function members(leader: ChildNode): Promise<ChildNode[]> {
  const report = await leader.membership();
  const named = new Set([...report.voters, ...report.learners]);
  return running().filter((node) => named.has(idOf(node)));
}

/** Wait until every member reports the same voter set, and return it. */
async function votersEverywhere(
  leader: ChildNode,
  predicate: (voters: number[]) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<number[]> {
  return waitUntil(
    async () => {
      const live = await members(leader);
      if (live.length === 0) return undefined;
      const reports = await Promise.all(live.map((node) => node.membership().catch(() => null)));
      const valid = reports.filter((r): r is MembershipReport => r !== null);
      if (valid.length !== live.length) return undefined;
      const voters = valid[0]!.voters;
      const unanimous = valid.every((r) => r.voters.join(',') === voters.join(','));
      return unanimous && predicate(voters) ? voters : undefined;
    },
    timeoutMs,
    label,
    250,
  );
}

beforeAll(async () => {
  certs = makeCertificates(VOTERS + JOINERS);
  const ports = await getFreePorts(VOTERS + JOINERS);
  baseDir = makeTempDir('cluster-membership');
  dirs.push(baseDir);

  specs = Array.from({ length: VOTERS }, (_, i) => specFor(i + 1, ports[i]!, []));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }

  for (const spec of specs) await startNode(spec);

  // The joiners are started with no peers at all. Giving them the cluster's peer
  // list would make each of them a *voter* in its own bootstrap configuration, and
  // a node that believes it votes campaigns against a cluster that has never heard
  // of it; with an empty list it is a lone node that appends nothing anywhere and
  // waits to be told what it is.
  for (let i = 0; i < JOINERS; i++) {
    const id = VOTERS + 1 + i;
    specs.push(specFor(id, ports[VOTERS + i]!, []));
    await startNode(specs[specs.length - 1]!);
  }
}, 180_000);

afterAll(async () => {
  await Promise.all([...nodes.values()].map((n) => (n.exited ? undefined : n.terminate())));
  for (const dir of dirs) removeTempDir(dir);
});

describe('membership change in a five-voter cluster (real processes, mTLS)', () => {
  it('AC-C10: a learner is added, promoted, and every member adopts the larger voter set', async () => {
    const leader = await leaderAmong(running());
    const before = await leader.membership();
    expect(before.voters).toEqual([1, 2, 3, 4, 5]);
    expect(before.learners).toEqual([]);

    const joinerSpec = specs.find((s) => s.id === 6)!;
    const added = await leader.change('add', 6, { address: `127.0.0.1:${joinerSpec.port}`, asLearner: true });
    expect(added.result).toEqual({ changed: true });

    // A learner is a member only when every process says so: a configuration entry
    // that reached the leader alone would still leave it reporting one.
    await votersEverywhere(leader, (voters) => voters.length === 5, 'five voters agreed after the join');
    for (const report of await Promise.all((await members(leader)).map((n) => n.membership()))) {
      expect(report.learners).toEqual([6]);
    }

    const promoted = await leader.change('promote', 6);
    expect(promoted.result).toEqual({ changed: true });
    // The promotion is a commit, not a timeout: raft-core's commit budget is five
    // seconds, so anything near it would mean the answer came from the deadline.
    expect(promoted.elapsedMs).toBeLessThan(4_000);

    const voters = await votersEverywhere(leader, (set) => set.length === 6 && set.includes(6), 'six voters agreed');
    expect(voters).toEqual([1, 2, 3, 4, 5, 6]);

    // The majority moved with the voter set. A leader still counting three would
    // claim a quorum raft cannot commit with.
    const health = await statusOf(leader);
    expect(health.quorum?.size).toBe(6);
    expect(health.quorum?.majority).toBe(4);

    // The newcomer holds the configuration, not just the name: a voter that cannot
    // answer is a voter that breaks the next commit.
    expect((await statusOf(nodes.get(6)!)).membership?.voters).toEqual([1, 2, 3, 4, 5, 6]);
  }, 120_000);

  it('AC-C11: a promotion commits while a voter is unreachable, and the survivors adopt it', async () => {
    // A second learner joins while every voter is still alive, so the next step is
    // about the *promotion* and nothing else.
    const leader = await leaderAmong(running());
    const secondSpec = specs.find((s) => s.id === 7)!;
    const added = await leader.change('add', 7, { address: `127.0.0.1:${secondSpec.port}`, asLearner: true });
    expect(added.result).toEqual({ changed: true });
    await votersEverywhere(leader, (voters) => voters.length === 6, 'six voters agreed before the crash');

    // One voter dies and stays dead. The leader must notice — otherwise the next
    // assertion would be about a cluster that still believes it has six live peers.
    const casualtyId = 5;
    const casualty = nodes.get(casualtyId)!;
    casualty.kill();
    await casualty.waitForExit(10_000);

    await waitUntil(
      async () => {
        const health = (await statusOf(leader).catch(() => null))?.quorum;
        return health && health.unheardPeers.includes(casualtyId) ? health : undefined;
      },
      30_000,
      'the leader naming the crashed voter as unheard',
      250,
    );

    // The arithmetic, not the prose. Six voters with one dead: the configuration
    // that admits the seventh needs four acknowledgements, and the five live voters
    // are five — so it commits. `P3-28` predicted a five-second timeout here.
    const promoted = await leader.change('promote', 7);
    expect(promoted.result).toEqual({ changed: true });
    expect(promoted.elapsedMs).toBeLessThan(4_000);

    const voters = await votersEverywhere(
      leader,
      (set) => set.length === 7 && set.includes(7),
      'seven voters agreed with node 5 dead',
    );
    expect(voters).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Measured after the message, not before: the survivors are the ones that
    // still answer, and node 5 is not among them.
    expect((await members(leader)).map(idOf).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7]);
  }, 180_000);

  it('AC-C12: a change attempted without a quorum is refused by name, and writes nothing', async () => {
    // From six live voters to three: kill three more, leaving 1, 2 and 6. Four of
    // seven is a majority, so three survivors are one short of one.
    for (const id of [3, 4, 7]) {
      const node = nodes.get(id)!;
      node.kill();
      await node.waitForExit(10_000);
    }
    const survivors = running();
    const leader = await leaderAmong(survivors);

    const healthBefore = (await statusOf(leader)).quorum;
    // The leader still answers, so it is still a leader — raft-core keeps reporting
    // one — and that is exactly the state a membership change has to refuse.
    expect(healthBefore?.size).toBe(7);
    expect(healthBefore?.majority).toBe(4);

    await waitUntil(
      async () => {
        const health = (await statusOf(leader).catch(() => null))?.quorum;
        return health && health.hasQuorum === false ? health : undefined;
      },
      30_000,
      'the leader admitting it has no quorum',
      250,
    );

    const refused = await leader.change('remove', 5);
    expect(refused.result).toEqual({ changed: false, reason: 'no-quorum' });
    // Named, not timed out: the answer arrives in the time it takes to read the
    // watchdog, not in the five seconds raft-core would spend waiting for a commit.
    expect(refused.elapsedMs).toBeLessThan(1_000);

    // And nothing was written. The configuration is the persisted one, on every
    // survivor, and it still names the three dead nodes.
    expect(survivors.map(idOf).sort((a, b) => a - b)).toEqual([1, 2, 6]);
    for (const report of await Promise.all(survivors.map((n) => n.membership()))) {
      expect(report.voters).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(report.source).toBe('persisted');
    }
  }, 180_000);

  it('AC-C13: a restarted node restores the quorum, and the cluster commits another change', async () => {
    // Same identity, same disk: the restarted process reads the configuration it
    // committed rather than the peer list it was started with.
    const restarted = await startNode(specs.find((s) => s.id === 3)!);
    expect((await statusOf(restarted)).membership?.voters).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const leader = await leaderAmong(running());
    await waitUntil(
      async () => {
        const health = (await statusOf(leader).catch(() => null))?.quorum;
        return health?.hasQuorum === true ? health : undefined;
      },
      30_000,
      'the leader hearing a majority again',
      250,
    );

    // A refusal is not a wedge: the cluster that refused the change still accepts
    // one, with the voters that are actually answering.
    const removed = await leader.change('remove', 5);
    expect(removed.result).toEqual({ changed: true });

    const voters = await votersEverywhere(
      leader,
      (set) => set.length === 6 && !set.includes(5),
      'six voters agreed after the removal',
    );
    expect(voters).toEqual([1, 2, 3, 4, 6, 7]);

    // The surviving majority is what the leader now counts, so a proposal still
    // commits with three of the four survivors.
    await waitUntil(
      async () => {
        const status = await statusOf(leader).catch(() => null);
        return status?.isLeader && status.quorum?.hasQuorum ? status : undefined;
      },
      30_000,
      'the leader reporting itself quorate after the removal',
      250,
    );
    const answer = await leader.propose('post-membership');
    expect(answer).toMatchObject({ ok: true });
  }, 180_000);

  it('AC-C14: a proposal sent to a follower is refused by name, and does not hang', async () => {
    const leader = await leaderAmong(running());
    const follower = running().find((node) => node !== leader)!;

    // raft-core refuses a proposal anywhere but the leader, and the adapter passes
    // that answer up instead of waiting for a commit that can never happen. The
    // harness has to surface it for the same reason: a caller that waits on
    // `proposed` alone turns "this is not the leader" into a twenty-second timeout.
    const answer = await follower.propose('sent-to-the-wrong-node');
    expect(answer).toEqual({ ok: false, error: 'not leader' });

    // And the cluster is unharmed: the leader still commits.
    expect(await leader.propose('after-a-refused-proposal')).toMatchObject({ ok: true });
  }, 120_000);
});
