/**
 * FencingManager — one admission call that answers both questions.
 *
 * The lease answers "should I stop?" from elapsed time; the token answers "may
 * the resource still accept me?" from the order of the quorum's log. An engine
 * that has to call two checks will eventually call one, so the manager exposes a
 * single `checkWriteAllowed(shardId, token)` that fails if *either* refuses — and
 * names which one did. Token admission is opt-in per config so an engine that
 * cannot carry a token today keeps the behaviour it had.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FencingManager } from '../../consensus/fencing/FencingManager';

describe('FencingManager — token admission', () => {
  let manager: FencingManager;

  afterEach(() => {
    manager?.stop();
  });

  describe('when a token is required', () => {
    beforeEach(() => {
      manager = new FencingManager({ requireToken: true, enabled: false });
    });

    it('refuses a write that carries no token', () => {
      const verdict = manager.checkWriteAllowed(0);

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('token');
      expect(verdict.reason).toContain('missing');
    });

    it('admits a write carrying the newest token', () => {
      const verdict = manager.checkWriteAllowed(0, { term: 2, index: 10 });

      expect(verdict.allowed).toBe(true);
      expect(manager.getHighestToken()).toEqual({ term: 2, index: 10 });
    });

    it('refuses a write carrying a token the resource has surpassed', () => {
      manager.checkWriteAllowed(0, { term: 2, index: 10 });

      const verdict = manager.checkWriteAllowed(0, { term: 1, index: 9_999 });

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('stale');
      expect(verdict.reason).toContain('1/9999');
      expect(verdict.reason).toContain('2/10');
    });

    it('counts refusals so an operator can see the old primary knocking', () => {
      manager.checkWriteAllowed(0);
      manager.checkWriteAllowed(0, { term: 1, index: 1 });
      manager.checkWriteAllowed(0, { term: 1, index: 0 });

      expect(manager.getStatus().tokenRefusals).toBe(2);
    });
  });

  describe('when a token is optional', () => {
    beforeEach(() => {
      manager = new FencingManager({ enabled: false });
    });

    it('keeps admitting untokened writes, exactly as before', () => {
      expect(manager.checkWriteAllowed(0)).toEqual({ allowed: true });
    });

    it('still refuses a token that has been surpassed', () => {
      expect(manager.checkWriteAllowed(0, { term: 4, index: 4 }).allowed).toBe(true);

      const verdict = manager.checkWriteAllowed(0, { term: 4, index: 3 });

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('stale');
    });

    it('treats an explicit null as no token rather than as a stale one', () => {
      manager.checkWriteAllowed(0, { term: 4, index: 4 });

      expect(manager.checkWriteAllowed(0, null).allowed).toBe(true);
    });
  });

  describe('the two verdicts compose', () => {
    beforeEach(() => {
      manager = new FencingManager({ requireToken: true, enabled: true, leaderLeaseMs: 1, checkIntervalMs: 1 });
    });

    it('refuses on the lease first, naming the lease', async () => {
      manager.receiveHeartbeat(0, 1, 'node-1');
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 15));

      const verdict = manager.checkWriteAllowed(0, { term: 1, index: 1 });

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('fenced');
      expect(verdict.reason).not.toContain('stale');
      manager.stop();
    });

    it('does not advance the recovered token past what the engine presented', () => {
      manager.receiveHeartbeat(0, 2, 'node-1');

      expect(manager.checkWriteAllowed(0, { term: 2, index: 5 }).allowed).toBe(true);
      expect(manager.checkWriteAllowed(0, { term: 2, index: 4 }).allowed).toBe(false);
    });
  });

  describe('admitToken', () => {
    beforeEach(() => {
      manager = new FencingManager({ enabled: false });
    });

    it('exposes the admission decision for engines that log it', () => {
      const first = manager.admitToken({ term: 6, index: 6 });
      const second = manager.admitToken({ term: 6, index: 5 });

      expect(first.admitted).toBe(true);
      expect(second.admitted).toBe(false);
      expect(second.reason).toBe('stale-token');
    });

    it('reports no highest token until one is presented', () => {
      expect(manager.getHighestToken()).toBeNull();
    });
  });

  it('reports the refusal counter as zero for a manager that has seen no token', () => {
    manager = new FencingManager({ enabled: false });
    expect(manager.getStatus().tokenRefusals).toBe(0);
  });

  it('keeps token observations across a fence and its recovery', () => {
    manager = new FencingManager({ requireToken: true, enabled: false, leaderLeaseMs: 60_000 });
    manager.receiveHeartbeat(0, 3, 'node-1');
    manager.fenceNode('node-1');
    manager.receiveHeartbeat(0, 4, 'node-2');

    expect(manager.getShardState(0)).toBe('unfenced');
    expect(manager.checkWriteAllowed(0, { term: 3, index: 100 }).allowed).toBe(false);
    expect(manager.checkWriteAllowed(0, { term: 4, index: 0 }).allowed).toBe(true);
  });

  it('learns the new term from a heartbeat, before the new leader writes anything', () => {
    manager = new FencingManager({ requireToken: true, enabled: false });
    manager.receiveHeartbeat(0, 7, 'node-1');

    expect(manager.getHighestToken()).toEqual({ term: 7, index: 0 });
    expect(manager.getFormattedHighestToken()).toBe('7/0');
  });

  it('renders no highest token before one is seen', () => {
    manager = new FencingManager({ enabled: false });
    expect(manager.getFormattedHighestToken()).toBeNull();
  });

  it('ignores a heartbeat term that cannot be ordered and keeps the lease', () => {
    manager = new FencingManager({ enabled: true, leaderLeaseMs: 60_000 });
    manager.receiveHeartbeat(0, 2, 'node-1');

    manager.receiveHeartbeat(0, 2.5, 'node-1');

    expect(manager.getHighestToken()).toEqual({ term: 2, index: 0 });
    expect(manager.getShardState(0)).toBe('unfenced');
    expect(manager.checkWriteAllowed(0, { term: 2, index: 1 }).allowed).toBe(true);
  });
});

describe('FencingManager — token observations are bounded by the lease verdict', () => {
  it('never records a token from a fenced shard as the highest seen', () => {
    const manager = new FencingManager({ requireToken: true, enabled: true, leaderLeaseMs: 60_000 });
    manager.receiveHeartbeat(0, 1, 'node-1');
    manager.receiveHeartbeat(0, 5, 'node-2');
    manager.fenceNode('node-2');

    const verdict = manager.checkWriteAllowed(0, { term: 5, index: 50 });

    expect(verdict.allowed).toBe(false);
    // The heartbeat from the new term is what moved the resource on, not the
    // refused write: a fenced node's token must not become evidence for anybody.
    expect(manager.getHighestToken()).toEqual({ term: 5, index: 0 });
    vi.restoreAllMocks();
  });
});
