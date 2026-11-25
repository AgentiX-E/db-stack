/**
 * heartbeatFrame — the datacenter heartbeat as a frame, and the rules for
 * reading one.
 *
 * What was wrong
 * --------------
 * The heartbeat was an `EventEmitter` emission inside the process that produced
 * it. Nothing crossed a socket, and nothing arrived that could be missed — so the
 * split-brain detector's "three missed heartbeats" timer could only ever fire for
 * a datacenter it had *once* heard from through a test that called
 * `receiveHeartbeat()` by hand. In a real deployment the detector had no peer to
 * miss.
 *
 * Making it a frame changes its nature, not just its transport. A frame is lost,
 * duplicated and reordered, and each of those has a different meaning:
 *
 *   - **Lost** — the peer said nothing this interval. That is what a missed
 *     heartbeat is, and it is the only evidence a split-brained peer produces.
 *   - **Duplicated** — the transport delivered the same interval twice. Not
 *     evidence of anything; feeding it to the detector twice would advance three
 *     "distinct" observations that are all the same instant.
 *   - **Reordered** — an older interval arrived after a newer one. Feeding it to
 *     the detector would push the peer's HLC chain *backwards*, and the chain is
 *     what divergence is measured on: a delayed pair of heartbeats could look
 *     like two independently advancing clocks, which is the exact false positive
 *     the detector exists to avoid.
 *
 * So the sequence number is not an optimisation. It is the field that makes the
 * difference between "an old frame arrived late" and "the peer is writing on its
 * own clock" computable at all.
 */

import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import type { DCHeartbeat } from './DCSplitBrainDetector';

/** The `TransportMessage.type` of a datacenter heartbeat. */
export const HEARTBEAT_TYPE = 'fed_heartbeat';

/** What crosses the wire. */
export interface HeartbeatBody {
  dcId: string;
  nodeId: string;
  /**
   * Monotonic per sender, starting at 1.
   *
   * A frame with a sequence at or below the last one accepted from the same
   * sender is out of order — see the module comment for why accepting it would
   * corrupt the divergence measurement rather than merely wasting a tick.
   */
  seq: number;
  /** The sender's wall clock when the frame was built, in ms. */
  sentAt: number;
  hlc: { wallTime: number; logical: number; nodeId: string };
  /** Writes the sender has applied, so a peer can see a frozen counter on a live link. */
  appliedCount: number;
}

/** True when this frame type belongs to the heartbeat family. */
export function isHeartbeatFrame(type: string | undefined): boolean {
  return type === HEARTBEAT_TYPE;
}

export function buildHeartbeatFrame(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: HeartbeatBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return {
    messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: toNodeId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type: HEARTBEAT_TYPE,
  };
}

/**
 * Read a heartbeat.
 *
 * `null` for anything that is not a complete heartbeat rather than a zeroed one:
 * a heartbeat with a missing `sentAt` would read as "sent at the epoch", which is
 * the most expired heartbeat possible, and would have the detector declare a
 * split brain because a frame could not be parsed.
 */
export function decodeHeartbeat(payload: Uint8Array): HeartbeatBody | null {
  if (payload.byteLength === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;

  if (typeof body.dcId !== 'string' || body.dcId.length === 0) return null;
  if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) return null;
  if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 1) return null;
  if (typeof body.sentAt !== 'number' || !Number.isFinite(body.sentAt)) return null;
  if (typeof body.appliedCount !== 'number' || !Number.isFinite(body.appliedCount)) return null;

  const hlc = body.hlc;
  if (hlc === null || typeof hlc !== 'object') return null;
  const clock = hlc as Record<string, unknown>;
  if (typeof clock.wallTime !== 'number' || !Number.isFinite(clock.wallTime)) return null;
  if (typeof clock.logical !== 'number' || !Number.isInteger(clock.logical)) return null;
  if (typeof clock.nodeId !== 'string') return null;

  return {
    dcId: body.dcId,
    nodeId: body.nodeId,
    seq: body.seq,
    sentAt: body.sentAt,
    hlc: { wallTime: clock.wallTime, logical: clock.logical, nodeId: clock.nodeId },
    appliedCount: body.appliedCount,
  };
}

/** Adapt a decoded frame to what `DCSplitBrainDetector` consumes. */
export function toDetectorHeartbeat(body: HeartbeatBody): DCHeartbeat {
  return {
    dcId: body.dcId,
    nodeId: body.nodeId,
    hlc: body.hlc,
    appliedCount: body.appliedCount,
    timestamp: body.sentAt,
  };
}
