/**
 * A fault is a description; a transport is a direction.
 *
 * `ChaosEngineV2` injects `ChaosFaultV2` values through `IChaosTransport`, and the
 * two vocabularies do not line up in a way that can be ignored:
 *
 *   - **A partition is symmetric.** `isolate(['n2','n3'])` called on `n1` stops
 *     `n1` sending to `n2` and `n3`; it does not stop `n2` sending to `n1`. A
 *     fault described as "separate {n1} from {n2,n3}" that only isolates `n1` is a
 *     half-open connection — traffic still flows, the retry succeeds, and the
 *     test that was supposed to prove the cluster survives a partition proves
 *     nothing. Every pair here is emitted in both directions.
 *   - **A leader is a fact, not a target.** `leadership-flap` names no node. It
 *     means "the node that is leading now", and only the cluster knows which one
 *     that is — at translation time, not at scenario-authoring time.
 *   - **Some faults are not transport faults.** `clock-skew` and
 *     `resource-pressure` change a clock or a cgroup. There is no method on
 *     `IChaosTransport` that can express them, so this translator refuses them by
 *     name instead of returning an empty instruction list — an empty list reads
 *     like "the fault was injected and had no effect", which is the most
 *     expensive way to be wrong about a chaos run.
 *
 * @module @agentix-e/db-cluster/chaos
 */

import type { ChaosFaultV2, ChaosTransportStats, IChaosTransport } from '@agentix-e/db-node/chaosengine';
import type { ClusterMember } from '../interfaces/index.js';
import { leaderOf } from '../membership/quorum.js';

/** One method call on one transport. */
export type TransportOperation =
  | { op: 'isolate'; peers: string[] }
  | { op: 'heal'; peers: string[] }
  | { op: 'setMessageLoss'; rate: number }
  | { op: 'setLatency'; ms: number }
  | { op: 'stop' }
  | { op: 'start' };

export interface TransportInstruction {
  transportId: string;
  operation: TransportOperation;
}

export interface FaultTranslation {
  /** The fault this translation realises. */
  fault: ChaosFaultV2;
  /** Calls to make, in order. Empty when `refusal` is set. */
  instructions: TransportInstruction[];
  /** Why the fault cannot be realised, or `null`. */
  refusal: string | null;
  /** Targets the fault named that no member matches. */
  unknownTargets: string[];
}

export class RaftFaultTranslator {
  /**
   * Translate a fault into transport calls.
   *
   * Pure: the same fault and the same member set produce the same instructions,
   * which is what makes a chaos run reproducible from its seed and its log.
   */
  translate(fault: ChaosFaultV2, members: readonly ClusterMember[]): FaultTranslation {
    const known = new Set(members.map((member) => member.id));
    const unknownTargets = fault.targets.filter((id) => !known.has(id));

    // A fault aimed at a node that is not in the group is not a fault; it is a
    // typo that would report "injected" and change nothing.
    if (unknownTargets.length > 0) {
      return {
        fault,
        instructions: [],
        refusal: `no member matches target(s) ${unknownTargets.join(', ')}`,
        unknownTargets,
      };
    }

    switch (fault.type) {
      case 'network-partition':
        return this.partition(fault, members, unknownTargets);
      case 'node-crash':
        return {
          fault,
          instructions: fault.targets.map((transportId) => ({
            transportId,
            operation: { op: 'stop' as const },
          })),
          refusal: null,
          unknownTargets,
        };
      case 'message-loss':
        return this.knob(fault, members, unknownTargets, 'setMessageLoss', 'rate');
      case 'latency-injection':
        return this.latency(fault, members, unknownTargets);
      case 'leadership-flap':
        return this.leadershipFlap(fault, members, unknownTargets);
      default:
        return {
          fault,
          instructions: [],
          refusal:
            `a ${fault.type} fault is not expressible through IChaosTransport ` +
            '(no method sets a clock, a cgroup or a dependency chain)',
          unknownTargets,
        };
    }
  }

  /**
   * The inverse of `translate` — the calls that undo the fault.
   *
   * Written here rather than left to the caller because the symmetry is the whole
   * point: a partition in both directions has to be healed in both directions, or
   * the group stays half-joined after the scenario reports `passed`.
   */
  revert(fault: ChaosFaultV2, members: readonly ClusterMember[]): FaultTranslation {
    const forward = this.translate(fault, members);
    if (forward.refusal !== null) return forward;

    return {
      fault,
      instructions: forward.instructions.map(({ transportId, operation }) => ({
        transportId,
        operation: inverseOf(operation),
      })),
      refusal: null,
      unknownTargets: forward.unknownTargets,
    };
  }

  private partition(
    fault: ChaosFaultV2,
    members: readonly ClusterMember[],
    unknownTargets: string[],
  ): FaultTranslation {
    const groups = partitionGroups(fault, members);
    if (groups === null) {
      return {
        fault,
        instructions: [],
        refusal: 'config.groups must be two non-empty arrays of member ids',
        unknownTargets,
      };
    }

    const [left, right] = groups;
    const instructions: TransportInstruction[] = [];
    const oneWay = fault.config.direction === 'one-way';

    for (const source of left) {
      instructions.push({
        transportId: source,
        operation: { op: 'isolate', peers: [...right].sort() },
      });
    }
    // The other direction is what makes this a partition rather than a
    // one-sided connection reset.
    if (!oneWay) {
      for (const source of right) {
        instructions.push({
          transportId: source,
          operation: { op: 'isolate', peers: [...left].sort() },
        });
      }
    }

    return { fault, instructions, refusal: null, unknownTargets };
  }

  private knob(
    fault: ChaosFaultV2,
    members: readonly ClusterMember[],
    unknownTargets: string[],
    op: 'setMessageLoss',
    key: 'rate',
  ): FaultTranslation {
    const value = Number(fault.config[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return {
        fault,
        instructions: [],
        refusal: `config.${key} must be a number in [0, 1]`,
        unknownTargets,
      };
    }

    // Loss is a property of the *sender's* transport, so dropping traffic between
    // a target and its peers needs the knob turned on both ends. `scope` lets a
    // scenario say which half it means; the default is both, because the fault
    // says "between".
    const targets = new Set(fault.targets);
    const peers = members.filter((member) => !targets.has(member.id)).map((member) => member.id);
    // Three readings of `scope`, and the third is the default: "both" is what the
    // word "between" in a fault description means, and an unrecognised value is a
    // caller that meant the default. Normalising the string first and then
    // comparing it again was a second copy of this decision.
    const affected =
      fault.config.scope === 'targets' ? [...targets] : fault.config.scope === 'peers' ? peers : [...targets, ...peers];

    return {
      fault,
      instructions: [...new Set(affected)]
        .sort()
        .map((transportId) => ({ transportId, operation: { op, rate: value } })),
      refusal: null,
      unknownTargets,
    };
  }

  private latency(fault: ChaosFaultV2, members: readonly ClusterMember[], unknownTargets: string[]): FaultTranslation {
    // Jitter is not a knob `IChaosTransport` has. Applying the base delay and
    // ignoring the jitter would make a scenario that says "50 ms ± 40 ms" run as a
    // scenario that says "50 ms", and the two test different things.
    if (fault.config.jitterMs !== undefined && Number(fault.config.jitterMs) !== 0) {
      return {
        fault,
        instructions: [],
        refusal: 'setLatency cannot express jitter; drop config.jitterMs or use a transport that can',
        unknownTargets,
      };
    }

    const ms = Number(fault.config.ms);
    if (!Number.isFinite(ms) || ms < 0) {
      return { fault, instructions: [], refusal: 'config.ms must be a number >= 0', unknownTargets };
    }

    return {
      fault,
      instructions: [...fault.targets]
        .sort()
        .map((transportId) => ({ transportId, operation: { op: 'setLatency' as const, ms } })),
      refusal: null,
      unknownTargets,
    };
  }

  private leadershipFlap(
    fault: ChaosFaultV2,
    members: readonly ClusterMember[],
    unknownTargets: string[],
  ): FaultTranslation {
    const leader = leaderOf(members);
    if (!leader) {
      // The fault names no node on purpose. With no leader there is nothing to
      // flap, and "injected successfully" would be a lie the scenario believes.
      return {
        fault,
        instructions: [],
        refusal: 'no member is currently leader; there is nothing to flap',
        unknownTargets,
      };
    }
    return {
      fault,
      instructions: [{ transportId: leader.id, operation: { op: 'stop' } }],
      refusal: null,
      unknownTargets,
    };
  }
}

/**
 * The two sides of a partition.
 *
 * Explicit `config.groups` wins. Otherwise the fault's `targets` are one side and
 * every other member is the other — which is the reading that makes
 * `targets: ['n1']` mean "isolate n1", not "isolate n1 from itself".
 */
function partitionGroups(fault: ChaosFaultV2, members: readonly ClusterMember[]): [string[], string[]] | null {
  const declared = fault.config.groups;
  if (Array.isArray(declared)) {
    if (declared.length !== 2) return null;
    const [first, second] = declared as unknown[];
    if (!Array.isArray(first) || !Array.isArray(second)) return null;
    const left = first.filter((id): id is string => typeof id === 'string');
    const right = second.filter((id): id is string => typeof id === 'string');
    if (left.length === 0 || right.length === 0) return null;
    return [left, right];
  }

  const targets = new Set(fault.targets);
  const others = members.filter((member) => !targets.has(member.id)).map((member) => member.id);
  if (others.length === 0) return null;
  return [[...targets], others];
}

/**
 * The operation that undoes `operation`.
 *
 * Total on purpose: every operation has an inverse, so `revert()` is a `map` and
 * not a switch with arms that can never be taken. Two of the inverses are
 * involutions (isolate ↔ heal, stop ↔ start); the two that set a knob are not, and
 * pretending otherwise would be the bug: the inverse of a latency is *no latency*,
 * not the reciprocal of one, and undoing a cleared knob clears it. Idempotent, not
 * symmetric — which is what a revert has to be to be safe to run twice.
 */
export function inverseOf(operation: TransportOperation): TransportOperation {
  switch (operation.op) {
    case 'isolate':
      return { op: 'heal', peers: [...operation.peers] };
    case 'heal':
      return { op: 'isolate', peers: [...operation.peers] };
    case 'setMessageLoss':
      return { op: 'setMessageLoss', rate: 0 };
    case 'setLatency':
      return { op: 'setLatency', ms: 0 };
    case 'stop':
      return { op: 'start' };
    case 'start':
      return { op: 'stop' };
  }
}

/**
 * Apply translations to real transports.
 *
 * Split from the translator so that the decision is testable without a transport
 * and the transport call is testable without the decision. An instruction naming a
 * transport the caller did not supply is an error, not a skip: a scenario that
 * silently ignores the one node it was supposed to break is a scenario that
 * passes for the wrong reason.
 */
export async function applyInstructions(
  transports: ReadonlyMap<string, IChaosTransport>,
  instructions: readonly TransportInstruction[],
): Promise<ChaosTransportStats[]> {
  const stats: ChaosTransportStats[] = [];
  for (const { transportId, operation } of instructions) {
    const transport = transports.get(transportId);
    if (!transport) {
      throw new Error(
        `no transport registered for "${transportId}"; the fault cannot be applied to a node ` +
          'the caller did not provide',
      );
    }
    switch (operation.op) {
      case 'isolate':
        transport.isolate(operation.peers);
        break;
      case 'heal':
        transport.heal(operation.peers);
        break;
      case 'setMessageLoss':
        transport.setMessageLoss(operation.rate);
        break;
      case 'setLatency':
        transport.setLatency(operation.ms);
        break;
      case 'stop':
        await transport.stop();
        break;
      case 'start':
        await transport.start();
        break;
    }
    stats.push(transport.getStats());
  }
  return stats;
}
