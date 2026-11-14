import { describe, it, expect, beforeEach } from 'vitest';
import { HealthOrchestrator } from '../impl/HealthOrchestrator.js';
import { componentProbe } from '../impl/ComponentProbe.js';
import type { IHealthProbe } from '../interfaces/IHealthProbe.js';
import type { ProbeResult } from '@agentix-e/db-operations-core/types';

// ── Helper: create probe with configurable results ─────────────

function createProbe(
  id: string,
  name: string,
  results: {
    liveness?: ProbeResult;
    readiness?: ProbeResult;
    startup?: ProbeResult;
  } = {},
): IHealthProbe {
  return {
    probeId: id,
    componentName: name,
    liveness: () => results.liveness ?? { ok: true },
    readiness: () => results.readiness ?? { ok: true },
    startup: () => results.startup ?? { ok: true },
  };
}

// ══════════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════════

describe('HealthOrchestrator', () => {
  let orchestrator: HealthOrchestrator;

  beforeEach(() => {
    orchestrator = new HealthOrchestrator();
  });

  describe('component registration', () => {
    it('should register and retrieve a component', () => {
      const probe = createProbe('disk', 'Disk Monitor');
      orchestrator.registerComponent(probe);
      expect(orchestrator.hasComponent('disk')).toBe(true);
    });

    it('should unregister a component', () => {
      const probe = createProbe('disk', 'Disk Monitor');
      orchestrator.registerComponent(probe);
      orchestrator.unregisterComponent('disk');
      expect(orchestrator.hasComponent('disk')).toBe(false);
    });

    it('should register a functional probe', () => {
      orchestrator.registerFunctional('mem', 'Memory Monitor', {
        liveness: () => ({ ok: true }),
        readiness: () => ({ ok: true }),
      });
      expect(orchestrator.hasComponent('mem')).toBe(true);
    });
  });

  describe('liveness', () => {
    it('should return ok when all probes pass', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.registerComponent(createProbe('b', 'B'));

      const result = orchestrator.liveness();
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return failed when a probe fails', () => {
      orchestrator.registerComponent(createProbe('good', 'Good'));
      orchestrator.registerComponent(createProbe('bad', 'Bad', {
        liveness: { ok: false, message: 'Service not responding' },
      }));

      const result = orchestrator.liveness();
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('bad');
      expect(result.errors[0]).toContain('Service not responding');
    });

    it('should catch thrown errors from probes', () => {
      orchestrator.registerComponent({
        probeId: 'bad',
        componentName: 'Bad Probe',
        liveness: () => { throw new Error('OOM'); },
        readiness: () => ({ ok: true }),
        startup: () => ({ ok: true }),
      });

      const result = orchestrator.liveness();
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('OOM');
    });

    it('should return ok when no components registered', () => {
      const result = orchestrator.liveness();
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('readiness', () => {
    it('should return ok when all probes pass liveness + readiness', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.registerComponent(createProbe('b', 'B'));

      const result = orchestrator.readiness();
      expect(result.ok).toBe(true);
    });

    it('should fail when readiness fails even if liveness passes', () => {
      orchestrator.registerComponent(createProbe('a', 'A', {
        readiness: { ok: false, message: 'Leader not elected' },
      }));

      const result = orchestrator.readiness();
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('Leader not elected');
    });
  });

  describe('startup', () => {
    it('should return ok when all probes complete startup', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.startup();
      orchestrator.startup();

      const r1 = orchestrator.startup();
      expect(r1.ok).toBe(true);
    });

    it('should return ok once and cache the result', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.startup(); // First call — completes startup
      const r2 = orchestrator.startup(); // Second call — cached
      expect(r2.ok).toBe(true);
    });
  });

  describe('getHealthStatus', () => {
    it('should return healthy when all components pass', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.registerComponent(createProbe('b', 'B'));

      const status = orchestrator.getHealthStatus();
      expect(status.status).toBe('healthy');
      expect(status.components).toHaveLength(2);
    });

    it('should return degraded when at least one component fails', () => {
      orchestrator.registerComponent(createProbe('good', 'Good'));
      orchestrator.registerComponent(createProbe('bad', 'Bad', {
        liveness: { ok: false, message: 'Down' },
      }));

      const status = orchestrator.getHealthStatus();
      expect(status.status).toBe('degraded');
    });

    it('should return unhealthy when all components fail', () => {
      orchestrator.registerComponent(createProbe('a', 'A', {
        liveness: { ok: false },
        readiness: { ok: false },
      }));
      orchestrator.registerComponent(createProbe('b', 'B', {
        liveness: { ok: false },
        readiness: { ok: false },
      }));

      const status = orchestrator.getHealthStatus();
      expect(status.status).toBe('unhealthy');
    });

    it('should include uptime', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      const status = orchestrator.getHealthStatus();
      expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getComponentHealth', () => {
    it('should return detailed per-component health', () => {
      orchestrator.registerComponent(
        createProbe('rpc', 'RPC Server', {
          liveness: { ok: true },
          readiness: { ok: false, message: 'Not connected to peers' },
        }),
      );

      const components = orchestrator.getComponentHealth();
      expect(components).toHaveLength(1);
      expect(components[0]).toMatchObject({
        componentId: 'rpc',
        componentName: 'RPC Server',
        liveness: { ok: true },
        readiness: { ok: false, message: 'Not connected to peers' },
        lastError: null,
      });
      expect(components[0].uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getAggregateStatus', () => {
    it('should return healthy when empty', () => {
      expect(orchestrator.getAggregateStatus().status).toBe('healthy');
    });

    it('should return healthy when all healthy', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      orchestrator.registerComponent(createProbe('b', 'B'));
      expect(orchestrator.getAggregateStatus().status).toBe('healthy');
    });

    it('should return degraded when mixed', () => {
      orchestrator.registerComponent(createProbe('good', 'Good'));
      orchestrator.registerComponent(createProbe('bad', 'Bad', {
        liveness: { ok: false },
      }));
      expect(orchestrator.getAggregateStatus().status).toBe('degraded');
    });
  });

  describe('getSummary', () => {
    it('should return a concise string', () => {
      orchestrator.registerComponent(createProbe('a', 'A'));
      const summary = orchestrator.getSummary();

      expect(typeof summary).toBe('string');
      expect(summary).toContain('healthy');
    });

    it('should include failing count when components fail', () => {
      orchestrator.registerComponent(createProbe('bad', 'Bad', {
        liveness: { ok: false },
      }));
      const summary = orchestrator.getSummary();

      expect(summary).toContain('Failing');
    });
  });

  describe('componentProbe helper', () => {
    it('should create a probe with correct metadata', () => {
      const probe = componentProbe('test', 'Test Component', {
        liveness: () => ({ ok: true }),
      });

      expect(probe.probeId).toBe('test');
      expect(probe.componentName).toBe('Test Component');
      expect(probe.liveness()).toEqual({ ok: true });
    });

    it('should fallback liveness to readiness and startup', () => {
      const probe = componentProbe('test', 'Test', {
        liveness: () => ({ ok: false, message: 'fail' }),
      });

      // Should all return liveness result
      expect(probe.readiness()).toEqual({ ok: false, message: 'fail' });
      expect(probe.startup()).toEqual({ ok: false, message: 'fail' });
    });
  });
});
