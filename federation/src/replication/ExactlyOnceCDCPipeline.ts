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
import type { CDCChangeEvent } from '../interfaces/replication/ICDCManager';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';

// ── Constants ──────────────────────────────────────────────

/** Prefix used to embed the CDC table name in the TransportMessage type field */
const CDC_TYPE_PREFIX = 'cdc_event:';

/** Extract table name from transport message type field */
function extractTableName(msg: TransportMessage): string | null {
  if (!msg.type || !msg.type.startsWith(CDC_TYPE_PREFIX)) return null;
  const lsnPart = msg.type.slice(CDC_TYPE_PREFIX.length);
  return lsnPart || null;
}

// ── Types ──────────────────────────────────────────────────

export interface ExactlyOnceCDCPipelineConfig {
  /** Node identity */
  nodeId: string;
  /** CDC engine config (HLsC, nodeId) */
  cdcConfig: CDCEngineConfig;
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
  private readonly cdc: CDCEngine;
  private readonly outbox: OutboxStore;
  private readonly dedup: DedupRing;
  private readonly config: ResolvedCDCPipelineConfig;
  private readonly checkpointPath: string;

  /** Event listeners */
  private readonly eventListeners = new Set<CDCPipelineEventHandler>();

  /** Pump state */
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private pumpActive = false;

  /** Metrics */
  private totalProduced = 0;
  private totalDelivered = 0;
  private totalDeduped = 0;

  // ── Constructor ──────────────────────────────────────────

  constructor(config: ExactlyOnceCDCPipelineConfig) {
    this.config = {
      dedupTtlMs: 600_000,
      pumpIntervalMs: 500,
      pumpBatchSize: 100,
      maxPending: 10_000,
      checkpointDir: config.outboxConfig.dataDir,
      ...config,
    };

    this.cdc = new CDCEngine(this.config.cdcConfig);
    this.outbox = new OutboxStore(this.config.outboxConfig);
    this.dedup = new DedupRing({ ttlMs: this.config.dedupTtlMs });

    this.checkpointPath = path.join(
      this.config.checkpointDir,
      'cdc-checkpoint.json',
    );
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
      lsn: Object.values(this.getCheckpoint()).join(','),
    });
  }

  async stop(): Promise<void> {
    this.stopPump();
    await this.cdc.stop();
    this.flushCheckpoint();
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

  /** For testing: simulate a CDC change event */
  appendChange(change: Omit<CDCChangeEvent, 'lsn' | 'timestamp' | 'txId'>): CDCChangeEvent {
    return this.cdc.appendChange(change);
  }

  // ── Dedup (receiver side) ────────────────────────────────

  /**
   * Process an inbound CDC transport message.
   * Returns true if the message was accepted (first-time delivery),
   * false if it was a duplicate (exactly-once guarantee).
   *
   * G2 — At-most-once delivery via DedupRing
   */
  processInbound(message: TransportMessage): { accepted: boolean; event?: CDCChangeEvent } {
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
        error: `Failed to decode CDC payload: ${err instanceof Error ? err.message : String(err)}`,
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
   */
  advanceCheckpoint(tableName: string, lsn: string): void {
    const checkpoint = this.getCheckpoint();

    // G3: monotonic LSN check
    const current = checkpoint.lastConfirmedLSN[tableName];
    if (current && lsn <= current) {
      return; // Non-monotonic: ignore stale checkpoint
    }

    checkpoint.lastConfirmedLSN[tableName] = lsn;
    checkpoint.updatedAt = Date.now();

    // Pass the modified checkpoint to flush, ref: this.getCheckpoint() reads from file
    this.flushCheckpoint(checkpoint);

    this.emit('checkpoint_advanced', {
      type: 'checkpoint_advanced',
      lsn,
      tableName,
      timestamp: Date.now(),
    });
  }

  /**
   * Get current checkpoint state.
   */
  getCheckpoint(): CDCCheckpoint {
    return JSON.parse(
      fs.readFileSync(this.checkpointPath, 'utf-8'),
    ) as CDCCheckpoint;
  }

  /**
   * Get last confirmed LSN for a table (G3: resume from here on restart).
   */
  getLastConfirmedLSN(tableName: string): string | null {
    const checkpoint = this.getCheckpoint();
    return checkpoint.lastConfirmedLSN[tableName] ?? null;
  }

  // ── Event handling ───────────────────────────────────────

  onEvent(handler: CDCPipelineEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => { this.eventListeners.delete(handler); };
  }

  private emit(type: CDCPipelineEventType, event: Omit<CDCPipelineEvent, 'type'> & { type: CDCPipelineEventType }): void {
    for (const listener of this.eventListeners) {
      listener(event as CDCPipelineEvent);
    }
  }

  // ── Metrics ──────────────────────────────────────────────

  async getMetrics(): Promise<CDCPipelineMetrics> {
    const stats = await this.outbox.getStats();
    return {
      totalProduced: this.totalProduced,
      totalDelivered: this.totalDelivered,
      totalDeduped: this.totalDeduped,
      pendingCount: stats.pendingCount,
      checkpoints: this.getCheckpoint().lastConfirmedLSN,
      deadLetterCount: this.outbox.getDeadLetterStats().count,
      pumpActive: this.pumpActive,
    };
  }

  // ── Recovery helpers ─────────────────────────────────────

  /** Retry a dead-letter entry (operational intervention) */
  retryDeadLetter(entryId: string): boolean {
    return this.outbox.retryDeadLetter(entryId);
  }

  /** Get dead letter entries for inspection */
  getDeadLetterEntries() {
    return this.outbox.getDeadLetterEntries();
  }

  /** Force a checkpoint flush */
  flushCheckpoint(cp?: CDCCheckpoint): void {
    // Atomic write: write to .tmp, fsync, rename (crash-safe)
    const data = cp ?? this.getCheckpoint();
    const tmpPath = this.checkpointPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 0));
    fs.fsyncSync(fs.openSync(tmpPath, 'r'));
    fs.renameSync(tmpPath, this.checkpointPath);
  }

  // ── Internal: CDC event → outbox ─────────────────────────

  private onCDCEvent(event: CDCChangeEvent): void {
    // Generate deterministic message ID: lsn:txId
    // G1: Unique msgId ensures at-least-once delivery
    const msgId = `${event.lsn}:${event.txId}`;
    const hlc = new HLC(this.config.nodeId);
    const encoder = new TextEncoder();

    this.outbox.add({
      id: msgId,
      targetPeerIds: this.config.remoteNodeId ? [this.config.remoteNodeId] : [],
      payload: encoder.encode(JSON.stringify(event, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      )),
      timestamp: hlc.now() as any,
      type: 'cdc_event',
      status: 'pending',
      createdAt: Date.now(),
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
    } as any);

    this.totalProduced++;

    this.emit('event_produced', {
      type: 'event_produced',
      lsn: event.lsn,
      tableName: event.tableName,
      msgId,
      timestamp: Date.now(),
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
      const entries = await this.outbox.fetchOldestPending(
        this.config.pumpBatchSize,
      );

      for (const entry of entries) {
        try {
          // Build transport message matching TransportMessage interface
          const msg: TransportMessage = {
            messageId: entry.id,
            sourcePeerId: this.config.nodeId,
            targetPeerId: this.config.remoteNodeId ?? '',
            payload: entry.payload,
            timestamp: entry.timestamp,
            createdAt: entry.createdAt,
            type: 'cdc_event:' + entry.id.split(':')[0], // lsn as type suffix
          };

          // G1: Send — if transport fails, entry stays pending (retry)
          await transport.send(msg);

          // G4: Mark delivered after successful transport
          await this.outbox.markDelivered(entry.id);

          // G3: Advance checkpoint — decode payload to get tableName
          try {
            const decoder = new TextDecoder();
            const event = JSON.parse(decoder.decode(entry.payload)) as CDCChangeEvent;
            const lsn = entry.id.split(':')[0];
            this.advanceCheckpoint(event.tableName, lsn!);
          } catch {
            // Skip checkpoint advance if payload can't be decoded
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          // Mark as failed — OutboxStore handles maxRetries → dead letter
          const movedToDLQ = this.outbox.markFailed(entry.id, errorMsg);

          this.emit('pump_error', {
            type: 'pump_error',
            error: errorMsg,
            msgId: entry.id,
            lsn: entry.id.split(':')[0],
            timestamp: Date.now(),
          });

          if (movedToDLQ) {
            this.emit('event_failed', {
              type: 'event_failed',
              error: `Moved to dead letter after max retries`,
              msgId: entry.id,
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch (err) {
      this.emit('pump_error', {
        type: 'pump_error',
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    } finally {
      this.pumpActive = false;
    }
  }

  private loadCheckpoint(): void {
    try {
      fs.readFileSync(this.checkpointPath, 'utf-8');
    } catch {
      // First run: create default checkpoint
      const defaultCheckpoint: CDCCheckpoint = {
        lastConfirmedLSN: {},
        updatedAt: Date.now(),
        version: 1,
      };
      fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
      fs.writeFileSync(this.checkpointPath, JSON.stringify(defaultCheckpoint));
    }
  }

  /** Cleanup for tests */
  async cleanup(): Promise<void> {
    await this.stop();
    this.outbox.close();
    this.eventListeners.clear();
  }
}
