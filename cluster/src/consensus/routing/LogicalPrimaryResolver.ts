/**
 * Logical primary name — a stable address that follows the elected leader.
 *
 * A physical node id makes failover a DNS change: every client holds a name
 * that stops answering the moment the leader moves. A logical name resolves
 * through the cluster's own membership on each call, so the name is stable and
 * the address behind it follows the election. The resolver knows nothing about
 * Raft or any storage engine — it reads a leader id and a member set through
 * injected callbacks, which any consensus implementation can supply.
 *
 * Two facts make a resolution trustworthy: the election is authoritative for
 * *which* node leads (a member row's role label may lag an election and is not
 * consulted), and the leader must be a live member (an id outside the member
 * set is a name that would resolve to a node nobody can reach).
 *
 * The epoch is a monotonic generation that advances only when the resolved
 * member actually changes. A client that caches a resolution compares epochs
 * to notice failover without inspecting node ids.
 *
 * @module @agentix-e/db-cluster/routing
 */

/** Role a member reports. Only the id is authoritative for name resolution. */
export interface PrimaryMember {
  readonly id: string;
  readonly role: 'leader' | 'follower' | 'candidate' | 'learner';
}

/** The cluster facts needed to resolve a logical name, read fresh each call. */
export interface PrimaryResolutionInput {
  readonly leaderId: number | string | null;
  readonly members: readonly PrimaryMember[];
  /** Optional term, carried through to the result for observability. */
  readonly leaderTerm?: number;
}

/** Why a resolution succeeded or was refused. */
export type PrimaryResolutionReason = 'leader-is-member' | 'no-leader' | 'no-members' | 'leader-not-a-member';

/** The stateless core of a resolution — one answer over one membership snapshot. */
export interface PrimaryResolutionCore {
  readonly name: string;
  /** The concrete member id, or null when the name cannot be resolved. */
  readonly memberId: string | null;
  readonly resolved: boolean;
  readonly reason: PrimaryResolutionReason;
  readonly leaderTerm: number | undefined;
}

/** A resolution plus the generation state kept by {@link LogicalPrimaryResolver}. */
export interface PrimaryResolution extends PrimaryResolutionCore {
  /** Monotonic generation; 0 before the first successful resolution. */
  readonly epoch: number;
  /** True only on the resolution that moved to a different member. */
  readonly changed: boolean;
}

/** Live callbacks the resolver reads on every resolve. */
export interface LogicalPrimaryDeps {
  readonly leader: () => Promise<number | string | null>;
  readonly members: () => Promise<readonly PrimaryMember[]>;
  readonly term?: () => Promise<number | undefined>;
}

/**
 * Match a consensus leader id against a member's transport id.
 *
 * A Raft node reports a numeric id; a cluster member carries a string id such
 * as `node-2` (or a bare `2`). Both forms name the same node, so resolution
 * accepts either. A member row's role label is deliberately ignored: an
 * election can move faster than a membership view, and the elected id is the
 * fact a router must follow.
 */
function matchesLeader(memberId: string, leaderId: number | string): boolean {
  const key = String(leaderId);
  return memberId === key || (typeof leaderId === 'number' && memberId === `node-${leaderId}`);
}

/**
 * Pure resolution over one snapshot of cluster facts.
 *
 * Separated from the stateful resolver so an engine can resolve without
 * constructing an object, and so every rule is testable without async.
 */
export function resolveLogicalPrimary(name: string, input: PrimaryResolutionInput): PrimaryResolutionCore {
  if (name.trim() === '') {
    throw new Error('logical name must be non-empty');
  }
  const base: PrimaryResolutionCore = {
    name,
    memberId: null,
    resolved: false,
    reason: 'no-leader',
    leaderTerm: input.leaderTerm,
  };

  if (input.members.length === 0) {
    return { ...base, reason: 'no-members' };
  }
  if (input.leaderId === null) {
    return base;
  }

  const match = input.members.find((m) => matchesLeader(m.id, input.leaderId!));
  if (!match) {
    return { ...base, reason: 'leader-not-a-member' };
  }

  return { ...base, memberId: match.id, resolved: true, reason: 'leader-is-member' };
}

/**
 * Stateful resolver that keeps the epoch across elections.
 *
 * Constructing one for a logical name and calling `resolve()` after each
 * suspected failover gives a caller a stable name plus a generation it can
 * cache against. The injected callbacks are read afresh every call.
 */
export class LogicalPrimaryResolver {
  private currentMemberId: string | null = null;
  private currentEpoch = 0;

  constructor(
    readonly name: string,
    private readonly deps: LogicalPrimaryDeps,
  ) {
    if (name.trim() === '') {
      throw new Error('logical name must be non-empty');
    }
  }

  /** Latest committed epoch; 0 before the first successful resolution. */
  epoch(): number {
    return this.currentEpoch;
  }

  /** Member the name last resolved to, or null before any successful resolve. */
  lastMemberId(): string | null {
    return this.currentMemberId;
  }

  /** Read the live membership and resolve the name, advancing epoch on change. */
  async resolve(): Promise<PrimaryResolution> {
    const [leaderId, members, term] = await Promise.all([
      this.deps.leader(),
      this.deps.members(),
      this.deps.term ? this.deps.term() : Promise.resolve(undefined),
    ]);
    const base = resolveLogicalPrimary(this.name, { leaderId, members, leaderTerm: term });
    if (!base.resolved) {
      return { ...base, epoch: this.currentEpoch, changed: false };
    }

    const changed = base.memberId !== this.currentMemberId;
    if (changed) {
      this.currentMemberId = base.memberId;
      this.currentEpoch += 1;
    }
    return { ...base, epoch: this.currentEpoch, changed };
  }
}
