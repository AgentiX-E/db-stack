/**
 * A group whose electorate is its own node.
 *
 * Why this file exists
 * --------------------
 * `@maboke123/raft-core` 0.2.1 had two defects that a three-node cluster cannot
 * reach, and every suite in this repository used three nodes:
 *
 * 1. **A candidate never counted its own vote as an election win.** The
 *    pre-vote path checked whether the votes already held met the quorum before
 *    becoming a candidate; the candidate path collected the self-vote, set
 *    `votesNeeded`, and then waited for `RequestVoteResponse`s. A one-voter group
 *    has no peer to answer, so it stayed a Candidate forever. Measured on a real
 *    node: `role: Candidate` with the term climbing 1 → 11 in four seconds and
 *    `commitIndex` pinned at 0.
 * 2. **Nothing advanced the commit index without a response to react to.** The
 *    only caller of `tryAdvanceCommitIndex` was the `AppendEntriesResponse`
 *    handler. With no followers there are no responses, so even after (1) was
 *    fixed every `propose()` still answered `Failed to commit command within
 *    timeout` — the entry was in the log, in the leader's own majority, and never
 *    became committed.
 *
 * Both are patched, and both patches are guarded here. The negative control
 * matters as much as the positive one: a two-voter group must *not* elect itself,
 * because the fix must be "a self-vote that is a majority wins", not "a candidate
 * wins".
 *
 * Acceptance criteria:
 *   AC 72.6  a one-voter group wins its first election and appends its no-op
 *   AC 72.7  a one-voter group commits and applies a command at the index after
 *            the no-op
 *   AC 72.8  it keeps that property across a restart on the same storage
 *   AC 72.9  a two-voter group whose peer is unreachable never takes office and
 *            never inflates its term
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';
import { generateClusterCerts } from '../../testing/test-certs';
import { cleanupTempDir, createTempDir, getFreePorts } from '../../testing/test-utils';

const running: RaftAdapter[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const adapter of running.splice(0)) await adapter.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Start a group of `voterCount` nodes of which only this one exists. */
async function startGroup(options: {
  voterCount: 1 | 2;
  storagePath?: string;
  applied?: string[];
}): Promise<RaftAdapter> {
  const ports = await getFreePorts(options.voterCount);
  const certs = generateClusterCerts(options.voterCount);
  const self = certs.nodes[0]!;
  const peers = Array.from({ length: options.voterCount - 1 }, (_, i) => ({
    id: i + 2,
    host: '127.0.0.1',
    port: ports[i + 1]!,
    cert: certs.nodes[i + 1]!.cert,
    key: certs.nodes[i + 1]!.key,
  }));
  const dir = options.storagePath ?? join(createTempDir('single-voter-'), 'raft.db');
  if (!options.storagePath) dirs.push(join(dir, '..'));

  const config: RaftConfig = {
    id: 1,
    peers: peers.map((peer) => peer.id),
    electionTick: 10,
    heartbeatTick: 3,
    tickIntervalMs: 30,
    storagePath: dir,
    snapshotInterval: 1000,
    environment: 'development',
  };
  const adapter = new RaftAdapter(config);
  await adapter.init(
    (data: string, index?: number) => {
      options.applied?.push(`${index}:${data}`);
    },
    {
      node: { id: 1, host: '127.0.0.1', port: ports[0]! },
      peers,
      tls: { cert: self.cert, key: self.key, ca: certs.caPem },
      connectTimeoutMs: 500,
      initialRetryMs: 50,
      maxRetryMs: 200,
    },
  );
  running.push(adapter);
  return adapter;
}

describe('a group that is its own electorate', () => {
  it('AC 72.6: a one-voter group wins its first election and appends its no-op', async () => {
    const applied: string[] = [];
    const adapter = await startGroup({ voterCount: 1, applied });

    await waitFor(() => adapter.isLeader(), 'the single voter to lead');
    const status = await adapter.getStatus();
    expect(status.role).toBe('Leader');
    // The leader appends a no-op when it takes office; it is the entry that proves
    // the win was acted on rather than merely displayed.
    expect(status.lastLogIndex).toBeGreaterThanOrEqual(1);
    expect(status.term).toBeGreaterThanOrEqual(1);
  });

  it('AC 72.7: a one-voter group commits and applies a command after the no-op', async () => {
    const applied: string[] = [];
    const adapter = await startGroup({ voterCount: 1, applied });
    await waitFor(() => adapter.isLeader(), 'the single voter to lead');

    const result = await adapter.propose('single-voter-1');
    expect(Number(result.index)).toBe(2);
    await waitFor(async () => applied.length >= 1, 'the command to reach the application');

    // The no-op occupies index 1 and is applied by raft without reaching the
    // application, so the first command the engine sees is index 2 — the same
    // forward jump a three-node cluster shows.
    expect(applied).toEqual(['2:single-voter-1']);
    expect(await adapter.getCommitIndex()).toBe(2);
    expect(await adapter.getAppliedIndex()).toBe(2);
  });

  it('AC 72.8: it keeps that property across a restart on the same storage', async () => {
    const storagePath = join(createTempDir('single-voter-restart-'), 'raft.db');
    dirs.push(join(storagePath, '..'));

    const firstApplied: string[] = [];
    const first = await startGroup({ voterCount: 1, storagePath, applied: firstApplied });
    await waitFor(() => first.isLeader(), 'the first life to lead');
    await first.propose('before-restart');
    await waitFor(async () => firstApplied.length >= 1, 'the first write to apply');
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const secondApplied: string[] = [];
    const second = await startGroup({ voterCount: 1, storagePath, applied: secondApplied });
    await waitFor(() => second.isLeader(), 'the restarted group to lead');
    const result = await second.propose('after-restart');
    // Two applies are expected here and the order is the point: the restarted node
    // has no application state to restore (this group registers no snapshot hooks),
    // so the log is the record and index 2 is delivered again before the new entry.
    await waitFor(
      async () => secondApplied.some((entry) => entry.endsWith(':after-restart')),
      'the post-restart write to apply',
      10_000,
    );

    // The restarted leader commits above everything the log already held, and the
    // entry it writes is applied at that index.
    expect(Number(result.index)).toBeGreaterThanOrEqual(3);
    expect(secondApplied).toEqual(['2:before-restart', `${Number(result.index)}:after-restart`]);
  });

  it('AC 72.9: a two-voter group whose peer is unreachable never takes office and never inflates its term', async () => {
    const adapter = await startGroup({ voterCount: 2 });

    // Quorum of two is two. The self-vote is one, so the group must not take office
    // no matter how many elections it runs — the control that keeps the patch from
    // meaning "a candidate always wins". The term is part of the assertion because a
    // node that campaigned and lost would raise it: with an unreachable peer the
    // election ends in pre-vote, which is the loop that deliberately does *not* touch
    // the term, so a climbing term here would mean the patch had made campaigning
    // unconditional.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const status = await adapter.getStatus();
      expect(status.role).not.toBe('Leader');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = await adapter.getStatus();
    expect(['Candidate', 'Follower']).toContain(status.role);
    expect(status.term).toBe(0);
    expect(status.commitIndex).toBe(0);
    await expect(adapter.propose('no-quorum')).rejects.toThrow();
  });
});
