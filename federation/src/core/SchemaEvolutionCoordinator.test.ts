/**
 * SchemaEvolutionCoordinator Tests — Distributed schema change orchestration.
 *
 * Coverage:
 *   - propose success → result.success = true
 *   - rollback executes rollbackSql
 *   - getAppliedChanges returns history
 *   - partial failure returns failedShards
 *   - propose with multiple shards
 *   - rollback on unknown change throws
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchemaEvolutionCoordinator, type SchemaChange } from './SchemaEvolutionCoordinator';
import type { IMultiLeaderReplication } from '../interfaces/replication/IMultiLeaderReplication';

function mockReplication(): IMultiLeaderReplication {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    replicate: vi.fn().mockResolvedValue({ msgId: 'msg-1' }),
    getStatus: vi.fn(),
    retryFailed: vi.fn(),
    getPendingCounts: vi.fn(),
    onTargetConnected: vi.fn(),
    onTargetDisconnected: vi.fn(),
    onHighLag: vi.fn(),
  };
}

function makeChange(overrides: Partial<SchemaChange> & { id: string }): SchemaChange {
  return {
    sql: overrides.sql ?? 'ALTER TABLE users ADD COLUMN age INTEGER',
    version: overrides.version ?? 1,
    shards: overrides.shards ?? ['shard-0', 'shard-1'],
    rollbackSql: overrides.rollbackSql ?? 'ALTER TABLE users DROP COLUMN age',
    ...overrides,
  };
}

describe('SchemaEvolutionCoordinator', () => {
  let coordinator: SchemaEvolutionCoordinator;
  let replication: IMultiLeaderReplication;

  beforeEach(() => {
    replication = mockReplication();
    coordinator = new SchemaEvolutionCoordinator(replication);
  });

  describe('proposeChange', () => {
    it('should return success=true when all shards succeed', async () => {
      const change = makeChange({ id: 'v1-add-age' });
      const result = await coordinator.proposeChange(change);

      expect(result.success).toBe(true);
      expect(result.changeId).toBe('v1-add-age');
      expect(result.appliedShards).toEqual(['shard-0', 'shard-1']);
      expect(result.failedShards).toEqual([]);
    });

    it('should return failedShards when some shards fail', async () => {
      const mockRepl = mockReplication();
      const rejectFn = vi
        .fn()
        .mockResolvedValueOnce({ msgId: 'ok' }) // shard-0 succeeds
        .mockRejectedValueOnce(new Error('fail')); // shard-1 fails
      mockRepl.replicate = rejectFn;
      const coord = new SchemaEvolutionCoordinator(mockRepl);

      const change = makeChange({
        id: 'v2-add-col',
        shards: ['shard-0', 'shard-1'],
      });
      const result = await coord.proposeChange(change);

      expect(result.success).toBe(false);
      expect(result.appliedShards).toEqual(['shard-0']);
      expect(result.failedShards).toEqual(['shard-1']);
    });
  });

  describe('rollback', () => {
    it('should execute rollbackSql on previously applied change', async () => {
      const change = makeChange({ id: 'v3-rollback-test' });
      await coordinator.proposeChange(change);

      await coordinator.rollback('v3-rollback-test');

      // Should have been called for propose (2 shards) + rollback (2 shards) = 4 calls
      expect(replication.replicate).toHaveBeenCalledTimes(4);
    });

    it('should throw when rolling back an unknown change', async () => {
      await expect(coordinator.rollback('unknown-id')).rejects.toThrow('not found');
    });

    it('should throw when the change has no rollback SQL', async () => {
      const change = makeChange({
        id: 'v-no-rollback',
        rollbackSql: undefined,
      });
      await coordinator.proposeChange(change);

      await expect(coordinator.rollback('v-no-rollback')).rejects.toThrow('has no rollback SQL');
    });
  });

  describe('getAppliedChanges', () => {
    it('should return history of applied changes', async () => {
      const change1 = makeChange({ id: 'v1-first', version: 1 });
      const change2 = makeChange({ id: 'v2-second', version: 2 });

      await coordinator.proposeChange(change1);
      await coordinator.proposeChange(change2);

      const history = coordinator.getAppliedChanges();
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('v1-first');
      expect(history[1].id).toBe('v2-second');
    });

    it('should exclude rolled back changes from history', async () => {
      const change = makeChange({
        id: 'v-rollback-excl',
        version: 1,
        shards: ['shard-0'],
      });
      await coordinator.proposeChange(change);
      expect(coordinator.getAppliedChanges()).toHaveLength(1);

      await coordinator.rollback('v-rollback-excl');
      expect(coordinator.getAppliedChanges()).toHaveLength(0);
    });

    it('should replicate schema change with correct payload format', async () => {
      const change = makeChange({ id: 'v-format', shards: ['shard-0'] });
      await coordinator.proposeChange(change);

      expect(replication.replicate).toHaveBeenCalledWith(
        0,
        expect.stringContaining('__schemaChange'),
        'schema:v-format',
      );
    });
  });
});
