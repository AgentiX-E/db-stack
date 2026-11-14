import { describe, it, expect } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([
  { name: 'InMemory', factory: new InMemoryEngineFactory() },
])('$name e2e: Backup', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create a full backup', async () => {
    const backup = factory.createBackupManager();
    const result = await backup.createBackup({ type: 'full', tags: { env: 'test' } });
    expect(result.success).toBe(true);
    expect(result.snapshot?.snapshotId).toBeTruthy();
  });

  it('should list backups', async () => {
    const backup = factory.createBackupManager();
    await backup.createBackup({ type: 'full' });
    await backup.createBackup({ type: 'incremental' });
    const list = await backup.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('should get backup by ID', async () => {
    const backup = factory.createBackupManager();
    const result = await backup.createBackup({ type: 'full' });
    const id = result.snapshot!.snapshotId;
    const meta = await backup.getBackup(id);
    expect(meta).not.toBeNull();
    expect(meta!.snapshotId).toBe(id);
  });

  it('should return null for non-existent backup', async () => {
    const backup = factory.createBackupManager();
    const meta = await backup.getBackup('non-existent');
    expect(meta).toBeNull();
  });

  it('should delete a backup', async () => {
    const backup = factory.createBackupManager();
    const result = await backup.createBackup({ type: 'full' });
    const deleted = await backup.deleteBackup(result.snapshot!.snapshotId);
    expect(deleted).toBe(true);
  });

  it('should restore from snapshot', async () => {
    const backup = factory.createBackupManager();
    const result = await backup.createBackup({ type: 'full' });
    const restore = await backup.restoreFromSnapshot(result.snapshot!.snapshotId);
    expect(restore.success).toBe(true);
  });

  it('should perform PITR', async () => {
    const backup = factory.createBackupManager();
    const result = await backup.pitr({ targetTime: new Date().toISOString() });
    expect(result.success).toBe(true);
  });

  it('should prune old backups', async () => {
    const backup = factory.createBackupManager();
    await backup.createBackup({ type: 'full' });
    await backup.createBackup({ type: 'full' });
    const pruned = await backup.prune();
    expect(typeof pruned).toBe('number');
  });

  it('should create storage backend', () => {
    const storage = factory.createStorageBackend();
    expect(storage.name).toBeTruthy();
  });

  it('should create retention policy', () => {
    const policy = factory.createRetentionPolicy();
    expect(policy.getConfig()).toBeDefined();
    expect(policy.getConfig().maxFullSnapshots).toBe(3);
  });

  it('storage backend returns health ok', async () => {
    const storage = factory.createStorageBackend();
    const health = await storage.health();
    expect(health.ok).toBe(true);
  });

  it('should list empty storage', async () => {
    const storage = factory.createStorageBackend();
    const items = await storage.list('');
    expect(Array.isArray(items)).toBe(true);
  });
});
