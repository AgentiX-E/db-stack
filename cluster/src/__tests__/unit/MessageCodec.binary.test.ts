/**
 * MessageCodec — binary fields across the JSON frame.
 *
 * Why this file exists
 * --------------------
 * `JSON.stringify` cannot carry bytes and `JSON.parse` does not put them back.
 * A `Buffer` reaches the wire as `{type: 'Buffer', data: [1, 2, 3]}`, and the
 * reader gets a *plain object*: `data.length` is `undefined`.
 *
 * `@maboke123/raft-core` installs a snapshot chunk with
 *
 *     if (request.data.length > 0) { session.chunks.push(request.data); … }
 *
 * so an InstallSnapshot chunk whose `data` arrived as an object was silently
 * dropped, the assembled snapshot was `Buffer.alloc(0)`, the engine's `restore`
 * rejected it, and the follower retried forever while still answering reads from
 * the state it had before. Measured before the fix: 5 bytes in, `undefined`
 * length out. That is a silent-divergence class defect, so the round trip is
 * pinned here at the byte level, including the "looks like a Buffer but is not
 * one" shapes that must *not* be revived.
 *
 * Acceptance criteria:
 *   AC 34.1  a Buffer field survives JSON framing with identical bytes
 *   AC 34.2  Buffers nested in arrays and objects survive
 *   AC 34.3  a plain Uint8Array view is normalised and survives
 *   AC 34.4  a large binary payload (256 KiB) survives byte for byte
 *   AC 34.5  only the exact `Buffer#toJSON` shape is revived
 *   AC 34.6  a batched `{requestId, msg}` frame gains no `entries` field
 *   AC 34.7  the legacy (no version byte) frame revives binary fields too
 *   AC 34.8  MsgPack framing stays binary-safe (Uint8Array → Buffer)
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MessageCodec } from '../../consensus/transport/MessageCodec';

/** Encode, then decode the frame's payload (the 4-byte length header is stripped). */
function roundTrip<T = any>(msg: object): T {
  const wire = MessageCodec.encode(msg);
  return MessageCodec.decode<T>(wire.subarray(4));
}

describe('MessageCodec — binary fields', () => {
  it('AC 34.1: a Buffer field arrives as a Buffer of the same length', () => {
    const data = Buffer.from([0, 1, 2, 250, 255]);
    const decoded = roundTrip<{ payload: { data: Buffer } }>({
      type: 'InstallSnapshot',
      payload: { data },
    });

    expect(Buffer.isBuffer(decoded.payload.data)).toBe(true);
    expect(decoded.payload.data.length).toBe(5);
    expect([...decoded.payload.data]).toEqual([0, 1, 2, 250, 255]);
  });

  it('AC 34.2: Buffers nested in arrays and objects survive', () => {
    const decoded = roundTrip<{ chunks: Buffer[]; meta: { inner: { blob: Buffer } } }>({
      chunks: [Buffer.from('a'), Buffer.from('bc')],
      meta: { inner: { blob: Buffer.from('deep') } },
    });

    expect(decoded.chunks.map((c) => c.toString())).toEqual(['a', 'bc']);
    expect(decoded.meta.inner.blob.toString()).toBe('deep');
  });

  it('AC 34.3: a plain Uint8Array is normalised to a Buffer and survives', () => {
    // `JSON.stringify` turns a Uint8Array into `{"0":1,…}` — an object with no
    // `length` at all. The encoder converts it before serialising.
    const view = new Uint8Array([7, 8, 9]);
    const decoded = roundTrip<{ data: Buffer }>({ data: view });

    expect(Buffer.isBuffer(decoded.data)).toBe(true);
    expect([...decoded.data]).toEqual([7, 8, 9]);
  });

  it('AC 34.4: 256 KiB of random bytes survive byte for byte', () => {
    // The size a real engine snapshot reaches quickly; JSON framing expands it
    // ~4x, so this also exercises the multi-byte length header.
    const data = randomBytes(256 * 1024);
    const decoded = roundTrip<{ data: Buffer }>({ data });

    expect(decoded.data.length).toBe(data.length);
    expect(decoded.data.equals(data)).toBe(true);
  });

  it('AC 34.5: only the exact Buffer#toJSON shape is revived', () => {
    const decoded = roundTrip<Record<string, unknown>>({
      wrongType: { type: 'Buffer-ish', data: [1] },
      noData: { type: 'Buffer' },
      notArrayData: { type: 'Buffer', data: 'AQID' },
      outOfRange: { type: 'Buffer', data: [300] },
      fractional: { type: 'Buffer', data: [1.5] },
      notNumber: { type: 'Buffer', data: ['1'] },
      emptyButValid: { type: 'Buffer', data: [] },
    });

    // A user payload that merely resembles a Buffer must come back untouched.
    expect(decoded.wrongType).toEqual({ type: 'Buffer-ish', data: [1] });
    expect(decoded.noData).toEqual({ type: 'Buffer' });
    expect(decoded.notArrayData).toEqual({ type: 'Buffer', data: 'AQID' });
    expect(decoded.outOfRange).toEqual({ type: 'Buffer', data: [300] });
    expect(decoded.fractional).toEqual({ type: 'Buffer', data: [1.5] });
    expect(decoded.notNumber).toEqual({ type: 'Buffer', data: ['1'] });
    // The valid empty shape is revived — a zero-length buffer is a Buffer.
    expect(Buffer.isBuffer(decoded.emptyButValid)).toBe(true);
    expect((decoded.emptyButValid as Buffer).length).toBe(0);
  });

  it('AC 34.6: a batched frame does not gain an entries field', () => {
    // `BatchedRaftTransport` frames are `{requestId, msg}`. The RaftMessage
    // normaliser used to add `entries: []` to anything it decoded.
    const decoded = roundTrip<Record<string, unknown>>({ requestId: 'r-1', msg: { type: 'Ping' } });

    expect(decoded).toEqual({ requestId: 'r-1', msg: { type: 'Ping' } });
    expect('entries' in decoded).toBe(false);
    // A RaftMessage-shaped frame still gets the normalisation it needs.
    expect(roundTrip<{ entries: unknown }>({ msgType: 1, entries: 'not-an-array' }).entries).toEqual([]);
  });

  it('AC 34.7: the legacy frame format revives binary fields', () => {
    // Frames without a version byte are still accepted, and they need the same
    // treatment or an old peer "works" until the first snapshot.
    const payload = Buffer.from(JSON.stringify({ data: Buffer.from([1, 2, 3]) }), 'utf-8');
    const decoded = MessageCodec.decode<{ data: Buffer }>(payload);

    expect(Buffer.isBuffer(decoded.data)).toBe(true);
    expect([...decoded.data]).toEqual([1, 2, 3]);
  });

  it('AC 34.8: MsgPack framing is binary-safe and normalises to Buffer', () => {
    const wire = MessageCodec.encodeMsgPack({
      msgType: 14,
      from: '1',
      to: '2',
      term: '3',
      entries: [{ index: '1', term: '1', entryType: 1, data: Buffer.from([9, 8, 7]) }],
    } as never);
    const decoded = MessageCodec.decode<{ entries: { data: Buffer }[] }>(wire.subarray(4));

    expect(Buffer.isBuffer(decoded.entries[0]!.data)).toBe(true);
    expect([...decoded.entries[0]!.data]).toEqual([9, 8, 7]);
  });
});
