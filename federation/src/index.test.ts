import { describe, it, expect, vi } from 'vitest';
import type {
  ITransport,
  TransportMessage,
  InboundMessage,
  IOutboxStore,
  OutboxEntry,
  IHLCTimestamp,
  PeerInfo,
  TransportStats,
  OutboxStats,
  HLCStatus,
  IMultiLeaderReplication,
  ReplicationConfig,
  ReplicationStatus,
  ReplicationTarget,
  TopologyType,
  ICDCEngine,
  ICDCManager,
  CDCChangeEvent,
  CDCSubscription,
  ICDCPublication,
  IReplicationSlotManager,
  ReplicationSlot,
  IAntiEntropy,
  AntiEntropyConfig,
  SyncResult,
} from './index';

describe('@agentix-e/db-federation types', () => {
  it('should export ITransport interface', () => {
    const transport: ITransport = {
      send: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn().mockResolvedValue(1),
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      getConnectedPeers: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({} as TransportStats),
    };
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.broadcast).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.getConnectedPeers).toBe('function');
    expect(typeof transport.getStats).toBe('function');
  });

  it('should export IOutboxStore interface', () => {
    const store: IOutboxStore = {
      add: vi.fn(),
      fetchOldestPending: vi.fn().mockResolvedValue([]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      getPendingCount: vi.fn().mockResolvedValue(0),
      markFailed: vi.fn().mockReturnValue(false),
      getStats: vi.fn().mockReturnValue({} as OutboxStats),
    };
    expect(typeof store.add).toBe('function');
    expect(typeof store.fetchOldestPending).toBe('function');
    expect(typeof store.markDelivered).toBe('function');
    expect(typeof store.getPendingCount).toBe('function');
    expect(typeof store.markFailed).toBe('function');
    expect(typeof store.getStats).toBe('function');
  });

  it('should validate TransportMessage structure', () => {
    const msg: TransportMessage = {
      messageId: 'msg-1',
      sourcePeerId: 'peer-a',
      targetPeerId: 'peer-b',
      payload: new Uint8Array([1, 2, 3]),
      timestamp: {
        wallTime: BigInt(0),
        logical: 0,
        nodeId: 'n1',
      } as IHLCTimestamp,
      createdAt: Date.now(),
    };
    expect(msg.messageId).toBe('msg-1');
    expect(msg.payload).toBeInstanceOf(Uint8Array);
  });

  it('should validate InboundMessage extends TransportMessage', () => {
    const msg: InboundMessage = {
      messageId: 'msg-2',
      sourcePeerId: 'peer-a',
      targetPeerId: 'peer-b',
      payload: new Uint8Array([]),
      timestamp: {
        wallTime: BigInt(0),
        logical: 0,
        nodeId: 'n1',
      } as IHLCTimestamp,
      createdAt: Date.now(),
      receivedAt: Date.now(),
    };
    expect(msg.receivedAt).toBeGreaterThan(0);
  });

  it('should validate OutboxEntry structure', () => {
    const entry: OutboxEntry = {
      id: 'entry-1',
      targetPeerIds: ['peer-b'],
      payload: new Uint8Array([0xde, 0xad]),
      timestamp: {
        wallTime: BigInt(0),
        logical: 0,
        nodeId: 'n1',
      } as IHLCTimestamp,
      type: 'replication',
      status: 'pending',
      createdAt: Date.now(),
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
    };
    expect(entry.status).toBe('pending');
    expect(entry.attemptCount).toBe(0);
  });

  it('should validate IHLCTimestamp interface', () => {
    const ts: IHLCTimestamp = {
      wallTime: BigInt(1736000000000),
      logical: 0,
      nodeId: 'node-1',
      compare: vi.fn().mockReturnValue(0),
      serialize: vi.fn().mockReturnValue('1736000000000:0:node-1'),
      deserialize: vi.fn(),
    };
    expect(typeof ts.compare).toBe('function');
    expect(typeof ts.serialize).toBe('function');
    expect(typeof ts.deserialize).toBe('function');
    expect(ts.serialize()).toBe('1736000000000:0:node-1');
  });

  it('should validate shared types', () => {
    const peer: PeerInfo = {
      peerId: 'peer-z',
      address: 'tcp://127.0.0.1:5555',
      connectedAt: Date.now(),
      latencyMs: 5,
    };
    expect(peer.latencyMs).toBeGreaterThanOrEqual(0);

    const tStats: TransportStats = {
      peersConnected: 0,
      messagesSent: 10,
      messagesReceived: 8,
      bytesSent: 1024,
      bytesReceived: 512,
      uptimeMs: 3600000,
    };
    expect(tStats.uptimeMs).toBe(3600000);

    const oStats: OutboxStats = {
      totalEntries: 100,
      pendingCount: 3,
      deliveredCount: 97,
      oldestPendingTimestamp: Date.now(),
    };
    expect(oStats.deliveredCount).toBe(97);

    const hlc: HLCStatus = {
      wallClockTime: BigInt(Date.now()),
      logicalCounter: 0,
      nodeId: 'node-1',
    };
    expect(hlc.nodeId).toBe('node-1');
  });
});

describe('@agentix-e/db-federation replication types', () => {
  it('should export TopologyType', () => {
    const intraDc: TopologyType = 'intra-dc';
    const crossDc: TopologyType = 'cross-dc';
    const edge: TopologyType = 'edge';
    expect(intraDc).toBe('intra-dc');
    expect(crossDc).toBe('cross-dc');
    expect(edge).toBe('edge');
  });

  it('should validate ReplicationTarget structure', () => {
    const target: ReplicationTarget = {
      nodeId: 'node-b',
      dc: 'dc-east',
      address: 'tcp://10.0.1.2:5555',
      topology: 'cross-dc',
      maxBackoffSeconds: 60,
    };
    expect(target.nodeId).toBe('node-b');
    expect(target.dc).toBe('dc-east');
    expect(target.maxBackoffSeconds).toBe(60);
  });

  it('should validate ReplicationConfig structure', () => {
    const config: ReplicationConfig = {
      nodeId: 'node-a',
      dc: 'dc-west',
      targets: [
        {
          nodeId: 'node-b',
          dc: 'dc-east',
          address: 'tcp://10.0.1.2:5555',
          topology: 'cross-dc',
          maxBackoffSeconds: 60,
        },
      ],
      curveDir: '/var/lib/curve',
      tickMs: 100,
      batchSize: 1000,
      maxRetries: 5,
    };
    expect(config.targets).toHaveLength(1);
    expect(config.curveDir).toBe('/var/lib/curve');
  });

  it('should validate ReplicationStatus structure', () => {
    const status: ReplicationStatus = {
      nodeId: 'node-a',
      dc: 'dc-west',
      targets: [
        {
          targetNodeId: 'node-b',
          connected: true,
          lagMs: 150,
          pendingCount: 42,
          lastSuccessAt: Date.now(),
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      ],
    };
    expect(status.targets[0]!.connected).toBe(true);
    expect(status.targets[0]!.lagMs).toBe(150);
  });

  it('should export IMultiLeaderReplication interface with all methods', () => {
    const replication: IMultiLeaderReplication = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      replicate: vi.fn().mockResolvedValue({ msgId: 'msg-1' }),
      getStatus: vi.fn().mockResolvedValue({} as ReplicationStatus),
      retryFailed: vi.fn().mockResolvedValue(3),
      getPendingCounts: vi.fn().mockResolvedValue({ 'node-b': 5 }),
      onTargetConnected: vi.fn().mockReturnValue(vi.fn()),
      onTargetDisconnected: vi.fn().mockReturnValue(vi.fn()),
      onHighLag: vi.fn().mockReturnValue(vi.fn()),
    };
    expect(typeof replication.start).toBe('function');
    expect(typeof replication.stop).toBe('function');
    expect(typeof replication.replicate).toBe('function');
    expect(typeof replication.getStatus).toBe('function');
    expect(typeof replication.retryFailed).toBe('function');
    expect(typeof replication.getPendingCounts).toBe('function');
    expect(typeof replication.onTargetConnected).toBe('function');
    expect(typeof replication.onTargetDisconnected).toBe('function');
    expect(typeof replication.onHighLag).toBe('function');
  });

  it('should validate CDCChangeEvent structure', () => {
    const ts: IHLCTimestamp = {
      wallTime: BigInt(1736000000000),
      logical: 0,
      nodeId: 'node-1',
      compare: vi.fn(),
      serialize: vi.fn(),
      deserialize: vi.fn(),
    };
    const event: CDCChangeEvent = {
      lsn: '0/16B3748',
      timestamp: ts,
      tableName: 'orders',
      operation: 'insert',
      oldValues: null,
      newValues: { id: 42, status: 'active' },
      txId: 'tx-1001',
    };
    expect(event.lsn).toBe('0/16B3748');
    expect(event.tableName).toBe('orders');
    expect(event.operation).toBe('insert');
    expect(event.newValues).toEqual({ id: 42, status: 'active' });
  });

  it('should validate CDCSubscription structure', () => {
    const sub: CDCSubscription = {
      subscriptionId: 'sub-1',
      tables: ['orders', 'payments'],
      operations: ['insert', 'update'],
      webhookUrl: 'https://hooks.example.com/cdc',
      createdAt: Date.now(),
    };
    expect(sub.subscriptionId).toBe('sub-1');
    expect(sub.tables).toContain('orders');
    expect(sub.webhookUrl).toBeDefined();
  });

  it('should export ICDCEngine interface with all methods', () => {
    const engine: ICDCEngine = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      watchTable: vi.fn(),
      unwatchTable: vi.fn(),
      getWatchedTables: vi.fn().mockReturnValue([]),
      onChange: vi.fn().mockReturnValue(vi.fn()),
    };
    expect(typeof engine.start).toBe('function');
    expect(typeof engine.stop).toBe('function');
    expect(typeof engine.watchTable).toBe('function');
    expect(typeof engine.unwatchTable).toBe('function');
    expect(typeof engine.getWatchedTables).toBe('function');
    expect(typeof engine.onChange).toBe('function');
  });

  it('should validate ICDCPublication structure', () => {
    const pub: ICDCPublication = {
      publicationId: 'pub-orders',
      tables: ['orders', 'order_items'],
      createdAt: Date.now(),
    };
    expect(pub.publicationId).toBe('pub-orders');
    expect(pub.tables).toHaveLength(2);
  });

  it('should export ICDCManager interface with all methods', () => {
    const manager: ICDCManager = {
      createPublication: vi.fn().mockResolvedValue({} as ICDCPublication),
      dropPublication: vi.fn().mockResolvedValue(undefined),
      createSubscription: vi.fn().mockResolvedValue({} as CDCSubscription),
      dropSubscription: vi.fn().mockResolvedValue(undefined),
      getSubscriptions: vi.fn().mockResolvedValue([]),
      getPublications: vi.fn().mockResolvedValue([]),
    };
    expect(typeof manager.createPublication).toBe('function');
    expect(typeof manager.dropPublication).toBe('function');
    expect(typeof manager.createSubscription).toBe('function');
    expect(typeof manager.dropSubscription).toBe('function');
    expect(typeof manager.getSubscriptions).toBe('function');
    expect(typeof manager.getPublications).toBe('function');
  });

  it('should validate ReplicationSlot structure', () => {
    const slot: ReplicationSlot = {
      slotName: 'node_a_slot',
      outputPlugin: 'pgoutput',
      database: 'mydb',
      lsn: '0/16B3748',
      active: true,
      activePID: 12345,
      catalogXmin: 742,
      restartLsn: '0/16B3740',
      confirmedFlushLsn: '0/16B3748',
    };
    expect(slot.slotName).toBe('node_a_slot');
    expect(slot.active).toBe(true);
    expect(slot.activePID).toBe(12345);
  });

  it('should export IReplicationSlotManager interface with all methods', () => {
    const slotManager: IReplicationSlotManager = {
      createSlot: vi.fn().mockResolvedValue({} as ReplicationSlot),
      dropSlot: vi.fn().mockResolvedValue(undefined),
      getSlot: vi.fn().mockResolvedValue(null),
      listSlots: vi.fn().mockResolvedValue([]),
      advanceSlot: vi.fn().mockResolvedValue(undefined),
      getOldestRequiredLSN: vi.fn().mockResolvedValue('0/16B3748'),
    };
    expect(typeof slotManager.createSlot).toBe('function');
    expect(typeof slotManager.dropSlot).toBe('function');
    expect(typeof slotManager.getSlot).toBe('function');
    expect(typeof slotManager.listSlots).toBe('function');
    expect(typeof slotManager.advanceSlot).toBe('function');
    expect(typeof slotManager.getOldestRequiredLSN).toBe('function');
  });

  it('should validate AntiEntropyConfig structure', () => {
    const config: AntiEntropyConfig = {
      nodeId: 'node-a',
      intervalMs: 30000,
      merkleDepth: 16,
    };
    expect(config.nodeId).toBe('node-a');
    expect(config.intervalMs).toBe(30000);
    expect(config.merkleDepth).toBe(16);
  });

  it('should validate SyncResult structure', () => {
    const result: SyncResult = {
      nodeId: 'node-b',
      entriesSynced: 150,
      entriesSkipped: 10,
      conflictsResolved: 2,
      durationMs: 1234,
      completedAt: Date.now(),
    };
    expect(result.entriesSynced).toBe(150);
    expect(result.conflictsResolved).toBe(2);
  });

  it('should export IAntiEntropy interface with all methods', () => {
    const antiEntropy: IAntiEntropy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      syncWith: vi.fn().mockResolvedValue({} as SyncResult),
      syncAll: vi.fn().mockResolvedValue([]),
      getMerkleRoot: vi.fn().mockResolvedValue('0xdeadbeef'),
    };
    expect(typeof antiEntropy.start).toBe('function');
    expect(typeof antiEntropy.stop).toBe('function');
    expect(typeof antiEntropy.syncWith).toBe('function');
    expect(typeof antiEntropy.syncAll).toBe('function');
    expect(typeof antiEntropy.getMerkleRoot).toBe('function');
  });
});
