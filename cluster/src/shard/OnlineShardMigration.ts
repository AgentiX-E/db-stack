/**
 * OnlineShardMigration — hot migration coordinator with zero-downtime cutover.
 *
 * A four-phase migration protocol:
 *   1. INITIAL SYNC — copy the shard, in version order, in batches
 *   2. INCREMENTAL SYNC — catch up everything written above the watermark the
 *      first pass reached, bounded by `finalSyncTimeoutMs`
 *   3. CUTOVER — optionally suspend writes, copy the remainder, and **verify**
 *      that the target holds as many entries as the source
 *   4. CLEANUP — the source is decommissioned by the caller
 *
 * The coordinator knows nothing about the database. Reads arrive through
 * {@link IShardMigrationSource} and writes through {@link IShardMigrationSink},
 * both of which a caller implements over its own engine; that is the whole of the
 * coupling, and it is why the same class migrates a key-value shard, a document
 * collection and a log-structured store.
 *
 * Everything this class reports is measured against the source. It used to be
 * measured against itself — `Math.random()` for the byte total, a random delta
 * for catch-up, a fixed 15 ms per batch — so `progress` advanced identically for
 * an empty shard and a full one, and the only thing a caller could conclude from
 * a completed migration was that the loop had ended. The observable now is the
 * one an operator needs: how many of the source's entries are on the target, and
 * whether the two counts agree when the migration says it is done.
 *
 * @module @agentix-e/db-cluster/shard
 */

import type {
  IMigrationConfig,
  IMigrationStatus,
  IOnlineShardMigration,
} from '../interfaces/shard/IOnlineShardMigration';
import type { IShardMigrationSink } from '../interfaces/shard/IShardMigrationSink';
import type { IShardMigrationSource, ShardScanEntry } from '../interfaces/shard/IShardMigrationSource';

// ── Migration State ─────────────────────────────────────────

type MigrationPhase = 'idle' | 'initial-sync' | 'incremental-sync' | 'cutover' | 'completed' | 'rolled-back' | 'failed';

interface MigrationState {
  migrationId: string;
  config: IMigrationConfig;
  phase: MigrationPhase;
  /** Entries applied on the target so far, by the coordinator's own count. */
  entriesCopied: number;
  /** Entries the source held when the current pass began. */
  entriesTotal: number;
  /** Bytes those entries occupy, by the source's measure. */
  bytesTotal: number;
  bytesCopied: number;
  /** Highest source version consumed. */
  caughtUpVersion: number;
  /**
   * The source's version when the migration began.
   *
   * The initial pass copies up to here and stops: everything above it arrived
   * while the copy was running, and belongs to the catch-up — which is bounded.
   * Without this watermark a shard under sustained writes makes the initial pass
   * unbounded, because every scan finds one more entry to copy.
   */
  snapshotVersion: number;
  startedAt: number;
  /** Set by `cutover()` and `rollback()`: stop scanning and go to the final pass. */
  stopRequested: boolean;
  /** Set by `cancel()`: unwind at the next checkpoint and do not cut over. */
  cancelRequested: boolean;
  /**
   * Whether the final pass ended because a scan came back empty.
   *
   * This, not a comparison against the source's current version, is what says the
   * shard stopped moving. A shard whose entries were deleted while it was being
   * copied has a current version above the watermark and nothing left to send; a
   * comparison would call that "behind" and refuse a migration that was complete.
   */
  quiesced: boolean;
  error?: string;
  /**
   * The run, so the control methods can wait for it and read the phase it settled
   * in. The outcome is returned rather than read off `state` afterwards because
   * TypeScript narrows `state.phase` at every earlier check and cannot see that
   * awaiting the run is what changes it.
   */
  run?: Promise<MigrationPhase>;
}

/** Thrown by the cancellation checkpoint; named so the run can report it verbatim. */
class MigrationCancelled extends Error {
  constructor() {
    super('cancelled by user');
    this.name = 'MigrationCancelled';
  }
}

let migrationSeq = 0;

function generateMigrationId(): string {
  migrationSeq++;
  return `migrate-${Date.now()}-${migrationSeq}`;
}

/** Progress from counted entries, capped below 100 until the conservation check passes. */
function progressOf(entriesCopied: number, entriesTotal: number): number {
  if (entriesTotal <= 0) return 0;
  return Math.min(99, Math.floor((entriesCopied / entriesTotal) * 100));
}

// ── OnlineShardMigration Implementation ────────────────────

export class OnlineShardMigration implements IOnlineShardMigration {
  private migrations = new Map<string, MigrationState>();
  private writeSuspended = new Set<string>(); // migrationIds with suspended writes

  /**
   * @param source the shard being copied — enumerated by version, read by key
   * @param sink the node that will own it — applied to, then counted
   */
  constructor(
    private readonly source: IShardMigrationSource,
    private readonly sink: IShardMigrationSink,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────

  async startMigration(config: IMigrationConfig): Promise<{ migrationId: string }> {
    // Validate
    if (config.sourceNode === config.targetNode) {
      throw new Error('source and target nodes must be different');
    }
    if (config.batchSize <= 0) {
      throw new Error('batchSize must be positive');
    }
    if (config.finalSyncTimeoutMs < 0) {
      throw new Error('finalSyncTimeoutMs must not be negative');
    }

    // The source is asked before the migration exists. A shard id no source knows
    // is a configuration error, and it is worth finding out before a migration is
    // registered that will fail on its first scan.
    const [initial, snapshotVersion] = await Promise.all([
      this.source.stats(config.shardId),
      this.source.currentVersion(config.shardId),
    ]);

    const migrationId = generateMigrationId();
    const state: MigrationState = {
      migrationId,
      config: { ...config },
      phase: 'initial-sync',
      entriesCopied: 0,
      entriesTotal: initial.entries,
      bytesTotal: initial.bytes,
      bytesCopied: 0,
      caughtUpVersion: 0,
      snapshotVersion,
      startedAt: Date.now(),
      stopRequested: false,
      cancelRequested: false,
      quiesced: false,
    };

    this.migrations.set(migrationId, state);

    state.run = this.runMigration(state);

    return { migrationId };
  }

  private async runMigration(state: MigrationState): Promise<MigrationPhase> {
    try {
      await this.copyFrom(state);
      await this.catchUp(state);
      await this.finalise(state);
    } catch (err) {
      state.phase = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      this.writeSuspended.delete(state.migrationId);
    }
    return state.phase;
  }

  /**
   * The cancellation checkpoint.
   *
   * A cancel has to stop the run *before* the final pass. Letting the run finish
   * and then relabelling it would copy the whole shard, cut over, and tell the
   * caller it was cancelled — three actions the caller asked not to happen.
   */
  private checkpoint(state: MigrationState): void {
    if (state.cancelRequested) throw new MigrationCancelled();
  }

  /**
   * Copy the shard in version order, up to the version it held when the
   * migration began.
   *
   * The watermark comes from the last entry of each batch rather than from an
   * offset: a shard that gains entries while the copy runs shifts every offset
   * after the insertion point, and a paged scan would then skip or repeat. A
   * version watermark is unaffected by concurrent writes — the new entries are
   * simply above it, and the catch-up pass is what collects them.
   *
   * The end of the initial pass is `snapshotVersion`, not "a scan came back
   * empty". A shard under sustained writes answers every scan with one more
   * entry, so "until empty" is a loop with no exit; the version the migration saw
   * at the start is the finite thing the first pass owes, and the deadline the
   * catch-up runs against is how the rest is accounted for.
   */
  private async copyFrom(state: MigrationState): Promise<number> {
    let watermark = 0;
    for (;;) {
      this.checkpoint(state);
      if (state.stopRequested || watermark >= state.snapshotVersion) return watermark;
      const batch = await this.source.scanEntries(state.config.shardId, watermark, state.config.batchSize);
      if (batch.length === 0) return watermark;
      await this.applyBatch(state, batch);
      watermark = batch[batch.length - 1]!.version;
      state.caughtUpVersion = watermark;
      state.phase = 'initial-sync';
    }
  }

  /**
   * Reconcile everything written above the initial pass's watermark.
   *
   * Bounded by `finalSyncTimeoutMs` on purpose. A shard under sustained write load
   * can be made to never quiesce, and a catch-up that cannot end is a migration
   * that never cuts over — the deadline is what turns "the target is behind" into
   * a number a caller can act on rather than a hang.
   */
  private async catchUp(state: MigrationState): Promise<void> {
    const deadline = Date.now() + state.config.finalSyncTimeoutMs;
    state.phase = 'incremental-sync';
    for (;;) {
      this.checkpoint(state);
      if (state.stopRequested) return;
      const batch = await this.source.scanEntries(state.config.shardId, state.caughtUpVersion, state.config.batchSize);
      if (batch.length === 0) return;
      await this.applyBatch(state, batch);
      state.caughtUpVersion = batch[batch.length - 1]!.version;
      if (Date.now() >= deadline) return;
    }
  }

  /** Suspend writes if asked, take the last pass, and prove the target has the shard. */
  private async finalise(state: MigrationState): Promise<void> {
    const { shardId, targetNode, sourceNode, finalSyncTimeoutMs, pauseWritesOnCutover } = state.config;
    state.phase = 'cutover';
    if (pauseWritesOnCutover) this.writeSuspended.add(state.migrationId);

    // One more pass inside the cutover window: the writes that arrived between the
    // last catch-up scan and the suspension are the ones that would be lost.
    const deadline = Date.now() + finalSyncTimeoutMs;
    for (;;) {
      this.checkpoint(state);
      const batch = await this.source.scanEntries(shardId, state.caughtUpVersion, state.config.batchSize);
      if (batch.length === 0) {
        state.quiesced = true;
        break;
      }
      await this.applyBatch(state, batch);
      state.caughtUpVersion = batch[batch.length - 1]!.version;
      if (Date.now() >= deadline) break;
    }

    // The conservation check. `entriesCopied` is the coordinator's count of what
    // it sent; this is what the target says it has, compared against what the
    // source says it holds. A migration that reports success while the target is
    // short is the failure this class exists to prevent, so it is an error here
    // rather than a number in a log line.
    const [sourceStats, targetStats] = await Promise.all([
      this.source.stats(shardId),
      this.sink.stats(targetNode, shardId),
    ]);
    // Two different failures, and they need different answers from the operator.
    // A shard that never quiesced has writes above the watermark that the deadline
    // forbade copying: the migration should not cut over, and nothing was lost —
    // the target is simply behind. A target that is short while the watermark is
    // current lost what it was sent, which is the defect this class exists to
    // refuse.
    if (!state.quiesced) {
      const behind = sourceStats.entries - targetStats.entries;
      throw new Error(
        `migration of shard ${shardId} did not quiesce within ${finalSyncTimeoutMs} ms: ` +
          `${behind} of ${sourceStats.entries} entries are above version ${state.caughtUpVersion}`,
      );
    }
    if (targetStats.entries !== sourceStats.entries) {
      throw new Error(
        `migration of shard ${shardId} from ${sourceNode} to ${targetNode} lost entries: ` +
          `the target holds ${targetStats.entries} of the source's ${sourceStats.entries}`,
      );
    }

    state.entriesTotal = sourceStats.entries;
    state.entriesCopied = targetStats.entries;
    state.bytesTotal = sourceStats.bytes;
    state.bytesCopied = targetStats.bytes;
    state.phase = 'completed';
    this.writeSuspended.delete(state.migrationId);
  }

  /** Read, then write, one batch. A key deleted between the two is reconciled, not copied. */
  private async applyBatch(state: MigrationState, batch: ShardScanEntry[]): Promise<void> {
    const { shardId, targetNode } = state.config;
    for (const scanned of batch) {
      const entry = await this.source.readEntry(shardId, scanned.key);
      if (entry === undefined) continue;
      await this.sink.applyEntry(targetNode, shardId, entry);
      state.entriesCopied += 1;
      state.bytesCopied += scanned.bytes;
      state.bytesTotal = Math.max(state.bytesTotal, state.bytesCopied);
      state.caughtUpVersion = Math.max(state.caughtUpVersion, entry.version);
    }
    state.entriesTotal = Math.max(state.entriesTotal, state.entriesCopied);
  }

  // ── Query ─────────────────────────────────────────────────

  async getStatus(migrationId: string): Promise<IMigrationStatus> {
    const state = this.migrations.get(migrationId);
    if (!state) {
      throw new Error(`migration ${migrationId} not found`);
    }
    const completed = state.phase === 'completed';
    return {
      phase: state.phase,
      progress: completed ? 100 : progressOf(state.entriesCopied, state.entriesTotal),
      remainingBytes: completed ? 0 : Math.max(0, state.bytesTotal - state.bytesCopied),
      bytesCopied: state.bytesCopied,
      entriesCopied: state.entriesCopied,
      entriesTotal: state.entriesTotal,
      caughtUpVersion: state.caughtUpVersion,
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  }

  // ── Control ───────────────────────────────────────────────

  /**
   * Ask the run to stop scanning and finish now.
   *
   * This is not a phase change with nothing behind it: the run performs the same
   * final pass and the same conservation check, so a manual cutover cannot report
   * a migration that the automatic one would have refused.
   */
  async cutover(migrationId: string): Promise<void> {
    const state = this.migrations.get(migrationId);
    if (!state) {
      throw new Error(`migration ${migrationId} not found`);
    }
    if (state.phase === 'completed') {
      return; // Already cut over
    }
    if (state.phase === 'failed' || state.phase === 'rolled-back') {
      throw new Error(`cannot cutover migration in phase ${state.phase}`);
    }

    state.stopRequested = true;
    const outcome = await state.run;
    if (outcome === 'failed') {
      // A failed phase always carries its reason: the catch that sets `failed`
      // sets `error` in the same statement, so there is no unspecified case here.
      throw new Error(`cutover of ${migrationId} failed: ${String(state.error)}`);
    }
  }

  async rollback(migrationId: string): Promise<void> {
    const state = this.migrations.get(migrationId);
    if (!state) {
      throw new Error(`migration ${migrationId} not found`);
    }
    state.stopRequested = true;
    await state.run;
    state.phase = 'rolled-back';
    state.entriesCopied = 0;
    state.bytesCopied = 0;
    state.caughtUpVersion = 0;
    state.error = undefined;
    this.writeSuspended.delete(migrationId);
  }

  async cancel(migrationId: string): Promise<void> {
    const state = this.migrations.get(migrationId);
    if (!state) {
      throw new Error(`migration ${migrationId} not found`);
    }
    if (state.phase === 'completed' || state.phase === 'failed') {
      return; // Already terminal
    }
    state.cancelRequested = true;
    const outcome = await state.run;
    // A run that finished between the check above and the flag lands in
    // `completed`; reporting it as cancelled would describe a migration that is
    // serving traffic as one that stopped.
    if (outcome === 'completed') return;
    state.phase = 'failed';
    state.error = 'cancelled by user';
    this.writeSuspended.delete(migrationId);
  }

  /** Wait for a migration to reach a terminal phase, then report it. */
  async waitForCompletion(migrationId: string): Promise<IMigrationStatus> {
    const state = this.migrations.get(migrationId);
    if (!state) {
      throw new Error(`migration ${migrationId} not found`);
    }
    await state.run;
    return this.getStatus(migrationId);
  }

  // ── Diagnostics ───────────────────────────────────────────

  /** Check if writes are currently suspended for a migration. */
  areWritesSuspended(migrationId: string): boolean {
    return this.writeSuspended.has(migrationId);
  }

  /** Get the number of active migrations. */
  getActiveMigrationCount(): number {
    let count = 0;
    for (const state of this.migrations.values()) {
      if (state.phase !== 'completed' && state.phase !== 'failed' && state.phase !== 'rolled-back') {
        count++;
      }
    }
    return count;
  }

  /** Get all migration IDs. */
  listMigrations(): string[] {
    return [...this.migrations.keys()];
  }

  /** Clear the registry (for tests). */
  reset(): void {
    this.migrations.clear();
    this.writeSuspended.clear();
    migrationSeq = 0;
  }
}
