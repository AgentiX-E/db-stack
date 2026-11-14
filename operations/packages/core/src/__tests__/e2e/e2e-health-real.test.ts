/**
 * Parameterized E2E health probe tests across all real engines.
 *
 * Each engine factory produces a REAL IHealthProbe that wraps native
 * engine infrastructure. Tests verify the bridge contract works.
 *
 * Note: ProbeResult.message is optional per the interface. Some adapters
 * (like InMemory's ComponentProbe) may not produce it for simple probes.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  IN_MEM_FACTORY,
  GRAPH_VEC_FACTORY,
  SQL_VEC_FACTORY,
  ENGINE_CASES,
} from './engineFactories.js';

const inMemFactory = IN_MEM_FACTORY;
const graphVecFactory = GRAPH_VEC_FACTORY;
const sqlVecFactory = SQL_VEC_FACTORY;

afterAll(async () => {
  await inMemFactory.cleanup();
  await sqlVecFactory.cleanup();
  await graphVecFactory.cleanup();
});

describe.each(ENGINE_CASES)('$name E2E: HealthProbe', ({ factory }) => {
  it('should create a health probe', async () => {
    const probe = await factory.createHealthProbe();
    expect(probe).toBeDefined();
    expect(typeof probe.liveness).toBe('function');
    expect(typeof probe.readiness).toBe('function');
    expect(typeof probe.startup).toBe('function');
  });

  it('should report liveness as ok', async () => {
    const probe = await factory.createHealthProbe();
    const result = probe.liveness();
    expect(result.ok).toBe(true);
  });

  it('should report readiness as ok', async () => {
    const probe = await factory.createHealthProbe();
    const result = await probe.readiness();
    expect(result.ok).toBe(true);
  });

  it('should report startup as complete', async () => {
    const probe = await factory.createHealthProbe();
    const result = await probe.startup();
    expect(result.ok).toBe(true);
  });

  it('should expose probeId', async () => {
    const probe = await factory.createHealthProbe();
    expect(probe.probeId).toBeDefined();
    expect(typeof probe.probeId).toBe('string');
    expect(probe.probeId.length).toBeGreaterThan(0);
  });

  it('should expose componentName', async () => {
    const probe = await factory.createHealthProbe();
    expect(probe.componentName).toBeDefined();
    expect(typeof probe.componentName).toBe('string');
  });

  it('should handle multiple liveness calls idempotently', async () => {
    const probe = await factory.createHealthProbe();
    const r1 = probe.liveness();
    const r2 = probe.liveness();
    const r3 = probe.liveness();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
  });

  it('should handle concurrent readiness calls', async () => {
    const probe = await factory.createHealthProbe();
    const results = await Promise.all([
      probe.readiness(),
      probe.readiness(),
      probe.readiness(),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  it('should not throw on liveness when engine is healthy', async () => {
    const probe = await factory.createHealthProbe();
    expect(() => probe.liveness()).not.toThrow();
  });

  it('should provide details in startup result when available', async () => {
    const probe = await factory.createHealthProbe();
    const result = await probe.startup();
    expect(result).toHaveProperty('ok');
  });

  it('liveness result should have {ok:boolean} shape', async () => {
    const probe = await factory.createHealthProbe();
    const result = probe.liveness();
    expect(Object.keys(result)).toContain('ok');
    expect(typeof result.ok).toBe('boolean');
  });

  it('liveness should return deterministic results', async () => {
    const probe = await factory.createHealthProbe();
    const r1 = probe.liveness();
    const r2 = probe.liveness();
    expect(r1.ok).toBe(r2.ok);
  });

  it('readiness should return deterministic results', async () => {
    const probe = await factory.createHealthProbe();
    const r1 = await probe.readiness();
    const r2 = await probe.readiness();
    expect(r1.ok).toBe(r2.ok);
  });

  it('should have ProbeResult shape', async () => {
    const probe = await factory.createHealthProbe();
    const lr = probe.liveness();
    expect(typeof lr.ok).toBe('boolean');
    expect(lr).toHaveProperty('ok');
  });
});

describe.each(ENGINE_CASES)('$name E2E: HealthOrchestrator', ({ factory }) => {
  it('should create health orchestrator', () => {
    const orch = factory.createHealthOrchestrator();
    expect(orch).toBeDefined();
  });

  it('should register functional probes', () => {
    const orch = factory.createHealthOrchestrator();
    expect(typeof orch.registerFunctional).toBe('function');
  });

  it('should evaluate liveness across registered probes', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('test-probe', 'Test', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    const status = orch.liveness();
    expect(status).toBeDefined();
    expect(status.ok).toBe(true);
  });

  it('should return component health array', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('test-probe', 'Test', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    const compHealth = orch.getComponentHealth();
    expect(Array.isArray(compHealth)).toBe(true);
  });

  it('should produce a summary string', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('test-probe', 'Test', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    const summary = orch.getSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('should return aggregate status', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('test-probe', 'Test', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    const status = orch.getAggregateStatus();
    expect(status).toHaveProperty('status');
    expect(status).toHaveProperty('count');
  });
});
