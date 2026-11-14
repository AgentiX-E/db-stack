/**
 * BatchedRaftTransport — boundary branch coverage
 *
 * Complements BatchedRaftTransport.test.ts with the request-direction
 * fallbacks: waitForConnections delegation, the no-requestId / no-handler /
 * falsy-response / no-requestId-response / non-numeric-from-peer branches,
 * and the (empty) removePeer method.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageHandler, RPCMessage } from '@maboke123/raft-core';

const mockSendToPeer = vi.fn();
const mockWaitForConnections = vi.fn().mockResolvedValue(undefined);
let mockHandlers: Array<(msg: any, fromPeerId: string) => void> = [];

vi.mock('../../consensus/transport/RaftTcpTransport', () => ({
  RaftTcpTransport: class {
    sendToPeer = mockSendToPeer;
    on(event: string, cb: any) {
      if (event === 'message') mockHandlers.push(cb);
    }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    waitForConnections = mockWaitForConnections;
  },
}));

import { BatchedRaftTransport } from '../../consensus/transport/BatchedRaftTransport';

function simulateIncoming(msg: any, fromPeerId = '2'): void {
  for (const h of mockHandlers) h(msg, fromPeerId);
}

describe('BatchedRaftTransport — branch completion', () => {
  let transport: BatchedRaftTransport;

  beforeEach(() => {
    mockSendToPeer.mockReset();
    mockHandlers = [];
    transport = new BatchedRaftTransport({} as any, 15000);
  });

  it('waitForConnections delegates to underlying transport', async () => {
    await transport.waitForConnections();
    expect(mockWaitForConnections).toHaveBeenCalled();
  });

  it('removePeer is callable (no-op placeholder)', () => {
    expect(() => (transport as any).removePeer('99')).not.toThrow();
  });

  it('addPeer is callable (no-op placeholder)', async () => {
    await expect((transport as any).addPeer('99', '127.0.0.1:1')).resolves.toBeUndefined();
  });

  it('underlying getter returns the transport instance', () => {
    expect(transport.underlying).toBeTruthy();
  });

  it('incoming message is ignored when not started', () => {
    // L111 `if (!this.started) return`. Call the private handler directly
    // before start() so `this.started` is still false.
    transport.onMessage(vi.fn().mockResolvedValue({ type: 'ok' }));
    expect(() => (transport as any).onIncoming({ type: 'RequestVote' }, '2')).not.toThrow();
    expect(mockSendToPeer).not.toHaveBeenCalled();
  });

  it('start is idempotent', async () => {
    await transport.start();
    await transport.start();
    expect(transport.isStarted()).toBe(true);
  });

  it('incoming request without requestId is forwarded whole to handler', async () => {
    const handler = vi.fn().mockResolvedValue({ type: 'ok' });
    transport.onMessage(handler);
    await transport.start();
    simulateIncoming({ type: 'RequestVote' });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][1]).toEqual({ type: 'RequestVote' });
  });

  it('incoming request with no handler is a no-op', async () => {
    await transport.start();
    expect(() => simulateIncoming({ type: 'RequestVote' })).not.toThrow();
    expect(mockSendToPeer).not.toHaveBeenCalled();
  });

  it('handler returning falsy response short-circuits send', async () => {
    transport.onMessage(vi.fn().mockResolvedValue(null));
    await transport.start();
    simulateIncoming({ requestId: 'r', msg: { type: 'RequestVote' } });
    await vi.waitFor(() => expect(mockSendToPeer).not.toHaveBeenCalled());
  });

  it('request without requestId generates a fresh response requestId', async () => {
    transport.onMessage(vi.fn().mockResolvedValue({ type: 'resp' }));
    await transport.start();
    simulateIncoming({ type: 'RequestVote' });
    await vi.waitFor(() => expect(mockSendToPeer).toHaveBeenCalled());
    const [peerId, frame] = mockSendToPeer.mock.calls[0];
    const payload = JSON.parse(frame.subarray(5).toString('utf-8'));
    expect(payload.requestId).toBeDefined();
    expect(peerId).toBe(2);
  });

  it('response to a non-numeric fromPeerId is dropped', async () => {
    transport.onMessage(vi.fn().mockResolvedValue({ type: 'resp' }));
    await transport.start();
    simulateIncoming({ requestId: 'r', msg: { type: 'RequestVote' } }, 'not-a-number');
    await vi.waitFor(() => expect(mockSendToPeer).not.toHaveBeenCalled());
  });

  it('handler error is caught and warned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.onMessage(vi.fn().mockRejectedValue(new Error('boom')));
    await transport.start();
    simulateIncoming({ requestId: 'r', msg: { type: 'RequestVote' } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
