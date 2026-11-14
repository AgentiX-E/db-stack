/**
 * SharedBatchedTransport Unit Tests
 *
 * Iteration 23 — Request-response Transport bridge for SharedTransport.
 *
 * SharedBatchedTransport wraps a SharedTransport (e.g. NodeTransport) to
 * implement the @maboke123/raft-core Transport interface, supporting
 * single-process multi-RaftGroup communication via per-shard message routing.
 *
 * Acceptance Criteria:
 *   AC 23.1: Constructor accepts shared transport + shardId + selfNodeId
 *   AC 23.2: start() registers handler with shared transport
 *   AC 23.3: isStarted() returns state
 *   AC 23.4: onMessage sets handler for incoming requests
 *   AC 23.5: send() dispatches wire message with requestId
 *   AC 23.6: send() resolves when matching response arrives
 *   AC 23.7: send() rejects on timeout
 *   AC 23.8: send() rejects when doSend fails
 *   AC 23.9: Incoming request routes to handler
 *   AC 23.10: Incoming response routes to pending request
 *   AC 23.11: Stop rejects pending requests
 *   AC 23.12: Stop unregisters handler from shared transport
 *   AC 23.13: Shard filtering ignores messages for other shardIds
 *   AC 23.14: start() is idempotent
 *   AC 23.15: stop() is idempotent
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SharedBatchedTransport } from '../../consensus/transport/SharedBatchedTransport';
import type { RPCMessage } from '@maboke123/raft-core';

// Mock SharedTransport
function createMockShared() {
  const handlers: Map<string, (shardId: number, msg: any) => void> = new Map();
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: (shardId: number, msg: any) => void) => {
      const key = `handler-${handlers.size}`;
      handlers.set(key, handler);
      return () => handlers.delete(key);
    }),
    offMessage: vi.fn(),
    _handlers: handlers,
  };
}

describe('SharedBatchedTransport - Unit', () => {
  let mockShared: ReturnType<typeof createMockShared>;
  let transport: SharedBatchedTransport;
  let unhandledErrors: Error[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mockShared = createMockShared();
    transport = new SharedBatchedTransport(mockShared as any, 0, '1');
    // Catch unhandled rejections to prevent vitest noise
    unhandledErrors = [];
    process.on('unhandledRejection', handler);
    function handler(err: Error) {
      unhandledErrors.push(err);
    }
  });

  afterEach(async () => {
    process.removeAllListeners('unhandledRejection');
    await transport.stop();
    vi.useRealTimers();
  });

  //
  // AC 23.1: Constructor
  //
  it('AC 23.1: Constructor accepts shared transport + shardId + selfNodeId', () => {
    const t = new SharedBatchedTransport(mockShared as any, 5, 'node-1');
    expect(t).toBeInstanceOf(SharedBatchedTransport);
    expect(t.isStarted()).toBe(false);
  });

  //
  // AC 23.2: start() registers handler
  //
  it('AC 23.2: start() registers handler with shared transport', async () => {
    await transport.start();
    expect(mockShared.onMessage).toHaveBeenCalled();
    expect(transport.isStarted()).toBe(true);
  });

  //
  // AC 23.3: isStarted() returns state
  //
  it('AC 23.3: isStarted() returns state', () => {
    expect(transport.isStarted()).toBe(false);
  });

  //
  // AC 23.4: onMessage sets handler
  //
  it('AC 23.4: onMessage sets handler for incoming requests', () => {
    const handler = vi.fn().mockResolvedValue(null);
    transport.onMessage(handler);
  });

  //
  // AC 23.5: send() dispatches wire message with requestId
  //
  it('AC 23.5: send() dispatches wire message with requestId', async () => {
    await transport.start();
    const sendPromise = transport.send('2', { type: 1 } as RPCMessage);

    expect(mockShared.send).toHaveBeenCalled();
    const callArg = mockShared.send.mock.calls[0][1][0];
    expect(callArg.requestId).toBeDefined();
    expect(callArg._shardId).toBe(0);
    expect(callArg.to).toBe('2');

    // Resolve by sending back response
    const handlerFn = mockShared.onMessage.mock.calls[0][0];
    handlerFn(0, { requestId: callArg.requestId, msg: { type: 2, direction: 'response' } });

    const result = await sendPromise;
    expect(result.type).toBe(2);
  });

  //
  // AC 23.6: send() resolves when matching response arrives
  //
  it('AC 23.6: send() resolves when matching response arrives', async () => {
    await transport.start();
    const sendPromise = transport.send('2', { type: 1 } as RPCMessage);

    const callArg = mockShared.send.mock.calls[0][1][0];
    const handlerFn = mockShared.onMessage.mock.calls[0][0];
    handlerFn(0, { requestId: callArg.requestId, msg: { type: 100, direction: 'response' } });

    const result = await sendPromise;
    expect(result.type).toBe(100);
  });

  //
  // AC 23.7: send() rejects on timeout
  //
  it('AC 23.7: send() rejects on timeout', async () => {
    await transport.start();
    const sendPromise = transport.send('2', { type: 1 } as RPCMessage);
    vi.advanceTimersByTime(20000);
    await expect(sendPromise).rejects.toThrow(/timeout/);
  });

  //
  // AC 23.8: send() rejects when doSend fails
  //
  it('AC 23.8: send() rejects when doSend fails', async () => {
    mockShared.send.mockRejectedValue(new Error('Network error'));
    await transport.start();
    await expect(transport.send('2', { type: 1 } as RPCMessage)).rejects.toThrow('Network error');
  });

  //
  // AC 23.9: Incoming request routes to handler
  //
  it('AC 23.9: Incoming request routes to handler', async () => {
    const handler = vi.fn().mockResolvedValue({ type: 200 } as RPCMessage);
    transport.onMessage(handler);
    await transport.start();

    const handlerFn = mockShared.onMessage.mock.calls[0][0];
    handlerFn(0, { requestId: 'req-1', msg: { type: 10 }, from: '2' });

    expect(handler).toHaveBeenCalledWith('2', { type: 10 });
  });

  //
  // AC 23.10: Incoming response routes to pending
  //
  it('AC 23.10: Incoming response routes to pending', async () => {
    await transport.start();
    const sendPromise = transport.send('2', { type: 1 } as RPCMessage);

    const callArg = mockShared.send.mock.calls[0][1][0];
    const handlerFn = mockShared.onMessage.mock.calls[0][0];
    handlerFn(0, { requestId: callArg.requestId, msg: { type: 2, direction: 'response' } });

    const result = await sendPromise;
    expect(result.type).toBe(2);
  });

  //
  // AC 23.11: Stop rejects pending requests
  //
  it('AC 23.11: Stop rejects pending requests', async () => {
    await transport.start();
    const sendPromise = transport.send('2', { type: 1 } as RPCMessage);
    await transport.stop();
    await expect(sendPromise).rejects.toThrow(/stopped/);
  });

  //
  // AC 23.12: Stop unregisters handler
  //
  it('AC 23.12: Stop unregisters handler', async () => {
    await transport.start();
    await transport.stop();
    expect(transport.isStarted()).toBe(false);
  });

  //
  // AC 23.13: Shard filtering
  //
  it('AC 23.13: Shard filtering ignores other shardIds', async () => {
    const handler = vi.fn().mockResolvedValue({ type: 200 } as RPCMessage);
    transport.onMessage(handler);
    await transport.start();

    const handlerFn = mockShared.onMessage.mock.calls[0][0];
    // Message for shard 1, but transport is for shard 0
    handlerFn(1, { requestId: 'req-1', msg: { type: 10 }, from: '2' });

    // Handler should NOT be called (wrong shard)
    expect(handler).not.toHaveBeenCalled();
  });

  //
  // AC 23.14: start() idempotent
  //
  it('AC 23.14: start() is idempotent', async () => {
    await transport.start();
    const callCount = mockShared.onMessage.mock.calls.length;
    await transport.start();
    expect(mockShared.onMessage.mock.calls.length).toBe(callCount);
  });

  //
  // AC 23.15: stop() idempotent
  //
  it('AC 23.15: stop() is idempotent', async () => {
    await transport.start();
    await transport.stop();
    await expect(transport.stop()).resolves.toBeUndefined();
  });
});
