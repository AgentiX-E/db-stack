/**
 * ConnectionPool — Pure Unit Tests (Frame encoding, PeerConnection)
 *
 * These tests do NOT import ConnectionPool (which spawns TLS/retry timers).
 * They test only the pure functions and PeerConnection with mock sockets.
 *
 * Acceptance Criteria:
 *   AC 31.1:  encodeFrame / decodeFrame roundtrip (normal + empty + large)
 *   AC 31.2:  encodeFrame / decodeFrame boundary (partial + multi-frame)
 *   AC 31.3:  PeerConnection write serialization via WriteLock
 *   AC 31.5:  PeerConnection replaceSocket
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mock socket ────────────────────────────────────────────────

function createMockSocket() {
  const socket = new EventEmitter() as any;
  const writes: Buffer[] = [];
  socket.authorized = true;
  socket.encrypted = true;
  socket.write = vi.fn((data: Buffer, cb?: (e?: Error | null) => void) => {
    writes.push(data);
    if (cb) setImmediate(() => cb(null));
    return true;
  });
  socket.end = vi.fn(() => setImmediate(() => socket.emit('close')));
  socket.destroy = vi.fn(() => setImmediate(() => socket.emit('close')));
  socket.setTimeout = vi.fn();
  socket.setNoDelay = vi.fn();
  socket.getPeerCertificate = vi.fn(() => ({
    subject: { CN: 'raft-node-2' },
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: '2030-01-01T00:00:00Z',
  }));
  socket.getWrites = () => [...writes];
  return socket;
}

// Import just the pure exports (no ConnectionPool side effects)
import { PeerConnection, encodeFrame, decodeFrame } from '../../consensus/transport/ConnectionPool';

describe('AC 31.1: encodeFrame / decodeFrame roundtrip', () => {
  it('normal message', () => {
    const decoded = decodeFrame(encodeFrame(Buffer.from('hello-raft')));
    expect(decoded!.data.toString()).toBe('hello-raft');
    expect(decoded!.remaining.length).toBe(0);
  });

  it('empty message', () => {
    expect(decodeFrame(encodeFrame(Buffer.alloc(0)))!.data.length).toBe(0);
  });

  it('64KB message', () => {
    const d = decodeFrame(encodeFrame(Buffer.alloc(65536, 0x41)));
    expect(d!.data.length).toBe(65536);
    expect(d!.data[0]).toBe(0x41);
  });
});

describe('AC 31.2: boundary conditions', () => {
  it('null for header < 4 bytes', () => {
    expect(decodeFrame(Buffer.alloc(2))).toBeNull();
  });

  it('null for partial body', () => {
    expect(decodeFrame(encodeFrame(Buffer.from('data')).subarray(0, 4 + 2))).toBeNull();
  });

  it('multiple frames in one buffer', () => {
    const combined = Buffer.concat([encodeFrame(Buffer.from('first')), encodeFrame(Buffer.from('second'))]);
    const d1 = decodeFrame(combined)!;
    expect(d1.data.toString()).toBe('first');
    const d2 = decodeFrame(d1.remaining)!;
    expect(d2.data.toString()).toBe('second');
    expect(d2.remaining.length).toBe(0);
  });
});

describe('AC 31.3: PeerConnection write', () => {
  it('serializes 10 concurrent writes', async () => {
    const socket = createMockSocket();
    const conn = new PeerConnection(1, socket);

    await Promise.all(Array.from({ length: 10 }, (_, i) => conn.write(Buffer.from(`msg-${i}`))));

    const writes = socket.getWrites();
    expect(writes).toHaveLength(10);
    expect(writes[0].toString()).toBe('msg-0');
    expect(writes[9].toString()).toBe('msg-9');
  });

  it('throws after close', async () => {
    const conn = new PeerConnection(1, createMockSocket());
    conn.close();
    await expect(conn.write(Buffer.from('x'))).rejects.toThrow('not connected');
  });
});

describe('AC 31.5: PeerConnection replaceSocket', () => {
  it('preserves peerId and state', () => {
    const conn = new PeerConnection(2, createMockSocket());
    conn.replaceSocket(createMockSocket());
    expect(conn.peerId).toBe(2);
    expect(conn.connected).toBe(true);
  });
});
