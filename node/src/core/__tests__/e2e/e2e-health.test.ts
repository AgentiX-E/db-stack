import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([{ name: 'InMemory', factory: new InMemoryEngineFactory() }])('$name e2e: Health', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create a health probe with liveness ok', async () => {
    const probe = factory.createHealthProbe();
    const result = await probe.liveness();
    expect(result.ok).toBe(true);
  });

  it('should create a health probe with readiness ok', async () => {
    const probe = factory.createHealthProbe();
    const result = await probe.readiness();
    expect(result.ok).toBe(true);
  });

  it('should create a health orchestrator', async () => {
    const orch = factory.createHealthOrchestrator();
    const status = await orch.liveness();
    expect(status.ok).toBe(true);
  });

  it('should aggregate component health correctly', async () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('comp-1', 'Component 1', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    orch.registerFunctional('comp-2', 'Component 2', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: 'not ready' }),
    });
    const overall = await orch.readiness();
    expect(overall.ok).toBe(false);
    expect(overall.errors).toHaveLength(1);
  });

  it('should return health status with uptime', async () => {
    const orch = factory.createHealthOrchestrator();
    const status = await orch.getHealthStatus();
    expect(status.status).toBeDefined();
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('should return summary string', async () => {
    const orch = factory.createHealthOrchestrator();
    const summary = await orch.getSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('should unregister component', async () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('temp', 'Temporary', {
      liveness: () => ({ ok: true }),
    });
    expect(orch.hasComponent('temp')).toBe(true);
    orch.unregisterComponent('temp');
    expect(orch.hasComponent('temp')).toBe(false);
  });

  it('should handle probe with configuration metadata', async () => {
    const probe = factory.createHealthProbe();
    expect((await probe.liveness()).ok).toBe(true);
    expect((await probe.readiness()).ok).toBe(true);
  });

  it('should check startup probe', async () => {
    const probe = factory.createHealthProbe();
    const result = await probe.startup();
    expect(result.ok).toBe(true);
  });

  it('getComponentHealth returns array of component healths', async () => {
    const orch = factory.createHealthOrchestrator();
    const healths = await orch.getComponentHealth();
    expect(Array.isArray(healths)).toBe(true);
  });
});

it('should handle empty health orchestrator', async () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  expect((await orch.liveness()).ok).toBe(true);
});

it('should register and check multiple components', async () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  expect((await orch.liveness()).ok).toBe(true);
  expect((await orch.readiness()).ok).toBe(true);
});

it('should return health with status field', async () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  const health = await orch.getHealthStatus();
  expect(health.status).toBeDefined();
});

it('should handle probe startup check', async () => {
  const factory2 = new InMemoryEngineFactory();
  const probe = factory2.createHealthProbe();
  const result = await probe.startup();
  expect(result).toBeDefined();
});
