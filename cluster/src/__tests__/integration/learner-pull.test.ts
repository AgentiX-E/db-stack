/**
 * A learner's pull, against a log a real cluster wrote.
 *
 * `RaftAdapter.getLogEntries()` is the only source `requestForLearner()` has, and
 * the unit tests for it install a fake log manager. What they cannot show is that
 * the *real* log — raft-core's, on disk, behind a mTLS transport, with the no-op
 * and configuration entries raft writes on its own — can be read back with the
 * payloads intact and the idempotency keys recoverable.
 *
 * That is the whole point of the endpoint: a learner replays what it pulls, so a
 * slice that loses `msgId` would replay a write twice.
 *
 * Acceptance criteria:
 *   AC 58.14  the leader reports a bound window over a log it really wrote
 *   AC 58.15  a slice reads back in ascending, gap-free order and keeps every payload
 *   AC 58.16  `msgId` survives the round trip through raft-core's storage
 *   AC 58.17  a cursor below the retained window is clamped up, and one past the head returns nothing
 *   AC 58.18  `limit` bounds a pull, and the next pull continues where the last ended
 *   AC 58.19  a follower can read its own replicated copy of the same entries
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from '../../testing/TestCluster';

const NODE_COUNT = 3;
const PROBES = 5;

describe('a learner pulling from a real cluster', () => {
  const cluster = new TestCluster({ nodeCount: NODE_COUNT, leaderTimeoutMs: 10_000, pollIntervalMs: 50 });
  const written: number[] = [];

  beforeAll(async () => {
    await cluster.start();
    const leader = await cluster.findLeader();
    for (let i = 0; i < PROBES; i++) {
      const { index } = await leader.adapter.proposeAndWait(
        JSON.stringify({ msgId: `probe-${i}`, type: 'exec', data: `learner-probe-${i}` }),
      );
      written.push(Number(index));
    }
  }, 120_000);

  afterAll(async () => {
    await cluster.stop();
  });

  it('AC 58.14: the leader reports a window over the log it wrote', async () => {
    const leader = await cluster.findLeader();
    const bounds = await leader.adapter.getLogBounds();

    expect(bounds).not.toBeNull();
    expect(bounds!.firstIndex).toBeGreaterThanOrEqual(1);
    expect(bounds!.lastIndex).toBeGreaterThanOrEqual(written[written.length - 1]!);
    expect(bounds!.lastTerm).toBeGreaterThanOrEqual(1);
  });

  it('AC 58.15: a slice reads back in order and keeps every payload', async () => {
    const leader = await cluster.findLeader();
    const entries = await leader.adapter.getLogEntries(written[0]!);

    const indexes = entries.map((e) => e.index);
    expect(indexes.length).toBeGreaterThanOrEqual(PROBES);
    // Ascending and gap-free: a learner replays by index, so a hole is a silent loss.
    expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, i) => written[0]! + i));

    const payloads = entries.map((e) => String(e.data)).join('\n');
    for (let i = 0; i < PROBES; i++) expect(payloads).toContain(`learner-probe-${i}`);
  });

  it('AC 58.16: the idempotency key survives raft-core storage', async () => {
    const leader = await cluster.findLeader();
    const entries = await leader.adapter.getLogEntries(written[0]!);

    const byMsgId = new Map(entries.filter((e) => e.msgId).map((e) => [e.msgId!, e]));
    for (let i = 0; i < PROBES; i++) {
      const entry = byMsgId.get(`probe-${i}`);
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('exec');
      expect(String(entry!.data)).toContain(`learner-probe-${i}`);
    }
  });

  it('AC 58.17: clamps a cursor below the window and empties one past the head', async () => {
    const leader = await cluster.findLeader();
    const bounds = (await leader.adapter.getLogBounds())!;

    const fromBelow = await leader.adapter.getLogEntries(1);
    expect(fromBelow[0]!.index).toBe(bounds.firstIndex);

    const pastHead = await leader.adapter.getLogEntries(bounds.lastIndex + 100);
    expect(pastHead).toEqual([]);
  });

  it('AC 58.18: limit bounds one pull, and the next continues where it stopped', async () => {
    const leader = await cluster.findLeader();
    const first = await leader.adapter.getLogEntries(written[0]!, 2);

    expect(first).toHaveLength(2);
    expect(first.map((e) => e.index)).toEqual([written[0]!, written[0]! + 1]);

    const rest = await leader.adapter.getLogEntries(first[1]!.index + 1);
    expect(rest[0]!.index).toBe(written[0]! + 2);
  });

  it('AC 58.19: a follower reads its own replicated copy', async () => {
    const leader = await cluster.findLeader();
    const follower = cluster.nodes.find((n) => n.id !== leader.id)!;

    // Replication is asynchronous: poll the follower's head until it has caught up
    // with the index the leader committed, rather than assuming an interval.
    const deadline = Date.now() + 20_000;
    let bounds = await follower.adapter.getLogBounds();
    while (Date.now() < deadline && (bounds?.lastIndex ?? 0) < written[written.length - 1]!) {
      await new Promise((r) => setTimeout(r, 50));
      bounds = await follower.adapter.getLogBounds();
    }

    expect(bounds!.lastIndex).toBeGreaterThanOrEqual(written[written.length - 1]!);
    const entries = await follower.adapter.getLogEntries(written[0]!);
    const payloads = entries.map((e) => String(e.data)).join('\n');
    for (let i = 0; i < PROBES; i++) expect(payloads).toContain(`learner-probe-${i}`);
  }, 30_000);
});
