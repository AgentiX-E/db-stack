/**
 * RaftGroup — Single shard's Raft consensus group
 *
 * Wraps RaftAdapter + ShardReplica into a cohesive consensus unit.
 * The RaftAdapter's apply callback applies committed entries to the
 * local state machine automatically. After propose() resolves (entry
 * committed + applied), we append to Outbox for async fan-out.
 *
 * Extensions:
 *   C2: Joint Consensus — TRANSITIONAL/NORMAL phase transitions
 *   C3: Learner (Read Replica) — non-voting followers
 *   C4: Leader Transfer — graceful leadership handoff
 */

import { RaftAdapter, RaftConfig, ShardSnapshotMeta } from './RaftAdapter';
import { IShardReplica, ApplyEntry } from '../../interfaces/IShardReplica';
import { IOutboxWriter, OutboxRecord } from '../../interfaces/IOutboxWriter';
import { SqliteStorage } from '../storage/SqliteStorage';
import { mintFencingToken, type FencingToken } from '../fencing/FencingToken';
import { getErrorMessage } from '../helpers/errorUtils';
import {
  RaftConsensusPhase,
  MembershipChange,
  TransitionalConfig,
  LearnerInfo,
  LeaderTransferResult,
  FlexibleQuorumConfig,
  resolveFlexibleQuorumConfig,
  type majorityQuorum,
  SharedTransport,
} from '../../interfaces/types';
import * as fs from 'fs';
import * as crypto from 'crypto';

import pino from 'pino';
import { IPITRHook } from '../../interfaces/IPITRHook';
import { resolveLogLevel } from '../../observability/logLevel';

const logger = pino({ level: resolveLogLevel() });

// ──────────────────────────────────────────
//  Types
// ──────────────────────────────────────────

export interface RaftGroupQuorumResult {
  quorumMet: boolean;
  required: number;
  actual: number;
  total: number;
  type: 'write' | 'read' | 'commit';
}

// ──────────────────────────────────────────
//  RaftGroup

export class RaftGroup {
  readonly shardId: number;
  readonly flexQuorum: FlexibleQuorumConfig;

  private raft: RaftAdapter;
  private replica: IShardReplica;
  private outboxManager: IOutboxWriter;
  private snapshotDir: string;
  private maxLogEntries: number;
  private nodeId: number;

  // ── C2: Joint Consensus ──────────────────────────────────
  /** Current joint consensus transitional config. null when not in a transition. */
  private _transitionalConfig: TransitionalConfig | null = null;

  // ── C3: Learner / Read Replica ──────────────────────────
  private learners: Map<string, LearnerInfo> = new Map();

  // ── C4: Leader Transfer ─────────────────────────────────
  private leaderTransferInProgress: boolean = false;

  // ── Stop guard ──────────────────────────────────────────
  /** Set to true when stop() is called. Guards against propose() after stop. */
  private _stopped = false;

  // ── PITR ────────────────────────────────────────────────
  /** Optional PITR hook for WAL capture during apply. */
  readonly pitrHook?: IPITRHook;
  /** Optional PITR flush callback invoked before Raft snapshot. */
  private pitrFlushHook?: () => Promise<void>;

  // ── HA: Auto Failover (GAP 1) ───────────────────────────
  /** Timestamp of last leader activity (epoch ms). Updated by leader monitor. */
  private _leaderHeartbeatTs: number = Date.now();
  /** Leader monitor interval handle. null when not running. */
  private _leaderMonitorTimer: ReturnType<typeof setInterval> | null = null;

  // ── Phase C: Fencing (STONITH protection) ───────────────
  /** Optional FencingManager for write-fencing integration. */
  private _fencingManager: import('../fencing/FencingManager').FencingManager | null = null;

  // ── HA: Split-Brain Prevention (GAP 2) ──────────────────
  /** Whether this group is in read-only mode (minority partition). */
  private _readOnly: boolean = false;
  /** Timestamp of last fencing check. */
  private _lastFencingCheck: number = 0;
  /** Last term forwarded to FencingManager for heartbeat dedup/ordering. */
  private _lastFencingTerm: number = 0;
  /** Minimum interval between fencing checks (ms). */
  private _fencingInterval: number = 10_000;
  /** Set of peer node IDs that we have recently received Raft messages from. */
  private _activePeers: Set<string> = new Set();
  /** Timestamps tracking when each peer was last active (for C-02 cleanup). */
  private _activePeerTimestamps: Map<string, number> = new Map();
  /** Timer for periodic active peer cleanup. */
  private _activePeerCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Current fencing state. */
  private _fencingState: 'normal' | 'fencing' | 'minority' = 'normal';
  /**
   * The token the last successful fence minted, or null when this node has no
   * right to write. It is handed to the engine, which presents it to the resource;
   * the resource refuses anything below what it has already accepted, which is the
   * only place a partitioned leader is actually stopped.
   */
  private _fencingToken: FencingToken | null = null;
  /** Optional health check callback invoked on severe failures. */
  private _onHealthCheck: ((message: string) => void) | null = null;

  constructor(
    shardId: number,
    raftConfig: RaftConfig,
    replica: IShardReplica,
    outboxManager: IOutboxWriter,
    snapshotDir?: string,
    flexQuorumConfig?: Partial<FlexibleQuorumConfig>,
    pitrHook?: IPITRHook,
    pitrFlushHook?: () => Promise<void>,
  ) {
    this.shardId = shardId;
    this.raft = new RaftAdapter(raftConfig);
    this.replica = replica;
    this.outboxManager = outboxManager;
    this.nodeId = raftConfig.id;
    this.maxLogEntries = raftConfig.maxLogEntries || 0;
    // The authoritative snapshot lives in the Raft storage engine, next to the
    // log it justifies. This directory is kept because deployments mount it and
    // engine adapters may export backups there; this package no longer writes a
    // second, competing snapshot file into it.
    this.snapshotDir = snapshotDir || './data';
    this.flexQuorum = resolveFlexibleQuorumConfig(flexQuorumConfig, raftConfig.peers.length);
    this.pitrHook = pitrHook;
    this.pitrFlushHook = pitrFlushHook;
  }

  /**
   * Set a custom storage backend (e.g. SqliteStorage) on the underlying
   * RaftAdapter. This replaces the default InMemoryStorage for persistent
   * raft log storage. Must be called before init().
   */
  setStorage(storage: SqliteStorage): void {
    // Delegates to RaftAdapter's storage injection if supported
    (this.raft as any)._customStorage = storage;
  }

  /**
   * Factory method: create a RaftGroup backed by SqliteStorage for
   * persistent raft log storage.
   */
  static async createWithSqliteStorage(
    shardId: number,
    raftConfig: RaftConfig,
    replica: IShardReplica,
    outboxManager: IOutboxWriter,
    sqliteStorageConfig: { file: string },
    snapshotDir?: string,
    flexQuorumConfig?: Partial<FlexibleQuorumConfig>,
    pitrHook?: IPITRHook,
    pitrFlushHook?: () => Promise<void>,
  ): Promise<RaftGroup> {
    const group = new RaftGroup(
      shardId,
      raftConfig,
      replica,
      outboxManager,
      snapshotDir,
      flexQuorumConfig,
      pitrHook,
      pitrFlushHook,
    );

    const sqliteStorage = new SqliteStorage({ file: sqliteStorageConfig.file });
    sqliteStorage.open();
    group.setStorage(sqliteStorage);

    return group;
  }

  /**
   * Initialize the Raft group.
   * @param sharedTransport - Optional shared NodeTransport for node-level transport sharing.
   *                          When provided, all RaftGroups on this node share one TCP transport,
   *                          and inbound messages are routed by shardId.
   */
  async init(sharedTransport?: SharedTransport): Promise<void> {
    // Ensure snapshot directory exists
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true });
    }

    // The apply callback is set during init so every committed entry
    // is automatically applied to the state machine.
    const applyHandler = async (data: string, raftIndex?: number, raftTerm?: number): Promise<void> => {
      let entry: ApplyEntry;
      try {
        entry = JSON.parse(data);
      } catch {
        logger.error(`[RaftGroup] Cannot parse committed entry data`);
        return;
      }

      // Capture the entry in PITR WAL before applying to state machine
      // This ensures no committed entry is lost in case of a crash
      const idx = raftIndex ?? 0;
      const term = raftTerm ?? 0;
      this.pitrHook?.onApply(String(this.shardId), idx, term, data);

      // Awaited on purpose: an apply that fails must reach raft-core, which then
      // stops advancing lastApplied and replays the entry, instead of the group
      // reporting a committed write it never persisted.
      await this.replica.apply(entry);
    };

    // The engine's state, not just the log, is what a restart has to recover. These
    // hooks are registered before init because raft-core loads the persisted
    // snapshot during start(). Without them a node restarts with an empty engine
    // while its log claims everything up to the snapshot index is applied.
    //
    // The PITR WAL is flushed *here*, inside the capture, because this callback is
    // the last moment before raft-core truncates the log the WAL duplicates: the
    // flush has to happen in the same step that freezes the engine's state, not in
    // a scheduler that might run later — or never, if raft-core snapshots on its
    // own threshold.
    this.raft.setApplicationSnapshotHandlers({
      takeSnapshot: async (boundaryIndex: number) => {
        await this.pitrFlushHook?.();
        return this.replica.snapshot(boundaryIndex);
      },
      installSnapshot: (data: Buffer) => this.replica.restore(data),
    });

    // If shared transport is provided, create a per-shard wrapper that tags
    // outgoing messages with this.shardId for routing at the receiver.
    // Inbound routing is handled centrally by RaftGroupManager via
    // NodeTransport.onMessage → handleRaftMessage — no per-group handler needed.
    if (sharedTransport) {
      // Pass the ORIGINAL NodeTransport (NOT forShard wrapper) to RaftAdapter.
      // SharedBatchedTransport will handle per-shard message tagging internally
      // via its own doSend() and onMessage() registration.
      await this.raft.init(applyHandler, undefined, {
        transport: sharedTransport,
        shardId: this.shardId,
      });
    } else {
      await this.raft.init(applyHandler);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  C2: Joint Consensus — True Two-Phase Membership Change
  // ════════════════════════════════════════════════════════════
  //
  //  Implements Section 4.1 of the Raft thesis (Ongaro 2014):
  //
  //    Phase 1 (C_JOINT):  Leader appends C_OLD_NEW entry. This config
  //    requires majority in BOTH oldPeers AND newPeers for commit.
  //    During C_JOINT:
  //      - Log entries are replicated to ALL members of old∪new.
  //      - Leaders are elected by majority in both old AND new.
  //
  //    Phase 2 (C_NEW):    Once the C_JOINT entry is committed in
  //    both configs, the leader appends a C_NEW entry. This config
  //    requires only majority of newPeers. After C_NEW commits,
  //    the transition is complete.
  //
  //    Rollback: If C_JOINT cannot commit (e.g. quorum lost in one
  //    config), the leader MUST NOT proceed to C_NEW. Instead it
  //    should retry or abort the membership change.
  //
  // ════════════════════════════════════════════════════════════

  /**
   * Get current transitional config (null when not in a transition).
   */
  getTransitionalConfig(): TransitionalConfig | null {
    return this._transitionalConfig;
  }

  /**
   * Check if a joint consensus transition is in progress.
   */
  isJointConsensusActive(): boolean {
    return this._transitionalConfig !== null && this._transitionalConfig.newEntryIndex === 0;
  }

  /**
   * Get the effective consensus phase for quorum calculations.
   */
  getEffectivePhase(): RaftConsensusPhase {
    if (!this._transitionalConfig) return RaftConsensusPhase.NORMAL;
    if (this._transitionalConfig.newEntryIndex === 0) return RaftConsensusPhase.C_JOINT;
    return RaftConsensusPhase.C_NEW;
  }

  /**
   * Get the current joint consensus phase.
   * Delegates to getEffectivePhase() for the latest state.
   */
  getConsensusPhase(): RaftConsensusPhase {
    return this.getEffectivePhase();
  }

  /**
   * Get current membership config (for inspection).
   */
  getCurrentMembership(): { oldPeers: number[]; newPeers: number[] } | null {
    if (!this._transitionalConfig) return null;
    return {
      oldPeers: this._transitionalConfig!.oldPeers!,
      newPeers: this._transitionalConfig!.newPeers!,
    };
  }

  /**
   * Calculate joint quorum requirement for C_JOINT phase.
   * Returns the number of acknowledgments needed from the union of
   * old∪new peers. A C_JOINT commit requires BOTH majorities.
   */
  getJointQuorumRequired(): { oldMajority: number; newMajority: number; total: number } {
    if (!this._transitionalConfig) {
      return { oldMajority: 0, newMajority: 0, total: 0 };
    }
    const { oldPeers, newPeers } = this._transitionalConfig;
    const oldMajority = Math.floor(oldPeers!.length / 2) + 1;
    const newMajority = Math.floor(newPeers!.length / 2) + 1;
    const total = new Set([...oldPeers!, ...newPeers!]).size;
    return { oldMajority, newMajority, total };
  }

  /**
   * Check whether a set of acknowledged peer IDs satisfies the
   * C_JOINT quorum requirement (majority in BOTH old AND new configs).
   */
  isJointQuorumSatisfied(acknowledgedPeerIds: Set<number>): boolean {
    const { oldMajority, newMajority } = this.getJointQuorumRequired();
    const oldAcks = this._transitionalConfig!.oldPeers!.filter((p) => acknowledgedPeerIds.has(p)).length;
    const newAcks = this._transitionalConfig!.newPeers!.filter((p) => acknowledgedPeerIds.has(p)).length;
    return oldAcks >= oldMajority && newAcks >= newMajority;
  }

  /**
   * Propose a membership change to the Raft group using true two-phase
   * joint consensus (C_JOINT → C_NEW).
   */
  async proposeMembershipChange(change: MembershipChange): Promise<{
    success: boolean;
    phase: RaftConsensusPhase;
    error?: string;
  }> {
    // Reject if a transition is already in progress
    if (this._transitionalConfig !== null) {
      return {
        success: false,
        phase: this.getEffectivePhase(),
        error: 'A joint consensus transition is already in progress',
      };
    }

    if (!(await this.raft.isLeader())) {
      return {
        success: false,
        phase: RaftConsensusPhase.NORMAL,
        error: 'Only the leader can propose membership changes',
      };
    }

    const oldPeers = change.oldPeers!.map(Number);
    const newPeers = change.newPeers!.map(Number);

    // ── Phase 1: Propose C_JOINT entry ──
    // This entry must be committed with majority in BOTH old AND new configs.
    const jointEntry: Partial<ApplyEntry> = {
      msgId: `membership-joint-${change.changeId}`,
      type: 'exec',
      data: JSON.stringify({
        __membership_change: true,
        changeId: change.changeId,
        type: change.type,
        nodeId: change.nodeId,
        oldPeers: change.oldPeers,
        newPeers: change.newPeers,
        phase: 'C_JOINT',
      }),
    } as any;

    // Enter C_JOINT phase and store transitional config
    this._transitionalConfig = {
      oldPeers,
      newPeers,
      jointEntryIndex: 0,
      newEntryIndex: 0,
      startedAt: Date.now(),
      timeoutMs: 30_000,
      oldMembers: oldPeers.map(String),
      newMembers: newPeers.map(String),
      phase: RaftConsensusPhase.C_JOINT,
    };

    try {
      // Propose the C_JOINT entry
      const result = await this.raft.propose(JSON.stringify(jointEntry));
      const jointIndex = Number(result.index);

      // Update config with the joint index
      this._transitionalConfig!.jointEntryIndex = jointIndex;

      // In a single-node cluster, immediate transition
      const totalNodes = new Set([...oldPeers, ...newPeers]).size;
      if (totalNodes <= 1) {
        await this._transitionToCNew(change, jointIndex);
      } else {
        // For multi-node clusters, wait for the C_JOINT entry to be committed
        // in BOTH configs (joint quorum). Use exponential backoff retry
        // with a maximum timeout. If the timeout is exceeded, rollback.
        const timeoutMs = this._transitionalConfig!.timeoutMs ?? 30_000;
        const maxRetries = 10;
        let committed = false;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // Check if the C_JOINT entry commit index has been reached
          const progress = (await this.raft.getProgress())!;
          if (progress.commit! >= jointIndex) {
            // Joint quorum satisfied — leader's commit in both configs
            // indicates majority in both C_old and C_new
            committed = true;
            break;
          }

          // Check for timeout
          if (Date.now() - this._transitionalConfig!.startedAt! > timeoutMs) {
            logger.warn(
              `[RaftGroup] C_JOINT timeout after ${Date.now() - this._transitionalConfig!.startedAt!}ms. ` +
                `Rolling back membership change (commit=${progress?.commit ?? '?'}, jointIdx=${jointIndex}).`,
            );
            break;
          }

          // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, ...
          const delay = Math.min(200 * Math.pow(2, attempt), 5000);
          logger.debug(
            `[RaftGroup] C_JOINT not yet committed in both configs (attempt ${attempt + 1}/${maxRetries}). ` +
              `Retrying in ${delay}ms.`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        if (committed) {
          await this._transitionToCNew(change, jointIndex);
        } else {
          // Rollback the membership change — C_JOINT could not be committed
          this._transitionalConfig = null;
          return {
            success: false,
            phase: RaftConsensusPhase.NORMAL,
            error: `C_JOINT entry could not be committed in both configs within timeout. Rolled back.`,
          };
        }
      }

      return { success: true, phase: RaftConsensusPhase.NORMAL };
    } catch (err: unknown) {
      // Rollback on failure
      this._transitionalConfig = null;
      return {
        success: false,
        phase: RaftConsensusPhase.NORMAL,
        error: `Membership change failed: ${getErrorMessage(err)}`,
      };
    }
  }

  /**
   * Transition from C_JOINT to C_NEW phase.
   * Appends a C_NEW config entry that needs only newPeers majority.
   */
  private async _transitionToCNew(change: MembershipChange, jointIndex: number): Promise<void> {
    if (!this._transitionalConfig) return;

    // Propose the C_NEW config entry
    const newEntry: Partial<ApplyEntry> = {
      msgId: `membership-new-${change.changeId}`,
      type: 'exec',
      data: JSON.stringify({
        __membership_change: true,
        changeId: change.changeId,
        type: change.type,
        nodeId: change.nodeId,
        oldPeers: change.newPeers, // C_NEW: only new config
        newPeers: change.newPeers,
        phase: 'C_NEW',
      }),
    } as any;

    try {
      const result = await this.raft.propose(JSON.stringify(newEntry));
      const newIndex = Number(result.index);

      if (!this._transitionalConfig) return; // Safety check
      this._transitionalConfig.newEntryIndex = newIndex;

      // Finalize: clear transitional config
      this._transitionalConfig = null;
    } catch (err: unknown) {
      logger.error(
        `[RaftGroup] C_NEW transition failed: ${getErrorMessage(err)}. ` +
          `C_JOINT entry at index ${jointIndex} already committed. Manual recovery may be needed.`,
      );
      // Even if C_NEW fails, we keep transitional config so that
      // the system can retry the transition later.
    }
  }

  /**
   * Rollback a joint consensus transition.
   * Only available during C_JOINT phase (before C_NEW entry committed).
   */
  async rollbackMembershipChange(): Promise<boolean> {
    if (!this._transitionalConfig || this._transitionalConfig.newEntryIndex !== 0) {
      return false;
    }

    // If C_JOINT entry hasn't been committed, we can safely abort
    this._transitionalConfig = null;
    return true;
  }

  // ════════════════════════════════════════════════════════════
  //  C3: Learner (Read Replica)
  // ════════════════════════════════════════════════════════════

  /**
   * Get all current learners.
   */
  getLearners(): Map<string, LearnerInfo> {
    return new Map(this.learners);
  }

  /**
   * Get the count of registered learners.
   */
  getLearnerCount(): number {
    return this.learners.size;
  }

  /**
   * Add a learner (read replica) node to this Raft group.
   *
   * Learners do NOT vote and do NOT participate in elections.
   * They receive the latest snapshot and then stream log entries
   * to maintain eventual consistency.
   */
  async addLearner(nodeId: string): Promise<boolean> {
    if (this.learners.has(nodeId)) {
      return false; // Already a learner
    }

    const now = Date.now();

    // Start streaming from the current commit index. Before the first apply
    // there is no progress yet, in which case the log origin is the right
    // starting point.
    let nextIndex = 0;
    try {
      const progress = await this.raft.getProgress();
      nextIndex = progress.commit || 0;
    } catch {
      // Progress is unavailable on a freshly started node; keep the origin.
    }

    const info: LearnerInfo = {
      nodeId,
      shardId: this.shardId,
      nextIndex: Math.max(1, nextIndex),
      matchIndex: 0,
      addedAt: now,
      lastHeartbeat: now,
    } as any;

    this.learners.set(nodeId, info);

    // Send snapshot to learner (if available)
    if (this.snapshotExists()) {
      const meta = this.readSnapshotMeta();
      if (meta) {
        info.nextIndex = meta.lastIncludedIndex + 1;
      }
    }

    logger.info(`[RaftGroup] Learner ${nodeId} added to shard ${this.shardId} at index ${info.nextIndex}`);

    return true;
  }

  /**
   * Remove a learner node from this Raft group.
   */
  removeLearner(nodeId: string): boolean {
    const existed = this.learners.delete(nodeId);
    if (existed) {
      logger.info(`[RaftGroup] Learner ${nodeId} removed from shard ${this.shardId}`);
    }
    return existed;
  }

  /**
   * Serve a learner with the log entries it is missing.
   *
   * Log shipping is raft-core's job: a learner catches up through the leader's own
   * replication, and through a snapshot when its gap is older than the retained
   * log. What this endpoint adds is a pull a caller can drive itself — a read
   * replica, a migration tool, an operator asking what a node actually holds — so
   * it answers from the log this group really has.
   *
   * The window matters as much as the entries: `firstAvailableIndex` is the floor
   * compaction has left behind, so a caller whose cursor is below it knows to take
   * the snapshot instead of asking forever for entries that no longer exist.
   *
   * The previous implementation read from a buffer nothing wrote to, so it
   * returned an empty array for every shard at every index, while its own
   * documentation promised "the log entries from `fromIndex` onward".
   */
  async requestForLearner(
    fromIndex: number,
    limit?: number,
  ): Promise<{
    entries: ApplyEntry[];
    snapshotAvailable: boolean;
    firstAvailableIndex: number;
    lastIndex: number;
    lastTerm: number;
  }> {
    const bounds = await this.raft.getLogBounds();
    const entries = await this.raft.getLogEntries(fromIndex, limit);

    return {
      entries,
      snapshotAvailable: this.snapshotExists(),
      firstAvailableIndex: bounds?.firstIndex ?? 0,
      lastIndex: bounds?.lastIndex ?? 0,
      lastTerm: bounds?.lastTerm ?? 0,
    };
  }

  /**
   * Update learner's progress (called after replicating to learner).
   */
  updateLearnerProgress(nodeId: string, matchedIndex: number): void {
    const learner = this.learners.get(nodeId);
    if (learner) {
      learner.matchIndex = matchedIndex;
      learner.nextIndex = matchedIndex + 1;
      learner.lastHeartbeat = Date.now();
    }
  }

  // ════════════════════════════════════════════════════════════
  //  C4: Leader Transfer
  // ════════════════════════════════════════════════════════════

  /**
   * Check if a leader transfer is in progress.
   */
  isLeaderTransferInProgress(): boolean {
    return this.leaderTransferInProgress;
  }

  /**
   * Transfer leadership to a target node.
   *
   * Delegates to RaftAdapter.transferLeadership which handles the
   * @maboke123/raft-core interaction (stop heartbeat → wait for election).
   */
  async transferLeadership(targetNodeId: string): Promise<LeaderTransferResult> {
    if (this.leaderTransferInProgress) {
      return {
        success: false,
        newLeader: undefined,
        durationMs: 0,
        error: 'A leader transfer is already in progress',
      };
    }

    if (!(await this.raft.isLeader())) {
      return {
        success: false,
        newLeader: undefined,
        durationMs: 0,
        error: 'Only the leader can transfer leadership',
      };
    }

    const startTime = Date.now();
    this.leaderTransferInProgress = true;

    try {
      // Delegate to the RaftAdapter which handles the @maboke123/raft-core interaction
      await this.raft.transferLeadership(targetNodeId);

      const durationMs = Date.now() - startTime;

      // Verify the new leader
      let newLeader: number | null = null;
      for (let i = 0; i < 30; i++) {
        newLeader = await this.raft.getLeader();
        if (newLeader !== null && newLeader !== this.nodeId) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      this.leaderTransferInProgress = false;

      if (newLeader && newLeader !== this.nodeId) {
        return {
          success: true,
          newLeader: String(newLeader),
          durationMs,
        };
      } else {
        return {
          success: true,
          newLeader: String(this.nodeId),
          durationMs,
          error: 'Leadership transfer may not have taken effect',
        };
      }
    } catch (err: unknown) {
      this.leaderTransferInProgress = false;
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        newLeader: undefined,
        durationMs,
        error: `Leadership transfer failed: ${getErrorMessage(err)}`,
      };
    }
  }

  /**
   * Transfer leadership to a target node using a manual approach
   * (campaign-based fallback when direct transferLeadership is unavailable).
   *
   * Submits a NOOP entry, then tries RaftAdapter.transferLeadership which
   * stops the heartbeat. If that fails, waits for leadership change.
   */
  async transferLeadershipViaCampaign(targetNodeId: string): Promise<LeaderTransferResult> {
    const startTime = Date.now();

    try {
      // Step 1: Append a no-op entry to ensure all prior entries are committed
      const noopEntry: Partial<ApplyEntry> & Record<string, any> = {
        msgId: `noop-transfer-${Date.now()}`,
        type: 'exec',
        data: JSON.stringify({ __noop: true, reason: 'leader-transfer' }),
      };
      await this.raft.propose(JSON.stringify(noopEntry));

      // Step 2: Use RaftAdapter's transferLeadership (stop heartbeat) to trigger election
      try {
        await this.raft.transferLeadership(targetNodeId);
      } catch {
        // Direct transfer not possible — manual step-down will be handled
        // by the LeaderTransferHandler extension or via heartbeat timeout
      }

      // Step 3: Wait for leadership change
      let newLeader: number | null = null;
      for (let i = 0; i < 30; i++) {
        newLeader = await this.raft.getLeader();
        if (newLeader !== null && newLeader !== this.nodeId) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const durationMs = Date.now() - startTime;

      if (newLeader && newLeader !== this.nodeId) {
        return {
          success: true,
          newLeader: String(newLeader),
          durationMs,
        };
      }

      // Fallback didn't work either
      return {
        success: false,
        newLeader: undefined,
        durationMs,
        error: 'Campaign-based transfer failed: no new leader detected',
      };
    } catch (err: unknown) {
      return {
        success: false,
        newLeader: undefined,
        durationMs: Date.now() - startTime,
        error: `Campaign transfer failed: ${getErrorMessage(err)}`,
      };
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Snapshot lifecycle
  //
  //  There is one snapshot mechanism: raft-core's. It captures the engine's
  //  state (through the hooks registered in `init`), persists it together with
  //  its term and the committed configuration, and truncates the log it covers.
  //  This group schedules nothing on its own — raft-core snapshots on the
  //  configured threshold after an apply — and no longer writes a metadata-only
  //  file that could compact the log ahead of the state it claimed to cover.
  // ════════════════════════════════════════════════════════════

  /**
   * Force a snapshot now.
   *
   * Scheduled snapshots are raft-core's job; this is the explicit path, used when
   * the log has grown past `maxLogEntries` or an operator asks for a durable
   * boundary. It is idempotent: if nothing has been applied since the last
   * snapshot, no snapshot is written and no log is truncated.
   */
  async trySnapshot(): Promise<void> {
    try {
      const meta = await this.raft.requestSnapshot();
      if (meta) {
        logger.info(
          `[RaftGroup] Snapshot at index ${meta.lastIncludedIndex} (term ${meta.lastIncludedTerm}, shard ${this.shardId})`,
        );
      }
    } catch (err: unknown) {
      logger.error(`[RaftGroup] Snapshot failed (shard ${this.shardId}): ${getErrorMessage(err)}`);
    }
  }

  async enforceLogLimit(): Promise<void> {
    if (this.maxLogEntries <= 0) return;

    const progress = (await this.raft.getProgress())!;
    const logSize = progress.lastLog! - progress.applied!;
    if (logSize > this.maxLogEntries) {
      logger.warn(`[RaftGroup] Log size ${logSize} exceeds limit ${this.maxLogEntries}, forcing snapshot`);
      await this.trySnapshot();
    }
  }

  /** Whether raft-core holds a snapshot for this shard. */
  snapshotExists(): boolean {
    return this.raft.getSnapshotMeta() !== null;
  }

  /**
   * Metadata of the snapshot raft-core holds, in this group's public shape.
   *
   * `timestamp` is when this node observed the snapshot, not a wall-clock stamp
   * written at capture time: the snapshot's own index and term are the facts.
   */
  readSnapshotMeta(): ShardSnapshotMeta | null {
    const meta = this.raft.getSnapshotMeta();
    if (!meta) return null;
    return {
      lastIncludedIndex: meta.lastIncludedIndex,
      lastIncludedTerm: meta.lastIncludedTerm,
      nodeId: this.nodeId,
      shardId: this.shardId,
      timestamp: meta.observedAt,
    };
  }

  // ──────────────────────────────────────────
  //  Write path (Raft primary + Outbox fallback)
  // ──────────────────────────────────────────

  /**
   * Build the outbox record for a committed entry.
   *
   * Five call sites used to assemble this literal by hand, and two of them
   * copied `entry.msgId` / `entry.type` straight through although both are
   * optional on `ApplyEntry`. The copies only compiled because the record was
   * passed through `as any`; without the cast the compiler points out that an
   * entry proposed without an id reaches the outbox with `msgId: undefined`,
   * where every such entry collapses onto one de-duplication key downstream.
   * The record is built in one place instead, and an entry that arrives without
   * an id is given one rather than being allowed to alias another.
   *
   * @param source   The entry the record describes (id and type are optional).
   * @param payload  The serialised payload exactly as it was committed.
   * @param index    Raft log index the entry committed at.
   * @param term     Raft term the entry committed in.
   * @param createdAt Commit timestamp; defaults to now.
   */
  private buildOutboxRecord(
    source: { msgId?: string; type?: string },
    payload: string | Buffer,
    index: number,
    term: number,
    createdAt?: number,
  ): OutboxRecord {
    return {
      msgId: source.msgId ?? `auto-${this.shardId}-${index}-${crypto.randomUUID()}`,
      raftIndex: index,
      raftTerm: term,
      shardId: this.shardId,
      targetDC: '*',
      type: source.type ?? 'exec',
      payload,
      createdAt: createdAt ?? Date.now(),
    };
  }

  async propose(entry: ApplyEntry): Promise<void> {
    if (this._stopped) throw new Error('RaftGroup: group already stopped');
    const committed = await this.raft.propose(JSON.stringify(entry));

    this.outboxManager.append(
      this.buildOutboxRecord(entry, JSON.stringify(entry), Number(committed.index), Number(committed.term)),
    );
  }

  /**
   * Propose multiple entries as a single Raft batch entry.
   *
   * Encodes all entries into one Raft log entry ({__batch: true, entries: [...]}),
   * reducing consensus overhead during bulk operations like pgbench init.
   * The apply handler on the receiving side iterates the sub-entries individually.
   *
   * Each sub-entry retains its original msgId for individual dedup safety,
   * but the batch itself is also dedup'd as a whole.
   */
  async proposeBatch(entries: ApplyEntry[]): Promise<void> {
    if (this._stopped) throw new Error('RaftGroup: group already stopped');
    const batchMsgId = crypto.randomUUID();
    const batchEntry: Partial<ApplyEntry> = {
      msgId: batchMsgId,
      type: 'exec',
      data: JSON.stringify({
        __batch: true,
        entries,
      }),
    };
    const committed = await this.raft.propose(JSON.stringify(batchEntry));
    this.outboxManager.append(
      this.buildOutboxRecord(
        { msgId: batchMsgId, type: 'exec' },
        JSON.stringify(batchEntry),
        Number(committed.index),
        Number(committed.term),
      ),
    );
  }

  /**
   * Propose and synchronously wait for Raft commit + local apply.
   * Enterprise-grade path: guarantees durability on return.
   */
  async proposeAndWait(entry: ApplyEntry): Promise<void> {
    if (this._stopped) throw new Error('RaftGroup: group already stopped');
    await this.raft.proposeAndWait(JSON.stringify(entry));

    // The entry is applied by the time this returns, so its position is known:
    // the record used to be appended with `raftIndex: 0`, which left every
    // synchronously proposed entry unpositioned for point-in-time recovery.
    const committed = await this.raft.proposeAndWait(JSON.stringify(entry));
    this.outboxManager.append(
      this.buildOutboxRecord(entry, JSON.stringify(entry), Number(committed.index), Number(committed.term)),
    );
  }

  proposeAsync(entry: ApplyEntry): void {
    this.raft
      .propose(JSON.stringify(entry))
      .then((committed) => {
        this.outboxManager.append(
          this.buildOutboxRecord(entry, JSON.stringify(entry), Number(committed.index), Number(committed.term)),
        );
      })
      .catch((err: unknown) => {
        logger.error(
          `[RaftGroup] Async propose failed (shard ${this.shardId}): ${getErrorMessage(err)} ` +
            `| entry msgId=${entry.msgId}, type=${entry.type}`,
        );
        // M-05: Trigger health check callback on severe failure
        // (e.g., persistent disk full or Raft node crash)
        if (this._onHealthCheck) {
          this._onHealthCheck(`Async propose failed for entry msgId=${entry.msgId}`);
        }
      });
  }

  // ──────────────────────────────────────────
  //  Read path
  // ──────────────────────────────────────────

  async read(sql: string, params?: any[]): Promise<any[]> {
    // readBarrier removed: pgbench transactions write to SQLite directly
    // (through Raft propose), not through the Raft state machine, so barrier
    // would wait for entries that are never applied to the state machine.
    // For the new architecture: all writes go through Raft propose + waitForCommit,
    // and reads are local since the data is applied to local SQLite synchronously.
    return (this.replica as any).query(sql, params);
  }

  // ──────────────────────────────────────────
  //  EventBus fallback apply
  // ──────────────────────────────────────────

  applyFromEventBus(entry: ApplyEntry): boolean {
    return (this.replica as any).applyFromEventBus(entry);
  }

  // ──────────────────────────────────────────
  //  Raft message handling
  // ──────────────────────────────────────────

  /**
   * Legacy inbound hook for applications that wire `NodeTransport.onMessage`
   * themselves.
   *
   * @maboke123/raft-core owns message routing: its transport hands every inbound
   * message to `RPCHandler`, notably `InstallSnapshot`, which it reassembles in
   * chunks and installs atomically. This method therefore does not forward
   * anything — an earlier version intercepted `InstallSnapshot` here and pushed
   * the reassembled bytes into `RaftAdapter.step()`, which is a no-op under
   * raft-core, so enabling that path *lost* snapshots instead of installing them.
   *
   * What it still does is the one thing only the application boundary can do:
   * note that a peer was heard from, which split-brain detection needs to tell a
   * partitioned node from a quiet one.
   */
  handleRaftMessage(msg: any): void {
    const from = msg?.from;
    if (from === undefined || from === null) return;
    this.reportPeerActivity(String(from));
  }

  // ──────────────────────────────────────────
  //  Status & utilities

  async isLeader(): Promise<boolean> {
    return await this.raft.isLeader();
  }

  /**
   * Force this node to act as the leader (bypasses Raft election).
   * Used by HA failover for 2-node stuck state.
   */
  setForceLeader(enabled: boolean): void {
    this.raft.setForceLeader(enabled);
  }

  /**
   * Trigger an immediate leader election (campaign) for this Raft group.
   * Delegates to the underlying RaftAdapter.campaign().
   * Used by the HA failover coordinator for direct election triggering.
   */
  async campaign(): Promise<void> {
    return await this.raft.campaign();
  }

  async getLeader(): Promise<number | null> {
    return await this.raft.getLeader();
  }

  async getTerm(): Promise<number> {
    return await this.raft.getTerm();
  }

  async getProgress(): Promise<Record<string, number>> {
    return await this.raft.getProgress();
  }

  getRaftAdapter(): RaftAdapter {
    return this.raft;
  }

  // ──────────────────────────────────────────
  //  Flexible quorum (E3)
  // ──────────────────────────────────────────

  /**
   * Check if a write quorum has been reached.
   * Uses the configured writeQuorum (default: majority = floor(total/2)+1).
   *
   * @param ackCount - Number of acknowledgments received
   * @param total - Total number of peer nodes in the group (excluding self)
   * @returns RaftGroupQuorumResult with quorum status and details
   */
  isQuorumReached(ackCount: number, total: number): RaftGroupQuorumResult {
    const required = total > 0 ? this.flexQuorum.writeQuorum : 1; // self-only
    const met = ackCount >= required;
    return {
      quorumMet: met,
      required,
      actual: ackCount,
      total,
      type: 'write',
    };
  }

  /**
   * Check if a read quorum has been reached.
   * Uses the configured readQuorum (default: 1 — allow stale reads).
   * For linearizable reads, use isCommitQuorumReached() instead.
   *
   * @param ackCount - Number of acknowledgments received
   * @param total - Total number of peer nodes in the group
   * @returns RaftGroupQuorumResult with quorum status and details
   */
  isReadQuorumReached(ackCount: number, total: number): RaftGroupQuorumResult {
    const required = total > 0 ? this.flexQuorum.readQuorum : 1;
    const met = ackCount >= required;
    return {
      quorumMet: met,
      required,
      actual: ackCount,
      total,
      type: 'read',
    };
  }

  /**
   * Check if a commit (linearizable read) quorum has been reached.
   * Uses the configured commitQuorum (default: majority).
   *
   * @param ackCount - Number of acknowledgments received
   * @param total - Total number of peer nodes in the group
   * @returns RaftGroupQuorumResult with quorum status and details
   */
  isCommitQuorumReached(ackCount: number, total: number): RaftGroupQuorumResult {
    const required = total > 0 ? this.flexQuorum.commitQuorum : 1;
    const met = ackCount >= required;
    return {
      quorumMet: met,
      required,
      actual: ackCount,
      total,
      type: 'commit',
    };
  }

  /**
   * Get the current flexible quorum configuration.
   */
  getFlexQuorumConfig(): FlexibleQuorumConfig {
    return { ...this.flexQuorum };
  }

  // ════════════════════════════════════════════════════════════════
  //  HA: Auto Failover (GAP 1)
  // ════════════════════════════════════════════════════════════════

  /**
   * Set a FencingManager instance for this Raft group.
   * The leader monitor will forward leader heartbeats to the fencing
   * manager on each poll interval to maintain the STONITH lease.
   *
   * Must be called BEFORE startLeaderMonitor().
   */
  setFencingManager(fm: import('../fencing/FencingManager').FencingManager): void {
    this._fencingManager = fm;
  }

  /**
   * Start the leader health monitor.
   *
   * Periodically checks whether the Raft group still has an active leader.
   * If the leader has been absent for longer than `electionTimeout * 2`,
   * triggers a new election by calling `campaign()` on the underlying raft node.
   *
   * Also forwards leader heartbeats to the FencingManager (if configured)
   * so that the STONITH lease can be maintained or renewed.
   *
   * @param intervalMs - How often to check (default: 2000ms)
   */
  startLeaderMonitor(intervalMs: number = 2000): void {
    if (this._leaderMonitorTimer) return;

    // C-02: Start active peer cleanup timer (every 10 seconds)
    this._activePeerCleanupTimer = setInterval(() => {
      this._cleanupActivePeers();
    }, 10_000);

    this._leaderMonitorTimer = setInterval(async () => {
      try {
        const node = (this.raft as any).node;
        if (!node) return;

        // Get current leader and term via the RaftAdapter's status API
        const st = await this.raft.getStatus();
        if (!st) return;

        // Track leader heartbeat — any non-null leader is considered healthy
        if (st.lead !== null && st.lead !== '0') {
          this._leaderHeartbeatTs = Date.now();

          // C-03: Only forward heartbeats with a term >= the last known term.
          // Reject heartbeats with a lower term — stale leaders should not
          // renew their FencingManager lease. This prevents a partitioned
          // leader from maintaining its STONITH protection.
          if (this._fencingManager) {
            const term = parseInt(st.term, 10) || 0;
            const leaderId = String(st.lead);
            if (term >= this._lastFencingTerm) {
              this._lastFencingTerm = term;
              this._fencingManager.receiveHeartbeat(this.shardId, term, leaderId);
            } else {
              logger.warn(
                `[RaftGroup] Rejecting stale heartbeat from term ${term} ` +
                  `(last known: ${this._lastFencingTerm}). Leader ${leaderId} may be stale.`,
              );
            }
          }
        }

        // Compute election timeout (ms) from config: electionTick * tickIntervalMs
        const config = (this.raft as any).config as RaftConfig | undefined;
        const electionTick = config?.electionTick ?? 10;
        const tickIntervalMs = config?.tickIntervalMs ?? 100;
        const electionTimeoutMs = electionTick * tickIntervalMs;
        const failoverTimeoutMs = Math.max(electionTimeoutMs * 2, 2000);

        // If no leader heartbeat within the failover window, trigger new election
        if (Date.now() - this._leaderHeartbeatTs > failoverTimeoutMs) {
          logger.warn(
            `[RaftGroup] Leader heartbeat timeout (shard ${this.shardId}, ` +
              `missed ${Date.now() - this._leaderHeartbeatTs}ms, ` +
              `timeout ${failoverTimeoutMs}ms). Triggering campaign.`,
          );

          // Use the underlying RaftNode.campaign() to start election
          if (typeof node.campaign === 'function') {
            await node.campaign();
          }
        }
      } catch (err: unknown) {
        logger.error(`[RaftGroup] Leader monitor error (shard ${this.shardId}): ${getErrorMessage(err)}`);
      }
    }, intervalMs);
  }

  /**
   * Stop the leader monitor. Safe to call when already stopped.
   */
  stopLeaderMonitor(): void {
    if (this._leaderMonitorTimer) {
      clearInterval(this._leaderMonitorTimer);
      this._leaderMonitorTimer = null;
    }
    if (this._activePeerCleanupTimer) {
      clearInterval(this._activePeerCleanupTimer);
      this._activePeerCleanupTimer = null;
    }
  }

  /**
   * Get the leader health status.
   *
   * Returns information about leader liveness, including whether the leader is
   * considered healthy, the time since last heartbeat, and the current term.
   *
   * A leader is considered "healthy" when:
   * - The underlying RaftAdapter reports a leader
   * - AND the leader heartbeat timestamp is within the failover window
   */
  async getLeaderHealth(): Promise<{
    healthy: boolean;
    lastHeartbeatMs: number;
    term: number;
    leaderId: string | null;
    leaderMonitorRunning: boolean;
  }> {
    const term = await this.raft.getTerm();
    const leaderId = await this.raft.getLeader();
    const config = (this.raft as any).config as RaftConfig | undefined;
    const electionTick = config?.electionTick ?? 10;
    const tickIntervalMs = config?.tickIntervalMs ?? 100;
    const failoverTimeoutMs = Math.max(electionTick * tickIntervalMs * 2, 2000);
    const now = Date.now();
    const timeSinceHeartbeat = now - this._leaderHeartbeatTs;

    // Healthy if: leader exists AND heartbeat within timeout
    const hasLeader = leaderId !== null;
    const heartbeatFresh = timeSinceHeartbeat <= failoverTimeoutMs;

    return {
      healthy: hasLeader && heartbeatFresh,
      lastHeartbeatMs: timeSinceHeartbeat,
      term,
      leaderId: leaderId !== null ? String(leaderId) : null,
      leaderMonitorRunning: this._leaderMonitorTimer !== null,
    };
  }

  /**
   * Report peer activity — records that we received a message from a peer.
   * Used by the split-brain detection and leader monitoring subsystems.
   *
   * Call this from `handleRaftMessage` (or from the transport layer) whenever
   * a Raft protocol message arrives from another node.
   *
   * @param peerId - The numeric peer ID (as string) that sent the message
   */
  reportPeerActivity(peerId: string): void {
    if (peerId === String(this.nodeId)) return; // skip self

    this._activePeers.add(peerId);
    this._activePeerTimestamps.set(peerId, Date.now());

    // If the message is from the current leader, also update heartbeat
    // Check cached lead on the node (avoid async)
    const node = (this.raft as any).node;
    if (node && node._lead === peerId) {
      this._leaderHeartbeatTs = Date.now();
    }
  }

  /**
   * C-02: Cleanup stale active peers that have not been heard from
   * within `electionTimeout * 3` ms. Peers that disconnect from the
   * cluster should not remain in the active set indefinitely.
   */
  private _cleanupActivePeers(): void {
    const config = (this.raft as any).config as RaftConfig | undefined;
    const electionTick = config?.electionTick ?? 10;
    const tickIntervalMs = config?.tickIntervalMs ?? 100;
    const staleThresholdMs = electionTick * tickIntervalMs * 3;

    const now = Date.now();
    let removedCount = 0;
    for (const [peerId, lastSeen] of this._activePeerTimestamps) {
      if (now - lastSeen > staleThresholdMs) {
        this._activePeers.delete(peerId);
        this._activePeerTimestamps.delete(peerId);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      logger.debug(
        `[RaftGroup] Cleaned up ${removedCount} stale active peers ` +
          `(threshold: ${staleThresholdMs}ms, remaining: ${this._activePeers.size})`,
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  HA: Split-Brain Prevention (GAP 2)
  // ════════════════════════════════════════════════════════════════

  /**
   * Check whether this node is in the majority partition.
   *
   * Uses the Raft config's peer list as the total voting member count,
   * and compares it against the number of peers we have received recent
   * messages from (tracked via `_activePeers`).
   *
   * @returns true if the number of active peers + self > total peers / 2
   */
  isInMajority(): boolean {
    const config = (this.raft as any).config as RaftConfig | undefined;
    if (!config) return true; // No config → assume majority

    const totalPeers = config.peers.length;

    // Single-node cluster is always in majority
    if (totalPeers <= 1) return true;

    // Count active peers (those we've received messages from)
    // Plus 1 for self — we're always connected to ourselves
    const activeCount = this._activePeers.size + 1;

    // Strict majority: need > totalPeers / 2
    return activeCount > totalPeers / 2;
  }

  /**
   * Enter read-only mode.
   *
   * Sets a flag that prevents writes. In a minority partition, the Raft group
   * should degrade to read-only to avoid violating the consistency guarantees.
   *
   * If this node was the leader, it should also step down to allow the
   * majority partition to elect a new leader.
   */
  async enterReadOnlyMode(): Promise<void> {
    if (this._readOnly) return;

    this._readOnly = true;
    this._fencingState = 'minority';
    // Losing the quorum loses the right to write. Keeping the old token around
    // would let this node present a superseded position to a resource that has
    // not yet seen the new leader's write; dropping it makes the resource refuse
    // with "no token", which is the honest answer.
    this._fencingToken = null;
    logger.warn(
      `[RaftGroup] Entering read-only mode (shard ${this.shardId}). ` +
        `Minority partition detected. Writes will be rejected.`,
    );

    // If we're the leader, step down to avoid split-brain
    const isLeader = await this.raft.isLeader();
    if (isLeader) {
      try {
        const node = (this.raft as any).node;
        if (node && typeof node.stepDown === 'function') {
          await node.stepDown(5000);
          logger.info(`[RaftGroup] Leader stepped down due to minority partition (shard ${this.shardId})`);
        }
      } catch (err: unknown) {
        logger.error(
          `[RaftGroup] Failed to step down from minority partition (shard ${this.shardId}): ${getErrorMessage(err)}`,
        );
      }
    }
  }

  /**
   * Check whether the group is in read-only mode.
   */
  isReadOnly(): boolean {
    return this._readOnly;
  }

  /**
   * Perform a fencing request.
   *
   * The check answers two separate questions, and only one of them can be settled
   * here:
   *
   *   1. Is this node's own view current? Its term must not be behind a term the
   *      group has already observed. A node that is behind cannot mint a token —
   *      the quorum has moved on without it — and enters read-only.
   *   2. Can it hear a majority of its peers? That is a belief assembled from the
   *      messages it happens to receive, and it is the weaker half of the check.
   *
   * When both hold, the fence mints a token from the term the group is in and the
   * index it has committed. The token is what the *resource* compares: it refuses
   * any write carrying a position below the highest it has accepted, which is the
   * only place a partitioned leader can actually be stopped. `isInMajority()`
   * alone cannot do that, because the old primary's own answer is "yes".
   *
   * The check respects `_fencingInterval` to avoid excessive checks.
   *
   * @param force - If true, skip the interval throttle
   * @returns true if the fence succeeded and a token is held
   */
  async fencingRequest(force: boolean = false): Promise<boolean> {
    const now = Date.now();

    // Throttle: only check if enough time has passed since last check
    if (!force && now - this._lastFencingCheck < this._fencingInterval) {
      // Previous result still stands
      return !this._readOnly;
    }

    this._lastFencingCheck = now;
    this._fencingState = 'fencing';

    // A term behind one already observed means the quorum has moved on: this node
    // is the old primary, and no amount of peer chatter makes it current again.
    const term = await this.raft.getTerm();
    if (term < this._lastFencingTerm) {
      logger.warn(
        `[RaftGroup] Fencing check FAILED (shard ${this.shardId}). ` +
          `Local term ${term} is behind the observed term ${this._lastFencingTerm}; ` +
          `refusing to mint a fencing token.`,
      );
      await this.enterReadOnlyMode();
      this._fencingState = 'minority';
      return false;
    }

    // Check if we're in majority
    const inMajority = this.isInMajority();

    if (!inMajority) {
      logger.warn(
        `[RaftGroup] Fencing check FAILED (shard ${this.shardId}). ` +
          `Active peers: ${this._activePeers.size}, total peers in config.`,
      );

      // Step down and enter read-only
      await this.enterReadOnlyMode();
      this._fencingState = 'minority';
      return false;
    }

    // We hold the quorum's position: mint the token the resource will compare.
    const commitIndex = await this.raft.getCommitIndex();
    this._fencingToken = mintFencingToken(term, commitIndex);
    this._lastFencingTerm = term;

    // We're in majority — ensure read-only is disabled
    this._readOnly = false;
    this._fencingState = 'normal';

    logger.debug(
      `[RaftGroup] Fencing check PASSED (shard ${this.shardId}). ` +
        `Active peers: ${this._activePeers.size}, token: ${term}/${commitIndex}`,
    );

    return true;
  }

  /**
   * The token minted by the last successful fence, or null when this node has no
   * right to write.
   *
   * An engine attaches it to every write it sends to the resource; the resource
   * keeps the highest it has seen and refuses anything below it.
   */
  getFencingToken(): FencingToken | null {
    return this._fencingToken;
  }

  /**
   * Get the split-brain status summary.
   */
  getSplitBrainStatus(): {
    inMajority: boolean;
    readOnly: boolean;
    connectedPeers: number;
    totalPeers: number;
    fencingState: string;
    fencingToken: FencingToken | null;
  } {
    const config = (this.raft as any).config as RaftConfig | undefined;
    const totalPeers = config?.peers.length ?? 1;

    return {
      inMajority: this.isInMajority(),
      readOnly: this._readOnly,
      connectedPeers: this._activePeers.size,
      totalPeers,
      fencingState: this._fencingState,
      fencingToken: this._fencingToken,
    };
  }

  /**
   * Get the set of active peer node IDs.
   */
  getActivePeers(): string[] {
    return Array.from(this._activePeers);
  }

  /**
   * Clear the active peer tracking (e.g., after a network partition heals).
   * Peers will be re-added as messages arrive.
   */
  clearActivePeerTracking(): void {
    this._activePeers.clear();
  }

  // ════════════════════════════════════════════════════════════════
  //  Stop / Cleanup (updated with HA resources)
  // ════════════════════════════════════════════════════════════════

  stop(): void {
    this._stopped = true;
    this.stopLeaderMonitor();
    this.raft.stop();
  }
}
