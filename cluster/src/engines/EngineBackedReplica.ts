/**
 * EngineBackedReplica — turns an {@link IStorageEngine} into the
 * {@link IShardReplica} a Raft group applies entries to.
 *
 * The adapter owns everything an engine should not have to think about:
 *
 * - **Idempotent replay.** After a restart Raft replays every entry that is not
 *   covered by the snapshot it loaded. If the engine already persisted those
 *   writes, replaying them again would double-count counters, re-fire triggers and
 *   turn `UPDATE balance = balance + 10` into `+20`. The adapter therefore drops
 *   any index it has already applied.
 * - **Monotonic position.** A forward jump is legitimate: raft-core applies
 *   CONFIG and NOOP entries itself and never calls the application for them, so
 *   the indexes an engine sees are increasing but not necessarily consecutive.
 *   Rejecting a jump — which this adapter used to do, on the assumption that Raft
 *   never skips an index — killed the apply loop on the first entry after a
 *   restart and left the cluster readable but no longer writable.
 * - **Serialization.** Committed entries are applied one at a time even if a
 *   caller submits several without awaiting.
 * - **Snapshot framing.** A raw engine snapshot carries no position, so a
 *   restarted replica cannot tell Raft where to resume. The adapter wraps it in an
 *   envelope that records `(shardId, index, term)` and a CRC32, which turns a
 *   truncated, corrupt or cross-shard snapshot into a clear error instead of a
 *   silent data loss.
 *
 * @module engines/EngineBackedReplica
 */

import type { ApplyEntry, IShardReplica } from '../interfaces/IShardReplica';
import type { IStorageEngine } from '../interfaces/IStorageEngine';
import { SqlVecError, SqlVecErrorCode } from '../interfaces/types';
import { crc32 } from '../consensus/helpers/crc32';
import { getErrorMessage } from '../consensus/helpers/errorUtils';

/** Envelope magic. Chosen so a mis-framed buffer fails fast on the first four bytes. */
const MAGIC = Buffer.from('DBSE', 'utf8');

/** Envelope layout version. Bumped only for an incompatible layout change. */
export const SNAPSHOT_ENVELOPE_VERSION = 1;

/**
 * Header layout (30 bytes, big-endian throughout so the bytes are identical on
 * every platform):
 *
 * ```
 * 0   magic     4   'DBSE'
 * 4   version   2   u16
 * 6   shardId   4   u32
 * 10  index     8   u64
 * 18  term      8   u64
 * 26  crc32     4   u32   CRC32 of payload
 * 30  payload   n
 * ```
 */
const HEADER_SIZE = 30;

export interface SnapshotEnvelope {
  shardId: number;
  index: number;
  term: number;
  payload: Buffer;
}

/** Wrap an engine snapshot in a positioned, checksummed envelope. */
export function encodeSnapshotEnvelope(envelope: SnapshotEnvelope): Buffer {
  const { shardId, index, term, payload } = envelope;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new SqlVecError(
      `Cannot frame snapshot: index ${index} is not a safe non-negative integer`,
      SqlVecErrorCode.INVALID_ARGUMENT,
    );
  }
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt16BE(SNAPSHOT_ENVELOPE_VERSION, 4);
  header.writeUInt32BE(shardId >>> 0, 6);
  header.writeBigUInt64BE(BigInt(index), 10);
  header.writeBigUInt64BE(BigInt(Math.trunc(term)), 18);
  header.writeUInt32BE(crc32.unsigned(payload), 26);
  return Buffer.concat([header, payload]);
}

/**
 * Parse and validate an envelope.
 *
 * Every check runs before the caller touches engine state, so a rejected snapshot
 * cannot damage a healthy replica.
 */
export function decodeSnapshotEnvelope(buffer: Buffer, expectedShardId?: number): SnapshotEnvelope {
  if (buffer.length < HEADER_SIZE) {
    throw new SqlVecError(
      `Snapshot is truncated: ${buffer.length} bytes is shorter than the ${HEADER_SIZE}-byte envelope header`,
      SqlVecErrorCode.INVALID_ARGUMENT,
    );
  }
  if (!buffer.subarray(0, 4).equals(MAGIC)) {
    throw new SqlVecError('Snapshot is not a db-cluster snapshot: bad magic', SqlVecErrorCode.INVALID_ARGUMENT);
  }
  const version = buffer.readUInt16BE(4);
  if (version !== SNAPSHOT_ENVELOPE_VERSION) {
    throw new SqlVecError(
      `Unsupported snapshot envelope version ${version} (this build writes ${SNAPSHOT_ENVELOPE_VERSION})`,
      SqlVecErrorCode.FAILED_PRECONDITION,
    );
  }
  const shardId = buffer.readUInt32BE(6);
  if (expectedShardId !== undefined && shardId !== expectedShardId) {
    throw new SqlVecError(
      `Snapshot belongs to shard ${shardId}, not ${expectedShardId}`,
      SqlVecErrorCode.FAILED_PRECONDITION,
    );
  }
  const index = Number(buffer.readBigUInt64BE(10));
  const term = Number(buffer.readBigUInt64BE(18));
  const expectedCrc = buffer.readUInt32BE(26);
  const payload = buffer.subarray(HEADER_SIZE);
  const actualCrc = crc32.unsigned(payload);
  if (actualCrc !== expectedCrc) {
    throw new SqlVecError(
      `Snapshot payload is corrupt: CRC32 ${actualCrc.toString(16)} does not match header ${expectedCrc.toString(16)}`,
      SqlVecErrorCode.INTERNAL,
    );
  }
  return { shardId, index, term, payload };
}

export interface EngineBackedReplicaOptions {
  shardId: number;
  engine: IStorageEngine;
  /**
   * Index the loaded state already reflects, used when the engine was restored
   * out of band before the replica was constructed. Defaults to 0 (empty engine).
   */
  initialIndex?: number;
}

export class EngineBackedReplica implements IShardReplica {
  private readonly engine: IStorageEngine;
  private readonly _shardId: number;
  private _appliedIndex: number;
  private _appliedTerm = 0;
  /** Serializes applies: a caller that forgets to await still gets in-order state. */
  private tail: Promise<void> = Promise.resolve();
  /** Replayed indexes dropped because the engine had already applied them. */
  private _skippedReplays = 0;
  /** Forward jumps accepted because raft skipped non-command entries. */
  private _forwardJumps = 0;
  /** Non-zero while an apply is running, so `snapshot()` can detect re-entrancy. */
  private _applyDepth = 0;
  /**
   * The error from the last failed `restore()`, cleared by the next successful one.
   *
   * A failed install is not a transient miss: raft has already discarded the log
   * up to the snapshot's index, so the entries the snapshot was supposed to carry
   * are gone from the log *and* absent from this engine. Applying the entries
   * above the boundary anyway is how a replica ends up with an applied index that
   * matches the cluster and state that does not — serving reads from a hole. It
   * refuses until an install succeeds, which the leader retries on its own.
   */
  private _restoreFailure: unknown = null;

  constructor(options: EngineBackedReplicaOptions) {
    this.engine = options.engine;
    this._shardId = options.shardId;
    this._appliedIndex = options.initialIndex ?? 0;
  }

  /** Exposed for diagnostics: how many duplicate indexes the adapter suppressed. */
  get skippedReplays(): number {
    return this._skippedReplays;
  }

  /**
   * Exposed for diagnostics: the error from the last failed `restore()`, or null.
   *
   * Non-null means this replica is refusing to apply until a snapshot install
   * succeeds. It is the difference between "behind" and "wrong": a node that is
   * behind catches up, and a node whose state has a hole must not answer reads.
   */
  get restoreFailure(): unknown {
    return this._restoreFailure;
  }

  /**
   * Exposed for diagnostics: how many indexes arrived above the expected one.
   *
   * Non-zero is normal on any cluster that elected a leader (raft appends a NOOP)
   * or was bootstrapped (a CONFIG entry); it is not an error signal.
   */
  get forwardJumps(): number {
    return this._forwardJumps;
  }

  async apply(entry: ApplyEntry): Promise<void> {
    const run = this.tail.then(() => this.applyOnce(entry));
    // Keep the chain alive after a rejection: one failed command must not wedge
    // every later one, the failure is reported to the caller of this call.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyOnce(entry: ApplyEntry): Promise<void> {
    const { index } = entry;
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new SqlVecError(
        `Entry index ${index} is not a safe non-negative integer`,
        SqlVecErrorCode.INVALID_ARGUMENT,
      );
    }
    if (this._restoreFailure !== null) {
      throw new SqlVecError(
        `Refusing to apply index ${index}: the last snapshot install failed ` +
          `(${getErrorMessage(this._restoreFailure)}), so the state the snapshot covered was never restored. ` +
          'Applying past it would leave this replica with a current applied index and a hole in its state.',
        SqlVecErrorCode.INTERNAL_ERROR,
        { cause: this._restoreFailure },
      );
    }
    if (index <= this._appliedIndex) {
      this._skippedReplays += 1;
      return;
    }
    // A forward jump is expected, not a fault: raft-core applies CONFIG and NOOP
    // entries without calling the application, so the application's index sequence
    // has holes exactly where those entries were. Applying across a jump is
    // correct — the skipped entries carry no application state — while *going
    // backwards* is the case that must be refused, and it is handled above.
    if (index > this._appliedIndex + 1) this._forwardJumps += 1;
    const payload = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const context = {
      shardId: this._shardId,
      index,
      applyTerm: entry.term,
      ...(entry.type === undefined ? {} : { operation: entry.type }),
      ...(entry.msgId === undefined ? {} : { msgId: entry.msgId }),
    };
    this._applyDepth += 1;
    try {
      await this.engine.apply(context, payload);
      this._appliedIndex = index;
      this._appliedTerm = entry.term;
    } finally {
      this._applyDepth -= 1;
    }
  }

  /** Read through the engine. Not part of `IShardReplica`; used by shard-level readers. */
  async query(request: Buffer): Promise<Buffer> {
    return this.engine.query(request);
  }

  async getAppliedIndex(): Promise<number> {
    return this._appliedIndex;
  }

  lastAppliedIndex(): number {
    return this._appliedIndex;
  }

  shardId(): number {
    return this._shardId;
  }

  async snapshot(boundaryIndex?: number): Promise<Buffer> {
    // Wait for queued applies so the payload and the recorded index describe the
    // same state: framing index N around state that also contains N+1 would make a
    // restore replay N+1 a second time. When the snapshot is requested *from* an
    // apply (a size-triggered compaction), the queue is already blocked on this
    // very call, so awaiting it would deadlock — and is unnecessary, because no
    // other apply can start until the current one returns.
    if (this._applyDepth === 0) await this.tail;
    const payload = await this.engine.snapshot();
    // The boundary raft declares wins over the local watermark. They differ by the
    // non-command entries raft applied without calling the application, and a
    // snapshot stamped *below* its own boundary makes the first post-restore apply
    // look like a skipped entry.
    const index = boundaryIndex ?? this._appliedIndex;
    if (boundaryIndex !== undefined && boundaryIndex > this._appliedIndex) {
      this._appliedIndex = boundaryIndex;
    }
    return encodeSnapshotEnvelope({
      shardId: this._shardId,
      index,
      term: this._appliedTerm,
      payload,
    });
  }

  async restore(snapshot: Buffer): Promise<void> {
    let envelope: SnapshotEnvelope;
    try {
      envelope = decodeSnapshotEnvelope(snapshot, this._shardId);
      await this.engine.restore(envelope.payload);
    } catch (err) {
      // Recorded, not swallowed: the caller still sees the failure, and every
      // later apply is refused until a restore succeeds.
      this._restoreFailure = err;
      throw err;
    }
    this._restoreFailure = null;
    this._appliedIndex = envelope.index;
    this._appliedTerm = envelope.term;
  }

  async dataSize(): Promise<number> {
    return this.engine.sizeInBytes();
  }
}
