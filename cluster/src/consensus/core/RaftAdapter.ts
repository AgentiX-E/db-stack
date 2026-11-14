/**
 * RaftAdapter — Wrapper around @maboke123/raft-core
 *
 * Normalizes the @maboke123/raft-core RaftNode API for SqlVec's consensus layer.
 * Keeps the exact same public API surface as the old adapter so that
 * RaftGroup.ts and its callers need zero changes.
 *
 * Key differences from the previous WASM adapter:
 *   - No WASM serialization queue (no RefCell issue — @maboke123/raft-core is
 *     pure TypeScript with async-safe internals)
 *   - No manual tick driving (RaftNode internally manages timers and elections)
 *   - No manual leader tracking (RaftNode.getLeaderId() is authoritative)
 *   - forceLeader simplified: mark + skip Raft for propose
 *   - applyHandler passed directly to ShardStateMachine
 */

import { RaftNode, InMemoryNodeStorage, LogEntryType } from '@maboke123/raft-core';
import type { RaftConfig as CoreRaftConfig, NodeStorage, Transport } from '@maboke123/raft-core';
import { SqliteNodeStorage } from '../storage/SqliteNodeStorage';
import { ShardStateMachine } from './ShardStateMachine';
import { BatchedRaftTransport } from '../transport/BatchedRaftTransport';
import { RaftTcpTransport as OriginalRaftTcpTransport } from '../transport/RaftTcpTransport';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';
import type { SharedTransport } from '../../interfaces/types';
import { getErrorMessage } from '../helpers/errorUtils';
import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';

const logger = pino({ level: resolveLogLevel() });

// ──────────────────────────────────────────
//  Public types (re-exported for RaftGroup)
// ──────────────────────────────────────────

export interface RaftTcpTransportConfig {
  /** Local node info */
  node: { id: number; host: string; port: number };
  /** Peer node list */
  peers: Array<{ id: number; host: string; port: number }>;
  /** mTLS certificates */
  tls: {
    cert: Buffer | string;
    key: Buffer | string;
    ca: Buffer | string;
  };
  /** Connection timeout (ms, default 5000) */
  connectTimeoutMs?: number;
  /** Initial retry interval (ms, default 100) */
  initialRetryMs?: number;
  /** Max retry interval (ms, default 30000) */
  maxRetryMs?: number;
}

export interface RaftConfig {
  id: number;
  peers: number[];
  electionTick: number;
  heartbeatTick: number;
  storage?: any;
  transport?: any;
  tickIntervalMs?: number;
  /** Path to a SQLite file for durable Raft log storage. */
  storagePath?: string;
  /** Enable pre-vote check (default: true). Disable for InMemoryTransport tests. */
  preVote?: boolean;
  /** Enable check quorum (default: true). */
  checkQuorum?: boolean;
  /** Snapshot interval (0 = disabled). Every N committed entries triggers snapshot. */
  snapshotInterval?: number;
  /** Max log entries before forced compaction (0 = no limit). */
  maxLogEntries?: number;
  /**
   * Use InMemoryStorage (test-only). When false (default), RaftAdapter
   * requires storagePath or a custom storage instance. NEVER enable in production.
   */
  useInMemoryStorage?: boolean;
  /**
   * Use InMemoryTransport (test-only). When false (default), RaftAdapter
   * requires sharedTransport, tcpConfig, or transport. NEVER enable in production.
   */
  useInMemoryTransport?: boolean;
  /**
   * Enable InstallSnapshot RPC handler for streaming snapshot chunks (G17).
   * When true, RaftGroup initializes InstallSnapshotHandler and routes
   * MsgInstallSnapshot (type 14) messages to it for chunk reassembly.
   * Default: false.
   */
  enableInstallSnapshot?: boolean;
  /**
   * Environment mode. When set to 'production', requires durable storage
   * (storagePath or custom storage instance). Default: 'development'.
   */
  environment?: 'development' | 'production';
  /** Local transport address (used for @maboke123/raft-core RaftConfig). */
  address?: string;
}

export interface CommittedEntry {
  index: string;
  term: string;
  data: string;
}

export interface SnapshotMeta {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  nodeId: number;
  shardId?: number;
  timestamp: number;
}

// ──────────────────────────────────────────
//  RaftAdapter
// ──────────────────────────────────────────

export class RaftAdapter {
  private node: RaftNode | null = null;
  private config: RaftConfig;
  private applyHandler: ((data: string, index?: number, term?: number) => void | Promise<void>) | null = null;

  /**
   * Application snapshot hooks. Without them every snapshot raft-core takes is
   * empty and every snapshot it installs is discarded, which silently loses all
   * state older than the log: the node restarts believing it has applied up to
   * `snapshot.lastIncludedIndex` while the engine is blank.
   *
   * Registered before `init()`, because raft-core restores its snapshot during
   * `start()`. See {@link setApplicationSnapshotHandlers}.
   */
  private applicationSnapshotHandlers: {
    takeSnapshot?: (boundaryIndex: number) => Buffer | Promise<Buffer>;
    installSnapshot?: (data: Buffer) => void | Promise<void>;
  } = {};

  /**
   * Last index this adapter has handed to the application.
   *
   * Kept for the force-leader path, which bypasses raft and therefore has no
   * position to read; the normal path derives the index from raft itself.
   */
  private _appliedIndex = 0;

  private nodeStorage: NodeStorage | null = null;
  private transport: Transport | null = null;
  private originalTcpTransport: OriginalRaftTcpTransport | null = null;

  /**
   * The snapshot raft-core currently holds, as last observed.
   *
   * There is exactly one snapshot in this system: the one raft-core writes
   * together with the log truncation it justifies. Keeping a second, parallel
   * notion of "the snapshot" — a metadata file written by the group — is what
   * made compaction able to discard entries no snapshot covered.
   */
  private _snapshotMeta: { lastIncludedIndex: number; lastIncludedTerm: number; observedAt: number } | null = null;

  /** Forced leader flag — set by HA failover when 2-node cluster is stuck */
  private _forceLeader: boolean = false;

  // Stored reference for getStorage() compatibility
  private sqliteStorage: any = null;

  /** Concurrency limiter for proposeAndWait (CONCURRENCY_MAX=128).
   * Prevents burst-induced mass timeouts: Raft serializes through a single
   * pipeline, so 1K simultaneous proposals would all time out at ~5s.
   * The internal queue + queue timeout ensures controlled pipeline depth
   * without blocking callers indefinitely.
   * Sized at 16: measured against @maboke123/raft-core, whose commit path is a
   * single pipeline guarded by one mutex. At depth 128 a 100-proposal burst
   * lost ~93% of entries (7 committed); at depth 16 the queue absorbs the burst
   * and every entry commits. Deeper pipelines only move the failure from the
   * queue to the RPC timeout. */
  private static readonly CONCURRENCY_MAX = 16;
  private _proposeQueue: Array<{
    data: string;
    resolve: (result: { index: string; term: string }) => void;
    reject: (err: unknown) => void;
  }> = [];
  private _inFlight = 0;

  constructor(config: RaftConfig) {
    this.config = config;
  }

  /**
   * Initialize the @maboke123/raft-core RaftNode.
   *
   * @param applyHandler - Called for every committed entry with data, plus optional index/term
   * @param tcpConfig - Optional TCP transport config (mutually exclusive with sharedTransport)
   * @param sharedTransport - Optional SharedTransport (shared across all RaftGroups, mutually exclusive with tcpConfig)
   *                           Can be a plain SharedTransport or a tuple { transport, shardId } for
   *                           per-shard message routing in single-process multi-RaftGroup mode.
   */
  async init(
    applyHandler?: (data: string, index?: number, term?: number) => void | Promise<void>,
    tcpConfig?: RaftTcpTransportConfig,
    sharedTransport?: SharedTransport | { transport: SharedTransport; shardId: number },
  ): Promise<void> {
    if (applyHandler) this.applyHandler = applyHandler;

    try {
      // ── Step 1: Build NodeStorage ────────────────────────────
      let storage: NodeStorage;

      if (this.config.storage) {
        // Existing SqliteStorage instance passed directly
        storage = new SqliteNodeStorage(this.config.storage);
        this.sqliteStorage = this.config.storage;
      } else if (this.config.storagePath) {
        const { SqliteStorage } = await import('../storage/SqliteStorage');
        const ss = new SqliteStorage({ file: this.config.storagePath, maxLogSize: 0 });
        ss.open();
        this.sqliteStorage = ss;
        storage = new SqliteNodeStorage(ss);
      } else if (this.config.useInMemoryStorage) {
        storage = new InMemoryNodeStorage();
      } else {
        throw new SqlVecError(
          'RaftAdapter requires storagePath or a custom storage instance. Set useInMemoryStorage=true only for tests.',
          SqlVecErrorCode.INTERNAL_ERROR,
        );
      }

      // Production mode requires durable storage
      if (this.config.environment === 'production' && !this.config.storagePath && !this.config.storage) {
        throw new SqlVecError(
          'Production mode requires durable Raft log storage (storagePath or custom storage instance)',
          SqlVecErrorCode.INTERNAL_ERROR,
        );
      }

      this.nodeStorage = storage;

      // ── Step 2: Build Transport ──────────────────────────────
      let raftTransport: Transport;

      if (this.config.transport) {
        // Custom transport already provided
        raftTransport = this.config.transport;
      } else if (sharedTransport) {
        // SharedTransport (e.g., NodeTransport singleton for single-process
        // multi-RaftGroup).  Use SharedBatchedTransport which implements
        // proper request/response matching via requestId and
        // SharedTransport.onMessage() dispatch.
        // sharedTransport can be a plain SharedTransport or { transport, shardId } tuple.
        let st: SharedTransport;
        let shardId: number;
        if ('transport' in (sharedTransport as any)) {
          const tuple = sharedTransport as { transport: SharedTransport; shardId: number };
          st = tuple.transport;
          shardId = tuple.shardId;
        } else {
          st = sharedTransport as SharedTransport;
          shardId = this.config.id;
        }
        const { SharedBatchedTransport } = await import('../transport/SharedBatchedTransport');
        raftTransport = new SharedBatchedTransport(st, shardId, String(this.config.id));
      } else if (tcpConfig) {
        // TCP + mTLS — BatchedRaftTransport wraps the single RaftTcpTransport instance
        raftTransport = new BatchedRaftTransport({
          node: tcpConfig.node,
          peers: tcpConfig.peers,
          tls: tcpConfig.tls,
          connectTimeoutMs: tcpConfig.connectTimeoutMs,
          initialRetryMs: tcpConfig.initialRetryMs,
          maxRetryMs: tcpConfig.maxRetryMs,
        });

        // Wait for connections before starting Raft to avoid heartbeat drops
        const batchedTransport = raftTransport as BatchedRaftTransport;
        await batchedTransport.underlying.start();
        await batchedTransport.underlying.waitForConnections();
        this.originalTcpTransport = batchedTransport.underlying;
      } else {
        if (this.config.useInMemoryTransport) {
          throw new SqlVecError(
            'InMemoryTransport is not needed with @maboke123/raft-core — use InMemoryNodeStorage for tests',
            SqlVecErrorCode.INTERNAL_ERROR,
          );
        }
        throw new SqlVecError(
          'RaftAdapter requires sharedTransport, tcpConfig, or transport. Set useInMemoryStorage=true only for tests.',
          SqlVecErrorCode.INTERNAL_ERROR,
        );
      }

      this.transport = raftTransport;

      // Start transport
      if (!raftTransport.isStarted()) {
        await raftTransport.start();
      }

      // ── Step 3: Build ShardStateMachine ──────────────────────
      const stateMachine = new ShardStateMachine({
        // The position of the entry being applied is exactly
        // `getLastApplied() + 1`: raft-core's apply loop is serialized by an
        // exclusive lock and advances `lastApplied` only after this callback
        // resolves, so nothing can move it in between. Deriving it from raft
        // (instead of counting locally) is what keeps an engine's index equal to
        // the *log* index — a local counter drifts by one for every CONFIG or
        // NOOP entry raft applies without telling the application, and the
        // engine's own strict ordering then rejects the first entry after a
        // restart. Both getters are in-memory field reads.
        applyHandler: async (data: string, index?: number, term?: number) => {
          const appliedIndex = index ?? (this.node ? this.node.getLastApplied() + 1 : 0);
          const appliedTerm = term ?? this.node?.getCurrentTerm() ?? 0;
          if (this.applyHandler) {
            // Rethrow: an unapplied command that raft-core marks as applied is
            // silent divergence. Fail-stopping the apply loop lets the node replay
            // the entry after a restart instead.
            await this.applyHandler(data, appliedIndex, appliedTerm);
          }
          this._appliedIndex = appliedIndex;
        },
        // raft-core computes the snapshot boundary before asking for the bytes, so
        // the engine's state must be stamped with *its* index, not the engine's own
        // watermark: the difference is every non-command entry applied above the
        // last command, and a restore that lands short of the boundary makes the
        // next apply look like a gap.
        takeSnapshotCallback: () =>
          this.applicationSnapshotHandlers.takeSnapshot
            ? this.applicationSnapshotHandlers.takeSnapshot(this.node?.getLastApplied() ?? 0)
            : Buffer.alloc(0),
        installSnapshotCallback: async (data: Buffer) => {
          if (this.applicationSnapshotHandlers.installSnapshot) {
            await this.applicationSnapshotHandlers.installSnapshot(data);
          }
          // The snapshot moves raft's lastApplied without going through apply, so
          // the counter has to follow or the next entry would look like a replay.
          this._appliedIndex = this.node?.getLastApplied() ?? this._appliedIndex;
          // An installed snapshot replaces the one we were advertising.
          await this.refreshSnapshotMeta();
        },
      });

      // ── Step 4: Build RaftConfig for @maboke123/raft-core ────
      const tickIntervalMs = this.config.tickIntervalMs || 100;
      const electionTimeoutMinMs = Math.max(100, this.config.electionTick * tickIntervalMs);
      const electionTimeoutMaxMs = Math.max(150, electionTimeoutMinMs + tickIntervalMs * 2);

      // Build peer list
      const nodeId = String(this.config.id);
      const address = tcpConfig
        ? `${tcpConfig.node.host}:${tcpConfig.node.port}`
        : this.config.address || `node-${this.config.id}:0`;

      // SharedTransport mode (no tcpConfig) may not have peers in config;
      // the transport layer handles peer routing, so use empty peer list.
      const peerIds = this.config.peers || [];
      const peers = peerIds
        .filter((p) => p !== this.config.id)
        .map((p) => ({
          id: String(p),
          address: tcpConfig
            ? `${tcpConfig.peers.find((pc) => pc.id === p)?.host || '127.0.0.1'}:${tcpConfig.peers.find((pc) => pc.id === p)?.port || 0}`
            : `node-${p}:0`,
        }));

      const coreConfig: CoreRaftConfig = {
        nodeId,
        address,
        peers,
        electionTimeoutMinMs,
        electionTimeoutMaxMs,
        heartbeatIntervalMs: Math.max(10, this.config.heartbeatTick * tickIntervalMs),
        // `snapshotInterval` was documented as "entries between snapshots" but never
        // reached raft-core, so an operator asking for a snapshot every 15 entries
        // silently got the library default and the log grew to match. It is now
        // forwarded — but only when the operator set it: applying this package's own
        // default here would silently change snapshot frequency (and the cost that
        // goes with it) for every existing deployment.
        ...(this.config.snapshotInterval === undefined ? {} : { snapshotThreshold: this.config.snapshotInterval }),
      };

      // ── Step 5: Create RaftNode ──────────────────────────────
      const raftNode = new RaftNode({
        config: coreConfig,
        storage,
        transport: raftTransport,
        stateMachine,
        logger: {
          debug: (msg: string, ctx?: any) => logger.debug(ctx || {}, msg),
          info: (msg: string, ctx?: any) => logger.info(ctx || {}, msg),
          warn: (msg: string, ctx?: any) => logger.warn(ctx || {}, msg),
          error: (msg: string, ctx?: any) => logger.error(ctx || {}, msg),
        },
      });

      await raftNode.start();
      this.node = raftNode;
      // A restart may begin above index 1 (raft loads a snapshot during start), and
      // the entry counter must reflect that before the first apply arrives.
      this._appliedIndex = raftNode.getLastApplied();
      // A restarted node already owns a snapshot; read it before anyone asks.
      await this.refreshSnapshotMeta();

      logger.info({ nodeId: this.config.id }, '[RaftAdapter] Initialized with @maboke123/raft-core');
    } catch (err: unknown) {
      throw new SqlVecError(
        `Failed to initialize @maboke123/raft-core: ${getErrorMessage(err)}`,
        SqlVecErrorCode.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Build a transport bridge wrapping SharedTransport.
   *
   * SharedTransport is used by NodeTransport which routes messages between
   * RaftGroups within the same process. We use the existing RaftTransportAdapter
   * pattern: the adapter wires messages from the TCP transport (or shared transport)
   * into the Raft layer. For SharedTransport, messages come from inter-group routing.
   *
   */
  // Removed: buildSharedTransportBridge — replaced by SharedBatchedTransport above.
  // private async buildSharedTransportBridge(...): Promise<BatchedRaftTransport> { ... }

  /**
   * Register the application-state snapshot hooks.
   *
   * Must be called before {@link RaftAdapter.init}: raft-core loads the persisted
   * snapshot during `start()` and hands it to the application state machine, so a
   * handler registered afterwards would miss the restore.
   *
   * @param handlers Serializer and restorer for the engine's applied state.
   */
  setApplicationSnapshotHandlers(handlers: {
    /**
     * Serialize the engine's applied state.
     *
     * @param boundaryIndex The Raft log index the snapshot will cover. The
     *        envelope must record *this* index: the engine's own watermark can be
     *        lower, because raft-core applies CONFIG and NOOP entries without
     *        calling the application, and a state stamped below the boundary would
     *        make the first post-restore apply look like a gap.
     */
    takeSnapshot?: (boundaryIndex: number) => Buffer | Promise<Buffer>;
    installSnapshot?: (data: Buffer) => void | Promise<void>;
  }): void {
    this.applicationSnapshotHandlers = handlers;
  }

  /**
   * Propose an entry through Raft consensus.
   * Resolves with { index, term } after the entry is committed and applied.
   */
  async propose(data: string): Promise<{ index: string; term: string }> {
    // Bursts must be funnelled through the same bounded pipeline as
    // proposeAndWait: @maboke123/raft-core commits through a single pipeline,
    // so firing N concurrent submitCommand calls makes most of them fail
    // (observed: 7 of 100 committed) instead of simply queueing.
    return this._submit(data);
  }

  /**
   * Submit through the concurrency limiter; queues while the pipeline is full.
   */
  private _submit(data: string): Promise<{ index: string; term: string }> {
    if (this._inFlight >= RaftAdapter.CONCURRENCY_MAX) {
      return new Promise<{ index: string; term: string }>((resolve, reject) => {
        this._proposeQueue.push({ data, resolve, reject });
      });
    }
    return this._doPropose(data);
  }

  async proposeAndWait(data: string): Promise<void> {
    await this._submit(data);
  }

  /**
   * Internal propose executor. Runs the actual Raft submitCommand, then
   * services the next queued proposal before returning.
   */
  private async _doPropose(data: string): Promise<{ index: string; term: string }> {
    if (!this.node) {
      throw new SqlVecError('Raft node not initialized', SqlVecErrorCode.INTERNAL_ERROR);
    }

    // ── Force leader bypass ──
    if (this._forceLeader) {
      try {
        if (this.applyHandler) {
          await this.applyHandler(data, this._appliedIndex + 1, this.node.getCurrentTerm());
          this._appliedIndex += 1;
        }
        return { index: '0', term: '0' };
      } catch (applyErr: unknown) {
        throw new SqlVecError(
          `Force-leader apply failed: ${getErrorMessage(applyErr)}`,
          SqlVecErrorCode.INTERNAL_ERROR,
        );
      }
    }

    this._inFlight++;
    try {
      const result = await this.node.submitCommand({
        type: 'command',
        payload: data,
      });

      if (!result.success && !result.leaderId) {
        throw new SqlVecError(
          `Raft propose failed: ${result.error || 'unknown error'}`,
          SqlVecErrorCode.INTERNAL_ERROR,
        );
      }

      if (!result.success && result.leaderId) {
        throw new SqlVecError(
          `Not the Raft leader for this shard (leader=${result.leaderId})`,
          SqlVecErrorCode.NOT_LEADER,
        );
      }

      return { index: String(result.index ?? 0), term: String(this.node.getCurrentTerm()) };
    } catch (err: unknown) {
      if (err instanceof SqlVecError) throw err;
      throw new SqlVecError(`Raft propose failed: ${getErrorMessage(err)}`, SqlVecErrorCode.INTERNAL_ERROR);
    } finally {
      this._inFlight--;
      // Service the next queued proposal — must be in finally so that
      // thrown errors don't starve the queue.
      this._serviceQueue();
    }
  }

  /**
   * Pop the next queued proposal and execute it.
   * Uses CONCURRENCY_MAX to limit in-flight proposals, preventing
   * burst-induced mass timeouts against the single-pipeline Raft core.
   */
  private _serviceQueue(): void {
    while (this._inFlight < RaftAdapter.CONCURRENCY_MAX) {
      const next = this._proposeQueue.shift();
      if (!next) break;
      this._doPropose(next.data).then(next.resolve).catch(next.reject);
    }
  }

  /**
   * Transfer leadership to a target node.
   *
   * Must be called on the leader. Stops heartbeat so the target node detects
   * leader loss and triggers an election. Waits up to 10 seconds for the
   * target to become the new leader.
   *
   * @param targetNodeId - The node ID to transfer leadership to
   * @throws Error if not leader or transfer times out
   */
  async transferLeadership(targetNodeId: string): Promise<void> {
    if (!this.node) throw new Error('RaftAdapter not initialized');
    if (!(await this.isLeader())) {
      throw new Error('Only the leader can transfer leadership');
    }

    // Step 1: Submit NOOP to ensure all prior entries are committed
    const result = await this.node.submitCommand({
      type: 'command',
      payload: JSON.stringify({
        __noop: true,
        reason: 'leader-transfer',
        ts: Date.now(),
      }),
    });
    if (!result.success) {
      throw new Error(`Failed to commit NOOP entry: ${result.error || 'unknown'}`);
    }

    // Step 2: Stop heartbeat so target detects leader loss
    await this.stopHeartbeat();

    // Step 3: Wait for new leader
    const startTime = Date.now();
    const timeoutMs = 10_000;
    const pollIntervalMs = 200;
    const maxAttempts = timeoutMs / pollIntervalMs;

    const selfNodeId = Number(this.node.getNodeId());

    for (let i = 0; i < maxAttempts; i++) {
      const leader = await this.getLeader();
      if (leader !== null && leader !== selfNodeId) {
        // Wait briefly for the new leader to be ready
        await new Promise((r) => setTimeout(r, 500));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Leadership transfer timed out: target ${targetNodeId} did not become leader within ${timeoutMs}ms`,
    );
  }

  /**
   * Stop the heartbeat timer on the current leader.
   *
   * This causes the other nodes to detect leader loss via election timeout,
   * triggering a new election cycle. Only callable on the leader node.
   *
   * Accessible via RaftAdapter to avoid exposing the internal RaftNode as any.
   */
  async stopHeartbeat(): Promise<void> {
    if (!this.node) throw new Error('RaftAdapter not initialized');

    const stateMachine = (this.node as any).stateMachine;
    if (!stateMachine || typeof stateMachine.timerManager?.stopHeartbeatTimer !== 'function') {
      throw new Error('Cannot stop heartbeat: timerManager not accessible');
    }

    const timerManager = stateMachine.timerManager;
    timerManager.stopHeartbeatTimer();

    // Double-stop to cover any edge cases
    if (typeof timerManager.stopHeartbeatTimer === 'function') {
      timerManager.stopHeartbeatTimer();
    }
  }

  /**
   * Check if this node is the Raft leader.
   */
  async isLeader(): Promise<boolean> {
    if (this._forceLeader) return true;
    if (!this.node) return false;
    try {
      return this.node.isLeader();
    } catch {
      return false;
    }
  }

  /**
   * Force this node to act as the leader, bypassing Raft election.
   * Used by HA failover coordinator when a 2-node cluster loses one node.
   */
  setForceLeader(enabled: boolean): void {
    this._forceLeader = enabled;
    logger.warn({ nodeId: this.config.id, enabled }, `[RaftAdapter] Force leader ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Get the current Raft term.
   */
  async getTerm(): Promise<number> {
    if (!this.node) return 0;
    try {
      return this.node.getCurrentTerm();
    } catch {
      return 0;
    }
  }

  /**
   * Get the current Raft leader node ID.
   */
  async getLeader(): Promise<number | null> {
    if (this._forceLeader) return this.config.id;
    if (!this.node) return null;
    try {
      const leaderId = this.node.getLeaderId();
      if (leaderId === null) return null;
      return Number(leaderId);
    } catch {
      return null;
    }
  }

  /**
   * Get replication progress summary.
   */
  async getProgress(): Promise<Record<string, number>> {
    if (!this.node) return {};
    try {
      return {
        commit: this.node.getCommittedIndex(),
        applied: this.node.getLastApplied(),
        lastLog: this.node.getLastLogIndex(),
      };
    } catch {
      return {};
    }
  }

  /**
   * Get the length of the retained (not-yet-compacted) Raft log.
   *
   * This is the authoritative measure of bounded log growth: a healthy node
   * compacts its log on snapshot, so `lastLog - applied` stays near the
   * snapshot threshold instead of growing monotonically with the total number
   * of committed entries. It intentionally differs from physical file size,
   * which is sensitive to SQLite WAL freelist layout and does not shrink on
   * DELETE-based compaction.
   */
  async getRetainedLogLength(): Promise<number> {
    const progress = await this.getProgress();
    const lastLog = progress.lastLog ?? 0;
    const applied = progress.applied ?? 0;
    return Math.max(0, lastLog - applied);
  }

  /**
   * Get the last applied index.
   */
  async getAppliedIndex(): Promise<number> {
    if (!this.node) return 0;
    try {
      return this.node.getLastApplied();
    } catch {
      return 0;
    }
  }

  /**
   * Get the current commit index.
   */
  async getCommitIndex(): Promise<number> {
    if (!this.node) return 0;
    try {
      return this.node.getCommittedIndex();
    } catch {
      return 0;
    }
  }

  /**
   * Get full Raft status.
   *
   * Also refreshes the cached snapshot view: this is the call monitoring makes,
   * and a status that reports a snapshot index the node no longer holds (or omits
   * one raft-core took on its own threshold) is worse than no field at all.
   */
  async getStatus(): Promise<any> {
    if (!this.node) return null;
    try {
      const snapshot = await this.refreshSnapshotMeta();
      return {
        role: this.node.getState(),
        term: this.node.getCurrentTerm(),
        commitIndex: this.node.getCommittedIndex(),
        lastApplied: this.node.getLastApplied(),
        lastLogIndex: this.node.getLastLogIndex(),
        leader: this.node.getLeaderId(),
        snapshot: snapshot
          ? { lastIncludedIndex: snapshot.lastIncludedIndex, lastIncludedTerm: snapshot.lastIncludedTerm }
          : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Trigger an election campaign.
   * @maboke123/raft-core handles elections automatically; this is a no-op.
   */
  async campaign(): Promise<void> {
    // @maboke123/raft-core handles elections automatically via timer.
    // No manual campaign needed.
  }

  /**
   * Step a Raft protocol message from a peer (public API).
   * @maboke123/raft-core handles routing via Transport; no manual step needed.
   */
  step(msg: any): void {
    // @maboke123/raft-core's Transport.onMessage handler automatically
    // routes incoming messages. No manual step() needed.
  }

  /**
   * Stop the Raft node and release resources.
   */
  stop(): void {
    if (this.node) {
      try {
        this.node.stop();
      } catch (err: unknown) {
        logger.warn({ err }, '[RaftAdapter] Error stopping RaftNode');
      }
      this.node = null;
    }

    if (this.transport) {
      try {
        this.transport.stop();
      } catch (err: unknown) {
        console.warn('[RaftAdapter] Transport stop failed:', err);
      }
      this.transport = null;
    }

    if (this.originalTcpTransport) {
      try {
        this.originalTcpTransport.stop();
      } catch (err: unknown) {
        console.warn('[RaftAdapter] Original TCP transport stop failed:', err);
      }
      this.originalTcpTransport = null;
    }

    if (this.sqliteStorage) {
      try {
        this.sqliteStorage.close();
      } catch (err: unknown) {
        console.warn('[RaftAdapter] SQLite storage close failed:', err);
      }
      this.sqliteStorage = null;
    }
  }

  // ──────────────────────────────────────────
  //  Snapshot API
  // ──────────────────────────────────────────

  /**
   * The snapshot raft-core currently holds, or `null` when it holds none.
   *
   * Synchronous on purpose: it reads a cache refreshed at init, after every
   * snapshot this adapter requests and after every snapshot raft-core installs,
   * so callers on a hot path (learner catch-up, status reporting) do not have to
   * await a storage read.
   */
  getSnapshotMeta(): { lastIncludedIndex: number; lastIncludedTerm: number; observedAt: number } | null {
    return this._snapshotMeta;
  }

  /**
   * Re-read raft-core's snapshot metadata into the cache.
   *
   * The stored snapshot is the only authority: it is written by raft-core in the
   * same step that truncates the log, so its index is exactly the boundary below
   * which no log entry exists.
   */
  async refreshSnapshotMeta(): Promise<{
    lastIncludedIndex: number;
    lastIncludedTerm: number;
    observedAt: number;
  } | null> {
    try {
      const meta = await this.nodeStorage?.snapshot.readMetadata();
      this._snapshotMeta =
        meta && meta.lastIncludedIndex > 0
          ? {
              lastIncludedIndex: meta.lastIncludedIndex,
              lastIncludedTerm: meta.lastIncludedTerm ?? 0,
              observedAt: Date.now(),
            }
          : null;
    } catch (err: unknown) {
      logger.warn({ err }, '[RaftAdapter] Failed to read snapshot metadata');
      this._snapshotMeta = null;
    }
    return this._snapshotMeta;
  }

  /**
   * Take a snapshot now and let raft-core compact the log it covers.
   *
   * This is the *only* way this package produces a snapshot. Scheduling belongs
   * to raft-core (`snapshotInterval` → its threshold, checked after every apply);
   * this method is the explicit path — operator request, log-size pressure, or a
   * PITR flush boundary — and is idempotent: asking twice for the same applied
   * index returns the existing snapshot without writing or compacting again.
   *
   * @returns The snapshot metadata after the call, or `null` when nothing could
   *          be snapshotted (not started, or nothing applied yet).
   */
  async requestSnapshot(): Promise<{ lastIncludedIndex: number; lastIncludedTerm: number; observedAt: number } | null> {
    if (!this.node) return null;

    const applied = this.node.getLastApplied();
    const current = this._snapshotMeta;
    if (applied <= 0) return current;
    if (current && applied <= current.lastIncludedIndex) return current;

    // raft-core publishes no "snapshot now" trigger: `takeSnapshot` is its own
    // capture-and-compact routine, declared private in the typings but the only
    // way to snapshot outside its threshold. The cast is narrow and defensive —
    // if the library ever renames it, this degrades to "cannot force" (logged)
    // instead of throwing on a path that must never fail an apply.
    // `src/__tests__/unit/RaftAdapter.snapshot.test.ts` fails if it disappears.
    const node = this.node as unknown as { takeSnapshot?: () => Promise<unknown> };
    if (typeof node.takeSnapshot !== 'function') {
      logger.warn('[RaftAdapter] raft-core exposes no snapshot trigger — request ignored');
      return current;
    }

    try {
      await node.takeSnapshot.call(this.node);
    } catch (err: unknown) {
      logger.warn({ err }, `[RaftAdapter] Snapshot request failed at index ${applied}`);
      return current;
    }
    return await this.refreshSnapshotMeta();
  }

  /**
   * Compact the Raft log up to (and including) the given snapshot index.
   */
  async compactLogs(lastIncludedIndex: number): Promise<void> {
    const storage = this.sqliteStorage || (this.config.storage as any);
    if (!storage) {
      logger.debug(`[RaftAdapter] No storage available for log compaction at index ${lastIncludedIndex}`);
      return;
    }
    if (typeof storage.compactLogs !== 'function') {
      logger.warn(
        `[RaftAdapter] Storage does not support compactLogs() — logs will not be truncated (index ${lastIncludedIndex})`,
      );
      return;
    }
    try {
      await storage.compactLogs(lastIncludedIndex);
      logger.info(`[RaftAdapter] Logs compacted at index ${lastIncludedIndex}`);
    } catch (err: unknown) {
      logger.warn(
        { err },
        `[RaftAdapter] Log compaction failed at index ${lastIncludedIndex}: ${getErrorMessage(err)} — continuing`,
      );
    }
  }

  /**
   * Flush pending apply queue (no-op for @maboke123/raft-core — apply is synchronous).
   */
  flushApplyQueue(): void {
    // @maboke123/raft-core applies entries synchronously in its apply loop.
    // No background apply queue needed.
  }

  /**
   * Get the underlying SqliteStorage instance for direct log manipulation.
   */
  getStorage(): any {
    return this.sqliteStorage || this.config.storage || null;
  }

  /**
   * Read index barrier for linearizable reads.
   * @maboke123/raft-core guarantees linearizable reads natively.
   */
  async readBarrier(): Promise<void> {
    // @maboke123/raft-core guarantees linearizable reads without manual barrier.
  }

  // ──────────────────────────────────────────
  //  Static helpers
  // ──────────────────────────────────────────

  /**
   * Encode snapshot metadata as Uint8Array for persistence.
   */
  static encodeSnapshotData(meta: SnapshotMeta): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(meta));
  }
}
