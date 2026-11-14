import { describe, it, expect, vi } from 'vitest';
import { IFailoverDetector, FailoverDetectorConfig } from '../../interfaces/ha/IFailoverDetector';

describe('IFailoverDetector', () => {
  it('should define the interface contract', () => {
    const methods: (keyof IFailoverDetector)[] = [
      'start',
      'stop',
      'heartbeat',
      'getNodeHealth',
      'getAllHealth',
      'configure',
      'suspect',
      'recover',
      'onNodeSuspected',
      'onNodeFailed',
      'onNodeRecovered',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('should accept a valid FalloverDetectorConfig', () => {
    const config: FailoverDetectorConfig = {
      heartbeatIntervalMs: 1000,
      suspicionTimeoutMs: 5000,
      failureTimeoutMs: 15000,
      quorumSize: 3,
      monitoredNodes: ['node-1', 'node-2', 'node-3'],
    };
    expect(config.monitoredNodes).toHaveLength(3);
    expect(config.failureTimeoutMs).toBe(15000);
  });

  it('mock failover detector should implement interface', () => {
    const mock: IFailoverDetector = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(undefined),
      getNodeHealth: vi.fn().mockResolvedValue({ success: true }),
      getAllHealth: vi.fn().mockResolvedValue({ success: true, data: [] }),
      configure: vi.fn().mockResolvedValue(undefined),
      suspect: vi.fn().mockResolvedValue(undefined),
      recover: vi.fn().mockResolvedValue(undefined),
      onNodeSuspected: vi.fn(),
      onNodeFailed: vi.fn(),
      onNodeRecovered: vi.fn(),
    };

    expect(mock.start).toBeDefined();
    expect(mock.heartbeat).toBeDefined();
  });
});
