/**
 * SharedBatchedTransport — boundary branch coverage
 *
 * Complements SharedBatchedTransport.test.ts with the remaining request/
 * response direction branches: early returns when not started / no handler,
 * the `requestId ? msg : wireMsg` fallback, `from ?? ''`, the falsy-response
 * early return, and the response-send / handler error `console.warn` paths.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SharedBatchedTransport } from '../../consensus/transport/SharedBatchedTransport';
import type { RPCMessage } from '@maboke123/raft-core';

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

describe('SharedBatchedTransport — branch completion', () => {
  let mockShared: ReturnType<typeof createMockShared>;
  let transport: SharedBatchedTransport;

  const getHandler = () => mockShared.onMessage.mock.calls[0][0];

  beforeEach(() => {
    mockShared = createMockShared();
    transport = new SharedBatchedTransport(mockShared as any, 0, '1');
  });

  afterEach(async () => {
    await transport.stop();
  });

  it('onIncoming ignores when not started', async () => {
    // L166 `if (!this.started) return` — transport never started.
    transport.onMessage(vi.fn().mockResolvedValue({ type: 2 }));
    await transport.start();
    // started=false via stop before dispatching
    await transport.stop();
    // Direct dispatch after stop
    const h = getHandler();
    // (re-started check) — call handler while stopped
    (transport as any).onIncoming({ requestId: 'x', msg: { direction: 'response' } });
    expect(mockShared.send).not.toHaveBeenCalled();
  });

  it('request direction without requestId passes whole wireMsg to handler', async () => {
    // L169 `requestId ? wireMsg.msg : wireMsg` — no requestId.
    const handler = vi.fn().mockResolvedValue({ type: 9 });
    transport.onMessage(handler);
    await transport.start();
    const h = getHandler();
    h(0, { from: '2', msg: { type: 1 } }); // no requestId
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    // No requestId -> inner is the whole wireMsg (from+msg), passed as innerMsg.
    expect(handler.mock.calls[0][1]).toEqual({ from: '2', msg: { type: 1 } });
  });

  it('request direction with no handler is a no-op', async () => {
    // L183 `if (!this.handler) return` — onMessage never called.
    await transport.start();
    const h = getHandler();
    expect(() => h(0, { from: '2', msg: { type: 1 } })).not.toThrow();
    expect(mockShared.send).not.toHaveBeenCalled();
  });

  it('handler returning falsy response short-circuits send', async () => {
    // L192 `if (!response || !this.started) return`.
    transport.onMessage(vi.fn().mockResolvedValue(null));
    await transport.start();
    const h = getHandler();
    h(0, { requestId: 'r1', from: '2', msg: { type: 1 } });
    await vi.waitFor(() => expect(mockShared.send).not.toHaveBeenCalled());
  });

  it('request without requestId generates a fresh response requestId', async () => {
    // L195 `requestId || nextRequestId()`.
    transport.onMessage(vi.fn().mockResolvedValue({ type: 7 }));
    await transport.start();
    const h = getHandler();
    h(0, { from: '2', msg: { type: 1 } }); // no requestId
    await vi.waitFor(() => expect(mockShared.send).toHaveBeenCalled());
    const sent = mockShared.send.mock.calls[0][1][0];
    expect(sent.requestId).toBeDefined();
    expect(sent.msg.direction).toBe('response');
    expect(sent.to).toBe('2');
  });

  it('logs a warning when response send fails', async () => {
    // L204 console.warn catch branch.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShared.send.mockRejectedValueOnce(new Error('send-fail'));
    transport.onMessage(vi.fn().mockResolvedValue({ type: 7 }));
    await transport.start();
    const h = getHandler();
    h(0, { requestId: 'r2', from: '2', msg: { type: 1 } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('logs a warning when the handler rejects', async () => {
    // L208 console.warn catch branch.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.onMessage(vi.fn().mockRejectedValue(new Error('handler-boom')));
    await transport.start();
    const h = getHandler();
    h(0, { requestId: 'r3', from: '2', msg: { type: 1 } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('wireMsg without from uses empty-string sender', async () => {
    // L187 `from ?? ''`.
    transport.onMessage(vi.fn().mockResolvedValue({ type: 7 }));
    await transport.start();
    const h = getHandler();
    h(0, { requestId: 'r4', msg: { type: 1 } }); // no from field
    await vi.waitFor(() => expect(mockShared.send).toHaveBeenCalled());
    const sent = mockShared.send.mock.calls[0][1][0];
    expect(sent.to).toBe('');
  });
});
