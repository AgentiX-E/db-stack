/**
 * WalTailCDCEngine — an `ICDCEngine` whose events come from a real log.
 *
 * `CDCEngine` is a simulator: its events are produced by `appendChange()`, a
 * method documented as test-only. Everything downstream of it — the
 * subscription pump, the exactly-once pipeline, the outbox — was therefore
 * exercised against a stream that no deployment produces. This engine reads an
 * `IChangeLogReader` instead: the records were written by another process, they
 * are ordered by the position the writer assigned, and a restart resumes after
 * the last position a consumer confirmed.
 *
 * Three decisions worth their comments:
 *
 *   **The position advances for records that are not delivered.** A tail that
 *   left the cursor behind a table nobody watches would re-read those records
 *   on every poll, forever, and a batch limit would then starve the tables that
 *   *are* watched. The cursor is the log's, not the subscription's; filtering
 *   decides what is emitted, never what has been consumed.
 *
 *   **A read error is not a stopped tail.** One `EACCES`, one half-written
 *   directory, one transient `EBUSY` would otherwise wedge the stream until a
 *   process restart, and nothing would say so. The error is counted, the last
 *   message is kept, an optional hook is called, and the next tick tries again.
 *
 *   **An empty watch set means "everything".** The alternative — silence —
 *   is indistinguishable from a broken deployment, and `CDCEngine` never
 *   filtered at all, so a pipeline written against it would go dark the day it
 *   was moved onto a real log. A watch set that has been told what it wants
 *   filters; one that has not delivers what the log holds.
 */

import type { ICDCEngine, CDCChangeEvent } from '../interfaces/replication/ICDCManager';
import type { ChangeLogRecord, IChangeLogReader } from '../interfaces/replication/IChangeLogReader';
import { parseLsn, recordToChangeEvent } from '../interfaces/replication/IChangeLogReader';
import { HLC } from '../hlc/HLC';

export interface WalTailCDCEngineConfig {
  /** The log to read. Any engine's log, behind `IChangeLogReader`. */
  reader: IChangeLogReader;
  /** Node identity, stamped onto the HLC of every event this engine emits */
  nodeId: string;
  /**
   * Resume strictly after this position. Default: null (from the beginning).
   *
   * Pass the consumer's checkpoint. Passing the last position *delivered*
   * rather than the last one *processed* replays the difference — which is the
   * correct failure mode: a replay is deduplicated downstream, a gap is not.
   */
  startAfterLsn?: string | null;
  /** Poll period. Default: 50 ms */
  pollIntervalMs?: number;
  /** Records per poll. Default: 256 */
  batchSize?: number;
  /** Called with every read failure, after it has been counted */
  onReadError?: (error: unknown) => void;
}

export interface WalTailCDCEngineStatus {
  started: boolean;
  /** Last position consumed, whether or not it was delivered */
  position: string | null;
  polls: number;
  readErrors: number;
  lastError: string | null;
  /** Events handed to listeners */
  emitted: number;
  /** Records consumed whose table was not in the watch set */
  skipped: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_BATCH_SIZE = 256;

export class WalTailCDCEngine implements ICDCEngine {
  private readonly reader: IChangeLogReader;
  private readonly nodeId: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly onReadError: ((error: unknown) => void) | undefined;

  private readonly watchedTables = new Set<string>();
  private readonly listeners = new Set<(event: CDCChangeEvent) => void>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private startedFlag = false;
  private polling = false;
  private position: string | null;
  private polls = 0;
  private readErrors = 0;
  private lastError: string | null = null;
  private emitted = 0;
  private skipped = 0;

  /** HLC state, advanced from the writer's commit times. */
  private lastWall = 0n;
  private lastLogical = -1;

  constructor(config: WalTailCDCEngineConfig) {
    if (!config.reader) throw new Error('WalTailCDCEngine needs a reader');
    if (!config.nodeId) throw new Error('WalTailCDCEngine needs a nodeId');
    if (config.startAfterLsn !== undefined && config.startAfterLsn !== null) {
      // Validated here, not on the first poll: a checkpoint that is not an LSN
      // would otherwise be discovered an interval later, as a read error, and
      // the tail would look idle rather than misconfigured.
      parseLsn(config.startAfterLsn);
    }
    this.reader = config.reader;
    this.nodeId = config.nodeId;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.onReadError = config.onReadError;
    this.position = config.startAfterLsn ?? null;
  }

  // ── Lifecycle ────────────────────────────────────────────

  /** Start tailing. The first poll runs before this resolves. */
  async start(): Promise<void> {
    if (this.startedFlag) return;
    this.startedFlag = true;
    await this.poll();
    if (!this.startedFlag) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // A timer must not keep a process alive on its own: a caller that forgot
    // `stop()` should still be able to exit, and Node's default here would
    // hold the loop open for the lifetime of the deployment.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.startedFlag = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  // ── ICDCEngine ───────────────────────────────────────────

  watchTable(tableName: string): void {
    this.watchedTables.add(tableName);
  }

  unwatchTable(tableName: string): void {
    this.watchedTables.delete(tableName);
  }

  getWatchedTables(): string[] {
    return Array.from(this.watchedTables);
  }

  onChange(callback: (event: CDCChangeEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  // ── Observation ──────────────────────────────────────────

  getStatus(): WalTailCDCEngineStatus {
    return {
      started: this.startedFlag,
      position: this.position,
      polls: this.polls,
      readErrors: this.readErrors,
      lastError: this.lastError,
      emitted: this.emitted,
      skipped: this.skipped,
    };
  }

  /** The position a consumer checkpoints. */
  get currentPosition(): string | null {
    return this.position;
  }

  get started(): boolean {
    return this.startedFlag;
  }

  /**
   * Read one batch and emit it.
   *
   * Public so a caller can drive the tail deterministically — a poll on demand
   * rather than a sleep long enough for one to happen. Concurrent calls are
   * collapsed: the guard makes the second a no-op instead of a second read of
   * the same window, which would emit every record twice.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const batch = await this.reader.readAfter(this.position, this.batchSize);
      this.polls += 1;
      for (const record of batch) {
        this.consume(record);
      }
      this.lastError = null;
    } catch (error) {
      this.readErrors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onReadError?.(error);
    } finally {
      this.polling = false;
    }
  }

  // ── Internal ─────────────────────────────────────────────

  private consume(record: ChangeLogRecord): void {
    // The cursor moves first: whether this record is delivered or filtered, it
    // has been consumed, and a batch limit must count it against the window.
    this.position = record.lsn;

    if (this.watchedTables.size > 0 && !this.watchedTables.has(record.table)) {
      this.skipped += 1;
      return;
    }

    const event = recordToChangeEvent(record, this.tick(record.committedAt));
    this.emitted += 1;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One consumer's exception must not stop the stream for the others,
        // and must not stop the cursor: the record is consumed, and the
        // consumer that threw is the one that has to account for it.
      }
    }
  }

  /**
   * HLC tick anchored to the writer's commit time.
   *
   * The wall component never goes backwards, and two records committed in the
   * same millisecond get increasing logical counters — so the emitted events
   * are ordered the way the log is, even when the writer's clock is coarse or
   * a consumer's is behind it.
   */
  private tick(committedAt: number): HLC {
    const wall = BigInt(committedAt);
    if (wall > this.lastWall) {
      this.lastWall = wall;
      this.lastLogical = 0;
    } else {
      this.lastLogical += 1;
    }
    return new HLC(this.nodeId, this.lastWall, this.lastLogical);
  }
}
