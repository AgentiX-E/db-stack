/**
 * InMemoryMaintenanceExecutor.test.ts — Tests for InMemoryMaintenanceExecutor.
 *
 * Covers all maintenance operations with simulated storage stats and
 * fragmentation tracking.
 *
 * Acceptance criteria verified:
 *   M1 – vacuum dry run returns success without side effects
 *   M2 – vacuum full reduces free space ratio
 *   M3 – vacuum with target is reflected in result target field
 *   M4 – vacuum FULL reduces pageCount (simulated)
 *   M5 – analyze returns success with operation='ANALYZE'
 *   M6 – reindex returns success with operation='REINDEX'
 *   M7 – reindex target matches input
 *   M8 – getStorageStats returns all fields populated
 *   M9 – getIndexFragmentation returns array
 *   M10 – getAutoVacuumStatus returns { enabled: true, threshold: number }
 *   M11 – operation duration >= 0
 *   M12 – opsLog tracks history
 *   M13 – repeated operations idempotent
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryMaintenanceExecutor } from '../impl/InMemoryMaintenanceExecutor.js';

describe('InMemoryMaintenanceExecutor', () => {
  let executor: InMemoryMaintenanceExecutor;

  beforeEach(() => {
    executor = new InMemoryMaintenanceExecutor();
  });

  // ── M1: vacuum dry run ────────────────────────────────────────────

  it('M1: vacuum dry run returns success without side effects', async () => {
    const statsBefore = await executor.getStorageStats('*');
    const freeSpaceBefore = statsBefore.freeSpaceRatio;
    const deadRowBefore = statsBefore.deadRowCount;

    const result = await executor.vacuum({ target: 'table_orders', dryRun: true });

    expect(result.success).toBe(true);
    expect(result.operation).toBe('VACUUM');
    expect(result.message).toContain('[dry-run]');
    expect(result.durationMs).toBe(0);
    expect(result.details).toHaveProperty('dryRun', true);

    // No side effects
    const statsAfter = await executor.getStorageStats('*');
    expect(statsAfter.freeSpaceRatio).toBe(freeSpaceBefore);
    expect(statsAfter.deadRowCount).toBe(deadRowBefore);
    expect(statsAfter.pageCount).toBe(statsBefore.pageCount);
  });

  // ── M2: vacuum full reduces free space ratio ──────────────────────

  it('M2: vacuum full reduces free space ratio', async () => {
    const statsBefore = await executor.getStorageStats('*');
    expect(statsBefore.freeSpaceRatio).toBeGreaterThan(0);

    await executor.vacuum({ target: '*', full: true });

    const statsAfter = await executor.getStorageStats('*');
    expect(statsAfter.freeSpaceRatio).toBeLessThan(statsBefore.freeSpaceRatio);
  });

  // ── M3: vacuum with target ────────────────────────────────────────

  it('M3: vacuum with target is reflected in result target field', async () => {
    const result = await executor.vacuum({ target: 'shard-007' });
    expect(result.target).toBe('shard-007');
  });

  // ── M4: vacuum FULL reduces pageCount ─────────────────────────────

  it('M4: vacuum FULL reduces pageCount (simulated)', async () => {
    const statsBefore = await executor.getStorageStats('*');
    const pageCountBefore = statsBefore.pageCount;

    await executor.vacuum({ target: '*', full: true });

    const statsAfter = await executor.getStorageStats('*');
    expect(statsAfter.pageCount).toBeLessThan(pageCountBefore);
    // Verify file size is recalculated based on new page count
    expect(statsAfter.fileSizeBytes).toBe(statsAfter.pageCount * statsAfter.pageSize);
  });

  // ── M5: analyze returns success ────────────────────────────────────

  it('M5: analyze returns success with operation=ANALYZE', async () => {
    const result = await executor.analyze({ target: 'table_users' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('ANALYZE');
    expect(result.message).toBe('Analyzed table_users');
  });

  // ── M6: reindex returns success ────────────────────────────────────

  it('M6: reindex returns success with operation=REINDEX', async () => {
    const result = await executor.reindex({ target: 'idx_users_email' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('REINDEX');
  });

  // ── M7: reindex target matches input ──────────────────────────────

  it('M7: reindex target matches input', async () => {
    const result = await executor.reindex({ target: 'idx_orders_user_id' });
    expect(result.target).toBe('idx_orders_user_id');
  });

  it('reindex table target sets corresponding message', async () => {
    const result = await executor.reindex({ target: 'orders', isTable: true });
    expect(result.message).toContain('REINDEX table');
    expect(result.details).toHaveProperty('isTable', true);
  });

  // ── M8: getStorageStats returns all fields ─────────────────────────

  it('M8: getStorageStats returns all fields populated', async () => {
    const stats = await executor.getStorageStats('*');
    expect(stats).toHaveProperty('fileSizeBytes');
    expect(stats).toHaveProperty('pageCount');
    expect(stats).toHaveProperty('pageSize');
    expect(stats).toHaveProperty('rowCount');
    expect(stats).toHaveProperty('deadRowCount');
    expect(stats).toHaveProperty('freeSpaceRatio');

    expect(stats.fileSizeBytes).toBeGreaterThan(0);
    expect(stats.pageCount).toBeGreaterThan(0);
    expect(stats.pageSize).toBeGreaterThan(0);
    expect(stats.rowCount).toBeGreaterThan(0);
    expect(stats.deadRowCount).toBeGreaterThan(0);
    expect(typeof stats.freeSpaceRatio).toBe('number');
  });

  // ── M9: getIndexFragmentation returns array ────────────────────────

  it('M9: getIndexFragmentation returns array', async () => {
    const frag = await executor.getIndexFragmentation('*');
    expect(Array.isArray(frag)).toBe(true);
    expect(frag.length).toBeGreaterThan(0);
  });

  it('getIndexFragmentation filters by table name', async () => {
    const frag = await executor.getIndexFragmentation('users');
    expect(frag.length).toBe(1);
    expect(frag[0].tableName).toBe('users');
  });

  it('getIndexFragmentation filters by index name', async () => {
    const frag = await executor.getIndexFragmentation('idx_orders_user_id');
    expect(frag.length).toBe(1);
    expect(frag[0].indexName).toBe('idx_orders_user_id');
  });

  // ── M10: getAutoVacuumStatus returns config ────────────────────────

  it('M10: getAutoVacuumStatus returns { enabled: true, threshold: number }', () => {
    const status = executor.getAutoVacuumStatus();
    expect(status).toHaveProperty('enabled', true);
    expect(status).toHaveProperty('threshold');
    expect(typeof status.threshold).toBe('number');
    expect(status.threshold).toBe(200);
  });

  it('custom auto-vacuum config is respected', () => {
    const custom = new InMemoryMaintenanceExecutor(undefined, undefined, false, 500);
    const status = custom.getAutoVacuumStatus();
    expect(status.enabled).toBe(false);
    expect(status.threshold).toBe(500);
  });

  // ── M11: operation duration >= 0 ──────────────────────────────────

  it('M11: operation durationMs >= 0 for vacuum', async () => {
    const result = await executor.vacuum({ target: '*' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('M11: operation durationMs >= 0 for analyze', async () => {
    const result = await executor.analyze({ target: '*' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('M11: operation durationMs >= 0 for reindex', async () => {
    const result = await executor.reindex({ target: 'idx_users_email' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── M12: opsLog tracks history ─────────────────────────────────────

  it('M12: opsLog starts empty', () => {
    expect(executor.opsLog).toHaveLength(0);
  });

  it('M12: opsLog accumulates vacuum operations', async () => {
    await executor.vacuum({ target: '*' });
    await executor.vacuum({ target: 'table_a', full: true });

    const log = executor.opsLog;
    expect(log).toHaveLength(2);
    expect(log[0].operation).toBe('VACUUM');
    expect(log[1].operation).toBe('VACUUM');
  });

  it('M12: opsLog accumulates all operation types', async () => {
    await executor.vacuum({ target: '*' });
    await executor.analyze({ target: 't1' });
    await executor.reindex({ target: 'idx_x' });

    const log = executor.opsLog;
    expect(log).toHaveLength(3);
    expect(log.map((l) => l.operation)).toEqual(['VACUUM', 'ANALYZE', 'REINDEX']);
  });

  it('M12: dry-run vacuum is also logged', async () => {
    await executor.vacuum({ target: '*', dryRun: true });
    const log = executor.opsLog;
    expect(log).toHaveLength(1);
    expect(log[0].details).toHaveProperty('dryRun', true);
  });

  // ── M13: repeated operations idempotent ────────────────────────────

  it('M13: repeated vacuum calls are safe (no crash, always success)', async () => {
    const r1 = await executor.vacuum({ target: '*', full: true });
    const r2 = await executor.vacuum({ target: '*', full: true });
    const r3 = await executor.vacuum({ target: '*', full: true });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
  });

  it('M13: repeated analyze calls are safe and idempotent', async () => {
    const r1 = await executor.analyze({ target: 'table_orders' });
    const r2 = await executor.analyze({ target: 'table_orders' });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.operation).toBe('ANALYZE');
    expect(r2.operation).toBe('ANALYZE');
  });

  it('M13: repeated reindex calls are safe and keep fragmentation low', async () => {
    await executor.reindex({ target: 'idx_users_email' });
    const fragAfterFirst = await executor.getIndexFragmentation('idx_users_email');
    const ratioAfterFirst = fragAfterFirst[0].fragmentationRatio;

    // Second reindex should keep ratio at or below first reindex result
    await executor.reindex({ target: 'idx_users_email' });
    const fragAfterSecond = await executor.getIndexFragmentation('idx_users_email');
    const ratioAfterSecond = fragAfterSecond[0].fragmentationRatio;

    expect(ratioAfterSecond).toBeLessThanOrEqual(ratioAfterFirst);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('accepts custom initial storage stats', async () => {
    const custom = new InMemoryMaintenanceExecutor({
      fileSizeBytes: 10_000,
      pageCount: 50,
      pageSize: 4096,
      rowCount: 1000,
      deadRowCount: 500,
      freeSpaceRatio: 0.7,
    });

    const stats = await custom.getStorageStats('*');
    expect(stats.freeSpaceRatio).toBe(0.7);
    expect(stats.pageCount).toBe(50);
  });

  it('accepts custom initial fragmentation', async () => {
    const customFrag: import('@agentix-e/db-operations-core/types').IndexFragmentation[] = [
      { indexName: 'idx_custom', tableName: 'custom_tbl', pageCount: 500, fragmentationRatio: 0.9 },
    ];
    const custom = new InMemoryMaintenanceExecutor(undefined, customFrag);

    const frag = await custom.getIndexFragmentation('*');
    expect(frag).toHaveLength(1);
    expect(frag[0].indexName).toBe('idx_custom');
    expect(frag[0].fragmentationRatio).toBe(0.9);
  });

  it('vacuum incremental (non-full) reduces free space but not pageCount', async () => {
    const statsBefore = await executor.getStorageStats('*');
    const pageBefore = statsBefore.pageCount;

    const result = await executor.vacuum({ target: '*', full: false });

    expect(result.success).toBe(true);
    expect(result.details).toHaveProperty('full', false);

    const statsAfter = await executor.getStorageStats('*');
    expect(statsAfter.freeSpaceRatio).toBeLessThan(statsBefore.freeSpaceRatio);
    // Incremental vacuum should NOT reduce page count
    expect(statsAfter.pageCount).toBe(pageBefore);
  });

  it('reindex reduces fragmentation for matching table when isTable=true', async () => {
    const fragBefore = await executor.getIndexFragmentation('orders');
    const ratiosBefore = fragBefore.map((f) => f.fragmentationRatio);

    await executor.reindex({ target: 'orders', isTable: true });

    const fragAfter = await executor.getIndexFragmentation('orders');
    const ratiosAfter = fragAfter.map((f) => f.fragmentationRatio);

    // All indexes on 'orders' should have reduced fragmentation
    for (let i = 0; i < ratiosBefore.length; i++) {
      expect(ratiosAfter[i]).toBeLessThan(ratiosBefore[i]);
    }
  });

  it('opsLog is a snapshot (cannot mutate internal state)', () => {
    const log = executor.opsLog;
    expect(log).toHaveLength(0);
    // Modifying the returned array should not affect internal state
    (log as any[]).push({ test: true });
    expect(executor.opsLog).toHaveLength(0);
  });

  // ── Precise default-flag + elapsed-time assertions (kill survivors) ──

  it('dry-run vacuum defaults full to false when omitted', async () => {
    const result = await executor.vacuum({ target: 't', dryRun: true });
    expect(result.details).toHaveProperty('full', false);
  });

  it('non-dry-run vacuum reports dryRun=false and full reflects input', async () => {
    const result = await executor.vacuum({ target: 't' }); // no full, no dryRun
    expect(result.details).toHaveProperty('dryRun', false);
    expect(result.details).toHaveProperty('full', false);
    expect(result.message).toContain('VACUUM completed'); // non-full path
  });

  it('analyze defaults dryRun to false when omitted', async () => {
    const result = await executor.analyze({ target: 't' });
    expect(result.details).toHaveProperty('dryRun', false);
  });

  it('reindex defaults dryRun and isTable to false when omitted', async () => {
    const result = await executor.reindex({ target: 'idx_users_email' });
    expect(result.details).toHaveProperty('dryRun', false);
    expect(result.details).toHaveProperty('isTable', false);
  });

  it('reindex does NOT match by tableName when isTable is falsy', async () => {
    const before = await executor.getIndexFragmentation('orders');
    const ratiosBefore = before.map((f) => f.fragmentationRatio);

    // target 'orders' matches a tableName, but without isTable only indexName is compared
    await executor.reindex({ target: 'orders' });

    const after = await executor.getIndexFragmentation('orders');
    const ratiosAfter = after.map((f) => f.fragmentationRatio);
    expect(ratiosAfter).toEqual(ratiosBefore); // unchanged — no match by table when isTable is falsy
  });

  it('vacuum reports exact elapsed milliseconds', async () => {
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_042);
    const result = await executor.vacuum({ target: '*' });
    expect(result.durationMs).toBe(42);
    spy.mockRestore();
  });

  it('reindex reports exact elapsed milliseconds', async () => {
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(20_007);
    const result = await executor.reindex({ target: 'idx_x' });
    expect(result.durationMs).toBe(7);
    spy.mockRestore();
  });
});
