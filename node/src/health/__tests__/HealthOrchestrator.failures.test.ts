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
  it('uses a default message when a failing liveness probe gives none', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { liveness: () => ({ ok: false }) }));

    const result = await orchestrator.liveness();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] liveness failed']);
  });

  it('uses a default message when a failing readiness probe gives none', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { readiness: () => ({ ok: false }) }));

    const result = await orchestrator.readiness();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] readiness failed']);
  });

  it('keeps the probe-supplied message when there is one', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => ({ ok: false, message: 'connection refused' }),
      }),
    );

    expect((await orchestrator.liveness()).errors).toEqual(['[db] connection refused']);
  });

  it('reports a thrown Error from liveness with its message', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          throw new Error('socket closed');
        },
      }),
    );

    expect((await orchestrator.liveness()).errors).toEqual(['[db] liveness threw: socket closed']);
  });

  it('stringifies a non-Error throw from liveness', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 'plain failure';
        },
      }),
    );

    expect((await orchestrator.liveness()).errors).toEqual(['[db] liveness threw: plain failure']);
  });

  it('reports a thrown Error from readiness', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          throw new Error('not ready');
        },
      }),
    );

    expect((await orchestrator.readiness()).errors).toContain('[db] readiness threw: not ready');
  });

  it('stringifies a non-Error throw from readiness', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 42;
        },
      }),
    );

    expect((await orchestrator.readiness()).errors).toContain('[db] readiness threw: 42');
  });

  it('reports a failing startup probe', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { startup: () => ({ ok: false }) }));

    const result = await orchestrator.startup();

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['[db] startup not complete']);
    expect(orchestrator.isStartupComplete()).toBe(false);
  });

  it('reports a throwing startup probe', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        startup: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw 'warmup failed';
        },
      }),
    );

    expect((await orchestrator.startup()).errors).toEqual(['[db] startup threw: warmup failed']);
  });

  it('caches a successful startup', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    expect(await orchestrator.startup()).toEqual({ ok: true, errors: [] });
    expect(orchestrator.isStartupComplete()).toBe(true);
    expect(await orchestrator.startup()).toEqual({ ok: true, errors: [] });
  });
});

describe('HealthOrchestrator — structured status', () => {
  it('captures a probe crash inside getComponentHealth instead of throwing', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        readiness: () => {
          throw new Error('probe exploded');
        },
      }),
    );

    const components = await orchestrator.getComponentHealth();
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('the orchestrator returned no component');

    expect(component?.readiness).toEqual({
      ok: false,
      message: 'probe exploded',
    });
    expect((await orchestrator.getHealthStatus()).status).toBe('degraded');
  });

  it('stringifies a non-Error crash in the structured view', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => {
          // eslint-disable-next-line no-throw-literal -- a non-Error throw is the fixture
          throw { code: 'EFAIL' };
        },
      }),
    );

    expect((await orchestrator.getComponentHealth())[0]?.liveness.message).toBe('[object Object]');
  });

  it('surfaces the last error in the summary', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { liveness: () => ({ ok: false, message: 'disk full' }) }));
    await orchestrator.liveness();

    const summary = await orchestrator.getSummary();

    expect(summary).toContain('Failing: 1 component(s)');
    expect(summary).toContain('Last error: disk full');
  });

  it('omits the error section when everything is healthy', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    const summary = await orchestrator.getSummary();

    expect(summary).toContain('healthy');
    expect(summary).not.toContain('Last error');
  });

  it('reports unhealthy when every component fails', async () => {
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

    expect(await orchestrator.getAggregateStatus()).toEqual({
      status: 'unhealthy',
      count: 2,
    });
  });

  it('reports healthy when no component is registered', async () => {
    const orchestrator = new HealthOrchestrator();

    expect(await orchestrator.getAggregateStatus()).toEqual({
      status: 'healthy',
      count: 0,
    });
    expect((await orchestrator.getHealthStatus()).lastError).toBeNull();
  });

  it('clears the recorded error once a probe recovers', async () => {
    const orchestrator = new HealthOrchestrator();
    let failing = true;
    orchestrator.registerComponent(
      probe('db', {
        liveness: () => (failing ? { ok: false, message: 'down' } : { ok: true }),
      }),
    );

    await orchestrator.liveness();
    expect((await orchestrator.getComponentHealth())[0]?.lastError).toBe('down');

    failing = false;
    await orchestrator.liveness();

    expect((await orchestrator.getComponentHealth())[0]?.lastError).toBeNull();
  });
});

describe('HealthOrchestrator — registration', () => {
  it('defaults a component to critical', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));

    expect(orchestrator.hasComponent('db')).toBe(true);
    expect((await orchestrator.getComponentHealth())[0]?.componentName).toBe('component-db');
  });

  it('accepts an explicit non-critical registration', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('cache'), { critical: false });

    expect(orchestrator.hasComponent('cache')).toBe(true);
  });

  it('registers a functional probe and enforces its checks', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerFunctional('api', 'http-api', {
      liveness: () => ({ ok: true }),
      readiness: () => ({ ok: false, message: 'draining' }),
    });

    expect((await orchestrator.liveness()).ok).toBe(true);
    expect((await orchestrator.readiness()).errors).toEqual(['[api] draining']);
  });

  it('unregisters a component', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db'));
    orchestrator.unregisterComponent('db');

    expect(orchestrator.hasComponent('db')).toBe(false);
    expect(await orchestrator.liveness()).toEqual({ ok: true, errors: [] });
  });
});

describe('HealthOrchestrator — a probe that answers with a promise', () => {
  /**
   * A promise used to be refused by name, because the contract said
   * `() => ProbeResult` and a promise read as a result was a failed component
   * with an empty message. That diagnosis was honest and the product was still
   * incomplete: the readiness question is about a dependency, and a dependency
   * is reached over I/O. The contract now admits the promise and the aggregator
   * awaits it; these cases keep all three entry points honest about that.
   */
  const promiseProbe = (kind: 'liveness' | 'readiness' | 'startup'): IHealthProbe => {
    const async = () => Promise.resolve({ ok: true });
    return probe('db', { [kind]: async });
  };

  it('awaits liveness, readiness and startup rather than reporting a silent failure', async () => {
    for (const kind of ['liveness', 'readiness', 'startup'] as const) {
      const orchestrator = new HealthOrchestrator();
      orchestrator.registerComponent(promiseProbe(kind));

      const result =
        kind === 'liveness'
          ? await orchestrator.liveness()
          : kind === 'readiness'
            ? await orchestrator.readiness()
            : await orchestrator.startup();

      expect(result.ok, kind).toBe(true);
      expect(result.errors, kind).toEqual([]);
    }
  });

  it('reports the awaited answer through the structured status', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent({
      ...promiseProbe('liveness'),
      readiness: async () => ({ ok: true }),
    });

    const components = await orchestrator.getComponentHealth();
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('the orchestrator returned no component');

    expect(component.liveness.ok).toBe(true);
    expect(component.readiness.ok).toBe(true);
    expect((await orchestrator.getAggregateStatus()).status).toBe('healthy');
  });

  it('keeps the probe as the receiver, so a class probe that reads its own state answers', async () => {
    // `getComponentHealth()` used to pass `entry.probe.liveness` to a helper and
    // call it there. A closure does not notice; a class does — `this` was
    // undefined, the throw landed in the same `catch` a real failure uses, and a
    // healthy component was reported unhealthy with "Cannot read properties of
    // undefined".
    class EngineProbe implements IHealthProbe {
      readonly probeId = 'engine';
      readonly componentName = 'Engine';
      private readonly open = true;

      liveness(): ProbeResult {
        return { ok: this.open, message: this.open ? 'open' : 'closed' };
      }

      readiness(): ProbeResult {
        return { ok: this.open };
      }

      startup(): ProbeResult {
        return { ok: this.open };
      }
    }

    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(new EngineProbe());

    const components = await orchestrator.getComponentHealth();
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('the orchestrator returned no component');

    expect(component.liveness).toEqual({ ok: true, message: 'open' });
    expect((await orchestrator.getAggregateStatus()).status).toBe('healthy');
  });

  it('leaves a synchronous probe untouched', async () => {
    const orchestrator = new HealthOrchestrator();
    orchestrator.registerComponent(probe('db', { readiness: () => ({ ok: true, message: 'warm' }) }));

    const components = await orchestrator.getComponentHealth();
    expect(components).toHaveLength(1);
    const component = components[0];
    if (!component) throw new Error('the orchestrator returned no component');

    expect(component.readiness).toEqual({ ok: true, message: 'warm' });
  });
});
