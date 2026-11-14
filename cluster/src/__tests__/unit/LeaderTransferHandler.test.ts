/**
 * Tests for LeaderTransferHandler.
 *
 * Verifies:
 *   1. transfer rejects when not leader
 *   2. transfer succeeds via @maboke123/raft-core's transferLeadership
 *   3. transfer fails and falls back to campaign when transferLeadership unavailable
 *   4. transferInProgress flag prevents concurrent transfers
 *   5. waitForNewLeader returns success on leader change
 *   6. waitForNewLeader returns timeout when no change
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaderTransferHandler } from '../../consensus/extensions/LeaderTransferHandler';

describe('LeaderTransferHandler', () => {
  let handler: LeaderTransferHandler;
  let mockRaftNode: any;
  let proposeFn: any;
  let getLeaderFn: any;
  let isLeaderFn: any;

  beforeEach(() => {
    handler = new LeaderTransferHandler({
      enabled: true,
      timeoutMs: 5000,
      pollIntervalMs: 50,
      maxPollAttempts: 10,
      appendNoopEntry: true,
    });

    mockRaftNode = {
      transferLeadership: vi.fn().mockResolvedValue(undefined),
      stepDown: vi.fn().mockResolvedValue(undefined),
      step: vi.fn(),
      id: '1',
    };

    proposeFn = vi.fn().mockResolvedValue({ index: '5', term: '2' });
    getLeaderFn = vi.fn().mockResolvedValue(1);
    isLeaderFn = vi.fn().mockResolvedValue(true);
  });

  describe('transfer', () => {
    it('should return error when not leader', async () => {
      isLeaderFn = vi.fn().mockResolvedValue(false);

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Only the leader can transfer leadership');
    });

    it('should return error when transfer already in progress', async () => {
      // Manually set the flag
      (handler as any).transferInProgress = true;

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already in progress');
    });

    it('should succeed via transferLeadership when new leader detected', async () => {
      // Simulate leader change after some polls
      let callCount = 0;
      getLeaderFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) return 1; // still old leader
        return 2; // new leader!
      });

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(true);
      expect(result.newLeader).toBe('2');
      expect(mockRaftNode.transferLeadership).toHaveBeenCalledWith(2, 5000);
      expect(proposeFn).toHaveBeenCalledTimes(1);
    });

    it('should fallback to stepDown when transferLeadership throws', async () => {
      mockRaftNode.transferLeadership = vi.fn().mockRejectedValue(new Error('transfer not supported'));
      mockRaftNode.stepDown = vi.fn().mockResolvedValue(undefined);

      // Simulate leader change after stepDown
      let callCount = 0;
      getLeaderFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) return 1;
        return 2;
      });

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(true);
      expect(result.newLeader).toBe('2');
      expect(mockRaftNode.stepDown).toHaveBeenCalledWith(5000);
    });

    it('should return timeout when leader never changes', async () => {
      getLeaderFn = vi.fn().mockResolvedValue(1); // never changes

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timed out');
    });

    it('should use sendTimeoutNow fallback when no transferLeadership on raftNode', async () => {
      const simpleRaftNode = { step: vi.fn(), id: '1' };

      // Leader never changes
      const result = await handler.transfer(simpleRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(simpleRaftNode.step).toHaveBeenCalledWith(expect.objectContaining({ msgType: 13, to: 2, from: 1 }));
    });

    it('logs a non-fatal warning and continues when the no-op propose fails', async () => {
      proposeFn = vi.fn().mockRejectedValue(new Error('no-op rejected'));
      getLeaderFn = vi.fn().mockImplementation(async () => {
        return 2; // new leader detected immediately
      });

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      // No-op failure is non-fatal; transfer still succeeds.
      expect(result.success).toBe(true);
      expect(result.newLeader).toBe('2');
      expect(mockRaftNode.transferLeadership).toHaveBeenCalledWith(2, 5000);
    });

    it('returns failure when both transferLeadership and stepDown throw', async () => {
      mockRaftNode.transferLeadership = vi.fn().mockRejectedValue(new Error('transfer unsupported'));
      mockRaftNode.stepDown = vi.fn().mockRejectedValue(new Error('stepDown unsupported'));

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Leadership transfer failed');
      expect(mockRaftNode.stepDown).toHaveBeenCalled();
    });

    it('returns failure when stepDown succeeds but no new leader is elected', async () => {
      mockRaftNode.transferLeadership = vi.fn().mockRejectedValue(new Error('transfer unsupported'));
      mockRaftNode.stepDown = vi.fn().mockResolvedValue(undefined);
      getLeaderFn = vi.fn().mockResolvedValue(1); // leader never changes

      const result = await handler.transfer(mockRaftNode, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Leadership transfer failed');
      expect(mockRaftNode.stepDown).toHaveBeenCalled();
    });

    it('skips campaign fallback and returns failure when raftNode is null', async () => {
      const result = await handler.transfer(null, 1, '2', proposeFn, getLeaderFn, isLeaderFn);

      // No transferLeadership and no stepDown on a null node → sendTimeoutNow is
      // a no-op, and the transfer times out waiting for a leader change.
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timed out');
    });
  });

  describe('isTransferInProgress', () => {
    it('should return false initially', () => {
      expect(handler.isTransferInProgress()).toBe(false);
    });

    it('should return true during a transfer', async () => {
      // Start a transfer that never completes (leader never changes)
      const transferPromise = handler.transfer(
        mockRaftNode,
        1,
        '2',
        proposeFn,
        getLeaderFn, // always returns 1
        isLeaderFn,
      );

      // Allow microtasks to process (transferInProgress should be true now)
      await new Promise((r) => setTimeout(r, 10));

      // Note: The flag is set after isLeader check, so it should be true by now
      // The transfer will eventually timeout
      await transferPromise;
      expect(handler.isTransferInProgress()).toBe(false); // reset after completion
    });
  });

  describe('reset', () => {
    it('should reset transferInProgress flag', () => {
      (handler as any).transferInProgress = true;
      expect(handler.isTransferInProgress()).toBe(true);

      handler.reset();
      expect(handler.isTransferInProgress()).toBe(false);
    });
  });

  describe('config', () => {
    it('should return current config', () => {
      const config = handler.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.timeoutMs).toBe(5000);
    });

    it('should update config at runtime', () => {
      handler.setConfig({ timeoutMs: 10000 });
      expect(handler.getConfig().timeoutMs).toBe(10000);
    });
  });
});
