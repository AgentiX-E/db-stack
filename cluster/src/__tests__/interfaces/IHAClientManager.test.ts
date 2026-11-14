import { describe, it, expect, vi } from 'vitest';
import { IHAClientManager } from '../../interfaces/ha/IHAClientManager';

describe('IHAClientManager', () => {
  it('should define the interface contract with all methods', () => {
    const methods: (keyof IHAClientManager)[] = [
      'redirectClients',
      'getClientCount',
      'registerClient',
      'unregisterClient',
      'getAffectedClients',
      'drainConnections',
    ];
    expect(methods.length).toBe(6);
  });

  it('mock HA client manager should implement interface', async () => {
    const mock: IHAClientManager = {
      redirectClients: vi.fn().mockResolvedValue(undefined),
      getClientCount: vi.fn().mockReturnValue(5),
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getAffectedClients: vi.fn().mockReturnValue(['client-1', 'client-2']),
      drainConnections: vi.fn().mockResolvedValue(undefined),
    };

    // Verify redirectClients
    await expect(mock.redirectClients('node-2', 'shard-0')).resolves.toBeUndefined();

    // Verify getClientCount
    expect(mock.getClientCount()).toBe(5);

    // Verify registerClient / unregisterClient
    mock.registerClient('client-3', ['shard-0', 'shard-1']);
    expect(mock.registerClient).toHaveBeenCalledWith('client-3', ['shard-0', 'shard-1']);

    mock.unregisterClient('client-1');
    expect(mock.unregisterClient).toHaveBeenCalledWith('client-1');

    // Verify getAffectedClients
    const affected = mock.getAffectedClients('shard-0');
    expect(affected).toHaveLength(2);
    expect(affected).toContain('client-1');

    // Verify drainConnections
    await expect(mock.drainConnections(5000)).resolves.toBeUndefined();
  });
});
