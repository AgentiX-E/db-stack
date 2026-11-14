/**
 * Tests for RaftAdapter.transferLeadership and stopHeartbeat.
 *
 * These tests mock the internal RaftNode to verify adapter-level behavior:
 *   1. transferLeadership throws when not leader
 *   2. transferLeadership stops heartbeat and waits for new leader
 *   3. transferLeadership times out after 10s
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftAdapter } from '../../consensus/core/RaftAdapter';

// Helper: create a RaftAdapter with a mocked internal RaftNode
function createAdapterWithMockNode(
  mocks: {
    isLeader?: boolean;
    getLeader?: number | null;
    submitCommandSuccess?: boolean;
    submitCommandError?: string;
    getNodeId?: number;
    stopHeartbeatTimer?: boolean;
  } = {},
): RaftAdapter {
  const adapter = new RaftAdapter({
    id: 1,
    peers: [2, 3],
    electionTick: 10,
    heartbeatTick: 3,
    useInMemoryStorage: true,
  });

  const timerManager = {
    stopHeartbeatTimer: vi.fn(),
  };

  const stateMachine = {
    timerManager,
  };

  const mockNode = {
    isLeader: vi.fn().mockResolvedValue(mocks.isLeader ?? true),
    getLeaderId: vi.fn().mockReturnValue(mocks.getLeader !== undefined ? String(mocks.getLeader) : '1'),
    getNodeId: vi.fn().mockReturnValue(String(mocks.getNodeId ?? 1)),
    submitCommand: vi.fn().mockResolvedValue({
      success: mocks.submitCommandSuccess !== false,
      error: mocks.submitCommandError,
      index: 5,
    }),
    stateMachine,
  };

  // Force-set the private node via type cast
  (adapter as any).node = mockNode;

  return adapter;
}

describe('RaftAdapter.transferLeadership', () => {
  it('should throw when not the leader', async () => {
    const adapter = createAdapterWithMockNode({ isLeader: false });
    await expect(adapter.transferLeadership('2')).rejects.toThrow('Only the leader can transfer leadership');
  });

  it('should stop heartbeat and succeed when target becomes leader', async () => {
    const adapter = createAdapterWithMockNode({
      isLeader: true,
      getLeader: null, // initial: no leader → will poll until leader changes
      getNodeId: 1,
    });

    // Override getLeader to return null for first few calls, then return targetId
    const mockNode = (adapter as any).node;
    let callCount = 0;
    mockNode.getLeaderId = vi.fn().mockImplementation(() => {
      callCount++;
      // Return current node (1) for first 3 calls, then switch to target (2)
      if (callCount <= 3) return '1';
      return '2';
    });

    await adapter.transferLeadership('2');

    // Verify submitCommand was called with a NOOP entry
    expect(mockNode.submitCommand).toHaveBeenCalledWith({
      type: 'command',
      payload: expect.stringContaining('leader-transfer'),
    });

    // Verify stopHeartbeatTimer was called
    const timerManager = mockNode.stateMachine.timerManager;
    expect(timerManager.stopHeartbeatTimer).toHaveBeenCalled();
  });

  it(
    'should throw on timeout when leader does not change',
    { timeout: 15_000 },
    async () => {
      const adapter = createAdapterWithMockNode({
        isLeader: true,
        getLeader: 1, // Always returns self (same as nodeId)
        getNodeId: 1,
      });

      await expect(adapter.transferLeadership('2')).rejects.toThrow(/timed out/);
    },
    15_000,
  );
});

describe('RaftAdapter.stopHeartbeat', () => {
  it('should call stopHeartbeatTimer on the internal state machine', async () => {
    const adapter = createAdapterWithMockNode({ isLeader: true });
    const mockNode = (adapter as any).node;
    const timerManager = mockNode.stateMachine.timerManager;

    await adapter.stopHeartbeat();

    expect(timerManager.stopHeartbeatTimer).toHaveBeenCalled();
  });

  it('should throw when node is not initialized', async () => {
    const adapter = new RaftAdapter({
      id: 1,
      peers: [2, 3],
      electionTick: 10,
      heartbeatTick: 3,
      useInMemoryStorage: true,
    });
    // node is null by default

    await expect(adapter.stopHeartbeat()).rejects.toThrow('RaftAdapter not initialized');
  });
});

describe('RaftAdapter.transferLeadership — NOOP failure', () => {
  it('should throw when the NOOP entry fails to commit', async () => {
    const adapter = createAdapterWithMockNode({
      isLeader: true,
      submitCommandSuccess: false,
      submitCommandError: 'rejected',
    });

    await expect(adapter.transferLeadership('2')).rejects.toThrow(/Failed to commit NOOP entry/);
  });

  it('should throw with an unknown reason when NOOP fails without an error', async () => {
    const adapter = createAdapterWithMockNode({
      isLeader: true,
      submitCommandSuccess: false,
      submitCommandError: '', // falsy → 'unknown' fallback in the throw message
    });

    await expect(adapter.transferLeadership('2')).rejects.toThrow(/Failed to commit NOOP entry: unknown/);
  });
});
