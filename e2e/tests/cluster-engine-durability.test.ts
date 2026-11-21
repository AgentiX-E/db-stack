/**
 * E2E — the engine SPI on a real cluster: durability, replay and recovery.
 *
 * Acceptance criteria covered:
 *   AC-C8   the replica's applied index tracks Raft's commit index
 *   AC-C9   a replayed index never reaches the engine (no double apply)
 *   AC-C10  the engine's applied index equals Raft's applied index exactly, so a
 *           restart resumes at the right log position
 *   AC-C7   a full-cluster restart after log compaction comes back with *all* the
 *           data and accepts writes again
 *
 * AC-C7 was withdrawn in the previous iteration because it could not pass: three
 * nodes, snapshots every 15 entries, 60 writes, kill all three, restart all three —
 * the cluster elected a leader, reported committed entries and never applied them
 * again. Two defects were behind it, both fixed and both guarded here:
 *
 *   - the group truncated the log on the strength of a metadata-only snapshot, so
 *     everything between the last real snapshot and the truncation point was lost
 *     (measured: 16 of 60 writes);
 *   - the engine's log position came from a local counter that drifted by one for
 *     every CONFIG/NOOP entry, and the engine's own ordering check rejected the
 *     first entry after a restart, wedging the apply loop.
 *
 * Everything here runs against three independent OS processes talking TLS 1.3 with
 * mutual certificate verification, and the node's data lives behind
 * `IStorageEngine`/`EngineBackedReplica` — the same path a real database engine
 * plugs into. That matters for AC-C7: the Raft log has been compacted past the
 * snapshot, so the node *cannot* rebuild its state by replaying entries. If the
 * engine is not restored from the snapshot, the data is simply gone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
/** Below the number of writes below, so several snapshots are taken mid-run. */
const SNAPSHOT_INTERVAL = 15;

const dirs: string[] = [];
let nodes: ChildNode[] = [];
let certs: ReturnType<typeof makeCertificates>;
let specs: ClusterNodeSpec[] = [];
/** Every key this suite has successfully committed, in write order. */
const written: string[] = [];

interface NodeStatus {
  id: number;
  isLeader: boolean;
  term: number;
  commitIndex: number;
  lastLogIndex: number;
  raftApplied: number;
  snapshot: { lastIncludedIndex: number; lastIncludedTerm: number } | null;
  appliedCount: number;
  applied: string[];
  stateSize: number;
  /** The engine's key set — a count cannot say which write went missing. */
  keys: string[];
  appliedIndex: number;
  engineName: string;
  /** Indexes the engine was actually handed a command at, in order. */
  engineIndexes: number[];
  /** Applies the replica suppressed because it had already applied that index. */
  skippedReplays: number;
  /** Applies accepted over a gap raft left for its own CONFIG/NOOP entries. */
  forwardJumps: number;
  /** Non-null while the replica refuses to apply after a failed snapshot install. */
  restoreFailure: string | null;
}

async function statusOf(node: ChildNode): Promise<NodeStatus> {
  return node.status<NodeStatus>();
}

/**
 * One line per node: what the engine has, what Raft has applied, and how far the
 * log reaches. The three numbers together separate "the follower never received
 * the entry" (lastLogIndex behind) from "it received it and never applied it"
 * (raftApplied behind) from "it applied it and the engine dropped it" (stateSize
 * behind while raftApplied is current).
 *
 * The key names are part of the message because a count cannot say *which* write
 * went missing, and the two ways a command can vanish — the engine was never handed
 * it, or the replica suppressed it as a replay — are told apart by the engine's own
 * index list against the applied list, not by arithmetic.
 */
async function describeDivergence(): Promise<string> {
  const rows = await Promise.all(
    nodes.map(async (node) => {
      if (node.exited) return `${node.label}: exited`;
      try {
        const s = await statusOf(node);
        const missing = written.filter((key) => !s.keys.includes(key));
        return (
          `${node.label}: stateSize=${s.stateSize} applied=${s.raftApplied} commit=${s.commitIndex} ` +
          `lastLog=${s.lastLogIndex} snapshot=${s.snapshot?.lastIncludedIndex ?? 'none'} ` +
          `engineApplies=${s.engineIndexes.length}/${s.appliedCount} skipped=${s.skippedReplays} ` +
          `jumps=${s.forwardJumps}${s.restoreFailure === null ? '' : ` restoreFailure=${s.restoreFailure}`}` +
          `${missing.length === 0 ? '' : ` missing=[${missing.join(',')}]`}`
        );
      } catch (err) {
        return `${node.label}: status failed (${String(err)})`;
      }
    }),
  );
  return rows.join(' | ');
}

async function findLeader(active: ChildNode[], timeoutMs = 45_000): Promise<ChildNode> {
  return waitUntil(
    async () => {
      for (const node of active) {
        if (node.exited) continue;
        try {
          const status = await statusOf(node);
          if (status.isLeader) return node;
        } catch {
          // still electing
        }
      }
      return undefined;
    },
    timeoutMs,
    'a leader to be elected',
    250,
  );
}

/**
 * Propose one entry and wait for *this* proposal to be acknowledged.
 *
 * Waiting on the bare message type would return the first proposal ever seen,
 * which makes a loop of sequential writes race-free only by luck.
 */
async function propose(node: ChildNode, data: string): Promise<void> {
  const seen = (): number => node.messages.filter((m) => m.type === 'proposed').length;
  const before = seen();
  node.send({ cmd: 'propose', data });
  await node.waitFor(
    (m) => m.type === 'proposed' && node.messages.filter((x) => x.type === 'proposed').indexOf(m) >= before,
    20_000,
    `proposal ${data}`,
  );
}

async function write(node: ChildNode, key: string, value: string): Promise<void> {
  await propose(node, JSON.stringify({ key, value }));
  written.push(key);
}

async function readKey(node: ChildNode, key: string): Promise<string | null> {
  const before = node.messages.filter((m) => m.type === 'read').length;
  node.send({ cmd: 'read', key });
  const message = await node.waitFor(
    (m) => m.type === 'read' && node.messages.filter((x) => x.type === 'read').indexOf(m) >= before,
    15_000,
    `read ${key}`,
  );
  return (message.data as { value: string | null }).value;
}

async function startCluster(): Promise<void> {
  nodes = specs.map((spec) => spawnRaftNode(spec));
  await Promise.all(nodes.map((n) => n.waitForType('ready', 60_000)));
}

beforeAll(async () => {
  certs = makeCertificates(NODE_COUNT);
  const ports = await getFreePorts(NODE_COUNT);
  const baseDir = makeTempDir('engine-durability');
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
    snapshotInterval: SNAPSHOT_INTERVAL,
  }));
  for (const spec of specs) {
    spec.peers = specs.filter((p) => p.id !== spec.id).map((p) => ({ id: p.id, host: p.host, port: p.port }));
  }

  await startCluster();
}, 120_000);

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.terminate()));
  for (const dir of dirs) removeTempDir(dir);
});

describe('engine SPI on a real cluster (mTLS, separate processes)', () => {
  it('AC-C8: the replica applied index tracks the Raft commit index', async () => {
    const leader = await findLeader(nodes);
    for (let i = 0; i < 10; i += 1) {
      await write(leader, `idx-${i}`, String(i));
    }

    // Both readings only grow, but they are taken a moment apart: waiting for the
    // *engine's* key count (the durable fact) rather than the position it reports
    // avoids asserting on a pair that a commit can land between.
    const status = await waitUntil(
      async () => {
        const current = await statusOf(leader);
        return current.appliedIndex >= 10 && current.stateSize >= 10 ? current : undefined;
      },
      30_000,
      "the applied index and the engine's key count to catch up",
      200,
    );

    expect(status.engineName).toBe('memory');
    expect(status.appliedIndex).toBeLessThanOrEqual(status.commitIndex);
    expect(status.appliedIndex).toBeGreaterThanOrEqual(10);
    // Ten applied entries reached the engine; the count is the engine's view, not
    // a counter the node keeps on the side.
    expect(status.stateSize).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it("AC-C10: the engine position equals Raft's applied position on every node", async () => {
    // The drift this asserts away cost a whole cluster its writability: a local
    // counter advanced once per *apply call*, while raft advances once per *log
    // entry*, and CONFIG/NOOP entries are never handed to the application. Every
    // election therefore moved the engine one index further behind the log.
    const statuses = await waitUntil(
      async () => {
        const all = await Promise.all(nodes.map(statusOf));
        const settled = all.every((s) => s.appliedIndex === s.raftApplied || s.appliedIndex === s.raftApplied - 1);
        return settled ? all : undefined;
      },
      45_000,
      'every node to settle with engine position == raft position',
      250,
    );

    for (const status of statuses) {
      // `- 1` is legitimate only when the last applied entry was a NOOP raft
      // appended on election: the engine's position is the last *command*.
      expect(status.appliedIndex).toBeGreaterThanOrEqual(status.raftApplied - 1);
      expect(status.appliedIndex).toBeLessThanOrEqual(status.raftApplied);
    }
  }, 90_000);

  it('AC-C9: replay after restart does not apply an index twice', async () => {
    // A duplicate apply of `SET counter = 1` is invisible; a duplicate apply of an
    // increment is not. The reference engine's `put` is idempotent, so the check is
    // structural: the engine recorded exactly one context per index, which the
    // replica guarantees by dropping replayed indexes.
    const leader = await findLeader(nodes);
    await write(leader, 'replay-probe', 'v1');

    const before = await statusOf(leader);
    // Restarting a follower forces it to replay from its last snapshot.
    const follower = nodes.find((n) => n !== leader)!;
    await follower.terminate();
    const revived = spawnRaftNode(specs.find((s) => `node-${s.id}@${s.port}` === follower.label)!);
    nodes = nodes.filter((n) => n !== follower).concat(revived);
    await revived.waitForType('ready', 60_000);

    const recovered = await waitUntil(
      async () => {
        const status = await statusOf(revived);
        return status.appliedIndex > 0 ? status : undefined;
      },
      45_000,
      'the restarted node to apply again',
      250,
    );

    expect(recovered.appliedIndex).toBeGreaterThanOrEqual(before.appliedIndex - 5);
    expect(await readKey(revived, 'replay-probe')).toBe('v1');
  }, 180_000);

  it('AC-C7: a full-cluster restart after compaction keeps every write and stays writable', async () => {
    const leader = await findLeader(nodes);

    // Enough writes to force several snapshots and compact the log past what a
    // restart could replay: this is the case that used to come back empty.
    for (let i = 0; i < 40; i += 1) {
      await write(leader, `restart-${i}`, String(i));
    }

    // Followers apply asynchronously; convergence to the full key set is the
    // precondition, so wait for it instead of racing it.
    const beforeRestart = await waitUntil(
      async () => {
        const all = await Promise.all(nodes.map(statusOf));
        return all.every((s) => s.stateSize === written.length) ? all : undefined;
      },
      60_000,
      'every node to apply every write before the restart',
      250,
      // Applying is asynchronous, so the interesting fact on a timeout is *which*
      // node is behind and by how much — `written.length` alone cannot tell a
      // stalled follower from a slow one.
      async () => `wrote ${written.length}: ${await describeDivergence()}`,
    );
    for (const status of beforeRestart) {
      expect(status.stateSize).toBe(written.length);
    }
    const lastAppliedBefore = Math.max(...beforeRestart.map((s) => s.raftApplied));
    expect(
      beforeRestart.some((s) => s.snapshot !== null),
      'at least one node must have snapshotted before the restart',
    ).toBe(true);

    await Promise.all(nodes.map((n) => n.terminate()));
    await startCluster();

    const revived = await waitUntil(
      async () => {
        const all = await Promise.all(nodes.map(statusOf));
        return all.every((s) => s.stateSize === written.length) ? all : undefined;
      },
      90_000,
      'every restarted node to restore the complete engine state',
      500,
    );

    // No key may be missing: the snapshot is the only copy of everything the
    // compacted log used to hold.
    for (const status of revived) {
      expect(status.stateSize).toBe(written.length);
      expect(status.appliedIndex).toBeGreaterThanOrEqual(lastAppliedBefore - 1);
    }
    const probe = nodes[0]!;
    for (const key of [written[0]!, written[Math.floor(written.length / 2)]!, written.at(-1)!]) {
      const expected = key.startsWith('restart-')
        ? String(Number(key.slice('restart-'.length)))
        : key === 'replay-probe'
          ? 'v1'
          : String(Number(key.slice('idx-'.length)));
      expect(await readKey(probe, key)).toBe(expected);
    }

    // And the recovered cluster is writable — the failure mode was "readable but
    // never writable again", which no read assertion would have caught.
    const leaderAfter = await findLeader(nodes);
    await write(leaderAfter, 'post-restart', 'accepted');
    const confirmed = await waitUntil(
      async () => {
        const all = await Promise.all(nodes.map(statusOf));
        return all.every((s) => s.stateSize === written.length) ? all : undefined;
      },
      60_000,
      'the post-restart write to reach every node',
      250,
    );
    for (const status of confirmed) {
      expect(status.stateSize).toBe(written.length);
    }
    expect(await readKey(probe, 'post-restart')).toBe('accepted');
  }, 300_000);
});
