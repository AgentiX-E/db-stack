import { describe, it, expect, vi } from 'vitest';
import type {
  IBackupManager,
  IPITRManager,
  IStorageBackend,
  BackupEntry,
  RestorePoint,
  IBackupScheduleConfig,
  IBackupScheduler,
  IBackupManifest,
  IBackupRetentionRule,
  IBackupRetentionPolicy,
} from '../interfaces/index.js';

// ── Type-only structural validation — no runtime assertions on
//     abstract interfaces, just ensure the shape compiles. ──

describe('BackupEntry (type)', () => {
  it('compiles with required fields', () => {
    const entry: BackupEntry = {
      id: 'backup-1',
      database: 'production-db',
      type: 'full',
      sizeBytes: 1073741824,
      createdAt: new Date(),
      status: 'completed',
      tags: ['weekly', 'automated'],
    };
    expect(entry.status).toBe('completed');
  });
});

describe('RestorePoint (type)', () => {
  it('compiles with required fields', () => {
    const rp: RestorePoint = {
      id: 'pitr-1',
      timestamp: new Date(),
      database: 'production-db',
      type: 'log',
      sizeBytes: 524288000,
    };
    expect(rp.type).toBe('log');
  });
});

describe('IBackupScheduleConfig', () => {
  it('should create a valid schedule config', () => {
    const config: IBackupScheduleConfig = {
      enabled: true,
      intervalMs: 86400000,
      retentionCount: 7,
    };
    expect(config.intervalMs).toBe(86400000);
  });
});

describe('IBackupScheduler', () => {
  const mockScheduler: IBackupScheduler = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getNextScheduled: vi.fn().mockResolvedValue(new Date(Date.now() + 3600000)),
    triggerNow: vi.fn().mockResolvedValue('backup-42'),
    onBackupReady: vi.fn(),
  };

  it('should trigger an immediate backup', async () => {
    const backupId = await mockScheduler.triggerNow();
    expect(backupId).toBe('backup-42');
  });

  it('should return null when no backup is scheduled', async () => {
    const noopScheduler: IBackupScheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      getNextScheduled: vi.fn().mockResolvedValue(null),
      triggerNow: vi.fn(),
      onBackupReady: vi.fn(),
    };
    expect(await noopScheduler.getNextScheduled()).toBeNull();
  });
});

describe('IBackupManifest', () => {
  it('should have all required properties', () => {
    const manifest: IBackupManifest = {
      id: 'backup-1',
      metadata: { database: 'prod', type: 'full' },
      status: 'completed',
      sizeBytes: 1048576,
      createdAt: new Date(),
    };
    expect(manifest.id).toBe('backup-1');
  });
});

describe('IBackupRetentionRule', () => {
  it('should create a valid retention rule', () => {
    const rule: IBackupRetentionRule = {
      maxCount: 7,
      maxAgeDays: 30,
      minInterval: 24,
    };
    expect(rule.maxCount).toBe(7);
  });
});
