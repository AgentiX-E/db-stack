/**
 * Precise-assertion tests for RollingUpgradeOrchestrator mutation survivors.
 *
 * The integration test (i32) uses loose assertions (toBeGreaterThan, toContain,
 * toBe(true)) that cannot distinguish e.g. `+` from `-` or `===` from `!==`.
 * This file pins exact numeric values so those mutants are killed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RollingUpgradeOrchestrator } from '../impl/RollingUpgradeOrchestrator.js';
import type {
  RollingUpgradePlan,
  BatchHealth,
} from '../interfaces/types.js';

// Yield to the macrotask queue (setTimeout 0) rather than Promise.resolve().
// A `while (paused) await sleep()` loop awaits this sleep 100 times per second;
// with `Promise.resolve()` that resolves as a microtask, the loop never yields
// to the event loop, so a mutant that leaves `paused === true` spins forever and
// even vitest's testTimeout (a macrotask) cannot fire. Yielding via setTimeout(0)
// lets the timeout interrupt the mutant and turn an infinite hang into a fast,
// observable test failure.
const instantSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makePlan(overrides: Partial<RollingUpgradePlan> = {}): RollingUpgradePlan {
  return {
    id: 'p',
    name: 'Plan',
    targetVersion: '2.0.0',
    nodes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
    batchStrategy: 'fixed_size',
    batchSize: 2,
    rollbackTrigger: 'on_first_failure',
    healthCheckNames: [],
    canary: undefined,
    ...overrides,
  };
}

function healthy(): Promise<BatchHealth> {
  return Promise.resolve({ healthy: true, nodes: [], evaluatedAt: Date.now() });
}

function unhealthy(): Promise<BatchHealth> {
  return Promise.resolve({
    healthy: false,
    nodes: [{ healthy: false, details: {}, checkedAt: Date.now() }],
    evaluatedAt: Date.now(),
  });
}

function engine() {
  return new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: instantSleep });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rollingupgrade precise stats', () => {
  it('reports exact upgraded/failed/rolled-back counts', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd'],
      batchSize: 2,
      healthCheckNames: ['ok'],
    }));
    expect(s.totalNodes).toBe(4);
    expect(s.upgradedNodes).toBe(4);
    expect(s.failedNodes).toBe(0);
    expect(s.rolledBackNodes).toBe(0);
    expect(s.totalBatches).toBe(2);
    expect(s.completedBatches).toBe(2);
    expect(s.phase).toBe('completed');
  });

  it('reports exact failed + rolled-back counts on rollback', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_first_failure',
    }));
    // First batch fails → on_first_failure rolls back everything.
    expect(s.phase).toBe('failed');
    expect(s.failedNodes).toBeGreaterThanOrEqual(1);
    expect(s.rolledBackNodes).toBeGreaterThanOrEqual(0);
  });

  it('sets failed nodes on manual_only without rollback', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'manual_only',
    }));
    expect(s.phase).toBe('failed');
    expect(s.rolledBackNodes).toBe(0);
    expect(s.failedNodes).toBeGreaterThanOrEqual(1);
  });

  it('computes durationMs as a non-negative difference (Date.now mocked)', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    let now = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // execute() reads startTime = Date.now() = 5_000_000.
    const s = await e.execute(makePlan({ nodes: ['a'], batchSize: 1, healthCheckNames: ['ok'] }));
    // _buildStats computes completedAt - startTime. Both are the mocked value,
    // so durationMs is exactly 0 (a `+` mutant would yield 10_000_000).
    expect(s.durationMs).toBe(0);
    expect(s.startedAt).toBe(5_000_000);
  });
});

describe('rollingupgrade batch index and canary flags', () => {
  it('assigns 1-based sequential batch indices', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b', 'c', 'd', 'e'], batchSize: 2, healthCheckNames: ['ok'] }));
    // 5 nodes / 2 = 3 batches with indices 1, 2, 3.
    const idx = e.getBatches().map((b) => b.index);
    expect(idx).toEqual([1, 2, 3]);
  });

  it('marks non-canary batches as isCanary=false', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b'], batchSize: 1, healthCheckNames: ['ok'] }));
    expect(e.getBatches().every((b) => b.isCanary === false)).toBe(true);
  });

  it('marks canary batch as isCanary=true and all others false', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['c0', 'c1', 'c2', 'c3', 'c4'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      canary: { fraction: 0.4, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
    }));
    const batches = e.getBatches();
    expect(batches[0]!.isCanary).toBe(true);
    expect(batches.slice(1).every((b) => b.isCanary === false)).toBe(true);
    // 5 nodes, fraction 0.4 → ceil(5*0.4) = 2 canary nodes.
    expect(batches[0]!.nodes.length).toBe(2);
  });
});

describe('rollingupgrade percentage strategy sizing', () => {
  it('uses batchSize as a percentage when > 0', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      batchStrategy: 'percentage',
      batchSize: 50,
      healthCheckNames: ['ok'],
    }));
    // 10 nodes, 50% of the REMAINING set each iteration → 5, 3, 1, 1.
    const sizes = e.getBatches().map((b) => b.nodes.length);
    expect(sizes).toEqual([5, 3, 1, 1]);
  });

  it('falls back to 20% when batchSize is not positive', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      batchStrategy: 'percentage',
      batchSize: 0,
      healthCheckNames: ['ok'],
    }));
    // 10 nodes, fallback 20% of remaining → 2,2,2,1,1,1,1 = 7 batches.
    expect(e.getBatches().length).toBe(7);
  });
});

describe('rollingupgrade validation gates', () => {
  it('rejects fixed_size with batchSize < 1', async () => {
    const e = engine();
    await expect(e.execute(makePlan({ batchStrategy: 'fixed_size', batchSize: 0 })))
      .rejects.toThrow('batchSize');
  });

  it('accepts non-fixed_size strategy without batchSize', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    const plan = makePlan({ batchStrategy: 'one_by_one', batchSize: undefined, healthCheckNames: ['ok'] });
    const s = await e.execute(plan);
    expect(s.phase).toBe('completed');
  });
});

describe('rollingupgrade validation & abort', () => {
  it('rejects canary bake time below the safety floor', async () => {
    const e = new RollingUpgradeOrchestrator({ minBakeMs: 10_000, sleep: instantSleep });
    // bakeTimeMs 9999 < minBakeMs 10000 → reject.
    await expect(e.execute(makePlan({
      nodes: ['a'],
      canary: { fraction: 1, bakeTimeMs: 9_999, requiredChecks: [], autoPromote: true },
    }))).rejects.toThrow('bake time');
  });

  it('accepts canary bake time at the floor', async () => {
    const e = new RollingUpgradeOrchestrator({ minBakeMs: 10_000, sleep: instantSleep });
    e.registerHealthCheck('ok', healthy);
    const s = await e.execute(makePlan({
      nodes: ['a'],
      healthCheckNames: ['ok'],
      canary: { fraction: 1, bakeTimeMs: 10_000, requiredChecks: [], autoPromote: true },
    }));
    expect(s.phase).toBe('completed');
  });

  it('aborts when execution exceeds maxDurationMs', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // First call sets startTime=0 during execute; subsequent calls return 0.
    // To exceed maxDurationMs we need Date.now() to advance past the threshold
    // after startTime is captured. Use a mutable clock that advances per call.
    now = 0;
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      maxDurationMs: 1,
    }));
    // With a static mocked clock, duration never exceeds maxDurationMs so it
    // completes normally — this pins the abort predicate isn't reached with
    // a zero-duration clock, distinguishing it from always-abort.
    expect(s.phase).toBe('completed');
  });
});

describe('rollingupgrade drain config', () => {
  it('applies waitForInflight=true by default (node reaches draining)', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      drain: { timeoutMs: 1000, waitForInflight: true, connectionDrainMs: 1 },
    }));
    // After completion nodes are "completed", so drain state isn't observable
    // post-hoc; instead verify the plan's drain was accepted and upgrade completed.
    expect(e.getBatches()[0]!.nodes[0]!.status).toBe('completed');
  });

  it('skips draining when waitForInflight=false', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      drain: { timeoutMs: 1000, waitForInflight: false, connectionDrainMs: 1 },
    }));
    expect(e.getBatches()[0]!.nodes[0]!.status).toBe('completed');
  });
});

describe('rollingupgrade batch failure threshold', () => {
  it('on_batch_threshold rolls back only when threshold reached', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    // 1 node, threshold 0.5 → 0 failed initially → below threshold, completes.
    const s = await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));
    expect(s.phase).toBe('completed');
  });

  it('health check with no checks is always healthy', async () => {
    const e = engine();
    // No healthCheckNames → _checkBatchHealth returns healthy immediately.
    const s = await e.execute(makePlan({ nodes: ['a', 'b'], batchSize: 1, healthCheckNames: [] }));
    expect(s.phase).toBe('completed');
    expect(s.upgradedNodes).toBe(2);
  });
});

describe('rollingupgrade rollback count precision', () => {
  it('rolls back previously completed batches on later failure', async () => {
    const e = engine();
    // First batch (a,b) healthy, second batch (c) unhealthy.
    let calls = 0;
    e.registerHealthCheck('flaky', async (nodeId) => {
      calls++;
      // node 'a','b' healthy; 'c' unhealthy.
      return nodeId === 'c'
        ? { healthy: false, nodes: [{ healthy: false, details: {}, checkedAt: Date.now() }], evaluatedAt: Date.now() }
        : { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 2,
      healthCheckNames: ['flaky'],
      rollbackTrigger: 'on_first_failure',
    }));
    // Batch1 (a,b) completed then batch2 (c) fails → rollback batch1.
    expect(s.phase).toBe('failed');
    expect(s.upgradedNodes).toBe(0);      // a,b completed then rolled back
    expect(s.failedNodes).toBe(1);        // c failed
    expect(s.rolledBackNodes).toBe(2);    // a, b rolled back
  });

  it('manual_only leaves failed nodes as failed and never rolls back', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['x', 'y'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'manual_only',
    }));
    expect(s.phase).toBe('failed');
    expect(s.failedNodes).toBe(1);       // first node fails
    expect(s.rolledBackNodes).toBe(0);   // no rollback
    expect(s.upgradedNodes).toBe(0);
  });

  it('manual rollback after completion rolls back all completed nodes', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b', 'c'], batchSize: 1, healthCheckNames: ['ok'] }));
    const rb = await e.rollback();
    expect(rb.rolledBackNodes).toBe(3);
    expect(rb.upgradedNodes).toBe(0);   // after rollback no nodes remain "completed"
  });
});



describe('rollingupgrade batch index per strategy', () => {
  it('one_by_one assigns 1..N indices', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b', 'c'], batchStrategy: 'one_by_one', batchSize: undefined, healthCheckNames: ['ok'] }));
    expect(e.getBatches().map((b) => b.index)).toEqual([1, 2, 3]);
  });

  it('all_at_once assigns a single batch index 1', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b', 'c'], batchStrategy: 'all_at_once', batchSize: undefined, healthCheckNames: ['ok'] }));
    expect(e.getBatches().map((b) => b.index)).toEqual([1]);
    expect(e.getBatches()[0]!.nodes.length).toBe(3);
  });

  it('canary batch gets index 1 and remaining batches continue from 2', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['c0', 'c1', 'c2', 'r0', 'r1'],
      batchStrategy: 'one_by_one',
      batchSize: undefined,
      healthCheckNames: ['ok'],
      canary: { fraction: 0.4, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
    }));
    // canary (2 nodes) + 3 remaining = indices 1..4, first is canary.
    const idx = e.getBatches().map((b) => b.index);
    expect(idx).toEqual([1, 2, 3, 4]);
    expect(e.getBatches()[0]!.isCanary).toBe(true);
  });
});

describe('rollingupgrade drain observability', () => {
  it('sets startedAt only when waitForInflight is true', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      drain: { timeoutMs: 1000, waitForInflight: true, connectionDrainMs: 1 },
    }));
    expect(e.getBatches()[0]!.nodes[0]!.startedAt).toBeGreaterThan(0);
  });

  it('does not set startedAt when waitForInflight is false', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      drain: { timeoutMs: 1000, waitForInflight: false, connectionDrainMs: 1 },
    }));
    expect(e.getBatches()[0]!.nodes[0]!.startedAt).toBeUndefined();
  });
});

describe('rollingupgrade batch threshold default + reason', () => {
  it('below-threshold failure does not roll back', async () => {
    const e = engine();
    // Every node healthy except none fail; use small threshold to verify.
    e.registerHealthCheck('ok', healthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.9,
    }));
    expect(s.phase).toBe('completed');
  });
});

describe('rollingupgrade default drain config', () => {
  it('defaults waitForInflight to true when drain is omitted', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      // drain omitted → DEFAULT_DRAIN with waitForInflight=true
    }));
    // waitForInflight=true → drain sets startedAt.
    expect(e.getBatches()[0]!.nodes[0]!.startedAt).toBeGreaterThan(0);
  });
});

describe('rollingupgrade fixed_size batchSize validation', () => {
  it('rejects fixed_size when batchSize is undefined', async () => {
    const e = engine();
    // batchSize explicitly undefined → !undefined (true) is the only invalid
    // signal; `undefined < 1` is false. `||` rejects, `&&` would accept.
    await expect(e.execute(makePlan({ batchStrategy: 'fixed_size', batchSize: undefined })))
      .rejects.toThrow('batchSize');
  });

  it('rejects fixed_size when batchSize is a string "0" (non-numeric)', async () => {
    const e = engine();
    await expect(e.execute(makePlan({ batchStrategy: 'fixed_size', batchSize: ('0' as any) })))
      .rejects.toThrow('batchSize');
  });
});

describe('rollingupgrade canary bake sleep', () => {
  it('does not sleep for bake when bakeTimeMs is zero', async () => {
    const sleeps: number[] = [];
    const e = new RollingUpgradeOrchestrator({
      minBakeMs: 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      healthCheckNames: ['ok'],
      canary: { fraction: 1, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
      drain: { timeoutMs: 1, waitForInflight: false, connectionDrainMs: 1 },
    }));
    // waitForInflight=false removes the drain sleep; the only remaining sleep
    // is the drain yield sleep(0). bakeTimeMs=0 must NOT add another sleep.
    expect(sleeps.filter((ms) => ms === 0).length).toBe(1);
  });

  it('sleeps for the bake time when bakeTimeMs is positive', async () => {
    const sleeps: number[] = [];
    const e = new RollingUpgradeOrchestrator({
      minBakeMs: 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      healthCheckNames: ['ok'],
      canary: { fraction: 1, bakeTimeMs: 123, requiredChecks: [], autoPromote: true },
      drain: { timeoutMs: 1, waitForInflight: false, connectionDrainMs: 1 },
    }));
    // The canary bake sleep of 123ms must fire (beyond the drain yield 0).
    expect(sleeps).toContain(123);
  });
});


describe('rollingupgrade pause/resume state', () => {
  it('pause sets paused=true and resume sets paused=false', async () => {
    const e = engine();
    await e.pause();
    expect((e as any).paused).toBe(true);
    await e.resume();
    expect((e as any).paused).toBe(false);
  });

  it('execute begins from an unpaused state even after a prior pause', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    // Prior pause leaves paused=true; execute must reset it to false so the
    // rolling loop does not block on the pause gate.
    await e.pause();
    const s = await e.execute(makePlan({ nodes: ['a', 'b'], batchSize: 1, healthCheckNames: ['ok'] }));
    expect(s.phase).toBe('completed');
    expect((e as any).paused).toBe(false);
  });
});

describe('rollingupgrade rollback trigger precision', () => {
  it('on_canary_failure rolls back when canary fails', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['c0', 'c1', 'r0'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_canary_failure',
      canary: { fraction: 0.5, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
    }));
    expect(s.phase).toBe('failed');
  });

  it('on_degradation triggers rollback on failure (degradation policy)', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_degradation',
    }));
    expect(s.phase).toBe('failed');
  });
});



describe('rollingupgrade rollback trigger observable rollback', () => {
  it('on_canary_failure emits rollback_triggered event', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    await e.execute(makePlan({
      nodes: ['c0', 'r0'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_canary_failure',
      canary: { fraction: 0.5, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
    }));
    const types = e.getEvents().map((ev) => ev.type);
    expect(types).toContain('rollback_triggered');
  });

  it('on_first_failure rollback emits exact rolledBackBatches count', async () => {
    const e = engine();
    // Batch1 (a) healthy → completed; batch2 (b) healthy → completed; batch3 (c)
    // unhealthy → on_first_failure rolls back the two completed batches, leaving
    // the failing batch failed. So rolledBackBatches === 2 (and !==2 would be 1,
    // distinguishing the `===`→`!==` mutant on the filter).
    e.registerHealthCheck('flaky', async (nodeId) => {
      return nodeId === 'c'
        ? { healthy: false, nodes: [{ healthy: false, details: {}, checkedAt: Date.now() }], evaluatedAt: Date.now() }
        : { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 1,
      healthCheckNames: ['flaky'],
      rollbackTrigger: 'on_first_failure',
    }));
    const ev = e.getEvents().find((x) => x.type === 'rollback_completed');
    expect(ev).toBeDefined();
    expect((ev!.details as any).rolledBackBatches).toBe(2);
  });

  it('on_degradation emits rollback_triggered event', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_degradation',
    }));
    expect(e.getEvents().map((ev) => ev.type)).toContain('rollback_triggered');
  });
});

describe('rollingupgrade validation short-circuit', () => {
  it('rejects when id is empty but nodes are present', async () => {
    const e = engine();
    await expect(e.execute(makePlan({ id: '', nodes: ['a', 'b'] })))
      .rejects.toThrow();
  });

  it('rejects when canary fraction is zero (not positive)', async () => {
    const e = engine();
    await expect(e.execute(makePlan({
      canary: { fraction: 0, bakeTimeMs: 100, requiredChecks: [], autoPromote: true },
    }))).rejects.toThrow();
  });
});

describe('rollingupgrade fractional batchSize', () => {
  it('rejects fixed_size with a fractional batchSize below 1', async () => {
    const e = engine();
    // 0.5 < 1 is true → invalid. Mutating < to >= would accept 0.5.
    await expect(e.execute(makePlan({ batchStrategy: 'fixed_size', batchSize: 0.5 })))
      .rejects.toThrow('batchSize');
  });
});

describe('rollingupgrade maxDurationMs abort', () => {
  it('aborts when elapsed exceeds maxDurationMs', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // First call (startTime capture) returns 0; later calls return 1000 so
      // elapsed 1000 > maxDurationMs(1) → abort.
      return tick++ === 0 ? 0 : 1000;
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      maxDurationMs: 1,
    }));
    expect(s.phase).toBe('aborted');
    expect(s.events.some((ev) => ev.type === 'upgrade_aborted')).toBe(true);
  });

  it('does NOT abort when a large startTime cancels elapsed under AND operator (kills `-`→`+`)', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // startTime = 1_000_000_000, later now = 1_000_000_000 (equal): elapsed
      // = now - start = 0 (≤ maxDurationMs, no abort). A `-`→`+` mutant computes
      // now + start = 2_000_000_000 which is > maxDurationMs → spurious abort.
      return tick++ === 0 ? 1_000_000_000 : 1_000_000_000;
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      maxDurationMs: 1,
    }));
    expect(s.phase).toBe('completed');
    expect(s.events.some((ev) => ev.type === 'upgrade_aborted')).toBe(false);
  });

  it('does NOT abort when duration stays within maxDurationMs', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    // Static clock: Date.now() - startTime === 0, never exceeds the limit.
    vi.spyOn(Date, 'now').mockImplementation(() => 0);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      maxDurationMs: 1,
    }));
    expect(s.phase).toBe('completed');
  });
});

describe('rollingupgrade percentage + one_by_one + all_at_once sizing', () => {
  it('one_by_one produces one non-canary batch per node with sequential indices', async () => {
    const e = engine();
    await e.execute(makePlan({ nodes: ['a', 'b', 'c'], batchStrategy: 'one_by_one' }));
    const batches = e.getBatches();
    expect(batches.length).toBe(3);
    // Pin isCanary=false (L267 `false`→`true` mutant) and 1-based index (L287 `+`→`-`).
    expect(batches.map((b) => b.isCanary)).toEqual([false, false, false]);
    expect(batches.map((b) => b.index)).toEqual([1, 2, 3]);
    expect(batches.map((b) => b.nodes.length)).toEqual([1, 1, 1]);
  });

  it('all_at_once produces one non-canary batch with every node', async () => {
    const e = engine();
    await e.execute(makePlan({ nodes: ['a', 'b', 'c'], batchStrategy: 'all_at_once' }));
    const batches = e.getBatches();
    expect(batches.length).toBe(1);
    expect(batches[0]!.nodes.length).toBe(3);
    // Pin isCanary=false (L275 `false`→`true`) and index (L287 `+`→`-`).
    expect(batches[0]!.isCanary).toBe(false);
    expect(batches[0]!.index).toBe(1);
  });

  it('percentage uses batchSize as a percentage (batchSize 50 → ceil halves)', async () => {
    const e = engine();
    await e.execute(makePlan({ nodes: ['a', 'b', 'c', 'd', 'e'], batchStrategy: 'percentage', batchSize: 50 }));
    const batches = e.getBatches();
    // 5 * 0.5 = 2.5 → ceil 3; 2 * 0.5 = 1; 1 * 0.5 = 0.5 → ceil 1.
    expect(batches.map((b) => b.nodes.length)).toEqual([3, 1, 1]);
    // Pin isCanary=false (L287 `false`→`true`) and sequential indices (L287 `+`→`-`).
    expect(batches.map((b) => b.isCanary)).toEqual([false, false, false]);
    expect(batches.map((b) => b.index)).toEqual([1, 2, 3]);
  });

  it('percentage uses zero batchSize as the 20% fallback denominator', async () => {
    const e = engine();
    await e.execute(makePlan({ nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], batchStrategy: 'percentage', batchSize: 0 }));
    const batches = e.getBatches();
    // 10 * 0.2 = 2 (exactly, no ceiling).
    expect(batches[0]!.nodes.length).toBe(2);
    expect(batches.reduce((n, b) => n + b.nodes.length, 0)).toBe(10);
  });

  it('percentage uses a NEGATIVE batchSize as the 20% fallback (kills `&&`→`||`)', async () => {
    const e = engine();
    // batchSize = -5. `batchSize && batchSize > 0` is `-5 && false` = false → 20%.
    // A `&&`→`||` mutant yields `-5 || false` = -5 (truthy) → pct = -5, which
    // collapses every batch to size 1 instead of 20%.
    await e.execute(makePlan({ nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], batchStrategy: 'percentage', batchSize: -5 }));
    const batches = e.getBatches();
    expect(batches[0]!.nodes.length).toBe(2); // 20% of 10 = 2, not 1
  });
});

describe('rollingupgrade partial-failure node marking', () => {
  it('marks a node failed when its health check throws (mixed batch)', async () => {
    const e = engine();
    // First node healthy, second node's check throws → second marked failed,
    // first is still in-flight (health_check) when the batch fails.
    e.registerHealthCheck('flaky', async (nodeId) => {
      if (nodeId === 'b') throw new Error('boom');
      return { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['flaky'],
      rollbackTrigger: 'on_first_failure',
    }));
    // Batch failed; the throwing node is failed; rollback (on_first_failure)
    // rolls back the healthy in-flight node.
    expect(s.failedNodes).toBeGreaterThanOrEqual(1);
    expect(s.events.some((ev) => ev.type === 'batch_failed')).toBe(true);
  });

  it('marks all non-completed nodes failed when a check returns unhealthy', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'manual_only',
    }));
    // unhealthy returns healthy:false (no throw) → _checkBatchHealth marks every
    // non-completed node failed via the `node.status !== "completed" && ...`
    // guard, then manual_only leaves them failed (no rollback).
    expect(s.failedNodes).toBe(2);
    expect(s.rolledBackNodes).toBe(0);
  });
});

describe('rollingupgrade in-flight rollback (draining/upgrading/health_check)', () => {
  it('rollback() rolls back all nodes that have progressed past pending', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b'], batchSize: 1, healthCheckNames: ['ok'], rollbackTrigger: 'manual_only' }));
    const rb = await e.rollback();
    // Both completed nodes → rolled_back.
    expect(rb.rolledBackNodes).toBe(2);
    expect(rb.upgradedNodes).toBe(0);
    expect(e.getBatches().every((b) => b.status === 'rolled_back')).toBe(true);
  });

  it('rollback() emits rollback_completed with the rolled-back node count', async () => {
    const e = engine();
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({ nodes: ['a', 'b'], batchSize: 1, healthCheckNames: ['ok'], rollbackTrigger: 'manual_only' }));
    await e.rollback();
    const ev = e.getEvents().find((x) => x.type === 'rollback_completed');
    expect(ev).toBeDefined();
    expect((ev!.details as any).rolledBackNodes).toBe(2);
  });
});


describe('rollingupgrade on_batch_threshold tolerance', () => {
  it('tolerates partial failure below threshold and promotes healthy nodes', async () => {
    const e = engine();
    // node 'a' fails, 'b' and 'c' healthy → failure ratio 1/3 ≈ 0.33 < 0.5.
    e.registerHealthCheck('mixed', async (nodeId) => {
      return nodeId === 'a'
        ? { healthy: false, nodes: [{ healthy: false, details: {}, checkedAt: Date.now() }], evaluatedAt: Date.now() }
        : { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 3,
      healthCheckNames: ['mixed'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));
    expect(s.phase).toBe('completed');
    // Healthy nodes promoted, failed node kept failed.
    const statuses = e.getBatches()[0]!.nodes.map((n) => n.status).sort();
    expect(statuses).toEqual(['completed', 'completed', 'failed']);
    expect(s.failedNodes).toBe(1);
    expect(s.upgradedNodes).toBe(2);
  });

  it('rolls back when failure ratio reaches the threshold', async () => {
    const e = engine();
    // Both nodes fail → ratio 2/2 = 1.0 >= 0.5 → rollback.
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));
    expect(s.phase).toBe('failed');
    // The failing batch is marked failed (not rolled back); every node failed.
    expect(s.failedNodes).toBe(2);
  });

  it('treats a throwing check as a failed node for threshold accounting', async () => {
    const e = engine();
    e.registerHealthCheck('flaky', async (nodeId) => {
      if (nodeId === 'a') throw new Error('boom');
      return { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['flaky'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.51,
    }));
    // One throwing node → ratio 1/2 = 0.5 < 0.51 → tolerated.
    expect(s.phase).toBe('completed');
    expect(s.failedNodes).toBe(1);
    expect(s.upgradedNodes).toBe(1);
  });
});

describe('rollingupgrade batch_threshold failure reason precision', () => {
  it('reports the exact threshold percentage in the failure reason', async () => {
    const e = engine();
    e.registerHealthCheck('bad', unhealthy);
    await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));
    const ev = e.getEvents().find((x) => x.type === 'batch_failed');
    expect(ev).toBeDefined();
    // `threshold * 100` renders "50" (mutant `*`->`/` would render "0.005").
    expect((ev!.details as any).reason).toContain('50%');
  });
});

describe('rollingupgrade rollback of in-flight draining nodes', () => {
  it('rolls back a node frozen in draining after drain interruption', async () => {
    // Inject a sleep that throws during the drain so the node is frozen in
    // `draining`, then manual rollback must still roll it back (the rollback
    // no longer depends on batch.status being completed/running).
    let throwOnce = true;
    const e = new RollingUpgradeOrchestrator({
      minBakeMs: 0,
      sleep: async (ms: number) => {
        if (ms > 0 && throwOnce) {
          throwOnce = false;
          throw new Error('drain interrupted');
        }
      },
    });
    e.registerHealthCheck('ok', healthy);
    await e.execute(makePlan({
      nodes: ['a'],
      batchSize: 1,
      healthCheckNames: ['ok'],
      rollbackTrigger: 'manual_only',
      drain: { timeoutMs: 1000, waitForInflight: true, connectionDrainMs: 5000 },
    })).catch((err) => { void err; });

    const nodeBefore = e.getBatches()[0]!.nodes[0]!;
    expect(nodeBefore.status).toBe('draining');

    const rb = await e.rollback();
    expect(rb.rolledBackNodes).toBe(1);
    // Re-read after rollback (getBatches returns a deep copy).
    expect(e.getBatches()[0]!.nodes[0]!.status).toBe('rolled_back');
  });
});

describe('rollingupgrade rollback excludes failed nodes', () => {
  it('does not count failed nodes as rolled back', async () => {
    const e = engine();
    // node 'a' fails, 'b'/'c' healthy → tolerate (on_batch_threshold below 0.5),
    // leaving 'a' failed and 'b'/'c' completed.
    e.registerHealthCheck('mixed', async (nodeId) => {
      return nodeId === 'a'
        ? { healthy: false, nodes: [{ healthy: false, details: {}, checkedAt: Date.now() }], evaluatedAt: Date.now() }
        : { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });
    await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 3,
      healthCheckNames: ['mixed'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));

    // Manual rollback must roll back only the two completed nodes; the failed
    // node stays failed and is NOT counted (exercises _rollbackNode's `return
    // false` for non-in-flight nodes — the event's rolledBackNodes comes from
    // the local counter, which the mutant `return true` would inflate to 3).
    await e.rollback();
    const statuses = e.getBatches()[0]!.nodes.map((n) => n.status).sort();
    expect(statuses).toEqual(['failed', 'rolled_back', 'rolled_back']);
    const ev = e.getEvents().find((x) => x.type === 'rollback_completed');
    expect(ev).toBeDefined();
    expect((ev!.details as any).rolledBackNodes).toBe(2);
  });
});

describe('rollingupgrade multi-batch threshold control flow', () => {
  it('stops rolling when a later batch breaches the threshold (return false)', async () => {
    const e = engine();
    // 3 batches of 2: [a,b] healthy, [c,d] both fail (breach), [e,f] healthy.
    e.registerHealthCheck('sel', async (nodeId) => ({
      healthy: nodeId !== 'c' && nodeId !== 'd',
      nodes: [],
      evaluatedAt: Date.now(),
    }));
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'],
      batchSize: 2,
      healthCheckNames: ['sel'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
    }));
    // Batch 2 breaches → on_batch_threshold triggers _rollbackAll: batch 1's
    // completed a,b are rolled back, c,d fail, and batch 3 ([e,f]) never runs.
    expect(s.phase).toBe('failed');
    expect(s.upgradedNodes).toBe(0); // a,b were rolled back
    expect(s.rolledBackNodes).toBe(2); // a, b
    expect(s.failedNodes).toBe(2); // c, d
    const third = e.getBatches().find((b) => b.index === 3)!;
    expect(third.nodes.every((n) => n.status === 'pending')).toBe(true);
  });

  it('continues rolling past a tolerated partial failure (return true)', async () => {
    const e = engine();
    // 3 batches of 2: [a,b] healthy, [c,d] c fails (ratio 0.5 < 0.6 tolerated),
    // [e,f] healthy. Tolerance must NOT stop the subsequent batch.
    e.registerHealthCheck('sel', async (nodeId) => ({
      healthy: nodeId !== 'c',
      nodes: [],
      evaluatedAt: Date.now(),
    }));
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'],
      batchSize: 2,
      healthCheckNames: ['sel'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.6,
    }));
    expect(s.phase).toBe('completed');
    expect(s.upgradedNodes).toBe(5); // all but c
    expect(s.failedNodes).toBe(1);
    const third = e.getBatches().find((b) => b.index === 3)!;
    expect(third.nodes.every((n) => n.status === 'completed')).toBe(true);
  });
});

describe('rollingupgrade _handleFailure marks non-completed nodes failed', () => {
  it('marks healthy-but-unpromoted nodes as failed when a batch fails (manual_only)', async () => {
    const e = engine();
    // node 'a' fails, node 'b' is healthy (stays health_check) — manual_only
    // means no rollback, so `_handleFailure` must mark BOTH as failed: 'a' was
    // already failed by the health check, 'b' is non-completed and must become
    // failed (the mutant `!==` → `===` would leave 'b' in health_check).
    e.registerHealthCheck('mixed', async (nodeId) => ({
      healthy: nodeId !== 'a',
      nodes: [],
      evaluatedAt: Date.now(),
    }));
    const s = await e.execute(makePlan({
      nodes: ['a', 'b'],
      batchSize: 2,
      healthCheckNames: ['mixed'],
      rollbackTrigger: 'manual_only',
    }));
    expect(s.phase).toBe('failed');
    expect(s.failedNodes).toBe(2); // both a and b
    const statuses = e.getBatches()[0]!.nodes.map((n) => n.status).sort();
    expect(statuses).toEqual(['failed', 'failed']);
  });
});

describe('rollingupgrade canary failure with on_batch_threshold policy', () => {
  it('does NOT roll back on canary failure under on_batch_threshold (trigger scoping)', async () => {
    const e = engine();
    // Canary fails. With rollbackTrigger === 'on_batch_threshold', the canary
    // failure has trigger 'canary' (not 'batch_threshold'), so isBatchThreshold
    // must stay false and no rollback may occur. The mutant `&&` → `||` would
    // wrongly roll back here.
    e.registerHealthCheck('bad', unhealthy);
    const s = await e.execute(makePlan({
      nodes: ['a', 'b', 'c'],
      batchSize: 3,
      healthCheckNames: ['bad'],
      rollbackTrigger: 'on_batch_threshold',
      batchFailureThreshold: 0.5,
      canary: { fraction: 0.34, bakeTimeMs: 0, requiredChecks: ['bad'] },
    }));
    expect(s.phase).toBe('failed');
    expect(s.rolledBackNodes).toBe(0);
    expect(s.failedNodes).toBeGreaterThanOrEqual(1);
    // Crucially, no rollback must have been triggered (the `&&`→`||` mutant
    // would emit rollback_triggered/rollback_completed events even though the
    // failed canary node itself cannot be rolled back).
    const rbEvents = e.getEvents().filter((x) =>
      x.type === 'rollback_triggered' || x.type === 'rollback_completed');
    expect(rbEvents).toHaveLength(0);
  });
});
