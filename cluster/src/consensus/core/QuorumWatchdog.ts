/**
 * Who has answered this node lately, and what that is worth.
 *
 * raft-core 0.2.1 implements no check-quorum. A leader that has lost contact with
 * its majority keeps `isLeader() === true` forever: measured with two of three nodes
 * killed, still true at 16 s, the commit index frozen at 1, and the next write
 * refused only after 5 028 ms. Nothing unsafe happens — a majority is still required
 * to commit — but a client that routes by `isLeader()` keeps sending work to a node
 * that cannot serve it and discovers that one request timeout later, which reads as
 * a slow cluster rather than as a lost quorum.
 *
 * So the evidence for "I still have a majority" is a completed round trip, and this
 * class is a record of those moments. `hasQuorum` is arithmetic over the record.
 * There is no timer and no background loop: the answer is computed when it is asked
 * for, so there is nothing to leak, nothing to restart, and no clock drift between a
 * watchdog and the clock that reads it.
 *
 * The member set is a constructor argument and can be replaced afterwards with
 * {@link setMembers}, because a cluster can change while a leader is serving. The
 * direction matters: counting **fewer** members than the configuration holds makes
 * the majority smaller than reality, so the node claims a quorum it does not have —
 * the hazard this class exists to prevent. Counting **more** is merely conservative.
 * A caller that changes membership therefore has to call `setMembers` with the
 * configuration raft actually committed, not with what it hoped to commit.
 */

export interface QuorumWatchdogOptions {
  /** This node's id. It always counts itself, so it is never in `peers`. */
  selfId: number;
  /** The other voting members. */
  peers: readonly number[];
  /** How long a peer's answer keeps counting as contact. */
  windowMs: number;
  /** Injected clock, for tests and for callers with their own time source. */
  now?: () => number;
}

export class QuorumWatchdog {
  private readonly selfId: number;
  private readonly members: Set<number>;
  private readonly lastHeard = new Map<number, number>();
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(options: QuorumWatchdogOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      // A zero window would demote a healthy leader on every call, and a NaN window
      // would never expire. Both are configuration errors, not states to reason about.
      throw new RangeError(`QuorumWatchdog: windowMs must be a positive finite number, got ${options.windowMs}`);
    }
    this.selfId = options.selfId;
    this.windowMs = options.windowMs;
    this.clock = options.now ?? Date.now;
    this.members = new Set(options.peers.filter((peer) => peer !== options.selfId));
  }

  /** Members in the cluster, this node included. */
  get size(): number {
    return this.members.size + 1;
  }

  /** How many members make a majority. */
  get majority(): number {
    return Math.floor(this.size / 2) + 1;
  }

  /** How long an answer keeps counting. */
  get window(): number {
    return this.windowMs;
  }

  /** Record that a member answered at `at` (default: now). Non-members are ignored. */
  observe(peerId: number, at: number = this.clock()): void {
    if (!this.members.has(peerId)) return;
    this.lastHeard.set(peerId, at);
  }

  /** Whether enough members answered recently to form a majority. */
  hasQuorum(at: number = this.clock()): boolean {
    let heard = 1; // this node is a member too
    const majority = this.majority;
    if (heard >= majority) return true;
    // `observe` is the only writer and it drops non-members, so every entry here is a
    // member: re-checking that would be a branch no input can reach.
    for (const when of this.lastHeard.values()) {
      if (at - when >= this.windowMs) continue;
      heard++;
      if (heard >= majority) return true;
    }
    return false;
  }

  /** The members that are silent: never heard from, or heard from too long ago. */
  unheardPeers(at: number = this.clock()): number[] {
    const silent: number[] = [];
    for (const peer of this.members) {
      const when = this.lastHeard.get(peer);
      if (when === undefined || at - when >= this.windowMs) silent.push(peer);
    }
    return silent.sort((a, b) => a - b);
  }

  /** Forget every observation, so a restarted node inherits no stale evidence. */
  reset(): void {
    this.lastHeard.clear();
  }

  /**
   * Replace the member set, keeping the observations of members that stayed.
   *
   * Called after a configuration change commits, and after a restart reads its
   * persisted configuration. Observations of members that left are dropped: they
   * would otherwise keep counting toward a majority those nodes are no longer part
   * of — an answer from a removed peer is not evidence about the current cluster.
   */
  setMembers(peers: readonly number[]): void {
    this.members.clear();
    for (const peer of peers) {
      if (peer !== this.selfId) this.members.add(peer);
    }
    for (const peer of [...this.lastHeard.keys()]) {
      if (!this.members.has(peer)) this.lastHeard.delete(peer);
    }
  }

  /** This node's id, for messages that name the observer. */
  get id(): number {
    return this.selfId;
  }
}
