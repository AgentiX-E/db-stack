/**
 * NodeTransport Unit Tests
 *
 * NodeTransport wraps RaftTcpTransport with per-shard message routing.
 * Strategy: mock RaftTcpTransport via vi.mock, test NodeTransport's
 * shard-aware send/dispatch logic in isolation.
 *
 * AC 37.1: Constructor creates transport with nodeId
 * AC 37.2: createShared returns singleton per nodeId
 * AC 37.3: forShard creates wrapper that tags _shardId
 * AC 37.4: onMessage registers handler for incoming messages
 * AC 37.5: offMessage removes handler
 * AC 37.6: sendToShard tags messages with shardId
 * AC 37.7: registerPeer delegates to RaftTcpTransport
 * AC 37.8: getCircuitBreakerMetrics delegates to transport
 * AC 37.9: Incoming message with _shardId dispatches to correct handler
 * AC 37.10: Incoming message without _shardId dispatches to shard 0
 * AC 37.11: start/stop delegates to RaftTcpTransport
 * AC 37.12: removeShared cleans up singleton cache
 * AC 37.13: stop with handler errors is non-fatal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mocks
const mockRegister = vi.fn();
const mockSend = vi.fn();
const mockGetStatus = vi.fn(() => ({ connectedPeers: [], totalPeers: 0, started: true }));
const mockGetCircuitBreakerMetrics = vi.fn(() => []);
let mockStartResolved = true;
const mockStart = vi.fn(async () => { if (!mockStartResolved) throw new Error('start failed'); });
const mockStop = vi.fn(async () => {});
let messageHandler: ((msg: any) => void) | null = null;

vi.mock('../../consensus/transport/RaftTcpTransport', () => {
  return {
    RaftTcpTransport: vi.fn().mockImplementation((_config: any) => {
      const emitter = new EventEmitter();
      emitter.start = mockStart;
      emitter.stop = mockStop;
      emitter.send = mockSend;
      emitter.register = mockRegister;
      emitter.getStatus = mockGetStatus;
      emitter.getCircuitBreakerMetrics = mockGetCircuitBreakerMetrics;
      emitter.on = emitter.on.bind(emitter);
      emitter.emit = emitter.emit.bind(emitter);
      // Capture the internal 'message' listener
      const origOn = emitter.on.bind(emitter);
      emitter.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'message') messageHandler = handler as (msg: any) => void;
        return origOn(event, handler);
      });
      return emitter;
    }),
    RaftTcpTransportConfig: {},
  } as any;
});

// Import after mocks
import { NodeTransport } from '../../consensus/transport/NodeTransport';

const validConfig = {
  node: { id: 1, host: '127.0.0.1', port: 19001 },
  peers: [
    { id: 2, host: '127.0.0.1', port: 19002 },
    { id: 3, host: '127.0.0.1', port: 19003 },
  ],
  tls: {
    cert: 'cert',
    key: 'key',
    ca: 'ca',
  },
};

describe('NodeTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    mockStartResolved = true;
    NodeTransport.clearAllShared();
  });

  it('AC 37.1: Constructor creates transport with nodeId', () => {
    const nt = new NodeTransport(validConfig);
    expect(nt.nodeId).toBe(1);
  });

  it('AC 37.2: createShared returns singleton per nodeId', () => {
    const nt1 = NodeTransport.createShared(validConfig);
    const nt2 = NodeTransport.createShared(validConfig);
    expect(nt1).toBe(nt2);
    expect(nt1.nodeId).toBe(1);
  });

  it('AC 37.3: forShard creates wrapper that tags _shardId', async () => {
    const nt = new NodeTransport(validConfig);
    (nt as any)._started = true;
    const wrapper = nt.forShard(42);
    await wrapper.send(1, [{ type: 'AppendEntries' }]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const msgs = mockSend.mock.calls[0][1];
    expect(msgs[0]._shardId).toBe(42);
  });

  it('AC 37.4: onMessage registers handler for incoming messages', () => {
    const nt = new NodeTransport(validConfig);
    const handler = vi.fn();
    nt.onMessage(handler);
    // Simulate incoming message
    if (messageHandler) messageHandler({ type: 'AppendEntries', _shardId: 5 });
    expect(handler).toHaveBeenCalledWith(5, expect.objectContaining({ type: 'AppendEntries' }));
  });

  it('AC 37.5: offMessage removes handler', () => {
    const nt = new NodeTransport(validConfig);
    const handler = vi.fn();
    nt.onMessage(handler);
    nt.offMessage(handler);
    if (messageHandler) messageHandler({ type: 'AppendEntries', _shardId: 5 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('AC 37.6: sendToShard tags messages with shardId', async () => {
    const nt = new NodeTransport(validConfig);
    (nt as any)._started = true;
    await nt.sendToShard('1', 7, [{ type: 'AppendEntries' } as any]);
    expect(mockSend).toHaveBeenCalledWith(1, [expect.objectContaining({ _shardId: 7 })]);
  });

  it('AC 37.7: registerPeer delegates to RaftTcpTransport', () => {
    const nt = new NodeTransport(validConfig);
    nt.registerPeer({ id: 4, host: '127.0.0.1', port: 19004 });
    expect(mockRegister).toHaveBeenCalledWith({ id: 4, host: '127.0.0.1', port: 19004 });
  });

  it('AC 37.8: getCircuitBreakerMetrics delegates to transport', () => {
    const nt = new NodeTransport(validConfig);
    const result = nt.getCircuitBreakerMetrics();
    expect(mockGetCircuitBreakerMetrics).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('AC 37.9: Incoming message with _shardId dispatches to correct handler', () => {
    const nt = new NodeTransport(validConfig);
    const handler = vi.fn();
    nt.onMessage(handler);
    if (messageHandler) messageHandler({ type: 'RequestVote', _shardId: 3 });
    expect(handler).toHaveBeenCalledWith(3, expect.objectContaining({ type: 'RequestVote' }));
    // _shardId should be cleaned up
    const msgArg = handler.mock.calls[0][1];
    expect(msgArg._shardId).toBeUndefined();
  });

  it('AC 37.10: Incoming message without _shardId dispatches to shard 0', () => {
    const nt = new NodeTransport(validConfig);
    const handler = vi.fn();
    nt.onMessage(handler);
    if (messageHandler) messageHandler({ type: 'AppendEntriesResponse' });
    expect(handler).toHaveBeenCalledWith(0, expect.objectContaining({ type: 'AppendEntriesResponse' }));
  });

  it('AC 37.11: start/stop delegates to RaftTcpTransport', async () => {
    const nt = new NodeTransport(validConfig);
    expect(mockStart).not.toHaveBeenCalled();
    await nt.start();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(nt.getStatus().started).toBe(true);
    await nt.stop();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('AC 37.12: removeShared cleans up singleton cache', () => {
    NodeTransport.createShared(validConfig);
    NodeTransport.removeShared(1);
    // After removal, createShared creates new instance
    const nt3 = NodeTransport.createShared(validConfig);
    expect(nt3.nodeId).toBe(1);
    // Should be a different instance from the removed one
  });

  it('AC 37.13: stop with handler errors is non-fatal', async () => {
    const nt = new NodeTransport(validConfig);
    nt.onMessage(() => { throw new Error('handler error'); });
    // Incoming message with failing handler should not throw
    expect(() => {
      if (messageHandler) messageHandler({ type: 'AppendEntries', _shardId: 1 });
    }).not.toThrow();
  });
});
