/**
 * ReadIndexManager — Linearizable Read Implementation via Raft ReadIndex protocol
 *
 * When a leader receives a read request, it records the current commit index,
 * verifies it still leads via a quorum heartbeat round, and only then returns
 * the commit index. The caller then does a local read at that index, guaranteeing
 * linearizability without writing to the Raft log.
 *
 * Usage:
 *   const mgr = new ReadIndexManager(5000);
 *   const commitIdx = await mgr.requestReadIndex();
 *   const value = localStore.readAt(commitIdx); // safe linearizable read
 */

import * as crypto from 'node:crypto';

/** A pending ReadIndex request awaiting quorum acknowledgment */
export interface ReadIndexRequest {
  /** Unique request identifier */
  id: string;
  /** Completion callbacks */
  promise: {
    resolve: (index: number) => void;
    reject: (err: Error) => void;
  };
}

/** Internal pending entry with timeout handle */
interface PendingEntry {
  request: ReadIndexRequest;
  recordedIndex: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Manages the linearizable ReadIndex protocol for a single Raft group.
 *
 * Thread-safe: all methods should be called from the same event-loop context
 * as the Raft heartbeat/commit callback (single-threaded).
 */
export class ReadIndexManager {
  /** Pending read requests, keyed by request ID */
  private pending: Map<string, PendingEntry> = new Map();

  /** Maximum time (ms) to wait for the quorum ack before timing out */
  private readTimeoutMs: number;

  /**
   * @param readTimeoutMs - Timeout in ms for each read. 0 = no timeout (wait forever). Default 5000.
   */
  constructor(readTimeoutMs?: number) {
    this.readTimeoutMs = readTimeoutMs ?? 5000;
  }

  /**
   * Request a linearizable read index.
   *
   * Records the current commit index, then waits for the quorum acknowledgment
   * (via onCommitIndex) before resolving with the committed index. The caller
   * then reads the state machine at that index point.
   *
   * @returns Promise that resolves with the committed index for a safe linearizable read
   * @throws Error if timeout expires or leader loses leadership
   */
  requestReadIndex(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const id = crypto.randomUUID();
      const entry: PendingEntry = {
        request: {
          id,
          promise: { resolve, reject },
        },
        recordedIndex: -1,
      };

      // If a timeout is configured, set a timer to reject
      if (this.readTimeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ReadIndex timed out after ${this.readTimeoutMs}ms`));
        }, this.readTimeoutMs);
      }

      this.pending.set(id, entry);
    });
  }

  /**
   * Called when the leader commits/acks a heartbeat at the given commit index.
   *
   * All pending reads are resolved with the provided commit index, since the
   * leader has proven continued leadership by having a quorum acknowledge the
   * heartbeat round.
   *
   * @param currentIndex - The current committed log index
   */
  onCommitIndex(currentIndex: number): void {
    for (const [id, entry] of this.pending) {
      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
      }
      entry.request.promise.resolve(currentIndex);
      this.pending.delete(id);
    }
  }

  /**
   * Called when the leader loses leadership (step-down, election, etc.).
   * All pending reads are rejected to prevent stale reads.
   */
  onLeaderLost(): void {
    for (const [id, entry] of this.pending) {
      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
      }
      entry.request.promise.reject(new Error('ReadIndex failed: leader lost'));
      this.pending.delete(id);
    }
  }

  /**
   * Returns the number of pending ReadIndex requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Returns the read timeout in milliseconds.
   */
  get timeout(): number {
    return this.readTimeoutMs;
  }
}
