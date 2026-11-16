/**
 * AC 62 — the assertions a mutant asked for.
 *
 * P2-14 said mutation covered two of 21 operations packages and that the next
 * step needed a selection rule rather than a blanket run. The rule chosen:
 * **mutate what decides deletion, durability or when work runs.** Two more
 * modules qualify immediately — `InMemoryBackupManager` (it deletes snapshots)
 * and `backupChain` (it decides whether a snapshot can be restored at all) — and
 * measuring them the first time produced this list of behaviours nothing
 * asserted: the shape of a generated id, that `createdAt` is a readable instant,
 * the order `listBackups` returns, what `limit: 0` means, and whether
 * `newerThan` includes its own boundary.
 *
 * None of those is exotic. Each is a line an operator reads off the product and
 * acts on, and each was a mutant that survived a suite of 2 668 tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryBackupManager } from '../impl/InMemoryBackupManager.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import type { BackupMetadata } from '@agentix-e/db-operations-core/types';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0, 0);

function manager(keep = 100): InMemoryBackupManager {
  return new InMemoryBackupManager(
    new InMemoryStorageBackend(),
    new RetentionPolicyEvaluator({ maxFullSnapshots: keep, maxTotalBytes: 0 }),
  );
}

describe('AC 62 — what the backup store says about what it stores', () => {
  beforeEach(() => {
    // Only `Date` is faked: `createBackup` waits on a real `setTimeout`, and a
    // fully faked clock would leave that promise pending forever.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC 62.1: a generated snapshot id is a well-formed, unique identifier', async () => {
    const mgr = manager();
    const first = await mgr.createBackup({ type: 'full' });
    const second = await mgr.createBackup({ type: 'full' });

    // `snap-<base36 time>-<base36 sequence>`. A mutated counter produces ids such
    // as `snap-xxxx--1`, which this shape rejects.
    for (const result of [first, second]) {
      expect(result.snapshot!.snapshotId).toMatch(/^snap-[0-9a-z]+-[0-9a-z]+$/);
    }
    expect(first.snapshot!.snapshotId).not.toBe(second.snapshot!.snapshotId);
  });

  it('AC 62.2: a new snapshot carries a readable creation time and a location that names it', async () => {
    const mgr = manager();
    const created = (await mgr.createBackup({ type: 'full' })).snapshot!;

    // Retention sorts and ages by `createdAt`; an empty string there would sort
    // as the epoch and hide the snapshot from every floor.
    expect(new Date(created.createdAt).toISOString()).toBe(new Date(NOW).toISOString());
    expect(created.location).toContain(created.snapshotId);
    expect(created.state).toBe('completed');
    expect(created.completedAt).toBeDefined();
  });

  it('AC 62.3: listBackups returns newest first', async () => {
    const mgr = manager();
    const first = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 1_000);
    const second = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 2_000);
    const third = (await mgr.createBackup({ type: 'full' })).snapshot!;

    const listed = await mgr.listBackups();

    expect(listed.map((s) => s.snapshotId)).toEqual([third.snapshotId, second.snapshotId, first.snapshotId]);
  });

  it('AC 62.4: snapshots sharing a timestamp keep the order they were taken in', async () => {
    const mgr = manager();
    // Two snapshots created at the same instant: a comparator that returns a
    // non-zero value for equal times reverses them.
    const first = (await mgr.createBackup({ type: 'full' })).snapshot!;
    const second = (await mgr.createBackup({ type: 'full' })).snapshot!;

    const listed = await mgr.listBackups();

    expect(listed[0]!.snapshotId).toBe(first.snapshotId);
    expect(listed[1]!.snapshotId).toBe(second.snapshotId);
  });

  it('AC 62.5: limit 0 means no limit, and a positive limit truncates the newest', async () => {
    const mgr = manager();
    const first = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 1_000);
    const second = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 2_000);
    const third = (await mgr.createBackup({ type: 'full' })).snapshot!;

    expect(await mgr.listBackups({ limit: 0 })).toHaveLength(3);
    expect(await mgr.listBackups({ limit: -1 })).toHaveLength(3);
    expect((await mgr.listBackups({ limit: 2 })).map((s) => s.snapshotId)).toEqual([
      third.snapshotId,
      second.snapshotId,
    ]);
    expect((await mgr.listBackups({ limit: 1 })).map((s) => s.snapshotId)).toEqual([third.snapshotId]);
    expect(first.snapshotId).toBeDefined();
  });

  it('AC 62.6: newerThan is strict about its own boundary', async () => {
    const mgr = manager();
    const older = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 1_000);
    const boundary = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 2_000);
    const newer = (await mgr.createBackup({ type: 'full' })).snapshot!;

    const listed = await mgr.listBackups({ newerThan: boundary.createdAt });

    // "Newer than" excludes the instant named, so the snapshot taken exactly
    // then is not in the answer.
    expect(listed.map((s) => s.snapshotId)).toEqual([newer.snapshotId]);
    expect(listed.map((s) => s.snapshotId)).not.toContain(boundary.snapshotId);
    expect(listed.map((s) => s.snapshotId)).not.toContain(older.snapshotId);
  });

  it('AC 62.7: filters compose — type and time together, and a limit applies last', async () => {
    const mgr = manager();
    const full = (await mgr.createBackup({ type: 'full' })).snapshot!;
    vi.setSystemTime(NOW + 1_000);
    await mgr.createBackup({ type: 'incremental' });
    vi.setSystemTime(NOW + 2_000);
    const latestFull = (await mgr.createBackup({ type: 'full' })).snapshot!;

    const combined = await mgr.listBackups({ type: 'full', newerThan: new Date(NOW).toISOString() });
    expect(combined.map((s) => s.snapshotId)).toEqual([latestFull.snapshotId]);

    expect((await mgr.listBackups({ type: 'full', limit: 1 })).map((s) => s.snapshotId)).toEqual([
      latestFull.snapshotId,
    ]);
    expect((await mgr.listBackups({ limit: 100 })).map((s) => s.snapshotId)).toContain(full.snapshotId);
  });

  it('AC 62.8: prune deletes exactly what the policy returned and counts it', async () => {
    const mgr = manager(1);
    const inventory: BackupMetadata[] = [];
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(NOW + i * 1_000);
      inventory.push((await mgr.createBackup({ type: 'full' })).snapshot!);
    }

    // The store keeps one set, so the two older snapshots are the delete list.
    const pruned = await mgr.prune();
    const remaining = (await mgr.listBackups()).map((s) => s.snapshotId);

    expect(pruned).toBe(2);
    expect(remaining).toEqual([inventory[2]!.snapshotId]);
  });
});
