/**
 * bootstrapFrames — the protocol a datacenter uses to join one that has already
 * moved on.
 *
 * The gap this closes
 * -------------------
 * There was none. A datacenter that joined after another had compacted its log
 * had no snapshot transfer and no log handoff, so the only entries the two could
 * agree about were the ones both happened to still hold. Compaction is a
 * background task; the window in which a new datacenter is *unable* to join
 * therefore grows with uptime, and a rebuild after a long uptime could not
 * converge at all — not slowly, but never.
 *
 * The shape of the protocol
 * -------------------------
 *   1. `bootstrap_request` — the receiver says where it is: which chunk it wants
 *      next, and the highest log position it already holds. This one frame
 *      carries both the resume point and the floor, which is why a transfer
 *      interrupted by a restart resumes rather than starts over.
 *   2. `bootstrap_chunk` — a slice of the sender's current state, tagged with its
 *      index and the sender's log position at the moment the snapshot was taken.
 *      Idempotent: applying a chunk twice writes the same values.
 *   3. `bootstrap_done` — the receiver has every chunk; hand off from here.
 *   4. `handoff_entry` — changes the sender applied *after* the snapshot, one at a
 *      time, in log order. Anything at or below the receiver's high-water mark is
 *      skipped: the snapshot already contains that state.
 *   5. `handoff_end` — nothing more is coming, with the last position sent.
 *
 * Why the snapshot position is taken before the state is read
 * ----------------------------------------------------------
 * Reading the state first and stamping it afterwards leaves a window: a write
 * that landed between the read and the stamp is neither in the snapshot (it was
 * read too early) nor in the handoff (it is at or below the floor). Stamping
 * first makes the window harmless — a write that lands during the read is in the
 * snapshot *and* replayed by the handoff, which is a duplicate application of an
 * idempotent write rather than a hole.
 */

import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import type { DataEntry } from '../replication/AntiEntropy';

/** The `TransportMessage.type` of a receiver asking to be brought up to date. */
export const BOOTSTRAP_REQUEST_TYPE = 'bootstrap_request';
/** The `TransportMessage.type` of one slice of a snapshot. */
export const BOOTSTRAP_CHUNK_TYPE = 'bootstrap_chunk';
/** The `TransportMessage.type` of the receiver saying it has every chunk. */
export const BOOTSTRAP_DONE_TYPE = 'bootstrap_done';
/** The `TransportMessage.type` of one post-snapshot change. */
export const HANDOFF_TYPE = 'handoff_entry';
/** The `TransportMessage.type` of "nothing more is coming". */
export const HANDOFF_END_TYPE = 'handoff_end';

/** Every frame type this protocol owns. */
export const BOOTSTRAP_FRAME_TYPES: readonly string[] = [
  BOOTSTRAP_REQUEST_TYPE,
  BOOTSTRAP_CHUNK_TYPE,
  BOOTSTRAP_DONE_TYPE,
  HANDOFF_TYPE,
  HANDOFF_END_TYPE,
];

/** True when this frame type belongs to the bootstrap family. */
export function isBootstrapFrame(type: string | undefined): boolean {
  return type !== undefined && BOOTSTRAP_FRAME_TYPES.includes(type);
}

/**
 * "Send me the snapshot, starting at this chunk, because I already hold state up
 * to this log position."
 */
export interface BootstrapRequestBody {
  transferId: string;
  shardId: string;
  /** Zero-based index of the first chunk this side needs. */
  nextChunk: number;
  /**
   * The highest log position the receiver already holds.
   *
   * Also the floor for the handoff: a change at or below it is one the receiver
   * has, and replaying it would be applying history it already applied.
   */
  fromLsn: number;
}

/** One slice of the sender's state. */
export interface BootstrapChunkBody {
  transferId: string;
  shardId: string;
  chunkIndex: number;
  totalChunks: number;
  /**
   * The sender's log position when the snapshot was taken.
   *
   * The receiver adopts it as its high-water mark when the last chunk lands, so
   * the handoff starts exactly where the snapshot ends.
   */
  snapshotLsn: number;
  entries: DataEntry[];
}

/** "I have every chunk; hand off from `highWaterMark`." */
export interface BootstrapDoneBody {
  transferId: string;
  shardId: string;
  highWaterMark: number;
}

/** One change the sender applied after the snapshot. */
export interface HandoffEntryBody {
  transferId: string;
  shardId: string;
  lsn: number;
  entry: DataEntry;
}

/** "Nothing more is coming." */
export interface HandoffEndBody {
  transferId: string;
  shardId: string;
  /** The last position handed over; equal to the request's floor when nothing followed. */
  lastLsn: number;
  /**
   * False when the source could not reach back to the requested floor.
   *
   * The handoff is the only part of this protocol that needs history, and history
   * is the one thing a log is allowed to forget. A sender whose log no longer
   * reaches `highWaterMark` says so here instead of silently finishing: the
   * receiver then knows the transfer produced state with a hole in it, and the
   * only correct response is to bootstrap again from a snapshot.
   */
  complete: boolean;
}

// ── Builders ──

function frame(
  type: string,
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: unknown,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return {
    messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: toNodeId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type,
  };
}

export function buildBootstrapRequest(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: BootstrapRequestBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return frame(BOOTSTRAP_REQUEST_TYPE, messageId, fromNodeId, toNodeId, body, timestamp);
}

export function buildBootstrapChunk(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: BootstrapChunkBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return frame(BOOTSTRAP_CHUNK_TYPE, messageId, fromNodeId, toNodeId, body, timestamp);
}

export function buildBootstrapDone(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: BootstrapDoneBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return frame(BOOTSTRAP_DONE_TYPE, messageId, fromNodeId, toNodeId, body, timestamp);
}

export function buildHandoffEntry(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: HandoffEntryBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return frame(HANDOFF_TYPE, messageId, fromNodeId, toNodeId, body, timestamp);
}

export function buildHandoffEnd(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: HandoffEndBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return frame(HANDOFF_END_TYPE, messageId, fromNodeId, toNodeId, body, timestamp);
}

// ── Readers ──

/**
 * Read any frame of this family, discriminated by `type`.
 *
 * Returns `null` for a frame that cannot be read, and the caller counts it. A
 * chunk whose `chunkIndex` is missing would otherwise read as chunk `0` and
 * restart the transfer from the beginning on every attempt — a loop that looks
 * like a slow link.
 */
export type BootstrapFrame =
  | { type: typeof BOOTSTRAP_REQUEST_TYPE; body: BootstrapRequestBody }
  | { type: typeof BOOTSTRAP_CHUNK_TYPE; body: BootstrapChunkBody }
  | { type: typeof BOOTSTRAP_DONE_TYPE; body: BootstrapDoneBody }
  | { type: typeof HANDOFF_TYPE; body: HandoffEntryBody }
  | { type: typeof HANDOFF_END_TYPE; body: HandoffEndBody };

export function decodeBootstrapFrame(type: string, payload: Uint8Array): BootstrapFrame | null {
  const body = readObject(payload);
  if (!body) return null;
  if (typeof body.transferId !== 'string' || body.transferId.length === 0) return null;
  if (typeof body.shardId !== 'string') return null;

  switch (type) {
    case BOOTSTRAP_REQUEST_TYPE: {
      if (!isIndex(body.nextChunk)) return null;
      if (!isLsn(body.fromLsn)) return null;
      return {
        type,
        body: {
          transferId: body.transferId,
          shardId: body.shardId,
          nextChunk: body.nextChunk,
          fromLsn: body.fromLsn,
        },
      };
    }
    case BOOTSTRAP_CHUNK_TYPE: {
      if (!isIndex(body.chunkIndex)) return null;
      if (!isIndex(body.totalChunks) || body.totalChunks < 1) return null;
      if (body.chunkIndex >= body.totalChunks) return null;
      if (!isLsn(body.snapshotLsn)) return null;
      if (!Array.isArray(body.entries)) return null;
      const entries: DataEntry[] = [];
      for (const raw of body.entries) {
        const entry = readEntry(raw);
        if (!entry) return null;
        entries.push(entry);
      }
      return {
        type,
        body: {
          transferId: body.transferId,
          shardId: body.shardId,
          chunkIndex: body.chunkIndex,
          totalChunks: body.totalChunks,
          snapshotLsn: body.snapshotLsn,
          entries,
        },
      };
    }
    case BOOTSTRAP_DONE_TYPE: {
      if (!isLsn(body.highWaterMark)) return null;
      return {
        type,
        body: { transferId: body.transferId, shardId: body.shardId, highWaterMark: body.highWaterMark },
      };
    }
    case HANDOFF_TYPE: {
      if (!isLsn(body.lsn)) return null;
      const entry = readEntry(body.entry);
      if (!entry) return null;
      return { type, body: { transferId: body.transferId, shardId: body.shardId, lsn: body.lsn, entry } };
    }
    case HANDOFF_END_TYPE: {
      if (!isLsn(body.lastLsn)) return null;
      // Absent is `true`: a build that predates this field always finished, and
      // reading it as incomplete would have every older peer trigger a full
      // re-bootstrap on every handoff.
      if (body.complete !== undefined && typeof body.complete !== 'boolean') return null;
      return {
        type,
        body: {
          transferId: body.transferId,
          shardId: body.shardId,
          lastLsn: body.lastLsn,
          complete: body.complete !== false,
        },
      };
    }
    default:
      return null;
  }
}

function readObject(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLsn(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readEntry(raw: unknown): DataEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.key !== 'string' || typeof entry.value !== 'string') return null;
  if (typeof entry.nodeId !== 'string') return null;
  const hlc = entry.hlc;
  if (hlc === null || typeof hlc !== 'object') return null;
  const clock = hlc as Record<string, unknown>;
  if (typeof clock.wallTime !== 'number' || !Number.isFinite(clock.wallTime)) return null;
  if (typeof clock.logical !== 'number' || !Number.isInteger(clock.logical)) return null;
  if (typeof clock.nodeId !== 'string') return null;
  return {
    key: entry.key,
    value: entry.value,
    hlc: { wallTime: clock.wallTime, logical: clock.logical, nodeId: clock.nodeId },
    nodeId: entry.nodeId,
  };
}
