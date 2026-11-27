/**
 * E2E — a stale fencing token is refused by the resource, not by a flag.
 *
 * Acceptance criteria covered:
 *   AC-F22-1  a real quorum mints a token the resource accepts
 *   AC-F22-2  a node without a quorum cannot advance the log, so it cannot mint a
 *             newer token
 *   AC-F22-3  after a new election the old primary's token is refused by the file
 *   AC-F22-4  the resource still refuses it after being restarted
 *
 * The defect these cover: `fencingRequest()` used to answer from `isInMajority()`,
 * a belief assembled from the messages a node happened to receive. A partitioned
 * primary that still hears one peer answers "yes" and keeps writing, and nothing
 * inside the cluster can settle that argument. The resource can: it remembers the
 * highest position it has already accepted and refuses anything below it.
 *
 * Everything here is real. Three Raft nodes and the store are independent OS
 * processes; the token is minted from the term and committed index the elected
 * leader reports; the writers speak mutual TLS 1.3; and the ground truth is the
 * file on disk, which this test reads itself rather than asking the store what it
 * believes it wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareFencingTokens, formatFencingToken, mintFencingToken, type FencingToken } from '@agentix-e/db-cluster';
import {
  type ChildNode,
  type ClusterNodeSpec,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnFenceWriter,
  spawnFencedStore,
  spawnRaftNode,
  waitUntil,
} from '../harness/support';

const NODE_COUNT = 3;

interface NodeStatus {
  id: number;
  isLeader: boolean;
  term: number;
  commitIndex: number;
  applied: string[];
}

interface StoreState {
  accepted: number;
  refused: number;
  protocol: string | null;
  highest: string | null;
  recovered: string | null;
  records: Array<{ token: string; key: string; value: string }>;
}

interface StoreReply {
  id: number | null;
  admitted: boolean;
  reason?: string;
  detail?: string;
  highest: string | null;
}

const live = new Map<number, ChildNode>();
const specs: ClusterNodeSpec[] = [];
const dirs: string[] = [];
const writers: ChildNode[] = [];
let certs: ReturnType<typeof makeCertificates>;
let store: ChildNode;
let storePort = 0;
let storeDataFile = '';
let oldToken: FencingToken;
let newToken: FencingToken;

function activeNodes(): ChildNode[] {
  return [...live.values()].filter((node) => !node.exited);
}

function idOf(node: ChildNode): number {
  return Number(node.label.match(/node-(\d+)/)![1]);
}

/** A leader that can actually commit — a stale one still believes it is leader. */
async function findCommittingLeader(timeoutMs = 60_000): Promise<ChildNode> {
  return waitUntil(
    async () => {
      for (const node of activeNodes()) {
        try {
          const status = await node.status<NodeStatus>(5_000);
          if (!status.isLeader) continue;
          const probe = await node.propose('fence-probe', 8_000);
          if (probe.ok) return node;
        } catch {
          // busy electing, or this proposal never committed — try the next node
        }
      }
      return undefined;
    },
    timeoutMs,
    'a leader that can commit',
    500,
  );
}

/** The token `RaftGroup.fencingRequest()` mints: the quorum's position, once. */
async function mintFromQuorum(node: ChildNode): Promise<FencingToken> {
  const status = await node.status<NodeStatus>();
  return mintFencingToken(status.term, status.commitIndex);
}

async function startStore(port: number): Promise<ChildNode> {
  const child = spawnFencedStore(
    { port, dataFile: storeDataFile, cert: certs.nodes[NODE_COUNT]!, requireToken: true },
    `store@${port}`,
  );
  const ready = await child.waitForType('ready', 30_000);
  storePort = (ready.data as { port: number }).port;
  return child;
}

function spawnWriter(certIndex: number, label: string): ChildNode {
  const writer = spawnFenceWriter(
    {
      host: '127.0.0.1',
      port: storePort,
      // The store holds cert `NODE_COUNT`; a writer must verify that identity, not
      // merely trust the CA.
      servername: `raft-node-${NODE_COUNT + 1}`,
      cert: certs.nodes[certIndex]!,
    },
    label,
  );
  writers.push(writer);
  return writer;
}

async function write(writer: ChildNode, token: FencingToken, key: string, value: string): Promise<StoreReply> {
  return writer.request<StoreReply>('write', { id: Date.now(), token: formatFencingToken(token), key, value }, 'reply');
}

/** What the store's file actually contains — read from disk, not reported by anyone. */
function fileRecords(): Array<{ token: string; key: string; value: string }> {
  return readFileSync(storeDataFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { token: string; key: string; value: string });
}

beforeAll(async () => {
  certs = makeCertificates(NODE_COUNT + 1); // +1: the store's own identity
  const ports = await getFreePorts(NODE_COUNT + 1);
  const baseDir = makeTempDir('cluster-fencing');
  dirs.push(baseDir);
  storeDataFile = join(baseDir, 'store.jsonl');

  for (let i = 0; i < NODE_COUNT; i++) {
    specs.push({
      id: i + 1,
      host: '127.0.0.1',
      port: ports[i]!,
      dataDir: join(baseDir, `node-${i + 1}`),
      cert: certs.nodes[i]!,
      peers: [],
      electionTick: 10,
      heartbeatTick: 3,
    });
  }
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }

  for (const spec of specs) live.set(spec.id, spawnRaftNode(spec));
  await Promise.all([...live.values()].map((node) => node.waitForType('ready', 60_000)));

  store = await startStore(ports[NODE_COUNT]!);
}, 180_000);

afterAll(async () => {
  await Promise.all(writers.map((writer) => writer.terminate()));
  if (store && !store.exited) await store.terminate();
  await Promise.all([...live.values()].map((node) => node.terminate()));
  for (const dir of dirs) removeTempDir(dir);
});

describe('Fencing tokens — the resource refuses the old primary', () => {
  it('AC-F22-1: a real quorum mints a token the resource accepts', async () => {
    const leader = await findCommittingLeader();
    oldToken = await mintFromQuorum(leader);

    const writer = spawnWriter(0, 'old-primary');
    await writer.waitForType('ready', 30_000);
    const reply = await write(writer, oldToken, 'account/1', 'balance=100');

    expect(reply.admitted).toBe(true);
    expect(reply.highest).toBe(formatFencingToken(oldToken));
    expect(fileRecords()).toEqual([{ token: formatFencingToken(oldToken), key: 'account/1', value: 'balance=100' }]);

    const state = await store.request<StoreState>('state', {}, 'state');
    // The socket the write crossed was mutual TLS 1.3, not a loopback convenience.
    expect(state.protocol).toBe('TLSv1.3');
    // Nothing to recover: this store started on an empty file.
    expect(state.recovered).toBeNull();
  }, 150_000);

  it('AC-F22-5: the cluster stamps a token on the hot path and replicates it to every node', async () => {
    // The gated path mints the position from the leader's own term and commit
    // index using the published stamping function — the same one RaftGroup.propose
    // calls. The token therefore has to survive real Raft replication to reach
    // every node's application callback, which is where an engine admits the write.
    const leader = await findCommittingLeader();
    const key = `gated/${Date.now()}`;
    const answer = await leader.proposeGated(key, 'authorised-by-quorum');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.token).toMatch(/^\d+\/\d+$/);

    const { term, commitIndex } = await leader.status<NodeStatus>();
    // The stamp is the quorum position at proposal time: the commit index read
    // before this entry committed, so the token's index is at most the post-commit
    // index and its term is the leader's current one.
    const [stampedTerm, stampedIndex] = answer.token.split('/').map(Number);
    expect(stampedTerm).toBe(term);
    expect(stampedIndex).toBeLessThanOrEqual(commitIndex + 1);

    // Every live node has to have applied the entry with the same token. A token
    // that only the leader saw would be a return-value fiction, not a replicated
    // fact an engine on a follower could use. Replication to followers is
    // asynchronous, so wait for the state rather than sampling it once.
    type FencedStatus = NodeStatus & { fencedApplied: Array<{ token: string; key: string }> };
    const replicated = await waitUntil(
      async () => {
        const statuses = await Promise.all(activeNodes().map((node) => node.status<FencedStatus>()));
        const complete = statuses.every((status) =>
          status.fencedApplied.some((entry) => entry.key === key && entry.token === answer.token),
        );
        return complete ? statuses : undefined;
      },
      60_000,
      'the stamped entry replicated to every node',
      500,
    );
    for (const status of replicated) {
      const record = status.fencedApplied.find((entry) => entry.key === key);
      expect(record!.token).toBe(answer.token);
    }
  }, 180_000);

  it('AC-F22-6: a proposal carrying a token below the group position is refused', async () => {
    const leader = await findCommittingLeader();
    const key = `stale/${Date.now()}`;
    const before = await leader.status<NodeStatus>();

    // An engine forwarding a client's old position must not be able to commit it
    // through a group that has already moved on. The product's stamping function
    // refuses it before the entry reaches the log.
    const refused = await leader.proposeGated(key, 'must-not-commit', '0/0');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/behind/i);

    const after = await leader.status<NodeStatus>();
    expect(after.commitIndex).toBe(before.commitIndex);
    const statuses = await Promise.all(
      activeNodes().map((node) => node.status<NodeStatus & { fencedApplied: Array<{ key: string }> }>()),
    );
    for (const status of statuses) {
      expect(status.fencedApplied.some((entry) => entry.key === key)).toBe(false);
    }
  }, 180_000);

  it('AC-F22-2: without a quorum the surviving node cannot advance the log', async () => {
    const leader = await findCommittingLeader();
    const casualties = [leader, activeNodes().find((node) => node !== leader)!];
    for (const casualty of casualties) {
      casualty.kill('SIGKILL');
      await casualty.waitForExit();
    }
    expect(activeNodes()).toHaveLength(1);

    const survivor = activeNodes()[0]!;
    const before = await survivor.status<NodeStatus>();

    // A proposal either comes back refused or never reaches commit. Both mean the
    // same thing for the token: no new position was published, so the old primary
    // has nothing newer to present.
    const outcome = await Promise.race([
      survivor.propose('must-not-commit', 8_000).catch((error: unknown) => ({
        ok: false as const,
        error: String(error),
      })),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'deadline' }), 8_000),
      ),
    ]);

    expect(outcome.ok).toBe(false);
    const after = await survivor.status<NodeStatus>();
    expect(after.commitIndex).toBe(before.commitIndex);
    expect(after.applied).not.toContain('must-not-commit');

    // Bring one follower back: two of three is a majority, so an election is possible
    // again — but not with the old term, which is what makes the next token newer.
    const restoredId = idOf(casualties[1]!);
    const restored = spawnRaftNode(specs[restoredId - 1]!);
    live.set(restoredId, restored);
    await restored.waitForType('ready', 60_000);
    expect(activeNodes()).toHaveLength(2);
  }, 180_000);

  it('AC-F22-3: after a new election the old primary’s token is refused by the file', async () => {
    const leader = await findCommittingLeader();
    newToken = await mintFromQuorum(leader);
    expect(compareFencingTokens(newToken, oldToken)).toBe(1);

    // The new primary writes first. Until the resource has seen a later position,
    // the old token is indistinguishable from a retry — and a retry must be
    // admitted, which is what makes at-least-once delivery safe. The refusal below
    // is about the resource having moved on, not about the token being old.
    const newPrimary = spawnWriter(1, 'new-primary');
    await newPrimary.waitForType('ready', 30_000);
    const accepted = await write(newPrimary, newToken, 'account/1', 'balance=250');
    expect(accepted.admitted).toBe(true);

    // The old primary rejoins and replays its own write. Its belief is irrelevant:
    // the token it holds is the one the file has already passed.
    const exLeaderId = [...live.keys()].find((id) => !activeNodes().some((node) => idOf(node) === id))!;
    const revived = spawnRaftNode(specs[exLeaderId - 1]!);
    live.set(exLeaderId, revived);
    await revived.waitForType('ready', 60_000);

    const refusal = await write(writers[0]!, oldToken, 'account/1', 'balance=0');

    expect(refusal.admitted).toBe(false);
    expect(refusal.reason).toBe('stale-token');
    expect(refusal.detail).toContain(formatFencingToken(oldToken));
    expect(refusal.detail).toContain(formatFencingToken(newToken));

    // The file is the ground truth, and it never took the old primary's value.
    expect(fileRecords().map((record) => record.value)).not.toContain('balance=0');
    expect(fileRecords()).toEqual([
      { token: formatFencingToken(oldToken), key: 'account/1', value: 'balance=100' },
      { token: formatFencingToken(newToken), key: 'account/1', value: 'balance=250' },
    ]);
  }, 180_000);

  it('AC-F22-4: the resource still refuses the old token after a restart', async () => {
    const before = await store.request<StoreState>('state', {}, 'state');
    expect(before.refused).toBeGreaterThanOrEqual(1);

    await store.terminate();
    store = await startStore(storePort);

    const recovered = await store.request<StoreState>('state', {}, 'state');
    // The highest token came back from the file, which is the point: a store that
    // restarted empty would re-admit the old primary during exactly the window the
    // token exists to cover.
    expect(recovered.recovered).toBe(formatFencingToken(newToken));
    expect(recovered.highest).toBe(formatFencingToken(newToken));
    expect(recovered.records).toHaveLength(2);

    const oldPrimary = spawnWriter(0, 'old-primary-after-restart');
    await oldPrimary.waitForType('ready', 30_000);
    const refusal = await write(oldPrimary, oldToken, 'account/1', 'balance=-1');

    expect(refusal.admitted).toBe(false);
    expect(refusal.reason).toBe('stale-token');
    expect(fileRecords()).toHaveLength(2);

    // The newest token still works: a retry from the current primary is not a usurper.
    const retry = await write(oldPrimary, newToken, 'account/1', 'balance=250');
    expect(retry.admitted).toBe(true);
    expect(fileRecords()).toHaveLength(3);
  }, 180_000);
});
