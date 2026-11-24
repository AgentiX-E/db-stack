/**
 * I85 — the upgrade waits for the node, not for a timer.
 *
 * `_drainAndUpgrade` used to `await sleep(0)` where the upgrade should have been
 * and then mark the node `completed`. The plan carried a `targetVersion` that no
 * line of code read, so `upgradedNodes` counted nodes that had been relabelled:
 * a node that never restarted and a node that came back on the old version were
 * both reported as upgraded, and a canary that failed to start was promoted.
 *
 * These cases pin the three things that make the wait real — the node is asked,
 * the answer is read until it is the target version, and a node that never
 * answers is a failed node rather than a slow one.
 */

import { describe, it, expect } from 'vitest';
import { RollingUpgradeOrchestrator } from '../impl/RollingUpgradeOrchestrator.js';
import type { IVersionProbe, RollingUpgradePlan } from '../interfaces/types.js';

// ── Helpers ────────────────────────────────────────────────

type Reply = string | null | Error;

interface ProbeScript {
  probe: IVersionProbe;
  /** Every version read, in order, including the ones that threw. */
  reads: Array<{ nodeId: string; value: string | null }>;
  /** Every upgrade request the orchestrator made. */
  requests: Array<{ nodeId: string; version: string }>;
}

/**
 * A probe that answers per node from a script.
 *
 * The last reply in a node's script repeats, so a node that settles on a version
 * needs one entry and a node that never does needs one too. An `Error` in the
 * script is thrown from the read rather than returned — that is how a probe
 * whose engine is unreachable behaves, and it must not end the wait.
 */
function scriptedProbe(script: Record<string, Reply[]>, opts: { requestUpgrade?: boolean | Error } = {}): ProbeScript {
  const reads: ProbeScript['reads'] = [];
  const requests: ProbeScript['requests'] = [];
  const seen: Record<string, number> = {};

  const probe: IVersionProbe = {
    reportedVersion: async (nodeId: string) => {
      const seq = script[nodeId] ?? [null];
      const index = seen[nodeId] ?? 0;
      seen[nodeId] = index + 1;
      const reply = seq[Math.min(index, seq.length - 1)]!;
      if (reply instanceof Error) {
        reads.push({ nodeId, value: null });
        throw reply;
      }
      reads.push({ nodeId, value: reply });
      return reply;
    },
  };

  if (opts.requestUpgrade !== false) {
    const failure = opts.requestUpgrade instanceof Error ? opts.requestUpgrade : undefined;
    probe.requestUpgrade = async (nodeId: string, version: string) => {
      requests.push({ nodeId, version });
      if (failure) throw failure;
    };
  }

  return { probe, reads, requests };
}

function plan(overrides: Partial<RollingUpgradePlan> = {}): RollingUpgradePlan {
  return {
    id: 'i85',
    name: 'I85 plan',
    targetVersion: '2.0.0',
    nodes: ['n1'],
    batchStrategy: 'one_by_one',
    rollbackTrigger: 'on_first_failure',
    healthCheckNames: [],
    drain: { timeoutMs: 1, waitForInflight: false, connectionDrainMs: 1 },
    upgradeTimeoutMs: 50,
    upgradePollIntervalMs: 10,
    ...overrides,
  };
}

/** Every sleep the orchestrator asked for, which is how the poll cadence is observed. */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

// ── VW.1–VW.2: a plan nobody can verify is refused ─────────

describe('I85: a plan whose outcome cannot be observed', () => {
  it('VW.1 — refuses a plan before draining anything when no probe is bound', async () => {
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0 });

    await expect(orchestrator.execute(plan())).rejects.toThrow('no version probe was passed to the constructor');
    // Refusal happens in validation: no batch was started, so no node was
    // touched and nothing was recorded as upgraded.
    expect(orchestrator.getEvents()).toEqual([]);
    expect(orchestrator.getStats()).toBeNull();
    expect(orchestrator.getPhase()).toBe('idle');
  });

  it('VW.2 — the refusal names the version the plan asked for', async () => {
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0 });

    await expect(orchestrator.execute(plan({ targetVersion: '3.1.0' }))).rejects.toThrow('3.1.0');
  });
});

// ── VW.3–VW.6: the wait itself ─────────────────────────────

describe('I85: waiting for the reported version', () => {
  it('VW.3 — a node already on the target is confirmed on the first read and costs no sleep', async () => {
    const { probe, reads } = scriptedProbe({ n1: ['2.0.0'] });
    const { sleep, sleeps } = sleepRecorder();
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(1);
    expect(reads).toEqual([{ nodeId: 'n1', value: '2.0.0' }]);
    expect(sleeps).toEqual([]);
    expect(orchestrator.getBatches()[0]!.nodes[0]!.reportedVersion).toBe('2.0.0');
  });

  it('VW.4 — a node that reports the old version first is polled until it reports the new one', async () => {
    const { probe, reads } = scriptedProbe({ n1: ['1.9.0', '1.9.0', '2.0.0'] });
    const { sleep, sleeps } = sleepRecorder();
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('completed');
    expect(reads.map((r) => r.value)).toEqual(['1.9.0', '1.9.0', '2.0.0']);
    // Two waits between three reads, each the plan's interval — not the default.
    expect(sleeps).toEqual([10, 10]);
    const confirmed = orchestrator.getEvents().find((e) => e.type === 'node_version_confirmed');
    expect(confirmed?.details).toMatchObject({ nodeId: 'n1', version: '2.0.0', polls: 3 });
    expect(confirmed?.nodeId).toBe('n1');
  });

  it('VW.5 — a node that cannot answer yet (null) is waited for, not failed', async () => {
    const { probe, reads } = scriptedProbe({ n1: [null, null, '2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('completed');
    expect(reads).toHaveLength(3);
    expect(orchestrator.getBatches()[0]!.nodes[0]!.reportedVersion).toBe('2.0.0');
  });

  it('VW.6 — a probe that throws while the node restarts is a not-yet, not a failure', async () => {
    const { probe, reads } = scriptedProbe({ n1: [new Error('connection refused'), '2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('completed');
    expect(reads).toHaveLength(2);
  });

  it('VW.7 — the plan’s interval is floored at 1 ms rather than spinning on zero', async () => {
    const { probe } = scriptedProbe({ n1: ['1.9.0', '2.0.0'] });
    const { sleep, sleeps } = sleepRecorder();
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep, probe });

    const stats = await orchestrator.execute(plan({ upgradePollIntervalMs: 0 }));

    expect(stats.phase).toBe('completed');
    expect(sleeps).toEqual([1]);
  });
});

// ── VW.8–VW.11: what a node that never gets there looks like ──

describe('I85: a node that never reports the target version', () => {
  it('VW.8 — fails the node after the plan’s exact number of polls, naming what it saw', async () => {
    const { probe, reads } = scriptedProbe({ n1: ['1.9.0'] });
    const { sleep, sleeps } = sleepRecorder();
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep, probe });

    const stats = await orchestrator.execute(plan({ upgradeTimeoutMs: 30, upgradePollIntervalMs: 10 }));

    expect(stats.phase).toBe('failed');
    expect(stats.failedNodes).toBe(1);
    expect(stats.upgradedNodes).toBe(0);
    // ceil(30 / 10) = 3 polls, so 3 reads and 2 waits between them.
    expect(reads).toHaveLength(3);
    expect(sleeps).toEqual([10, 10]);

    const node = orchestrator.getBatches()[0]!.nodes[0]!;
    expect(node.status).toBe('failed');
    expect(node.error).toContain('did not report version 2.0.0 within 30 ms');
    expect(node.error).toContain('it reports 1.9.0');
    expect(node.reportedVersion).toBeUndefined();
  });

  it('VW.9 — a silent node is reported as having reported nothing at all', async () => {
    const { probe } = scriptedProbe({ n1: [null] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan({ upgradeTimeoutMs: 10, upgradePollIntervalMs: 10 }));

    expect(stats.phase).toBe('failed');
    expect(orchestrator.getBatches()[0]!.nodes[0]!.error).toContain('no version reported');
  });

  it('VW.10 — a timeout says why the last read failed, not just that it did', async () => {
    const { probe } = scriptedProbe({ n1: [new Error('socket hang up')] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    await orchestrator.execute(plan({ upgradeTimeoutMs: 20, upgradePollIntervalMs: 10 }));

    const error = orchestrator.getBatches()[0]!.nodes[0]!.error!;
    expect(error).toContain('no version reported');
    expect(error).toContain('socket hang up');
  });

  it('VW.11 — a failed verification is a failed batch, with the reason on the event', async () => {
    const { probe } = scriptedProbe({ n1: ['1.9.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    await orchestrator.execute(
      plan({ nodes: ['n1', 'n2'], batchStrategy: 'one_by_one', upgradeTimeoutMs: 10, upgradePollIntervalMs: 10 }),
    );

    const failed = orchestrator.getEvents().find((e) => e.type === 'batch_failed');
    expect(failed).toBeDefined();
    expect(String(failed!.details['reason'])).toContain('did not report version 2.0.0');
    // `RollingUpgradeEvent.batchIndex` is part of the public type and used to be
    // set by nothing: every emit passed the index inside `details` and left the
    // field undefined, so a consumer filtering events by batch found none.
    expect(failed!.batchIndex).toBe(1);
    expect(orchestrator.getEvents().some((e) => e.type === 'batch_promoted')).toBe(false);
  });
});

// ── VW.12–VW.13: the request side of the probe ─────────────

describe('I85: asking the node to upgrade', () => {
  it('VW.12 — asks the node for the plan’s target version exactly once, before reading', async () => {
    const { probe, requests, reads } = scriptedProbe({ n1: ['2.0.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    await orchestrator.execute(plan({ nodes: ['n1', 'n2'], batchStrategy: 'one_by_one' }));

    expect(requests).toEqual([
      { nodeId: 'n1', version: '2.0.0' },
      { nodeId: 'n2', version: '2.0.0' },
    ]);
    expect(reads).toHaveLength(2);
  });

  it('VW.13 — a request that cannot be delivered fails the node with the probe’s reason', async () => {
    const { probe, reads } = scriptedProbe({ n1: ['2.0.0'] }, { requestUpgrade: new Error('no agent on node') });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('failed');
    // The node was never asked, so its version was never read: waiting would
    // have burned the whole budget to report a timeout that hides the cause.
    expect(reads).toEqual([]);
    const error = orchestrator.getBatches()[0]!.nodes[0]!.error!;
    expect(error).toContain('could not request upgrade to 2.0.0');
    expect(error).toContain('no agent on node');
  });

  it('VW.14 — a probe with no requestUpgrade still verifies (the method is optional)', async () => {
    const { probe, reads, requests } = scriptedProbe({ n1: ['1.9.0', '2.0.0'] }, { requestUpgrade: false });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('completed');
    expect(requests).toEqual([]);
    expect(reads).toHaveLength(2);
  });
});

// ── VW.15–VW.17: batches, canary, and the rest of the plan ──

describe('I85: verification across batches and the canary', () => {
  it('VW.15 — each node in a batch is confirmed on its own account', async () => {
    const { probe } = scriptedProbe({ n1: ['1.9.0', '2.0.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan({ nodes: ['n1', 'n2'], batchStrategy: 'all_at_once' }));

    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(2);
    const confirmed = orchestrator.getEvents().filter((e) => e.type === 'node_version_confirmed');
    expect(confirmed.map((e) => [e.nodeId, e.details['polls']])).toEqual([
      ['n1', 2],
      ['n2', 1],
    ]);
  });

  it('VW.16 — a canary that never reaches the target is reported for what it did', async () => {
    const { probe } = scriptedProbe({ n1: ['1.9.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(
      plan({
        nodes: ['n1', 'n2'],
        batchStrategy: 'one_by_one',
        canary: { fraction: 0.5, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
        upgradeTimeoutMs: 10,
        upgradePollIntervalMs: 10,
      }),
    );

    expect(stats.phase).toBe('failed');
    // The failure carries the version reason rather than the old blanket
    // "Canary health check failed", which described an incident that had not
    // happened: the canary was never healthy-checked, it never started.
    const failed = orchestrator.getEvents().find((e) => e.type === 'batch_failed' && e.batchIndex === 1);
    expect(String(failed!.details['reason'])).toContain('did not report version 2.0.0');
    expect(orchestrator.getEvents().some((e) => e.type === 'canary_promoted')).toBe(false);
  });

  it('VW.17 — a late node inside the budget completes the whole plan', async () => {
    const { probe } = scriptedProbe({ n1: ['1.9.0', '1.9.0', '1.9.0', '2.0.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(
      plan({ nodes: ['n1', 'n2'], batchStrategy: 'one_by_one', upgradeTimeoutMs: 40, upgradePollIntervalMs: 10 }),
    );

    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(2);
    expect(stats.failedNodes).toBe(0);
  });

  it('VW.18 — pause is honoured at the batch boundary, after the batch in flight lands', async () => {
    const { probe } = scriptedProbe({ n1: ['2.0.0'], n2: ['2.0.0'] });
    const gates: number[] = [];
    // The gate sleeps *inside* the orchestrator, so the reference has to exist
    // before it does. A holder is enough — nothing in the case reassigns it.
    const holder: { orchestrator?: RollingUpgradeOrchestrator } = {};
    const orchestrator = new RollingUpgradeOrchestrator({
      minBakeMs: 0,
      probe,
      sleep: async (ms: number) => {
        gates.push(ms);
        // The only 100 ms sleep is the pause gate; releasing it here keeps the
        // case deterministic instead of racing a timer.
        if (ms === 100) await holder.orchestrator!.resume();
      },
    });
    holder.orchestrator = orchestrator;
    orchestrator.registerHealthCheck('pause-after-first', async () => {
      await orchestrator.pause();
      return { healthy: true, nodes: [], evaluatedAt: Date.now() };
    });

    const stats = await orchestrator.execute(
      plan({ nodes: ['n1', 'n2'], batchStrategy: 'one_by_one', healthCheckNames: ['pause-after-first'] }),
    );

    expect(gates).toEqual([100]);
    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(2);
  });

  it('VW.19 — a node that arrives on its last allowed poll is still confirmed, and nothing sleeps after it', async () => {
    // ceil(30 / 10) = 3 polls, and the third is the one that answers.
    const { probe, reads } = scriptedProbe({ n1: ['1.9.0', '1.9.0', '2.0.0'] });
    const { sleep, sleeps } = sleepRecorder();
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep, probe });

    const stats = await orchestrator.execute(plan({ upgradeTimeoutMs: 30, upgradePollIntervalMs: 10 }));

    expect(stats.phase).toBe('completed');
    expect(reads).toHaveLength(3);
    // Two waits between three reads: the third read ends the loop and the
    // orchestrator does not sleep on its way out of it.
    expect(sleeps).toEqual([10, 10]);
  });

  it('VW.20 — a probe that rejects with something other than an Error is still a not-yet', async () => {
    const probe: IVersionProbe = {
      reportedVersion: async () => {
        throw 'engine offline'; // eslint-disable-line no-throw-literal
      },
    };
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan({ upgradeTimeoutMs: 10, upgradePollIntervalMs: 10 }));

    expect(stats.phase).toBe('failed');
    // A rejection that is not an Error must not lose its text: the timeout is
    // the only place the operator learns why the node never answered.
    expect(orchestrator.getBatches()[0]!.nodes[0]!.error).toContain('engine offline');
  });

  it('VW.21 — a request that rejects with a string keeps that string as the reason', async () => {
    const { probe } = scriptedProbe({ n1: ['2.0.0'] }, { requestUpgrade: false });
    probe.requestUpgrade = async () => {
      throw 'agent refused'; // eslint-disable-line no-throw-literal
    };
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    const stats = await orchestrator.execute(plan());

    expect(stats.phase).toBe('failed');
    expect(orchestrator.getBatches()[0]!.nodes[0]!.error).toBe('could not request upgrade to 2.0.0: agent refused');
  });

  it('VW.22 — every batch-scoped event carries the batch it belongs to', async () => {
    const { probe } = scriptedProbe({ n1: ['2.0.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    await orchestrator.execute(
      plan({
        nodes: ['n1', 'n2'],
        batchStrategy: 'one_by_one',
        canary: { fraction: 0.5, bakeTimeMs: 0, requiredChecks: [], autoPromote: true },
      }),
    );

    const batchScoped = orchestrator
      .getEvents()
      .filter((e) =>
        [
          'batch_started',
          'batch_health_checked',
          'batch_promoted',
          'canary_started',
          'canary_health_checked',
          'canary_promoted',
        ].includes(e.type),
      );
    expect(batchScoped.length).toBe(6);
    // The canary is batch 1 and the rolling batch is batch 2 — read off the
    // event field rather than out of `details`, which is what a consumer has.
    expect(batchScoped.map((e) => [e.type, e.batchIndex])).toEqual([
      ['canary_started', 1],
      ['canary_health_checked', 1],
      ['canary_promoted', 1],
      ['batch_started', 2],
      ['batch_health_checked', 2],
      ['batch_promoted', 2],
    ]);
  });

  it('VW.23 — a bake interrupted by a non-Error rejection is reported as a failed canary', async () => {
    const { probe } = scriptedProbe({ n1: ['2.0.0'], n2: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({
      minBakeMs: 0,
      probe,
      sleep: async (ms: number) => {
        if (ms === 5) throw 'bake interrupted'; // eslint-disable-line no-throw-literal
      },
    });

    const stats = await orchestrator.execute(
      plan({
        nodes: ['n1', 'n2'],
        canary: { fraction: 0.5, bakeTimeMs: 5, requiredChecks: [], autoPromote: true },
      }),
    );

    expect(stats.phase).toBe('failed');
    const failed = orchestrator.getEvents().find((e) => e.type === 'batch_failed');
    expect(String(failed!.details['reason'])).toBe('Canary failed');
  });

  it('VW.24 — a strategy the type does not name falls back to fixed-size batching', async () => {
    // A plan can arrive from JSON, where the type system is not there to help.
    const offContract = 'rolling-ish' as unknown as RollingUpgradePlan['batchStrategy'];
    const { probe } = scriptedProbe({ n1: ['2.0.0'], n2: ['2.0.0'], n3: ['2.0.0'] });
    const orchestrator = new RollingUpgradeOrchestrator({ minBakeMs: 0, sleep: async () => {}, probe });

    // No batchSize either: the fallback strategy reads it, finds nothing, and
    // uses one node per batch.
    const stats = await orchestrator.execute(plan({ nodes: ['n1', 'n2', 'n3'], batchStrategy: offContract }));

    expect(stats.phase).toBe('completed');
    expect(stats.upgradedNodes).toBe(3);
    expect(orchestrator.getBatches().map((b) => b.nodes.length)).toEqual([1, 1, 1]);
  });
});
