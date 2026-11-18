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
import { QuorumWatchdog } from './QuorumWatchdog';
import { ObservedTransport } from '../transport/ObservedTransport';
import { SwappableTransport } from '../transport/SwappableTransport';
import { BatchedRaftTransport } from '../transport/BatchedRaftTransport';
import { RaftTcpTransport as OriginalRaftTcpTransport } from '../transport/RaftTcpTransport';
import { SqlVecError, SqlVecErrorCode } from '../../interfaces/types';
import type { SharedTransport } from '../../interfaces/types';
import { getErrorMessage } from '../helpers/errorUtils';
import pino from 'pino';
import { resolveLogLevel } from '../../observability/logLevel';

const logger = pino({ level: resolveLogLevel() });

/**
 * The transport a wrapper delegates to, when it says so.
 *
 * Every wrapper in this package exposes `underlying` for exactly this purpose: the
 * chain is walked to reach the layer that owns the sockets or the observer that
 * records contact. A transport with no such property ends the walk, which is the
 * honest answer — nothing further down is reachable.
 */
function underlyingOf(transport: Transport): Transport | null {
  const candidate = (transport as { underlying?: unknown }).underlying;
  return candidate && typeof candidate === 'object' ? (candidate as Transport) : null;
}

// ──────────────────────────────────────────
//  Public types (re-exported for RaftGroup)
// ──────────────────────────────────────────

/** What a node knows about who has answered it lately. */
export interface QuorumHealth {
  /** Members in the cluster, this node included. */
  size: number;
  /** How many members make a majority. */
  majority: number;
  /** How long an answer keeps counting, in milliseconds. */
  windowMs: number;
  /** Whether enough members answered recently to form a majority. */
  hasQuorum: boolean;
  /** Members that are silent: never heard from, or heard from too long ago. */
  unheardPeers: number[];
}

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
  /**
   * Accepted, **not forwarded**: raft-core 0.2.1 implements pre-vote
   * unconditionally and exposes no flag to turn it off, so `true` describes what
   * happens and `false` cannot. `init` warns when `false` is passed rather than
   * pretending the setting took effect — the flag is kept because the harness and the
   * chaos configurations set it, and because removing it would rename a knob in every
   * caller for no behavioural change.
   */
  preVote?: boolean;
  /**
   * Whether leadership is answered from contact with a majority (default: `true`).
   *
   * raft-core 0.2.1 implements no check-quorum at all: an isolated leader keeps
   * answering `isLeader() === true` and simply cannot commit — measured on
   * 2026-11-18, still leading at 16 s with the commit index frozen and every write
   * refused after 5 028 ms. With this enabled, the adapter records which peers have
   * answered it inside one election timeout and reports leadership only while a
   * majority is still answering. The library's own role is left untouched: the node
   * stops *claiming* to be able to serve, which is the part a router reads.
   */
  checkQuorum?: boolean;
  /**
   * Entries between snapshots (default `DEFAULT_SNAPSHOT_INTERVAL` = 200).
   *
   * Lower keeps the log a restart replays short and pays for it in capture cost
   * (measured: p99 proposal latency 31 ms at 100 versus 12 ms at 200 — retention is
   * identical). Setting it above the write volume means no snapshot happens at all,
   * which is a choice to replay every entry after a restart.
   */
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
   * Accepted and ignored.
   *
   * It used to be advertised as "RaftGroup initialises `InstallSnapshotHandler`
   * and routes type 14 to it", which was never true of this adapter: chunked
   * install is performed by raft-core itself, and the adapter only supplies the
   * application hooks (`setApplicationSnapshotHandlers`). The field is kept so
   * existing configurations keep compiling, but nothing reads it — a knob that
   * silently does nothing is worse than no knob, which is why it is documented
   * as dead rather than deleted.
   *
   * @deprecated Chunked snapshot install is unconditional; use
   *   `setApplicationSnapshotHandlers` to capture and restore application state.
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

/**
 * Entries between snapshots when the operator does not choose one.
 *
 * Measured on real 3-node mTLS clusters (`bench/snapshot-threshold-sweep.ts`, 600
 * proposals per threshold):
 *
 * | threshold | retained log | snapshot@ | proposal p50 | proposal p99 |
 * |---:|---:|---:|---:|---:|
 * | 100 | 51 | 600 | 9.73 ms | 31.49 ms |
 * | 200 | 51 | 600 | 9.05 ms | 12.36 ms |
 * | 1000 | 651 | none | 8.95 ms | 11.26 ms |
 * | 5000 | 651 | none | 8.76 ms | 10.61 ms |
 *
 * Two conclusions. A threshold above the write volume means *no* snapshot at all — the
 * log holds every entry a restart would replay — which is why "leave it to the library
 * default" is not a neutral choice. And 100 vs 200 changes nothing about retention
 * (both end with the 51-entry tail) while costing four times the p99, because capture
 * runs twice as often. 200 is raft-core's default, so this constant documents and
 * pins existing behaviour rather than changing it.
 */
export const DEFAULT_SNAPSHOT_INTERVAL = 200;

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
  /**
   * The object raft-core holds. Its inside is replaceable, which is what makes
   * `transport` a seam rather than a field: raft-core captures the transport it is
   * constructed with, so assigning to a plain field afterwards changed nothing and
   * every fault injector in this repository was talking to itself.
   */
  private transportProxy: SwappableTransport | null = null;
  /** The transport this adapter built; the target of the connection-report walk. */
  private rawTransport: Transport | null = null;
  /** Innermost wrapper: the only one that sees a real round trip. */
  private observer: ObservedTransport | null = null;
  /** What the leader knows about who answered it lately. */
  private watchdog: QuorumWatchdog | null = null;
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

  /**
   * Settings that were accepted and could not be honoured, with the reason.
   *
   * A configuration option that silently does nothing is worse than no option: the
   * caller believes it changed a behaviour. These are queryable so a deployment can
   * assert its own configuration is fully in effect.
   */
  private ignoredSettings: Array<{ setting: string; reason: string }> = [];

  /** Forced leader flag — set by HA failover when 2-node cluster is stuck */
  private _forceLeader: boolean = false;

  // Stored reference for getStorage() compatibility
  private sqliteStorage: any = null;
  /** Storage opened from `storagePath`. Only this one is ours to close. */
  private _ownsStorage = false;

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
    // A second init on a live adapter used to re-enter the whole build: it
    // constructed a fresh SqliteStorage, assigned it over `this.sqliteStorage`,
    // and left the previous handle open and unreachable. Depending on how far
    // raft-core got before failing, the node could also keep serving on the old
    // storage while the adapter believed it owned the new one. Refusing is the
    // only outcome that cannot corrupt a node; `stop()` then `init()` is the
    // supported way to restart. Checked before the handler is installed so a
    // refused call changes nothing at all.
    if (this.node || this.sqliteStorage) {
      throw new SqlVecError(
        'RaftAdapter is already initialized; call stop() before init() again',
        SqlVecErrorCode.INTERNAL_ERROR,
      );
    }

    if (applyHandler) this.applyHandler = applyHandler;

    if (this.config.preVote === false) {
      // Said out loud rather than honoured: raft-core runs a pre-vote phase on every
      // election timeout and exposes no flag to skip it, so a caller asking for "no
      // pre-vote" would otherwise be trusting a setting that cannot take effect.
      // Recorded as well as logged, because a warning in a log nobody tails is how a
      // dead setting stays dead.
      this.ignoredSettings.push({
        setting: 'preVote',
        reason: 'raft-core pre-votes unconditionally and exposes no flag to disable it (P3-22)',
      });
      logger.warn(
        { nodeId: this.config.id },
        '[RaftAdapter] preVote: false is not forwarded — raft-core pre-votes unconditionally, so this setting cannot take effect (P3-22)',
      );
    }

    try {
      // ── Step 1: Build NodeStorage ────────────────────────────
      let storage: NodeStorage;

      if (this.config.storage) {
        // Existing SqliteStorage instance passed directly
        storage = new SqliteNodeStorage(this.config.storage);
        this.sqliteStorage = this.config.storage;
        this._ownsStorage = false;
      } else if (this.config.storagePath) {
        const { SqliteStorage } = await import('../storage/SqliteStorage');
        const ss = new SqliteStorage({ file: this.config.storagePath, maxLogSize: 0 });
        ss.open();
        this.sqliteStorage = ss;
        this._ownsStorage = true;
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

      this.rawTransport = raftTransport;

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
        takeSnapshotCallback: async () => {
          const handler = this.applicationSnapshotHandlers.takeSnapshot;
          // No handler is a legitimate configuration: a group that holds no
          // application state (log and configuration only) has nothing to
          // capture, and raft still needs a boundary to truncate at.
          if (!handler) return Buffer.alloc(0);

          const data = await handler(this.node?.getLastApplied() ?? 0);
          if (!Buffer.isBuffer(data)) {
            throw new SqlVecError(
              `takeSnapshot returned ${Object.prototype.toString.call(data)} instead of a Buffer. ` +
                'A non-Buffer is stored as nothing, and the follower then installs an empty snapshot ' +
                'while raft reports it as caught up.',
              SqlVecErrorCode.INTERNAL_ERROR,
            );
          }
          if (data.length === 0) {
            // The dangerous case: a handler exists, so the application *does*
            // own state, yet it produced no bytes. Persisting that snapshot
            // truncates the log up to an index whose state nobody captured, and
            // every follower that installs it gets an empty application.
            throw new SqlVecError(
              'takeSnapshot returned 0 bytes. An application that registers a snapshot handler owns ' +
                'state, so an empty snapshot would truncate the log for an index it does not describe.',
              SqlVecErrorCode.INTERNAL_ERROR,
            );
          }
          return data;
        },
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
        // silently got the library default and the log grew to match. It is forwarded
        // unconditionally now, with this package's own default when unset: leaving the
        // number to the library means a dependency bump can change how much log a
        // deployment replays after a restart, with nothing in this repository changing.
        // The default is raft-core's current 200, so no existing deployment moves — it
        // is now stated here, measured (`bench/snapshot-threshold-sweep.ts`) and tested.
        snapshotThreshold: this.config.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL,
      };

      // ── Step 5: Create RaftNode ──────────────────────────────
      //
      // The node is given the seam, not the transport, so that a transport installed
      // later is a change raft-core observes. The quorum observer goes *inside* the
      // seam and around the real transport: a wrapper installed later (a fault
      // injector, a partition) sits outside it and can therefore answer a message it
      // never delivered without that answer counting as contact.
      const nodeTransport = this.attachTransport(raftTransport, peerIds, electionTimeoutMaxMs);
      const raftNode = new RaftNode({
        config: coreConfig,
        storage,
        transport: nodeTransport,
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
      // Release whatever got built before the failure. Nothing else can: the
      // caller only sees a rejected promise and has no handle on the storage or
      // the listener that a half-finished init already opened.
      await this.releaseResources();
      throw new SqlVecError(
        `Failed to initialize @maboke123/raft-core: ${getErrorMessage(err)}`,
        SqlVecErrorCode.INTERNAL_ERROR,
        { cause: err },
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
  private async _submit(data: string): Promise<{ index: string; term: string }> {
    // A leader that has lost its quorum is still raft's leader, so the library would
    // accept the entry, append it, and wait for a commit that cannot arrive: measured
    // at 5 028 ms before the refusal. Refusing here is the same answer, delivered
    // while the caller still cares, and it names the reason instead of a timeout.
    if (!this._forceLeader && this.node?.isLeader() && !this.hasQuorum()) {
      const health = this.getQuorumHealth();
      const heard = health ? health.size - health.unheardPeers.length : 0;
      throw new SqlVecError(
        `write refused: this node is raft's leader but has lost its quorum — heard from ` +
          `${heard} of ${health?.size ?? 0} members within ${health?.windowMs ?? 0}ms, ` +
          `${health?.majority ?? 0} needed (silent: ${health?.unheardPeers.join(',') || 'none'})`,
        SqlVecErrorCode.QUORUM_FAILED,
      );
    }
    if (this._inFlight >= RaftAdapter.CONCURRENCY_MAX) {
      return new Promise<{ index: string; term: string }>((resolve, reject) => {
        this._proposeQueue.push({ data, resolve, reject });
      });
    }
    return this._doPropose(data);
  }

  /**
   * Propose an entry and resolve once it is committed and applied.
   *
   * Returns the position the entry committed at. It used to return `void`, so
   * the only caller that needed the position (`RaftGroup.proposeAndWait`, which
   * has to stamp it into the outbox record for point-in-time recovery) appended
   * `raftIndex: 0` instead and asked a second question afterwards.
   */
  async proposeAndWait(data: string): Promise<{ index: string; term: string }> {
    return this._submit(data);
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
   * The transport raft-core is talking through, or null before init.
   *
   * Assigning to it re-points the seam. Anything installed here is expected to wrap
   * the transport it replaces (a fault injector, a partition), and the assignment is
   * refused when nothing is installed yet: a transport set before a node exists has
   * nowhere to go, and silently keeping it would describe a node that never uses it.
   */
  get transport(): Transport | null {
    return this.transportProxy?.underlying ?? null;
  }

  set transport(next: Transport | null) {
    if (!this.transportProxy) {
      if (next === null) return; // shutdown from a state that never installed one
      throw new SqlVecError(
        'RaftAdapter: transport cannot be installed before init(); pass it through init(tcpConfig) instead',
        SqlVecErrorCode.INVALID_ARGUMENT,
      );
    }
    this.transportProxy.swap(this.wrapForObservation(next));
  }

  /** The transport in use, or null. Named accessor for callers that prefer methods. */
  getTransport(): Transport | null {
    return this.transport;
  }

  /**
   * Install a different transport underneath the running node.
   *
   * This exists because raft-core captures the transport object it is constructed
   * with: replacing a field is invisible to the library, so fault injection and
   * transport upgrades have to go through the one object it holds. `next` is expected
   * to wrap the current transport (`new Wrapper(adapter.getTransport())`); a transport
   * that does not is accepted, but the observer is re-installed outside it, and an
   * outer wrapper that answers without delivering stops being evidence of contact.
   */
  setTransport(next: Transport | null): void {
    this.transport = next;
  }

  /**
   * Who this node has heard from lately, and whether that is a majority.
   *
   * Null when quorum accounting is off (`checkQuorum: false`) or impossible (a
   * configuration with no peer list, such as a shared-transport group whose members
   * live in another manager).
   */
  getQuorumHealth(): QuorumHealth | null {
    const watchdog = this.watchdog;
    if (!watchdog) return null;
    return {
      size: watchdog.size,
      majority: watchdog.majority,
      windowMs: watchdog.window,
      hasQuorum: watchdog.hasQuorum(),
      unheardPeers: watchdog.unheardPeers(),
    };
  }

  /** Settings that were accepted but cannot take effect, with the reason. */
  getIgnoredSettings(): Array<{ setting: string; reason: string }> {
    return this.ignoredSettings.map((entry) => ({ ...entry }));
  }

  /** Whether this node currently hears from a majority. True when not accounted for. */
  private hasQuorum(): boolean {
    return this.watchdog?.hasQuorum() ?? true;
  }

  /**
   * Check if this node is the Raft leader, **and** whether it can still serve.
   *
   * raft-core 0.2.1 has no check-quorum: an isolated leader reports `isLeader() ===
   * true` indefinitely (measured: still true at 16 s with the commit index frozen).
   * A caller routing by this method would keep sending work to a node that cannot
   * commit it, and learn that one request timeout later. So leadership is answered
   * from the role *and* from contact with a majority.
   */
  async isLeader(): Promise<boolean> {
    if (this._forceLeader) return true;
    if (!this.node) return false;
    try {
      // Awaited rather than tested: raft-core answers with a boolean, but anything
      // wrapping it may answer with a promise, and a promise is always truthy -- the
      // difference between "not the leader" and "asked the wrong question".
      if (!(await this.node.isLeader())) return false;
      return this.hasQuorum();
    } catch {
      return false;
    }
  }

  /**
   * Install the seam around `transport` and, when quorum accounting is possible,
   * the observer inside it. Returns the object raft-core must be constructed with.
   */
  private attachTransport(transport: Transport, peerIds: readonly number[], windowMs: number): Transport {
    const members = [...new Set(peerIds.filter((peer) => peer !== this.config.id))];
    if (this.config.checkQuorum === false || members.length === 0) {
      // No member list means no arithmetic: a shared-transport group keeps its
      // members in another manager, so claiming to judge its quorum would be a guess.
      // It keeps today's behaviour and says so through getQuorumHealth() === null.
      this.transportProxy = new SwappableTransport(transport);
      return this.transportProxy;
    }
    this.watchdog = new QuorumWatchdog({ selfId: this.config.id, peers: members, windowMs });
    this.observer = new ObservedTransport(transport, (peer) => this.watchdog?.observe(peer));
    this.transportProxy = new SwappableTransport(this.observer);
    return this.transportProxy;
  }

  /**
   * Keep exactly one observer in the chain: reuse the one inside `next` when it is
   * there, otherwise install a new one outside it.
   */
  private wrapForObservation(next: Transport | null): Transport | null {
    if (next === null || !this.observer) return next;
    for (let cursor: Transport | null = next; cursor; cursor = underlyingOf(cursor)) {
      if (cursor === this.observer) return next;
    }
    this.observer = new ObservedTransport(next, (peer) => this.watchdog?.observe(peer));
    return this.observer;
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
      const id = Number(leaderId);
      // A leader that can no longer hear a majority does not know who leads: it may
      // have been replaced by a term it has not seen yet. Naming itself would be the
      // claim this whole mechanism exists to stop making.
      if (id === this.config.id && !this.hasQuorum()) return null;
      return id;
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
   * How many entries the Raft log still holds, i.e. how much a restart must replay.
   *
   * This is the authoritative measure of bounded log growth: a healthy node
   * compacts its log on snapshot, so the retained count stays near the snapshot
   * threshold instead of growing with the total number of committed entries. It
   * intentionally differs from physical file size, which is sensitive to SQLite
   * WAL freelist layout and does not shrink on DELETE-based compaction.
   *
   * Counted from the log itself (`firstIndex .. lastIndex` inclusive), not from
   * `lastLog - applied`: those two are equal only while a node is idle, because the
   * apply loop keeps `applied` one step behind the head. The previous formula
   * therefore reported `0` or `1` for a node whose log held six hundred entries, and
   * every "the log stays bounded" assertion built on it passed without measuring.
   */
  async getRetainedLogLength(): Promise<number> {
    const logManager = (
      this.node as unknown as {
        logManager?: { getFirstIndex?: () => number; getLastIndex?: () => number };
      } | null
    )?.logManager;
    if (
      !logManager ||
      typeof logManager.getFirstIndex !== 'function' ||
      typeof logManager.getLastIndex !== 'function'
    ) {
      return 0;
    }
    try {
      const first = logManager.getFirstIndex();
      const last = logManager.getLastIndex();
      // An empty log reports first=1, last=0 (and a compacted one starts above 1).
      return last < first ? 0 : last - first + 1;
    } catch {
      return 0;
    }
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
   * Stop the node: Raft first, then the transport, then storage.
   *
   * Returns a promise, and the ordering is why it has to. Every step was
   * fire-and-forget, so `stop()` returned while raft-core was still flushing the
   * log, the listening socket was still bound, and the SQLite handle was being
   * closed under a running node. A node that is stopped and immediately started
   * again — the normal shape of a restart, and what `TestCluster.restartNode`
   * does — then races its own previous incarnation for the port, and the loser
   * comes up unable to receive anything. Awaiting is source-compatible: a caller
   * that ignores the promise behaves exactly as before.
   *
   * Storage passed in through `config.storage` is *not* closed: this adapter did
   * not create it, and a caller may hand the same storage to more than one
   * group. Closing it here would pull the database out from under its owner,
   * while a storage this adapter opened from `storagePath` must be closed or the
   * process leaks a native handle it can never reach again.
   */
  async stop(): Promise<void> {
    await this.releaseResources();
  }

  /**
   * Tear down everything `init` built, in reverse order of construction.
   *
   * Shared by `stop()` and by `init`'s own failure path. An `init` that threw
   * halfway used to leave the storage handle, the TLS listener and the timers
   * running with no reference held by any caller: nothing in the public API
   * suggested a cleanup was owed, so the correct usage leaked. Releasing on the
   * way out makes a failed `init` a no-op instead of a trap.
   */
  private async releaseResources(): Promise<void> {
    const node = this.node;
    this.node = null;
    if (node) {
      try {
        await node.stop();
      } catch (err: unknown) {
        logger.warn({ err }, '[RaftAdapter] Error stopping RaftNode');
      }
    }

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try {
        await transport.stop();
      } catch (err) {
        console.warn('[RaftAdapter] Transport stop failed:', err);
      }
    }

    // The seam and its evidence belong to the node that was just torn down. Keeping
    // them would let a restart inherit the previous incarnation's contacts and answer
    // `isLeader()` from a quorum that no longer exists.
    this.transportProxy = null;
    this.rawTransport = null;
    this.observer = null;
    this.watchdog?.reset();
    this.watchdog = null;

    const original = this.originalTcpTransport;
    this.originalTcpTransport = null;
    // The batched wrapper owns the underlying transport; the reference is taken
    // before the field is cleared so this only runs when they are different
    // objects.
    if (original && (original as unknown) !== this.rawTransport) {
      try {
        await original.stop();
      } catch (err) {
        console.warn('[RaftAdapter] Original TCP transport stop failed:', err);
      }
    }

    const storage = this.sqliteStorage;
    const ownsStorage = this._ownsStorage;
    this.sqliteStorage = null;
    this._ownsStorage = false;
    if (storage && ownsStorage) {
      try {
        storage.close();
      } catch (err) {
        console.warn('[RaftAdapter] SQLite storage close failed:', err);
      }
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
   * Peers this node currently holds a live connection to.
   *
   * The counterpart of `getConnectedPeers()` on the transport, exposed at the
   * node level because "which peers can I actually reach" is the first question
   * about a cluster that is not converging, and reaching into the transport from
   * outside is not possible through the published surface.
   */
  getConnectedPeers(): number[] {
    type PeerReporter = { getConnectedPeers?: () => Array<number | { peerId: number }> };
    // `BatchedRaftTransport` is a request-response wrapper: it owns the framing but
    // not the sockets, so the live connection table belongs to the transport it wraps.
    // Asking only the outer object reports "no peers" on a perfectly healthy node,
    // which is exactly the wrong signal when diagnosing a restarted node that is not
    // catching up. The walk is a loop rather than a single hop because the chain now
    // has more than one layer — the seam, the quorum observer, any injector a test
    // installed — and the answer belongs to the layer that owns the sockets.
    for (let cursor: Transport | null = this.transport; cursor; cursor = underlyingOf(cursor)) {
      const reporter = cursor as unknown as PeerReporter;
      if (typeof reporter.getConnectedPeers !== 'function') continue;
      return reporter.getConnectedPeers().map((peer) => (typeof peer === 'number' ? peer : peer.peerId));
    }
    return [];
  }

  /**
   * What the transport has done per peer: sent, answered, timed out, failed.
   *
   * The leader's own `{next, match}` cannot distinguish a peer that answers "no"
   * from one that never answers — both leave the pair where it was. These counters
   * can, and they are the difference between a bug in the protocol and a bug in the
   * link. Walks the wrapper chain for the same reason {@link getConnectedPeers}
   * does: the object that owns the sockets is the innermost one.
   */
  getTransportStats(): Record<string, { sent: number; answered: number; timedOut: number; failed: number }> {
    for (let cursor: Transport | null = this.transport; cursor; cursor = underlyingOf(cursor)) {
      const reporter = cursor as unknown as {
        getStats?: () => Record<string, { sent: number; answered: number; timedOut: number; failed: number }>;
      };
      if (typeof reporter.getStats !== 'function') continue;
      try {
        return reporter.getStats();
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * How far each peer is replicated, as this node's leader state sees it.
   *
   * Returns an empty object on a follower (it holds no per-peer view) and on any
   * node whose raft-core internals do not expose one. `match` is the highest
   * index the peer is known to have, `next` the index the leader will send next;
   * when `next` stays pinned at or below the leader's snapshot index while `match`
   * does not move, the follower is stuck in snapshot transfer — which looks
   * exactly like a healthy-but-slow follower from the follower's own side.
   */
  async getPeerProgress(): Promise<Record<number, { next: number; match: number }>> {
    const leaderState = (
      this.node as unknown as {
        stateMachine?: {
          leaderState?: { snapshot?: () => Map<string, { nextIndex: number; matchIndex: number }> } | null;
        };
      } | null
    )?.stateMachine?.leaderState;
    if (!leaderState || typeof leaderState.snapshot !== 'function') return {};
    try {
      const out: Record<number, { next: number; match: number }> = {};
      for (const [peer, progress] of leaderState.snapshot()) {
        out[Number(peer)] = { next: progress.nextIndex, match: progress.matchIndex };
      }
      return out;
    } catch {
      return {};
    }
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
