/**
 * antientropyFrames — the wire format of a reconciliation sweep.
 *
 * The decoders are deliberately strict, and the cases below are the reason: a
 * digest accepted while missing a field is worse than one rejected, because
 * `leaves: []` parses cleanly and means "I hold nothing", which would have this
 * node push its whole dataset to a peer that merely failed to encode its answer.
 */

import { describe, it, expect } from 'vitest';
import { makeHLC } from '../hlc/HLC';
import type { DatasetDigest } from '../interfaces/replication/IAntiEntropy';
import type { DataEntry } from './AntiEntropy';
import {
  AE_PUSH_TYPE,
  AE_SUMMARY_TYPE,
  buildPushFrame,
  buildSummaryReply,
  buildSummaryRequest,
  decodePush,
  decodeSummary,
  isAntiEntropyFrame,
} from './antientropyFrames';

const ts = makeHLC(1_700_000_000_000n, 3, 'dc-a');

const digest: DatasetDigest = {
  shardId: 'default',
  depth: 2,
  root: 'root-hash',
  total: 1,
  leaves: [
    { prefix: '00', hash: 'h00', count: 0 },
    { prefix: '01', hash: 'h01', count: 1 },
    { prefix: '10', hash: 'h10', count: 0 },
    { prefix: '11', hash: 'h11', count: 0 },
  ],
};

const entry: DataEntry = {
  key: 'k1',
  value: 'v1',
  hlc: { wallTime: 10, logical: 2, nodeId: 'dc-a' },
  nodeId: 'dc-a',
};

function encode(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

describe('antientropyFrames — summary', () => {
  it('round-trips a request', () => {
    const frame = buildSummaryRequest('m1', 'dc-a', 'dc-b', { kind: 'request', shardId: 'default', digest }, ts);

    expect(frame.type).toBe(AE_SUMMARY_TYPE);
    expect(frame.targetPeerId).toBe('dc-b');
    const decoded = decodeSummary(frame.payload);
    expect(decoded).toEqual({ kind: 'request', shardId: 'default', digest });
  });

  it('round-trips a reply with the buckets it wants', () => {
    const request = buildSummaryRequest('m2', 'dc-a', 'dc-b', { kind: 'request', shardId: 'default', digest }, ts);
    const reply = buildSummaryReply(request, 'dc-b', { kind: 'reply', shardId: 'default', digest, want: ['01'] }, ts);

    // The reply carries the request's id, because the requester matches on it.
    expect(reply.messageId).toBe('m2');
    expect(reply.targetPeerId).toBe('dc-a');
    expect(decodeSummary(reply.payload)).toEqual({ kind: 'reply', shardId: 'default', digest, want: ['01'] });
  });

  it('rejects an empty payload', () => {
    expect(decodeSummary(new Uint8Array())).toBeNull();
  });

  it('rejects a payload that is not JSON', () => {
    expect(decodeSummary(new TextEncoder().encode('{not json'))).toBeNull();
  });

  it('rejects a payload that is not an object', () => {
    expect(decodeSummary(encode([]))).toBeNull();
    expect(decodeSummary(encode('a string'))).toBeNull();
    expect(decodeSummary(encode(null))).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(decodeSummary(encode({ kind: 'gossip', shardId: 'default', digest }))).toBeNull();
  });

  it('rejects a missing shard', () => {
    expect(decodeSummary(encode({ kind: 'request', digest }))).toBeNull();
  });

  it('rejects a digest with no leaves', () => {
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default' }))).toBeNull();
  });

  it('rejects a leaf whose prefix does not match the digest depth', () => {
    // The prefix is the only field that makes two digests comparable; one of the
    // wrong length describes buckets that never lined up.
    const mismatched = {
      ...digest,
      leaves: [{ prefix: '0', hash: 'h', count: 0 }],
    };
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default', digest: mismatched }))).toBeNull();
  });

  it('rejects a digest with a non-integer depth', () => {
    expect(
      decodeSummary(encode({ kind: 'request', shardId: 'default', digest: { ...digest, depth: 1.5 } })),
    ).toBeNull();
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default', digest: { ...digest, depth: 0 } }))).toBeNull();
  });

  it('rejects a digest with an unreadable total', () => {
    expect(
      decodeSummary(encode({ kind: 'request', shardId: 'default', digest: { ...digest, total: 'many' } })),
    ).toBeNull();
    expect(
      decodeSummary(encode({ kind: 'request', shardId: 'default', digest: { ...digest, total: Number.NaN } })),
    ).toBeNull();
  });

  it('rejects a reply whose want list is not a list of strings', () => {
    const base = { kind: 'reply', shardId: 'default', digest };
    expect(decodeSummary(encode({ ...base, want: 'all' }))).toBeNull();
    expect(decodeSummary(encode({ ...base, want: [1] }))).toBeNull();
    expect(decodeSummary(encode({ ...base }))).toBeNull();
  });

  it('rejects a leaf with a negative count', () => {
    const broken = { ...digest, leaves: [{ prefix: '00', hash: 'h', count: -1 }] };
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default', digest: broken }))).toBeNull();
  });

  it('rejects a leaf that is not an object', () => {
    const broken = { ...digest, leaves: ['00'] };
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default', digest: broken }))).toBeNull();
  });

  it('rejects a leaf with no hash', () => {
    const broken = { ...digest, leaves: [{ prefix: '00', count: 0 }] };
    expect(decodeSummary(encode({ kind: 'request', shardId: 'default', digest: broken }))).toBeNull();
  });
});

describe('antientropyFrames — push', () => {
  it('round-trips a bucket', () => {
    const frame = buildPushFrame(
      'p1',
      'dc-a',
      'dc-b',
      { shardId: 'default', prefix: '01', entries: [entry], more: false },
      ts,
    );

    expect(frame.type).toBe(AE_PUSH_TYPE);
    expect(decodePush(frame.payload)).toEqual({
      shardId: 'default',
      prefix: '01',
      entries: [entry],
      more: false,
    });
  });

  it('reports that more is coming', () => {
    const frame = buildPushFrame(
      'p2',
      'dc-a',
      'dc-b',
      { shardId: 'default', prefix: '01', entries: [entry], more: true },
      ts,
    );
    expect(decodePush(frame.payload)?.more).toBe(true);
  });

  it('reads an absent `more` as false', () => {
    const decoded = decodePush(encode({ shardId: 'default', prefix: '00', entries: [] }));
    expect(decoded?.more).toBe(false);
  });

  it('rejects an empty payload', () => {
    expect(decodePush(new Uint8Array())).toBeNull();
  });

  it('rejects a payload that is not JSON', () => {
    expect(decodePush(new TextEncoder().encode('nope'))).toBeNull();
  });

  it('rejects a missing shard or prefix', () => {
    expect(decodePush(encode({ prefix: '00', entries: [] }))).toBeNull();
    expect(decodePush(encode({ shardId: 'default', entries: [] }))).toBeNull();
  });

  it('rejects a payload with no entries array', () => {
    expect(decodePush(encode({ shardId: 'default', prefix: '00' }))).toBeNull();
  });

  it('rejects an unreadable entry rather than dropping it', () => {
    // Dropping it would report a bucket as delivered while carrying fewer entries
    // than the sender put in it — a loss the next sweep cannot distinguish from a
    // concurrent delete.
    expect(decodePush(encode({ shardId: 'default', prefix: '00', entries: [{ key: 'k' }] }))).toBeNull();
  });

  it('rejects an entry with a broken clock', () => {
    const base = { shardId: 'default', prefix: '00' };
    expect(decodePush(encode({ ...base, entries: [{ ...entry, hlc: null }] }))).toBeNull();
    expect(
      decodePush(encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 'x', logical: 0, nodeId: 'a' } }] })),
    ).toBeNull();
    expect(
      decodePush(encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 1, logical: 0.5, nodeId: 'a' } }] })),
    ).toBeNull();
    expect(decodePush(encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 1, logical: 0 } }] }))).toBeNull();
    expect(decodePush(encode({ ...base, entries: [{ ...entry, nodeId: 7 }] }))).toBeNull();
    expect(decodePush(encode({ ...base, entries: [{ ...entry, value: 7 }] }))).toBeNull();
    expect(decodePush(encode({ ...base, entries: [null] }))).toBeNull();
  });

  it('accepts an empty bucket', () => {
    expect(decodePush(encode({ shardId: 'default', prefix: '00', entries: [] }))?.entries).toEqual([]);
  });
});

describe('antientropyFrames — family', () => {
  it('recognises its own two types and nothing else', () => {
    expect(isAntiEntropyFrame(AE_SUMMARY_TYPE)).toBe(true);
    expect(isAntiEntropyFrame(AE_PUSH_TYPE)).toBe(true);
    expect(isAntiEntropyFrame('cdc_ack')).toBe(false);
    expect(isAntiEntropyFrame(undefined)).toBe(false);
  });
});
