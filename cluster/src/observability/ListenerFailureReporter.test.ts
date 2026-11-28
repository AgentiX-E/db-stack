/**
 * ListenerFailureReporter tests — C-04.
 *
 * The reporter is the engine-agnostic channel between a swallowed callback and a
 * health verdict. These cases pin two properties: the default is inert so every
 * existing construction site keeps its behaviour, and a reporter wired to a
 * HealthProbe turns a listener failure into a degraded readiness that names the
 * component that failed.
 */

import { describe, it, expect } from 'vitest';
import { HealthProbe } from './HealthProbe';
import {
  createHealthFailureReporter,
  ignoreListenerFailure,
  type ListenerFailureEvent,
} from './ListenerFailureReporter';

describe('ListenerFailureReporter (C-04)', () => {
  it('the default reporter is inert and cannot throw', () => {
    expect(() => ignoreListenerFailure({ source: 'x', error: new Error('boom'), at: 1 })).not.toThrow();
  });

  it('a health reporter forwards the source, error and timestamp to the probe', () => {
    const probe = new HealthProbe();
    probe.markStartupComplete();
    const report = createHealthFailureReporter(probe);

    const failure: ListenerFailureEvent = {
      source: 'WatchApi.handler',
      error: new Error('boom'),
      at: 42,
    };
    report(failure);

    expect(probe.listenerFailures).toHaveLength(1);
    expect(probe.listenerFailures[0]!).toMatchObject({
      source: 'WatchApi.handler',
      at: 42,
    });
    expect(probe.readiness().ok).toBe(false);
    expect(probe.readiness().reason).toContain('WatchApi.handler');
  });

  it('a failure with no error is still recorded', () => {
    const probe = new HealthProbe();
    const report = createHealthFailureReporter(probe);
    report({ source: 'EventBus.async', error: undefined, at: 7 });
    expect(probe.listenerFailures[0]!.error).toBeUndefined();
  });
});
