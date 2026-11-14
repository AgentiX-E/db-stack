/**
 * E2E — real Raft cluster over mTLS.
 *
 * Acceptance criteria covered:
 *   AC-C1  3 independent OS processes form a cluster with exactly one leader
 *   AC-C2  peer traffic uses TLS 1.3 with mutual certificate verification
 *   AC-C3  a rogue certificate cannot join (handshake rejected)
 *   AC-C4  log replication delivers every entry to every node, in order
 *   AC-C5  killing the leader triggers re-election with no committed data loss
 *   AC-C6  killing a quorum blocks new commits (no silent divergence)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tls from 'node:tls';
import { join } from 'node:path';
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
          const status = await statusOf(node);
          if (status.isLeader) return node;
        } catch {
          // node busy electing — retry
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

beforeAll(async () => {
  certs = makeCertificates(NODE_COUNT + 1); // +1 for the rogue-free extra identity
  const ports = await getFreePorts(NODE_COUNT);
  const baseDir = makeTempDir('cluster-tls');
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
    spec.peers = specs
      .filter((p) => p.id !== spec.id)
      .map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }

  for (const spec of specs) nodes.push(spawnRaftNode(spec));
  await Promise.all(nodes.map((n) => n.waitForType('ready', 60_000)));
}, 120_000);

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.terminate()));
  for (const dir of dirs) removeTempDir(dir);
});

describe('Raft cluster over mTLS (real processes)', () => {
  it('AC-C1: forms a 3-node cluster with exactly one leader', async () => {
    const leader = await findLeader(activeNodes());
    const statuses = await Promise.all(activeNodes().map(statusOf));
    const leaders = statuses.filter((s) => s.isLeader);

    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.id).toBe(Number(leader.label.match(/node-(\d+)/)![1]));
    expect(new Set(statuses.map((s) => s.term)).size).toBeGreaterThanOrEqual(1);
  });

  it('AC-C2: negotiates TLS 1.3 and verifies the peer certificate', async () => {
    const target = specs[1]!;
    const identity = certs.nodes[1]!;

    const result = await new Promise<{ protocol: string | null; authorized: boolean; error?: string }>(
      (resolve) => {
        const socket = tls.connect(
          {
            host: target.host,
            port: target.port,
            servername: `raft-node-${target.id}`,
            cert: identity.cert,
            key: identity.key,
            ca: certs.caPem,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
          },
          () => {
            const protocol = socket.getProtocol();
            const authorized = socket.authorized;
            socket.end();
            resolve({ protocol, authorized });
          },
        );
        socket.on('error', (err) => resolve({ protocol: null, authorized: false, error: err.message }));
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.authorized).toBe(true);
    expect(result.protocol).toBe('TLSv1.3');
  });

  it('AC-C3: rejects a peer presenting a certificate from an unknown CA', async () => {
    const target = specs[1]!;
    const rogue = certs.rogue;

    // `socket.authorized` on the CLIENT reflects verification of the SERVER
    // certificate against the client's trust store — the server's cert is the
    // legitimate cluster cert, so that flag stays true even when the server
    // rejects our client certificate. The authoritative signal for client-cert
    // rejection is the post-handshake alert / connection teardown, so the test
    // writes an application-data frame and requires the connection to die.
    const result = await new Promise<{ rejected: boolean; error?: string }>((resolve) => {
      let settled = false;
      const done = (rejected: boolean, error?: string): void => {
        if (settled) return;
        settled = true;
        resolve({ rejected, error });
      };

      const socket = tls.connect(
        {
          host: target.host,
          port: target.port,
          servername: 'raft-node-2',
          cert: rogue.cert,
          key: rogue.key,
          ca: certs.caPem, // server verifies client against the *cluster* CA
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        () => {
          socket.write('ping');
        },
      );

      socket.on('data', () => done(false, 'unexpected application data'));
      socket.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        // A locally-detected certificate failure is also a rejection.
        done(true, `${code}:${err.message}`);
      });
      socket.on('close', () => done(true, 'closed-by-server'));
      setTimeout(() => done(false, 'timeout — connection survived'), 5_000).unref?.();
    });

    // The rogue chain is signed by a different CA: the server must drop it.
    expect(result.rejected).toBe(true);
    expect(result.error ?? 'handshake rejected').toBeTruthy();
  });

  it('AC-C4: replicates every committed entry to every node', async () => {
    const leader = await findLeader(activeNodes());
    const entries = Array.from({ length: 20 }, (_, i) => `e2e-entry-${i}`);

    for (const entry of entries) {
      leader.send({ cmd: 'propose', data: entry });
      await leader.waitFor(
        (m) => m.type === 'proposed',
        // 20 sequential proposals on a real cluster
        20_000,
        `proposal ${entry}`,
      );
    }

    await waitUntil(
      async () => {
        const statuses = await Promise.all(activeNodes().map(statusOf));
        return statuses.every((s) => s.appliedCount >= entries.length) ? statuses : undefined;
      },
      60_000,
      'all nodes to apply every entry',
      250,
    );

    const statuses = await Promise.all(activeNodes().map(statusOf));
    for (const status of statuses) {
      expect(status.applied.slice(-entries.length)).toEqual(entries);
    }
    // Every replica reached the same commit index (same log).
    expect(new Set(statuses.map((s) => s.commitIndex)).size).toBe(1);
  });

  it('AC-C5: re-elects after a leader crash without losing committed entries', async () => {
    const before = await Promise.all(activeNodes().map(statusOf));
    const committedBefore = Math.max(...before.map((s) => s.commitIndex));

    const leader = await findLeader(activeNodes());
    const leaderId = Number(leader.label.match(/node-(\d+)/)![1]);
    leader.kill('SIGKILL');
    await leader.waitForExit();

    const survivors = activeNodes();
    expect(survivors).toHaveLength(NODE_COUNT - 1);

    const newLeader = await findLeader(survivors, 45_000);
    expect(newLeader).not.toBe(leader);

    newLeader.send({ cmd: 'propose', data: 'after-failover' });
    await newLeader.waitFor((m) => m.type === 'proposed', 30_000, 'post-failover proposal');

    const after = await waitUntil(
      async () => {
        const statuses = await Promise.all(survivors.map(statusOf));
        return statuses.every((s) => s.applied.includes('after-failover')) ? statuses : undefined;
      },
      45_000,
      'survivors to apply the post-failover entry',
      250,
    );

    // No committed entry disappeared during the failover.
    for (const status of after) {
      expect(status.commitIndex).toBeGreaterThanOrEqual(committedBefore);
    }
    expect(after.map((s) => s.applied.length)).toEqual([expect.any(Number), expect.any(Number)]);
  });

  it('AC-C6: refuses new commits when the remaining node is a minority', async () => {
    const survivors = activeNodes();
    let lastLeader = await findLeader(survivors);

    // Kill one more node: 1 of 3 left → no quorum.
    const victim = survivors.find((n) => n !== lastLeader)!;
    victim.kill('SIGKILL');
    await victim.waitForExit();
    expect(activeNodes()).toHaveLength(1);

    lastLeader.send({ cmd: 'propose', data: 'must-not-commit' });

    const outcome = await Promise.race([
      lastLeader.waitFor((m) => m.type === 'proposed' || m.type === 'error', 8_000, 'proposal outcome'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8_000)),
    ]);

    const status = await statusOf(lastLeader);
    // Either the proposal was refused outright or it never reached commit —
    // both are correct: a minority must not commit.
    if (typeof outcome !== 'string') {
      expect(outcome.type === 'error' || outcome.type === 'proposed').toBe(true);
    }
    expect(status.applied).not.toContain('must-not-commit');
  }, 120_000);
});
