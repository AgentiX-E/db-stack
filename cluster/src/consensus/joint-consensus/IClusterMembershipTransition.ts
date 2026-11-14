/**
 * @fileoverview IClusterMembershipTransition — interface for safe membership changes via joint consensus
 *
 * Implements the two-phase joint consensus membership change described in Raft §6:
 *   C_old → C_old_new (Joint) → C_new
 *
 * Core safety guarantees:
 *   1. At most one active configuration at any time (C_old / C_old_new / C_new)
 *   2. The joint phase requires majorities of both C_old and C_new to commit
 *   3. The C_new phase only requires a majority of C_new
 *   4. Switching directly from C_old to C_new is rejected (prevents split brain)
 *
 * Relationship with RaftGroup.proposeMembershipChange:
 *   - RaftGroup writes the underlying log entry (propose)
 *   - IClusterMembershipTransition owns orchestration (retries, rollback, timeouts, events)
 *   - This interface is aggregated at the RaftGroupManager level for cross-shard coordination
 */

import type { MembershipChange, RaftConsensusPhase } from '../../interfaces/types';

/** Peer configuration */
export interface PeerConfig {
  /** Unique node identifier */
  id: string;
  /** Node address */
  host: string;
  /** Node port */
  port: number;
  /** Role: voter (voting member) or learner (non-voting member) */
  role: 'voter' | 'learner';
  /** Election priority (voters only) */
  priority?: number;
  /** Region the node lives in (used for topology awareness) */
  region?: string;
  /** Availability zone the node lives in */
  zone?: string;
}

/** Current transition phase */
export type TransitionPhase = 'stable' | 'joint' | 'new';

/** Result of a membership change */
export interface TransitionResult {
  /** Whether the change succeeded */
  success: boolean;
  /** Error message (on failure) */
  error?: string;
  /** Previous configuration */
  oldConfig: PeerConfig[];
  /** New configuration */
  newConfig: PeerConfig[];
  /** Joint-phase configuration (C_old ∪ C_new) */
  jointConfig: PeerConfig[];
  /** Phase that finally committed */
  committedStep: 'old' | 'joint' | 'new' | 'none';
  /** Elapsed time (ms) */
  duration: number;
  /** Active phase after the change */
  phase: Exclude<TransitionPhase, 'stable' | 'new'> | 'stable';
}

/** Membership change event */
export interface MembershipChangeEvent {
  type: 'transition_started' | 'joint_committed' | 'new_committed' | 'transition_aborted' | 'transition_failed';
  changeId: string;
  oldConfig: PeerConfig[];
  newConfig: PeerConfig[];
  phase: TransitionPhase;
  timestamp: number;
  error?: string;
}

/** Progress report for an in-flight change */
export interface TransitionProgress {
  changeId: string;
  phase: TransitionPhase;
  /** Number of acknowledgements received for the joint phase */
  jointAcks: { oldMajority: number; oldAcks: number; newMajority: number; newAcks: number };
  /** Whether the transition already timed out */
  isTimedOut: boolean;
  /** Elapsed time (ms) */
  elapsed: number;
  /** Configured timeout (ms) */
  timeoutMs: number;
}

/** Transition options */
export interface TransitionOptions {
  /** Timeout (ms); defaults to 30_000 */
  timeoutMs?: number;
  /** Retry budget; defaults to 10 */
  maxRetries?: number;
  /** Base retry delay (ms); defaults to 200 */
  retryBaseMs?: number;
  /** Whether to trigger an election after a node joins */
  autoCampaign?: boolean;
  /** Change identifier */
  changeId?: string;
}

/**
 * IClusterMembershipTransition — safe membership changes through joint consensus
 *
 * Responsibility boundaries:
 *   - Orchestrates membership changes only (does not replicate the Raft log itself)
 *   - Does not migrate shards (that is IOnlineShardMigration)
 *   - Does not own cluster topology (that is IClusterTopology)
 *
 * Safety:
 *   The two-phase Raft joint consensus protocol guarantees:
 *     - a direct C_old → C_new jump is rejected
 *     - the joint phase uses a double majority
 *     - a timeout rolls the change back
 */
export interface IClusterMembershipTransition {
  /**
   * Safely move the cluster from its current configuration to a new one.
   *
   * Procedure:
   *   1. Validate the change (a single-node cluster cannot evict its last node)
   *   2. Create C_old_new (old ∪ new)
   *   3. Commit the C_old_new entry behind a joint majority
   *   4. Commit the C_new entry (only a C_new majority is required)
   *   5. Clean up the transitional state
   *
   * Thread safety: only one transition may be in flight at a time.
   */
  transitionTo(peers: PeerConfig[], options?: TransitionOptions): Promise<TransitionResult>;

  /**
   * Current transition phase.
   */
  getTransitionPhase(): TransitionPhase;

  /**
   * Current joint consensus configuration, if a transition is in flight.
   */
  getActiveTransition(): {
    changeId: string;
    oldConfig: PeerConfig[];
    newConfig: PeerConfig[];
    phase: TransitionPhase;
  } | null;

  /**
   * Progress of the in-flight transition.
   */
  getProgress(): TransitionProgress | null;

  /**
   * Abort the in-flight transition.
   * Only safe while C_old_new has not committed.
   * Once C_new has committed the transition can no longer be aborted.
   */
  abortTransition(): Promise<TransitionResult>;

  /**
   * Register a listener for transition events.
   */
  onTransitionEvent(handler: (event: MembershipChangeEvent) => void): () => void;
}
