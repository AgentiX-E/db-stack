/**
 * A fault that reaches one side of a partition has not reached the other.
 *
 * These cases pin the three things `IChaosTransport` cannot say by itself: who the
 * leader is, that a partition has two directions, and that some faults are not
 * transport faults at all. The last one is the one that costs a day: an empty
 * instruction list reads like "injected, no effect", so it is a refusal here.
 */

import { describe, expect, it } from 'vitest';
import type { ChaosFaultV2, ChaosTransportStats, IChaosTransport } from '@agentix-e/db-operations-node/chaosengine';
import type { ClusterMember } from '../../interfaces/index.js';
import {
  applyInstructions,
  inverseOf,
  RaftFaultTranslator,
  type TransportInstruction,
} from '../RaftFaultTranslator.js';

const translator = new RaftFaultTranslator();

const members = (...specs: Array<[string, ClusterMember['role']]>): ClusterMember[] =>
  specs.map(([id, role]) => ({ id, role }));

const three = (): ClusterMember[] => members(['n1', 'leader'], ['n2', 'follower'], ['n3', 'follower']);

const fault = (type: ChaosFaultV2['type'], targets: string[], config: Record<string, unknown> = {}): ChaosFaultV2 => ({
  type,
  targets,
  durationMs: 1_000,
  config,
});

/** A transport that does what it is told and remembers being told. */
class RecordingTransport implements IChaosTransport {
  readonly transportId: string;
  readonly calls: string[] = [];
  readonly isolated = new Set<string>();
  lossRate = 0;
  latencyMs = 0;
  stopped = false;

  constructor(id: string) {
    this.transportId = id;
  }

  isolate(peers: string[]): void {
    for (const peer of peers) this.isolated.add(peer);
    this.calls.push(`isolate:${peers.join(',')}`);
  }

  heal(peers: string[]): void {
    for (const peer of peers) this.isolated.delete(peer);
    this.calls.push(`heal:${peers.join(',')}`);
  }

  healAll(): void {
    this.isolated.clear();
    this.calls.push('healAll');
  }

  setMessageLoss(rate: number): void {
    this.lossRate = rate;
    this.calls.push(`loss:${rate}`);
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
    this.calls.push(`latency:${ms}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.calls.push('stop');
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.calls.push('start');
  }

  getStats(): ChaosTransportStats {
    return {
      messagesSent: 0,
      messagesLost: 0,
      messagesDelayed: 0,
      partitioned: this.isolated.size,
      avgLatencyMs: this.latencyMs,
      connectedPeers: 2 - this.isolated.size,
      totalPeers: 2,
    };
  }

  isHealthy(): boolean {
    return !this.stopped;
  }
}

describe('RaftFaultTranslator — refusals', () => {
  it('AC-CL5.1 refuses a fault aimed at a node the group does not have', () => {
    const result = translator.translate(fault('node-crash', ['n1', 'n7']), three());

    expect(result.refusal).toBe('no member matches target(s) n7');
    expect(result.unknownTargets).toEqual(['n7']);
    // Empty instructions *and* a refusal: an empty list alone would read as
    // "injected, had no effect".
    expect(result.instructions).toEqual([]);
  });

  it('AC-CL5.20 names every unknown target, in the order the fault wrote them', () => {
    const result = translator.translate(fault('node-crash', ['n8', 'n1', 'n7']), three());

    // One sentence per fault, not one per target: a typo'd scenario has to be
    // fixable from a single log line, and the separator is part of the sentence.
    expect(result.refusal).toBe('no member matches target(s) n8, n7');
    expect(result.unknownTargets).toEqual(['n8', 'n7']);
    expect(result.instructions).toEqual([]);
  });

  it('AC-CL5.2 refuses a fault a transport cannot express, naming the fault type and the missing capability', () => {
    for (const type of ['clock-skew', 'resource-pressure', 'cascading-failure'] as const) {
      const result = translator.translate(fault(type, ['n2']), three());
      expect(result.refusal, type).toBe(
        `a ${type} fault is not expressible through IChaosTransport ` +
          '(no method sets a clock, a cgroup or a dependency chain)',
      );
      expect(result.instructions).toEqual([]);
    }
  });

  it('AC-CL5.3 refuses a partition that names one side only', () => {
    const result = translator.translate(fault('network-partition', ['n1', 'n2', 'n3']), three());
    expect(result.refusal).toBe('config.groups must be two non-empty arrays of member ids');
    expect(result.instructions).toEqual([]);
  });

  it('AC-CL5.4 refuses a partition whose groups are the wrong shape', () => {
    // Every shape that is not "two non-empty arrays of ids": one group, three
    // groups, no wrapper at all, an empty side, a side of numbers, and a side
    // that is not a list (`&&` or `||` between the two array checks disagree
    // exactly there).
    const shapes: unknown[] = [
      [['n1']],
      [['n1'], ['n2'], ['n3']],
      ['n1', 'n2'],
      [[], ['n2']],
      [[1], ['n2']],
      [['n1'], [2]],
      [['n1'], 'n2'],
    ];
    for (const groups of shapes) {
      const result = translator.translate(fault('network-partition', ['n1'], { groups }), three());
      expect(result.refusal, JSON.stringify(groups)).toBe('config.groups must be two non-empty arrays of member ids');
      expect(result.instructions, JSON.stringify(groups)).toEqual([]);
    }
  });

  it('AC-CL5.5 refuses a flap when there is no leader to flap', () => {
    const result = translator.translate(fault('leadership-flap', []), members(['n1', 'follower'], ['n2', 'follower']));
    expect(result.refusal).toBe('no member is currently leader; there is nothing to flap');
    expect(result.instructions).toEqual([]);
  });

  it('AC-CL5.6 refuses knobs it cannot honour rather than approximating them', () => {
    // Four values a scenario can write by accident: a rate above the domain, a
    // rate below it, a rate that is not a number, and a negative delay. Each is a
    // refusal with no instruction — a knob set to a value the transport would have
    // to round is a fault that did not happen as written.
    for (const [config, refusal] of [
      [{ rate: 1.5 }, 'config.rate must be a number in [0, 1]'],
      [{ rate: -0.1 }, 'config.rate must be a number in [0, 1]'],
      [{ rate: 'lots' }, 'config.rate must be a number in [0, 1]'],
    ] as const) {
      const result = translator.translate(fault('message-loss', ['n1'], config), three());
      expect(result.refusal, JSON.stringify(config)).toBe(refusal);
      expect(result.instructions, JSON.stringify(config)).toEqual([]);
    }

    const negativeDelay = translator.translate(fault('latency-injection', ['n1'], { ms: -5 }), three());
    expect(negativeDelay.refusal).toBe('config.ms must be a number >= 0');
    expect(negativeDelay.instructions).toEqual([]);
    const jitter = translator.translate(fault('latency-injection', ['n1'], { ms: 50, jitterMs: 40 }), three());
    expect(jitter.refusal).toBe('setLatency cannot express jitter; drop config.jitterMs or use a transport that can');
    expect(jitter.instructions).toEqual([]);
  });
});

describe('RaftFaultTranslator — instructions', () => {
  it('AC-CL5.7 isolates both directions, because a one-sided isolation is not a partition', () => {
    const result = translator.translate(fault('network-partition', ['n1']), three());

    expect(result.instructions).toEqual([
      { transportId: 'n1', operation: { op: 'isolate', peers: ['n2', 'n3'] } },
      { transportId: 'n2', operation: { op: 'isolate', peers: ['n1'] } },
      { transportId: 'n3', operation: { op: 'isolate', peers: ['n1'] } },
    ]);
  });

  it('AC-CL5.8 honours explicit groups and a one-way direction', () => {
    const explicit = translator.translate(fault('network-partition', ['n1'], { groups: [['n1'], ['n2']] }), three());
    expect(explicit.instructions).toEqual([
      { transportId: 'n1', operation: { op: 'isolate', peers: ['n2'] } },
      { transportId: 'n2', operation: { op: 'isolate', peers: ['n1'] } },
    ]);

    const oneWay = translator.translate(
      fault('network-partition', ['n1'], { groups: [['n1'], ['n2']], direction: 'one-way' }),
      three(),
    );
    expect(oneWay.instructions).toEqual([{ transportId: 'n1', operation: { op: 'isolate', peers: ['n2'] } }]);
  });

  it('AC-CL5.9 stops every crash target', () => {
    const result = translator.translate(fault('node-crash', ['n2', 'n3']), three());
    expect(result.instructions).toEqual([
      { transportId: 'n2', operation: { op: 'stop' } },
      { transportId: 'n3', operation: { op: 'stop' } },
    ]);
  });

  it('AC-CL5.10 applies a message-loss knob on both ends by default', () => {
    const both = translator.translate(fault('message-loss', ['n1'], { rate: 0.3 }), three());
    expect(both.instructions.map((instruction) => instruction.transportId)).toEqual(['n1', 'n2', 'n3']);

    const targets = translator.translate(fault('message-loss', ['n1'], { rate: 0.3, scope: 'targets' }), three());
    expect(targets.instructions.map((instruction) => instruction.transportId)).toEqual(['n1']);

    const peers = translator.translate(fault('message-loss', ['n1'], { rate: 0.3, scope: 'peers' }), three());
    expect(peers.instructions.map((instruction) => instruction.transportId)).toEqual(['n2', 'n3']);

    // `both` is built as targets-then-peers, which is not sorted unless
    // something sorts it: the instruction list is what a reader replays.
    const unsorted = translator.translate(fault('message-loss', ['n3'], { rate: 0.3 }), three());
    expect(unsorted.instructions.map((instruction) => instruction.transportId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('AC-CL5.24 accepts both ends of the knob domain, and only them', () => {
    // [0, 1] is closed: 0 is "no loss" and 1 is "nothing arrives". A validation
    // written with a strict comparison at either end refuses a scenario the
    // transport can run, and the refusal reads like a typo in the scenario.
    const none = translator.translate(fault('message-loss', ['n1'], { rate: 0, scope: 'targets' }), three());
    expect(none.refusal).toBeNull();
    expect(none.instructions).toEqual([{ transportId: 'n1', operation: { op: 'setMessageLoss', rate: 0 } }]);

    const all = translator.translate(fault('message-loss', ['n1'], { rate: 1, scope: 'targets' }), three());
    expect(all.refusal).toBeNull();
    expect(all.instructions).toEqual([{ transportId: 'n1', operation: { op: 'setMessageLoss', rate: 1 } }]);

    // Zero latency is a knob value, not a missing one.
    const zero = translator.translate(fault('latency-injection', ['n1'], { ms: 0 }), three());
    expect(zero.refusal).toBeNull();
    expect(zero.instructions).toEqual([{ transportId: 'n1', operation: { op: 'setLatency', ms: 0 } }]);
  });

  it('AC-CL5.25 treats an unrecognised scope as both ends', () => {
    const result = translator.translate(fault('message-loss', ['n2'], { rate: 0.1, scope: 'sideways' }), three());
    expect(result.instructions.map((instruction) => instruction.transportId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('AC-CL5.11 sets latency on the targets, in id order, and accepts zero jitter', () => {
    const result = translator.translate(fault('latency-injection', ['n2'], { ms: 50, jitterMs: 0 }), three());
    expect(result.instructions).toEqual([{ transportId: 'n2', operation: { op: 'setLatency', ms: 50 } }]);

    const unsorted = translator.translate(fault('latency-injection', ['n3', 'n2'], { ms: 5 }), three());
    expect(unsorted.instructions).toEqual([
      { transportId: 'n2', operation: { op: 'setLatency', ms: 5 } },
      { transportId: 'n3', operation: { op: 'setLatency', ms: 5 } },
    ]);
  });

  it('AC-CL5.26 sorts the peers it isolates, whatever order the groups were written in', () => {
    const right = translator.translate(fault('network-partition', ['n1'], { groups: [['n1'], ['n3', 'n2']] }), three());

    // The partition is a set of pairs; the order inside `peers` is what a diff
    // of two runs would otherwise show as a change of plan.
    expect(right.instructions).toEqual([
      { transportId: 'n1', operation: { op: 'isolate', peers: ['n2', 'n3'] } },
      { transportId: 'n3', operation: { op: 'isolate', peers: ['n1'] } },
      { transportId: 'n2', operation: { op: 'isolate', peers: ['n1'] } },
    ]);

    // The same rule on the other side: two peers, written out of order.
    const left = translator.translate(fault('network-partition', ['n1'], { groups: [['n2', 'n1'], ['n3']] }), three());
    expect(left.instructions).toEqual([
      { transportId: 'n2', operation: { op: 'isolate', peers: ['n3'] } },
      { transportId: 'n1', operation: { op: 'isolate', peers: ['n3'] } },
      { transportId: 'n3', operation: { op: 'isolate', peers: ['n1', 'n2'] } },
    ]);
  });

  it('AC-CL5.12 flaps the leader the group actually has', () => {
    const result = translator.translate(fault('leadership-flap', []), three());
    expect(result.instructions).toEqual([{ transportId: 'n1', operation: { op: 'stop' } }]);

    const moved = translator.translate(fault('leadership-flap', []), members(['n1', 'follower'], ['n2', 'leader']));
    expect(moved.instructions).toEqual([{ transportId: 'n2', operation: { op: 'stop' } }]);
  });
});

describe('RaftFaultTranslator — undo', () => {
  it('AC-CL5.13 heals both sides, stops the stopped, and clears the knobs', () => {
    expect(translator.revert(fault('network-partition', ['n1']), three()).instructions).toEqual([
      { transportId: 'n1', operation: { op: 'heal', peers: ['n2', 'n3'] } },
      { transportId: 'n2', operation: { op: 'heal', peers: ['n1'] } },
      { transportId: 'n3', operation: { op: 'heal', peers: ['n1'] } },
    ]);

    expect(translator.revert(fault('node-crash', ['n2']), three()).instructions).toEqual([
      { transportId: 'n2', operation: { op: 'start' } },
    ]);

    expect(
      translator.revert(fault('message-loss', ['n1'], { rate: 0.5, scope: 'targets' }), three()).instructions,
    ).toEqual([{ transportId: 'n1', operation: { op: 'setMessageLoss', rate: 0 } }]);

    expect(translator.revert(fault('latency-injection', ['n1'], { ms: 80 }), three()).instructions).toEqual([
      { transportId: 'n1', operation: { op: 'setLatency', ms: 0 } },
    ]);
  });

  it('AC-CL5.14 passes a refusal through instead of inventing an inverse for it', () => {
    const refused = translator.revert(fault('clock-skew', ['n1']), three());
    expect(refused.instructions).toEqual([]);
    expect(refused.refusal).toContain('clock-skew');
  });

  it('AC-CL5.15 inverts every operation, and twice is once', () => {
    const pairs: Array<[TransportInstruction['operation'], TransportInstruction['operation']]> = [
      [
        { op: 'isolate', peers: ['n2'] },
        { op: 'heal', peers: ['n2'] },
      ],
      [
        { op: 'heal', peers: ['n2'] },
        { op: 'isolate', peers: ['n2'] },
      ],
      [{ op: 'stop' }, { op: 'start' }],
      [{ op: 'start' }, { op: 'stop' }],
      [
        { op: 'setLatency', ms: 40 },
        { op: 'setLatency', ms: 0 },
      ],
      [
        { op: 'setMessageLoss', rate: 0.2 },
        { op: 'setMessageLoss', rate: 0 },
      ],
    ];

    for (const [operation, expected] of pairs) {
      expect(inverseOf(operation), operation.op).toEqual(expected);
    }
    // Idempotent, not symmetric: clearing a cleared knob clears it.
    expect(inverseOf(inverseOf({ op: 'setLatency', ms: 40 }))).toEqual({ op: 'setLatency', ms: 0 });
    expect(inverseOf(inverseOf({ op: 'isolate', peers: ['n2'] }))).toEqual({
      op: 'isolate',
      peers: ['n2'],
    });
  });
});

describe('applyInstructions', () => {
  it('AC-CL5.16 calls the transports it was given and returns what they report', async () => {
    const transports = new Map<string, IChaosTransport>([
      ['n1', new RecordingTransport('n1')],
      ['n2', new RecordingTransport('n2')],
      ['n3', new RecordingTransport('n3')],
    ]);
    const translation = translator.translate(fault('network-partition', ['n1']), three());

    const stats = await applyInstructions(transports, translation.instructions);

    expect(stats).toHaveLength(3);
    expect(stats[0]?.partitioned).toBe(2);
    const n1 = transports.get('n1') as RecordingTransport;
    const n2 = transports.get('n2') as RecordingTransport;
    expect(n1.isolated).toEqual(new Set(['n2', 'n3']));
    expect(n2.isolated).toEqual(new Set(['n1']));
    expect(n1.calls).toEqual(['isolate:n2,n3']);
  });

  it('AC-CL5.17 awaits a crash, so a scenario cannot race the stop', async () => {
    const n2 = new RecordingTransport('n2');
    const transports = new Map<string, IChaosTransport>([['n2', n2]]);

    await applyInstructions(transports, [{ transportId: 'n2', operation: { op: 'stop' } }]);
    expect(n2.stopped).toBe(true);

    await applyInstructions(transports, [{ transportId: 'n2', operation: { op: 'start' } }]);
    expect(n2.stopped).toBe(false);
    expect(n2.calls).toEqual(['stop', 'start']);
  });

  it('AC-CL5.18 refuses to silently skip a transport the caller did not provide', async () => {
    const transports = new Map<string, IChaosTransport>([['n1', new RecordingTransport('n1')]]);
    await expect(applyInstructions(transports, [{ transportId: 'n3', operation: { op: 'stop' } }])).rejects.toThrow(
      'no transport registered for "n3"; the fault cannot be applied to a node the caller did not provide',
    );
  });

  it('AC-CL5.19 flips the knobs it was told to flip', async () => {
    const n1 = new RecordingTransport('n1');
    await applyInstructions(new Map<string, IChaosTransport>([['n1', n1]]), [
      { transportId: 'n1', operation: { op: 'setMessageLoss', rate: 0.4 } },
      { transportId: 'n1', operation: { op: 'setLatency', ms: 25 } },
      { transportId: 'n1', operation: { op: 'heal', peers: ['n2'] } },
      { transportId: 'n1', operation: { op: 'isolate', peers: ['n2'] } },
    ]);

    expect(n1.lossRate).toBe(0.4);
    expect(n1.latencyMs).toBe(25);
    expect(n1.calls).toEqual(['loss:0.4', 'latency:25', 'heal:n2', 'isolate:n2']);
  });
});
