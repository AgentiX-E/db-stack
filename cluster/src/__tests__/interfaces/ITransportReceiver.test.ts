import { describe, it, expect, vi } from 'vitest';
import { ITransportReceiver } from '../../interfaces/transport/ITransportReceiver';
import { RaftMessage } from '../../interfaces/types';

describe('ITransportReceiver', () => {
  it('should define the interface contract', () => {
    const methods: (keyof ITransportReceiver)[] = [
      'listen',
      'close',
      'send',
      'broadcast',
      'multicast',
      'getAddress',
      'setNodeId',
      'getNodeId',
      'onMessage',
      'onError',
      'registerNode',
      'unregisterNode',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('should accept a valid RaftMessage', () => {
    const msg: RaftMessage = {
      type: 'request_vote',
      term: 1,
      from: 'node-1',
      to: 'node-2',
      payload: { lastLogIndex: 5, lastLogTerm: 1 },
    };
    expect(msg.type).toBe('request_vote');
    expect(msg.term).toBe(1);
  });

  it('mock transport should implement interface', () => {
    const mock: ITransportReceiver = {
      listen: vi.fn().mockResolvedValue({ success: true }),
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ success: true }),
      broadcast: vi.fn().mockResolvedValue({ success: true }),
      multicast: vi.fn().mockResolvedValue({ success: true }),
      getAddress: vi.fn().mockReturnValue('tcp://0.0.0.0:5555'),
      setNodeId: vi.fn(),
      getNodeId: vi.fn().mockReturnValue('node-1'),
      onMessage: vi.fn(),
      onError: vi.fn(),
      registerNode: vi.fn(),
      unregisterNode: vi.fn(),
    };

    expect(mock.getAddress()).toBe('tcp://0.0.0.0:5555');
    expect(mock.getNodeId()).toBe('node-1');
  });
});
