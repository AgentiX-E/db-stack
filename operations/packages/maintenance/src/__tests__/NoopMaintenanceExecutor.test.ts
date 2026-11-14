/**
 * NoopMaintenanceExecutor.test.ts — Tests for NoopMaintenanceExecutor.
 *
 * Covers all maintenance operations returning fixed/empty results.
 */

import { describe, it, expect } from 'vitest';
import { NoopMaintenanceExecutor } from '../impl/NoopMaintenanceExecutor.js';

describe('NoopMaintenanceExecutor', () => {
  let executor: NoopMaintenanceExecutor;

  beforeEach(() => {
    executor = new NoopMaintenanceExecutor();
  });

  it('vacuum returns success with VACUUM operation', async () => {
    const result = await executor.vacuum({ target: '*' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('VACUUM');
    expect(result.target).toBe('*');
  });

  it('vacuum dryRun returns success without side effects', async () => {
    const result = await executor.vacuum({ target: 'table_orders', dryRun: true });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('VACUUM');
    expect(result.details).toHaveProperty('dryRun', true);
    expect(result.message).toContain('[dry-run]');
  });

  it('vacuum with target applies target field', async () => {
    const result = await executor.vacuum({ target: 'shard-001' });
    expect(result.target).toBe('shard-001');
  });

  it('vacuum full sets full flag in details', async () => {
    const result = await executor.vacuum({ target: '*', full: true });
    expect(result.details).toHaveProperty('full', true);
  });

  it('analyze returns valid result', async () => {
    const result = await executor.analyze({ target: 'table_users' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('ANALYZE');
    expect(result.target).toBe('table_users');
    expect(result.message).toContain('ANALYZE completed');
  });

  it('reindex returns valid result', async () => {
    const result = await executor.reindex({ target: 'idx_users_email' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('REINDEX');
    expect(result.target).toBe('idx_users_email');
    expect(result.message).toContain('REINDEX index');
  });

  it('reindex with isTable=true uses table message', async () => {
    const result = await executor.reindex({ target: 'users', isTable: true });
    expect(result.message).toContain('REINDEX table');
    expect(result.details).toHaveProperty('isTable', true);
  });

  it('getStorageStats returns valid stats', async () => {
    const stats = await executor.getStorageStats('*');
    expect(stats).toHaveProperty('fileSizeBytes');
    expect(stats).toHaveProperty('pageCount');
    expect(stats).toHaveProperty('pageSize');
    expect(stats).toHaveProperty('rowCount');
    expect(stats).toHaveProperty('deadRowCount');
    expect(stats).toHaveProperty('freeSpaceRatio');
    expect(stats.pageSize).toBe(4096);
  });

  it('getIndexFragmentation returns empty array', async () => {
    const frag = await executor.getIndexFragmentation('*');
    expect(Array.isArray(frag)).toBe(true);
    expect(frag).toHaveLength(0);
  });

  it('getAutoVacuumStatus returns config', () => {
    const status = executor.getAutoVacuumStatus();
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('threshold');
    expect(status.enabled).toBe(true);
    expect(status.threshold).toBe(200);
  });

  it('custom auto-vacuum config is respected', () => {
    const custom = new NoopMaintenanceExecutor(false, 500);
    const status = custom.getAutoVacuumStatus();
    expect(status.enabled).toBe(false);
    expect(status.threshold).toBe(500);
  });

  // ── Default false when flags omitted (kills `?? false` → `?? true`) ──

  it('vacuum defaults dryRun and full to false when omitted', async () => {
    const result = await executor.vacuum({ target: '*' });
    expect(result.details).toHaveProperty('dryRun', false);
    expect(result.details).toHaveProperty('full', false);
  });

  it('analyze defaults dryRun to false when omitted', async () => {
    const result = await executor.analyze({ target: 't' });
    expect(result.details).toHaveProperty('dryRun', false);
  });

  it('reindex defaults dryRun and isTable to false when omitted', async () => {
    const result = await executor.reindex({ target: 'idx' });
    expect(result.details).toHaveProperty('dryRun', false);
    expect(result.details).toHaveProperty('isTable', false);
  });
});
