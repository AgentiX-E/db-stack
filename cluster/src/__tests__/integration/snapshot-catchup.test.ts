/**
 * A follower that was down while the leader compacted its log comes back.
 *
 * Why this file exists
 * --------------------
 * A restarted follower whose `nextIndex` points below the leader's snapshot can
 * only recover by *installing* a snapshot; there is no log left to replay. Until
 * `TestCluster.restartNode` existed the harness could produce that situation but
 * never observe the recovery, so the transfer path was exercised only by the
 * multi-process acceptance suite — which is exactly where it failed, once in four
 * runs, with the follower logging `Snapshot is truncated: 0 bytes …` and staying
 * twenty keys behind while reporting a current applied index.
 *
 * Three defects lived behind that symptom, and each needs its own guard:
 *
 *   1. `BatchedRaftTransport` framed the RPC with `JSON.stringify`, so a chunk's
 *      `data` arrived as `{type: 'Buffer', data: […]}` — an object whose
 *      `.length` is `undefined` — and raft-core drops a chunk with
 *      `if (request.data.length > 0)`. Pinned by `MessageCodec.binary.test.ts`.
 *   2. An application with no snapshot handler took 0-byte snapshots, so Raft
 *      truncated a log it had never captured and followers installed nothing
 *      while reporting everything. Pinned by
 *      `EngineBackedReplica.divergence.test.ts` and `RaftAdapter`'s callbacks.
 *   3. raft-core starts snapshot transfers from its heartbeat loop without
 *      awaiting peers and without a per-peer guard, so two transfers to one peer
 *      interleave; the receiver resets its chunk assembly on every `offset === 0`
 *      and *both* transfers then fail their offset check. A snapshot larger than
 *      raft-core's 256 KiB chunk size could therefore never install. Pinned here,
 *      and in `BatchedRaftTransport.test.ts`, because only a real multi-chunk
 *      transfer over real TLS shows it.
 *
 * The payload is deliberately larger than one chunk and the assertions compare
 * *state*, not positions: a node that reports the leader's `lastApplied` while
 * missing the values behind it is the failure this file exists to catch.
 *
 * Acceptance criteria:
 *   AC 35.1  a restarted follower reaches the leader's log position
 *   AC 35.2  the recovery happened through a snapshot, not a replay
 *   AC 35.3  the restarted follower's state machine matches the leader's exactly
 *   AC 35.4  the restarted follower keeps accepting entries afterwards
 *   AC 35.5  restarting a node that is still running is refused
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from '../../testing/TestCluster';

/** Entries between snapshots, small so the log is compacted past the follower. */
const SNAPSHOT_INTERVAL = 10;
/** Writes while the follower is down: more than one snapshot's worth. */
const WRITES_WHILE_DOWN = 40;
/**
 * Size of each pre-outage value.
 *
 * raft-core transfers a snapshot in fixed 256 KiB chunks, so the serialized state
 * has to exceed one chunk before the transfer is split — and a single-chunk
 * transfer cannot show the interleaving defect at all. Three values of this size
 * put the snapshot past two chunks.
 */
const BIG_VALUE_BYTES = 96 * 1024;

let cluster: TestCluster;

/**
 * Poll `probe` until it returns true, or fail with `label` and a description.
 *
 * The description is not decoration: a 60-second timeout against a real cluster
 * costs a minute of CI per hypothesis, and "it timed out" cannot distinguish a
 * stalled follower from a leader that never sent the snapshot.
 */
async function eventually(
  probe: () => Promise<boolean>,
  label: string,
  describe?: () => Promise<string>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  let detail = '';
  if (describe) {
    try {
      detail = ` (${await describe()})`;
    } catch (err) {
      detail = ` (diagnostics unavailable: ${String(err)})`;
    }
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}` +
      (last === undefined ? '' : ` (last error: ${String(last)})`) +
      detail,
  );
}

/** One line per node: what Raft believes about it, and what the node's state holds. */
async function describeCluster(): Promise<string> {
  const rows = await Promise.all(
    cluster.nodes.map(async (node) => {
      try {
        const [applied, commit, leader, snapshot, retained, peers] = await Promise.all([
          node.adapter.getAppliedIndex(),
          node.adapter.getCommitIndex(),
          node.adapter.getLeader(),
          node.adapter.refreshSnapshotMeta(),
          node.adapter.getRetainedLogLength(),
          node.adapter.getPeerProgress(),
        ]);
        return (
          `node-${node.id}: applied=${applied} commit=${commit} leader=${String(leader)} ` +
          `snapshot=${snapshot?.lastIncludedIndex ?? 'none'} retained=${retained} ` +
          `stateLen=${node.applied.length} peers=${JSON.stringify(peers)}`
        );
      } catch (err) {
        return `node-${node.id}: status failed (${String(err)})`;
      }
    }),
  );
  // The leader's own view of each peer is the other half: a follower that is
  // behind because the leader never advanced `nextIndex` looks identical to one
  // whose install failed, from the follower's side alone — so the leader prints
  // the per-peer `next`/`match` it is actually working from.
  let progress: string;
  try {
    const leader = await cluster.findLeader();
    progress =
      ` | leader-${leader.id} progress=${JSON.stringify(await leader.adapter.getProgress())}` +
      ` peers=${JSON.stringify(await leader.adapter.getPeerProgress())}`;
  } catch (err) {
    progress = ` | leader progress unavailable (${String(err)})`;
  }
  return rows.join(' | ') + progress;
}

/** A value large enough that the snapshot has to be chunked. */
function bigValue(tag: string): string {
  return `${tag}:${'x'.repeat(BIG_VALUE_BYTES)}`;
}

describe('Raft cluster — a restarted follower installs a snapshot', () => {
  beforeAll(async () => {
    cluster = new TestCluster({ nodeCount: 3, snapshotInterval: SNAPSHOT_INTERVAL });
    await cluster.start();
  }, 120_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it('AC 35.1 + 35.2 + 35.3: a node that was down for a compaction catches up through a snapshot', async () => {
    const leader = await cluster.findLeader();
    const follower = cluster.remainingNodes(leader.id)[0]!;

    // The leader's per-peer view is the only place a stuck transfer is visible;
    // it has to name every peer, with real positions, before this case means
    // anything.
    const peerProgress = await leader.adapter.getPeerProgress();
    expect(Object.keys(peerProgress).sort()).toEqual(
      cluster
        .remainingNodes(leader.id)
        .map((n) => String(n.id))
        .sort(),
    );
    for (const progress of Object.values(peerProgress)) {
      expect(progress.match).toBeGreaterThanOrEqual(0);
      expect(progress.next).toBeGreaterThan(0);
    }

    await leader.adapter.proposeAndWait('before-outage');
    for (let i = 0; i < 3; i += 1) {
      await leader.adapter.proposeAndWait(bigValue(`bulk-${i}`));
    }

    // Take the follower out of the cluster and let the leader compact past it.
    await cluster.killNode(follower.id);
    for (let i = 0; i < WRITES_WHILE_DOWN; i += 1) {
      await leader.adapter.proposeAndWait(`during-outage-${i}`);
    }
    const leaderCommit = await leader.adapter.getCommitIndex();
    const leaderSnapshot = await leader.adapter.refreshSnapshotMeta();

    // The precondition for the case to mean anything: the entries the follower
    // missed are no longer in the log, so it cannot catch up by replaying them.
    expect(leaderSnapshot?.lastIncludedIndex ?? 0).toBeGreaterThan(0);
    expect(await leader.adapter.getRetainedLogLength()).toBeLessThan(WRITES_WHILE_DOWN);

    const revived = await cluster.restartNode(follower.id);

    await eventually(
      async () => (await revived.adapter.getAppliedIndex()) >= leaderCommit,
      `the restarted node to apply up to the leader's commit index ${leaderCommit}`,
      describeCluster,
    );

    // AC 35.2: it can only have got there by installing the snapshot, because the
    // log it would have replayed from was truncated on the leader.
    const revivedSnapshot = await revived.adapter.refreshSnapshotMeta();
    expect(revivedSnapshot?.lastIncludedIndex ?? 0).toBeGreaterThan(0);
    // And it is still a follower of the same leader, not a new one.
    expect(await revived.adapter.getLeader()).toBe(leader.id);

    // AC 35.3: the point of the whole exercise. Matching applied indexes prove
    // nothing if the bytes behind them were lost, so the state machines are
    // compared value by value — including the bulk values that could only have
    // reached this node inside a multi-chunk snapshot.
    await eventually(
      async () => cluster.stateOf(revived.id).length >= cluster.stateOf(leader.id).length,
      `the restarted node's state machine to reach ${cluster.stateOf(leader.id).length} values`,
      describeCluster,
    );
    expect(cluster.stateOf(revived.id)).toEqual(cluster.stateOf(leader.id));
  }, 180_000);

  it('AC 35.4: the recovered node keeps accepting entries', async () => {
    const leader = await cluster.findLeader();
    const revived = cluster.remainingNodes(leader.id)[0]!;

    const { index } = await leader.adapter.proposeAndWait('after-recovery');

    await eventually(
      async () => (await revived.adapter.getAppliedIndex()) >= Number(index),
      `the recovered node to apply index ${index}`,
      describeCluster,
    );
    expect(await revived.adapter.getAppliedIndex()).toBeGreaterThanOrEqual(Number(index));
    expect(cluster.stateOf(revived.id)).toContain('after-recovery');
  }, 120_000);

  it('AC 35.5: restarting a node that is still running is refused', async () => {
    const running = cluster.nodes[0]!;
    await expect(cluster.restartNode(running.id)).rejects.toThrow(/still running/);
  }, 30_000);
});
