/**
 * bootstrapFrames — the wire format of a datacenter bootstrap.
 *
 * A chunk whose `chunkIndex` is missing must not read as chunk 0: that would
 * restart the transfer from the beginning on every attempt, and the symptom would
 * be a link that looks slow rather than a frame that is wrong.
 */

import { describe, it, expect } from 'vitest';
import { makeHLC } from '../hlc/HLC';
import type { DataEntry } from './AntiEntropy';
import {
  BOOTSTRAP_CHUNK_TYPE,
  BOOTSTRAP_DONE_TYPE,
  BOOTSTRAP_FRAME_TYPES,
  BOOTSTRAP_REQUEST_TYPE,
  HANDOFF_END_TYPE,
  HANDOFF_TYPE,
  buildBootstrapChunk,
  buildBootstrapDone,
  buildBootstrapRequest,
  buildHandoffEnd,
  buildHandoffEntry,
  decodeBootstrapFrame,
  isBootstrapFrame,
} from './bootstrapFrames';

const ts = makeHLC(1_700_000_000_000n, 1, 'dc-a');

const entry: DataEntry = {
  key: 'k1',
  value: 'v1',
  hlc: { wallTime: 10, logical: 2, nodeId: 'dc-a' },
  nodeId: 'dc-a',
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const request = { transferId: 't1', shardId: 'default', nextChunk: 3, fromLsn: 42 };

describe('bootstrapFrames — round trips', () => {
  it('carries a request with both its cursor and its floor', () => {
    const frame = buildBootstrapRequest('m1', 'dc-a', 'dc-b', request, ts);
    expect(frame.type).toBe(BOOTSTRAP_REQUEST_TYPE);
    expect(decodeBootstrapFrame(BOOTSTRAP_REQUEST_TYPE, frame.payload)).toEqual({
      type: BOOTSTRAP_REQUEST_TYPE,
      body: request,
    });
  });

  it('carries a chunk with its index, total and snapshot position', () => {
    const body = {
      transferId: 't1',
      shardId: 'default',
      chunkIndex: 1,
      totalChunks: 4,
      snapshotLsn: 99,
      entries: [entry],
    };
    const frame = buildBootstrapChunk('m2', 'dc-a', 'dc-b', body, ts);
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, frame.payload)).toEqual({ type: BOOTSTRAP_CHUNK_TYPE, body });
  });

  it('carries the completion with the receiver high-water mark', () => {
    const body = { transferId: 't1', shardId: 'default', highWaterMark: 99 };
    const frame = buildBootstrapDone('m3', 'dc-b', 'dc-a', body, ts);
    expect(decodeBootstrapFrame(BOOTSTRAP_DONE_TYPE, frame.payload)).toEqual({ type: BOOTSTRAP_DONE_TYPE, body });
  });

  it('carries one handoff change with its position', () => {
    const body = { transferId: 't1', shardId: 'default', lsn: 100, entry };
    const frame = buildHandoffEntry('m4', 'dc-a', 'dc-b', body, ts);
    expect(decodeBootstrapFrame(HANDOFF_TYPE, frame.payload)).toEqual({ type: HANDOFF_TYPE, body });
  });

  it('carries the end of a handoff, complete by default', () => {
    const frame = buildHandoffEnd(
      'm5',
      'dc-a',
      'dc-b',
      { transferId: 't1', shardId: 'default', lastLsn: 101, complete: true },
      ts,
    );
    expect(decodeBootstrapFrame(HANDOFF_END_TYPE, frame.payload)).toEqual({
      type: HANDOFF_END_TYPE,
      body: { transferId: 't1', shardId: 'default', lastLsn: 101, complete: true },
    });
  });

  it('reads an absent completeness flag as complete', () => {
    // A build that predates the field always finished; reading it as incomplete
    // would have every older peer trigger a full re-bootstrap on every handoff.
    const decoded = decodeBootstrapFrame(
      HANDOFF_END_TYPE,
      encode({ transferId: 't1', shardId: 'default', lastLsn: 5 }),
    );
    expect(decoded).toMatchObject({ body: { complete: true } });
  });

  it('reports an explicit incompleteness', () => {
    const decoded = decodeBootstrapFrame(
      HANDOFF_END_TYPE,
      encode({ transferId: 't1', shardId: 'default', lastLsn: 5, complete: false }),
    );
    expect(decoded).toMatchObject({ body: { complete: false } });
  });
});

describe('bootstrapFrames — strict reading', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', []],
    ['no transfer id', { shardId: 'default', nextChunk: 0, fromLsn: 0 }],
    ['empty transfer id', { transferId: '', shardId: 'default', nextChunk: 0, fromLsn: 0 }],
    ['no shard', { transferId: 't', nextChunk: 0, fromLsn: 0 }],
    ['negative chunk', { transferId: 't', shardId: 'd', nextChunk: -1, fromLsn: 0 }],
    ['fractional lsn', { transferId: 't', shardId: 'd', nextChunk: 0, fromLsn: 0.5 }],
    ['missing lsn', { transferId: 't', shardId: 'd', nextChunk: 0 }],
  ];

  for (const [label, payload] of cases) {
    it(`rejects a request with ${label}`, () => {
      expect(decodeBootstrapFrame(BOOTSTRAP_REQUEST_TYPE, encode(payload))).toBeNull();
    });
  }

  it('rejects an empty payload', () => {
    expect(decodeBootstrapFrame(BOOTSTRAP_REQUEST_TYPE, new Uint8Array())).toBeNull();
  });

  it('rejects a payload that is not JSON', () => {
    expect(decodeBootstrapFrame(BOOTSTRAP_REQUEST_TYPE, new TextEncoder().encode('{'))).toBeNull();
  });

  it('rejects a chunk with a bad index or total', () => {
    const base = { transferId: 't', shardId: 'd', chunkIndex: 0, totalChunks: 2, snapshotLsn: 1, entries: [] };
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, chunkIndex: 1.5 }))).toBeNull();
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, totalChunks: 0 }))).toBeNull();
    // An index at or past the total describes a chunk that cannot exist.
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, chunkIndex: 2 }))).toBeNull();
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, snapshotLsn: -1 }))).toBeNull();
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, entries: 'all' }))).toBeNull();
  });

  it('rejects a chunk with an unreadable entry', () => {
    const base = { transferId: 't', shardId: 'd', chunkIndex: 0, totalChunks: 2, snapshotLsn: 1 };
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, entries: [{ key: 'k' }] }))).toBeNull();
    expect(
      decodeBootstrapFrame(
        BOOTSTRAP_CHUNK_TYPE,
        encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 1, logical: 0 } }] }),
      ),
    ).toBeNull();
    expect(
      decodeBootstrapFrame(
        BOOTSTRAP_CHUNK_TYPE,
        encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 'x', logical: 0, nodeId: 'a' } }] }),
      ),
    ).toBeNull();
    expect(
      decodeBootstrapFrame(
        BOOTSTRAP_CHUNK_TYPE,
        encode({ ...base, entries: [{ ...entry, hlc: { wallTime: 1, logical: 0.5, nodeId: 'a' } }] }),
      ),
    ).toBeNull();
    expect(decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, entries: [null] }))).toBeNull();
    expect(
      decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, entries: [{ ...entry, value: 1 }] })),
    ).toBeNull();
    expect(
      decodeBootstrapFrame(BOOTSTRAP_CHUNK_TYPE, encode({ ...base, entries: [{ ...entry, nodeId: 1 }] })),
    ).toBeNull();
  });

  it('rejects a completion with no high-water mark', () => {
    expect(decodeBootstrapFrame(BOOTSTRAP_DONE_TYPE, encode({ transferId: 't', shardId: 'd' }))).toBeNull();
  });

  it('rejects a handoff entry with a bad position or entry', () => {
    expect(decodeBootstrapFrame(HANDOFF_TYPE, encode({ transferId: 't', shardId: 'd', lsn: -1, entry }))).toBeNull();
    expect(decodeBootstrapFrame(HANDOFF_TYPE, encode({ transferId: 't', shardId: 'd', lsn: 1 }))).toBeNull();
    expect(decodeBootstrapFrame(HANDOFF_TYPE, encode({ transferId: 't', shardId: 'd', lsn: 1, entry: {} }))).toBeNull();
  });

  it('rejects a handoff end with a bad position or flag', () => {
    expect(decodeBootstrapFrame(HANDOFF_END_TYPE, encode({ transferId: 't', shardId: 'd' }))).toBeNull();
    expect(
      decodeBootstrapFrame(HANDOFF_END_TYPE, encode({ transferId: 't', shardId: 'd', lastLsn: 1, complete: 'yes' })),
    ).toBeNull();
  });

  it('rejects a frame of a type it does not own', () => {
    expect(decodeBootstrapFrame('ae_push', encode(request))).toBeNull();
  });
});

describe('bootstrapFrames — family', () => {
  it('names all five frames', () => {
    expect([...BOOTSTRAP_FRAME_TYPES].sort()).toEqual(
      [BOOTSTRAP_CHUNK_TYPE, BOOTSTRAP_DONE_TYPE, BOOTSTRAP_REQUEST_TYPE, HANDOFF_END_TYPE, HANDOFF_TYPE].sort(),
    );
  });

  it('recognises its own types and nothing else', () => {
    for (const type of BOOTSTRAP_FRAME_TYPES) expect(isBootstrapFrame(type)).toBe(true);
    expect(isBootstrapFrame('fed_heartbeat')).toBe(false);
    expect(isBootstrapFrame(undefined)).toBe(false);
  });
});
