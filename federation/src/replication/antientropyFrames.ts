/**
 * antientropyFrames — the two frames of the reconciliation protocol, and the
 * rules for reading one.
 *
 * Why these exist
 * ---------------
 * `AntiEntropy` used to be constructed with a data provider and, in every
 * product path, compared the local dataset with the local dataset: its "remote"
 * Merkle root was whatever the caller passed in, and no product caller passed
 * anything. A component that measures one node against itself reports perfect
 * agreement in a partition, which is the one situation it exists to notice.
 *
 * The only way to compare two nodes is to ask one of them. These frames are that
 * question and its answer, carried over the same `FederationTransport` — and
 * therefore the same TLS peer identity, the same epoch stamp and the same
 * reachability model — as the replication frames they are about.
 *
 * The protocol, in three frames
 * -----------------------------
 *   1. `ae_summary` (kind `request`) — "here is my digest; what does yours look
 *      like?" Both digests are cut from the key space, so the reply is a
 *      comparison and not a coincidence.
 *   2. `ae_summary` (kind `reply`) — the peer's digest plus the buckets it wants
 *      pushed. One round trip settles both directions: the requester learns what
 *      to send, and the replier says what it needs.
 *   3. `ae_push` — the entries of one bucket. Sent by both sides, in parallel,
 *      with no acknowledgement: a push that is lost shows up as the same
 *      divergence on the next sweep, which is the cheapest possible detector.
 *
 * Why the reply carries `want` instead of a second request
 * -------------------------------------------------------
 * A second request would make a sweep four frames and leave a window in which
 * both sides are waiting for the other. The replier can compute its own want from
 * the requester's digest alone — it has both digests in hand at the instant it
 * answers — so the extra frame buys nothing.
 */

import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import type { DatasetDigest } from '../interfaces/replication/IAntiEntropy';
import type { DataEntry } from '../replication/AntiEntropy';

/** The `TransportMessage.type` of a digest request or its answer. */
export const AE_SUMMARY_TYPE = 'ae_summary';

/** The `TransportMessage.type` of a bucket being handed over. */
export const AE_PUSH_TYPE = 'ae_push';

/** "Here is my digest — what does yours look like?" */
export interface SummaryRequestBody {
  kind: 'request';
  shardId: string;
  digest: DatasetDigest;
}

/** The peer's digest, plus the buckets it cannot fill for itself. */
export interface SummaryReplyBody {
  kind: 'reply';
  shardId: string;
  digest: DatasetDigest;
  want: string[];
}

export type SummaryBody = SummaryRequestBody | SummaryReplyBody;

/** Entries of one bucket, in key order. */
export interface PushBody {
  shardId: string;
  prefix: string;
  entries: DataEntry[];
  /**
   * True when this bucket did not fit in one frame.
   *
   * The receiver has no cursor to resume from, deliberately: a push is
   * idempotent, so "the rest is coming" only has to be visible in a status page.
   * A resume protocol here would need its own expiry and its own failure modes to
   * save bandwidth that the next sweep spends anyway.
   */
  more: boolean;
}

/** True when this frame type belongs to the reconciliation protocol. */
export function isAntiEntropyFrame(type: string | undefined): boolean {
  return type === AE_SUMMARY_TYPE || type === AE_PUSH_TYPE;
}

/**
 * Build a digest request.
 *
 * `messageId` is supplied by the caller rather than generated here, because the
 * *peer* matches its reply to it: an id invented inside this function would be
 * unreachable to the caller that is waiting for the answer.
 */
export function buildSummaryRequest(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: SummaryRequestBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return {
    messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: toNodeId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type: AE_SUMMARY_TYPE,
  };
}

/** Build the answer to a digest request. */
export function buildSummaryReply(
  inReplyTo: TransportMessage,
  fromNodeId: string,
  body: SummaryReplyBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return {
    messageId: inReplyTo.messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: inReplyTo.sourcePeerId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type: AE_SUMMARY_TYPE,
  };
}

/** Build one bucket handover. `messageId` is fresh: a push is not an answer. */
export function buildPushFrame(
  messageId: string,
  fromNodeId: string,
  toNodeId: string,
  body: PushBody,
  timestamp: IHLCTimestamp,
): TransportMessage {
  return {
    messageId,
    sourcePeerId: fromNodeId,
    targetPeerId: toNodeId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    timestamp,
    createdAt: Date.now(),
    type: AE_PUSH_TYPE,
  };
}

/**
 * Read a summary body.
 *
 * Strict on the digest, because a digest that is accepted while missing a field
 * is worse than one that is rejected: `leaves: []` parses fine and means "I hold
 * nothing", which would have this node push its entire dataset to a peer that
 * simply could not encode its answer. The depth is checked against the leaves
 * actually present for the same reason — a reply built at a different depth is
 * not comparable, and comparing across depths would report agreement on buckets
 * that never lined up.
 */
export function decodeSummary(payload: Uint8Array): SummaryBody | null {
  const parsed = parseObject(payload);
  if (!parsed) return null;

  const kind = parsed.kind;
  if (kind !== 'request' && kind !== 'reply') return null;
  if (typeof parsed.shardId !== 'string') return null;

  const digest = decodeDigest(parsed.digest);
  if (!digest) return null;

  if (kind === 'request') return { kind, shardId: parsed.shardId, digest };

  const want = parsed.want;
  if (!Array.isArray(want) || want.some((prefix) => typeof prefix !== 'string')) return null;
  return { kind, shardId: parsed.shardId, digest, want: want as string[] };
}

/** Read a push body. Entries that cannot be read are dropped, not invented. */
export function decodePush(payload: Uint8Array): PushBody | null {
  const parsed = parseObject(payload);
  if (!parsed) return null;
  if (typeof parsed.shardId !== 'string' || typeof parsed.prefix !== 'string') return null;
  if (!Array.isArray(parsed.entries)) return null;

  const entries: DataEntry[] = [];
  for (const raw of parsed.entries) {
    const entry = decodeEntry(raw);
    if (!entry) return null;
    entries.push(entry);
  }

  return { shardId: parsed.shardId, prefix: parsed.prefix, entries, more: parsed.more === true };
}

// ── Field readers ──

function parseObject(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeDigest(raw: unknown): DatasetDigest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.shardId !== 'string') return null;
  if (typeof input.root !== 'string') return null;
  if (typeof input.total !== 'number' || !Number.isFinite(input.total)) return null;
  if (typeof input.depth !== 'number' || !Number.isInteger(input.depth) || input.depth < 1) return null;
  if (!Array.isArray(input.leaves)) return null;

  const leaves: DatasetDigest['leaves'] = [];
  for (const rawLeaf of input.leaves) {
    if (rawLeaf === null || typeof rawLeaf !== 'object') return null;
    const leaf = rawLeaf as Record<string, unknown>;
    if (typeof leaf.prefix !== 'string' || typeof leaf.hash !== 'string') return null;
    if (typeof leaf.count !== 'number' || !Number.isInteger(leaf.count) || leaf.count < 0) return null;
    // The prefix is the only field that makes two digests comparable; one that is
    // the wrong length is a digest this node cannot line up with its own.
    if (leaf.prefix.length !== input.depth) return null;
    leaves.push({ prefix: leaf.prefix, hash: leaf.hash, count: leaf.count });
  }

  return {
    shardId: input.shardId,
    depth: input.depth,
    root: input.root,
    total: input.total,
    leaves,
  };
}

function decodeEntry(raw: unknown): DataEntry | null {
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
