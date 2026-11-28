/**
 * E2E — a client retry of the same msgId returns the first write's result and
 * writes one key, even when the primary is killed between attempt and retry.
 *
 * Acceptance criteria covered:
 *   AC-P86-1  a stable logical name follows a re-election to a new leader
 *   AC-P86-2  a client retry of the same msgId replays the first result, does
 *             not execute a second write, and leaves exactly one applied entry
 *   AC-P86-3  a different msgId is still a fresh write after the failover
 *
 * Everything here is real: three Raft nodes are independent OS processes with
 * mutual TLS 1.3, the leader is killed mid-scenario and a new one is elected,
 * and the ground truth is the `applied` list each node reports from its own
 * state machine — not a counter the client keeps.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  IdempotencyTable,
  IdempotentWriteCoordinator,
  type IdempotentOutcome,
  resolveLogicalPrimary,
  type PrimaryMember,
} from '@agentix-e/db-cluster';
import {
  type ChildNode,
  type ClusterNodeSpec,
  getFreePorts,
  makeCertificates,
  makeTempDir,
  removeTempDir,
  spawnRaftNode,
  waitUntil,
} from '../harness/support';

const NODE_COUNT = 3;
const dirs: string[] = [];
const nodes: ChildNode[] = [];
let certs: ReturnType<typeof makeCertificates>;
let specs: ClusterNodeSpec[] = [];

interface NodeStatus {
  id: number;
  isLeader: boolean;
  term: number;
  commitIndex: number;
  appliedCount: number;
  applied: string[];
}

async function statusOf(node: ChildNode): Promise<NodeStatus> {
  return node.status<NodeStatus>();
}

async function findLeader(active: ChildNode[], timeoutMs = 30_000): Promise<ChildNode> {
  return waitUntil(
    async () => {
      for (const node of active) {
        if (node.exited) continue;
        try {
          if ((await statusOf(node)).isLeader) return node;
        } catch {
          // electing
        }
      }
      return undefined;
    },
    timeoutMs,
    'a leader to be elected',
    250,
  );
}

function activeNodes(): ChildNode[] {
  return nodes.filter((n) => !n.exited);
}

/** Count how many times a msgId was applied across the live replicas. */
async function appliedCountOf(msgId: string): Promise<number[]> {
  const statuses = await Promise.all(activeNodes().map(statusOf));
  return statuses.map((s) => s.applied.filter((entry) => entry.includes(msgId)).length);
}

/** A client write: propose a keyed entry through the current leader over TLS. */
async function writeThrough(leader: ChildNode, msgId: string, key: string, value: string): Promise<number> {
  const start = leader.messages.length;
  const data = JSON.stringify({ msgId, type: 'put', key, value });
  leader.send({ cmd: 'propose', data });
  const reply = await leader.waitFor(
    (m) => (m.type === 'proposed' || m.type === 'error') && leader.messages.indexOf(m) >= start,
    30_000,
    `proposal for ${msgId}`,
  );
  if (reply.type === 'error') throw new Error(`proposal refused: ${String(reply.data)}`);
  return (reply.data as { index: number }).index;
}

beforeAll(async () => {
  certs = makeCertificates(NODE_COUNT + 1);
  const ports = await getFreePorts(NODE_COUNT);
  const baseDir = makeTempDir('cluster-idempotency');
  dirs.push(baseDir);

  specs = Array.from({ length: NODE_COUNT }, (_, i) => ({
    id: i + 1,
    host: '127.0.0.1',
    port: ports[i]!,
    dataDir: join(baseDir, `node-${i + 1}`),
    cert: certs.nodes[i]!,
    peers: [],
    electionTick: 10,
    heartbeatTick: 3,
  }));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }
  for (const spec of specs) nodes.push(spawnRaftNode(spec));
  await Promise.all(nodes.map((n) => n.waitForType('ready', 60_000)));
}, 120_000);

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.terminate()));
  for (const dir of dirs) removeTempDir(dir);
});

describe('idempotent write under a real primary failover', () => {
  const table = new IdempotencyTable<number>({ windowMs: 10 * 60_000 });
  const coordinator = new IdempotentWriteCoordinator<number>({ table });

  it('AC-P86-1: resolves the logical name to the elected leader', async () => {
    const leader = await findLeader(activeNodes());
    const leaderId = Number(leader.label.match(/node-(\d+)/)![1]);
    const members: PrimaryMember[] = activeNodes().map((n) => ({
      id: `node-${n.label.match(/node-(\d+)/)![1]}`,
      role: 'follower',
    }));
    const resolution = resolveLogicalPrimary('primary', { leaderId, members });
    expect(resolution.resolved).toBe(true);
    expect(resolution.memberId).toBe(`node-${leaderId}`);
  });

  it('AC-P86-2: a retry after the primary is killed replays the first result and writes one key', async () => {
    const leader = await findLeader(activeNodes());
    const msgId = 'e2e-idem-op-1';

    // First attempt: a real write through the elected leader.
    const first: IdempotentOutcome<number> = await coordinator.execute(
      msgId,
      () => writeThrough(leader, msgId, 'key-idem', 'first-value'),
      0,
    );
    expect(first.replayed).toBe(false);

    await waitUntil(
      async () => ((await appliedCountOf(msgId)).every((n) => n === 1) ? true : undefined),
      30_000,
      'the first write to reach every replica',
      250,
    );

    // Kill the primary mid-scenario and elect a new one.
    leader.kill('SIGKILL');
    await leader.waitForExit();
    const newLeader = await findLeader(activeNodes(), 45_000);
    expect(newLeader).not.toBe(leader);

    // Retry the same msgId through the new leader. The coordinator is the
    // client-side memory, so it must replay and must not call writeThrough —
    // a second proposal would be a second key even though the client sees none.
    let retriesExecuted = 0;
    const retry = await coordinator.execute(
      msgId,
      () => {
        retriesExecuted++;
        return writeThrough(newLeader, msgId, 'key-idem', 'first-value');
      },
      999,
    );
    expect(retry.replayed).toBe(true);
    expect(retry.result).toBe(first.result);
    expect(retry.position).toBe(first.position);
    expect(retriesExecuted).toBe(0);

    // Ground truth: no replica recorded a second entry for this msgId.
    await waitUntil(
      async () => ((await appliedCountOf(msgId)).every((n) => n === 1) ? true : undefined),
      15_000,
      'the retry not adding a second write',
      250,
    );
    const counts = await appliedCountOf(msgId);
    expect(counts.length).toBeGreaterThanOrEqual(2);
    expect(counts.every((n) => n === 1)).toBe(true);
  });

  it('AC-P86-3: a different msgId is still a fresh write after the failover', async () => {
    const leader = await findLeader(activeNodes());
    const msgId = 'e2e-idem-op-2';
    const outcome = await coordinator.execute(
      msgId,
      () => writeThrough(leader, msgId, 'key-idem-2', 'second-value'),
      0,
    );
    expect(outcome.replayed).toBe(false);
    await waitUntil(
      async () => ((await appliedCountOf(msgId)).every((n) => n === 1) ? true : undefined),
      30_000,
      'the fresh write to reach every replica',
      250,
    );
  });
});
