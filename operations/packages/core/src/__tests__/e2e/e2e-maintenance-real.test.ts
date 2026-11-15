/**
 * Parameterized E2E maintenance tests across all real engines.
 *
 * Tests vacuum, analyze, reindex, rebuild operations, deadlock detection,
 * slow query recording, connection monitoring, and alert rule management.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryAlertRuleManager } from '@agentix-e/db-operations-monitor';
import type { IAlertRuleManager } from '@agentix-e/db-operations-monitor';
import { IN_MEM_FACTORY, GRAPH_VEC_FACTORY, SQL_VEC_FACTORY, ENGINE_CASES } from './engineFactories.js';

/**
 * `IAlertRuleManager` does not declare `addRule`/`evaluateSnapshot` although
 * every engine factory returns an `InMemoryAlertRuleManager` that exposes them.
 * Narrow through `instanceof` rather than a cast so a factory that starts
 * returning something else fails loudly here.
 */
function asInMemoryAlertRuleManager(manager: IAlertRuleManager): InMemoryAlertRuleManager {
  if (!(manager instanceof InMemoryAlertRuleManager)) {
    throw new Error('expected the factory to return an InMemoryAlertRuleManager');
  }
  return manager;
}

const inMemFactory = IN_MEM_FACTORY;
const graphVecFactory = GRAPH_VEC_FACTORY;
const sqlVecFactory = SQL_VEC_FACTORY;

afterAll(async () => {
  await inMemFactory.cleanup();
  await sqlVecFactory.cleanup();
  await graphVecFactory.cleanup();
});

describe.each(ENGINE_CASES)('$name E2E: MaintenanceExecutor', ({ factory }) => {
  it('should create a maintenance executor', async () => {
    const exec = await factory.createMaintenanceExecutor();
    expect(exec).toBeDefined();
    expect(typeof exec.vacuum).toBe('function');
  });

  it('should execute vacuum successfully', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const result = await exec.vacuum({ target: '*', full: false });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('VACUUM');
  });

  it('should execute analyze successfully', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const result = await exec.analyze({ target: 'public.*' });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('ANALYZE');
  });

  it('should execute reindex successfully', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const result = await exec.reindex({ target: 'users_pkey', isTable: false });
    expect(result.success).toBe(true);
    expect(result.operation).toBe('REINDEX');
  });

  it('should get storage stats', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const stats = await exec.getStorageStats('*');
    expect(stats).toBeDefined();
  });

  it('should get index fragmentation', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const frag = await exec.getIndexFragmentation('*');
    expect(frag).toBeInstanceOf(Array);
  });

  it('should get auto-vacuum status', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const status = exec.getAutoVacuumStatus();
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('threshold');
  });

  it('should return details on successful operations', async () => {
    const exec = await factory.createMaintenanceExecutor();
    const result = await exec.vacuum({ target: '*' });
    expect(result.details).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: DeadlockDetector', ({ factory }) => {
  it('should create a deadlock detector', async () => {
    const detector = await factory.createDeadlockDetector();
    expect(detector).toBeDefined();
  });

  it('should return a deadlock history (possibly empty)', async () => {
    const detector = await factory.createDeadlockDetector();
    const history = await detector.getDeadlockHistory();
    expect(history).toBeInstanceOf(Array);
  });
});

describe.each(ENGINE_CASES)('$name E2E: SlowQueryRecorder', ({ factory }) => {
  it('should create a slow query recorder', async () => {
    const recorder = await factory.createSlowQueryRecorder();
    expect(recorder).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: ConnectionMonitor', ({ factory }) => {
  it('should create a connection monitor', async () => {
    const monitor = await factory.createConnectionMonitor();
    expect(monitor).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: AlertRuleManager', ({ factory }) => {
  it('should create an alert rule manager', async () => {
    const mgr = await factory.createAlertRuleManager();
    expect(mgr).toBeDefined();
    expect(typeof asInMemoryAlertRuleManager(mgr).addRule).toBe('function');
  });

  it('should add and evaluate alert rules', async () => {
    const mgr = await factory.createAlertRuleManager();
    const r1 = await mgr.createRule({
      name: 'high-error-rate',
      metric: 'errors_per_sec',
      condition: 'gt',
      threshold: 10,
      durationMs: 60000,
      severity: 'critical',
      enabled: true,
    });
    const r2 = await mgr.createRule({
      name: 'latency-spike',
      metric: 'latency_p99',
      condition: 'gt',
      threshold: 500,
      durationMs: 30000,
      severity: 'warning',
      enabled: true,
    });
    expect(r1).toBeDefined();
    expect(r2).not.toBe(r1);
  });

  it('should evaluate alert rules', async () => {
    const mgr = await factory.createAlertRuleManager();
    await mgr.createRule({
      name: 'cpu-high',
      metric: 'cpu_usage',
      condition: 'gt',
      threshold: 90,
      durationMs: 60000,
      severity: 'warning',
      enabled: true,
    });
    // A snapshot is the input an alert rule needs. The interface used to offer
    // `evaluate()` with no argument, which this case could only assert was an
    // array — an assertion no implementation could fail.
    expect(mgr.evaluateSnapshot({ cpu_usage: 95 })).toHaveLength(1);
    expect(mgr.evaluateSnapshot({ cpu_usage: 50 })).toHaveLength(0);
  });
});
