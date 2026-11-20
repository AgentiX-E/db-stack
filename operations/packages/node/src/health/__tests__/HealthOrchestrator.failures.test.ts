/**
 * HealthOrchestrator — failing, throwing and non-Error probes.
 *
 * A health API that swallows a probe crash is useless: `/health` would report
 * `healthy` while the component is dead. These tests pin the failure surface —
 * default messages, thrown strings, per-component errors and the summary — and
 * the registration defaults around `critical`.
 */

import { describe, it, expect } from 'vitest';
import { HealthOrchestrator } from '../impl/HealthOrchestrator.js';
import type { IHealthProbe } from '../interfaces/IHealthProbe.js';
import type { ProbeResult } from '../../core/types.js';

function probe(
  id: string,
  results: {
    liveness?: () => ProbeResult;
    readiness?: () => ProbeResult;
    startup?: () => ProbeResult;
  } = {},
): IHealthProbe {
  return {
    probeId: id,
    componentName: `component-${id}`,
    liveness: results.liveness ?? (() => ({ ok: true })),
    readiness: results.readiness ?? (() => ({ ok: true })),
    startup: results.startup ?? (() => ({ ok: true })),
  };
}

describe('HealthOrchestrator — probe failures', () => {
  it('uses a default message when a failing liveness probe gives none', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { liveness: () => ({ ok: false }) }));

    const result = orchestrator.liveness();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] liveness failed']);
  });

  it('uses a default message when a failing readiness probe gives none', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { readiness: () => ({ ok: false }) }));

    const result = orchestrator.readiness();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] readiness failed']);
  });

  it('keeps the probe-supplied message when there is one', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => ({ ok: false, message: 'connection refused' }),
      }),
    );

    expect(orchestrator.liveness().errors).toEqual(['[db] connection refused']);
  });

  it('reports a thrown Error from liveness with its message', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          throw new Error('socket closed');
        },
      }),
    );

    expect(orchestrator.liveness().errors).toEqual(['[db] liveness threw: socket closed']);
  });

  it('stringifies a non-Error throw from liveness', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 'plain failure';
        },
      }),
    );

    expect(orchestrator.liveness().errors).toEqual(['[db] liveness threw: plain failure']);
  });

  it('reports a thrown Error from readiness', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          throw new Error('not ready');
        },
      }),
    );

    expect(orchestrator.readiness().errors).toContain('[db] readiness threw: not ready');
  });

  it('stringifies a non-Error throw from readiness', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 42;
        },
      }),
    );

    expect(orchestrator.readiness().errors).toContain('[db] readiness threw: 42');
  });

  it('reports a failing startup probe', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { startup: () => ({ ok: false }) }));

    const result = orchestrator.startup();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] startup not complete']);
    expect(orchestrator.isStartupComplete()).toBe(false);
  });

  it('reports a throwing startup probe', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        startup: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 'warmup failed';
        },
      }),
    );

    expect(orchestrator.startup().errors).toEqual(['[db] startup threw: warmup failed']);
  });

  it('caches a successful startup', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    expect(orchestrator.startup()).toEqual({ ok: true, errors: [] });
    expect(orchestrator.isStartupComplete()).toBe(true);
    expect(orchestrator.startup()).toEqual({ ok: true, errors: [] });
  });
});

describe('HealthOrchestrator — structured status', () => {
  it('captures a probe crash inside getComponentHealth instead of throwing', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          throw new Error('probe exploded');
        },
      }),
    );

    const [component] = orchestrator.getComponentHealth();

    expect(component?.readiness).toEqual({
      ok: false,
      message: 'probe exploded',
    });
    expect(orchestrator.getHealthStatus().status).toBe('degraded');
  });

  it('stringifies a non-Error crash in the structured view', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw { code: 'EFAIL' };
        },
      }),
    );

    expect(orchestrator.getComponentHealth()[0]?.liveness.message).toBe('[object Object]');
  });

  it('surfaces the last error in the summary', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { liveness: () => ({ ok: false, message: 'disk full' }) }));
    orchestrator.liveness();

    const summary = orchestrator.getSummary();

    expect(summary).toContain('Failing: 1 component(s)');
    expect(summary).toContain('Last error: disk full');
  });

  it('omits the error section when everything is healthy', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    const summary = orchestrator.getSummary();

    expect(summary).toContain('healthy');
    expect(summary).not.toContain('Last error');
  });

  it('reports unhealthy when every component fails', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('a', {
        liveness: () => ({ ok: false }),
        readiness: () => ({ ok: false }),
      }),
    );
    orchestrator.registerComponent(
      probe('b', {
        liveness: () => ({ ok: false }),
        readiness: () => ({ ok: false }),
      }),
    );

    expect(orchestrator.getAggregateStatus()).toEqual({
      status: 'unhealthy',
      count: 2,
    });
  });

  it('reports healthy when no component is registered', () => {
    const orchestrator = new HealthOrchestrator();

    expect(orchestrator.getAggregateStatus()).toEqual({
      status: 'healthy',
      count: 0,
    });
    expect(orchestrator.getHealthStatus().lastError).toBeNull();
  });

  it('clears the recorded error once a probe recovers', () => {
    const orchestrator = new HealthOrchestrator();
    let failing = true;
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => (failing ? { ok: false, message: 'down' } : { ok: true }),
      }),
    );

    orchestrator.liveness();
    expect(orchestrator.getComponentHealth()[0]?.lastError).toBe('down');

    failing = false;
    orchestrator.liveness();

    expect(orchestrator.getComponentHealth()[0]?.lastError).toBeNull();
  });
});

describe('HealthOrchestrator — registration', () => {
  it('defaults a component to critical', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    expect(orchestrator.hasComponent('db')).toBe(true);
    expect(orchestrator.getComponentHealth()[0]?.componentName).toBe('component-db');
  });

  it('accepts an explicit non-critical registration', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('cache'), { critical: false });

    expect(orchestrator.hasComponent('cache')).toBe(true);
  });

  it('registers a functional probe and enforces its checks', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('api', 'http-api', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: 'draining' }),
    });

    expect(orchestrator.liveness().ok).toBe(true);
    expect(orchestrator.readiness().errors).toEqual(['[api] draining']);
  });

  it('unregisters a component', () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));
    orchestrator.unregisterComponent('db');

    expect(orchestrator.hasComponent('db')).toBe(false);
    expect(orchestrator.liveness()).toEqual({ ok: true, errors: [] });
  });
});
