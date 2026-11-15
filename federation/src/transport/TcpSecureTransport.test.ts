/**
 * TcpSecureTransport Tests — AC 46.7–46.9
 *
 * AC 46.7 — TcpSecureTransport wraps RaftTcpTransport as ITransport
 * AC 46.8 — send()/broadcast()/onMessage() work correctly
 * AC 46.9 — Transport lifecycle (start/stop/destroy)
 *     — send() with fallback transport
 *     — broadcast() to multiple peers
 *     — onMessage subscription delivery
 *     — getStats metrics reporting
 *     — getConnectedPeers from underlying transport
 *     — stop() cleans up subscriptions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcpSecureTransport } from './TcpSecureTransport';
import type { TransportMessage } from '../interfaces/transport/TransportMessage';
import type { InboundMessage } from '../interfaces/transport/InboundMessage';
import type { IHLCTimestamp } from '../interfaces/hlc/IHLCTimestamp';
import { HLC } from '../hlc/HLC';

/** A real HLC timestamp for the wire message under test. */
function ts(nodeId = 'node-1'): IHLCTimestamp {
  return new HLC(nodeId).now();
}

/** Mock Raft transport for testing (avoids real TLS/network) */
function createMockRaftTransport() {
  const messageHandlers: Array<(msg: unknown) => void> = [];
  let started = false;

  return {
    send: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockImplementation(async () => {
      started = true;
    }),
    stop: vi.fn().mockImplementation(async () => {
      started = false;
    }),
    onMessage: vi.fn().mockImplementation((handler: (msg: unknown) => void) => {
      messageHandlers.push(handler);
    }),
    getConnectedPeers: vi.fn().mockReturnValue([{ nodeId: '2' }, { nodeId: '3' }]),
    getStats: vi.fn().mockReturnValue({
      messagesSent: 42,
      messagesReceived: 17,
    }),
    // Expose for test: simulate incoming message
    _simulateIncoming(msg: unknown) {
      for (const h of messageHandlers) h(msg);
    },
    _isStarted: () => started,
  };
}

describe('TcpSecureTransport — AC 46.7: ITransport Interface', () => {
  it('should implement ITransport interface methods', () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: {
        cert: 'fake-cert',
        key: 'fake-key',
        ca: 'fake-ca',
      },
      _transportOverride: mockRaft,
    });

    expect(typeof transport.send).toBe('function');
    expect(typeof transport.broadcast).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.getConnectedPeers).toBe('function');
    expect(typeof transport.getStats).toBe('function');
  });
});

describe('TcpSecureTransport — AC 46.8: Send & Receive', () => {
  it('should send a message via underlying transport', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();

    const msg: TransportMessage = {
      messageId: 'msg-1',
      sourcePeerId: 'node-1',
      targetPeerId: 'node-2',
      payload: new Uint8Array([1, 2, 3]),
      timestamp: ts('node-1'),
      createdAt: Date.now(),
      type: 'test',
    };

    const result = await transport.send(msg);
    expect(result).toBe(true);
    expect(mockRaft.send).toHaveBeenCalled();

    await transport.stop();
  });

  it('should return false on send failure', async () => {
    const mockRaft = createMockRaftTransport();
    mockRaft.send.mockRejectedValue(new Error('Connection refused'));

    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();

    const msg: TransportMessage = {
      messageId: 'fail-msg',
      sourcePeerId: 'node-1',
      targetPeerId: 'node-2',
      payload: new Uint8Array(),
      timestamp: ts('node-1'),
      createdAt: 0,
      type: 'fail',
    };

    const result = await transport.send(msg);
    expect(result).toBe(false);

    await transport.stop();
  });

  it('should not send before start', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    const msg: TransportMessage = {
      messageId: 'pre-start',
      sourcePeerId: 'node-1',
      targetPeerId: 'node-2',
      payload: new Uint8Array(),
      timestamp: ts('node-1'),
      createdAt: 0,
      type: 'test',
    };

    const result = await transport.send(msg);
    expect(result).toBe(false);
  });

  it('should broadcast to all connected peers', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001', '127.0.0.1:7002'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();

    const msg: TransportMessage = {
      messageId: 'broadcast-1',
      sourcePeerId: 'node-1',
      targetPeerId: '*',
      payload: new Uint8Array([10, 20]),
      timestamp: ts('node-1'),
      createdAt: Date.now(),
      type: 'broadcast',
    };

    const sent = await transport.broadcast(msg);
    // 2 connected peers
    expect(sent).toBe(2);

    await transport.stop();
  });

  it('should subscribe to inbound messages', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();

    const received: InboundMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Simulate an incoming Raft message
    mockRaft._simulateIncoming({
      type: 'federation_send',
      term: 1,
      from: '2',
      to: 'node-1',
      payload: {
        messageId: 'incoming-1',
        sourcePeerId: 'node-2',
        timestamp: ts('node-2'),
        payload: [65, 66, 67],
        type: 'replicate',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.messageId).toBe('incoming-1');
    expect(received[0]!.sourcePeerId).toBe('node-2');
    expect(received[0]!.type).toBe('replicate');
    expect(Array.from(received[0]!.payload)).toEqual([65, 66, 67]);

    await transport.stop();
  });
});

describe('TcpSecureTransport — Get Connected Peers', () => {
  it('should return peers from underlying transport', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    const peers = transport.getConnectedPeers();
    expect(peers).toHaveLength(2);
    expect(peers[0]!.peerId).toBe('2');
    expect(peers[1]!.peerId).toBe('3');
  });
});

describe('TcpSecureTransport — Get Stats', () => {
  it('should return transport metrics', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    const stats = transport.getStats();
    expect(stats).toHaveProperty('peersConnected');
    expect(stats).toHaveProperty('messagesSent');
    expect(stats).toHaveProperty('messagesReceived');
    expect(stats).toHaveProperty('bytesSent');
    expect(stats).toHaveProperty('bytesReceived');
    expect(stats).toHaveProperty('uptimeMs');
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('TcpSecureTransport — AC 46.9: Lifecycle', () => {
  it('should start and stop the underlying transport', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    expect(mockRaft.start).not.toHaveBeenCalled();
    await transport.start();
    expect(mockRaft.start).toHaveBeenCalledTimes(1);

    await transport.stop();
    expect(mockRaft.stop).toHaveBeenCalledTimes(1);
  });

  it('should not start twice', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();
    await transport.start(); // no-op

    expect(mockRaft.start).toHaveBeenCalledTimes(1);
  });

  it('should destroy and clean up', async () => {
    const mockRaft = createMockRaftTransport();
    const transport = new TcpSecureTransport({
      nodeId: 'node-1',
      peerAddresses: ['127.0.0.1:7001'],
      tls: { cert: 'c', key: 'k', ca: 'ca' },
      _transportOverride: mockRaft,
    });

    await transport.start();
    const received: InboundMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    transport.destroy();

    // After destroy, send should fail
    const msg: TransportMessage = {
      messageId: 'after-destroy',
      sourcePeerId: 'node-1',
      targetPeerId: 'node-2',
      payload: new Uint8Array(),
      timestamp: ts('node-1'),
      createdAt: 0,
      type: 'test',
    };

    const result = await transport.send(msg);
    expect(result).toBe(false);
    expect(mockRaft.stop).toHaveBeenCalled();
  });
});
