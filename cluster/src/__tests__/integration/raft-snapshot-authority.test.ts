/**
 * Snapshot authority — one snapshot mechanism, proven on a real cluster.
 *
 * The defect this suite guards against had two halves, and both were invisible to
 * unit tests because each half looked reasonable on its own:
 *
 *   1. The group wrote a *metadata-only* snapshot file and then truncated the log
 *      on the strength of it. Anything between the last real snapshot and that
 *      truncation point was gone: 16 of 60 writes in the end-to-end reproduction.
 *   2. The engine's log position was derived from a local counter instead of from
 *      raft, so it drifted by one for every CONFIG/NOOP entry raft applied without
 *      calling the application. After a restart the engine refused the next entry
 *      as a gap, which killed the apply loop and left the cluster readable but no
 *      longer writable.
 *
 * This suite asserts the rules that replace them:
 *
 *   SA.1  raft-core snapshots on its own threshold (scheduling is not ours)
 *   SA.2  an explicit request produces exactly one snapshot, at the applied index
 *   SA.3  the request is idempotent — nothing is written twice for one index
 *   SA.4  the snapshot is real: the log it covers is truncated in storage
 *   SA.5  the reported metadata is the stored metadata, not a local guess
 *   SA.6  canary: raft-core still exposes the trigger this adapter needs
 */

import { describe, it, expect } from 'vitest';
import { TestCluster } from './TestCluster';

const SNAPSHOT_THRESHOLD = 10;
const ENTRIES = 25;

async function waitForApplied(cluster: TestCluster, index: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const applied = await Promise.all(cluster.nodes.map((n) => n.adapter.getAppliedIndex()));
    if (applied.every((a) => a >= index)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`applied index did not reach ${index} within ${timeoutMs}ms`);
}

describe('Snapshot authority (real 3-node cluster over mTLS)', () => {
  it('SA.1–SA.6: raft-core schedules, the request path is idempotent, the log is truncated', async () => {
    const cluster = new TestCluster({ nodeCount: 3, snapshotInterval: SNAPSHOT_THRESHOLD });
    await cluster.start();
    try {
      const leader = await cluster.findLeader();
      for (let i = 0; i < ENTRIES; i += 1) {
        await leader.adapter.proposeAndWait(`sa-entry-${i}`);
      }
      await waitForApplied(cluster, ENTRIES);

      // SA.1 — nobody asked for a snapshot: raft-core took at least one because
      // the applied index crossed its own threshold. This is the property that
      // makes the group's scheduling loop unnecessary rather than merely slow.
      for (const node of cluster.nodes) {
        const status = await node.adapter.getStatus();
        expect(status.snapshot, `node ${node.id} should have an automatic snapshot`).toBeTruthy();
        expect(status.snapshot.lastIncludedIndex).toBeGreaterThanOrEqual(SNAPSHOT_THRESHOLD);
        expect(status.snapshot.lastIncludedIndex).toBeLessThanOrEqual(status.lastApplied);
      }

      const node = cluster.nodes[0]!;
      const storage = node.adapter.getStorage();
      const appliedBefore = await node.adapter.getAppliedIndex();
      const rowsBefore = storage.countLogs();
      expect(rowsBefore).toBeGreaterThan(0);

      // SA.2 — the explicit request snapshots at the applied index.
      const meta = await node.adapter.requestSnapshot();
      expect(meta).toBeTruthy();
      expect(meta!.lastIncludedIndex).toBe(appliedBefore);
      expect(meta!.lastIncludedTerm).toBeGreaterThan(0);

      // SA.4 — and the log it covers is gone from storage, not merely marked.
      const rowsAfter = storage.countLogs();
      expect(rowsAfter).toBeLessThan(rowsBefore);
      expect(storage.getSnapshotIndex()).toBe(appliedBefore);

      // SA.3 — asking again for the same index writes nothing.
      const again = await node.adapter.requestSnapshot();
      expect(again!.lastIncludedIndex).toBe(meta!.lastIncludedIndex);
      expect(storage.countLogs()).toBe(rowsAfter);

      // SA.5 — the reported metadata is what is stored.
      const status = await node.adapter.getStatus();
      expect(status.snapshot).toEqual({
        lastIncludedIndex: meta!.lastIncludedIndex,
        lastIncludedTerm: meta!.lastIncludedTerm,
      });
      expect(node.adapter.getSnapshotMeta()).toMatchObject({
        lastIncludedIndex: meta!.lastIncludedIndex,
        lastIncludedTerm: meta!.lastIncludedTerm,
      });

      // The cluster is still writable after a snapshot truncated the log.
      await leader.adapter.proposeAndWait('sa-after-snapshot');
      await waitForApplied(cluster, appliedBefore + 1);
    } finally {
      await new Promise((r) => setTimeout(r, 500));
      await cluster.stop();
    }
  }, 240_000);

  it('SA.6: raft-core still exposes the snapshot trigger this adapter depends on', async () => {
    // `takeSnapshot` is declared private in raft-core's typings but is the only way
    // to snapshot outside its threshold. If the library renames or removes it, the
    // adapter degrades to "cannot force" and logs — silently, which is exactly the
    // class of defect this iteration removed. This canary fails first instead.
    const cluster = new TestCluster({ nodeCount: 1 });
    await cluster.start();
    try {
      const node = cluster.nodes[0]!;
      const core = (node.adapter as unknown as { node?: { takeSnapshot?: unknown } }).node;
      expect(core).toBeTruthy();
      expect(typeof core!.takeSnapshot).toBe('function');
    } finally {
      await cluster.stop();
    }
  }, 60_000);
});
