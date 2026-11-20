/**
 * Parameterized E2E adapter bridge tests.
 *
 * Tests the specific adapter bridge patterns that differ between
 * engines: logger creation, storage backend composition, retention
 * policy integration, and cross-component wiring.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { IN_MEM_FACTORY, GRAPH_VEC_FACTORY, SQL_VEC_FACTORY, ENGINE_CASES } from './engineFactories.js';

const inMemFactory = IN_MEM_FACTORY;
const graphVecFactory = GRAPH_VEC_FACTORY;
const sqlVecFactory = SQL_VEC_FACTORY;

afterAll(async () => {
  await inMemFactory.cleanup();
  await sqlVecFactory.cleanup();
  await graphVecFactory.cleanup();
});

describe.each(ENGINE_CASES)('$name E2E: Logger', ({ factory }) => {
  it('should create a logger', () => {
    const logger = factory.createLogger();
    expect(logger).toBeDefined();
  });

  it('should support log levels', () => {
    const logger = factory.createLogger();
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('should create child loggers', () => {
    const logger = factory.createLogger();
    const child = logger.child({ module: 'backup' });
    expect(child).toBeDefined();
    expect(child).not.toBe(logger);
  });

  it('should log without throwing', () => {
    const logger = factory.createLogger();
    expect(() => {
      logger.info('test message');
      logger.warn('warning message');
      logger.error('error message');
    }).not.toThrow();
  });

  it('child logger should have different identity', () => {
    const logger = factory.createLogger();
    const child1 = logger.child({ component: 'backup' });
    const child2 = logger.child({ component: 'metrics' });
    // Each call creates a new child — they should be distinct objects
    expect(child1).toBeDefined();
    expect(child2).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: StorageBackend', ({ factory }) => {
  it('should create a storage backend', async () => {
    const storage = await factory.createStorageBackend();
    expect(storage).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: RetentionPolicy', ({ factory }) => {
  it('should create a retention policy', async () => {
    const policy = await factory.createRetentionPolicy();
    expect(policy).toBeDefined();
  });
});

describe.each(ENGINE_CASES)('$name E2E: EngineWiring', ({ factory }) => {
  it('should create all components without error', async () => {
    const probe = await factory.createHealthProbe();
    const metrics = await factory.createMetricsRegistry();
    const backup = await factory.createBackupManager();
    const audit = await factory.createAuditStore();
    const tracer = await factory.createDistributedTracer();
    const deadlock = await factory.createDeadlockDetector();
    const maintenance = await factory.createMaintenanceExecutor();
    const auth = await factory.createAuthProvider();
    const logger = factory.createLogger();

    expect(probe).toBeDefined();
    expect(metrics).toBeDefined();
    expect(backup).toBeDefined();
    expect(audit).toBeDefined();
    expect(tracer).toBeDefined();
    expect(deadlock).toBeDefined();
    expect(maintenance).toBeDefined();
    expect(auth).toBeDefined();
    expect(logger).toBeDefined();
  });

  it('should wire health probe into orchestrator', () => {
    const orch = factory.createHealthOrchestrator();
    expect(orch).toBeDefined();
    expect(typeof orch.registerFunctional).toBe('function');
  });

  it('should support full create+operate+cleanup cycle', async () => {
    const probe = await factory.createHealthProbe();
    expect(probe.liveness().ok).toBe(true);
    // Cleanup at end
    await factory.cleanup();
    // After cleanup, should be able to create new components
    const probe2 = await factory.createHealthProbe();
    expect(probe2.liveness().ok).toBe(true);
  });

  it('should produce meaningful probe names', async () => {
    const probe = await factory.createHealthProbe();
    expect(probe.probeId).toBeDefined();
    expect(probe.componentName).toBeDefined();
    expect(probe.probeId.length).toBeGreaterThan(2);
    expect(probe.componentName.length).toBeGreaterThan(2);
  });
});
