/**
 * Backup chain primitives — what an incremental needs, and who needs it.
 *
 * An incremental stores only what changed since the snapshot named by
 * `parentSnapshotId`, so it is replayable only on top of that snapshot, which is
 * in turn replayable only on top of its own parent. The functions here answer
 * the two questions a store has to answer to keep that true:
 *
 *   - **who depends on this snapshot** — so a delete can cascade instead of
 *     leaving behind bytes nobody can replay (`dependentsOf`);
 *   - **can this snapshot be replayed at all** — so a restore can say no instead
 *     of reporting a success it cannot deliver (`unrestorableReason`).
 *
 * They are pure functions over an inventory rather than methods on the manager
 * because they must agree with what a *policy* does — `RetentionPolicyEvaluator`
 * groups the same edges into sets — and because malformed metadata (a
 * self-reference, a cycle, a parent that was never stored) has to be testable
 * without concurrency in the way.
 *
 * @module @agentix-e/db-node/backup/impl
 */

import type { BackupMetadata } from '../../core/types.js';

/** The snapshot an incremental created now should extend, or `null` if none. */
export function newestCompletedSnapshot(inventory: readonly BackupMetadata[]): BackupMetadata | null {
  let newest: BackupMetadata | null = null;
  for (const snapshot of inventory) {
    const isCompleted = snapshot.state === 'completed';
    if (!isCompleted) continue;
    if (newest === null) {
      newest = snapshot;
      continue;
    }
    const isAtLeastAsNew = new Date(snapshot.createdAt).getTime() >= new Date(newest.createdAt).getTime();
    if (isAtLeastAsNew) newest = snapshot;
  }
  return newest;
}

/**
 * Every snapshot naming `snapshotId` anywhere in its ancestry, transitively.
 *
 * A self-reference and a cycle both stop at an id already collected, so
 * malformed metadata cannot make this loop or report the snapshot itself.
 *
 * Takes an array rather than an iterator on purpose: the walk revisits the whole
 * inventory once per generation, and `Map.values()` is consumed after the first
 * pass. Passing the live iterator — which is what the manager did at first —
 * silently returned the children of the target and stopped, so a two-deep chain
 * cascaded one level and left a delta behind (AC 59.12 caught it).
 */
export function dependentsOf(inventory: readonly BackupMetadata[], snapshotId: string): string[] {
  const dependents: string[] = [];
  const pending: string[] = [snapshotId];

  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const snapshot of inventory) {
      const namesCurrent = snapshot.parentSnapshotId === current;
      if (!namesCurrent) continue;
      const isTheSnapshotItself = snapshot.snapshotId === snapshotId;
      const alreadyCollected = dependents.includes(snapshot.snapshotId);
      if (isTheSnapshotItself || alreadyCollected) continue;
      dependents.push(snapshot.snapshotId);
      pending.push(snapshot.snapshotId);
    }
  }

  return dependents;
}

/** What a restore needs from the inventory: the artefacts, oldest first, or why it cannot. */
export interface ChainResolution {
  /**
   * The artefacts to replay, **oldest first**: the base, every delta above it, and
   * `snapshot` itself last. Empty when the chain cannot be replayed.
   */
  chain: BackupMetadata[];
  /** Why that chain cannot be replayed, or `null` when it can. */
  reason: string | null;
}

/**
 * The chain a restore of `snapshot` needs, and the reason it has none.
 *
 * Two failures matter. A **missing link** — a parent that is no longer stored —
 * means the delta has nothing to apply to. A **chain without a base** — one that
 * ends at an incremental instead of a full or logical snapshot — means there was
 * never anything to apply the deltas to. A cycle is reported as the link that
 * repeats.
 *
 * One walk answers both questions on purpose. `unrestorableReason` asks *may this be
 * replayed* and the manager then has to ask *with what*; two walks are two chances to
 * disagree, and the failure mode of that disagreement is a restore that passes the
 * check and then replays a different set of artefacts — the exact shape P3-62
 * describes. Returning both from one function makes them agree by construction.
 */
export function resolveChain(
  inventory: ReadonlyMap<string, BackupMetadata>,
  snapshot: BackupMetadata,
): ChainResolution {
  const walked: BackupMetadata[] = [snapshot];
  const seen = new Set<string>([snapshot.snapshotId]);
  let current: BackupMetadata = snapshot;

  const refuse = (reason: string): ChainResolution => ({ chain: [], reason });

  for (;;) {
    const parentId: string | undefined = current.parentSnapshotId;
    if (parentId === undefined) {
      const isBase = current.type !== 'incremental';
      if (!isBase) {
        return refuse(`incremental snapshot ${snapshot.snapshotId} has no full snapshot at the root of its chain`);
      }
      return { chain: walked.reverse(), reason: null };
    }
    if (seen.has(parentId)) {
      return refuse(`parent chain of snapshot ${snapshot.snapshotId} is cyclic at ${parentId}`);
    }
    const parent = inventory.get(parentId);
    if (parent === undefined) {
      return refuse(`base snapshot ${parentId} of incremental ${snapshot.snapshotId} is missing`);
    }
    seen.add(parentId);
    walked.push(parent);
    current = parent;
  }
}

/**
 * Why `snapshot` cannot be replayed, or `null` when it can.
 *
 * The reason half of `resolveChain`, kept as its own name because most callers only
 * ask this question and a boolean-shaped answer reads better at those sites.
 */
export function unrestorableReason(
  inventory: ReadonlyMap<string, BackupMetadata>,
  snapshot: BackupMetadata,
): string | null {
  return resolveChain(inventory, snapshot).reason;
}
