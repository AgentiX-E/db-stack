/**
 * PITRManager — Point-in-Time Recovery engine.
 *
 * Enables time-travel restore for any shard:
 *   1. Take periodic base snapshots (checkpoint)
 *   2. Record all WAL entries after each checkpoint
 *   3. Restore: load nearest snapshot + replay WAL to target timestamp
 *
 * Key properties:
 *   - Recovery Point Objective (RPO): configurable checkpoint interval
 *   - Recovery Time Objective (RTO): linear in WAL entry count
 *   - Snapshot compression: optional gzip for large snapshots
 *   - Retention: configurable max age / max count of snapshots + WAL segments
 */

import { IPITRHook } from '../interfaces/IPITRHook';
import * as crypto from 'crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// ── Types ──────────────────────────────────────────────────

/** A PITR checkpoint: a base snapshot + WAL entries since checkpoint. */
export interface PITRCheckpoint {
  checkpointId: string;
  shardId: string;
  snapshotIndex: number;
  snapshotTerm: number;
  snapshotData: Buffer;
  timestamp: number; // epoch ms
  compressed: boolean;
}

export interface PITRConfig {
  /** How often to create a new checkpoint (ms). Default: 5min */
  checkpointIntervalMs: number;
  /** Maximum number of checkpoints to retain per shard. Default: 10 */
  maxCheckpoints: number;
  /** Maximum age of checkpoints before rotation (ms). Default: 1 hour */
  maxCheckpointAgeMs: number;
  /** Whether to compress snapshots with gzip. Default: false */
  compressSnapshots: boolean;
}

export interface PITRRestoreResult {
  shardId: string;
  targetTimestamp: number;
  usedCheckpointId: string;
  usedCheckpointTimestamp: number;
  walEntriesReplayed: number;
  restoredData: string;
  rtoMs: number;
}

export interface WALEntry {
  entryId: string;
  shardId: string;
  index: number;
  term: number;
  data: string;
  timestamp: number;
}

// ── Default Config ─────────────────────────────────────────

const DEFAULT_CONFIG: PITRConfig = {
  checkpointIntervalMs: 5 * 60 * 1000, // 5 minutes
  maxCheckpoints: 10,
  maxCheckpointAgeMs: 60 * 60 * 1000, // 1 hour
  compressSnapshots: false,
};

// ── PITRManager Implementation ─────────────────────────────

export class PITRManager {
  private config: PITRConfig;
  private checkpoints = new Map<string, PITRCheckpoint[]>(); // shardId → checkpoints
  private walEntries = new Map<string, WALEntry[]>(); // shardId → WAL entries
  private lastCheckpointTime = new Map<string, number>(); // shardId → epoch ms
  private enabled = false;
  /**
   * What compression actually saved, per shard.
   *
   * Measured at the moment the checkpoint is written, because that is the only
   * moment both numbers exist: the snapshot before it was stored and the stream
   * after. A ratio computed later would have to decompress to find out, which is
   * the work the setting exists to avoid.
   */
  private compression = new Map<string, { checkpoints: number; uncompressedBytes: number; compressedBytes: number }>();

  constructor(config: Partial<PITRConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Enable PITR for the given shard. Must be called before record/checkpoint. */
  enable(shardId: string): void {
    if (!this.checkpoints.has(shardId)) {
      this.checkpoints.set(shardId, []);
    }
    if (!this.walEntries.has(shardId)) {
      this.walEntries.set(shardId, []);
    }
    if (!this.lastCheckpointTime.has(shardId)) {
      this.lastCheckpointTime.set(shardId, 0);
    }
    this.enabled = true;
  }

  /** Disable PITR for a shard and clean up stored data. */
  disable(shardId: string): void {
    this.checkpoints.delete(shardId);
    this.walEntries.delete(shardId);
    this.lastCheckpointTime.delete(shardId);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Recording ────────────────────────────────────────────

  /**
   * Record a WAL entry for future replay.
   * Called by the Raft state machine on each apply.
   */
  recordWAL(entry: WALEntry): void {
    const entries = this.walEntries.get(entry.shardId);
    if (!entries) return; // PITR not enabled for this shard

    entries.push({
      ...entry,
      timestamp: entry.timestamp || Date.now(),
    });

    // No auto-checkpoint here: a checkpoint is a synchronous copy of the whole
    // state machine, and doing it inside the apply path would put that copy in
    // front of every write. The interval is honoured by the caller that owns the
    // clock — an empty `if` here used to look like it did.
    // Enforce WAL retention
    this.enforceWALRetention(entry.shardId);
  }

  /** Bulk record for batch processing. */
  recordWALBatch(entries: WALEntry[]): void {
    for (const entry of entries) {
      this.recordWAL(entry);
    }
  }

  // ── Checkpointing ────────────────────────────────────────

  /**
   * Create a checkpoint for a shard.
   * @param shardId — The shard to checkpoint
   * @param snapshotIndex — Current applied index
   * @param snapshotTerm — Current term
   * @param snapshotData — Current state machine data
   */
  createCheckpoint(shardId: string, snapshotIndex: number, snapshotTerm: number, snapshotData: Buffer): PITRCheckpoint {
    // The bytes that go on disk, and the measurement of what they cost.
    const stored = this.config.compressSnapshots ? this.compressSnapshot(snapshotData) : Buffer.from(snapshotData);
    const tally = this.compression.get(shardId) ?? {
      checkpoints: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
    };
    tally.checkpoints += 1;
    tally.uncompressedBytes += snapshotData.length;
    tally.compressedBytes += stored.length;
    this.compression.set(shardId, tally);

    const checkpoint: PITRCheckpoint = {
      checkpointId: this.generateCheckpointId(shardId),
      shardId,
      snapshotIndex,
      snapshotTerm,
      snapshotData: stored,
      timestamp: Date.now(),
      compressed: this.config.compressSnapshots,
    };

    const checkpoints = this.checkpoints.get(shardId) ?? [];
    checkpoints.push(checkpoint);
    this.checkpoints.set(shardId, checkpoints);
    this.lastCheckpointTime.set(shardId, Date.now());

    // Rotate: trim WAL entries before this checkpoint's index
    this.trimWALBeforeIndex(shardId, snapshotIndex);

    // Enforce max checkpoints
    this.enforceCheckpointRetention(shardId);

    return checkpoint;
  }

  // ── Restore ──────────────────────────────────────────────

  /**
   * Restore a shard to the state at the given target timestamp.
   *
   * Algorithm:
   *   1. Find the nearest checkpoint BEFORE the target timestamp
   *   2. Load the checkpoint's snapshot data
   *   3. Replay all WAL entries from checkpoint index → target timestamp
   *   4. Return the restored state
   *
   * @param shardId — The shard to restore
   * @param targetTimestamp — Epoch ms timestamp to restore to
   * @returns Restore result with restored data and metadata
   */
  async restore(shardId: string, targetTimestamp: number): Promise<PITRRestoreResult> {
    const startTime = Date.now();

    const checkpoints = this.checkpoints.get(shardId) ?? [];
    if (checkpoints.length === 0) {
      throw new Error(`No checkpoints available for shard ${shardId}. ` + `Cannot perform PITR restore.`);
    }

    // 1. Find nearest checkpoint ≤ targetTimestamp
    const checkpoint = this.findNearestCheckpoint(checkpoints, targetTimestamp);
    if (!checkpoint) {
      throw new Error(
        `No checkpoint found before timestamp ${targetTimestamp} ` +
          `for shard ${shardId}. The earliest checkpoint is at ` +
          `${new Date(checkpoints[0]!.timestamp).toISOString()}.`,
      );
    }

    // 2. Load snapshot data (decompress if needed)
    let restoredData = checkpoint.compressed
      ? this.decompressSnapshot(checkpoint.snapshotData)
      : checkpoint.snapshotData.toString();

    // 3. Replay WAL entries from checkpoint → targetTimestamp
    const walEntries = this.walEntries.get(shardId) ?? [];
    const entriesToReplay = walEntries.filter(
      (e) => e.timestamp > checkpoint.timestamp && e.timestamp <= targetTimestamp,
    );

    for (const entry of entriesToReplay) {
      restoredData = this.applyWALEntry(restoredData, entry);
    }

    const rtoMs = Date.now() - startTime;

    return {
      shardId,
      targetTimestamp,
      usedCheckpointId: checkpoint.checkpointId,
      usedCheckpointTimestamp: checkpoint.timestamp,
      walEntriesReplayed: entriesToReplay.length,
      restoredData,
      rtoMs,
    };
  }

  // ── Query ────────────────────────────────────────────────

  /** Get all checkpoints for a shard, newest first. */
  getCheckpoints(shardId: string): PITRCheckpoint[] {
    const cps = this.checkpoints.get(shardId) ?? [];
    return [...cps].sort((a, b) => {
      const tsDiff = b.timestamp - a.timestamp;
      if (tsDiff !== 0) return tsDiff;
      // Tiebreak: newer snapshotIndex first
      return b.snapshotIndex - a.snapshotIndex;
    });
  }

  /** Get the number of WAL entries since the last checkpoint. */
  getWALCountSinceLastCheckpoint(shardId: string): number {
    const checkpoints = this.checkpoints.get(shardId) ?? [];
    const entries = this.walEntries.get(shardId) ?? [];
    if (checkpoints.length === 0) return entries.length;

    const latestCheckpointIdx = Math.max(...checkpoints.map((c) => c.snapshotIndex));
    return entries.filter((e) => e.index > latestCheckpointIdx).length;
  }

  /** Get total WAL entries for a shard. */
  getWALCount(shardId: string): number {
    return (this.walEntries.get(shardId) ?? []).length;
  }

  /** Estimate the RPO (time since last checkpoint in ms). */
  getRPO(shardId: string): number {
    const lastTime = this.lastCheckpointTime.get(shardId) ?? 0;
    return lastTime > 0 ? Date.now() - lastTime : 0;
  }

  // ── Internal ─────────────────────────────────────────────

  private generateCheckpointId(shardId: string): string {
    const rand = crypto.randomBytes(8).toString('hex');
    return `ckpt-${shardId}-${Date.now()}-${rand}`;
  }

  /**
   * Find the checkpoint with the highest timestamp that is ≤ target.
   * Binary search on sorted (by timestamp) checkpoints.
   */
  private findNearestCheckpoint(checkpoints: PITRCheckpoint[], targetTimestamp: number): PITRCheckpoint | null {
    // Checkpoints are stored in insertion order, sort by timestamp
    const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);

    let best: PITRCheckpoint | null = null;
    for (const cp of sorted) {
      if (cp.timestamp <= targetTimestamp) {
        best = cp;
      } else {
        break; // Sorted — all subsequent are > target
      }
    }
    return best;
  }

  /** Truncate WAL entries before the given Raft index. */
  private trimWALBeforeIndex(shardId: string, snapshotIndex: number): void {
    const entries = this.walEntries.get(shardId);
    if (!entries) return;
    this.walEntries.set(
      shardId,
      entries.filter((e) => e.index > snapshotIndex),
    );
  }

  /** Enforce max WAL entry retention. */
  private enforceWALRetention(shardId: string): void {
    const entries = this.walEntries.get(shardId);
    if (!entries) return;

    const cutoff = Date.now() - this.config.maxCheckpointAgeMs;
    this.walEntries.set(
      shardId,
      entries.filter((e) => e.timestamp > cutoff),
    );
  }

  /** Enforce max checkpoint count. */
  private enforceCheckpointRetention(shardId: string): void {
    const checkpoints = this.checkpoints.get(shardId);
    if (!checkpoints || checkpoints.length <= this.config.maxCheckpoints) return;

    // Sort oldest-first, drop excess
    const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);
    this.checkpoints.set(shardId, sorted.slice(sorted.length - this.config.maxCheckpoints));
  }

  /**
   * Apply a WAL entry to restored data.
   * Simple key=value newline format for the state machine data.
   */
  private applyWALEntry(currentData: string, entry: WALEntry): string {
    // Strip the entryId prefix and apply the mutation
    const lines = currentData.split('\n').filter(Boolean);
    const updated = new Map<string, string>();

    for (const line of lines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        updated.set(line.slice(0, eqIdx), line.slice(eqIdx + 1));
      }
    }

    // Apply this entry's data as a key=value pair or deletion
    if (entry.data.startsWith('DELETE:')) {
      updated.delete(entry.data.slice(7));
    } else if (entry.data.includes('=')) {
      const eqIdx = entry.data.indexOf('=');
      updated.set(entry.data.slice(0, eqIdx), entry.data.slice(eqIdx + 1));
    }

    return [...updated.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
  }

  /**
   * Compress a snapshot for storage.
   *
   * gzip, because the setting says "gzip" and because the one property an
   * operator turns it on for is that the checkpoint is smaller than the snapshot.
   * This used to return `Buffer.from(data)`: the flag was set, the bytes were
   * not touched, and every round-trip test passed because the matching
   * "decompressor" was the identity too.
   */
  private compressSnapshot(data: Buffer): Buffer {
    return gzipSync(data);
  }

  /**
   * Decompress a checkpoint, refusing a stream that is not one.
   *
   * A truncated or corrupt checkpoint has to fail here rather than return
   * whatever `toString()` makes of it: a restore that lands on a half-written
   * snapshot is a restore that reports success and loses rows.
   */
  private decompressSnapshot(data: Buffer): string {
    try {
      return gunzipSync(data).toString();
    } catch (error) {
      throw new Error(
        `PITR checkpoint stream is not a readable gzip stream (${data.length} bytes): ` + `${(error as Error).message}`,
      );
    }
  }

  /**
   * What compression saved for a shard.
   *
   * `ratio` is compressed bytes over snapshot bytes: below 1 is a saving, 1 is
   * none, and a shard with no checkpoints has nothing to compare.
   */
  getCompressionStats(shardId: string): {
    checkpoints: number;
    uncompressedBytes: number;
    compressedBytes: number;
    ratio: number;
  } {
    const tally = this.compression.get(shardId);
    if (!tally || tally.uncompressedBytes === 0) {
      return {
        checkpoints: tally?.checkpoints ?? 0,
        uncompressedBytes: tally?.uncompressedBytes ?? 0,
        compressedBytes: tally?.compressedBytes ?? 0,
        ratio: 1,
      };
    }
    return { ...tally, ratio: tally.compressedBytes / tally.uncompressedBytes };
  }

  // ── Cleanup ──────────────────────────────────────────────

  /** Reset all PITR state (for testing). */
  reset(): void {
    this.checkpoints.clear();
    this.walEntries.clear();
    this.lastCheckpointTime.clear();
    this.compression.clear();
    this.enabled = false;
  }
}
