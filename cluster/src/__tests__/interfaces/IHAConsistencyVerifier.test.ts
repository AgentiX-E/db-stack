import { describe, it, expect, vi } from 'vitest';
import { IHAConsistencyVerifier, IVerificationResult } from '../../interfaces/ha/IHAConsistencyVerifier';

describe('IHAConsistencyVerifier', () => {
  it('should define the interface contract with all methods', () => {
    const methods: (keyof IHAConsistencyVerifier)[] = [
      'verifyShard',
      'verifyAll',
      'startPeriodicVerification',
      'stopPeriodicVerification',
      'onInconsistency',
    ];
    expect(methods.length).toBe(5);
  });

  it('mock consistency verifier should implement interface', async () => {
    const result: IVerificationResult = {
      shardId: 'shard-0',
      verified: true,
      lastVerifiedAt: Date.now(),
      checksum: 'abc123',
      logIndex: 42,
      mismatches: [],
    };

    const mock: IHAConsistencyVerifier = {
      verifyShard: vi.fn().mockResolvedValue(result),
      verifyAll: vi.fn().mockResolvedValue([result]),
      startPeriodicVerification: vi.fn(),
      stopPeriodicVerification: vi.fn(),
      onInconsistency: vi.fn().mockReturnValue(() => {}),
    };

    // Verify verifyShard
    const shardResult = await mock.verifyShard('shard-0');
    expect(shardResult.shardId).toBe('shard-0');
    expect(shardResult.verified).toBe(true);
    expect(shardResult.checksum).toBe('abc123');
    expect(shardResult.logIndex).toBe(42);
    expect(shardResult.mismatches).toHaveLength(0);

    // Verify verifyAll
    const allResults = await mock.verifyAll();
    expect(allResults).toHaveLength(1);

    // Verify startPeriodicVerification
    mock.startPeriodicVerification(30000);
    expect(mock.startPeriodicVerification).toHaveBeenCalledWith(30000);

    // Verify stopPeriodicVerification
    mock.stopPeriodicVerification();
    expect(mock.stopPeriodicVerification).toHaveBeenCalled();

    // Verify onInconsistency
    const unsubscribe = mock.onInconsistency(vi.fn());
    expect(typeof unsubscribe).toBe('function');
  });

  it('should report mismatches when data is inconsistent', async () => {
    const inconsistentResult: IVerificationResult = {
      shardId: 'shard-1',
      verified: false,
      lastVerifiedAt: Date.now(),
      checksum: 'def456',
      logIndex: 100,
      mismatches: [
        {
          nodeId: 'node-2',
          expectedChecksum: 'def456',
          actualChecksum: 'xyz789',
        },
      ],
    };

    const mock: IHAConsistencyVerifier = {
      verifyShard: vi.fn().mockResolvedValue(inconsistentResult),
      verifyAll: vi.fn().mockResolvedValue([inconsistentResult]),
      startPeriodicVerification: vi.fn(),
      stopPeriodicVerification: vi.fn(),
      onInconsistency: vi.fn().mockReturnValue(() => {}),
    };

    const result = await mock.verifyShard('shard-1');
    expect(result.verified).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].nodeId).toBe('node-2');
    expect(result.mismatches[0].actualChecksum).toBe('xyz789');
  });
});
