/**
 * FederationManager — Top-level orchestrator for cross-DC replication.
 *
 * Owns the full lifecycle:
 *   1. MultiLeaderReplication — cross-DC write replication
 *   2. CDCManager — change data capture for event streaming (MA1-MA5)
 *   3. DCSplitBrainDetector — detects and recovers from DC split-brain (MA6-MA9)
 *   4. ConflictResolver — resolves write conflicts on the replication hot path
 *   5. AntiEntropy — Merkle tree reconciliation for eventual consistency
 *   6. HealthMonitor — periodic health checks + lag tracking
 *
 * The replicate() method is now the write hot path:
 *   conflict resolution → outbox → replication → CDC event
 *
 * Consumers (sqlvec-db, graphvec-db) register via registerConsumer() to:
 *   - Receive replicated entries for local Raft proposal
 *   - Provide HLC for timestamp attachment
 *   - Receive conflict resolution notifications
 */

import type { IMultiLeaderReplication, ReplicationConfig } from '../interfaces/replication/IMultiLeaderReplication';
import type { ICDCManager } from '../interfaces/replication/ICDCManager';
import type { IAntiEntropy } from '../interfaces/replication/IAntiEntropy';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { IOutboxStore } from '../interfaces/outbox/IOutboxStore';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC, makeHLC } from '../hlc/HLC';
import { HealthMonitor, type FederationHealth, type HealthMonitorConfig } from '../monitoring/HealthMonitor';
import { CDCManager, type CDCEvent } from './CDCManager';
import { DCSplitBrainDetector, type SplitBrainEvent } from './DCSplitBrainDetector';
import { ConflictResolver, type ConflictValue, type ConflictStrategy } from '../replication/ConflictResolver';
import { AntiEntropy } from '../replication/AntiEntropy';
import { DedupRing } from '../replication/DedupRing';
import { buildAckFrame, CDC_ACK_TYPE } from '../replication/cdcAck';
import { IncarnationLedger } from '../replication/epoch';
import type { EpochStatus } from '../replication/epoch';
import { deriveRetention, type RetentionWindows } from '../storage/retention';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { DataEntry, DataProvider } from '../replication/AntiEntropy';
import { EventEmitter } from 'events';

// ── Interfaces (defined here for Phase 2, will move to separate files) ──

export interface ReplicatedEntry {
  /**
   * Config key the entry belongs to.
   *
   * Without it a consumer can only re-propose an opaque payload and the
   * receiving DC cannot reconstruct which key the value applies to — the
   * inbound apply path is key-scoped (dedup, conflict resolution, local store).
   */
  key: string;
  /** The raw data payload */
  data: string;
  /** Message type */
  type: string;
  /** Source DC */
  sourceDc: string;
  /** Source node */
  sourceNodeId: string;
  /** HLC timestamp for causal ordering */
  hlcTimestamp: IHLCTimestamp;
}

/**
 * What became of an inbound frame.
 *
 * Six facts, not one boolean. `applied` and `duplicate` both mean "this node holds
 * the value"; `superseded` means it deliberately kept its own; `declined` means a
 * consumer could not put it into the local cluster; `malformed` means it could not
 * be read; `not-a-change` means the frame was a confirmation addressed to another
 * component; and `stale-epoch` means it came from an incarnation of the sender
 * that this node has already moved past.
 */
export type InboundOutcome =
  'applied' | 'duplicate' | 'superseded' | 'malformed' | 'declined' | 'not-a-change' | 'stale-epoch';

export interface ConflictEntry {
  /** The key that had a conflict */
  key: string;
  /** Local value */
  localValue: string;
  /** Remote value */
  remoteValue: string;
  /** Local HLC timestamp */
  localHlc: IHLCTimestamp;
  /** Remote HLC timestamp */
  remoteHlc: IHLCTimestamp;
  /** Source DC */
  sourceDc: string;
}

export interface IFederationConsumer {
  /** Propose a replicated entry back into the local Raft cluster */
  proposeReplicated(entry: ReplicatedEntry): Promise<void>;
  /** Get the local HLC instance for timestamp attachment */
  getHLC(): HLC;
  /** Notify of a conflict that needs resolution */
  onConflict(conflict: ConflictEntry): Promise<void>;
}

// ── FederationManager ──────────────────────────

export interface FederationManagerConfig {
  /** Node ID */
  nodeId: string;
  /** Data center / region */
  dc: string;
  /** Replication config (targets, topology) */
  replicationConfig: ReplicationConfig;
  /** Transport layer (must be started and connected) */
  transport: ITransport;
  /** Outbox store for crash-safe persistence */
  outbox: IOutboxStore;
  /** HLC instance (optional — created if not provided) */
  hlc?: HLC;
  /** Health monitor config (optional) */
  healthConfig?: HealthMonitorConfig;
  /**
   * How often to revive dead letters whose target is reachable. Default 5 000.
   * `0` disables the scan.
   *
   * A dead letter is not a tombstone. The retry window decides when the store
   * stops trying an entry on its own; this scan decides when to try it again,
   * and it is the only thing that does — `OutboxStore.retryDeadLetter(id)`
   * existed with no production caller. Reviving only for a reachable target is
   * what makes the scan a retry policy instead of a spin: the revived entry
   * gets a fresh window, so a permanently failing target costs one attempt per
   * window rather than one per scan.
   */
  dlqScanIntervalMs?: number;
  /**
   * How often to prune delivered and dead-lettered entries past their TTL.
   * Default 60 000. `0` disables pruning.
   *
   * This is the only place an outbox entry is deleted for good, and it used to
   * run nowhere outside the test suite.
   */
  outboxHousekeepingIntervalMs?: number;
  /**
   * How long this side remembers a `msgId` it has already applied.
   * Default: the package default, 30 minutes.
   *
   * The ring is the receiver's half of at-least-once delivery, and its length is
   * not a tuning preference: a retry that arrives after the ring has forgotten
   * the id is a second change. The sender's budget is therefore read from the
   * replication and a window shorter than it is refused in the constructor.
   */
  dedupWindowMs?: number;
}

export class FederationManager {
  private readonly config: FederationManagerConfig;
  private readonly hlc: HLC;
  private readonly healthMonitor: HealthMonitor;
  private readonly emitter = new EventEmitter();
  private consumers: IFederationConsumer[] = [];
  /** Reason the most recent inbound apply failed, for diagnostics. */
  private _lastInboundError: string | null = null;
  /** Reason the most recent confirmation could not be sent, for diagnostics. */
  private _lastAckError: string | null = null;
  private _started = false;

  // Multi-Active production components
  private _cdcManager: CDCManager | null = null;
  private _splitBrainDetector: DCSplitBrainDetector | null = null;
  private _conflictResolver: ConflictResolver | null = null;
  private _antiEntropy: AntiEntropy | null = null;

  /**
   * The windows this side runs with, derived once from the sender's budget.
   *
   * Kept so `getRetention()` reports the window the ring was actually built
   * with, rather than a second copy of the number that can drift from it.
   */
  private readonly retention: RetentionWindows;

  /**
   * Receiver-side dedup. Transport delivery is at-least-once, so the same
   * message id can arrive more than once (retry, reconnect, anti-entropy).
   */
  private readonly dedup: DedupRing;

  /**
   * Which incarnation of each peer this node has heard from.
   *
   * The dedup ring answers "have I applied this id"; the ledger answers "should I
   * be listening to this sender at all". They are different questions with
   * different lifetimes: a stale frame's id is one this node may well have
   * applied, and releasing it as a duplicate would confirm the resurrection.
   */
  private readonly ledger = new IncarnationLedger();
  private _unsubInbound: (() => void) | null = null;
  private _unsubRecovered: (() => void) | null = null;
  private _dlqScanTimer: ReturnType<typeof setInterval> | null = null;
  private _housekeepingTimer: ReturnType<typeof setInterval> | null = null;

  // Local key-value store for AntiEntropy (MA10-MA12)
  private readonly localStore = new Map<
    string,
    {
      key: string;
      value: string;
      hlc: { wallTime: number; logical: number; nodeId: string };
      nodeId: string;
    }
  >();

  constructor(
    private readonly replication: IMultiLeaderReplication,
    config: FederationManagerConfig,
  ) {
    this.config = config;
    // The sender's budget is the replication's, not ours: it is the component
    // that retries. Ask it, then refuse a ring that would forget an id while the
    // sender can still repeat it — in the constructor, before `start()` wires a
    // single timer around a window that cannot hold what it must hold.
    this.retention = deriveRetention({
      ...replication.getRetention(),
      dedupMs: config.dedupWindowMs,
    });
    this.dedup = new DedupRing({
      maxCapacity: 100_000,
      ttlMs: this.retention.dedupMs,
    });
    this.hlc = config.hlc ?? new HLC(config.nodeId);
    this.healthMonitor = new HealthMonitor(replication, config.healthConfig);
  }

  /**
   * Start the federation manager.
   * Initializes all sub-systems:
   *   1. MultiLeaderReplication (outbox workers per target)
   *   2. CDCManager (change data capture)
   *   3. DCSplitBrainDetector (heartbeat-based split-brain detection)
   *   4. ConflictResolver (LWW + CRDT strategies)
   *   5. AntiEntropy (Merkle tree reconciliation)
   *   6. HealthMonitor (periodic health checks)
   */
  async start(): Promise<void> {
    if (this._started) return;

    // 1. Start replication engine
    await this.replication.start(this.config.replicationConfig);

    // 2. Start CDC Manager
    this._cdcManager = new CDCManager({
      nodeId: this.config.nodeId,
    });
    await this._cdcManager.start();

    // 3. Start Split-Brain Detector
    this._splitBrainDetector = new DCSplitBrainDetector({
      nodeId: this.config.nodeId,
      dcId: this.config.dc,
      hlc: this.hlc,
    });
    this._splitBrainDetector.start();

    // 4. Initialize ConflictResolver
    this._conflictResolver = new ConflictResolver(this.config.nodeId);

    // 5. Start AntiEntropy with data provider
    this._antiEntropy = new AntiEntropy(
      { nodeId: this.config.nodeId, merkleDepth: 4, intervalMs: 5000 },
      this.buildDataProvider(this.localStore, this.config.nodeId),
      this._conflictResolver,
    );

    // 6. Start HealthMonitor
    this.healthMonitor.start();

    // Listen for split-brain events
    this._splitBrainDetector.onSplitBrainDetected((event: SplitBrainEvent) => {
      this.emitter.emit('split-brain-detected', event);
    });

    // 7. Wire the receive path: without it, inbound replication frames were
    // delivered by the transport but never applied — cross-DC sync was
    // send-only. Delivery is at-least-once, so dedup by message id first.
    this._unsubInbound = this.config.transport.onMessage((msg) => {
      // Inbound frames are fire-and-forget, but a rejection must not become an
      // unhandled promise rejection (which terminates the process on Node >=15).
      // Record it instead so the operator can inspect the failure.
      //
      // A confirmation is not a change: `applyInbound` says so with
      // `not-a-change` and answers nothing, which is what stops two nodes from
      // acknowledging each other's acknowledgements for ever.
      void this.applyInbound(msg).catch((err: unknown) => {
        this._lastInboundError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      });
    });

    // 8. Revive dead letters and prune expired entries.
    //
    // Both timers exist because neither task had a production caller: the
    // dead letter queue was reachable only through a per-entry method, and the
    // TTL prune only through the test suite. A queue that nothing drains and
    // nothing prunes is storage growth in one direction and permanent data
    // loss in the other.
    this._unsubRecovered = this.replication.onTargetRecovered((targetNodeId) => {
      this.emitter.emit('target-recovered', targetNodeId);
      // The link is back; the entries written off while it was down are the
      // first thing worth retrying.
      void this.scanDeadLetters().catch(() => undefined);
    });

    const dlqScanIntervalMs = this.config.dlqScanIntervalMs ?? 5_000;
    if (dlqScanIntervalMs > 0) {
      this._dlqScanTimer = setInterval(() => {
        void this.scanDeadLetters().catch(() => undefined);
      }, dlqScanIntervalMs);
      this._dlqScanTimer.unref?.();
    }

    const housekeepingIntervalMs = this.config.outboxHousekeepingIntervalMs ?? 60_000;
    if (housekeepingIntervalMs > 0) {
      this._housekeepingTimer = setInterval(() => {
        try {
          const removed = this.config.outbox.housekeeping();
          if (removed.delivered > 0 || removed.deadLettered > 0) {
            this.emitter.emit('outbox-pruned', removed);
          }
        } catch (err: unknown) {
          this._lastInboundError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
      }, housekeepingIntervalMs);
      this._housekeepingTimer.unref?.();
    }

    this._started = true;
  }

  /**
   * Revive the dead letters of every target that is reachable right now.
   *
   * Public because an operator who has just brought a datacenter back should
   * not have to wait for the next tick of a timer to find out whether anything
   * came back. Returns the number of entries revived, per target.
   */
  async scanDeadLetters(): Promise<Record<string, number>> {
    const revived: Record<string, number> = {};
    if (this.config.outbox.getDeadLetterEntries().length === 0) return revived;

    for (const target of this.config.replicationConfig.targets) {
      if (!this.replication.isPeerReachable(target.nodeId)) continue;
      const count = await this.replication.retryFailed(target.nodeId);
      if (count > 0) revived[target.nodeId] = count;
    }

    if (Object.keys(revived).length > 0) this.emitter.emit('dead-letters-revived', revived);
    return revived;
  }

  /**
   * Apply a replication frame received from a peer DC, and answer it.
   *
   * Ordering: dedup by message id → decode envelope → resolve conflict with
   * the local value (LWW by HLC by default) → persist to the local store →
   * notify consumers so they can propose the entry into their own Raft group →
   * confirm to the sender.
   *
   * The confirmation is the point of the last step. `ITransport.send()` resolving
   * `true` is a statement about this node's socket, so a sender that retires an
   * outbox entry on it reports a delivery this node never made — the measured
   * shape was twenty changes reported delivered, thirteen applied, no refusal and
   * no dead letter. The answer is sent after the local write and after every
   * consumer has proposed, because that is the moment after which a retry would
   * add nothing.
   *
   * @returns `applied`, `duplicate`, `superseded` (remote lost the conflict),
   *   `malformed` when the frame cannot be decoded, `declined` when a consumer
   *   could not propose it into the local cluster, or `not-a-change` when the
   *   frame is a confirmation for another component.
   */
  async applyInbound(msg: InboundMessage): Promise<InboundOutcome> {
    // A confirmation is not a change. Answering one would start a conversation
    // between two nodes that never ends.
    if (msg.type === CDC_ACK_TYPE) return 'not-a-change';

    if (!msg.messageId) {
      // Nothing to answer: the id *is* what a confirmation is matched by.
      this._lastInboundError = 'inbound frame has no message id, so it cannot be answered';
      return 'malformed';
    }

    // Before dedup, and before the payload is even looked at. A frame from an
    // incarnation this node has moved past is not a change: it carries a world
    // the rebuild has already replaced, and applying it is how a deleted key comes
    // back. The id is *not* remembered either — the ring would then answer a later
    // frame from the current incarnation as a duplicate of one from the old.
    const epochVerdict = this.ledger.assess(msg.sourcePeerId, msg.sourceEpoch);
    if (epochVerdict === 'stale') {
      this._lastInboundError = this.ledger.refusalFor(msg.sourcePeerId, msg.sourceEpoch as number);
      // Refused on the wire, not dropped: the sender is the only party that can
      // stop retrying, and a frame that vanishes teaches it nothing.
      await this.answer(msg, this._lastInboundError);
      return 'stale-epoch';
    }

    if (this.dedup.contains(msg.messageId)) {
      // Applied earlier — by this node, so the sender may stop retrying. Answered
      // rather than dropped: this is the retry the sender is waiting to hear about.
      await this.answer(msg);
      return 'duplicate';
    }
    this.dedup.put(msg.messageId);

    const decoded = decodeEnvelope(msg.payload, msg.type ?? 'replicate');
    if (!decoded) {
      // The id is released so the retry is judged on its own: a frame that is
      // merely unreadable *now* must not be reported as a duplicate by the ring.
      this.dedup.delete(msg.messageId);
      this._lastInboundError = `frame ${msg.messageId} is not a decodable replicate envelope`;
      await this.answer(msg, this._lastInboundError);
      return 'malformed';
    }

    const remoteValue: ConflictValue = {
      key: decoded.key,
      value: decoded.value,
      hlc: decoded.hlc ?? this.hlc.now(),
      nodeId: decoded.sourceNodeId,
    };

    const existing = this.localStore.get(decoded.key);
    if (existing && this._conflictResolver) {
      const local: ConflictValue = {
        key: decoded.key,
        value: existing.value,
        hlc: toConflictTimestamp(existing.hlc),
        nodeId: existing.nodeId,
      };
      const resolution = await this._conflictResolver.resolve(decoded.key, local, remoteValue);
      if (resolution.resolvedValue !== remoteValue.value) {
        // Local write won; the remote entry is stale. Confirmed rather than
        // refused: the conflict is settled, and a retry would settle it the same
        // way, so asking the sender to try again would only cost it its budget.
        await this.answer(msg);
        return 'superseded';
      }
    }

    this.localStore.set(decoded.key, {
      key: decoded.key,
      value: decoded.value,
      hlc: {
        wallTime: Number(remoteValue.hlc.wallTime),
        logical: remoteValue.hlc.logical,
        nodeId: remoteValue.hlc.nodeId,
      },
      nodeId: decoded.sourceNodeId,
    });

    this._splitBrainDetector?.recordApply();

    for (const consumer of this.consumers) {
      try {
        await consumer.proposeReplicated({
          key: decoded.key,
          data: decoded.value,
          type: decoded.type,
          sourceDc: decoded.sourceDc ?? 'unknown',
          sourceNodeId: decoded.sourceNodeId,
          hlcTimestamp: remoteValue.hlc,
        });
      } catch (err: unknown) {
        // The receiving cluster did not take the entry: no leader, this node is a
        // follower, or the proposal was rejected. The local converged store has
        // the value but the cluster does not, which is exactly the state a sender
        // must not be told was a delivery — so it is told the reason instead.
        //
        // The id leaves the dedup ring with the refusal, so the retry is applied
        // again rather than answered as a duplicate that never happened. This is
        // the defect the ring would otherwise create: a refusal followed by a
        // duplicate is a silent loss with two acknowledgements.
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.dedup.delete(msg.messageId);
        this._lastInboundError = reason;
        await this.answer(msg, reason);
        return 'declined';
      }
    }

    this.emitter.emit('replicated-entry', {
      key: decoded.key,
      value: decoded.value,
      messageId: msg.messageId,
      sourceNodeId: decoded.sourceNodeId,
    });

    await this.answer(msg);
    return 'applied';
  }

  /**
   * Confirm one inbound frame to the node that sent it.
   *
   * Never throws. The change has already been applied by the time this runs, and a
   * confirmation that cannot reach the wire is the sender's timeout to absorb —
   * turning it into a rejection here would report a failure to a caller whose work
   * succeeded, and `getLastAckError()` is the diagnostic that says so.
   */
  private async answer(inbound: InboundMessage, refusal?: string): Promise<void> {
    try {
      const frame = buildAckFrame(inbound, this.config.nodeId, this.hlc.now(), refusal);
      const sent = await this.config.transport.send(frame);
      this._lastAckError = sent ? null : `the transport refused the confirmation for ${inbound.messageId}`;
    } catch (err: unknown) {
      this._lastAckError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  /** Reason the most recent confirmation could not be sent, or null. */
  getLastAckError(): string | null {
    return this._lastAckError;
  }

  /**
   * Read the current converged value for a key (local writes + applied
   * inbound replication).
   */
  /** Reason the most recent inbound replication frame failed to apply. */
  getLastInboundError(): string | null {
    return this._lastInboundError;
  }

  /**
   * The incarnations this node has heard from, and what it has done about them.
   *
   * `self` is read from the transport rather than kept here: the number on the
   * wire and the number in this report have to be the same number, and a second
   * copy is a second thing that can be wrong.
   */
  getEpochStatus(): EpochStatus & { self: number | null } {
    return { self: this.config.transport.getEpoch?.() ?? null, ...this.ledger.getStatus() };
  }

  getLocalValue(key: string): string | undefined {
    return this.localStore.get(key)?.value;
  }

  /** Number of keys held in the local converged store. */
  getLocalStoreSize(): number {
    return this.localStore.size;
  }

  /**
   * Build the AntiEntropy DataProvider backed by the given local store.
   *
   * Extracted from `start()` so the four data-access closures are standalone
   * and independently testable units. The provider is intentionally
   * self-contained: it reads from and writes to a single `Map` keyed by entry
   * key. All functions are pure with respect to the store.
   */
  private buildDataProvider(localStore: Map<string, DataEntry>, nodeId: string): DataProvider {
    return {
      async getRange(start: string, end: string): Promise<DataEntry[]> {
        const entries: DataEntry[] = [];
        for (const [, e] of localStore) {
          if (e.key >= start && e.key <= end) {
            entries.push(e);
          }
        }
        return entries;
      },

      async getEntriesAfter(afterKey: string, limit: number): Promise<DataEntry[]> {
        const sorted = Array.from(localStore.values()).sort((a, b) => a.key.localeCompare(b.key));
        const idx = sorted.findIndex((e) => e.key > afterKey);
        // findIndex returns -1 when no entry is strictly greater than
        // afterKey; slice(-1, …) would incorrectly wrap around to the last
        // element, so we must bail out explicitly.
        if (idx === -1) return [];
        return sorted.slice(idx, idx + limit);
      },

      async get(key: string): Promise<DataEntry | null> {
        return localStore.get(key) ?? null;
      },

      async apply(key: string, value: string): Promise<void> {
        localStore.set(key, {
          key,
          value,
          hlc: { wallTime: Date.now(), logical: 0, nodeId },
          nodeId,
        });
      },
    };
  }

  /**
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    this._started = false;
    this._unsubInbound?.();
    this._unsubInbound = null;
    this._unsubRecovered?.();
    this._unsubRecovered = null;
    for (const timer of [this._dlqScanTimer, this._housekeepingTimer]) {
      if (timer) clearInterval(timer);
    }
    this._dlqScanTimer = null;
    this._housekeepingTimer = null;
    this.healthMonitor.stop();
    this._splitBrainDetector?.stop();
    await this._cdcManager?.stop();
    await this.replication.stop();
  }

  /**
   * Replicate data to all targets.
   * Hot path: conflict resolution → local store → outbox → CDC event.
   *
   * @param key — The data key for conflict resolution
   * @param value — The data to replicate
   * @param shardId — Target shard (optional, uses 0 if unspecified)
   * @param type — Operation type ("insert", "update", "delete", etc.)
   */
  async replicate(
    shardIdOrKey: number | string,
    valueOrData: string,
    type: string,
    remoteValue?: ConflictValue,
  ): Promise<{ msgId: string }> {
    // Default params when called with old signature (shardId, data, type)
    const key = typeof shardIdOrKey === 'string' ? shardIdOrKey : `key:${shardIdOrKey}:${Date.now()}`;
    const data = valueOrData;
    const shardId = typeof shardIdOrKey === 'number' ? shardIdOrKey : 0;

    // MA10: Conflict resolution on the write hot path.
    // `HLC.now()` already returns a full `IHLCTimestamp` (compare/serialize/
    // deserialize), so there is no need to hand-roll a redundant snapshot.
    const now = this.hlc.now();

    if (remoteValue && this._conflictResolver) {
      const local: ConflictValue = {
        key,
        value: data,
        hlc: now,
        nodeId: this.config.nodeId,
      };

      await this._conflictResolver.resolve(key, local, remoteValue);
      // Notify consumers of conflict
      for (const consumer of this.consumers) {
        await consumer.onConflict({
          key,
          localValue: local.value,
          remoteValue: remoteValue.value,
          localHlc: local.hlc,
          remoteHlc: remoteValue.hlc,
          sourceDc: remoteValue.nodeId,
        });
      }
    }

    // Store locally (for AntiEntropy)
    this.localStore.set(key, {
      key,
      value: data,
      hlc: {
        wallTime: Number(now.wallTime),
        logical: now.logical,
        nodeId: now.nodeId,
      },
      nodeId: this.config.nodeId,
    });

    // Record split-brain heartbeat
    this._splitBrainDetector?.recordApply();

    // Commit the write in the LOCAL cluster as well.
    //
    // `replicate()` is the write entry point for the whole federation stack, so
    // a local write must reach the local state machine, not just the local
    // replica map and the outbox. Without this the originating DC would ship a
    // value it never applied itself, and a single-DC read would see nothing.
    for (const consumer of this.consumers) {
      await consumer.proposeReplicated({
        key,
        data,
        type,
        sourceDc: this.config.dc,
        sourceNodeId: this.config.nodeId,
        hlcTimestamp: now,
      });
    }

    // Replicate via outbox. When a real key is supplied the payload carries a
    // self-describing envelope so the receiving DC can resolve conflicts on the
    // same key; the legacy numeric-shard call keeps the raw payload.
    const payload =
      typeof shardIdOrKey === 'string'
        ? encodeEnvelope({
            key,
            value: data,
            type,
            sourceNodeId: this.config.nodeId,
            sourceDc: this.config.dc,
            hlc: {
              wallTime: Number(now.wallTime),
              logical: now.logical,
              nodeId: now.nodeId,
            },
          })
        : data;
    const result = await this.replication.replicate(shardId, payload, type);

    // Capture CDC event (MA1-MA5)
    if (this._cdcManager?.isStarted()) {
      await this._cdcManager.capture({
        eventId: result.msgId,
        key,
        value: data,
        type: type as 'insert' | 'update' | 'delete',
        sourceNodeId: this.config.nodeId,
        sourceDc: this.config.dc,
        hlcTimestamp: {
          wallTime: Number(now.wallTime),
          logical: now.logical,
          nodeId: now.nodeId,
        },
        appliedAt: Date.now(),
      });
    }

    return result;
  }

  /**
   * Get the replication engine.
   */
  getReplication(): IMultiLeaderReplication {
    return this.replication;
  }

  /**
   * The retention windows this side runs with.
   *
   * The dedup window here is the one the ring was built with; the retry budget
   * is the sender's, read from the replication at construction. A caller that
   * needs both numbers to agree — a composition root wiring the outbox and the
   * manager — reads them from one place instead of restating one of them.
   */
  getRetention(): RetentionWindows {
    return { ...this.retention };
  }

  /**
   * Get the CDC manager.
   */
  getCDC(): CDCManager {
    if (!this._cdcManager) {
      throw new Error('CDCManager not started. Call start() first.');
    }
    return this._cdcManager;
  }

  /**
   * Get the split-brain detector.
   */
  getSplitBrainDetector(): DCSplitBrainDetector {
    if (!this._splitBrainDetector) {
      throw new Error('DCSplitBrainDetector not started. Call start() first.');
    }
    return this._splitBrainDetector;
  }

  /**
   * Get the conflict resolver.
   */
  getConflictResolver(): ConflictResolver {
    if (!this._conflictResolver) {
      throw new Error('ConflictResolver not initialized. Call start() first.');
    }
    return this._conflictResolver;
  }

  /**
   * Get the anti-entropy engine.
   */
  getAntiEntropy(): AntiEntropy {
    if (!this._antiEntropy) {
      throw new Error('AntiEntropy not started. Call start() first.');
    }
    return this._antiEntropy;
  }

  /**
   * Get current cluster health.
   */
  async getHealth(): Promise<FederationHealth> {
    return this.healthMonitor.check();
  }

  /**
   * Register a downstream consumer (sqlvec-db or graphvec-db adapter).
   */
  registerConsumer(consumer: IFederationConsumer): void {
    this.consumers.push(consumer);
  }

  /**
   * Get registered consumers.
   */
  getConsumers(): IFederationConsumer[] {
    return [...this.consumers];
  }

  /**
   * Get the local HLC instance.
   */
  getHLC(): HLC {
    return this.hlc;
  }

  /**
   * Check if the manager has started.
   */
  isStarted(): boolean {
    return this._started;
  }

  /**
   * Register a health change callback.
   */
  onHealthChange(callback: (health: FederationHealth) => void): () => void {
    return this.healthMonitor.onHealthChange(callback);
  }

  /**
   * Register a high-lag callback.
   */
  /**
   * Register a callback for a target that was failing and is delivering again.
   *
   * Re-emitted from the replication engine so a supervisor only has to hold
   * one object: the manager already owns the engine, the health monitor, the
   * split-brain detector and the anti-entropy sweep.
   */
  onTargetRecovered(callback: (targetNodeId: string) => void): () => void {
    this.emitter.on('target-recovered', callback);
    return () => {
      this.emitter.off('target-recovered', callback);
    };
  }

  onHighLag(callback: (targetNodeId: string, lagMs: number) => void): () => void {
    return this.healthMonitor.onHighLag(callback);
  }

  /**
   * Register a split-brain detection callback.
   */
  onSplitBrainDetected(callback: (event: SplitBrainEvent) => void): () => void {
    this.emitter.on('split-brain-detected', callback);
    return () => {
      this.emitter.off('split-brain-detected', callback);
    };
  }

  /**
   * Get the local key-value store for AntiEntropy reconciliation.
   */
  getLocalStore(): Map<
    string,
    {
      key: string;
      value: string;
      hlc: { wallTime: number; logical: number; nodeId: string };
    }
  > {
    return this.localStore;
  }
}

// ── Wire envelope ──────────────────────────────────────────

/**
 * Replication payload envelope.
 *
 * The value alone is not enough for the receiver: conflict resolution needs the
 * key, and causal ordering needs the source HLC. The envelope is versioned so
 * older peers sending a raw payload still decode (see {@link decodeEnvelope}).
 */
export interface ReplicationEnvelope {
  /** Envelope marker + version, e.g. `"fb1"`. */
  __fb: 'fb1';
  key: string;
  value: string;
  type: string;
  sourceNodeId: string;
  sourceDc: string;
  hlc: { wallTime: number; logical: number; nodeId: string };
}

export function encodeEnvelope(envelope: Omit<ReplicationEnvelope, '__fb'>): string {
  return JSON.stringify({
    __fb: 'fb1',
    ...envelope,
  } satisfies ReplicationEnvelope);
}

export function decodeEnvelope(
  payload: Uint8Array,
  fallbackType: string,
): {
  key: string;
  value: string;
  type: string;
  sourceNodeId: string;
  sourceDc?: string;
  hlc?: IHLCTimestamp;
} | null {
  if (payload.byteLength === 0) return null;

  const text = new TextDecoder().decode(payload);

  // Legacy frame: a bare value with no envelope (older producers).
  if (!text.startsWith('{"__fb"')) {
    return {
      key: `legacy:${hash32(text)}`,
      value: text,
      type: fallbackType,
      sourceNodeId: 'unknown',
    };
  }

  try {
    const parsed = JSON.parse(text) as ReplicationEnvelope;
    if (parsed.__fb !== 'fb1' || typeof parsed.key !== 'string' || typeof parsed.value !== 'string') {
      return null;
    }
    return {
      key: parsed.key,
      value: parsed.value,
      type: parsed.type,
      sourceNodeId: parsed.sourceNodeId,
      sourceDc: parsed.sourceDc,
      hlc: makeHLC(BigInt(parsed.hlc.wallTime), parsed.hlc.logical, parsed.hlc.nodeId),
    };
  } catch {
    return null;
  }
}

/** Stable 32-bit hash used to key legacy (key-less) frames. */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function toConflictTimestamp(hlc: { wallTime: number; logical: number; nodeId: string }): IHLCTimestamp {
  return makeHLC(BigInt(hlc.wallTime), hlc.logical, hlc.nodeId);
}
