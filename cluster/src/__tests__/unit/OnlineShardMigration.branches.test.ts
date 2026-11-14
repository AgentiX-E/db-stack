/**
 * OnlineShardMigration — branch completion tests.
 *
 * i22-resharding.test.ts covers the lifecycle, cutover, rollback, cancel, and
 * listing happy paths, but leaves a few branches unreached:
 *   - reset (entire method — FNDA 0)
 *   - runMigration's .catch failure branch (async migration rejection)
 *   - cutover "not found" throw
 *   - cancel "not found" throw
 *
 * These tests close each remaining branch. The async migration's defensive
 * .catch is triggered by spying delayMs to reject, simulating a timer failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnlineShardMigration } from '../../shard/OnlineShardMigration';

function asAny(m: OnlineShardMigration): any {
  return m as any;
}

function config(overrides: Partial<any> = {}): any {
  return {
    shardId: 4,
    sourceNode: 'node-a',
    targetNode: 'node-b',
    batchSize: 1024,
    finalSyncTimeoutMs: 100,
    pauseWritesOnCutover: false,
    ...overrides,
  };
}

describe('OnlineShardMigration — branch completion', () => {
  let migration: OnlineShardMigration;

  beforeEach(() => {
    migration = new OnlineShardMigration();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reset', () => {
    it('clears all migrations and suspended writes', async () => {
      const { migrationId } = await migration.startMigration(config());

      // Suspend writes manually to exercise the writeSuspended cleanup.
      asAny(migration).writeSuspended.add(migrationId);

      expect(migration.listMigrations()).toHaveLength(1);
      expect(migration.areWritesSuspended(migrationId)).toBe(true);

      migration.reset();

      expect(migration.listMigrations()).toEqual([]);
      expect(migration.getActiveMigrationCount()).toBe(0);
      expect(migration.areWritesSuspended(migrationId)).toBe(false);
    });
  });

  describe('cutover not found', () => {
    it('throws for an unknown migration', async () => {
      await expect(migration.cutover('ghost')).rejects.toThrow(
        'migration ghost not found',
      );
    });
  });

  describe('cancel not found', () => {
    it('throws for an unknown migration', async () => {
      await expect(migration.cancel('ghost')).rejects.toThrow(
        'migration ghost not found',
      );
    });
  });

  describe('runMigration failure catch', () => {
    it('marks the migration failed and records the error when the async run rejects', async () => {
      // Force the async migration to reject by making delayMs reject.
      vi.spyOn(asAny(migration), 'delayMs').mockRejectedValue(
        new Error('timer exploded'),
      );

      const { migrationId } = await migration.startMigration(config());

      await vi.waitFor(() => {
        const state = asAny(migration).migrations.get(migrationId);
        expect(state.phase).toBe('failed');
      });

      const state = asAny(migration).migrations.get(migrationId);
      expect(state.phase).toBe('failed');
      expect(state.error).toContain('timer exploded');
    });
  });
});
