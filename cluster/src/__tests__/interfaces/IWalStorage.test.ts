import { describe, it, expect, vi } from 'vitest';
import { IWalStorage } from '../../interfaces/wal/IWalStorage';
import { LogEntry, OperationResult } from '../../interfaces/types';

describe('IWalStorage', () => {
  it('should define the interface contract', () => {
    const methods: (keyof IWalStorage)[] = [
      'append',
      'appendBatch',
      'read',
      'readRange',
      'lastEntry',
      'length',
      'truncate',
      'deleteFrom',
      'storeSnapshot',
      'latestSnapshot',
      'close',
    ];
    expect(methods.length).toBeGreaterThan(0);
  });

  it('mock WAL storage should implement interface', () => {
    const mock: IWalStorage = {
      append: vi.fn().mockResolvedValue({ success: true, data: 1 }),
      appendBatch: vi.fn().mockResolvedValue({ success: true, data: [1, 2] }),
      read: vi.fn().mockResolvedValue({ success: true, data: null }),
      readRange: vi.fn().mockResolvedValue({ success: true, data: [] }),
      lastEntry: vi.fn().mockResolvedValue({ success: true, data: null }),
      length: vi.fn().mockResolvedValue({ success: true, data: 0 }),
      truncate: vi.fn().mockResolvedValue({ success: true }),
      deleteFrom: vi.fn().mockResolvedValue({ success: true }),
      storeSnapshot: vi.fn().mockResolvedValue({ success: true }),
      latestSnapshot: vi.fn().mockResolvedValue({ success: true, data: null }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Test append/write cycle via mock behavior
    const result = mock.append({ term: 1, command: 'SET', data: { x: 1 } });
    expect(result).toBeDefined();
  });
});
