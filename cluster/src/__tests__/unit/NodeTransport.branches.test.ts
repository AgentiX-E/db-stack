/**
 * NodeTransport — boundary branch coverage
 *
 * Complements NodeTransport.test.ts with the `_started` guards (idempotent
 * start, no-op send/sendToShard/stop while not started) and the
 * `_handleIncoming` catch branch (a dispatch that throws before per-handler
 * try/catch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mockRegister = vi.fn();
const mockSend = vi.fn();
const mockGetStatus = vi.fn(() => ({ connectedPeers: [], totalPeers: 0, started: true }));
const mockGetCircuitBreakerMetrics = vi.fn(() => []);
const mockStart = vi.fn(async () => {});
const mockStop = vi.fn(async () => {});
let messageHandler: ((msg: any) => void) | null = null;

vi.mock('../../consensus/transport/RaftTcpTransport', () => ({
  RaftTcpTransport: vi.fn().mockImplementation((_config: any) => {
    const emitter = new EventEmitter();
    emitter.start = mockStart;
    emitter.stop = mockStop;
    emitter.send = mockSend;
    emitter.register = mockRegister;
    emitter.getStatus = mockGetStatus;
    emitter.getCircuitBreakerMetrics = mockGetCircuitBreakerMetrics;
    const origOn = emitter.on.bind(emitter);
    emitter.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'message') messageHandler = handler as (msg: any) => void;
      return origOn(event, handler);
    });
    return emitter;
  }),
}));

import { NodeTransport } from '../../consensus/transport/NodeTransport';

const validConfig = {
  node: { id: 1, host: '127.0.0.1', port: 19001 },
  peers: [],
  tls: { cert: 'c', key: 'k', ca: 'ca' },
};

describe('NodeTransport — branch completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    NodeTransport.clearAllShared();
  });

  it('start is idempotent (second start is a no-op)', async () => {
    const nt = new NodeTransport(validConfig);
    await nt.start();
    await nt.start();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('stop is idempotent (stop while not started is a no-op)', async () => {
    const nt = new NodeTransport(validConfig);
    await nt.stop();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('send is a no-op while not started', async () => {
    const nt = new NodeTransport(validConfig);
    await nt.send('1', [{ type: 'AppendEntries' }]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sendToShard is a no-op while not started', async () => {
    const nt = new NodeTransport(validConfig);
    await nt.sendToShard('1', 5, [{ type: 'AppendEntries' } as any]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('_handleIncoming swallows a dispatch-time error', () => {
    const nt = new NodeTransport(validConfig);
    nt.onMessage(() => {});
    // A frozen message makes `delete msg._shardId` throw in strict mode,
    // which propagates out of _handleIncoming into the message-listener
    // try/catch (construct-time), covering the catch branch.
    expect(() => {
      if (messageHandler) messageHandler(Object.freeze({ type: 'x', _shardId: 1 }));
    }).not.toThrow();
  });
});
