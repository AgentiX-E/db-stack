/**
 * Tests for ShardStateMachine.
 *
 * Verifies:
 *   1. apply() calls the applyHandler with correct data
 *   2. getState() returns a summary
 *   3. takeSnapshot() delegates to callback
 *   4. installSnapshot() delegates to callback
 *   5. Snapshot round-trip
 */

import { describe, it, expect, vi } from 'vitest';
import { ShardStateMachine } from '../../consensus/core/ShardStateMachine';
import type { Command } from '@maboke123/raft-core';

describe('ShardStateMachine', () => {
  describe('apply', () => {
    it('should call applyHandler with string payload', async () => {
      const handler = vi.fn();
      const sm = new ShardStateMachine({ applyHandler: handler });

      const command: Command = { type: 'command', payload: 'SET key value' };
      await sm.apply(command);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('SET key value');
    });

    it('should call applyHandler with JSON-stringified object payload', async () => {
      const handler = vi.fn();
      const sm = new ShardStateMachine({ applyHandler: handler });

      const command: Command = { type: 'command', payload: { op: 'SET', key: 'k', value: 'v' } };
      await sm.apply(command);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(JSON.stringify({ op: 'SET', key: 'k', value: 'v' }));
    });

    it('should work without applyHandler (no-op)', async () => {
      const sm = new ShardStateMachine({});
      const command: Command = { type: 'command', payload: 'data' };
      await expect(sm.apply(command)).resolves.toBeUndefined();
    });

    it('should propagate errors from applyHandler', async () => {
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('apply failed');
      });
      const sm = new ShardStateMachine({ applyHandler: handler });

      const command: Command = { type: 'command', payload: 'data' };
      await expect(sm.apply(command)).rejects.toThrow('apply failed');
    });
  });

  describe('getState', () => {
    it('should return a status object', () => {
      const sm = new ShardStateMachine({});
      const state = sm.getState();
      expect(state).toHaveProperty('status');
    });
  });

  describe('takeSnapshot', () => {
    it('should return Buffer from callback', async () => {
      const callback = vi.fn().mockReturnValue(Buffer.from('snap-data'));
      const sm = new ShardStateMachine({ takeSnapshotCallback: callback });

      const snapshot = await sm.takeSnapshot();
      expect(snapshot).toBeInstanceOf(Buffer);
      expect(snapshot.toString()).toBe('snap-data');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should return empty Buffer when no callback', async () => {
      const sm = new ShardStateMachine({});
      const snapshot = await sm.takeSnapshot();
      expect(snapshot).toBeInstanceOf(Buffer);
      expect(snapshot.length).toBe(0);
    });

    it('should handle async callback', async () => {
      const callback = vi.fn().mockResolvedValue(Buffer.from('async-data'));
      const sm = new ShardStateMachine({ takeSnapshotCallback: callback });

      const snapshot = await sm.takeSnapshot();
      expect(snapshot.toString()).toBe('async-data');
    });
  });

  describe('installSnapshot', () => {
    it('should call installSnapshotCallback with data', async () => {
      const callback = vi.fn();
      const sm = new ShardStateMachine({ installSnapshotCallback: callback });

      const data = Buffer.from('snap-data');
      await sm.installSnapshot(data);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(data);
    });

    it('should work without installSnapshotCallback', async () => {
      const sm = new ShardStateMachine({});
      await expect(sm.installSnapshot(Buffer.from('data'))).resolves.toBeUndefined();
    });

    it('should handle async callback', async () => {
      let restored = false;
      const callback = vi.fn().mockImplementation(async () => {
        restored = true;
      });
      const sm = new ShardStateMachine({ installSnapshotCallback: callback });

      await sm.installSnapshot(Buffer.from('data'));
      expect(restored).toBe(true);
    });
  });

  describe('snapshot round-trip', () => {
    it('should round-trip through takeSnapshot and installSnapshot', async () => {
      let state = Buffer.alloc(0);

      const sm = new ShardStateMachine({
        takeSnapshotCallback: () => state,
        installSnapshotCallback: (data: Buffer) => {
          state = data;
        },
      });

      // Take snapshot of current state
      const snap = await sm.takeSnapshot();
      expect(snap.length).toBe(0);

      // Save some state
      state = Buffer.from('new-state');

      // Take snapshot again
      const snap2 = await sm.takeSnapshot();
      expect(snap2.toString()).toBe('new-state');

      // Install a different snapshot
      await sm.installSnapshot(Buffer.from('restored-state'));
      expect(state.toString()).toBe('restored-state');
    });
  });
});
