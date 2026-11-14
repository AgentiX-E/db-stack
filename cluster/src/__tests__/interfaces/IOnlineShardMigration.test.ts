import { describe, it, expect, vi } from 'vitest';
import { IOnlineShardMigration, IMigrationConfig } from '../../interfaces/shard/IOnlineShardMigration';

describe('IOnlineShardMigration', () => {
  it('should define the interface contract with all methods', () => {
    const methods: (keyof IOnlineShardMigration)[] = ['startMigration', 'getStatus', 'cutover', 'rollback', 'cancel'];
    expect(methods.length).toBe(5);
  });

  it('mock online shard migration should implement interface', async () => {
    const config: IMigrationConfig = {
      shardId: 0,
      sourceNode: 'node-1',
      targetNode: 'node-2',
      batchSize: 1000,
      finalSyncTimeoutMs: 30000,
      pauseWritesOnCutover: true,
    };

    const mock: IOnlineShardMigration = {
      startMigration: vi.fn().mockResolvedValue({ migrationId: 'mig-1' }),
      getStatus: vi.fn().mockResolvedValue({ phase: 'incremental-sync', progress: 60, remainingBytes: 400_000_000 }),
      cutover: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    // Verify startMigration
    const { migrationId } = await mock.startMigration(config);
    expect(migrationId).toBe('mig-1');

    // Verify getStatus
    const status = await mock.getStatus('mig-1');
    expect(status.phase).toBe('incremental-sync');
    expect(status.progress).toBe(60);
    expect(status.remainingBytes).toBe(400_000_000);

    // Verify cutover
    await expect(mock.cutover('mig-1')).resolves.toBeUndefined();

    // Verify rollback
    await expect(mock.rollback('mig-1')).resolves.toBeUndefined();

    // Verify cancel
    await expect(mock.cancel('mig-1')).resolves.toBeUndefined();
  });

  it('should support migration lifecycle through all states', async () => {
    const config: IMigrationConfig = {
      shardId: 1,
      sourceNode: 'node-3',
      targetNode: 'node-4',
      batchSize: 500,
      finalSyncTimeoutMs: 60000,
      pauseWritesOnCutover: false,
    };

    const mock: IOnlineShardMigration = {
      startMigration: vi.fn().mockResolvedValue({ migrationId: 'mig-2' }),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ phase: 'snapshot-copy', progress: 10, remainingBytes: 900_000_000 })
        .mockResolvedValueOnce({ phase: 'incremental-sync', progress: 95, remainingBytes: 50_000_000 })
        .mockResolvedValueOnce({ phase: 'cutover', progress: 100, remainingBytes: 0 }),
      cutover: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const { migrationId } = await mock.startMigration(config);

    const status1 = await mock.getStatus(migrationId);
    expect(status1.phase).toBe('snapshot-copy');
    expect(status1.progress).toBe(10);

    const status2 = await mock.getStatus(migrationId);
    expect(status2.phase).toBe('incremental-sync');
    expect(status2.progress).toBe(95);

    const status3 = await mock.getStatus(migrationId);
    expect(status3.phase).toBe('cutover');
    expect(status3.progress).toBe(100);

    await mock.cutover(migrationId);
    expect(mock.cutover).toHaveBeenCalledWith(migrationId);
  });
});
