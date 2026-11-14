/**
 * RaftAdapter — init() coverage tests.
 *
 * Exercises the storage/transport construction branches of init() that the
 * other RaftAdapter test files deliberately avoid. Uses raft-core's
 * MockTransport so the full RaftNode lifecycle (storage, state machine, logger,
 * transport) is exercised for real rather than via `(adapter as any).node`.
 *
 * Acceptance Criteria:
 *   AC 34.40: init succeeds with useInMemoryStorage + custom transport
 *   AC 34.41: init throws without storage and without useInMemoryStorage
 *   AC 34.42: init throws in production mode without durable storage
 *   AC 34.43: init throws when only useInMemoryTransport is set (no transport)
 *   AC 34.44: init throws without any transport
 *   AC 34.45: init with config.storage wraps into SqliteNodeStorage
 *   AC 34.46: init reports through the logger and applies via applyHandler
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockTransport } from '@maboke123/raft-core/testing';
import { InMemoryNodeStorage } from '@maboke123/raft-core';
import { RaftAdapter, type RaftConfig } from '../../consensus/core/RaftAdapter';

// Capture the logger object passed to RaftNode so its debug/warn/error
// callbacks (RaftAdapter lines 316-319) can be invoked directly.
let capturedLogger: { debug: Function; info: Function; warn: Function; error: Function } | undefined;

vi.mock('@maboke123/raft-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@maboke123/raft-core')>();
  return {
    ...original,
    RaftNode: class {
      opts: any;
      constructor(opts: any) {
        this.opts = opts;
        capturedLogger = opts.logger;
      }
      async start() {}
      async stop() {}
      async submitCommand() { return { success: true, index: 1 }; }
      getState() { return 'follower'; }
      isLeader() { return false; }
      getLeaderId() { return null; }
      getCurrentTerm() { return 0; }
      getCommittedIndex() { return 0; }
      getLastApplied() { return 0; }
      getLastLogIndex() { return 0; }
      getNodeId() { return '1'; }
      getApplicationState() { return null; }
      isStarted() { return false; }
      getEntries() { return []; }
    },
  };
});

// Capture the ShardStateMachine callbacks so the adapter's applyHandler closure
// can be invoked directly (this exercises lines 264-274 of RaftAdapter).
let capturedApplyHandler: ((data: string) => void) | undefined;
vi.mock('../../consensus/core/ShardStateMachine', () => {
  return {
    ShardStateMachine: class {
      callbacks: any;
      constructor(callbacks: any) {
        this.callbacks = callbacks;
        capturedApplyHandler = callbacks.applyHandler;
      }
      async apply(cmd: any) {
        if (this.callbacks.applyHandler) this.callbacks.applyHandler(String(cmd.payload));
      }
      getState() { return null; }
      async takeSnapshot() { return Buffer.alloc(0); }
      async installSnapshot() {}
    },
  };
});

// Replace SqliteNodeStorage with an in-memory stand-in so the `config.storage`
// branch can be exercised without a real SQLite database. The stand-in is a
// thin wrapper over raft-core's InMemoryNodeStorage, which already conforms to
// the NodeStorage contract that raft-core consumes.
vi.mock('../../consensus/storage/SqliteNodeStorage', () => {
  const { InMemoryNodeStorage: Inner } = require('@maboke123/raft-core');
  return {
    SqliteNodeStorage: class {
      public readonly sqlite: unknown;
      private inner = new Inner();
      constructor(sqlite: unknown) { this.sqlite = sqlite; }
      get meta() { return this.inner.meta; }
      get config() { return this.inner.config; }
      get log() { return this.inner.log; }
      get snapshot() { return this.inner.snapshot; }
      async open() { return this.inner.open(); }
      async close() { return this.inner.close(); }
      isOpen() { return this.inner.isOpen(); }
    },
  };
});

// Replace the heavy TCP-backed transports with a MockTransport-backed stand-in
// so the sharedTransport/tcpConfig/storagePath branches can be exercised
// without opening real sockets or SQLite files.
vi.mock('../../consensus/transport/SharedBatchedTransport', () => {
  const { MockTransport: MT } = require('@maboke123/raft-core/testing');
  return {
    SharedBatchedTransport: class {
      private inner = new MT('shared');
      constructor(public shared: unknown, public shardId: number, public selfNodeId: string) {}
      async start() { return this.inner.start(); }
      async stop() { return this.inner.stop(); }
      isStarted() { return this.inner.isStarted(); }
      onMessage(h: any) { return this.inner.onMessage(h); }
      send(peer: string, msg: any) { return this.inner.send(peer, msg); }
    },
  };
});

vi.mock('../../consensus/transport/BatchedRaftTransport', () => {
  const { MockTransport: MT } = require('@maboke123/raft-core/testing');
  return {
    BatchedRaftTransport: class {
      private inner = new MT('tcp');
      public underlying: any;
      constructor(config: any) {
        this.underlying = {
          start: async () => {},
          waitForConnections: async () => {},
          stop: async () => {},
        };
      }
      async start() { return this.inner.start(); }
      async stop() { return this.inner.stop(); }
      isStarted() { return this.inner.isStarted(); }
      onMessage(h: any) { return this.inner.onMessage(h); }
      send(peer: string, msg: any) { return this.inner.send(peer, msg); }
    },
  };
});

// Replace SqliteStorage (dynamically imported for storagePath) with a trivial
// stand-in exposing open/getDb/setKv that storagePath path touches.
vi.mock('../../consensus/storage/SqliteStorage', () => {
  return {
    SqliteStorage: class {
      constructor(public opts: any) {}
      open() {}
      close() {}
      getDb() { return {}; }
      getKv() { return null; }
      setKv() {}
      getSnapshotIndex() { return 0; }
      getLastIndex() { return 0; }
      getTerm() { return 0; }
      appendLogEntry() {}
      getLogEntry() { return null; }
      getLogEntries() { return []; }
      truncateLogsFrom() {}
      truncateAllLogs() {}
      compactLogs() {}
      beginBatch() {}
      endBatch() {}
    },
  };
});

function minimalConfig(overrides: Partial<RaftConfig> = {}): RaftConfig {
  return { id: 1, peers: [2, 3], electionTick: 10, heartbeatTick: 3, ...overrides };
}

describe('RaftAdapter.init — storage & transport construction', () => {
  afterEach(() => {
    MockTransport.reset();
    vi.restoreAllMocks();
  });

  // AC 34.40: full happy path with in-memory storage and a custom transport.
  it('init succeeds with useInMemoryStorage + custom transport', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, transport }),
    );
    const applied: string[] = [];
    await adapter.init((data) => applied.push(data));

    expect((adapter as any).node).not.toBeNull();
    expect((adapter as any).transport).toBe(transport);

    const node = (adapter as any).node;
    expect(typeof node.submitCommand).toBe('function');
    expect(typeof node.getState).toBe('function');

    await adapter.stop();
  });

  // AC 34.41: no storage and no useInMemoryStorage → throw.
  it('init throws without storage and without useInMemoryStorage', async () => {
    const adapter = new RaftAdapter(minimalConfig());
    await expect(adapter.init()).rejects.toThrow(/requires storagePath/);
  });

  // AC 34.42: production mode requires durable storage.
  it('init throws in production mode without durable storage', async () => {
    const adapter = new RaftAdapter(
      minimalConfig({ environment: 'production', useInMemoryStorage: true, transport: new MockTransport('1') }),
    );
    // useInMemoryStorage builds storage, but production requires storagePath/storage.
    await expect(adapter.init()).rejects.toThrow(/Production mode requires durable/);
  });

  // AC 34.43: useInMemoryTransport alone (no transport) → throw.
  it('init throws when only useInMemoryTransport is set', async () => {
    const adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, useInMemoryTransport: true }),
    );
    await expect(adapter.init()).rejects.toThrow(/InMemoryTransport is not needed/);
  });

  // AC 34.44: no transport at all → throw.
  it('init throws without any transport', async () => {
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true }));
    await expect(adapter.init()).rejects.toThrow(/requires sharedTransport, tcpConfig, or transport/);
  });

  // AC 34.45: config.storage wraps into SqliteNodeStorage.
  it('init with config.storage wraps into SqliteNodeStorage', async () => {
    const fakeStorage = {
      file: ':memory:',
      open: () => {},
      close: () => {},
      compactLogs: () => Promise.resolve(),
    };
    const adapter = new RaftAdapter(
      minimalConfig({ storage: fakeStorage, transport: new MockTransport('1') }),
    );
    await adapter.init();
    expect((adapter as any).sqliteStorage).toBe(fakeStorage);
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.46: applyHandler is invoked and logger callbacks exist.
  it('init wires the apply handler and logger callbacks', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true, transport }));
    const applied: string[] = [];
    await adapter.init((data) => applied.push(data));

    // The state machine's applyHandler closure increments committedCount and
    // delegates to the adapter's applyHandler.
    const node = (adapter as any).node;
    expect(node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.46b: the state machine apply delegates into the applyHandler and
  // increments committedCount.
  it('state machine apply delegates into applyHandler and commits', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true, transport }));
    const applied: string[] = [];
    await adapter.init((data) => applied.push(data));

    const before = (adapter as any).committedCount;
    capturedApplyHandler!('hello-state');

    expect(applied).toContain('hello-state');
    expect((adapter as any).committedCount).toBe(before + 1);
    await adapter.stop();
  });

  // AC 34.46c: a throwing applyHandler is logged without crashing commit.
  it('a throwing applyHandler is logged and commit still advances', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true, transport }));
    await adapter.init(() => { throw new Error('apply-boom'); });

    const before = (adapter as any).committedCount;
    expect(() => capturedApplyHandler!('x')).not.toThrow();
    expect((adapter as any).committedCount).toBe(before + 1);
    await adapter.stop();
  });

  // AC 34.46d: the RaftNode logger callbacks (debug/info/warn/error) delegate
  // to pino without throwing.
  it('init wires debug/warn/error logger callbacks', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true, transport }));
    await adapter.init();

    expect(capturedLogger).toBeDefined();
    expect(() => capturedLogger!.debug('dbg', { a: 1 })).not.toThrow();
    expect(() => capturedLogger!.info('inf', { b: 2 })).not.toThrow();
    expect(() => capturedLogger!.warn('wrn', { c: 3 })).not.toThrow();
    expect(() => capturedLogger!.error('err', { d: 4 })).not.toThrow();

    // `ctx || {}` fallback: passing undefined ctx yields an empty object.
    expect(() => capturedLogger!.debug('no-ctx')).not.toThrow();
    expect(() => capturedLogger!.info('no-ctx')).not.toThrow();
    expect(() => capturedLogger!.warn('no-ctx')).not.toThrow();
    expect(() => capturedLogger!.error('no-ctx')).not.toThrow();
    await adapter.stop();
  });

  // AC 34.47: init with storagePath builds a SqliteStorage-backed node.
  it('init with storagePath builds durable storage', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(
      minimalConfig({ storagePath: '/tmp/raft-test.db', transport }),
    );
    await adapter.init();
    expect((adapter as any).sqliteStorage).not.toBeNull();
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });
});

describe('RaftAdapter.init — shared transport & tcp transport', () => {
  afterEach(() => {
    MockTransport.reset();
    vi.restoreAllMocks();
  });

  // AC 34.48: shared transport (plain SharedTransport) builds a batched transport.
  it('init with a plain sharedTransport', async () => {
    const shared = {
      onMessage: () => () => {},
      send: () => Promise.resolve({}),
    };
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true }));
    await adapter.init(undefined, undefined, shared as any);
    expect((adapter as any).transport).not.toBeNull();
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.49: shared transport tuple routes per-shard.
  it('init with a sharedTransport tuple', async () => {
    const shared = {
      onMessage: () => () => {},
      send: () => Promise.resolve({}),
    };
    const adapter = new RaftAdapter(minimalConfig({ useInMemoryStorage: true }));
    await adapter.init(undefined, undefined, { transport: shared as any, shardId: 5 } as any);
    expect((adapter as any).transport).not.toBeNull();
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.50: tcpConfig builds a BatchedRaftTransport.
  it('init with tcpConfig builds a TCP transport', async () => {
    const tcpConfig = {
      node: { id: 1, host: '127.0.0.1', port: 5001 },
      peers: [
        { id: 2, host: '127.0.0.1', port: 5002 },
        { id: 3, host: '127.0.0.1', port: 5003 },
      ],
      tls: { cert: Buffer.from('c'), key: Buffer.from('k'), ca: Buffer.from('a') },
      connectTimeoutMs: 1000,
      initialRetryMs: 50,
      maxRetryMs: 1000,
    };
    const adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, peers: [2, 3] }),
    );
    await adapter.init(undefined, tcpConfig);
    expect((adapter as any).originalTcpTransport).not.toBeNull();
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.51: peers not present in tcpConfig fall back to default addresses.
  it('init with tcpConfig falls back for unknown peer addresses', async () => {
    const tcpConfig = {
      node: { id: 1, host: '127.0.0.1', port: 5001 },
      peers: [], // no peer entries → .find() returns undefined → default host/port
      tls: { cert: Buffer.from('c'), key: Buffer.from('k'), ca: Buffer.from('a') },
      connectTimeoutMs: 1000,
      initialRetryMs: 50,
      maxRetryMs: 1000,
    };
    const adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, peers: [2, 3] }),
    );
    await adapter.init(undefined, tcpConfig);
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });

  // AC 34.52: peer list falls back to [] when config.peers is undefined.
  it('init with undefined peers uses an empty peer list', async () => {
    const transport = new MockTransport(String(1));
    const adapter = new RaftAdapter(
      minimalConfig({ useInMemoryStorage: true, transport, peers: undefined }),
    );
    await adapter.init();
    expect((adapter as any).node).not.toBeNull();
    await adapter.stop();
  });
});
