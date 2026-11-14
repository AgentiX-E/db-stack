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
 * - **Gap detection.** Raft never skips an index; an engine that receives
 *   `1, 2, 4` is talking to a broken log, and silently applying `4` would corrupt
 *   state invisibly. The gap is rejected.
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
  /** Non-zero while an apply is running, so `snapshot()` can detect re-entrancy. */
  private _applyDepth = 0;

  constructor(options: EngineBackedReplicaOptions) {
    this.engine = options.engine;
    this._shardId = options.shardId;
    this._appliedIndex = options.initialIndex ?? 0;
  }

  /** Exposed for diagnostics: how many duplicate indexes the adapter suppressed. */
  get skippedReplays(): number {
    return this._skippedReplays;
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
    if (index <= this._appliedIndex) {
      this._skippedReplays += 1;
      return;
    }
    // A gap means the log lost an entry. Applying past it would produce state no
    // peer can reproduce, so refuse rather than diverge silently. The first apply
    // of a recovered engine may legitimately start above 1.
    if (this._appliedIndex !== 0 && index !== this._appliedIndex + 1) {
      throw new SqlVecError(
        `Log gap on shard ${this._shardId}: applied ${this._appliedIndex}, next entry is ${index}`,
        SqlVecErrorCode.FAILED_PRECONDITION,
      );
    }
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

  async snapshot(): Promise<Buffer> {
    // Wait for queued applies so the payload and the recorded index describe the
    // same state: framing index N around state that also contains N+1 would make a
    // restore replay N+1 a second time. When the snapshot is requested *from* an
    // apply (a size-triggered compaction), the queue is already blocked on this
    // very call, so awaiting it would deadlock — and is unnecessary, because no
    // other apply can start until the current one returns.
    if (this._applyDepth === 0) await this.tail;
    const payload = await this.engine.snapshot();
    return encodeSnapshotEnvelope({
      shardId: this._shardId,
      index: this._appliedIndex,
      term: this._appliedTerm,
      payload,
    });
  }

  async restore(snapshot: Buffer): Promise<void> {
    const envelope = decodeSnapshotEnvelope(snapshot, this._shardId);
    await this.engine.restore(envelope.payload);
    this._appliedIndex = envelope.index;
    this._appliedTerm = envelope.term;
  }

  async dataSize(): Promise<number> {
    return this.engine.sizeInBytes();
  }
}
