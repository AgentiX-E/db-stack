/**
 * LeaseReadManager — Leader Lease Optimization for Linearizable Reads
 *
 * If the leader has received heartbeat responses from a quorum within a
 * configurable lease period (`leaseMs`), it can serve linearizable reads
 * without the extra quorum round-trip required by the full ReadIndex protocol.
 *
 * This implements the "Leader Lease" optimization described in the Raft
 * extended paper (Section 6.4.1) and used by etcd and other production systems.
 *
 * Safety: The lease is only valid if the clock skew between nodes is bounded
 * and the leader can guarantee no other node will become leader during the
 * lease period.
 *
 * Usage:
 *   const leaseMgr = new LeaseReadManager(500);
 *   // On receiving quorum heartbeat ack:
 *   leaseMgr.onQuorumHeartbeatAck();
 *   // Before serving a read:
 *   if (leaseMgr.isLeaseValid()) {
 *     return localRead(); // safe linearizable read
 *   }
 *   // Otherwise fall back to ReadIndex protocol
 */

/** Default leader lease duration in milliseconds */
const DEFAULT_LEASE_MS = 500;

export class LeaseReadManager {
  /** Timestamp (ms since epoch) of the last quorum heartbeat acknowledgment */
  private lastQuorumTime: number = 0;

  /** Lease duration in milliseconds */
  private leaseMs: number;

  /**
   * @param leaseMs - Leader lease duration in ms. Default 500.
   *                  If 0 is passed, lease is disabled (always expired).
   */
  constructor(leaseMs?: number) {
    this.leaseMs = leaseMs ?? DEFAULT_LEASE_MS;
  }

  /**
   * Called when the leader receives heartbeat responses from a quorum.
   * Updates the last quorum time, extending the lease.
   *
   * @param now - Current time in ms (defaults to Date.now())
   */
  onQuorumHeartbeatAck(now?: number): void {
    this.lastQuorumTime = now ?? Date.now();
  }

  /**
   * Returns true if the leader lease is still valid.
   *
   * When valid, the leader can serve linearizable reads directly from its
   * state machine without a quorum round-trip.
   *
   * @returns true if within lease (safe for linearizable read)
   */
  isLeaseValid(): boolean {
    if (this.leaseMs <= 0) return false;
    return (Date.now() - this.lastQuorumTime) < this.leaseMs;
  }

  /**
   * Returns remaining lease time in milliseconds.
   *
   * @returns ms remaining in lease (0 if expired or disabled)
   */
  getLeaseRemaining(): number {
    if (this.leaseMs <= 0) return 0;
    const elapsed = Date.now() - this.lastQuorumTime;
    const remaining = this.leaseMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Returns the configured lease duration in milliseconds.
   */
  get leaseDuration(): number {
    return this.leaseMs;
  }

  /**
   * Resets the lease (marks as expired). Used when leadership is lost.
   */
  reset(): void {
    this.lastQuorumTime = 0;
  }
}
