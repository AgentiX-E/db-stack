/**
 * ClusterHealth composition root tests — C-04 / C-07.
 *
 * The reporter channel is only useful if a production composition root exists
 * that binds it to a real HealthProbe. These cases pin that root: one health
 * object, one reporter shared by every component, and a readiness verdict that
 * degrades when any of them reports a swallowed failure. The root is
 * engine-agnostic — it takes no store, socket or engine.
 */

import { describe, it, expect } from 'vitest';
import { createClusterHealth } from './ClusterHealth';

describe('createClusterHealth (C-04/C-07)', () => {
  it('returns a health probe and a reporter bound to it', () => {
    const { health, reporter } = createClusterHealth();
    health.markStartupComplete();
    expect(health.readiness().ok).toBe(true);

    reporter({ source: 'WatchApi.handler', error: new Error('boom') });

    expect(health.readiness().ok).toBe(false);
    expect(health.readiness().reason).toContain('WatchApi.handler');
  });

  it('the reporter is shared: failures from different components aggregate', () => {
    const { health, reporter } = createClusterHealth();
    health.markStartupComplete();

    reporter({ source: 'EventBus.sync', error: new Error('a') });
    reporter({ source: 'OnlineShardMigration.listener', error: new Error('b') });

    const reason = health.readiness().reason ?? '';
    expect(reason).toContain('EventBus.sync');
    expect(reason).toContain('OnlineShardMigration.listener');
    expect(health.listenerFailures).toHaveLength(2);
  });

  it('accepts an injected clock so a deployment can supply its own time source', () => {
    const { health, reporter } = createClusterHealth({ now: () => 12345 });
    reporter({ source: 'x' });
    expect(health.listenerFailures[0]!.at).toBe(12345);
  });
});
