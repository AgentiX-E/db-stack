/**
 * RaftGroupManager — reconnect, leader-election retry, PG auto-forward, and
 * error/cleanup paths.
 *
 * These branches were uncovered because they require fake timers (exponential
 * backoff), a mocked `pg` client (auto-forward), or error injection (catch
 * blocks). Each is driven through the public API with a stubbed Client that
 * never opens a real TCP socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const mockGroups = new Map<number, any>();

// `pg` is aliased to src/__tests__/fixtures/pg.ts (see vitest.config.ts), so
// the production `require('pg')` inside _execOnLeader resolves to the stub.
// Behaviour is driven per-test via globalThis.__pgActions, read dynamically.
const createClient = vi.fn();

vi.mock('../../consensus/core/RaftGroup', () => ({
  RaftGroup: class MockRaftGroup {
    public shardId: number;
    public config: any;
    public _leader: number | null = null;
    public _isLeader = false;
    public _progress = { commit: 1, applied: 1, lastLog: 1 };
    public _proposeCalls: any[] = [];
    public _initArgs: any[] = [];
    public _storage: any = null;
    public _phase = 'NORMAL';
    public _health = { healthy: true, lastHeartbeatMs: 1, term: 1, leaderId: '1', leaderMonitorRunning: true };
    public _raftAdapter = { flushApplyQueue: vi.fn() };

    constructor(shardId: number, config: any, _replica: any, _outbox: any, ..._rest: any[]) {
      this.shardId = shardId;
      this.config = config;
      mockGroups.set(shardId, this);
    }
    async init(_t?: any) { this._initArgs.push(_t); }
    stop() {}
    async isLeader() { return this._isLeader; }
    async getLeader() { return this._leader; }
    async getProgress() { return this._progress; }
    async propose(e: any) { this._proposeCalls.push(e); return { index: '1', term: '1' }; }
    async getLeaderHealth() { return this._health; }
    getRaftAdapter() { return this._raftAdapter; }
    setStorage(s: any) { this._storage = s; }
    toString() { return `MockRaftGroup(${this.shardId})`; }
  },
}));

vi.mock('../../consensus/opt/AdaptiveElectionTimeout', () => ({
  AdaptiveElectionTimeout: class {
    constructor(public cfg: any) {}
    start() {}
    stop() {}
    recordRtt() {}
    getSampleCount() { return 0; }
    getAvgRtt() { return 0; }
  },
}));

vi.mock('../../consensus/storage/SqliteStorage', () => ({
  SqliteStorage: class {
    constructor(public cfg: any) {}
    open() {}
    close() {}
  },
}));

class MockReplica {}

describe('RaftGroupManager — reconnect / retry / pg-forward / cleanup', () => {
  let RaftGroupManager: any;
  let manager: any;

  beforeEach(async () => {
    mockGroups.clear();
    createClient.mockClear();
    vi.resetModules();
    // Wire the pg stub's onCreate to record client constructions via the
    // global actions hook (read dynamically by the stub).
    (globalThis as any).__pgActions = { onCreate: (cfg: any) => createClient(cfg) };
    const mod = await import('../../consensus/core/RaftGroupManager');
    RaftGroupManager = mod.RaftGroupManager;
    manager = new RaftGroupManager({}, 100);
  });

  afterEach(async () => {
    delete (globalThis as any).__pgActions;
    vi.useRealTimers();
    await manager?.stop?.().catch(() => {});
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  function registerOne(shardId = 1, raftIndex = 1): any {
    manager.registerShardWithReplica(shardId, new MockReplica(), [{ nodeId: 'n1', raftIndex: raftIndex }], raftIndex);
    return mockGroups.get(shardId);
  }

  // ── Reconnection ─────────────────────────────────────────────
  describe('reconnection', () => {
    it('onPeerDisconnected registers and starts backoff', () => {
      manager.onPeerDisconnected('peer-1');
      expect(manager.peerReconnectState.has('peer-1')).toBe(true);
    });

    it('onPeerDisconnected is idempotent while reconnecting', () => {
      manager.onPeerDisconnected('peer-1');
      const first = manager.peerReconnectState.get('peer-1');
      manager.onPeerDisconnected('peer-1');
      expect(manager.peerReconnectState.get('peer-1')).toBe(first);
    });

    it('_getLocalRaftIndex returns first config id or 0', () => {
      expect((manager as any)._getLocalRaftIndex()).toBe(0);
      registerOne(1, 7);
      expect((manager as any)._getLocalRaftIndex()).toBe(7);
    });

    it('_checkReconnections no-ops without shared transport', async () => {
      await (manager as any)._checkReconnections();
      expect(manager.peerReconnectState.size).toBe(0);
    });

    it('_checkReconnections detects dead peers and reconnects', async () => {
      manager.setSharedTransport({ send: vi.fn() });
      manager.setClusterTopology({ isPeerAlive: () => false });
      registerOne(1, 1); // config.id=1, peers=[1] → no external peers
      // register a second group with a peer different from self
      manager.registerShardWithReplica(2, new MockReplica(), [{ nodeId: 'n1', raftIndex: 2 }, { nodeId: 'n2', raftIndex: 9 }], 2);
      await (manager as any)._checkReconnections();
      // peer 9 is dead and not self → reconnect scheduled
      expect(manager.peerReconnectState.has('9')).toBe(true);
    });

    it('_attemptReconnect succeeds when peer alive and notifies topology', async () => {
      manager.setClusterTopology({ isPeerAlive: () => true });
      manager.peerReconnectState.set('peer-1', { peerId: 'peer-1', attempt: 0, timer: null });
      await (manager as any)._attemptReconnect('peer-1');
      expect(manager.peerReconnectState.has('peer-1')).toBe(false);
    });

    it('_attemptReconnect schedules retry on failure', () => {
      manager.setClusterTopology({ isPeerAlive: () => false });
      manager.setReconnectConfig({ maxRetries: 0, baseMs: 1, maxMs: 1 });
      manager.peerReconnectState.set('peer-1', { peerId: 'peer-1', attempt: 0, timer: null });
      vi.useFakeTimers();
      const p = (manager as any)._attemptReconnect('peer-1');
      vi.advanceTimersByTimeAsync(10);
      return p.then(() => {
        expect(manager.peerReconnectState.size).toBe(0); // maxRetries reached
      });
    });

    it('_schedulePeerReconnect stops at maxRetries with error', () => {
      manager.setReconnectConfig({ maxRetries: 0, baseMs: 1, maxMs: 1 });
      manager.peerReconnectState.set('peer-1', { peerId: 'peer-1', attempt: 0, timer: null });
      (manager as any)._schedulePeerReconnect('peer-1');
      // attempt 0 >= maxRetries 0 → deleted immediately
      expect(manager.peerReconnectState.has('peer-1')).toBe(false);
    });
  });

  // ── propose leader-election retry ────────────────────────────
  describe('propose leader-election retry', () => {
    it('retries 5 times then forwards when leader stays null and auto-forward on', async () => {
      const g = registerOne(); // config.id=1
      g._isLeader = false;
      g._leader = null; // election in progress
      manager.autoForwardEnabled = true;
      manager.localPgPort = 5432;
      // _forwardWriteToLeader → _execOnLeader → getLeader() still null → throws
      await expect(manager.propose(1, { data: { sql: 'x' } })).rejects.toThrow('no leader known');
    });

    it('retries then throws when auto-forward disabled and leader null', async () => {
      const g = registerOne();
      g._isLeader = false;
      g._leader = null;
      manager.autoForwardEnabled = false;
      await expect(manager.propose(1, { data: { sql: 'x' } })).rejects.toThrow('not the Raft leader');
    });

    it('proposes directly when retry discovers self is leader', async () => {
      const g = registerOne(); // config.id=1
      g._isLeader = false;
      let call = 0;
      g.getLeader = vi.fn().mockImplementation(async () => {
        call++;
        return call <= 1 ? null : 1; // first null, then self
      });
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, { 1: 5432 });
      await manager.propose(1, { data: { sql: 'x' } });
      expect(g._proposeCalls.length).toBe(1);
    });

    it('forwards to another leader after retry', async () => {
      const g = registerOne();
      g._isLeader = false;
      let call = 0;
      g.getLeader = vi.fn().mockImplementation(async () => {
        call++;
        return call <= 1 ? null : 9; // first null, then remote
      });
      manager.autoForwardEnabled = true;
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, { 9: 6000 });
      await manager.propose(1, { data: { sql: 'forward me' } });
      expect(createClient).toHaveBeenCalled();
    });
  });

  // ── PG auto-forward (via _execOnLeader) ─────────────────────
  describe('PG auto-forward', () => {
    it('_execOnLeader no-ops when entry has no sql', async () => {
      const r = await (manager as any)._execOnLeader(1, { data: {} });
      expect(r).toBeUndefined();
    });

    it('_execOnLeader throws when group missing', async () => {
      await expect((manager as any)._execOnLeader(999, { data: { sql: 'x' } })).rejects.toThrow('not found');
    });

    it('_execOnLeader throws when no leader known', async () => {
      registerOne();
      await expect((manager as any)._execOnLeader(1, { data: { sql: 'x' } })).rejects.toThrow('no leader known');
    });

    it('_execOnLeader throws when leader PG address unknown', async () => {
      registerOne();
      mockGroups.get(1)._leader = 9;
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, {}); // no peer 9 mapping
      await expect((manager as any)._execOnLeader(1, { data: { sql: 'x' } })).rejects.toThrow('unknown PG address');
    });

    it('_execOnLeader proposes directly when leader is local', async () => {
      const g = registerOne();
      g._leader = 1;
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, { 1: 5432 });
      await (manager as any)._execOnLeader(1, { data: { sql: 'x' } });
      expect(g._proposeCalls.length).toBe(1);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('_execOnLeader connects and forwards to remote leader', async () => {
      registerOne();
      mockGroups.get(1)._leader = 9;
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, { 9: 6000 });
      await (manager as any)._execOnLeader(1, { data: { sql: 'SELECT 1' } });
      expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ port: 6000 }));
    });

    it('_execOnLeader reuses pooled connection on second call', async () => {
      registerOne();
      mockGroups.get(1)._leader = 9;
      manager.localPgPort = 5432;
      manager.setPgPorts(5432, { 9: 6000 });
      await (manager as any)._execOnLeader(1, { data: { sql: 'SELECT 1' } });
      const firstCount = createClient.mock.calls.length;
      await (manager as any)._execOnLeader(1, { data: { sql: 'SELECT 2' } });
      expect(createClient.mock.calls.length).toBe(firstCount); // pool hit
    });

    it('_cleanPgClientPool closes idle connections', () => {
      manager.pgClientPool.set(6000, { client: { end: vi.fn().mockResolvedValue(undefined) }, lastUsed: Date.now() - 60_000 });
      manager.pgPoolConnected.add(6000);
      (manager as any)._cleanPgClientPool();
      expect(manager.pgClientPool.size).toBe(0);
    });
  });

  // ── jitter branch (adaptive disabled) ───────────────────────
  describe('adaptive disabled → jitter', () => {
    it('uses jitteredElectionTick when adaptive is off', () => {
      manager.setAdaptiveElectionTimeout(false);
      manager.registerShardWithReplica(1, new MockReplica(), [{ nodeId: 'n1', raftIndex: 1 }], 1);
      const cfg = manager.groupConfigs.get(1);
      expect(cfg.electionTick).toBeGreaterThanOrEqual(10);
      expect(manager.groupContexts.has(1)).toBe(false);
    });
  });

  // ── error catch branches ─────────────────────────────────────
  describe('error catch branches', () => {
    it('deregisterShard swallows stop error', () => {
      const g = registerOne();
      g.stop = vi.fn().mockImplementation(() => {
        throw new Error('stop fail');
      });
      expect(() => manager.deregisterShard(1)).not.toThrow();
      expect(manager.groups.has(1)).toBe(false);
    });

    it('pauseShard throws on stop error', async () => {
      const g = registerOne();
      g.stop = vi.fn().mockImplementation(() => {
        throw new Error('stop fail');
      });
      await expect(manager.pauseShard(1)).rejects.toThrow('stop fail');
    });

    it('pauseShard warns for unknown shard', async () => {
      await expect(manager.pauseShard(999)).resolves.toBeUndefined();
    });

    it('resumeShard re-init and throws on error', async () => {
      const g = registerOne();
      g.init = vi.fn().mockRejectedValue(new Error('init fail'));
      await expect(manager.resumeShard(1)).rejects.toThrow('init fail');
    });

    it('resumeShard warns for unknown shard', async () => {
      await expect(manager.resumeShard(999)).resolves.toBeUndefined();
    });

    it('resumeShard re-initializes a paused group', async () => {
      const g = registerOne();
      await manager.resumeShard(1);
      expect(g._initArgs.length).toBe(1);
    });
  });

  // ── stop cleanup ─────────────────────────────────────────────
  describe('stop cleanup', () => {
    it('_stopReconnectMonitor clears timer', () => {
      manager._startReconnectMonitor();
      expect(manager._reconnectMonitorTimer).toBeTruthy();
      (manager as any)._stopReconnectMonitor();
      expect(manager._reconnectMonitorTimer).toBeNull();
    });

    it('_startReconnectMonitor is idempotent', () => {
      manager._startReconnectMonitor();
      const t = manager._reconnectMonitorTimer;
      manager._startReconnectMonitor();
      expect(manager._reconnectMonitorTimer).toBe(t);
    });
  });
});
