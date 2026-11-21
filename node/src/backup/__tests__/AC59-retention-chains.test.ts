/**
 * AC 59 — retention operates on chains, and a store never keeps a chain it
 * cannot replay.
 *
 * P2-12 asked what a count rule is supposed to do with incrementals, because
 * two rules disagreed about them: rule 1 counted `full` snapshots only, so
 * incrementals were never pruned by count, and rule 4 pruned strictly oldest
 * first, so the base under them went first. The two rules together produced the
 * worst of both: unrestorable incrementals kept forever, and no way to reclaim
 * their bytes without deleting more of the same kind.
 *
 * The decision is that a snapshot is not the unit of retention — a **set** is: a
 * base plus every incremental chained to it through `parentSnapshotId`. A set is
 * kept or removed whole. That is the only rule under which the inventory never
 * contains a delta without its base, and the only one under which "reclaimed
 * 250 GB" also means "250 GB that nobody could restore".
 *
 * The second half of the acceptance criterion is the store itself. Recording the
 * parent (`createBackup`), cascading a delete to the dependents
 * (`deleteBackup`) and refusing to report success for a chain that cannot be
 * replayed (`restoreFromSnapshot`) keep the invariant that retention exists to
 * preserve. Restore keeps its own check because `IBackupRetentionPolicy` is an
 * injection point: a caller-supplied policy can still return a base.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import { BackupManager } from '../impl/BackupManager.js';
import { DirectoryBackupSource } from '../impl/DirectoryBackupSource.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { dependentsOf, newestCompletedSnapshot, unrestorableReason } from '../impl/backupChain.js';
import type { IBackupRetentionPolicy } from '../interfaces/index.js';
import type { BackupMetadata, RetentionPolicy } from '../../core/types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Fixed instant, so every age in this suite is an exact number of days. */
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0, 0);

interface Draft {
  /** Snapshot id, also used in messages. */
  id: string;
  /** Age in milliseconds before `NOW`. Defaults to zero (created now). */
  ageMs?: number;
  sizeBytes?: number;
  type?: 'full' | 'incremental' | 'logical';
  parent?: string;
}

function snapshot(draft: Draft): BackupMetadata {
  return {
    snapshotId: draft.id,
    type: draft.type ?? 'full',
    state: 'completed',
    sizeBytes: draft.sizeBytes ?? 100,
    createdAt: new Date(NOW - (draft.ageMs ?? 0)).toISOString(),
    fileCount: 1,
    location: `file:///backups/${draft.id}`,
    ...(draft.parent === undefined ? {} : { parentSnapshotId: draft.parent }),
  };
}

const ids = (snapshots: BackupMetadata[]): string[] => snapshots.map((s) => s.snapshotId).sort();

describe('AC 59 — a snapshot is not the unit of retention, a set is', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 59.1: the byte ceiling removes the base together with its incrementals', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 130 });

    // Set A: a three-day-old base and an incremental taken an hour ago.
    // Set B: a two-hour-old base.
    const inventory = [
      snapshot({ id: 'base-a', ageMs: 3 * DAY_MS, sizeBytes: 100 }),
      snapshot({ id: 'inc-a', ageMs: HOUR_MS, sizeBytes: 50, type: 'incremental', parent: 'base-a' }),
      snapshot({ id: 'base-b', ageMs: 2 * HOUR_MS, sizeBytes: 100 }),
    ];

    // Iteration 26 ordered snapshots by age and stopped as soon as the total
    // fitted: it removed `base-a` (oldest), then `base-b`, and left `inc-a` —
    // 50 bytes of delta with nothing to replay onto, reported as a successful
    // prune. 250 bytes in, 130 allowed, 50 left behind and unusable.
    const outcome = evaluator.evaluateWithOutcome(inventory);

    expect(ids(outcome.toDelete)).toEqual(['base-a', 'inc-a']);
    expect(outcome.unreclaimedBytes).toBe(0);
    // What survives is restorable, which is the only thing the ceiling is for.
    const survivors = inventory.filter((s) => !outcome.toDelete.includes(s));
    expect(ids(survivors)).toEqual(['base-b']);
  });

  it('AC 59.2: the count rule does not leave a headless chain', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 1, maxTotalBytes: 0 });

    const inventory = [
      snapshot({ id: 'base-old', ageMs: 3 * DAY_MS }),
      snapshot({ id: 'inc-old', ageMs: 2 * DAY_MS, type: 'incremental', parent: 'base-old' }),
      snapshot({ id: 'base-new', ageMs: 1 * DAY_MS }),
    ];

    // Counting `full` snapshots kept `base-new`, deleted `base-old` and kept
    // `inc-old` — a delta whose base the same pass had just removed.
    expect(ids(evaluator.evaluate(inventory))).toEqual(['base-old', 'inc-old']);
  });

  it('AC 59.3: keepRecent on one member protects the whole set', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 0,
      maxTotalBytes: 0,
      keepRecent: 'P2D',
    });

    const inventory = [
      snapshot({ id: 'base-ancient', ageMs: 30 * DAY_MS }),
      snapshot({ id: 'inc-fresh', ageMs: HOUR_MS, type: 'incremental', parent: 'base-ancient' }),
      snapshot({ id: 'base-stale', ageMs: 10 * DAY_MS }),
    ];

    // The fresh incremental cannot be kept without its base, and the base cannot
    // be kept "for free": protecting one member protects the chain.
    expect(ids(evaluator.evaluate(inventory))).toEqual(['base-stale']);
  });

  it('AC 59.4: minAge on one member protects the whole set', () => {
    const evaluator = new RetentionPolicyEvaluator({
      maxFullSnapshots: 0,
      maxTotalBytes: 0,
      minAge: 'P1D',
    });

    const inventory = [
      snapshot({ id: 'base-2d', ageMs: 2 * DAY_MS }),
      snapshot({ id: 'inc-2h', ageMs: 2 * HOUR_MS, type: 'incremental', parent: 'base-2d' }),
      snapshot({ id: 'base-5d', ageMs: 5 * DAY_MS }),
    ];

    // `inc-2h` is younger than minAge, so it is not removable; removing its base
    // would make it unrestorable, so the base is not removable either.
    expect(ids(evaluator.evaluate(inventory))).toEqual(['base-5d']);
  });

  it('AC 59.5: a parent that is absent from the inventory is not a delete order', () => {
    // `evaluate` receives whatever listing the caller passes. Treating an
    // unknown parent as "orphan, delete it" would turn a filtered inventory
    // into a data-loss order, so an incremental with no base in the inventory is
    // its own set and is subject to the same rules as anything else.
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 5, maxTotalBytes: 0 });

    const inventory = [snapshot({ id: 'inc-only', ageMs: DAY_MS, type: 'incremental', parent: 'not-listed' })];
    expect(evaluator.evaluate(inventory)).toEqual([]);
  });

  it('AC 59.6: every decision keeps the chain invariant', () => {
    const inventory = [
      snapshot({ id: 'a', ageMs: 10 * DAY_MS, sizeBytes: 400 }),
      snapshot({ id: 'a-1', ageMs: 9 * DAY_MS, sizeBytes: 200, type: 'incremental', parent: 'a' }),
      snapshot({ id: 'a-2', ageMs: 8 * DAY_MS, sizeBytes: 200, type: 'incremental', parent: 'a-1' }),
      snapshot({ id: 'b', ageMs: 4 * DAY_MS, sizeBytes: 400 }),
      snapshot({ id: 'b-1', ageMs: 3 * DAY_MS, sizeBytes: 100, type: 'incremental', parent: 'b' }),
      snapshot({ id: 'c', ageMs: 2 * DAY_MS, sizeBytes: 400, type: 'logical' }),
    ];
    const policies: RetentionPolicy[] = [
      { maxFullSnapshots: 3, maxTotalBytes: 0 },
      { maxFullSnapshots: 2, maxTotalBytes: 0 },
      { maxFullSnapshots: 1, maxTotalBytes: 0 },
      { maxFullSnapshots: 3, maxTotalBytes: 1_200 },
      { maxFullSnapshots: 3, maxTotalBytes: 800 },
      { maxFullSnapshots: 0, maxTotalBytes: 0 },
      { maxFullSnapshots: 2, maxTotalBytes: 500, keepRecent: 'P3D' },
    ];

    for (const policy of policies) {
      const toDelete = new RetentionPolicyEvaluator(policy).evaluate(inventory);
      const deleted = new Set(ids(toDelete));
      for (const victim of toDelete) {
        const parent = victim.parentSnapshotId;
        if (parent === undefined) continue;
        // Deleting a child without its parent is allowed (a set may be reduced
        // from the tip); deleting a parent without its children is not.
        expect(deleted.has(parent) || !deleted.has(victim.snapshotId)).toBe(true);
      }
      for (const survivor of inventory.filter((s) => !deleted.has(s.snapshotId))) {
        let cursor: BackupMetadata | undefined = survivor;
        const seen = new Set<string>();
        while (cursor?.parentSnapshotId !== undefined && !seen.has(cursor.snapshotId)) {
          seen.add(cursor.snapshotId);
          expect(deleted.has(cursor.parentSnapshotId)).toBe(false);
          cursor = inventory.find((s) => s.snapshotId === cursor!.parentSnapshotId);
        }
      }
    }
  });

  it('AC 59.7: a cyclic chain terminates and stays reclaimable', () => {
    // Malformed metadata: two snapshots naming each other as parent. There is no
    // base to walk to, so the set is rooted at whichever comes first; the point
    // is that the pass neither loops nor declares the bytes unreclaimable.
    const inventory = [
      snapshot({ id: 'cyc-1', ageMs: 2 * DAY_MS, type: 'incremental', parent: 'cyc-2' }),
      snapshot({ id: 'cyc-2', ageMs: 1 * DAY_MS, type: 'incremental', parent: 'cyc-1' }),
    ];

    const keepOne = new RetentionPolicyEvaluator({ maxFullSnapshots: 1, maxTotalBytes: 0 });
    expect(keepOne.evaluate(inventory)).toEqual([]);

    const keepNone = new RetentionPolicyEvaluator({ maxFullSnapshots: 0, maxTotalBytes: 0 });
    expect(ids(keepNone.evaluate(inventory))).toEqual(['cyc-1', 'cyc-2']);
  });

  it('AC 59.8: a snapshot naming itself as parent does not become its own child', () => {
    const inventory = [
      snapshot({ id: 'self', ageMs: 2 * DAY_MS, type: 'incremental', parent: 'self' }),
      snapshot({ id: 'other', ageMs: DAY_MS }),
    ];

    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 1, maxTotalBytes: 0 });
    // Two independent sets, newest kept: the self-reference adds no member.
    expect(ids(evaluator.evaluate(inventory))).toEqual(['self']);
  });

  it('AC 59.9: the same set is never listed twice, and its bytes are charged once', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 250 });
    const inventory = [
      snapshot({ id: 'base', ageMs: 3 * DAY_MS, sizeBytes: 100 }),
      snapshot({ id: 'inc-1', ageMs: 2 * DAY_MS, sizeBytes: 100, type: 'incremental', parent: 'base' }),
      snapshot({ id: 'inc-2', ageMs: DAY_MS, sizeBytes: 100, type: 'incremental', parent: 'inc-1' }),
    ];

    // 300 bytes against a 250-byte ceiling: one set, so the only honest answer
    // is "remove it, or keep it and report the excess" — and here it is removed
    // once, not three times with a duplicated delete list.
    const outcome = evaluator.evaluateWithOutcome(inventory);
    expect(outcome.toDelete).toHaveLength(3);
    expect(new Set(ids(outcome.toDelete)).size).toBe(3);
    expect(outcome.unreclaimedBytes).toBe(0);
  });

  it('AC 59.10: a snapshot whose creation time cannot be read is never removed', () => {
    const undateable = { ...snapshot({ id: 'undateable', ageMs: DAY_MS, sizeBytes: 500 }) };
    undateable.createdAt = 'not-a-timestamp';
    const inventory = [snapshot({ id: 'dated', ageMs: 10 * DAY_MS, sizeBytes: 500 }), undateable];

    // Counting cannot date it, so the count rule skips it and removes only the
    // set it can reason about.
    const counted = new RetentionPolicyEvaluator({ maxFullSnapshots: 0, maxTotalBytes: 0 });
    expect(ids(counted.evaluate(inventory))).toEqual(['dated']);

    // The ceiling cannot honour itself either, and says so instead of deleting
    // the one snapshot it does not understand.
    const capped = new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 100 });
    const outcome = capped.evaluateWithOutcome(inventory);
    expect(ids(outcome.toDelete)).toEqual(['dated']);
    expect(outcome.unreclaimedBytes).toBe(400);
  });
});

describe('AC 59 — the store keeps chains intact', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ac59-'));
    dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    // A directory source rather than a simulator: the chain rules are about what a
    // restorable snapshot needs, and a source that never wrote an artefact would let
    // a broken chain pass by not having any bytes to restore.
    writeFileSync(join(dataDir, 'table.bin'), 'rows');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manager(retention?: IBackupRetentionPolicy): BackupManager {
    const policy = retention ?? new RetentionPolicyEvaluator({ maxFullSnapshots: 7, maxTotalBytes: 0 });
    return new BackupManager(new DirectoryBackupSource(dataDir), new InMemoryStorageBackend(), policy, {
      workDir: join(root, 'work'),
    });
  }

  it('AC 59.11: an incremental records the snapshot it extends', async () => {
    const mgr = manager();
    const full = await mgr.createBackup({ type: 'full' });
    const inc = await mgr.createBackup({ type: 'incremental' });

    // Before iteration 27 `parentSnapshotId` was never written, so the inventory
    // said nothing about what an incremental needs: no retention pass could keep
    // a chain together and no restore could check one.
    expect(inc.snapshot!.parentSnapshotId).toBe(full.snapshot!.snapshotId);
    expect(full.snapshot!.parentSnapshotId).toBeUndefined();
  });

  it('AC 59.12: an incremental extends the new base, not the old chain', async () => {
    const mgr = manager();
    await mgr.createBackup({ type: 'full' });
    const firstInc = await mgr.createBackup({ type: 'incremental' });
    const secondInc = await mgr.createBackup({ type: 'incremental' });
    const newFull = await mgr.createBackup({ type: 'full' });
    const afterNewFull = await mgr.createBackup({ type: 'incremental' });

    expect(firstInc.snapshot!.parentSnapshotId).toBeDefined();
    // Incrementals chain onto incrementals: that is what makes a long chain.
    expect(secondInc.snapshot!.parentSnapshotId).toBe(firstInc.snapshot!.snapshotId);
    expect(afterNewFull.snapshot!.parentSnapshotId).toBe(newFull.snapshot!.snapshotId);
  });

  it('AC 59.13: deleting a base deletes every snapshot that cannot be replayed without it', async () => {
    const mgr = manager();
    const full = await mgr.createBackup({ type: 'full' });
    const inc1 = await mgr.createBackup({ type: 'incremental' });
    const inc2 = await mgr.createBackup({ type: 'incremental' });
    const unrelated = await mgr.createBackup({ type: 'full' });

    expect(await mgr.deleteBackup(full.snapshot!.snapshotId)).toBe(true);

    expect(await mgr.getBackup(full.snapshot!.snapshotId)).toBeNull();
    expect(await mgr.getBackup(inc1.snapshot!.snapshotId)).toBeNull();
    expect(await mgr.getBackup(inc2.snapshot!.snapshotId)).toBeNull();
    // A base that nothing depends on is untouched.
    expect(await mgr.getBackup(unrelated.snapshot!.snapshotId)).not.toBeNull();
  });

  it('AC 59.14: deleting an unknown snapshot reports that nothing was deleted', async () => {
    const mgr = manager();
    await mgr.createBackup({ type: 'full' });
    expect(await mgr.deleteBackup('no-such-snapshot')).toBe(false);
    expect(await mgr.listBackups()).toHaveLength(1);
  });

  it('AC 59.15: a policy that removes a base takes its incrementals with it', async () => {
    // A caller-supplied policy is an injection point; the store cannot assume it is
    // chain-aware. This one deletes the oldest snapshot and nothing else — and the
    // store refuses to leave the delta behind, because bytes that are listed,
    // billed and impossible to replay are the state this whole criterion exists to
    // make unrepresentable.
    const baseFirst: IBackupRetentionPolicy = {
      evaluate: (snapshots) => {
        const oldest = [...snapshots].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )[0];
        return oldest === undefined ? [] : [oldest];
      },
      getConfig: () => ({ maxFullSnapshots: 1, maxTotalBytes: 0 }),
      updateConfig: () => undefined,
    };

    const mgr = manager(baseFirst);
    const full = await mgr.createBackup({ type: 'full' });
    const inc = await mgr.createBackup({ type: 'incremental' });

    expect(await mgr.prune()).toBe(2);
    expect(await mgr.getBackup(full.snapshot!.snapshotId)).toBeNull();
    expect(await mgr.getBackup(inc.snapshot!.snapshotId)).toBeNull();
    // And the restore of the delta says the honest thing: nothing is there.
    expect((await mgr.restoreFromSnapshot(inc.snapshot!.snapshotId)).error).toBe('not found');
  });

  it('AC 59.16: restore refuses an incremental that has no base at the root of its chain', async () => {
    const mgr = manager();
    // No full was ever taken, so there is nothing to apply the delta to. The
    // create still succeeds — the bytes exist — but the restore must not claim
    // they can be used.
    const inc = await mgr.createBackup({ type: 'incremental' });

    const restore = await mgr.restoreFromSnapshot(inc.snapshot!.snapshotId);
    expect(restore.success).toBe(false);
    expect(restore.error).toContain('no full snapshot');
  });

  it('AC 59.17: restoring a full snapshot still succeeds, and an unknown id still fails', async () => {
    const mgr = manager();
    const full = await mgr.createBackup({ type: 'full' });
    expect((await mgr.restoreFromSnapshot(full.snapshot!.snapshotId)).success).toBe(true);
    expect((await mgr.restoreFromSnapshot('missing-id')).success).toBe(false);
  });

  it('AC 59.18: dependentsOf is transitive, excludes the snapshot itself, and survives a cycle', () => {
    const inventory = [
      snapshot({ id: 'base' }),
      snapshot({ id: 'inc-1', type: 'incremental', parent: 'base' }),
      snapshot({ id: 'inc-2', type: 'incremental', parent: 'inc-1' }),
      snapshot({ id: 'cycle-a', type: 'incremental', parent: 'cycle-b' }),
      snapshot({ id: 'cycle-b', type: 'incremental', parent: 'cycle-a' }),
    ];

    expect(dependentsOf(inventory, 'base').sort()).toEqual(['inc-1', 'inc-2']);
    expect(dependentsOf(inventory, 'inc-2')).toEqual([]);
    expect(dependentsOf(inventory, 'self-referencing')).toEqual([]);
    expect(dependentsOf(inventory, 'cycle-a').sort()).toEqual(['cycle-b']);

    // A snapshot naming itself is not its own dependent: it would make the
    // cascade delete the target twice and inflate the count.
    const selfReferencing = [snapshot({ id: 'alone', type: 'incremental', parent: 'alone' })];
    expect(dependentsOf(selfReferencing, 'alone')).toEqual([]);
  });

  it('AC 59.19: newestCompletedSnapshot ignores snapshots that never finished', () => {
    const inventory: BackupMetadata[] = [
      { ...snapshot({ id: 'done-old', ageMs: 2 * HOUR_MS }), state: 'completed' },
      { ...snapshot({ id: 'running', ageMs: HOUR_MS }), state: 'in-progress' },
      { ...snapshot({ id: 'broken', ageMs: 1 }), state: 'failed' },
    ];

    // Chaining onto a snapshot that is still running would name a base no
    // restore can use.
    expect(newestCompletedSnapshot(inventory)!.snapshotId).toBe('done-old');
    expect(newestCompletedSnapshot([])).toBeNull();
  });

  it('AC 59.20: unrestorableReason reports the three shapes of a broken chain', () => {
    const inventory = new Map<string, BackupMetadata>(
      [
        snapshot({ id: 'base' }),
        snapshot({ id: 'inc', type: 'incremental', parent: 'base' }),
        snapshot({ id: 'oracle', type: 'logical' }),
        snapshot({ id: 'loop-a', type: 'incremental', parent: 'loop-b' }),
        snapshot({ id: 'loop-b', type: 'incremental', parent: 'loop-a' }),
      ].map((s) => [s.snapshotId, s]),
    );

    expect(unrestorableReason(inventory, inventory.get('base')!)).toBeNull();
    expect(unrestorableReason(inventory, inventory.get('oracle')!)).toBeNull();
    expect(unrestorableReason(inventory, inventory.get('inc')!)).toBeNull();
    expect(unrestorableReason(inventory, snapshot({ id: 'ghost', parent: 'gone', type: 'incremental' }))).toBe(
      'base snapshot gone of incremental ghost is missing',
    );
    // The link that repeats is the one named: loop-a -> loop-b -> loop-a.
    expect(unrestorableReason(inventory, inventory.get('loop-a')!)).toBe(
      'parent chain of snapshot loop-a is cyclic at loop-a',
    );
  });

  it('AC 59.21: the newest completed snapshot wins, ties go to the later one', () => {
    // `AC 59.19` had a single completed snapshot, which cannot tell "the newest"
    // from "the last one looked at".
    const older = { ...snapshot({ id: 'older', ageMs: 2 * HOUR_MS }), state: 'completed' as const };
    const newer = { ...snapshot({ id: 'newer', ageMs: HOUR_MS }), state: 'completed' as const };

    expect(newestCompletedSnapshot([newer, older])!.snapshotId).toBe('newer');
    expect(newestCompletedSnapshot([older, newer])!.snapshotId).toBe('newer');

    // Same instant: the snapshot stored later is the tip of the chain.
    const twinA = { ...snapshot({ id: 'twin-a', ageMs: HOUR_MS }), state: 'completed' as const };
    const twinB = { ...snapshot({ id: 'twin-b', ageMs: HOUR_MS }), state: 'completed' as const };
    expect(newestCompletedSnapshot([twinA, twinB])!.snapshotId).toBe('twin-b');
  });

  it('AC 59.22: a chain that runs into a cycle still terminates and names the loop', () => {
    // a -> b -> c -> b: the cycle does not contain the snapshot the walk started
    // from, so only a visited set makes this terminate.
    const inventory = new Map<string, BackupMetadata>(
      [
        snapshot({ id: 'a', type: 'incremental', parent: 'b' }),
        snapshot({ id: 'b', type: 'incremental', parent: 'c' }),
        snapshot({ id: 'c', type: 'incremental', parent: 'b' }),
      ].map((s) => [s.snapshotId, s]),
    );

    expect(unrestorableReason(inventory, inventory.get('a')!)).toBe('parent chain of snapshot a is cyclic at b');
  });

  it('AC 59.23: a removed set is listed oldest member first', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 0, maxTotalBytes: 0 });
    // Deliberately handed over out of order: the delete list has to be a
    // sequence an operator can read down, not the order the inventory happened
    // to arrive in.
    const inventory = [
      snapshot({ id: 'newest', ageMs: DAY_MS }),
      snapshot({ id: 'oldest', ageMs: 3 * DAY_MS }),
      snapshot({ id: 'middle', ageMs: 2 * DAY_MS }),
    ];

    expect(evaluator.evaluate(inventory).map((s) => s.snapshotId)).toEqual(['oldest', 'middle', 'newest']);
  });
});
