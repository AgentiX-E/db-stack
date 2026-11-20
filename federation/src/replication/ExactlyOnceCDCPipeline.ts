/**
 * ExactlyOnceCDCPipeline — Production-grade Exactly-Once Change Data Capture.
 *
 * Design (streaming exactly-once semantics):
 *
 *   [CDCEngine] ──(LSN-ordered)──→ [OutboxStore] ──(adapter)──→ [Transport]
 *                                         ↑                         ↓
 *                                   [CheckpointManager]      [DedupRing (rw)]
 *                                         ↑                    ↓ ack/noop
 *                                   [Durable LSN state]    [Consumer callback]
 *
 * Guarantees:
 *   G1 — Each LSN is processed at least once (OutboxStore persistence)
 *   G2 — Each LSN is delivered at most once (DedupRing on receiver)
 *   G3 — No gaps: LSN checkpoint is monotonic and crash-recoverable
 *   G4 — Durable ack: consumer confirms before checkpoint advances
 *   G5 — Backpressure via pending queue depth threshold
 *
 * CheckpointManager — Durable LSN tracking:
 *   - Stores last-confirmed LSN per shard/table
 *   - Persisted via simple JSON file (LMDB would be overkill for single-value)
 *   - On restart, resumes from last checkpoint
 *   - Atomic write: write to .tmp, fsync, rename
 *
 * Flow:
 *   1. CDC change arrives (via appendChange or WAL decoder callback)
 *   2. Pipeline appends to OutboxStore with unique msgId = `lsn:txId`
 *   3. Outbox pump picks up pending entries in FIFO order
 *   4. For each entry:
 *      a. Serialize → TransportMessage
 *      b. Send via ITransport
 *      c. On acknowledgment: OutboxStore.markDelivered()
 *      d. Advance checkpoint to this LSN
 *   5. Receiver side:
 *      a. DedupRing.contains(msgId) — skip if duplicate
 *      b. If not duplicate: deliver to consumer callback
 *      c. DedupRing.put(msgId) — mark seen
 *      d. Send ACK back
 *
 * Recovery:
 *   - Sender restarts: OutboxStore.fetchOldestPending() → retry
 *   - Receiver restarts: DedupRing is empty (TTL-based), but OutboxStore
 *     on sender side knows which were delivered via markDelivered
 *   - Crash mid-send: entry stays pending → retry →
 *     receiver sees duplicate via DedupRing → noop → ACK
 */

import { CDCEngine, type CDCEngineConfig } from './CDCEngine';
import { OutboxStore, type OutboxStoreConfig } from '../storage/OutboxStore';
import { DedupRing } from './DedupRing';
import { HLC } from '../hlc/HLC';
import * as fs from 'fs';
import * as path from 'path';
import type { ITransport } from '../interfaces/transport/ITransport';
import type { ICDCEngine, CDCChangeEvent } from '../interfaces/replication/ICDCManager';
import { compareLsn, parseLsn } from '../interfaces/replication/IChangeLogReader';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

// ── Constants ──────────────────────────────────────────────

/** Prefix of the `TransportMessage.type` this pipeline stamps on a CDC frame */
const CDC_TYPE_PREFIX = 'cdc_event:';

// ── Types ──────────────────────────────────────────────────

export interface ExactlyOnceCDCPipelineConfig {
  /** Node identity */
  nodeId: string;
  /** CDC engine config (HLsC, nodeId) */
  cdcConfig: CDCEngineConfig;
  /**
   * The engine whose changes this pipeline persists and ships.
   *
   * Optional only for compatibility: when absent the pipeline builds a
   * `CDCEngine`, the simulator. That default was the *only* option — the field
   * was hardcoded, so a pipeline could not be driven by a real WAL reader even
   * though every class around it took its dependencies as parameters. A
   * deployment passes a `WalTailCDCEngine` here and the rest of the path is
   * unchanged.
   */
  engine?: ICDCEngine;
  /** OutboxStore config */
  outboxConfig: OutboxStoreConfig;
  /** DedupRing TTL (ms) for receiver-side dedup — default 600_000 (10 min) */
  dedupTtlMs?: number;
  /** Cross-DC transport (sender side) */
  transport?: ITransport;
  /** Target node/channel for transporting CDC events */
  remoteNodeId?: string;
  /** Checkpoint persistence dir (default: outboxConfig.dataDir) */
  checkpointDir?: string;
  /** Outbox pump interval (ms) — default 500 */
  pumpIntervalMs?: number;
  /** Max entries per pump cycle — default 100 */
  pumpBatchSize?: number;
  /** Max pending entries before backpressure kicks in — default 10_000 */
  maxPending?: number;
}

/** Resolved config with all optional fields filled with defaults. */
type ResolvedCDCPipelineConfig = {
  nodeId: string;
  cdcConfig: CDCEngineConfig;
  engine?: ICDCEngine;
  outboxConfig: OutboxStoreConfig;
  dedupTtlMs: number;
  transport?: ITransport;
  remoteNodeId?: string;
  checkpointDir: string;
  pumpIntervalMs: number;
  pumpBatchSize: number;
  maxPending: number;
};

export interface CDCCheckpoint {
  /** Shard/table name → last confirmed LSN */
  lastConfirmedLSN: Record<string, string>;
  /** Timestamp of last checkpoint */
  updatedAt: number;
  /** Version for forward compat */
  version: number;
}

export interface CDCPipelineMetrics {
  /** Total CDC events produced */
  totalProduced: number;
  /** Total events delivered (at least once) */
  totalDelivered: number;
  /** Total duplicates filtered (exactly once) */
  totalDeduped: number;
  /** Current pending outbox count */
  pendingCount: number;
  /**
   * Outbox entries this store has marked delivered, across restarts.
   *
   * The sender-side twin of `totalProduced`, and the only counter that can
   * balance it: `totalProduced` is process-scoped, while the outbox is durable,
   * so the identity `produced = pending + sent + deadLettered` needs a `sent`
   * that outlives the process too.
   */
  outboxDelivered: number;
  /** Last checkpoint LSN per table */
  checkpoints: Record<string, string>;
  /** Dead letter count */
  deadLetterCount: number;
  /** Pump active flag */
  pumpActive: boolean;
}

// ── Events ─────────────────────────────────────────────────

export type CDCPipelineEventType =
  | 'event_produced'
  | 'event_delivered'
  | 'event_deduped'
  | 'event_failed'
  | 'checkpoint_advanced'
  | 'backpressure'
  | 'pump_error';

export interface CDCPipelineEvent {
  type: CDCPipelineEventType;
  lsn?: string;
  tableName?: string;
  msgId?: string;
  error?: string;
  timestamp: number;
}

export type CDCPipelineEventHandler = (event: CDCPipelineEvent) => void;

// ── Implementation ─────────────────────────────────────────

export class ExactlyOnceCDCPipeline {
  private readonly cdc: ICDCEngine;
  private readonly outbox: OutboxStore;
  private readonly dedup: DedupRing;
  private readonly config: ResolvedCDCPipelineConfig;
  private readonly checkpointPath: string;

  /** Event listeners */
  private readonly eventListeners = new Set<CDCPipelineEventHandler>();

  /**
   * The checkpoint, in memory.
   *
   * `getCheckpoint()` used to `readFileSync` and `JSON.parse` on every call —
   * and `advanceCheckpoint` calls it once per delivered entry, so a pipeline
   * delivering 5 000 changes a second parsed the same small JSON 5 000 times,
   * and threw `ENOENT` if the file was removed underneath it. The file is the
   * durable copy; this object is the working one, refreshed by `start()` and
   * written by `flushCheckpoint()`.
   */
  private checkpoint: CDCCheckpoint = { lastConfirmedLSN: {}, updatedAt: 0, version: 1 };

  /**
   * Whether `loadCheckpoint()` has read (or created) the file yet.
   *
   * `stop()` flushes the working copy, and a pipeline whose `start()` was refused
   * never read one: stopping it wrote the empty default over the file that caused
   * the refusal. That is the same "replay from the beginning" decision this class
   * refuses to make at start, taken through the back door when a caller cleans up
   * after catching the refusal.
   */
  private checkpointLoaded = false;

  /** Pump state */
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private pumpActive = false;

  /** Metrics */
  private totalProduced = 0;
  private totalDelivered = 0;
  private totalDeduped = 0;

  /**
   * The tail of the outbox-append chain.
   *
   * `outbox.add()` is asynchronous, and a CDC engine delivers a batch of events
   * in one synchronous pass. Firing one `add()` per event without awaiting them
   * let their LMDB write transactions settle in whatever order the microtask
   * queue produced — and the outbox's *insertion order is the send order*, so
   * the peer applied changes out of the log's order. The acceptance run that
   * found this had `0/0000000A` arrive before `0/00000002`.
   *
   * The chain keeps `onChange` synchronous (the engine's listener contract) and
   * the appends ordered (the log's contract).
   */
  private appendChain: Promise<void> = Promise.resolve();

  /** Why the last append failed, or null. Visible so a refusal is not silent. */
  private lastAppendError: string | null = null;

  // ── Constructor ──────────────────────────────────────────

  constructor(config: ExactlyOnceCDCPipelineConfig) {
    // Field by field, not `{ ...defaults, ...config }`. An optional field may be
    // passed explicitly as `undefined`, and the spread would then overwrite the
    // default with it: `dedupTtlMs: undefined` reaches `new DedupRing({ ttlMs })`
    // and the ring stops expiring, with no error anywhere.
    this.config = {
      nodeId: config.nodeId,
      cdcConfig: config.cdcConfig,
      engine: config.engine,
      outboxConfig: config.outboxConfig,
      dedupTtlMs: config.dedupTtlMs ?? 600_000,
      transport: config.transport,
      remoteNodeId: config.remoteNodeId,
      checkpointDir: config.checkpointDir ?? config.outboxConfig.dataDir,
      pumpIntervalMs: config.pumpIntervalMs ?? 500,
      pumpBatchSize: config.pumpBatchSize ?? 100,
      maxPending: config.maxPending ?? 10_000,
    };

    this.cdc = this.config.engine ?? new CDCEngine(this.config.cdcConfig);
    this.outbox = new OutboxStore(this.config.outboxConfig);
    this.dedup = new DedupRing({ ttlMs: this.config.dedupTtlMs });

    this.checkpointPath = path.join(this.config.checkpointDir, 'cdc-checkpoint.json');
  }

  // ── Lifecycle ────────────────────────────────────────────

  async start(): Promise<void> {
    // Load checkpoint from disk (G3: crash-recoverable)
    this.loadCheckpoint();

    // Wire CDC engine → outbox (G1: at-least-once persistence)
    this.cdc.onChange((event: CDCChangeEvent) => {
      this.onCDCEvent(event);
    });

    // Start CDC engine
    await this.cdc.start();

    // Start outbox pump
    this.startPump();

    this.emit('checkpoint_advanced', {
      type: 'checkpoint_advanced',
      timestamp: Date.now(),
      lsn: Object.values(this.checkpoint.lastConfirmedLSN).join(',') || undefined,
    });
  }

  async stop(): Promise<void> {
    this.stopPump();
    await this.cdc.stop();
    // A graceful stop waits for the appends already accepted from the engine:
    // dropping them would lose changes the log still reports as produced.
    await this.appendChain;
    if (this.checkpointLoaded) this.flushCheckpoint();
  }

  // ── CDC control (delegated) ──────────────────────────────

  watchTable(tableName: string): void {
    this.cdc.watchTable(tableName);
  }

  unwatchTable(tableName: string): void {
    this.cdc.unwatchTable(tableName);
  }

  getWatchedTables(): string[] {
    return this.cdc.getWatchedTables();
  }

  /**
   * Simulate a change on the configured engine.
   *
   * Only the simulator has this method. A pipeline wired to a real log refuses
   * here rather than silently appending to a stream nothing reads: the whole
   * point of the injection point above is that the changes come from the log,
   * and a test hook that still worked would let a deployment believe it had
   * one.
   */
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent {
    const engine = this.cdc;
    if (!isSimulatedEngine(engine)) {
      throw new Error(
        'appendChange is a test hook of CDCEngine; this pipeline is wired to a ' +
          `read end (${engine.constructor.name}) and its changes come from the log`,
      );
    }
    return engine.appendChange(change);
  }

  // ── Dedup (receiver side) ────────────────────────────────

  /**
   * Process an inbound CDC transport message.
   * Returns true if the message was accepted (first-time delivery),
   * false if it was a duplicate (exactly-once guarantee).
   *
   * G2 — At-most-once delivery via DedupRing
   */
  processInbound(message: TransportMessage): {
    accepted: boolean;
    event?: CDCChangeEvent;
  } {
    const msgId = message.messageId;

    // G2: Check dedup before delivery
    if (this.dedup.contains(msgId)) {
      this.totalDeduped++;
      this.emit('event_deduped', {
        type: 'event_deduped',
        msgId,
        timestamp: Date.now(),
      });
      return { accepted: false };
    }

    // Mark as seen (before processing: crash-during-delivery = noop on retry)
    this.dedup.put(msgId);

    // Decode CDC event from payload
    try {
      const decoder = new TextDecoder();
      const event = JSON.parse(decoder.decode(message.payload)) as CDCChangeEvent;

      this.emit('event_delivered', {
        type: 'event_delivered',
        lsn: event.lsn,
        msgId,
        timestamp: Date.now(),
      });

      this.totalDelivered++;
      return { accepted: true, event };
    } catch (err) {
      // Payload is not a valid CDCChangeEvent
      this.emit('event_failed', {
        type: 'event_failed',
        error: `Failed to decode CDC payload: ${describeError(err)}`,
        msgId,
        timestamp: Date.now(),
      });
      return { accepted: false };
    }
  }

  // ── Checkpoint (G3: crash-recoverable LSN) ───────────────

  /**
   * Advance the checkpoint for a table to the given LSN.
   * G4: advance checkpoint after consumer confirms.
   *
   * Positions are ordered by `comparePositions`, not by `<` on the strings.
   * The string comparison was right only while every low word stayed eight
   * hexadecimal digits wide: past `0/FFFFFFFF` the ninth digit makes
   * `"0/100000000" < "0/A0000000"` lexically and greater numerically, and a
   * stale position would then be accepted over a newer one — a checkpoint
   * that moves backwards is a replay, which is merely wasteful, or a skip,
   * which is not.
   */
  advanceCheckpoint(tableName: string, lsn: string): void {
    const current = this.checkpoint.lastConfirmedLSN[tableName];
    if (current !== undefined && comparePositions(lsn, current) <= 0) {
      return; // Non-monotonic: ignore stale checkpoint
    }

    this.checkpoint.lastConfirmedLSN[tableName] = lsn;
    this.checkpoint.updatedAt = Date.now();

    this.flushCheckpoint();

    this.emit('checkpoint_advanced', {
      type: 'checkpoint_advanced',
      lsn,
      tableName,
      timestamp: Date.now(),
    });
  }

  /**
   * The checkpoint as it stands, copied so a caller cannot mutate the working
   * state by accident.
   */
  getCheckpoint(): CDCCheckpoint {
    return {
      lastConfirmedLSN: { ...this.checkpoint.lastConfirmedLSN },
      updatedAt: this.checkpoint.updatedAt,
      version: this.checkpoint.version,
    };
  }

  /**
   * Get last confirmed LSN for a table (G3: resume from here on restart).
   */
  getLastConfirmedLSN(tableName: string): string | null {
    return this.checkpoint.lastConfirmedLSN[tableName] ?? null;
  }

  // ── Event handling ───────────────────────────────────────

  onEvent(handler: CDCPipelineEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => {
      this.eventListeners.delete(handler);
    };
  }

  private emit(
    type: CDCPipelineEventType,
    event: Omit<CDCPipelineEvent, 'type'> & { type: CDCPipelineEventType },
  ): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event as CDCPipelineEvent);
      } catch {
        // An observer that throws must not stop the pipeline: `emit` is called
        // from inside the outbox pump cycle and from `advanceCheckpoint`, so a
        // broken listener used to abort a batch mid-flight and then throw
        // again from the `pump_error` it raised, leaving an unhandled
        // rejection and a half-processed batch. The counters are the record.
      }
    }
  }

  // ── Metrics ──────────────────────────────────────────────

  async getMetrics(): Promise<CDCPipelineMetrics> {
    // Measured after every accepted append has landed, so a reader never sees
    // `produced` ahead of the outbox it is supposed to balance against.
    await this.appendChain;
    const stats = await this.outbox.getStats();
    return {
      totalProduced: this.totalProduced,
      totalDelivered: this.totalDelivered,
      totalDeduped: this.totalDeduped,
      pendingCount: stats.pendingCount,
      outboxDelivered: stats.deliveredCount,
      checkpoints: { ...this.checkpoint.lastConfirmedLSN },
      deadLetterCount: this.outbox.getDeadLetterStats().count,
      pumpActive: this.pumpActive,
    };
  }

  // ── Recovery helpers ─────────────────────────────────────

  /** Retry a dead-letter entry (operational intervention) */
  retryDeadLetter(entryId: string): boolean {
    return this.outbox.retryDeadLetter(entryId);
  }

  /** Why the outbox last refused an append, or null. */
  get appendError(): string | null {
    return this.lastAppendError;
  }

  /** Get dead letter entries for inspection */
  getDeadLetterEntries() {
    return this.outbox.getDeadLetterEntries();
  }

  /** Force a checkpoint flush */
  flushCheckpoint(cp?: CDCCheckpoint): void {
    const data = cp ?? this.checkpoint;
    // Atomic write: write to .tmp, fsync, rename (crash-safe).
    //
    // The descriptor is the one that was written, and it is closed. The
    // previous version wrote with `writeFileSync(path)` and then called
    // `fsyncSync(openSync(path, 'r'))` — a second descriptor, opened read-only,
    // never closed: one leaked file descriptor per checkpoint, and a fsync on a
    // handle whose write buffer was somebody else's.
    const tmpPath = `${this.checkpointPath}.tmp`;
    fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.checkpointPath);
    this.checkpoint = data;
  }

  // ── Internal: CDC event → outbox ─────────────────────────

  private onCDCEvent(event: CDCChangeEvent): void {
    // The dedup key: the log's position and the writer's transaction, which are
    // the same numbers on every replay of the same change.
    //
    // It has to travel as `msgId`, not as `id`. `OutboxStore.add()` assigns
    // `entry:<sequence>` as the id and *overwrites* whatever the caller passed,
    // so the old `id: msgId` was discarded: the transport shipped `entry:7`,
    // and the receiver's DedupRing deduplicated on a store-local counter. Two
    // consequences, both silent — a change replayed after a restart got a new
    // sequence and was applied twice, and two datacenters whose outboxes both
    // started at `entry:1` deduplicated against each other, dropping one of the
    // two regions' first change.
    const msgId = `${event.lsn}:${event.txId}`;

    this.appendChain = this.appendChain.then(async () => {
      try {
        const hlc = new HLC(this.config.nodeId);
        const encoder = new TextEncoder();
        await this.outbox.add({
          msgId,
          targetPeerIds: this.config.remoteNodeId ? [this.config.remoteNodeId] : [],
          payload: encoder.encode(
            JSON.stringify(event, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
          ),
          timestamp: hlc.now(),
          type: 'cdc_event',
        });

        // Counted after the entry exists. A counter incremented on the way in
        // would report a change that no outbox holds — a gap in the very
        // identity `pipelineConservation` checks.
        this.totalProduced += 1;
        this.emit('event_produced', {
          type: 'event_produced',
          lsn: event.lsn,
          tableName: event.tableName,
          msgId,
          timestamp: Date.now(),
        });
      } catch (error) {
        // The outbox refused the entry: the change is not shipped and nothing
        // will retry it, which is the one state this pipeline must never enter
        // quietly. It is not counted as produced (no outbox holds it), and the
        // reason is kept.
        this.lastAppendError = describeError(error);
        this.emit('event_failed', {
          type: 'event_failed',
          lsn: event.lsn,
          msgId,
          error: `outbox append failed: ${this.lastAppendError}`,
          timestamp: Date.now(),
        });
      }
    });
  }

  // ── Internal: Outbox pump ─────────────────────────────────

  private startPump(): void {
    if (this.pumpTimer) return;

    this.pumpTimer = setInterval(() => {
      this.pumpCycle();
    }, this.config.pumpIntervalMs);
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.pumpActive = false;
  }

  private async pumpCycle(): Promise<void> {
    if (this.pumpActive) return;
    this.pumpActive = true;

    try {
      const transport = this.config.transport;
      if (!transport) {
        this.pumpActive = false;
        return;
      }

      // G5: Backpressure if pending exceeds maxPending
      const pendingCount = await this.outbox.getPendingCount();
      if (pendingCount > this.config.maxPending) {
        this.emit('backpressure', {
          type: 'backpressure',
          error: `Pending count ${pendingCount} exceeds max ${this.config.maxPending}`,
          timestamp: Date.now(),
        });
      }

      // G1: Fetch oldest pending entries (FIFO order)
      const entries = await this.outbox.fetchOldestPending(this.config.pumpBatchSize);

      for (const entry of entries) {
        try {
          // Build transport message matching TransportMessage interface.
          //
          // The id is the *message* id when the caller supplied one — the
          // receiver deduplicates on it — and the store's local sequence only
          // as a fallback for entries written without one.
          const msg: TransportMessage = {
            messageId: messageIdOf(entry),
            sourcePeerId: this.config.nodeId,
            targetPeerId: this.config.remoteNodeId ?? '',
            payload: entry.payload,
            timestamp: entry.timestamp,
            createdAt: entry.createdAt,
            type: `${CDC_TYPE_PREFIX}${lsnOf(entry)}`,
          };

          // G1: Send — if transport fails, entry stays pending (retry)
          //
          // The refusal has to be acted on here. `send()` returns false when the
          // transport cannot reach the peer, and the previous code discarded
          // that answer and marked the entry delivered anyway — the one comment
          // in this file that promised at-least-once delivery sat directly above
          // the line that turned it into at-most-once. A refused entry now goes
          // to the catch below, which keeps it pending and retries it until the
          // outbox moves it to the dead-letter queue.
          const sent = await transport.send(msg);
          if (!sent) {
            throw new Error(`Transport refused message to ${msg.targetPeerId}`);
          }

          // G4: Mark delivered after successful transport
          await this.outbox.markDelivered(entry.id);

          // G3: Advance checkpoint — from the event's own LSN, decoded from the
          // payload. This read `entry.id.split(':')[0]`, and `entry.id` is
          // `entry:12`, so every checkpoint the pump wrote said `"entry"`: a
          // position that is not one, equal to itself for ever, and therefore
          // never advanced. `markDelivered` kept the outbox honest, but the
          // resume point a restart relies on was a constant string.
          try {
            const decoder = new TextDecoder();
            const event = JSON.parse(decoder.decode(entry.payload)) as CDCChangeEvent;
            this.advanceCheckpoint(event.tableName, event.lsn);
          } catch {
            // Skip checkpoint advance if payload can't be decoded
          }
        } catch (err) {
          const errorMsg = describeError(err);

          // Mark as failed — OutboxStore handles maxRetries → dead letter
          const movedToDLQ = this.outbox.markFailed(entry.id, errorMsg);

          this.emit('pump_error', {
            type: 'pump_error',
            error: errorMsg,
            msgId: messageIdOf(entry),
            lsn: lsnOf(entry),
            timestamp: Date.now(),
          });

          if (movedToDLQ) {
            this.emit('event_failed', {
              type: 'event_failed',
              error: `Moved to dead letter after max retries`,
              msgId: messageIdOf(entry),
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch (err) {
      this.emit('pump_error', {
        type: 'pump_error',
        error: describeError(err),
        timestamp: Date.now(),
      });
    } finally {
      this.pumpActive = false;
    }
  }

  private loadCheckpoint(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.checkpointPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // First run: create the default checkpoint, so a later flush has a
      // directory to rename into even if no change ever arrives.
      const defaultCheckpoint: CDCCheckpoint = {
        lastConfirmedLSN: {},
        updatedAt: Date.now(),
        version: 1,
      };
      fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
      this.checkpoint = defaultCheckpoint;
      this.writeCheckpointFile(defaultCheckpoint);
      this.checkpointLoaded = true;
      return;
    }

    this.checkpoint = ExactlyOnceCDCPipeline.parseCheckpoint(raw, this.checkpointPath);
    this.checkpointLoaded = true;
  }

  /**
   * The one definition of "a checkpoint this pipeline will start from".
   *
   * It was written twice — once in `loadCheckpoint`, once in `readCheckpoint` —
   * and the copies had already drifted: one refused a file that is not JSON with
   * a message naming the consequence, the other let `JSON.parse`'s own
   * `SyntaxError` out, and only the second sanitised a checkpoint whose
   * `updatedAt` or `version` is not a number. Two copies of a validation rule is
   * two answers to "may I start?", so `readCheckpoint` — the public door, the one
   * a deployment calls before it constructs an engine — is now the only one, and
   * `loadCheckpoint` walks through it.
   */
  private static parseCheckpoint(raw: string, file: string): CDCCheckpoint {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A checkpoint that exists and cannot be parsed is not "a first run".
      // Treating it as one would replay the whole log and report a healthy
      // pipeline, and the operator would learn about it from duplicated rows.
      throw new Error(
        `${file}: checkpoint is not JSON (${String(error)}); ` +
          `refusing to start — replaying from the beginning is a decision, not a default`,
      );
    }

    const candidate = parsed as Partial<CDCCheckpoint> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.lastConfirmedLSN !== 'object' ||
      candidate.lastConfirmedLSN === null
    ) {
      throw new Error(`${file}: checkpoint has no lastConfirmedLSN map`);
    }

    return {
      lastConfirmedLSN: { ...(candidate.lastConfirmedLSN as Record<string, string>) },
      // A checkpoint written by an older build, or edited by hand, may carry the
      // fields as strings. The map is the part that decides where the tail
      // resumes; the other two are bookkeeping, and refusing to start over them
      // would turn a cosmetic problem into an outage.
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
      version: typeof candidate.version === 'number' ? candidate.version : 1,
    };
  }

  /** Write a checkpoint file without touching the working copy. */
  private writeCheckpointFile(data: CDCCheckpoint): void {
    const tmpPath = `${this.checkpointPath}.tmp`;
    fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.checkpointPath);
  }

  /**
   * Read a checkpoint file without a pipeline.
   *
   * The resume point has to be known *before* the engine is constructed —
   * `WalTailCDCEngine.startAfterLsn` decides what the tail reads — and the
   * pipeline loads its own checkpoint only when it starts. This is the seam
   * that lets a deployment compose the two in the right order instead of
   * replaying the log on every boot and relying on deduplication to hide it.
   *
   * Returns null when there is no checkpoint yet. A file that exists and cannot
   * be parsed throws: the same decision `start()` makes, for the same reason.
   */
  static readCheckpoint(dir: string): CDCCheckpoint | null {
    const file = path.join(dir, 'cdc-checkpoint.json');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return ExactlyOnceCDCPipeline.parseCheckpoint(raw, file);
  }

  /**
   * The earliest position a checkpoint records, or null.
   *
   * A tail has one cursor and a checkpoint has one position per table, so the
   * two have to be reconciled. The *earliest* is the only safe answer: resuming
   * at the latest would skip every row of a table that is behind (its entries
   * are earlier in the log and would never be read again), while resuming at
   * the earliest re-reads rows that some tables have already shipped — and a
   * replay is exactly what the receiver's dedup ring exists to absorb. This is
   * the same trade the delivery contract makes: a duplicate is recoverable, a
   * gap is not.
   */
  static resumePosition(checkpoint: CDCCheckpoint | null): string | null {
    if (!checkpoint) return null;
    let earliest: string | null = null;
    for (const lsn of Object.values(checkpoint.lastConfirmedLSN)) {
      if (earliest === null || comparePositions(lsn, earliest) < 0) earliest = lsn;
    }
    return earliest;
  }

  /** Cleanup for tests */
  async cleanup(): Promise<void> {
    await this.stop();
    this.outbox.close();
    this.eventListeners.clear();
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Order two checkpoint positions.
 *
 * Numeric when both are `high/low` LSNs — the shape this package's own engines
 * and PostgreSQL produce — and lexical when neither is, because the checkpoint
 * API is public and a consumer may key it by whatever its own log assigns (a
 * Kafka offset, an integer sequence). A mix is refused: two positions that are
 * not the same kind of thing have no order, and guessing one would silently
 * move a checkpoint in a direction nobody chose.
 */
export function comparePositions(a: string, b: string): number {
  const aIsLsn = isHighLowLsn(a);
  const bIsLsn = isHighLowLsn(b);
  if (aIsLsn !== bIsLsn) {
    throw new Error(`cannot order "${a}" against "${b}": one is a high/low LSN and the other is not`);
  }
  if (aIsLsn) return compareLsn(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isHighLowLsn(value: string): boolean {
  try {
    parseLsn(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a thrown value for an event or a log line.
 *
 * Extracted because it appeared at four call sites, and four copies of one
 * decision are four branches: three of them could only ever see an `Error`,
 * because the only throw they could observe was a `SyntaxError` from
 * `JSON.parse`, so the `String(err)` arm was unreachable in three places and
 * reachable in none by a test. A port can reject with anything — a transport
 * that throws a string is a configuration this package accepts — and the
 * decision now lives in one place, where one case covers it for all four.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The id a receiver deduplicates on.
 *
 * Same reasoning as `describeError`: `entry.msgId ?? entry.id` was written out at
 * three call sites plus once inside `lsnOf`, and the fallback — an entry stored
 * by a producer that set no message id — is reachable only through the outbox,
 * so three of those four copies were untested. One function, one case.
 */
function messageIdOf(entry: { id: string; msgId?: string }): string {
  return entry.msgId ?? entry.id;
}

/**
 * The log position an outbox entry carries.
 *
 * The message id is `<lsn>:<txId>` when the producer set one; the store's own
 * `entry:<sequence>` is not a position and never was — `entry:12`.split(':')[0]
 * is `"entry"`, which is what the checkpoint used to record.
 *
 * An id with no separator is a position in a log that numbers its own records
 * (a Kafka offset, a monotonic counter), which the checkpoint API supports; the
 * whole id is the position there, not a prefix of it.
 */
function lsnOf(entry: { id: string; msgId?: string }): string {
  const source = messageIdOf(entry);
  const separator = source.indexOf(':');
  return separator > 0 ? source.slice(0, separator) : source;
}

/** True when the engine is the simulator, which is the only one with `appendChange`. */
export function isSimulatedEngine(engine: ICDCEngine): engine is CDCEngine {
  return engine instanceof CDCEngine;
}
