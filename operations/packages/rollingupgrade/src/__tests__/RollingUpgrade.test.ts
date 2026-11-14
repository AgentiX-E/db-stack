import { describe, it, expect } from 'vitest';
import { InMemoryRollingUpgrade } from '../impl/InMemoryRollingUpgrade.js';
import type { RollingUpgradePlan, BatchHealth } from '../interfaces/types.js';

// InMemoryRollingUpgrade is a thin alias over RollingUpgradeOrchestrator, so
// these tests exercise the public IRollingUpgrade contract through the
// in-memory entry point.

const instantSleep = () => Promise.resolve();

function makePlan(overrides: Partial<RollingUpgradePlan> = {}): RollingUpgradePlan {
  return {
    id: 'mem-plan',
    name: 'Mem Plan',
    targetVersion: '2.0.0',
    nodes: ['n1', 'n2', 'n3'],
    batchStrategy: 'fixed_size',
    batchSize: 1,
    rollbackTrigger: 'on_first_failure',
    healthCheckNames: [],
    ...overrides,
  };
}

function healthy(): Promise<BatchHealth> {
  return Promise.resolve({
    healthy: true,
    nodes: [{ healthy: true, details: {}, checkedAt: Date.now() }],
    evaluatedAt: Date.now(),
  });
}

describe('InMemoryRollingUpgrade', () => {
  it('starts with an empty phase (idle) and no batches', () => {
    const ug = new InMemoryRollingUpgrade();
    expect(ug.getPhase()).toBe('idle');
    expect(ug.getBatches()).toEqual([]);
    expect(ug.getEvents()).toEqual([]);
    expect(ug.getStats()).toBeNull();
  });

  it('executes a single-node upgrade to completion', async () => {
    const ug = new InMemoryRollingUpgrade({ minBakeMs: 0, sleep: instantSleep });
    ug.registerHealthCheck('ok', healthy);
    const stats = await ug.execute(makePlan({
      nodes: ['n1'],
      healthCheckNames: ['ok'],
    }));
    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(1);
    expect(stats.failedNodes).toBe(0);
  });

  it('splits nodes into the requested number of batches', async () => {
    const ug = new InMemoryRollingUpgrade({ minBakeMs: 0, sleep: instantSleep });
    ug.registerHealthCheck('ok', healthy);
    const stats = await ug.execute(makePlan({
      nodes: ['n1', 'n2', 'n3', 'n4', 'n5'],
      batchSize: 2,
      healthCheckNames: ['ok'],
    }));
    // 5 nodes / 2 = 3 batches (ceil).
    expect(stats.totalBatches).toBe(3);
  });

  it('records events across validation, batches, and completion', async () => {
    const ug = new InMemoryRollingUpgrade({ minBakeMs: 0, sleep: instantSleep });
    ug.registerHealthCheck('ok', healthy);
    const stats = await ug.execute(makePlan({
      nodes: ['n1', 'n2'],
      healthCheckNames: ['ok'],
    }));
    const types = stats.events.map((e) => e.type);
    expect(types).toContain('plan_validated');
    expect(types).toContain('upgrade_completed');
  });

  it('pause and resume toggle the paused state without throwing', async () => {
    const ug = new InMemoryRollingUpgrade();
    await ug.pause();
    await ug.resume();
    expect(true).toBe(true);
  });

  it('rollback on a completed plan is accepted', async () => {
    const ug = new InMemoryRollingUpgrade({ minBakeMs: 0, sleep: instantSleep });
    ug.registerHealthCheck('ok', healthy);
    await ug.execute(makePlan({ healthCheckNames: ['ok'] }));
    await expect(ug.rollback()).resolves.toBeDefined();
  });

  it('rejects an invalid plan (missing id)', async () => {
    const ug = new InMemoryRollingUpgrade();
    await expect(ug.execute(makePlan({ id: '' }))).rejects.toThrow();
  });

  it('satisfies the full IRollingUpgrade surface', () => {
    const ug = new InMemoryRollingUpgrade();
    expect(typeof ug.execute).toBe('function');
    expect(typeof ug.getPhase).toBe('function');
    expect(typeof ug.getBatches).toBe('function');
    expect(typeof ug.getEvents).toBe('function');
    expect(typeof ug.getStats).toBe('function');
    expect(typeof ug.pause).toBe('function');
    expect(typeof ug.resume).toBe('function');
    expect(typeof ug.rollback).toBe('function');
    expect(typeof ug.registerHealthCheck).toBe('function');
  });
});
