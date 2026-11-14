import { describe, it, expect, vi } from 'vitest';
import { IFencingManager } from '../../interfaces/ha/IFencingManager';

describe('IFencingManager', () => {
  it('should define the interface contract with all methods', () => {
    const methods: (keyof IFencingManager)[] = [
      'acquireFence',
      'releaseFence',
      'isFenced',
      'getFenceOwner',
      'stonith',
      'renewFence',
    ];
    expect(methods.length).toBe(6);
  });

  it('mock fencing manager should implement interface', async () => {
    const mock: IFencingManager = {
      acquireFence: vi.fn().mockResolvedValue(true),
      releaseFence: vi.fn().mockResolvedValue(undefined),
      isFenced: vi.fn().mockResolvedValue(true),
      getFenceOwner: vi.fn().mockResolvedValue('node-1'),
      stonith: vi.fn().mockResolvedValue(undefined),
      renewFence: vi.fn().mockResolvedValue(true),
    };

    // Verify acquireFence
    const acquired = await mock.acquireFence('shard-0', 'node-1', 30000);
    expect(acquired).toBe(true);

    // Verify releaseFence
    await expect(mock.releaseFence('shard-0', 'node-1')).resolves.toBeUndefined();

    // Verify isFenced
    const fenced = await mock.isFenced('shard-0');
    expect(fenced).toBe(true);

    // Verify getFenceOwner
    const owner = await mock.getFenceOwner('shard-0');
    expect(owner).toBe('node-1');

    // Verify stonith — returns null owner after termination
    const mockAfterStonith: IFencingManager = {
      ...mock,
      getFenceOwner: vi.fn().mockResolvedValue(null),
    };

    await expect(mock.stonith('shard-0')).resolves.toBeUndefined();
    const ownerAfter = await mockAfterStonith.getFenceOwner('shard-0');
    expect(ownerAfter).toBeNull();

    // Verify renewFence
    const renewed = await mock.renewFence('shard-0', 'node-1', 60000);
    expect(renewed).toBe(true);

    // Verify acquireFence false scenario (already fenced by another)
    const mockConflict: IFencingManager = {
      ...mock,
      acquireFence: vi.fn().mockResolvedValue(false),
    };
    const acquiredConflict = await mockConflict.acquireFence('shard-0', 'node-2', 30000);
    expect(acquiredConflict).toBe(false);
  });
});
