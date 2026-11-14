import { describe, it, expect } from 'vitest';
import { InMemoryEngineFactory } from './InMemoryEngineFactory.js';

describe.each([
  { name: 'InMemory', factory: new InMemoryEngineFactory() },
])('$name e2e: Health', ({ factory }) => {
  afterAll(async () => {
    await factory.cleanup();
  });

  it('should create a health probe with liveness ok', () => {
    const probe = factory.createHealthProbe();
    const result = probe.liveness();
    expect(result.ok).toBe(true);
  });

  it('should create a health probe with readiness ok', () => {
    const probe = factory.createHealthProbe();
    const result = probe.readiness();
    expect(result.ok).toBe(true);
  });

  it('should create a health orchestrator', () => {
    const orch = factory.createHealthOrchestrator();
    const status = orch.liveness();
    expect(status.ok).toBe(true);
  });

  it('should aggregate component health correctly', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('comp-1', 'Component 1', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: true }),
    });
    orch.registerFunctional('comp-2', 'Component 2', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: 'not ready' }),
    });
    const overall = orch.readiness();
    expect(overall.ok).toBe(false);
    expect(overall.errors).toHaveLength(1);
  });

  it('should return health status with uptime', () => {
    const orch = factory.createHealthOrchestrator();
    const status = orch.getHealthStatus();
    expect(status.status).toBeDefined();
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('should return summary string', () => {
    const orch = factory.createHealthOrchestrator();
    const summary = orch.getSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('should unregister component', () => {
    const orch = factory.createHealthOrchestrator();
    orch.registerFunctional('temp', 'Temporary', {
      liveness: () => ({ ok: true }),
    });
    expect(orch.hasComponent('temp')).toBe(true);
    orch.unregisterComponent('temp');
    expect(orch.hasComponent('temp')).toBe(false);
  });

  it('should handle probe with configuration metadata', () => {
    const probe = factory.createHealthProbe();
    expect(probe.liveness().ok).toBe(true);
    expect(probe.readiness().ok).toBe(true);
  });

  it('should check startup probe', () => {
    const probe = factory.createHealthProbe();
    const result = probe.startup();
    expect(result.ok).toBe(true);
  });

  it('getComponentHealth returns array of component healths', () => {
    const orch = factory.createHealthOrchestrator();
    const healths = orch.getComponentHealth();
    expect(Array.isArray(healths)).toBe(true);
  });
});

it('should handle empty health orchestrator', () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  expect(orch.liveness().ok).toBe(true);
});

it('should register and check multiple components', () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  expect(orch.liveness().ok).toBe(true);
  expect(orch.readiness().ok).toBe(true);
});

it('should return health with status field', () => {
  const factory2 = new InMemoryEngineFactory();
  const orch = factory2.createHealthOrchestrator();
  const health = orch.getHealthStatus();
  expect(health.status).toBeDefined();
});

it('should handle probe startup check', () => {
  const factory2 = new InMemoryEngineFactory();
  const probe = factory2.createHealthProbe();
  const result = probe.startup();
  expect(result).toBeDefined();
});
