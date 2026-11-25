/**
 * heartbeatFrame — the wire format of a datacenter heartbeat.
 *
 * The decoder returns `null` for anything incomplete rather than a zeroed body:
 * a heartbeat with a missing `sentAt` would read as "sent at the epoch", which is
 * the most expired heartbeat possible, and would have the detector declare a
 * split brain because a frame could not be parsed.
 */

import { describe, it, expect } from 'vitest';
import { makeHLC } from '../hlc/HLC';
import {
  HEARTBEAT_TYPE,
  buildHeartbeatFrame,
  decodeHeartbeat,
  isHeartbeatFrame,
  toDetectorHeartbeat,
} from './heartbeatFrame';
import type { HeartbeatBody } from './heartbeatFrame';

const ts = makeHLC(1_700_000_000_000n, 1, 'dc-a');

const body: HeartbeatBody = {
  dcId: 'dc-a',
  nodeId: 'node-1',
  seq: 7,
  sentAt: 1_700_000_000_123,
  hlc: { wallTime: 1_700_000_000_000, logical: 4, nodeId: 'node-1' },
  appliedCount: 42,
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('heartbeatFrame — round trip', () => {
  it('carries every field', () => {
    const frame = buildHeartbeatFrame('m1', 'node-1', 'node-2', body, ts);

    expect(frame.type).toBe(HEARTBEAT_TYPE);
    expect(frame.targetPeerId).toBe('node-2');
    expect(decodeHeartbeat(frame.payload)).toEqual(body);
  });

  it('adapts to what the detector consumes', () => {
    expect(toDetectorHeartbeat(body)).toEqual({
      dcId: 'dc-a',
      nodeId: 'node-1',
      hlc: body.hlc,
      appliedCount: 42,
      timestamp: body.sentAt,
    });
  });
});

describe('heartbeatFrame — strict reading', () => {
  it('rejects an empty payload', () => {
    expect(decodeHeartbeat(new Uint8Array())).toBeNull();
  });

  it('rejects a payload that is not JSON', () => {
    expect(decodeHeartbeat(new TextEncoder().encode('half a heartbeat'))).toBeNull();
  });

  it('rejects a payload that is not an object', () => {
    expect(decodeHeartbeat(encode([]))).toBeNull();
    expect(decodeHeartbeat(encode(1))).toBeNull();
    expect(decodeHeartbeat(encode(null))).toBeNull();
  });

  it('rejects a missing or empty datacenter', () => {
    expect(decodeHeartbeat(encode({ ...body, dcId: undefined }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, dcId: '' }))).toBeNull();
  });

  it('rejects a missing node', () => {
    expect(decodeHeartbeat(encode({ ...body, nodeId: undefined }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, nodeId: '' }))).toBeNull();
  });

  it('rejects a sequence that is not a positive integer', () => {
    expect(decodeHeartbeat(encode({ ...body, seq: 0 }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, seq: 1.5 }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, seq: '7' }))).toBeNull();
  });

  it('rejects a send time that is not a number', () => {
    expect(decodeHeartbeat(encode({ ...body, sentAt: 'now' }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, sentAt: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it('rejects an applied count that is not a number', () => {
    expect(decodeHeartbeat(encode({ ...body, appliedCount: undefined }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, appliedCount: Number.NaN }))).toBeNull();
  });

  it('rejects a broken clock', () => {
    expect(decodeHeartbeat(encode({ ...body, hlc: null }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, hlc: { logical: 0, nodeId: 'x' } }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, hlc: { wallTime: 1, logical: 0.5, nodeId: 'x' } }))).toBeNull();
    expect(decodeHeartbeat(encode({ ...body, hlc: { wallTime: 1, logical: 0 } }))).toBeNull();
  });
});

describe('heartbeatFrame — family', () => {
  it('recognises only its own type', () => {
    expect(isHeartbeatFrame(HEARTBEAT_TYPE)).toBe(true);
    expect(isHeartbeatFrame('ae_summary')).toBe(false);
    expect(isHeartbeatFrame(undefined)).toBe(false);
  });
});
