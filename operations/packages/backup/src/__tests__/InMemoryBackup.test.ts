/**
 * InMemoryBackup.test.ts — Tests for all InMemory backup implementations.
 *
 * Covers acceptance criteria B1–B15 from DESIGN.md Iteration 3.
 *
 * @module @agentix-e/db-operations-backup/__tests__
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryBackupManager } from '../impl/InMemoryBackupManager.js';
import { InMemoryPITRManager } from '../impl/InMemoryPITRManager.js';
import { InMemoryStorageBackend } from '../impl/InMemoryStorageBackend.js';
import { RetentionPolicyEvaluator } from '../impl/RetentionPolicyEvaluator.js';
import type { BackupMetadata, RetentionPolicy, PITRTarget } from '@agentix-e/db-operations-core/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<BackupMetadata> & { snapshotId: string }): BackupMetadata {
  return {
    type: 'full',
    state: 'completed',
    createdAt: new Date().toISOString(),
    sizeBytes: 1024,
    fileCount: 1,
    location: `/backups/${overrides.snapshotId}`,
    ...overrides,
  };
}

function makeSnapshotAged(snapshotId: string, daysAgo: number, type: 'full' | 'incremental' | 'logical' = 'full'): BackupMetadata {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    snapshotId,
    type,
    state: 'completed',
    createdAt: d.toISOString(),
    sizeBytes: 1024,
    fileCount: 1,
    location: `/backups/${snapshotId}`,
  };
}

// ── B1–B8: InMemoryBackupManager ─────────────────────────────────────

describe('InMemoryBackupManager', () => {
  let storage: InMemoryStorageBackend;
  let retention: RetentionPolicyEvaluator;
  let manager: InMemoryBackupManager;

  beforeEach(() => {
    storage = new InMemoryStorageBackend();
    retention = new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 1_000_000_000 });
    manager = new InMemoryBackupManager(storage, retention);
  });

  // B1: createBackup returns snapshot with unique ID & correct type
  it('B1 — creates backup with unique ID and correct type', async () => {
    const result1 = await manager.createBackup({ type: 'full' });
    expect(result1.success).toBe(true);
    expect(result1.snapshot).toBeDefined();
    expect(result1.snapshot!.snapshotId).toBeTruthy();
    expect(result1.snapshot!.type).toBe('full');

    const result2 = await manager.createBackup({ type: 'incremental' });
    expect(result2.success).toBe(true);
    expect(result2.snapshot!.snapshotId).not.toBe(result1.snapshot!.snapshotId);
    expect(result2.snapshot!.type).toBe('incremental');
  });

  // B2: listBackups returns all snapshots when no filter
  it('B2 — listBackups returns all snapshots with no filter', async () => {
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'incremental' });
    await manager.createBackup({ type: 'logical' });

    const all = await manager.listBackups();
    expect(all.length).toBe(3);
  });

  // B3: listBackups filters by type, newerThan, limit
  it('B3 — listBackups filters by type', async () => {
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'incremental' });
    await manager.createBackup({ type: 'full' });

    const fulls = await manager.listBackups({ type: 'full' });
    expect(fulls.length).toBe(2);
    fulls.forEach(s => expect(s.type).toBe('full'));
  });

  it('B3 — listBackups filters by newerThan', async () => {
    await manager.createBackup({ type: 'full' }); // T0
    await new Promise(r => setTimeout(r, 15));
    const mid = new Date().toISOString();
    await new Promise(r => setTimeout(r, 15));
    await manager.createBackup({ type: 'full' }); // T2

    const recent = await manager.listBackups({ newerThan: mid });
    expect(recent.length).toBe(1);
  });

  it('B3 — listBackups respects limit', async () => {
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'full' });
    await manager.createBackup({ type: 'full' });

    const limited = await manager.listBackups({ limit: 3 });
    expect(limited.length).toBe(3);
  });

  // B4: getBackup returns metadata for known ID, null for unknown
  it('B4 — getBackup returns metadata for known ID', async () => {
    const created = await manager.createBackup({ type: 'full' });
    const fetched = await manager.getBackup(created.snapshot!.snapshotId);
    expect(fetched).not.toBeNull();
    expect(fetched!.snapshotId).toBe(created.snapshot!.snapshotId);
  });

  it('B4 — getBackup returns null for unknown ID', async () => {
    const fetched = await manager.getBackup('non-existent-id');
    expect(fetched).toBeNull();
  });

  // B5: restoreFromSnapshot success path
  it('B5 — restoreFromSnapshot success returns success=true, duration>0', async () => {
    const created = await manager.createBackup({ type: 'full' });
    const result = await manager.restoreFromSnapshot(created.snapshot!.snapshotId);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.recoveryPoint).toBe(created.snapshot!.snapshotId);
  });

  // B6: restoreFromSnapshot unknown ID
  it('B6 — restoreFromSnapshot unknown ID returns success=false, error set', async () => {
    const result = await manager.restoreFromSnapshot('non-existent-id');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.durationMs).toBe(0);
  });

  // B7: deleteBackup removes from list
  it('B7 — deleteBackup removes snapshot from list', async () => {
    const created = await manager.createBackup({ type: 'full' });
    const id = created.snapshot!.snapshotId;

    expect(await manager.getBackup(id)).not.toBeNull();
    const deleted = await manager.deleteBackup(id);
    expect(deleted).toBe(true);
    expect(await manager.getBackup(id)).toBeNull();
  });

  // B8: prune respects retention policy
  it('B8 — prune respects retention policy (correct count deleted)', async () => {
    const strictRetention = new RetentionPolicyEvaluator({ maxFullSnapshots: 2, maxTotalBytes: 1_000_000_000 });
    const m = new InMemoryBackupManager(new InMemoryStorageBackend(), strictRetention);

    await m.createBackup({ type: 'full' }); // 1
    await m.createBackup({ type: 'full' }); // 2
    await m.createBackup({ type: 'full' }); // 3
    await m.createBackup({ type: 'full' }); // 4

    expect((await m.listBackups()).length).toBe(4);
    const deleted = await m.prune();
    expect(deleted).toBe(2);
    expect((await m.listBackups()).length).toBe(2);
  });

  // B9: PITR via backup manager
  it('returns recovery point from pitr', async () => {
    const result = await manager.pitr({ targetTime: '2026-01-01T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.recoveryPoint).toBe('2026-01-01T00:00:00Z');
    expect(result.durationMs).toBe(20);
  });

  it('falls back to targetLsn when targetTime absent', async () => {
    const result = await manager.pitr({ targetLsn: '0/12345' });
    expect(result.recoveryPoint).toBe('0/12345');
  });

  it('uses "unknown" when no target provided', async () => {
    const result = await manager.pitr({});
    expect(result.recoveryPoint).toBe('unknown');
  });
});

// ── B9–B10: InMemoryPITRManager ──────────────────────────────────────

describe('InMemoryPITRManager', () => {
  // B9: getCurrentLSN returns string
  it('B9 — getCurrentLSN returns a string', async () => {
    const pitr = new InMemoryPITRManager('0/ABCDEF');
    const lsn = await pitr.getCurrentLSN();
    expect(typeof lsn).toBe('string');
    expect(lsn).toBe('0/ABCDEF');
  });

  it('getCurrentTimestamp returns ISO string', async () => {
    const pitr = new InMemoryPITRManager();
    const ts = await pitr.getCurrentTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('archiveCurrentWal is a no-op (does not throw)', async () => {
    const pitr = new InMemoryPITRManager();
    await expect(pitr.archiveCurrentWal()).resolves.toBeUndefined();
  });

  // B10: resolveTarget returns valid plan
  it('B10 — resolveTarget returns valid plan', async () => {
    const pitr = new InMemoryPITRManager('0/CAFE01');
    const target: PITRTarget = { targetTime: '2026-07-12T00:00:00Z' };
    const plan = await pitr.resolveTarget(target);

    expect(plan).toHaveProperty('snapshotId');
    expect(plan).toHaveProperty('walEndLsn');
    expect(plan).toHaveProperty('approxTime');
    expect(plan.snapshotId).toBe('pitr-snap-1');
    expect(plan.walEndLsn).toBe('0/CAFE01');
    expect(plan.approxTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('isEnabled returns correct value', () => {
    const enabled = new InMemoryPITRManager('0/0', true);
    expect(enabled.isEnabled()).toBe(true);

    const disabled = new InMemoryPITRManager('0/0', false);
    expect(disabled.isEnabled()).toBe(false);
  });

  // The `enabled = true` default parameter must be observable: constructing
  // without the enabled argument yields an enabled manager (the `true`→`false`
  // mutant would report disabled).
  it('defaults to enabled when the enabled argument is omitted', () => {
    const pitr = new InMemoryPITRManager('0/0');
    expect(pitr.isEnabled()).toBe(true);
  });
});

// ── B11–B13: InMemoryStorageBackend ──────────────────────────────────

describe('InMemoryStorageBackend', () => {
  let backend: InMemoryStorageBackend;
  let tmpDir: string;

  beforeEach(() => {
    backend = new InMemoryStorageBackend();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // B11: upload → download round-trip
  it('B11 — upload then download round-trip preserves data', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
    const srcFile = path.join(tmpDir, 'source.bin');
    const destFile = path.join(tmpDir, 'dest.bin');

    const originalData = Buffer.from('Hello, backup storage round-trip!', 'utf-8');
    await fs.writeFile(srcFile, originalData);

    await backend.upload(srcFile, 'test-object.bin');
    await backend.download('test-object.bin', destFile);

    const downloaded = await fs.readFile(destFile);
    expect(downloaded.equals(originalData)).toBe(true);
  });

  // B12: list returns correct count
  it('B12 — list returns correct count with prefix filter', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
    const f1 = path.join(tmpDir, 'f1.bin');
    const f2 = path.join(tmpDir, 'f2.bin');
    const f3 = path.join(tmpDir, 'f3.bin');
    await fs.writeFile(f1, Buffer.from('a'));
    await fs.writeFile(f2, Buffer.from('b'));
    await fs.writeFile(f3, Buffer.from('c'));

    await backend.upload(f1, 'daily/b1.snap');
    await backend.upload(f2, 'daily/b2.snap');
    await backend.upload(f3, 'weekly/w1.snap');

    const daily = await backend.list('daily/');
    expect(daily.length).toBe(2);

    const weekly = await backend.list('weekly/');
    expect(weekly.length).toBe(1);

    const all = await backend.list('');
    expect(all.length).toBe(3);
  });

  // B13: health returns ok
  it('B13 — health returns ok', async () => {
    const health = await backend.health();
    expect(health.ok).toBe(true);
  });

  it('delete removes object', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
    const f = path.join(tmpDir, 'a.bin');
    await fs.writeFile(f, Buffer.from('data'));
    await backend.upload(f, 'object-to-delete');

    expect((await backend.list('')).length).toBe(1);
    await backend.delete('object-to-delete');
    expect((await backend.list('')).length).toBe(0);
  });

  it('getUsageBytes returns correct total', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
    const f1 = path.join(tmpDir, 'a.bin');
    const f2 = path.join(tmpDir, 'b.bin');
    await fs.writeFile(f1, Buffer.from('12345'));
    await fs.writeFile(f2, Buffer.from('1234567890'));
    await backend.upload(f1, 'a');
    await backend.upload(f2, 'b');

    const usage = await backend.getUsageBytes();
    expect(usage).toBe(15);
  });
});

// ── B14–B15: RetentionPolicyEvaluator ────────────────────────────────

describe('RetentionPolicyEvaluator', () => {
  // B14: maxFullSnapshots enforced
  it('B14 — keeps only maxFullSnapshots full snapshots', () => {
    const policy: RetentionPolicy = { maxFullSnapshots: 2, maxTotalBytes: 1_000_000_000 };
    const evaluator = new RetentionPolicyEvaluator(policy);

    const snapshots: BackupMetadata[] = [
      makeSnapshotAged('s1', 10),
      makeSnapshotAged('s2', 8),
      makeSnapshotAged('s3', 5),
      makeSnapshotAged('s4', 2),
    ];

    const toDelete = evaluator.evaluate(snapshots);
    // 4 full snapshots, maxFullSnapshots=2 → 2 should be deleted
    expect(toDelete.length).toBe(2);
    const deletedIds = toDelete.map(s => s.snapshotId);
    // The oldest 2 should be deleted
    expect(deletedIds).toContain('s1');
    expect(deletedIds).toContain('s2');
  });

  // B15: keepRecent prevents deletion
  it('B15 — keepRecent prevents deletion of recent snapshots', () => {
    // keepRecent = 'P30D' (30 days) — snapshots younger than 30d are kept
    const policy: RetentionPolicy = {
      maxFullSnapshots: 1,
      maxTotalBytes: 1_000_000_000,
      keepRecent: 'P30D',
    };
    const evaluator = new RetentionPolicyEvaluator(policy);

    const snapshots: BackupMetadata[] = [
      makeSnapshotAged('old-snap', 60),    // 60 days old → exceeds keepRecent
      makeSnapshotAged('recent-snap', 10), // 10 days old → within keepRecent
      makeSnapshotAged('newest-snap', 1),  // 1 day old → kept by maxFullSnapshots
    ];

    const toDelete = evaluator.evaluate(snapshots);

    // maxFullSnapshots=1 keeps newest-snap
    // old-snap is 60d old, exceeds keepRecent → deletable
    // recent-snap is 10d old, within keepRecent → NOT deletable
    expect(toDelete.length).toBe(1);
    expect(toDelete[0].snapshotId).toBe('old-snap');
  });

  it('returns empty array for empty input', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 5, maxTotalBytes: 1_000_000_000 });
    const result = evaluator.evaluate([]);
    expect(result).toEqual([]);
  });

  it('respects minAge', () => {
    const policy: RetentionPolicy = {
      maxFullSnapshots: 0,
      maxTotalBytes: 1_000_000_000,
      minAge: 'P10D',
    };
    const evaluator = new RetentionPolicyEvaluator(policy);

    const snapshots: BackupMetadata[] = [
      makeSnapshotAged('young', 5),
      makeSnapshotAged('old', 20),
    ];

    const toDelete = evaluator.evaluate(snapshots);
    // Both exceed maxFullSnapshots=0
    // young is 5d old, minAge=10d → NOT old enough
    // old is 20d old, minAge=10d → old enough
    expect(toDelete.length).toBe(1);
    expect(toDelete[0].snapshotId).toBe('old');
  });

  it('getConfig returns current policy', () => {
    const policy: RetentionPolicy = { maxFullSnapshots: 5, maxTotalBytes: 500_000 };
    const evaluator = new RetentionPolicyEvaluator(policy);
    const config = evaluator.getConfig();
    expect(config.maxFullSnapshots).toBe(5);
    expect(config.maxTotalBytes).toBe(500_000);
  });

  it('updateConfig merges new values', () => {
    const evaluator = new RetentionPolicyEvaluator({ maxFullSnapshots: 3, maxTotalBytes: 100 });
    evaluator.updateConfig({ maxFullSnapshots: 10 });
    const config = evaluator.getConfig();
    expect(config.maxFullSnapshots).toBe(10);
    expect(config.maxTotalBytes).toBe(100); // unchanged
  });
});
