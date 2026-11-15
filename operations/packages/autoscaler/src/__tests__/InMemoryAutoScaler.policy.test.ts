/**
 * InMemoryAutoScaler — policy, cooldown and observability edges.
 *
 * The threshold behaviour is covered elsewhere. What decides whether the scaler
 * is safe in production is the interaction with a registered `ScalingPolicy`:
 * bounds clipping, cooldown enforcement (a second scale action inside the
 * window must be suppressed), the policy label on every action, and the
 * bounded evaluation-interval buffer that feeds `averageEvaluationIntervalMs`.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryAutoScaler } from '../impl/InMemoryAutoScaler.js';
import type { AutoScalerMetrics, ScalingPolicy } from '../interfaces/types.js';

function metrics(overrides: Partial<AutoScalerMetrics> = {}): AutoScalerMetrics {
  return {
    cpu: 0.5,
    qps: 100,
    latencyP95: 10,
    connectionCount: 5,
    currentNodeCount: 2,
    ...overrides,
  };
}

function policy(overrides: Partial<ScalingPolicy> = {}): ScalingPolicy {
  return {
    id: 'standard',
    name: 'Standard',
    strategy: 'custom',
    minNodes: 2,
    maxNodes: 4,
    cpuTarget: 0.7,
    scaleUpCooldownMs: 60_000,
    scaleDownCooldownMs: 60_000,
    predictiveScaling: false,
    overProvisionFactor: 1.0,
    evaluationIntervalMs: 0,
    ...overrides,
  };
}

describe('InMemoryAutoScaler — node accounting', () => {
  it('adopts the node count reported by the metrics', async () => {
    const scaler = new InMemoryAutoScaler();

    await scaler.evaluate(metrics({ currentNodeCount: 6 }));

    expect(scaler.getStats().currentNodeCount).toBe(6);
  });

  it('keeps its own count when the metrics omit it', async () => {
    const scaler = new InMemoryAutoScaler();
    await scaler.forceScale('scale_up', 2, 'manual');

    await scaler.evaluate(metrics({ currentNodeCount: undefined }));

    expect(scaler.getStats().currentNodeCount).toBe(3);
  });

  it('tracks the peak node count', async () => {
    const scaler = new InMemoryAutoScaler();

    await scaler.forceScale('scale_up', 4, 'burst');
    await scaler.forceScale('scale_down', 3, 'settle');

    expect(scaler.getStats().peakNodeCount).toBe(5);
    expect(scaler.getStats().currentNodeCount).toBe(2);
  });
});

describe('InMemoryAutoScaler — policy bounds and labels', () => {
  it('labels actions as threshold-based without a policy', async () => {
    const scaler = new InMemoryAutoScaler();

    const action = await scaler.evaluate(metrics({ cpu: 0.95 }));

    expect(action?.policy).toBe('threshold');
  });

  it('labels actions with the policy id once registered', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy());

    const action = await scaler.evaluate(metrics({ cpu: 0.95 }));

    expect(action?.policy).toBe('standard');
  });

  it('clips a forced scale-up to the policy maximum', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy({ minNodes: 1, maxNodes: 3 }));

    const action = await scaler.forceScale('scale_up', 10, 'overshoot');

    expect(action.targetCount).toBe(3);
    expect(action.amount).toBe(2);
    expect(scaler.getStats().currentNodeCount).toBe(3);
  });

  it('clips a forced scale-down to the policy minimum', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy({ minNodes: 2, maxNodes: 6 }));
    await scaler.forceScale('scale_up', 3, 'grow');

    const action = await scaler.forceScale('scale_down', 10, 'shrink');

    expect(action.targetCount).toBe(2);
    expect(scaler.getStats().currentNodeCount).toBe(2);
  });

  it('returns the registered policy as a copy', () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy({ id: 'copy-check' }));

    const copy = scaler.getPolicy()!;
    copy.maxNodes = 99;

    expect(scaler.getPolicy()?.maxNodes).toBe(4);
  });

  it('reports no policy by default', () => {
    expect(new InMemoryAutoScaler().getPolicy()).toBeNull();
  });
});

describe('InMemoryAutoScaler — cooldowns', () => {
  it('suppresses a second scale-up inside the cooldown window', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy({ scaleUpCooldownMs: 60_000 }));

    const first = await scaler.evaluate(metrics({ cpu: 0.95 }));
    const second = await scaler.evaluate(metrics({ cpu: 0.95 }));

    expect(first?.action).toBe('scale_up');
    expect(second).toBeNull();
    expect(scaler.getCooldownState().scaleUpUntil).toBeGreaterThan(0);
  });

  it('suppresses a second scale-down inside the cooldown window', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy({ scaleDownCooldownMs: 60_000 }));

    const first = await scaler.evaluate(metrics({ cpu: 0.01 }));
    const second = await scaler.evaluate(metrics({ cpu: 0.01 }));

    expect(first?.action).toBe('scale_down');
    expect(second).toBeNull();
    expect(scaler.getCooldownState().scaleDownUntil).toBeGreaterThan(0);
  });

  it('does not cool down without a policy', async () => {
    const scaler = new InMemoryAutoScaler();

    const first = await scaler.evaluate(metrics({ cpu: 0.95 }));
    const second = await scaler.evaluate(metrics({ cpu: 0.95 }));

    expect(first?.action).toBe('scale_up');
    expect(second?.action).toBe('scale_up');
    // Without a policy the cooldown deadline is "now", so it never blocks.
    expect(scaler.getCooldownState().scaleUpUntil).toBeLessThanOrEqual(Date.now());
  });

  it('records the manual action timestamp', async () => {
    const scaler = new InMemoryAutoScaler();
    await scaler.forceScale('scale_up', 1, 'manual');

    expect(scaler.getCooldownState().lastEvaluationAt).toBe(0);
    expect(scaler.getStats().lastActionAt).not.toBeNull();
  });
});

describe('InMemoryAutoScaler — evaluation observability', () => {
  it('averages the interval between evaluations', async () => {
    const scaler = new InMemoryAutoScaler();

    await scaler.evaluate(metrics());
    await scaler.evaluate(metrics());
    await scaler.evaluate(metrics());

    const stats = scaler.getStats();
    expect(stats.averageEvaluationIntervalMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats.averageEvaluationIntervalMs)).toBe(true);
  });

  it('bounds the interval buffer so memory stays flat', async () => {
    const scaler = new InMemoryAutoScaler();

    for (let i = 0; i < 300; i++) {
      await scaler.evaluate(metrics());
    }

    // The average must still be a finite number after the buffer wraps.
    const average = scaler.getStats().averageEvaluationIntervalMs;
    expect(Number.isFinite(average)).toBe(true);
    expect(average).toBeGreaterThanOrEqual(0);
  });

  it("records a forceScale('none') without counting a scale action", async () => {
    const scaler = new InMemoryAutoScaler();

    const action = await scaler.forceScale('none', 5, 'hold');

    expect(action.action).toBe('none');
    expect(action.amount).toBe(0);
    expect(scaler.getStats().totalScaleUps).toBe(0);
    expect(scaler.getStats().totalScaleDowns).toBe(0);
    expect(scaler.getHistory()).toHaveLength(1);
    // A manual action carries a metrics snapshot even though none was supplied.
    expect(scaler.getHistory()[0]?.metricsSnapshot.cpu).toBe(0);
  });

  it('resets every counter and the policy', async () => {
    const scaler = new InMemoryAutoScaler();
    scaler.registerPolicy(policy());
    await scaler.evaluate(metrics({ cpu: 0.95 }));

    scaler.reset();

    expect(scaler.getPolicy()).toBeNull();
    expect(scaler.getStats().currentNodeCount).toBe(1);
    expect(scaler.getStats().totalScaleUps).toBe(0);
    expect(scaler.getCooldownState().scaleUpUntil).toBe(0);
    expect(scaler.getHistory()).toEqual([]);
  });
});
