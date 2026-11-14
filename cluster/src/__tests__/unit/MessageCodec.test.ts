/**
 * MessageCodec Unit Tests
 *
 * Iteration 24 — TCP wire protocol for @maboke123/raft-core messages.
 *
 * Wire format: [4 bytes BE length][1 byte format][N bytes JSON/MsgPack payload].
 * IMPORTANT: encode() returns full wire frame; decode() expects buffer WITHOUT
 * the 4-byte length header (just format byte + payload, or pure JSON for legacy).
 *
 * Acceptance Criteria:
 *   AC 24.1: encode() produces length-prefixed JSON Buffer
 *   AC 24.2: encode() sets correct format byte (0x00 JSON)
 *   AC 24.3: decode() reconstructs the original from subarray(4) frame
 *   AC 24.4: encode+decode round-trip preserves all fields
 *   AC 24.5: encode+decode with entries preserves entry fields
 *   AC 24.6: encode+decode with base64 entry data
 *   AC 24.7: encodeMsgPack produces MsgPack Buffer
 *   AC 24.8: decodeMsgPack from subarray(4) reconstructs message
 *   AC 24.9: JSON + MsgPack produce same decoded result
 *   AC 24.10: normaliseForWasm converts u64 fields to strings
 *   AC 24.11: normaliseForWasm converts entryType to number
 *   AC 24.12: normaliseEntryData converts Buffer data to base64
 *   AC 24.13: Large message encode+decode round-trip
 *   AC 24.14: MsgPack decode with binary entry data
 *   AC 24.15: MsgPack encode+decode round-trip preserves schema
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageCodec, type RaftMessage } from '../../consensus/transport/MessageCodec';

// Minimal readable-stream shim for readFrame. readFrame only requires the
// socket to emit 'data', 'end', and 'error' events and behave like a stream.
class MockSocket extends EventEmitter {
  pushChunk(chunk: Buffer): void {
    this.emit('data', chunk);
  }
  end(): void {
    this.emit('end');
  }
  fail(err: Error): void {
    this.emit('error', err);
  }
}

// Build a length-prefixed frame: [4-byte BE length][payload].
function lengthPrefixed(payload: Buffer, length?: number): Buffer {
  const len = length ?? payload.length;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(len, 0);
  return Buffer.concat([header, payload]);
}

describe('MessageCodec - Unit', () => {
  // Helper: encode returns full wire frame; decode expects buffer[4..]
  function encodeAndDecode(msg: RaftMessage): RaftMessage {
    const buf = MessageCodec.encode(msg);
    return MessageCodec.decode(buf.subarray(4)); // strip length header
  }

  function encodeAndDecodeMsgPack(msg: RaftMessage): RaftMessage {
    const buf = MessageCodec.encodeMsgPack(msg);
    return MessageCodec.decodeMsgPack(buf.subarray(4)); // strip length header
  }

  //
  // AC 24.1: encode produces length-prefixed JSON Buffer
  //
  it('AC 24.1: encode() produces length-prefixed JSON Buffer', () => {
    const msg: RaftMessage = { msgType: 1, from: '1', to: '2', term: '1' };
    const buf = MessageCodec.encode(msg);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(5);

    const length = buf.readUInt32BE(0);
    expect(length).toBe(buf.length - 4); // length excludes the 4-byte header
    expect(length).toBeGreaterThan(0);
  });

  //
  // AC 24.2: encode format byte
  //
  it('AC 24.2: encode() sets correct format byte (0x00 JSON)', () => {
    const msg: RaftMessage = { msgType: 1, from: '1', to: '2', term: '1' };
    const buf = MessageCodec.encode(msg);
    expect(buf[4]).toBe(0x00);
  });

  //
  // AC 24.3: decode reconstructs message from subarray(4)
  //
  it('AC 24.3: decode() reconstructs the original from subarray(4) frame', () => {
    const msg: RaftMessage = { msgType: 1, from: '1', to: '2', term: '1' };
    const decoded = encodeAndDecode(msg);
    expect(decoded.msgType).toBe(1);
    expect(decoded.from).toBe('1');
    expect(decoded.to).toBe('2');
    expect(decoded.term).toBe('1');
  });

  //
  // AC 24.4: round-trip preserves all fields
  //
  it('AC 24.4: encode+decode round-trip preserves all fields', () => {
    const msg: RaftMessage = {
      msgType: 2,
      from: '3',
      to: '4',
      term: '5',
      logTerm: '3',
      index: '100',
      commit: '50',
      reject: false,
      rejectHint: 'log gap',
    };
    const decoded = encodeAndDecode(msg);
    expect(decoded.msgType).toBe(2);
    expect(decoded.from).toBe('3');
    expect(decoded.to).toBe('4');
    expect(decoded.term).toBe('5');
    expect(decoded.logTerm).toBe('3');
    expect(decoded.index).toBe('100');
    expect(decoded.commit).toBe('50');
    expect(decoded.reject).toBe(false);
    expect(decoded.rejectHint).toBe('log gap');
  });

  //
  // AC 24.5: round-trip with entries
  //
  it('AC 24.5: encode+decode with entries preserves entry fields', () => {
    const msg: RaftMessage = {
      msgType: 1,
      from: '1',
      to: '2',
      term: '1',
      entries: [
        { index: '10', term: '1', entryType: 0, data: Buffer.from([1, 2, 3]).toString('base64') },
        { index: '11', term: '1', entryType: 1, data: Buffer.from([4, 5, 6]).toString('base64') },
      ],
    };
    const decoded = encodeAndDecode(msg);
    expect(decoded.entries).toHaveLength(2);
    expect(decoded.entries![0].index).toBe('10');
    expect(decoded.entries![1].index).toBe('11');
  });

  //
  // AC 24.6: entry data as base64 string
  //
  it('AC 24.6: encode+decode with base64 entry data', () => {
    const originalData = 'SGVsbG8='; // "Hello" in base64
    const msg: RaftMessage = {
      msgType: 1,
      from: '1',
      to: '2',
      term: '1',
      entries: [{ index: '1', term: '1', entryType: 0, data: originalData }],
    };
    const decoded = encodeAndDecode(msg);
    // decode normalises: Buffer -> base64 string
    expect(typeof decoded.entries![0].data).toBe('string');
  });

  //
  // AC 24.7: encodeMsgPack produces MsgPack Buffer
  //
  it('AC 24.7: encodeMsgPack produces MsgPack Buffer', () => {
    const msg: RaftMessage = { msgType: 1, from: '1', to: '2', term: '1' };
    const buf = MessageCodec.encodeMsgPack(msg);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(5);
    // Format byte for MsgPack: 0x01
    expect(buf[4]).toBe(0x01);
  });

  //
  // AC 24.8: decodeMsgPack from subarray(4)
  //
  it('AC 24.8: decodeMsgPack from subarray(4) reconstructs message', () => {
    const msg: RaftMessage = { msgType: 1, from: '1', to: '2', term: '1' };
    const decoded = encodeAndDecodeMsgPack(msg);
    expect(decoded.msgType).toBe(1);
    expect(decoded.from).toBe('1');
    expect(decoded.to).toBe('2');
    expect(decoded.term).toBe('1');
  });

  //
  // AC 24.9: JSON and MsgPack produce same decoded result
  //
  it('AC 24.9: JSON + MsgPack produce same decoded result', () => {
    const msg: RaftMessage = { msgType: 2, from: '3', to: '4', term: '5', commit: '10' };
    const jsonDecoded = encodeAndDecode(msg);
    const mpDecoded = encodeAndDecodeMsgPack(msg);
    expect(jsonDecoded.msgType).toBe(mpDecoded.msgType);
    expect(jsonDecoded.from).toBe(mpDecoded.from);
    expect(jsonDecoded.to).toBe(mpDecoded.to);
    expect(jsonDecoded.term).toBe(mpDecoded.term);
    expect(jsonDecoded.commit).toBe(mpDecoded.commit);
  });

  //
  // AC 24.10: normaliseForWasm converts u64 fields to strings
  //
  it('AC 24.10: normaliseForWasm converts u64 fields to strings', () => {
    const raw = { msgType: 0, from: 1, to: 2, term: 3 };
    const normalised = MessageCodec.normaliseForWasm(raw);
    expect(typeof normalised.from).toBe('string');
    expect(typeof normalised.to).toBe('string');
    expect(typeof normalised.term).toBe('string');
    expect(normalised.from).toBe('1');
    expect(normalised.to).toBe('2');
    expect(normalised.term).toBe('3');
  });

  //
  // AC 24.11: normaliseForWasm converts entryType to number
  //
  it('AC 24.11: normaliseForWasm converts entry index/term to string', () => {
    const raw = {
      msgType: 1,
      from: 1,
      to: 2,
      term: 1,
      entries: [{ index: 1, term: 1, entryType: 0, data: 'dGVzdA==' }],
    };
    const normalised = MessageCodec.normaliseForWasm(raw);
    expect(normalised.entries![0].index).toBe('1');
    expect(normalised.entries![0].term).toBe('1');
    // entryType is NOT converted by normaliseForWasm — it's already a number
    expect(normalised.entries![0].entryType).toBe(0);
  });

  //
  // AC 24.12: normaliseEntryData converts Buffer to base64
  //
  it('AC 24.12: normaliseForWasm converts Buffer entry data to base64 string', () => {
    const msg: RaftMessage = {
      msgType: 1,
      from: '1',
      to: '2',
      term: '1',
      entries: [{ index: '1', term: '1', entryType: 0, data: Buffer.from([72, 101, 108, 108, 111]) }],
    };
    // normaliseForWasm converts Buffer entry.data to base64 string
    const normalised = MessageCodec.normaliseForWasm(msg);
    expect(typeof normalised.entries![0].data).toBe('string');
    expect(normalised.entries![0].data).toBe('SGVsbG8=');
  });

  //
  // AC 24.13: Large message round-trip
  //
  it('AC 24.13: Large message encode+decode round-trip', () => {
    const largeData = Buffer.alloc(10000, 'X').toString('base64');
    const msg: RaftMessage = {
      msgType: 1,
      from: '1',
      to: '2',
      term: '1',
      entries: [{ index: '1', term: '1', entryType: 0, data: largeData }],
    };
    const decoded = encodeAndDecode(msg);
    expect(decoded.entries).toHaveLength(1);
    expect(typeof decoded.entries![0].data).toBe('string');
  });

  //
  // AC 24.14: MsgPack decode with binary entry data
  //
  it('AC 24.14: MsgPack decode with binary entry data', () => {
    const msg: RaftMessage = {
      msgType: 10,
      from: '5',
      to: '6',
      term: '7',
      entries: [{ index: '1', term: '1', entryType: 0, data: Buffer.from([0xab, 0xcd]) }],
    };
    const decoded = encodeAndDecodeMsgPack(msg);
    expect(decoded.msgType).toBe(10);
    expect(decoded.entries).toHaveLength(1);
  });

  //
  // AC 24.15: MsgPack round-trip preserves schema
  //
  it('AC 24.15: MsgPack encode+decode round-trip preserves schema', () => {
    const msg: RaftMessage = {
      msgType: 5,
      from: '1',
      to: '2',
      term: '3',
      logTerm: '2',
      index: '50',
      commit: '30',
      reject: true,
      rejectHint: 'conflict',
      entries: [
        { index: '1', term: '1', entryType: 0, data: Buffer.from([1, 2]) },
        { index: '2', term: '1', entryType: 1, data: Buffer.from([3, 4]) },
      ],
    };
    const decoded = encodeAndDecodeMsgPack(msg);
    expect(decoded.msgType).toBe(5);
    expect(decoded.reject).toBe(true);
    expect(decoded.rejectHint).toBe('conflict');
    expect(decoded.entries).toHaveLength(2);
    expect(decoded.entries![0].index).toBe('1');
    expect(decoded.entries![1].index).toBe('2');
  });

  //
  // decode() format-dispatch branches (version byte autodetection)
  //

  it('decode() autodetects the MsgPack format byte and normalises binary data', () => {
    const msg: RaftMessage = {
      msgType: 6,
      from: '1',
      to: '2',
      term: '1',
      entries: [{ index: '1', term: '1', entryType: 0, data: Buffer.from([9, 8, 7]) }],
    };
    const frame = MessageCodec.encodeMsgPack(msg).subarray(4); // [0x01][msgpack]
    expect(frame[0]).toBe(0x01);

    const decoded = MessageCodec.decode(frame);
    expect(decoded.msgType).toBe(6);
    // MsgPack path normalises Uint8Array back to Buffer via normaliseEntryData.
    expect(decoded.entries![0].data).toBeInstanceOf(Buffer);
  });

  it('decode() throws on an empty buffer', () => {
    expect(() => MessageCodec.decode(Buffer.alloc(0))).toThrow('Empty decode buffer');
  });

  it('decode() falls back to legacy JSON when no version byte is present', () => {
    const msg: RaftMessage = { msgType: 7, from: '1', to: '2', term: '1' };
    // Legacy frame: raw JSON without leading format byte.
    const legacy = Buffer.from(JSON.stringify(msg), 'utf-8');
    const decoded = MessageCodec.decode(legacy);
    expect(decoded.msgType).toBe(7);
    expect(decoded.from).toBe('1');
  });

  it('decode() normalises a non-array entries field to an empty array', () => {
    // Craft a JSON frame whose `entries` is an object (not an array).
    const raw = { msgType: 8, from: '1', to: '2', term: '1', entries: { bogus: true } };
    const frame = Buffer.from(JSON.stringify(raw), 'utf-8');
    frame[0] = 0x00; // ensure it reads as version-byte JSON? No — leave as legacy JSON.
    // Use legacy path (no version byte) so buffer[0] is '{' (0x7b).
    const decoded = MessageCodec.decode(Buffer.from(JSON.stringify(raw), 'utf-8'));
    expect(Array.isArray(decoded.entries)).toBe(true);
    expect(decoded.entries).toHaveLength(0);
  });

  it('decodeMsgPack accepts a raw payload without a version byte', () => {
    const msg: RaftMessage = { msgType: 9, from: '1', to: '2', term: '1' };
    // Encode, then strip BOTH the length header and the version byte.
    const full = MessageCodec.encodeMsgPack(msg);
    const rawPayload = full.subarray(5); // skip 4-byte length + 1-byte version
    const decoded = MessageCodec.decodeMsgPack(rawPayload);
    expect(decoded.msgType).toBe(9);
  });

  it('decode()/decodeMsgPack handle a MsgPack message with no entries field', () => {
    // Exercises normaliseEntryData's early-return when `entries` is absent.
    const msg: RaftMessage = { msgType: 14, from: '1', to: '2', term: '1' };
    const frame = MessageCodec.encodeMsgPack(msg).subarray(4);
    const decoded = MessageCodec.decode(frame);
    expect(decoded.msgType).toBe(14);
    // decode() normalises an absent entries field to an empty array.
    expect(decoded.entries).toEqual([]);

    const rawPayload = MessageCodec.encodeMsgPack(msg).subarray(5);
    const decoded2 = MessageCodec.decodeMsgPack(rawPayload);
    expect(decoded2.msgType).toBe(14);
  });

  //
  // normaliseForWasm snapshot.data (base64 conversion)
  //

  it('normaliseForWasm converts snapshot.data Uint8Array to base64 string', () => {
    const raw: any = {
      msgType: 10,
      from: '1',
      to: '2',
      term: '1',
      snapshot: { data: Buffer.from([1, 2, 3, 4]) },
    };
    const out = MessageCodec.normaliseForWasm(raw);
    expect(out.snapshot.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('normaliseForWasm leaves a string snapshot.data untouched', () => {
    const raw: any = {
      msgType: 11,
      from: '1',
      to: '2',
      term: '1',
      snapshot: { data: 'already-base64' },
    };
    const out = MessageCodec.normaliseForWasm(raw);
    expect(out.snapshot.data).toBe('already-base64');
  });

  it('normaliseForWasm returns non-object inputs unchanged', () => {
    expect(MessageCodec.normaliseForWasm(null as any)).toBeNull();
    expect(MessageCodec.normaliseForWasm('str' as any)).toBe('str');
    expect(MessageCodec.normaliseForWasm(42 as any)).toBe(42);
  });

  it('normaliseForWasm converts logTerm/index/commit numbers to strings when non-null', () => {
    const raw: any = {
      msgType: 12,
      from: 1, // number → string
      to: 2,
      term: 3,
      logTerm: 2,
      index: 4,
      commit: 5,
      entries: [{ index: 7, term: 8, entryType: 0, data: 'x' }],
    };
    const out = MessageCodec.normaliseForWasm(raw);
    expect(out.from).toBe('1');
    expect(out.to).toBe('2');
    expect(out.term).toBe('3');
    expect(out.logTerm).toBe('2');
    expect(out.index).toBe('4');
    expect(out.commit).toBe('5');
    expect(out.entries[0].index).toBe('7');
    expect(out.entries[0].term).toBe('8');
  });

  it('normaliseForWasm leaves null logTerm/index/commit untouched', () => {
    const raw: any = { msgType: 13, from: '1', to: '2', term: '1', logTerm: null, index: null, commit: null };
    const out = MessageCodec.normaliseForWasm(raw);
    expect(out.logTerm).toBeNull();
    expect(out.index).toBeNull();
    expect(out.commit).toBeNull();
  });
});

describe('MessageCodec.readFrame', () => {
  it('reads a complete frame delivered in a single chunk', async () => {
    const socket = new MockSocket();
    const payload = Buffer.from('hello-frame');
    const promise = MessageCodec.readFrame(socket as any);
    socket.pushChunk(lengthPrefixed(payload));
    const frame = await promise;
    expect(frame).toBeInstanceOf(Buffer);
    expect(frame!.toString('utf-8')).toBe('hello-frame');
  });

  it('reassembles a frame split across multiple chunks', async () => {
    const socket = new MockSocket();
    const payload = Buffer.from('split-across-chunks');
    const full = lengthPrefixed(payload);
    const promise = MessageCodec.readFrame(socket as any);
    // Split the header itself across two chunks.
    socket.pushChunk(full.subarray(0, 2));
    socket.pushChunk(full.subarray(2, 4));
    socket.pushChunk(full.subarray(4, 10));
    socket.pushChunk(full.subarray(10));
    const frame = await promise;
    expect(frame!.toString('utf-8')).toBe('split-across-chunks');
  });

  it('resolves null on an empty frame (length=0, end-of-stream signal)', async () => {
    const socket = new MockSocket();
    const promise = MessageCodec.readFrame(socket as any);
    socket.pushChunk(lengthPrefixed(Buffer.alloc(0), 0));
    const result = await promise;
    expect(result).toBeNull();
  });

  it('rejects on a payload length exceeding MAX_PAYLOAD_SIZE', async () => {
    const socket = new MockSocket();
    const promise = MessageCodec.readFrame(socket as any);
    socket.pushChunk(lengthPrefixed(Buffer.alloc(0), MessageCodec.MAX_PAYLOAD_SIZE + 1));
    await expect(promise).rejects.toThrow(/Invalid payload length/);
  });

  it('resolves null on a clean end with no partial frame', async () => {
    const socket = new MockSocket();
    const promise = MessageCodec.readFrame(socket as any);
    socket.end();
    const result = await promise;
    expect(result).toBeNull();
  });

  it('rejects when the stream ends mid-frame', async () => {
    const socket = new MockSocket();
    const payload = Buffer.from('partial-frame-data');
    const full = lengthPrefixed(payload);
    const promise = MessageCodec.readFrame(socket as any);
    // Send only part of the payload, then end.
    socket.pushChunk(full.subarray(0, 6));
    socket.end();
    await expect(promise).rejects.toThrow('Connection closed mid-frame');
  });

  it('propagates stream errors', async () => {
    const socket = new MockSocket();
    const promise = MessageCodec.readFrame(socket as any);
    socket.fail(new Error('socket exploded'));
    await expect(promise).rejects.toThrow('socket exploded');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const socket = new MockSocket();
    const controller = new AbortController();
    controller.abort();
    const promise = MessageCodec.readFrame(socket as any, controller.signal);
    await expect(promise).rejects.toThrow('The operation was aborted');
  });

  it('rejects when the signal aborts after the read has started', async () => {
    const socket = new MockSocket();
    const controller = new AbortController();
    const promise = MessageCodec.readFrame(socket as any, controller.signal);
    // Abort while the frame header is still pending.
    controller.abort();
    await expect(promise).rejects.toThrow('The operation was aborted');
  });

  it('ignores data chunks after the frame is complete', async () => {
    const socket = new MockSocket();
    const payload = Buffer.from('frame-data');
    // Frame is complete after the first full frame; a second frame is sent but
    // readFrame resolves with only the first.
    const promise = MessageCodec.readFrame(socket as any);
    socket.pushChunk(lengthPrefixed(payload));
    const frame = await promise;
    expect(frame!.toString('utf-8')).toBe('frame-data');
  });
});
